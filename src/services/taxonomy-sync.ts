/**
 * Taxonomy Sync Service.
 * Ensures required WP categories and tags exist before pipeline runs.
 * Ref: 01_ContentSpec §2 (SOURCE OF TRUTH), WP-INTEGRATION-CONTRACTS.
 *
 * Design:
 *   - Idempotent: safe to run repeatedly (checks by slug before create).
 *   - No auto-publish.
 *   - No secrets in logs.
 *   - No city/province tags created (no verified local-value system in repo).
 *   - Gated tags: only created if ≥3 planned articles (§2.3).
 *   - Approved additions: tags explicitly approved in taxonomy_config.yaml.
 *   - Rank Math archive robots: set noindex,follow on created/ensured tags (best effort).
 */

import { WpClient } from './wp-client';
import {
    CANONICAL_CATEGORIES,
    TAG_WHITELIST,
    TAG_WHITELIST_GROUPS,
    normalizeSlug,
    evaluateGatedTags,
    type KeywordCsvRow,
} from './taxonomy';
import { logger } from '../logger';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface TaxonomySyncPlan {
    categories: Array<{ slug: string; name: string; action: 'create' | 'exists' }>;
    tags: Array<{
        slug: string;
        name: string;
        group: string;
        action: 'create' | 'exists';
    }>;
    gatedTags: Array<{
        slug: string;
        count: number;
        qualifies: boolean;
        action: 'create' | 'skip';
        reason: string;
    }>;
    skippedCityTags: string[];
}

export interface TaxonomySyncResult {
    categoriesCreated: number;
    categoriesExisting: number;
    categoriesFailed: Array<{ slug: string; error: string }>;
    tagsCreated: number;
    tagsExisting: number;
    tagsFailed: Array<{ slug: string; error: string }>;
    gatedTagsCreated: number;
    gatedTagsSkipped: number;
    cityTagsSkipped: number;
    /** Approved additions from taxonomy_config.yaml */
    approvedCreated: number;
    approvedExisting: number;
    approvedFailed: Array<{ slug: string; error: string }>;
    /** Rank Math archive robots update attempts */
    robotsUpdateAttempted: number;
    robotsUpdateSucceeded: number;
    robotsUpdateFailed: number;
}

// ═══════════════════════════════════════════════════════════════════
// CSV parser (minimal, no dependencies)
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse keyword.csv content into rows.
 * Handles: comma-separated, first row is headers.
 */
export function parseKeywordCsv(csvContent: string): KeywordCsvRow[] {
    const lines = csvContent
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((l) => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim());
    const rows: KeywordCsvRow[] = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map((v) => v.trim());
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j] || '';
        }
        rows.push(row as KeywordCsvRow);
    }

    return rows;
}

// ═══════════════════════════════════════════════════════════════════
// Plan Builder
// ═══════════════════════════════════════════════════════════════════

/**
 * Build a sync plan without touching WP.
 * Useful for dry-run / plan display.
 */
export function buildSyncPlan(
    existingCategorySlugs: Set<string>,
    existingTagSlugs: Set<string>,
    csvRows: KeywordCsvRow[],
    candidateGatedTags: string[] = []
): TaxonomySyncPlan {
    // Categories
    const categories = CANONICAL_CATEGORIES.map((c) => ({
        slug: c.slug,
        name: c.name,
        action: existingCategorySlugs.has(c.slug) ? ('exists' as const) : ('create' as const),
    }));

    // Tags — flat whitelist
    const tags: TaxonomySyncPlan['tags'] = [];
    for (const [group, groupTags] of Object.entries(TAG_WHITELIST_GROUPS)) {
        for (const tagSlug of groupTags) {
            tags.push({
                slug: tagSlug,
                name: tagSlug, // WP will display as-is; slug format is fine
                group,
                action: existingTagSlugs.has(tagSlug) ? 'exists' : 'create',
            });
        }
    }

    // Gated tags (§2.3)
    const gatedEval = evaluateGatedTags(candidateGatedTags, csvRows);
    const gatedTags: TaxonomySyncPlan['gatedTags'] = [];
    for (const [slug, { count, qualifies }] of gatedEval.entries()) {
        gatedTags.push({
            slug,
            count,
            qualifies,
            action: qualifies && !existingTagSlugs.has(slug) ? 'create' : 'skip',
            reason: qualifies
                ? existingTagSlugs.has(slug)
                    ? 'already_exists'
                    : `qualifies_${count}_articles`
                : `below_threshold_${count}_of_3`,
        });
    }

    // City tags — always skipped (no verified local-value system in repo)
    const cityTagSlugs = (TAG_WHITELIST_GROUPS as Record<string, readonly string[]>)[
        'city_province'
    ];
    const skippedCityTags = cityTagSlugs ? [...cityTagSlugs] : [];

    return { categories, tags, gatedTags, skippedCityTags };
}

// ═══════════════════════════════════════════════════════════════════
// Sync Executor
// ═══════════════════════════════════════════════════════════════════

/**
 * Execute taxonomy sync against WordPress.
 * Idempotent: checks existing before creating.
 */
export async function executeTaxonomySync(
    wpClient: WpClient,
    csvRows: KeywordCsvRow[],
    candidateGatedTags: string[] = [],
    approvedAdditions: Array<{ slug: string; group: string }> = [],
    rankMathRobotsKey: string = ''
): Promise<{ plan: TaxonomySyncPlan; result: TaxonomySyncResult }> {
    // 1. Fetch existing terms
    logger.info('taxonomy-sync: fetching existing WP categories');
    const existingCats = await wpClient.listAllCategories();
    const existingCatSlugs = new Set(existingCats.map((c) => c.slug));

    logger.info('taxonomy-sync: fetching existing WP tags');
    const existingTagsList = await wpClient.listAllTags();
    const existingTagSlugs = new Set(existingTagsList.map((t) => t.slug));

    // 2. Build plan
    const plan = buildSyncPlan(
        existingCatSlugs,
        existingTagSlugs,
        csvRows,
        candidateGatedTags
    );

    // 3. Execute
    const result: TaxonomySyncResult = {
        categoriesCreated: 0,
        categoriesExisting: 0,
        categoriesFailed: [],
        tagsCreated: 0,
        tagsExisting: 0,
        tagsFailed: [],
        gatedTagsCreated: 0,
        gatedTagsSkipped: 0,
        cityTagsSkipped: plan.skippedCityTags.length,
        approvedCreated: 0,
        approvedExisting: 0,
        approvedFailed: [],
        robotsUpdateAttempted: 0,
        robotsUpdateSucceeded: 0,
        robotsUpdateFailed: 0,
    };

    // 3a. Sync categories
    for (const cat of plan.categories) {
        if (cat.action === 'exists') {
            result.categoriesExisting++;
            continue;
        }
        const res = await wpClient.createCategory(cat.slug, cat.name);
        if (res.ok) {
            result.categoriesCreated++;
            logger.info('taxonomy-sync: category ensured', { slug: cat.slug, created: res.created });
        } else {
            result.categoriesFailed.push({ slug: cat.slug, error: res.error || 'unknown' });
            logger.error('taxonomy-sync: category sync failed', { slug: cat.slug });
        }
    }

    // 3b. Sync tags
    for (const tag of plan.tags) {
        if (tag.action === 'exists') {
            result.tagsExisting++;
            continue;
        }
        const res = await wpClient.createTag(tag.slug, tag.name);
        if (res.ok) {
            result.tagsCreated++;
            logger.info('taxonomy-sync: tag ensured', { slug: tag.slug, created: res.created });
        } else {
            result.tagsFailed.push({ slug: tag.slug, error: res.error || 'unknown' });
            logger.error('taxonomy-sync: tag sync failed', { slug: tag.slug });
        }
    }

    // 3c. Gated tags
    for (const gt of plan.gatedTags) {
        if (gt.action === 'skip') {
            result.gatedTagsSkipped++;
            continue;
        }
        const res = await wpClient.createTag(gt.slug, gt.slug);
        if (res.ok) {
            result.gatedTagsCreated++;
        } else {
            result.gatedTagsSkipped++;
        }
    }

    // 3d. Approved additions from taxonomy_config.yaml
    if (approvedAdditions && approvedAdditions.length > 0) {
        logger.info('taxonomy-sync: processing approved additions', {
            count: approvedAdditions.length,
        });

        for (const addition of approvedAdditions) {
            // Create tag idempotently (if exists, no-op; if missing, create)
            const tagRes = await wpClient.createTag(addition.slug, addition.slug);
            if (tagRes.ok) {
                if (tagRes.created) {
                    result.approvedCreated++;
                    logger.info('taxonomy-sync: approved tag created', {
                        slug: addition.slug,
                        group: addition.group,
                    });
                } else {
                    result.approvedExisting++;
                }

                // Attempt to set Rank Math tag archive robots to noindex,follow
                // Best effort, non-blocking. Uses tag term ID.
                if (tagRes.id && rankMathRobotsKey) {
                    result.robotsUpdateAttempted++;
                    try {
                        const robotsOk = await setTagArchiveRobots(
                            wpClient,
                            tagRes.id,
                            rankMathRobotsKey
                        );
                        if (robotsOk) {
                            result.robotsUpdateSucceeded++;
                        } else {
                            result.robotsUpdateFailed++;
                        }
                    } catch {
                        result.robotsUpdateFailed++;
                        logger.warn('taxonomy-sync: robots update failed (non-blocking)', {
                            slug: addition.slug,
                        });
                    }
                }
            } else {
                result.approvedFailed.push({
                    slug: addition.slug,
                    error: tagRes.error || 'unknown',
                });
                logger.error('taxonomy-sync: approved tag creation failed', {
                    slug: addition.slug,
                });
            }
        }
    }

    return { plan, result };
}

/**
 * Set Rank Math tag archive robots to noindex,follow for a WP tag term.
 * Uses discovered key name (never hardcoded).
 * Best effort: returns false on failure, never throws.
 */
async function setTagArchiveRobots(
    wpClient: WpClient,
    tagId: number,
    robotsKey: string
): Promise<boolean> {
    try {
        // WP REST API for updating tag term meta:
        // PUT /wp-json/wp/v2/tags/{id} with { meta: { key: value } }
        const result = await wpClient.updateTagMeta(tagId, {
            [robotsKey]: 'noindex,follow',
        });
        return result;
    } catch {
        return false;
    }
}
