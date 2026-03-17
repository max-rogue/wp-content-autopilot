/**
 * Tests for Option B Dense Remainder Bundle.
 *
 * Covers:
 *   A) Dropped-tag report generation with mocked queue rows
 *   B) Scheduler lock + CRON gate for report task
 *   C) Taxonomy sync approved additions + robots update (mocked WP calls)
 *   D) Regression: Stage 6 does not create tags, still attaches-only, still records wp_tag_not_found
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { CronLockRepo, PublishQueueRepo } from '../db/repositories';
import {
    generateDroppedTagReport,
    type DroppedTagReport,
} from '../services/dropped-tag-report';
import {
    getReportLockKey,
} from '../scheduler';
import {
    executeTaxonomySync,
    buildSyncPlan,
} from '../services/taxonomy-sync';
import { runStage6 } from '../stages/stage6';
import type { Stage6Input } from '../stages/stage6';
import { SCHEMA_VERSION } from '../types';
import type { PipelineConfig } from '../config';

// ═══════════════════════════════════════════════════════════ A ═══
// A) Dropped-Tag Report Generation
// ═══════════════════════════════════════════════════════════════════

function makeTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    return db;
}

function insertQueueRow(
    db: Database.Database,
    id: string,
    overrides: {
        dropped_tags?: string | null;
        wp_tag_not_found?: string | null;
        days_ago?: number;
    } = {}
): void {
    const daysAgo = overrides.days_ago ?? 0;
    const updatedAt = daysAgo === 0
        ? "datetime('now')"
        : `datetime('now', '-${daysAgo} days')`;

    db.prepare(`
    INSERT INTO publish_queue (
      id, picked_keyword, normalized_keyword, language, idempotency_key,
      cluster, content_type, status, dropped_tags, wp_tag_not_found,
      updated_at
    ) VALUES (
      ?, 'test keyword', 'test-keyword', 'vi', ?,
      'test', 'BlogPost', 'draft_wp', ?, ?,
      ${updatedAt}
    )
  `).run(
        id,
        `idem-${id}`,
        overrides.dropped_tags ?? null,
        overrides.wp_tag_not_found ?? null
    );
}

describe('Dropped-Tag Report — Generation', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
    });

    afterEach(() => {
        db.close();
    });

    it('generates empty report when no tag data exists', () => {
        const { report } = generateDroppedTagReport({
            db,
            outputDir: require('os').tmpdir(),
        });

        expect(report.schema_version).toBe('1.0');
        expect(report.report_type).toBe('weekly_dropped_tags');
        expect(report.total_queue_rows_scanned).toBe(0);
        expect(report.dropped_tags.total_unique).toBe(0);
        expect(report.dropped_tags.total_occurrences).toBe(0);
        expect(report.wp_tag_not_found.total_unique).toBe(0);
    });

    it('aggregates dropped_tags counts from multiple rows', () => {
        insertQueueRow(db, 'row-1', {
            dropped_tags: JSON.stringify(['niche-ai', 'smart-niche']),
        });
        insertQueueRow(db, 'row-2', {
            dropped_tags: JSON.stringify(['niche-ai', 'new-tech']),
        });
        insertQueueRow(db, 'row-3', {
            dropped_tags: JSON.stringify(['niche-ai']),
        });

        const { report } = generateDroppedTagReport({
            db,
            outputDir: require('os').tmpdir(),
        });

        expect(report.total_queue_rows_scanned).toBe(3);
        expect(report.dropped_tags.total_unique).toBe(3);
        expect(report.dropped_tags.total_occurrences).toBe(5);

        // Deterministic ordering: niche-ai (3) first, then alpha
        expect(report.dropped_tags.top[0]).toEqual({ slug: 'niche-ai', count: 3 });
        expect(report.dropped_tags.top[1].count).toBe(1);
    });

    it('aggregates wp_tag_not_found counts', () => {
        insertQueueRow(db, 'row-1', {
            wp_tag_not_found: JSON.stringify(['brand-beta', 'brand-gamma']),
        });
        insertQueueRow(db, 'row-2', {
            wp_tag_not_found: JSON.stringify(['brand-beta']),
        });

        const { report } = generateDroppedTagReport({
            db,
            outputDir: require('os').tmpdir(),
        });

        expect(report.wp_tag_not_found.total_unique).toBe(2);
        expect(report.wp_tag_not_found.total_occurrences).toBe(3);
        expect(report.wp_tag_not_found.top[0]).toEqual({ slug: 'brand-beta', count: 2 });
    });

    it('respects window_days parameter — excludes old rows', () => {
        insertQueueRow(db, 'recent', {
            dropped_tags: JSON.stringify(['recent-tag']),
            days_ago: 2,
        });
        insertQueueRow(db, 'old', {
            dropped_tags: JSON.stringify(['old-tag']),
            days_ago: 10,
        });

        const { report } = generateDroppedTagReport({
            db,
            windowDays: 7,
            outputDir: require('os').tmpdir(),
        });

        expect(report.total_queue_rows_scanned).toBe(1);
        expect(report.dropped_tags.top[0].slug).toBe('recent-tag');
    });

    it('handles malformed JSON gracefully', () => {
        insertQueueRow(db, 'bad-json', {
            dropped_tags: 'not-valid-json',
            wp_tag_not_found: '42',
        });

        const { report } = generateDroppedTagReport({
            db,
            outputDir: require('os').tmpdir(),
        });

        // Should not crash, just ignore malformed data
        expect(report.total_queue_rows_scanned).toBe(1);
        expect(report.dropped_tags.total_occurrences).toBe(0);
    });

    it('caps top N results', () => {
        const tags = Array.from({ length: 30 }, (_, i) => `tag-${String(i).padStart(3, '0')}`);
        insertQueueRow(db, 'many-tags', {
            dropped_tags: JSON.stringify(tags),
        });

        const { report } = generateDroppedTagReport({
            db,
            topN: 5,
            outputDir: require('os').tmpdir(),
        });

        expect(report.dropped_tags.top.length).toBe(5);
        expect(report.dropped_tags.total_unique).toBe(30);
    });

    it('writes JSON artifact to disk', () => {
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tmpDir = path.join(os.tmpdir(), `wcap-test-${Date.now()}`);

        insertQueueRow(db, 'artifact-test', {
            dropped_tags: JSON.stringify(['test-tag']),
        });

        const { artifactPath } = generateDroppedTagReport({
            db,
            outputDir: tmpDir,
        });

        expect(fs.existsSync(artifactPath)).toBe(true);

        const content = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
        expect(content.schema_version).toBe('1.0');
        expect(content.report_type).toBe('weekly_dropped_tags');

        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ═══════════════════════════════════════════════════════════ B ═══
// B) Scheduler Lock + CRON Gate for Report Task
// ═══════════════════════════════════════════════════════════════════

describe('Report Scheduler — Lock Behavior', () => {
    let db: Database.Database;
    let lockRepo: CronLockRepo;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('journal_mode = WAL');
        runMigrations(db);
        lockRepo = new CronLockRepo(db);
    });

    afterEach(() => {
        db.close();
    });

    it('getReportLockKey returns report-YYYY-WNN format', () => {
        const key = getReportLockKey();
        expect(key).toMatch(/^report-\d{4}-W\d{2}$/);
    });

    it('report lock prevents duplicate report runs in same week', () => {
        const key = getReportLockKey();

        const first = lockRepo.tryAcquire(key, 'report-run-1');
        expect(first).toBe(true);

        const second = lockRepo.tryAcquire(key, 'report-run-2');
        expect(second).toBe(false);
    });

    it('report lock is independent from pipeline lock', () => {
        const reportKey = getReportLockKey();
        const pipelineKey = 'cron-2026-02-25';

        const reportAcquired = lockRepo.tryAcquire(reportKey, 'report-1');
        const pipelineAcquired = lockRepo.tryAcquire(pipelineKey, 'cron-1');

        expect(reportAcquired).toBe(true);
        expect(pipelineAcquired).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════ C ═══
// C) Taxonomy Sync — Approved Additions + Robots Update
// ═══════════════════════════════════════════════════════════════════

function mockWpClient() {
    const existingTags = new Map<string, { id: number; slug: string }>();
    const existingCats = new Map<string, { id: number; slug: string; name: string }>();
    const tagMetaUpdates: Array<{ tagId: number; meta: Record<string, string> }> = [];

    let nextId = 100;

    return {
        _existingTags: existingTags,
        _tagMetaUpdates: tagMetaUpdates,

        addExistingTag(slug: string) {
            existingTags.set(slug, { id: nextId++, slug });
        },

        addExistingCategory(slug: string, name: string) {
            existingCats.set(slug, { id: nextId++, slug, name });
        },

        async listAllCategories() {
            return [...existingCats.values()];
        },

        async listAllTags() {
            return [...existingTags.values()].map((t) => ({ ...t, name: t.slug }));
        },

        async findTagBySlug(slug: string) {
            return existingTags.get(slug) || undefined;
        },

        async findCategoryBySlug(slug: string) {
            return existingCats.get(slug) || undefined;
        },

        async createCategory(slug: string, name: string) {
            const id = nextId++;
            existingCats.set(slug, { id, slug, name });
            return { ok: true, id, slug, created: true };
        },

        async createTag(slug: string, name: string) {
            if (existingTags.has(slug)) {
                const existing = existingTags.get(slug)!;
                return { ok: true, id: existing.id, slug: existing.slug, created: false };
            }
            const id = nextId++;
            existingTags.set(slug, { id, slug });
            return { ok: true, id, slug, created: true };
        },

        async updateTagMeta(tagId: number, meta: Record<string, string>) {
            tagMetaUpdates.push({ tagId, meta });
            return true;
        },

        async updatePost(_id: number, _p: any) {
            return { ok: true, data: { id: _id, slug: 'test', link: 'http://test.com' }, status: 200 };
        },
    };
}

describe('Taxonomy Sync — Approved Additions', () => {
    it('creates approved tags idempotently', async () => {
        const wp = mockWpClient();

        const { result } = await executeTaxonomySync(
            wp as any,
            [],
            [],
            [
                { slug: 'new-brand-a', group: 'brand' },
                { slug: 'new-brand-b', group: 'brand' },
            ],
            ''
        );

        expect(result.approvedCreated).toBe(2);
        expect(result.approvedExisting).toBe(0);
        expect(result.approvedFailed.length).toBe(0);
    });

    it('skips existing approved tags without error', async () => {
        const wp = mockWpClient();
        wp.addExistingTag('existing-tag');

        const { result } = await executeTaxonomySync(
            wp as any,
            [],
            [],
            [{ slug: 'existing-tag', group: 'brand' }],
            ''
        );

        expect(result.approvedCreated).toBe(0);
        expect(result.approvedExisting).toBe(1);
        expect(result.approvedFailed.length).toBe(0);
    });

    it('attempts Rank Math robots update for approved tags when key provided', async () => {
        const wp = mockWpClient();

        const { result } = await executeTaxonomySync(
            wp as any,
            [],
            [],
            [{ slug: 'rm-test-tag', group: 'brand' }],
            'rank_math_robots'
        );

        expect(result.robotsUpdateAttempted).toBe(1);
        expect(result.robotsUpdateSucceeded).toBe(1);
        expect(result.robotsUpdateFailed).toBe(0);

        // Verify the meta update was called with discovered key, not hardcoded
        expect(wp._tagMetaUpdates.length).toBe(1);
        expect(wp._tagMetaUpdates[0].meta).toEqual({
            rank_math_robots: 'noindex,follow',
        });
    });

    it('skips robots update when no Rank Math key provided', async () => {
        const wp = mockWpClient();

        const { result } = await executeTaxonomySync(
            wp as any,
            [],
            [],
            [{ slug: 'no-rm-tag', group: 'brand' }],
            '' // empty key
        );

        expect(result.robotsUpdateAttempted).toBe(0);
        expect(wp._tagMetaUpdates.length).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════ D ═══
// D) Regression: Stage 6 — No Tag Creation, Attach-Only
// ═══════════════════════════════════════════════════════════════════

function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
    return {
        appEnv: 'test',
        siteBaseUrl: 'http://localhost:8080',
        serviceBaseUrl: 'http://127.0.0.1:3100',
        servicePort: 3100,
        wpBaseUrl: 'http://localhost:8080',
        wpApiUser: 'test',
        wpApplicationPassword: 'test',
        aiProvider: 'openai',
        aiApiKey: '',
        openaiApiKey: '',
        geminiApiKey: '',
        llmResearchProvider: 'openai',
        llmResearchModel: 'gpt-4o',
        llmDraftProvider: 'openai',
        llmDraftModel: 'gpt-4o',
        llmFinalProvider: 'openai',
        llmFinalModel: 'gpt-4o',
        llmImageProvider: 'gemini',
        llmImageModel: 'gemini-2.0-flash',
        llmResearchGrounding: '',
        llmImageRequired: true,
        geminiApiMode: 'genai_sdk',
        mediaProvider: 'none',
        mediaApiKey: '',
        dailyJobQuota: 1,
        publishPosture: 'always_draft' as const,
        requireHumanApproval: false,
        logLevel: 'silent',
        stopOnCoverageSpike: true,
        stopOnIndexDrop: true,
        stopOnFailRate: true,
        indexingLagThreshold: 0.4,
        coverageErrorWowThreshold: 0.2,
        impressionsDropThreshold: 0.25,
        embeddingProvider: 'disabled',
        embeddingEndpoint: '',
        embeddingApiKey: '',
        localDbEnabled: true,
        dbPath: ':memory:',
        keywordCsvPath: './data/keyword.csv',
        cronEnabled: false,
        cronSchedule: '0 6 * * *',
        cronTimezone: 'Asia/Ho_Chi_Minh',
        rankmath: {
            keyTitle: 'rank_math_title',
            keyDescription: 'rank_math_description',
            keyFocusKeyword: 'rank_math_focus_keyword',
            keyRobots: 'rank_math_robots',
            keyCanonical: 'rank_math_canonical_url',
            keySchemaType: 'rank_math_schema_type',
        },
        maxConcurrentRuns: 1,
        maxJobsPerTick: 1,
        dailyCostCapUsd: 5,
        perJobCostCapUsd: 1,
        maxRetryAttempts: 3,
        retryBackoffMs: 2000,
        jitterMs: 250,
        recoveryReplayLimit: 20,
        recoveryLookbackMinutes: 60,
        publishPostureSource: 'default' as const,
        internalLinksEnabled: false,
        geminiThinkingLevel: 'HIGH',
        maxOutputTokensResearch: 8192,
        maxOutputTokensDraft: 8192,
        maxOutputTokensFinal: 8192,
        maxOutputTokensHtml: 8192,
        ...overrides,
    };
}

describe('Stage 6 Regression — Tag Handling', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeTestDb();
        // Insert a queue row for Stage 6 to update
        db.prepare(`
      INSERT INTO publish_queue (
        id, picked_keyword, normalized_keyword, language, idempotency_key,
        cluster, content_type, status
      ) VALUES (
        'q-tag-test', 'test keyword', 'test-keyword', 'vi', 'idem-tag-test',
        'general', 'BlogPost', 'qa'
      )
    `).run();
    });

    afterEach(() => {
        db.close();
    });

    it('Stage 6 does NOT create tags — only attaches existing ones', async () => {
        const wp = mockWpClient();
        // Only 'brand-alpha' exists in WP — 'new-tag' does not
        wp.addExistingTag('brand-alpha');
        wp.addExistingCategory('general', 'General');

        // Track createTag calls
        const createTagCalls: string[] = [];
        const originalCreateTag = wp.createTag.bind(wp);
        (wp as any).createTag = async (slug: string, name: string) => {
            createTagCalls.push(slug);
            return originalCreateTag(slug, name);
        };

        const input: Stage6Input = {
            queueId: 'q-tag-test',
            stage3: {
                schema_version: SCHEMA_VERSION,
                title: 'Test Post',
                content_markdown: '# Test',
                excerpt: 'Test excerpt',
                suggested_slug: 'test-post',
                category: 'General',
                tags: ['brand-alpha', 'new-tag'], // includes non-existing tag
                focus_keyword: 'test',
                additional_keywords: [],
                meta_title: 'Test',
                meta_description: 'Test description for SEO',
                faq: [],
                featured_image: { prompt: 'test', alt_text: 'test image' },
                citations: [],
                publish_recommendation: 'DRAFT',
                reasons: [],
                missing_data_fields: [],
            },
            stage4: {
                schema_version: SCHEMA_VERSION,
                featured_image: { prompt: 'test', alt_text: 'test image' },
                inline_image: null,
                media_mode: 'image_only',
                images: { featured: null, hero: null },
            },
            stage5: {
                schema_version: SCHEMA_VERSION,
                publish_recommendation: 'DRAFT',
                slug_final: 'test-post',
                rankmath: {
                    focus_keyword: 'test',
                    meta_title: 'Test',
                    meta_description: 'Test description for SEO',
                    canonical: 'http://localhost:8080/test-post',
                    robots: 'index,follow',
                    schema_type: 'BlogPosting',
                },
                taxonomy: {
                    category: 'general',
                    tags: ['brand-alpha', 'new-tag'], // Stage 5 filtered tags
                    dropped_tags: ['some-dropped'],
                },
                gate_results: {},
                reasons: [],
            },
            config: makeConfig(),
            wpClient: {
                findBySlug: async () => ({ ok: true, status: 200 }),
                findCategoryBySlug: async (slug: string) => {
                    const cat = wp._existingTags; // just use wp mock
                    return wp.findCategoryBySlug(slug);
                },
                createDraft: async (payload: any) => ({
                    ok: true,
                    data: { id: 42, slug: payload.slug, link: `http://localhost:8080/${payload.slug}`, status: 'draft' },
                    status: 201,
                }),
                updatePost: async (_id: number, _p: any) => ({
                    ok: true,
                    data: { id: _id, slug: 'test-post', link: 'http://localhost:8080/test-post', status: 'draft' },
                    status: 200,
                }),
                findTagBySlug: async (slug: string) => wp.findTagBySlug(slug),
                createCategory: async (slug: string, name: string) => wp.createCategory(slug, name),
            } as any,
            rankMathService: {
                isDiscovered: () => true,
                writeMeta: async () => ({ ok: true, method: 'direct_postmeta' as const }),
                verifyMeta: async () => ({ ok: true }),
            } as any,
            queueRepo: new PublishQueueRepo(db),
            contentIndexRepo: {
                upsert: () => { },
            } as any,
        };

        const result = await runStage6(input);

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');

        // KEY REGRESSION CHECK: Stage 6 must NOT have called createTag
        // It should only lookup (findTagBySlug), never create
        expect(createTagCalls.length).toBe(0);
    });

    it('Stage 6 records wp_tag_not_found when tag missing from WP', async () => {
        const wp = mockWpClient();
        wp.addExistingCategory('general', 'General');
        // No tags exist in WP

        const input: Stage6Input = {
            queueId: 'q-tag-test',
            stage3: {
                schema_version: SCHEMA_VERSION,
                title: 'Test Post',
                content_markdown: '# Test',
                excerpt: 'Test excerpt',
                suggested_slug: 'test-post-2',
                category: 'General',
                tags: ['missing-tag'],
                focus_keyword: 'test',
                additional_keywords: [],
                meta_title: 'Test',
                meta_description: 'Test description for SEO',
                faq: [],
                featured_image: { prompt: 'test', alt_text: 'test image' },
                citations: [],
                publish_recommendation: 'DRAFT',
                reasons: [],
                missing_data_fields: [],
            },
            stage4: {
                schema_version: SCHEMA_VERSION,
                featured_image: { prompt: 'test', alt_text: 'test image' },
                inline_image: null,
                media_mode: 'image_only',
                images: { featured: null, hero: null },
            },
            stage5: {
                schema_version: SCHEMA_VERSION,
                publish_recommendation: 'DRAFT',
                slug_final: 'test-post-2',
                rankmath: {
                    focus_keyword: 'test',
                    meta_title: 'Test',
                    meta_description: 'Test description for SEO',
                    canonical: 'http://localhost:8080/test-post-2',
                    robots: 'index,follow',
                    schema_type: 'BlogPosting',
                },
                taxonomy: {
                    category: 'general',
                    tags: ['missing-tag'],
                    dropped_tags: [],
                },
                gate_results: {},
                reasons: [],
            },
            config: makeConfig(),
            wpClient: {
                findBySlug: async () => ({ ok: true, status: 200 }),
                findCategoryBySlug: wp.findCategoryBySlug.bind(wp),
                createDraft: async (payload: any) => ({
                    ok: true,
                    data: { id: 43, slug: payload.slug, link: `http://localhost:8080/${payload.slug}`, status: 'draft' },
                    status: 201,
                }),
                updatePost: async (_id: number, _p: any) => ({
                    ok: true,
                    data: { id: _id, slug: 'test-post-2', link: 'http://localhost:8080/test-post-2', status: 'draft' },
                    status: 200,
                }),
                findTagBySlug: async (_slug: string) => undefined, // Tag NOT found
                createCategory: wp.createCategory.bind(wp),
            } as any,
            rankMathService: {
                isDiscovered: () => true,
                writeMeta: async () => ({ ok: true, method: 'direct_postmeta' as const }),
                verifyMeta: async () => ({ ok: true }),
            } as any,
            queueRepo: new PublishQueueRepo(db),
            contentIndexRepo: {
                upsert: () => { },
            } as any,
        };

        const result = await runStage6(input);

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');

        // Verify wp_tag_not_found was recorded in reasons
        expect(result.output?.reasons.some((r) => r.includes('wp_tag_not_found'))).toBe(true);

        // Verify the queue row has wp_tag_not_found persisted
        const queueRow = (new PublishQueueRepo(db)).findById('q-tag-test');
        expect(queueRow?.wp_tag_not_found).toBeTruthy();
        const notFound = JSON.parse(queueRow!.wp_tag_not_found!);
        expect(notFound).toContain('missing-tag');
    });
});
