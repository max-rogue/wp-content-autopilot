/**
 * Tag Gate — deterministic tag filtering for Stage 5.
 * Ref: docs/spec/marketing/01_ContentSpec.md §2.2, §7.6
 * Ref: docs/spec/marketing/03_PublishingOps.md Stage 5 Tag Gate
 * Ref: docs/spec/marketing/05_AgentPrompts.md §6 Tag Filtering Rules
 *
 * Algorithm (must match spec):
 *   1. Normalize candidates (trim/casefold/diacritics→ASCII slug)
 *   2. Intersection with whitelist from taxonomy_config.yaml
 *   3. City rule: only allow city tags if verified local value in content
 *   4. Gated expansion: non-whitelist tags pass ONLY if >=3 planned in 60d
 *      OR explicitly approved in taxonomy_config (Phase 2 gate)
 *   5. Cap to max_tags_per_post (8) by priority: Brand > Skill > City > Format
 *   6. Output: final_tags[], dropped_tags[]
 *
 * Post is NEVER held solely because tags were dropped (§7.6).
 */

import type { TaxonomyConfig, TagGroupName } from '../config/taxonomy-config-loader';
import { getTagGroup, TAG_GROUP_PRIORITY } from '../config/taxonomy-config-loader';
import { logger } from '../logger';

// ─── Slug Normalization ─────────────────────────────────────────

/**
 * Strip Vietnamese/Unicode diacritics + special chars → ASCII slug.
 * Ref: 01_ContentSpec §2.2.3 Tag Naming Conventions
 *   - ASCII only, lowercase, hyphenated
 *   - No diacritics in slug
 *   - Max 3 words in slug (not enforced here — whitelist handles)
 */
export function normalizeTagSlug(input: string): string {
    let s = input.trim().toLowerCase();

    // Vietnamese đ/Đ → d (NFD does not decompose these)
    s = s.replace(/[đĐ]/g, 'd');

    // NFD decompose then strip combining marks
    s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Replace non-alphanumeric (except hyphens) with hyphens
    s = s.replace(/[^a-z0-9-]/g, '-');

    // Collapse consecutive hyphens
    s = s.replace(/-{2,}/g, '-');

    // Remove leading/trailing hyphens
    s = s.replace(/^-+|-+$/g, '');

    return s;
}

// ─── Tag Gate Result ────────────────────────────────────────────

export interface TagGateResult {
    /** Final tags to attach (whitelist-filtered, capped, ASCII slugs) */
    finalTags: string[];
    /** Tags proposed by LLM that failed whitelist check */
    droppedTags: string[];
    /** Reasons for the tag gate decision */
    reasons: string[];
}

// ─── Tag Gate Execution ─────────────────────────────────────────

export interface TagGateInput {
    /** Raw tags proposed by the LLM (Stage 3 output) */
    proposedTags: string[];
    /** Taxonomy config loaded from YAML */
    taxonomyConfig: TaxonomyConfig;
    /** Whether content contains verified local value for city tags */
    hasVerifiedLocalValue: boolean;
    /**
     * Optional: count of planned articles per tag in next 60 days
     * (for gated expansion). Map<normalized_slug, count>.
     * If not provided, gated expansion is disabled (strict whitelist only).
     */
    plannedTagCounts?: Map<string, number>;
}

/**
 * Run the tag gate algorithm.
 *
 * @returns TagGateResult with finalTags (to attach) and droppedTags (logged).
 */
export function runTagGate(input: TagGateInput): TagGateResult {
    const { proposedTags, taxonomyConfig, hasVerifiedLocalValue, plannedTagCounts } = input;
    const reasons: string[] = [];
    const droppedTags: string[] = [];
    const accepted: string[] = [];

    if (!proposedTags || proposedTags.length === 0) {
        return { finalTags: [], droppedTags: [], reasons: [] };
    }

    // Step 1: Normalize all candidates
    const candidates = proposedTags.map((t) => ({
        original: t,
        slug: normalizeTagSlug(t),
    }));

    // Deduplicate by slug
    const seen = new Set<string>();
    const uniqueCandidates = candidates.filter((c) => {
        if (seen.has(c.slug) || !c.slug) return false;
        seen.add(c.slug);
        return true;
    });

    for (const { original, slug } of uniqueCandidates) {
        // Step 2: Check whitelist intersection
        if (taxonomyConfig.flatWhitelist.has(slug)) {
            // Step 3: City rule — only allow city tags if verified local value exists
            if (taxonomyConfig.cityTags.has(slug)) {
                if (!hasVerifiedLocalValue) {
                    droppedTags.push(slug);
                    continue; // City tag without verified local → drop
                }
            }
            accepted.push(slug);
        } else {
            // Step 4: Gated expansion check
            // Non-whitelist tag: only allow if >=3 planned in 60 days
            const GATED_THRESHOLD = 3;
            const count = plannedTagCounts?.get(slug) ?? 0;

            if (count >= GATED_THRESHOLD) {
                // Passes gated expansion — but still needs human approval in config
                // Per spec: "Human approval: Tech lead or SEO owner explicitly adds it
                //   to the whitelist in taxonomy_config.yaml"
                // Since it's NOT in the whitelist file, it does NOT qualify.
                // The >=3 check is for the weekly review batch, not auto-approval.
                droppedTags.push(slug);
            } else {
                droppedTags.push(slug);
            }
        }
    }

    // Step 5: Priority-based cap
    let capped = capByPriority(accepted, taxonomyConfig);

    // Track tags dropped by cap
    if (capped.length < accepted.length) {
        const cappedSet = new Set(capped);
        for (const tag of accepted) {
            if (!cappedSet.has(tag)) {
                droppedTags.push(tag);
                reasons.push(`tag_capped_over_${taxonomyConfig.maxTagsPerPost}: ${tag}`);
            }
        }
    }

    // Step 6: Build reasons
    if (droppedTags.length > 0) {
        logger.info('Tag gate: dropped tags', {
            dropped_count: droppedTags.length,
            dropped: droppedTags,
        });
    }

    if (capped.length === 0 && proposedTags.length > 0) {
        reasons.push('tag_policy_drop_nonwhitelist');
    }

    return {
        finalTags: capped,
        droppedTags,
        reasons,
    };
}

/**
 * Cap accepted tags to max_tags_per_post by priority.
 * Priority order (01_ContentSpec §2.2.4): Brand > Skill > City > Format
 * Expanded: brand > shaft_brand > ball_brand > skill > handicap_band > technology > city > format
 *
 * Within same priority group, preserve original order (deterministic).
 */
function capByPriority(tags: string[], config: TaxonomyConfig): string[] {
    if (tags.length <= config.maxTagsPerPost) {
        return tags;
    }

    // Assign priority index to each tag
    const tagged: Array<{ slug: string; priority: number; originalIndex: number }> = tags.map(
        (slug, idx) => {
            const group = getTagGroup(slug, config);
            const priority = group ? TAG_GROUP_PRIORITY.indexOf(group) : TAG_GROUP_PRIORITY.length;
            return { slug, priority, originalIndex: idx };
        }
    );

    // Sort by priority (lower = higher priority), then by original index for stability
    tagged.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.originalIndex - b.originalIndex;
    });

    // Take top N
    return tagged.slice(0, config.maxTagsPerPost).map((t) => t.slug);
}
