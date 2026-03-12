/**
 * Publisher Tests — draft_wp invariant, HOLD block, idempotency
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.7
 * Ref: 32_IDEMPOTENCY_AND_RETRY
 * Ref: 31_WP_PUBLISHING_CONTRACTS
 *
 * Key invariants tested:
 * - draft_wp ONLY if wp_post_id > 0 AND WP REST returned 2xx
 * - HOLD → no WP post created
 * - DRAFT → creates draft only with wp_post_id > 0
 * - Idempotency: same key does NOT create duplicate
 * - Fail-closed on WP errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo, ContentIndexRepo } from '../db/repositories';
import { runStage6 } from './stage6';
import { SCHEMA_VERSION, type Stage3Output, type Stage3_5Output, type Stage4Output, type Stage5Output } from '../types';
import { v4 as uuid } from 'uuid';
import type { PipelineConfig } from '../config';

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

function makeConfig(): PipelineConfig {
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
        publishPostureSource: 'default' as const,
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
        internalLinksEnabled: false,
        geminiThinkingLevel: 'HIGH',
        maxOutputTokensResearch: 8192,
        maxOutputTokensDraft: 8192,
        maxOutputTokensFinal: 8192,
        maxOutputTokensHtml: 8192,
        pipelineDailyQuota: undefined,
        sitemapSnippetMaxUrls: 20,
        sitemapSnippetMaxChars: 4000,
        newsEnabled: false,
        newsFeeds: [],
        newsLookbackHours: 24,
        newsMaxItemsPerTick: 3,
        newsHttpTimeoutMs: 5000,
        defaultLanguage: 'en',
    };
}

function makeStage3(): Stage3Output {
    return {
        schema_version: SCHEMA_VERSION,
        title: 'Test Title',
        content_markdown: '# Test',
        excerpt: 'Test excerpt',
        suggested_slug: 'test-slug',
        category: 'hoc-golf',
        tags: ['golf'],
        focus_keyword: 'test keyword',
        additional_keywords: [],
        meta_title: 'Test | MySite',
        meta_description:
            'A comprehensive test description for the pipeline publisher stage verification.',
        faq: [
            { question: 'Q1?', answer: 'A1' },
            { question: 'Q2?', answer: 'A2' },
            { question: 'Q3?', answer: 'A3' },
        ],
        featured_image: { prompt: 'test', alt_text: 'test' },
        citations: [],
        publish_recommendation: 'DRAFT',
        reasons: [],
        missing_data_fields: [],
    };
}

function makeStage4(): Stage4Output {
    return {
        schema_version: SCHEMA_VERSION,
        featured_image: { prompt: 'test', alt_text: 'test' },
        inline_image: null,
        media_mode: 'image_only',
        images: { featured: null, hero: null },
    };
}

function makeStage5Hold(): Stage5Output {
    return {
        schema_version: SCHEMA_VERSION,
        publish_recommendation: 'HOLD',
        slug_final: 'test-slug',
        rankmath: {
            focus_keyword: 'test',
            meta_title: 'Test | MySite',
            meta_description: 'Test desc',
            canonical: 'http://localhost/blog/test-slug',
            robots: 'index,follow',
            schema_type: 'BlogPosting',
        },
        taxonomy: { category: 'hoc-golf', tags: [], dropped_tags: [] },
        gate_results: {},
        reasons: ['test_hold_reason'],
    };
}

function makeStage5Draft(): Stage5Output {
    return {
        schema_version: SCHEMA_VERSION,
        publish_recommendation: 'DRAFT',
        slug_final: 'test-slug',
        rankmath: {
            focus_keyword: 'test',
            meta_title: 'Test | MySite',
            meta_description: 'Test desc',
            canonical: 'http://localhost/blog/test-slug',
            robots: 'index,follow',
            schema_type: 'BlogPosting',
        },
        taxonomy: { category: 'hoc-golf', tags: ['titleist'], dropped_tags: [] },
        gate_results: {},
        reasons: [],
    };
}

function makeStage5Publish(): Stage5Output {
    return {
        schema_version: SCHEMA_VERSION,
        publish_recommendation: 'PUBLISH',
        slug_final: 'test-slug',
        rankmath: {
            focus_keyword: 'test',
            meta_title: 'Test | MySite',
            meta_description: 'Test desc',
            canonical: 'http://localhost/blog/test-slug',
            robots: 'index,follow',
            schema_type: 'BlogPosting',
        },
        taxonomy: { category: 'hoc-golf', tags: ['titleist'], dropped_tags: [] },
        gate_results: {},
        reasons: [],
    };
}

function insertQueueItem(repo: PublishQueueRepo, id: string): void {
    repo.insert({
        id,
        picked_keyword: 'test keyword',
        normalized_keyword: 'test keyword',
        language: 'vi',
        idempotency_key: `key-${id}`,
        cluster: 'test',
        content_type: 'BlogPost',
        class_hint: 'B',
        blogpost_subtype: null,
        status: 'qa',
        scheduled_for: null,
        published_url: null,
        published_wp_id: null,
        fail_reasons: null,
        model_trace: null,
        similarity_score: null,
        similarity_band: null,
        robots_decision: null,
        gate_results: null,
        dropped_tags: null,
        wp_tag_not_found: null,
        canonical_category: null,
        news_source_url: null,
        news_source_name: null,
    });
}

// Mock WpClient
function mockWpClient(opts?: {
    createDraftOk?: boolean;
    createDraftId?: number;
    findBySlugResult?: { ok: boolean; data?: { id: number; slug: string; link: string; status: string } };
    updatePostOk?: boolean;
    findCategoryResult?: { id: number; slug: string } | null;
    findTagResult?: { id: number; slug: string } | null;
    createCategoryOk?: boolean;
    createCategoryId?: number;
}) {
    const categoryResult = opts && 'findCategoryResult' in opts
        ? (opts.findCategoryResult ?? undefined)
        : { id: 1, slug: 'hoc-golf' };
    const tagResult = opts && 'findTagResult' in opts
        ? (opts.findTagResult ?? undefined)
        : { id: 1, slug: 'golf' };

    return {
        createDraft: vi.fn().mockResolvedValue({
            ok: opts?.createDraftOk ?? true,
            data: opts?.createDraftOk !== false
                ? { id: opts?.createDraftId ?? 123, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' }
                : undefined,
            status: opts?.createDraftOk !== false ? 201 : 500,
            error: opts?.createDraftOk === false ? 'server error' : undefined,
        }),
        updatePost: vi.fn().mockResolvedValue({
            ok: opts?.updatePostOk ?? true,
            data: opts?.updatePostOk !== false
                ? { id: opts?.createDraftId ?? 123, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' }
                : undefined,
            status: opts?.updatePostOk !== false ? 200 : 500,
            error: opts?.updatePostOk === false ? 'server error' : undefined,
        }),
        findBySlug: vi.fn().mockResolvedValue(
            opts?.findBySlugResult ?? { ok: true, status: 200 }
        ),
        findCategoryBySlug: vi.fn().mockResolvedValue(categoryResult),
        findTagBySlug: vi.fn().mockResolvedValue(tagResult),
        getPost: vi.fn().mockResolvedValue({
            ok: true,
            data: {
                id: opts?.createDraftId ?? 123,
                meta: {
                    rank_math_title: 'Test | MySite',
                    rank_math_description: 'Test desc',
                    rank_math_focus_keyword: 'test',
                },
            },
            status: 200,
        }),
        uploadMedia: vi.fn().mockResolvedValue({
            ok: true,
            data: { id: 10, source_url: 'http://localhost/media.jpg', slug: 'media' },
            status: 201,
        }),
        createCategory: vi.fn().mockResolvedValue({
            ok: opts?.createCategoryOk ?? true,
            id: opts?.createCategoryId ?? 50,
            slug: 'auto-created-slug',
            created: true,
        }),
    } as any;
}

// Mock RankMathService
function mockRankMathService(opts?: { isDiscovered?: boolean; writeOk?: boolean; verifyOk?: boolean }) {
    return {
        isDiscovered: vi.fn().mockReturnValue(opts?.isDiscovered ?? true),
        writeMeta: vi.fn().mockResolvedValue({
            ok: opts?.writeOk ?? true,
            method: 'direct_postmeta',
        }),
        verifyMeta: vi.fn().mockResolvedValue({
            ok: opts?.verifyOk ?? true,
        }),
        buildMetaObject: vi.fn().mockReturnValue({}),
    } as any;
}

describe('Stage 6 — Publisher', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    let contentIndexRepo: ContentIndexRepo;
    let config: PipelineConfig;

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        contentIndexRepo = new ContentIndexRepo(db);
        config = makeConfig();
    });

    // ── HOLD blocks post creation ────────────────────────────────

    it('HOLD → no WP post created, status=hold', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient();
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Hold(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('hold');
        expect(result.output?.wp_post_id).toBe(0);

        // WP client should NOT have been called
        expect(wpClient.createDraft).not.toHaveBeenCalled();

        // Queue status should be hold
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('hold');
    });

    // ── DRAFT creates WP draft with valid wp_post_id ─────────────

    it('DRAFT → creates draft, wp_post_id > 0, status=draft_wp', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 456 });
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.wp_post_id).toBe(456);
        expect(result.output?.wp_post_id).toBeGreaterThan(0);
        expect(result.output?.final_status).toBe('draft_wp');

        // Queue should be draft_wp
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('draft_wp');
        expect(item?.published_wp_id).toBe(456);
    });

    // ── draft_wp invariant: ONLY if wp_post_id > 0 AND 2xx───────

    it('fail-closed: WP create fails → status=failed, NOT draft_wp', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftOk: false });
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.output?.final_status).toBe('failed');
        expect(result.output?.wp_post_id).toBe(0);

        // Queue status should NOT be draft_wp
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('failed');
        expect(item?.status).not.toBe('draft_wp');
    });

    // ── Idempotency: update existing draft ──────────────────────

    it('idempotent: existing draft → update instead of create', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({
            findBySlugResult: {
                ok: true,
                data: { id: 789, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
            },
            createDraftId: 789,
        });
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        // createDraft should NOT be called; updatePost should be called
        expect(wpClient.createDraft).not.toHaveBeenCalled();
        expect(wpClient.updatePost).toHaveBeenCalled();
    });

    // ── schema_version in output ─────────────────────────────────

    it('schema_version is "1.0" in all outputs', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient();
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.output?.schema_version).toBe('1.0');
    });

    // ── Category not found → HOLD ────────────────────────────────

    it('category not found → HOLD, no post created', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        // Use a non-canonical category that can't be resolved
        const wpClient = mockWpClient({ findCategoryResult: null });
        const rankMath = mockRankMathService();

        const s3 = makeStage3();
        s3.category = 'Non Existent Category'; // not resolvable to any canonical slug

        // Clear stage5 taxonomy category so stage3 path is tested
        const s5 = makeStage5Draft();
        s5.taxonomy = { category: '', tags: ['titleist'], dropped_tags: [] };

        const result = await runStage6({
            queueId,
            stage3: s3,
            stage4: makeStage4(),
            stage5: s5,
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.output?.final_status).toBe('hold');
        expect(result.output?.reasons).toContain('category_not_canonical');
    });

    // ── BUG REGRESSION: display name resolves to slug ─────────────

    it('BUG REGRESSION: stage3.category="Golf Công Nghệ" resolves to slug and succeeds when WP has it', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        // WP has the category with slug 'golf-cong-nghe' even though display name differs
        const wpClient = mockWpClient({
            createDraftId: 200,
            findCategoryResult: { id: 42, slug: 'golf-cong-nghe' },
        });
        const rankMath = mockRankMathService();

        const s3 = makeStage3();
        s3.category = 'Golf Công Nghệ'; // display name, not slug

        // Clear stage5 taxonomy category so stage3 label-resolution path is tested
        const s5 = makeStage5Draft();
        s5.taxonomy = { category: '', tags: ['titleist'], dropped_tags: [] };

        const result = await runStage6({
            queueId,
            stage3: s3,
            stage4: makeStage4(),
            stage5: s5,
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.wp_post_id).toBe(200);
        // Should have been looked up by canonical slug, not display name
        expect(wpClient.findCategoryBySlug).toHaveBeenCalledWith('golf-cong-nghe');
    });

    it('auto-creates category in WP when canonical slug is valid but WP category missing', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        // WP does NOT have the category yet
        const wpClient = mockWpClient({
            createDraftId: 201,
            findCategoryResult: null,       // not found in WP
            createCategoryOk: true,
            createCategoryId: 55,
        });
        const rankMath = mockRankMathService();

        const s3 = makeStage3();
        s3.category = 'hoc-golf'; // canonical slug

        const result = await runStage6({
            queueId,
            stage3: s3,
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        // createCategory should have been called with canonical slug and name
        expect(wpClient.createCategory).toHaveBeenCalledWith('hoc-golf', 'Học Golf');
    });

    it('non-canonical category input → HOLD', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient();
        const rankMath = mockRankMathService();

        const s3 = makeStage3();
        s3.category = 'Totally Random Category'; // not canonical/resolvable

        // Clear stage5 taxonomy category so the HOLD path is reached
        const s5 = makeStage5Draft();
        s5.taxonomy = { category: '', tags: ['titleist'], dropped_tags: [] };

        const result = await runStage6({
            queueId,
            stage3: s3,
            stage4: makeStage4(),
            stage5: s5,
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.output?.final_status).toBe('hold');
        expect(result.output?.reasons).toContain('category_not_canonical');
        expect(wpClient.createDraft).not.toHaveBeenCalled();
    });

    it('WP category create fails → HOLD with category_create_failed', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({
            findCategoryResult: null,       // not found in WP
            createCategoryOk: false,        // create fails
        });
        // Override createCategory mock manually to simulate failure
        wpClient.createCategory = vi.fn().mockResolvedValue({
            ok: false,
            created: false,
            error: 'WP 500',
        });
        const rankMath = mockRankMathService();

        const s3 = makeStage3();
        s3.category = 'hoc-golf'; // canonical slug, but WP create will fail

        const result = await runStage6({
            queueId,
            stage3: s3,
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.output?.final_status).toBe('hold');
        expect(result.output?.reasons).toContain('category_create_failed');
    });

    // ── BUG REGRESSION: WP success + DRAFT + RankMath fail => NOT failed ──

    it('WP success + recommendation=DRAFT + RankMath write fails → status=draft_wp, NOT failed', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 51 });
        const rankMath = mockRankMathService({ writeOk: false });

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        // WP succeeded → must be draft_wp, never failed
        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.final_status).not.toBe('failed');
        expect(result.output?.wp_post_id).toBe(51);
        expect(result.output?.rankmath_write_result).toBe('failed');

        // Queue row must reflect draft_wp
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('draft_wp');
        expect(item?.published_wp_id).toBe(51);
    });

    it('WP success + RankMath NOT discovered → status=draft_wp, NOT failed', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 77 });
        const rankMath = mockRankMathService({ isDiscovered: false });

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.final_status).not.toBe('failed');
        expect(result.output?.wp_post_id).toBe(77);
        expect(result.output?.reasons).toContain('rankmath_keys_not_discovered — meta write skipped');

        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('draft_wp');
    });

    it('WP success + RankMath verify fails → status=draft_wp with reasons', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 88 });
        const rankMath = mockRankMathService({ verifyOk: false });

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.final_status).not.toBe('failed');
        expect(result.output?.wp_post_id).toBe(88);
        expect(result.output?.reasons).toContain('rankmath_verification_failed');
        expect(result.output?.rankmath_write_result).toBe('failed');

        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('draft_wp');
    });

    // ── INVARIANT: status=failed → fail_reasons MUST be populated ─────

    it('INVARIANT: WP create fails → status=failed AND fail_reasons is non-null, non-empty', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftOk: false });
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.output?.final_status).toBe('failed');

        // fail_reasons in DB MUST be populated
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('failed');
        expect(item?.fail_reasons).not.toBeNull();
        const reasons = JSON.parse(item!.fail_reasons!);
        expect(Array.isArray(reasons)).toBe(true);
        expect(reasons.length).toBeGreaterThan(0);
    });

    it('INVARIANT: WP update fails → status=failed AND fail_reasons is non-null, non-empty', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({
            findBySlugResult: {
                ok: true,
                data: { id: 99, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
            },
            updatePostOk: false,
        });
        const rankMath = mockRankMathService();

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.output?.final_status).toBe('failed');

        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('failed');
        expect(item?.fail_reasons).not.toBeNull();
        const reasons = JSON.parse(item!.fail_reasons!);
        expect(Array.isArray(reasons)).toBe(true);
        expect(reasons.length).toBeGreaterThan(0);
    });

    // ── Tag Attachment: NO auto-create tags ───────────────────────

    it('wp_tag_not_found is recorded when tag slug not in WP', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({
            createDraftId: 300,
            findTagResult: null, // ALL tags will be "not found"
        });
        const rankMath = mockRankMathService();

        const s5 = makeStage5Draft();
        s5.taxonomy = {
            category: 'hoc-golf',
            tags: ['titleist', 'callaway'],
            dropped_tags: [],
        };

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: s5,
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.reasons).toEqual(
            expect.arrayContaining([expect.stringContaining('wp_tag_not_found')])
        );

        // createTag should NEVER have been called (no auto-create)
        // The mock wpClient includes createTag; verify it was not called
        if (typeof wpClient.createTag?.mock !== 'undefined') {
            expect(wpClient.createTag).not.toHaveBeenCalled();
        }

        // Queue row should have wp_tag_not_found persisted
        const item = queueRepo.findById(queueId);
        expect(item?.wp_tag_not_found).not.toBeNull();
        const notFound = JSON.parse(item!.wp_tag_not_found!);
        expect(notFound).toContain('titleist');
        expect(notFound).toContain('callaway');
    });

    it('drops tags from LLM that are not on whitelist → stores dropped_tags in queue', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 301 });
        const rankMath = mockRankMathService();

        const s5 = makeStage5Draft();
        s5.taxonomy = {
            category: 'hoc-golf',
            tags: ['titleist'], // only whitelisted tag
            dropped_tags: ['random-brand', 'fake-tag'], // dropped by tag gate
        };

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: s5,
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');

        // Queue row should have dropped_tags persisted
        const item = queueRepo.findById(queueId);
        expect(item?.dropped_tags).not.toBeNull();
        const dropped = JSON.parse(item!.dropped_tags!);
        expect(dropped).toContain('random-brand');
        expect(dropped).toContain('fake-tag');
    });

    it('found WP tags are attached; missing ones are skipped without error', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        // WP has 'titleist' (id=10) but NOT 'callaway'
        const wpClient = mockWpClient({ createDraftId: 302 });
        wpClient.findTagBySlug = vi.fn().mockImplementation(async (slug: string) => {
            if (slug === 'titleist') return { id: 10, slug: 'titleist' };
            return undefined;
        });
        const rankMath = mockRankMathService();

        const s5 = makeStage5Draft();
        s5.taxonomy = {
            category: 'hoc-golf',
            tags: ['titleist', 'callaway'],
            dropped_tags: [],
        };

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: s5,
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');

        // Draft should have been created with only the found tag (id=10)
        expect(wpClient.createDraft).toHaveBeenCalledWith(
            expect.objectContaining({ tags: [10] })
        );

        // wp_tag_not_found should include 'callaway'
        const item = queueRepo.findById(queueId);
        const notFound = JSON.parse(item!.wp_tag_not_found!);
        expect(notFound).toContain('callaway');
        expect(notFound).not.toContain('titleist');
    });

    // ── DB migration check ───────────────────────────────────────

    it('DB migration v8 adds dropped_tags and wp_tag_not_found columns', () => {
        // The test DB uses runMigrations which includes v8
        const columns = db.pragma('table_info(publish_queue)') as Array<{
            name: string;
            type: string;
        }>;
        const colNames = columns.map((c) => c.name);

        expect(colNames).toContain('dropped_tags');
        expect(colNames).toContain('wp_tag_not_found');
    });

    // ── NON-BLOCKING RankMath — No Rollback ────────────────────────

    it('CRITICAL: RankMath write failure does NOT trigger WP rollback', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 500 });
        const rankMath = mockRankMathService({ writeOk: false });

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        // WP succeeded → must be draft_wp
        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.wp_post_id).toBe(500);

        // CRITICAL: WP updatePost should only be called once (for the
        // original slug update check — NOT for RankMath rollback).
        // findBySlug returns no data, so createDraft is used, not updatePost.
        // Rollback would be an ADDITIONAL updatePost call.
        // Since we use createDraft (clean path), updatePost should NOT be called at all.
        expect(wpClient.updatePost).not.toHaveBeenCalled();

        // Reason should be clean — no "rolled back" mention
        expect(result.output?.reasons).toContain('rankmath_write_failed');
        for (const reason of result.output?.reasons || []) {
            expect(reason).not.toContain('rolled back');
            expect(reason).not.toContain('noindex');
        }
    });

    it('CRITICAL: RankMath verify failure does NOT trigger WP rollback', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 501 });
        const rankMath = mockRankMathService({ verifyOk: false });

        const result = await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.final_status).toBe('draft_wp');
        expect(result.output?.wp_post_id).toBe(501);

        // CRITICAL: NO rollback updatePost call
        expect(wpClient.updatePost).not.toHaveBeenCalled();

        // Reason should be present but clean
        expect(result.output?.reasons).toContain('rankmath_verification_failed');
        for (const reason of result.output?.reasons || []) {
            expect(reason).not.toContain('rolled back');
        }
    });

    it('CRITICAL: fail_reasons in DB row does NOT mention rollback after RankMath failure', async () => {
        const queueId = uuid();
        insertQueueItem(queueRepo, queueId);

        const wpClient = mockWpClient({ createDraftId: 502 });
        const rankMath = mockRankMathService({ writeOk: false });

        await runStage6({
            queueId,
            stage3: makeStage3(),
            stage4: makeStage4(),
            stage5: makeStage5Draft(),
            config,
            wpClient,
            rankMathService: rankMath,
            queueRepo,
            contentIndexRepo,
        });

        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('draft_wp');
        if (item?.fail_reasons) {
            const reasons = JSON.parse(item.fail_reasons);
            for (const r of reasons) {
                expect(r).not.toContain('rolled back');
            }
        }
    });

    // ── Category Precedence Tests ─────────────────────────────────

    describe('Category precedence — CSV canonical_category', () => {
        it('CSV canonical_category used even when raw_category label is different', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 600,
                findCategoryResult: { id: 77, slug: 'hoc-golf' },
            });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'Kinh nghiệm chơi Golf'; // unresolvable LLM label

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                csvCanonicalCategory: 'hoc-golf', // CSV provides correct slug
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.wp_post_id).toBe(600);
            // Should resolve category by CSV slug, not by raw_category label
            expect(wpClient.findCategoryBySlug).toHaveBeenCalledWith('hoc-golf');
        });

        it('CSV canonical_category overrides resolvable stage3.category', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            // Both CSV and stage3 have valid categories, but CSV should win
            const wpClient = mockWpClient({
                createDraftId: 601,
                findCategoryResult: { id: 78, slug: 'golf-cong-nghe' },
            });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'hoc-golf'; // resolvable, but CSV should take precedence

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                csvCanonicalCategory: 'golf-cong-nghe', // CSV overrides
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            // Should use CSV category slug, not stage3 category
            expect(wpClient.findCategoryBySlug).toHaveBeenCalledWith('golf-cong-nghe');
        });

        it('falls back to stage5 taxonomy category when CSV is absent', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 602,
                findCategoryResult: { id: 79, slug: 'san-golf' },
            });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'Totally Unknown Label'; // not resolvable

            const s5 = makeStage5Draft();
            s5.taxonomy = { category: 'san-golf', tags: ['titleist'], dropped_tags: [] };

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: s5,
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                // csvCanonicalCategory NOT provided
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(wpClient.findCategoryBySlug).toHaveBeenCalledWith('san-golf');
        });

        it('falls back to stage3 label resolution when CSV and stage5 both absent', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 603,
                findCategoryResult: { id: 80, slug: 'golf-cong-nghe' },
            });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'Golf Công Nghệ'; // resolvable display name

            const s5 = makeStage5Draft();
            s5.taxonomy = { category: '', tags: ['titleist'], dropped_tags: [] };

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: s5,
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                // no CSV, no stage5 taxonomy category
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(wpClient.findCategoryBySlug).toHaveBeenCalledWith('golf-cong-nghe');
        });

        it('HOLD with category_not_canonical when nothing resolves', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient();
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'Totally Unresolvable Category';

            const s5 = makeStage5Draft();
            s5.taxonomy = { category: 'also-not-canonical', tags: ['titleist'], dropped_tags: [] };

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: s5,
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                csvCanonicalCategory: 'not-a-known-slug', // invalid CSV slug
            });

            expect(result.output?.final_status).toBe('hold');
            expect(result.output?.reasons).toContain('category_not_canonical');
            expect(wpClient.createDraft).not.toHaveBeenCalled();
        });

        it('empty CSV canonical_category falls through to other sources', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 604,
                findCategoryResult: { id: 81, slug: 'hoc-golf' },
            });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'hoc-golf'; // resolvable

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                csvCanonicalCategory: '', // empty — should fall through
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
        });

        it('whitespace-only CSV canonical_category falls through', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 605,
                findCategoryResult: { id: 82, slug: 'hoc-golf' },
            });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.category = 'hoc-golf';

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
                csvCanonicalCategory: '   ', // whitespace-only
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
        });
    });

    // ── Featured Image Upload Tests ──────────────────────────────────

    describe('Featured Image Upload', () => {
        function makeStage4WithImage(): Stage4Output {
            return {
                schema_version: SCHEMA_VERSION,
                featured_image: { prompt: 'test prompt', alt_text: 'test alt' },
                inline_image: null,
                media_mode: 'image_only',
                image_result: {
                    image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mime_type: 'image/png',
                    alt_text: 'test featured image',
                },
                images: { featured: null, hero: null },
            };
        }

        it('uploads media and sets featured_media when image bytes present', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 700 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4WithImage(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.featured_media_result).toBe('ok');
            expect(result.output?.wp_media_id).toBe(10); // from mockWpClient default

            // Verify uploadMedia was called
            expect(wpClient.uploadMedia).toHaveBeenCalledWith(
                expect.any(Buffer),
                expect.stringContaining('featured-'),
                'test featured image',
                'image/png'
            );

            // Verify updatePost was called with featured_media
            expect(wpClient.updatePost).toHaveBeenCalledWith(
                700,
                expect.objectContaining({ featured_media: 10 })
            );
        });

        it('non-blocking: media upload fails → draft_wp preserved, reasons include media_upload_failed', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 701 });
            // Override uploadMedia to fail
            wpClient.uploadMedia = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                error: 'upload failed',
            });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4WithImage(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // CRITICAL: draft_wp is preserved despite upload failure
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.featured_media_result).toBe('failed');
            expect(result.output?.reasons).toContain('media_upload_failed');

            // Queue should still be draft_wp
            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('draft_wp');
        });

        it('non-blocking: uploadMedia throws → draft_wp preserved, reasons include media_upload_failed', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 702 });
            wpClient.uploadMedia = vi.fn().mockRejectedValue(new Error('network error'));
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4WithImage(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.featured_media_result).toBe('failed');
            expect(result.output?.reasons).toContain('media_upload_failed');
        });

        it('skips featured image when no image bytes in Stage4Output', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 703 });
            const rankMath = mockRankMathService();

            // makeStage4() has no image_result
            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.featured_media_result).toBe('skipped');
            expect(result.output?.wp_media_id).toBeUndefined();

            // uploadMedia should NOT have been called
            expect(wpClient.uploadMedia).not.toHaveBeenCalled();
        });

        it('non-blocking: featured_media update fails after upload → draft_wp, reasons include featured_media_update_failed', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 704 });
            // updatePost fails for featured_media update
            wpClient.updatePost = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                error: 'update failed',
            });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4WithImage(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.featured_media_result).toBe('failed');
            expect(result.output?.reasons).toContain('featured_media_update_failed');
        });
    });

    // ── Content Enrichment: Hero + TOC ────────────────────────────

    describe('Content Enrichment — Hero + TOC', () => {
        function makeStage4WithImageEnrich(): Stage4Output {
            return {
                schema_version: SCHEMA_VERSION,
                featured_image: { prompt: 'test prompt', alt_text: 'test alt' },
                inline_image: null,
                media_mode: 'image_only',
                image_result: {
                    image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mime_type: 'image/png',
                    alt_text: 'test featured image',
                },
                images: { featured: null, hero: null },
            };
        }

        function makeStage3WithHeadings(): Stage3Output {
            return {
                ...makeStage3(),
                content_markdown:
                    '<h2>Section One</h2><p>Content about section one.</p>' +
                    '<h2>Section Two</h2><p>Content about section two.</p>' +
                    '<h3>Sub Section</h3><p>Sub content here.</p>' +
                    '<h2>Section Three</h2><p>More content here.</p>',
            };
        }

        it('hero_injected=true and toc_injected=true when media upload succeeds and content has >= 3 headings', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            // Track updatePost calls to verify content enrichment
            let contentUpdatePayload: any = null;
            const wpClient = mockWpClient({ createDraftId: 800 });
            const originalUpdatePost = wpClient.updatePost;
            wpClient.updatePost = vi.fn().mockImplementation((postId: number, payload: any) => {
                if (payload.content) {
                    contentUpdatePayload = payload;
                }
                return originalUpdatePost(postId, payload);
            });

            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3WithHeadings(),
                stage4: makeStage4WithImageEnrich(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.hero_injected).toBe(true);
            expect(result.output?.toc_injected).toBe(true);

            // Verify content update was called with enriched content
            expect(contentUpdatePayload).not.toBeNull();
            expect(contentUpdatePayload.content).toContain('wcap-hero-image');
            expect(contentUpdatePayload.content).toContain('wcap-toc');
        });

        it('hero_injected=false when no image uploaded, toc_injected=true', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 801 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3WithHeadings(),
                stage4: makeStage4(), // no image
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.hero_injected).toBe(false);
            expect(result.output?.toc_injected).toBe(true);
        });

        it('toc_injected=false when < 3 headings', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 802 });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.content_markdown = '<h2>Only One</h2><p>text</p><h2>Two</h2><p>more text</p>';

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4WithImageEnrich(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.toc_injected).toBe(false);
            // Hero should still work
            expect(result.output?.hero_injected).toBe(true);
        });

        it('hero NOT injected when content already has <img> tag', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 803 });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.content_markdown =
                '<img src="existing.jpg"/>' +
                '<h2>A</h2><p>t</p><h2>B</h2><p>t</p><h2>C</h2>';

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage4: makeStage4WithImageEnrich(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.hero_injected).toBe(false);
            // TOC should still work
            expect(result.output?.toc_injected).toBe(true);
        });

        it('non-blocking: content enrichment update fails → draft_wp preserved, reasons include failure', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            let callCount = 0;
            const wpClient = mockWpClient({ createDraftId: 804 });
            wpClient.updatePost = vi.fn().mockImplementation(() => {
                callCount++;
                // First call: featured_media update (ok)
                // Second call: content enrichment update (fail)
                if (callCount <= 1) {
                    return Promise.resolve({
                        ok: true,
                        data: { id: 804, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                        status: 200,
                    });
                }
                return Promise.resolve({
                    ok: false,
                    status: 500,
                    error: 'enrichment update failed',
                });
            });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3WithHeadings(),
                stage4: makeStage4WithImageEnrich(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            // Enrichment flags should be false since update failed
            expect(result.output?.hero_injected).toBe(false);
            expect(result.output?.toc_injected).toBe(false);
            expect(result.output?.reasons).toContain('content_enrichment_update_failed');
        });
    });

    // ── Publish Posture Tests ────────────────────────────────────────

    describe('Publish Posture — always_draft vs auto_publish', () => {

        function makeStage5Publish(): Stage5Output {
            return {
                schema_version: SCHEMA_VERSION,
                publish_recommendation: 'PUBLISH',
                slug_final: 'test-slug',
                rankmath: {
                    focus_keyword: 'test',
                    meta_title: 'Test | MySite',
                    meta_description: 'Test desc',
                    canonical: 'http://localhost/blog/test-slug',
                    robots: 'index,follow',
                    schema_type: 'BlogPosting',
                },
                taxonomy: { category: 'hoc-golf', tags: ['titleist'], dropped_tags: [] },
                gate_results: {},
                reasons: [],
            };
        }

        it('always_draft: never publishes, even when recommendation=PUBLISH', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 900 });
            const rankMath = mockRankMathService();

            // Config is already always_draft by default
            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(), // recommendation=PUBLISH
                config, // publishPosture: 'always_draft'
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // MUST remain draft_wp — never published in always_draft
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.wp_post_id).toBe(900);

            // createDraft should have been called with status='draft'
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'draft' })
            );

            // Queue row should be draft_wp, not published
            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('draft_wp');
        });

        it('auto_publish: publishes when recommendation=PUBLISH and WP confirms', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 901 });
            // Override getPost to return status='publish' (confirming publish)
            wpClient.getPost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 901, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'publish' },
                status: 200,
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(), // recommendation=PUBLISH
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('published');
            expect(result.output?.wp_post_id).toBe(901);

            // createDraft should have been called with status='publish'
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'publish' })
            );

            // Verification GET should have been called
            expect(wpClient.getPost).toHaveBeenCalledWith(901);

            // Queue row should be published
            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('published');
        });

        it('auto_publish: recommendation=DRAFT still creates draft, not publish', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 902 });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Draft(), // recommendation=DRAFT
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // DRAFT recommendation → draft_wp even in auto_publish mode
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.wp_post_id).toBe(902);

            // createDraft should have been called with status='draft'
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'draft' })
            );

            // getPost should NOT have been called (no verification needed)
            expect(wpClient.getPost).not.toHaveBeenCalled();
        });

        it('auto_publish: verification fails → rollback to draft + noindex, final_status=draft_wp (QA AC-4, WPC-014)', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 903 });
            // Override getPost to show WP didn't actually publish (verification fail)
            wpClient.getPost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 903, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                status: 200,
            });
            // Track updatePost calls — first called for rollback (status='draft')
            const updatePostCalls: any[] = [];
            wpClient.updatePost = vi.fn().mockImplementation(async (postId: number, payload: any) => {
                updatePostCalls.push({ postId, payload });
                return {
                    ok: true,
                    data: { id: postId, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                    status: 200,
                };
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // Final status MUST be draft_wp, NEVER published
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.final_status).not.toBe('published');
            expect(result.output?.reasons).toContain('verification_failed_rolled_back');
            expect(result.output?.wp_post_id).toBe(903);

            // Rollback updatePost should have been called with status='draft'
            const rollbackCall = updatePostCalls.find(c => c.payload?.status === 'draft');
            expect(rollbackCall).toBeDefined();
            expect(rollbackCall?.postId).toBe(903);

            // noindex,follow should have been applied via RankMath
            expect(rankMath.writeMeta).toHaveBeenCalledWith(
                903,
                expect.objectContaining({ robots: 'noindex,follow' })
            );

            // Queue row should be draft_wp, not published
            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('draft_wp');
        });

        it('auto_publish: verification fails + rollback API fails → final_status=failed + rollback_failed (WPC-014)', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 910 });
            // Verification fails
            wpClient.getPost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 910, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                status: 200,
            });
            // Rollback also fails
            wpClient.updatePost = vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                error: 'Internal Server Error',
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // MUST be failed, NEVER published
            expect(result.ok).toBe(false);
            expect(result.output?.final_status).toBe('failed');
            expect(result.output?.final_status).not.toBe('published');
            expect(result.output?.reasons).toContain('rollback_failed');
            expect(result.output?.reasons).not.toContain('verification_failed_rolled_back');

            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('failed');
        });

        it('auto_publish: verification GET throws + rollback succeeds → draft_wp + verification_failed_rolled_back', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 904 });
            // getPost throws network error
            wpClient.getPost = vi.fn().mockRejectedValue(new Error('network timeout'));
            // Rollback succeeds
            wpClient.updatePost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 904, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                status: 200,
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // Rollback succeeded → draft_wp with rolled back reason
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.final_status).not.toBe('published');
            expect(result.output?.reasons).toContain('verification_failed_rolled_back');

            // noindex,follow applied
            expect(rankMath.writeMeta).toHaveBeenCalledWith(
                904,
                expect.objectContaining({ robots: 'noindex,follow' })
            );
        });

        it('auto_publish: verification fails + rollback succeeds but RankMath not discovered → draft_wp + noindex_not_supported', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 911 });
            wpClient.getPost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 911, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                status: 200,
            });
            wpClient.updatePost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 911, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'draft' },
                status: 200,
            });
            // Rank Math NOT discovered — noindex cannot be applied
            const rankMath = mockRankMathService({ isDiscovered: false });

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // Rollback succeeded → draft_wp
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.reasons).toContain('verification_failed_rolled_back');
            expect(result.output?.reasons).toContain('noindex_not_supported');
            // Still NOT published
            expect(result.output?.final_status).not.toBe('published');
        });

        it('auto_publish: idempotent rerun on already-published post → no duplicate, final_status=published', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 905,
                findBySlugResult: {
                    ok: true,
                    data: {
                        id: 905,
                        slug: 'test-slug',
                        link: 'http://localhost/test-slug',
                        status: 'publish', // Already published!
                    },
                },
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // Already published → idempotent no-op
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('published');
            expect(result.output?.wp_post_id).toBe(905);
            expect(result.output?.reasons).toEqual(
                expect.arrayContaining(['idempotent_already_published'])
            );

            // createDraft should NOT have been called (no-op)
            expect(wpClient.createDraft).not.toHaveBeenCalled();
            // updatePost should NOT have been called
            expect(wpClient.updatePost).not.toHaveBeenCalled();

            // Queue row should be published
            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('published');
        });

        it('auto_publish: existing draft → updates with status=publish and verifies', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({
                createDraftId: 906,
                findBySlugResult: {
                    ok: true,
                    data: {
                        id: 906,
                        slug: 'test-slug',
                        link: 'http://localhost/test-slug',
                        status: 'draft', // Existing draft (not yet published)
                    },
                },
            });
            // Override updatePost to return publish status
            const originalUpdatePost = wpClient.updatePost;
            wpClient.updatePost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 906, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'publish' },
                status: 200,
            });
            // Override getPost to confirm publish
            wpClient.getPost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 906, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'publish' },
                status: 200,
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('published');
            expect(result.output?.wp_post_id).toBe(906);

            // updatePost should have been called with status='publish'
            expect(wpClient.updatePost).toHaveBeenCalledWith(
                906,
                expect.objectContaining({ status: 'publish' })
            );

            // Verification GET should have been called
            expect(wpClient.getPost).toHaveBeenCalledWith(906);
        });

        it('always_draft: existing published post -> HOLD no-op (does not edit live content)', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            // Existing published post must be treated as published conflict in always_draft
            const wpClient = mockWpClient({
                createDraftId: 907,
                findBySlugResult: {
                    ok: true,
                    data: {
                        id: 907,
                        slug: 'test-slug',
                        link: 'http://localhost/test-slug',
                        status: 'publish', // Already published
                    },
                },
            });
            const rankMath = mockRankMathService();

            // Config is always_draft (default)
            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config, // always_draft
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            // In always_draft, editing live content is blocked with HOLD no-op
            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('hold');
            expect(result.output?.reasons).toContain('idempotency_published_conflict');

            // No mutation calls should happen
            expect(wpClient.updatePost).not.toHaveBeenCalled();
            expect(wpClient.createDraft).not.toHaveBeenCalled();

            // Queue row should be hold
            const item = queueRepo.findById(queueId);
            expect(item?.status).toBe('hold');
        });

        it('schema_version is "1.0" in publish posture outputs', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 908 });
            wpClient.getPost = vi.fn().mockResolvedValue({
                ok: true,
                data: { id: 908, slug: 'test-slug', link: 'http://localhost/test-slug', status: 'publish' },
                status: 200,
            });
            const rankMath = mockRankMathService();

            const autoPublishConfig = { ...config, publishPosture: 'auto_publish' as const };

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage4: makeStage4(),
                stage5: makeStage5Publish(),
                config: autoPublishConfig,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.output?.schema_version).toBe('1.0');
        });
    });

    // ── HTML-First Content Enrichment Tests ──────────────────────────

    describe('HTML-First Content Enrichment', () => {
        function makeStage3_5WithHtml(html: string): Stage3_5Output {
            return {
                schema_version: SCHEMA_VERSION,
                html_artifact: {
                    content_html: html,
                    headings: [],
                    heading_ids_injected: true,
                },
                source_markdown_hash: 'abc123deadbeef00',
                qa_notes: [],
            };
        }

        function makeStage4WithImageHtml(): Stage4Output {
            return {
                schema_version: SCHEMA_VERSION,
                featured_image: { prompt: 'test prompt', alt_text: 'test alt' },
                inline_image: null,
                media_mode: 'image_only',
                image_result: {
                    image_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    mime_type: 'image/png',
                    alt_text: 'test featured image',
                },
                images: { featured: null, hero: null },
            };
        }

        it('HTML-first: enrichment parses HTML headings, produces TOC with heading_count >= 3', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            // HTML content with multiple H2/H3 headings
            const htmlContent =
                '<h2>Cách Chọn Gậy Golf</h2><p>Hướng dẫn chi tiết.</p>' +
                '<h2>Loại Gậy Phổ Biến</h2><p>Iron, wood, putter.</p>' +
                '<h3>Gậy Sắt (Iron)</h3><p>Đây là loại gậy phổ biến nhất.</p>' +
                '<h2>Bảo Dưỡng Gậy Golf</h2><p>Vệ sinh sau mỗi vòng.</p>';

            let contentUpdatePayload: any = null;
            const wpClient = mockWpClient({ createDraftId: 960 });
            const originalUpdatePost = wpClient.updatePost;
            wpClient.updatePost = vi.fn().mockImplementation((postId: number, payload: any) => {
                if (payload.content) {
                    contentUpdatePayload = payload;
                }
                return originalUpdatePost(postId, payload);
            });

            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(), // markdown content (should be IGNORED)
                stage3_5: makeStage3_5WithHtml(htmlContent),
                stage4: makeStage4WithImageHtml(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.content_source).toBe('html');
            expect(result.output?.toc_injected).toBe(true);

            // Verify the WP createDraft was called with HTML content, not markdown
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('<h2>'),
                })
            );

            // Verify content update contains TOC nav
            expect(contentUpdatePayload).not.toBeNull();
            expect(contentUpdatePayload.content).toContain('wcap-toc');

            // Verify NO markdown tokens appear in the published content
            expect(contentUpdatePayload.content).not.toMatch(/^### /m);
            expect(contentUpdatePayload.content).not.toMatch(/^## /m);
            expect(contentUpdatePayload.content).not.toContain('- [');
        });

        it('HTML-first: regression — does NOT use markdown builder for HTML source', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const htmlContent =
                '<h2>Section A</h2><p>Content A.</p>' +
                '<h2>Section B</h2><p>Content B.</p>' +
                '<h2>Section C</h2><p>Content C.</p>';

            const wpClient = mockWpClient({ createDraftId: 961 });
            const rankMath = mockRankMathService();

            const s3 = makeStage3();
            s3.content_markdown = '### Markdown Heading\n- list item\n## Another'; // raw markdown

            const result = await runStage6({
                queueId,
                stage3: s3,
                stage3_5: makeStage3_5WithHtml(htmlContent),
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.content_source).toBe('html');

            // createDraft must NOT contain markdown tokens
            const createCall = (wpClient.createDraft as any).mock.calls[0][0];
            expect(createCall.content).not.toContain('### Markdown Heading');
            expect(createCall.content).not.toContain('- list item');
            expect(createCall.content).toContain('<h2>Section A</h2>');
        });

        it('HTML-first: falls back to markdown when stage3_5 is not provided', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 962 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                // stage3_5 omitted — should fall back to markdown
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.content_source).toBe('markdown');

            // createDraft should have used stage3.content_markdown
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: makeStage3().content_markdown,
                })
            );
        });

        it('HTML-first: falls back to markdown when content_html is empty', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 963 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage3_5: makeStage3_5WithHtml(''), // empty HTML → fallback
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.content_source).toBe('markdown');
        });

        it('HTML-first: updatePost during enrichment uses HTML body with TOC nav', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const htmlContent =
                '<h2>Phần Một</h2><p>Nội dung.</p>' +
                '<h2>Phần Hai</h2><p>Nội dung.</p>' +
                '<h3>Phần Nhỏ</h3><p>Chi tiết.</p>' +
                '<h2>Phần Ba</h2><p>Thêm nội dung.</p>';

            let enrichUpdateContent: string | null = null;
            const wpClient = mockWpClient({ createDraftId: 964 });
            const originalUpdatePost = wpClient.updatePost;
            wpClient.updatePost = vi.fn().mockImplementation((postId: number, payload: any) => {
                if (payload.content) {
                    enrichUpdateContent = payload.content;
                }
                return originalUpdatePost(postId, payload);
            });

            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage3_5: makeStage3_5WithHtml(htmlContent),
                stage4: makeStage4WithImageHtml(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.toc_injected).toBe(true);
            expect(result.output?.hero_injected).toBe(true);

            // The updatePost enrichment call must contain HTML nav TOC
            expect(enrichUpdateContent).not.toBeNull();
            expect(enrichUpdateContent).toContain('<nav class="wcap-toc__nav">');
            expect(enrichUpdateContent).toContain('<ol class="wcap-toc__list">');

            // Must contain anchor links based on HTML headings
            expect(enrichUpdateContent).toContain('href="#');

            // Must NOT contain any raw markdown tokens
            expect(enrichUpdateContent).not.toMatch(/^#{2,3}\s/m);
            expect(enrichUpdateContent).not.toContain('- [');
        });
    });

    // ── HTML-first content source (DEBUG_stage3_5_html_availability) ──

    describe('HTML-first content source', () => {
        function makeStage3_5WithHtml(html: string): Stage3_5Output {
            return {
                schema_version: SCHEMA_VERSION,
                html_artifact: {
                    content_html: html,
                    headings: [
                        { level: 2, text: 'Section One', id: 'section-one' },
                        { level: 2, text: 'Section Two', id: 'section-two' },
                    ],
                    heading_ids_injected: true,
                },
                source_markdown_hash: 'abcdef1234567890',
                qa_notes: [],
            };
        }

        it('content_source="html" when stage3_5 provides non-empty HTML', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 900 });
            const rankMath = mockRankMathService();

            const htmlBody = '<h2 id="section-one">Section One</h2><p>Content here.</p><h2 id="section-two">Section Two</h2><p>More content.</p>';

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage3_5: makeStage3_5WithHtml(htmlBody),
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.final_status).toBe('draft_wp');
            expect(result.output?.content_source).toBe('html');

            // WP should receive the HTML content, not markdown
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({ content: htmlBody })
            );
        });

        it('content_source="markdown" when stage3_5 is undefined', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 901 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                // stage3_5 deliberately omitted
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.content_source).toBe('markdown');

            // WP should receive the markdown content
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({ content: makeStage3().content_markdown })
            );
        });

        it('content_source="markdown" when stage3_5 has empty content_html', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 902 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage3_5: makeStage3_5WithHtml(''),
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.content_source).toBe('markdown');

            // WP should receive the markdown content, not empty HTML
            expect(wpClient.createDraft).toHaveBeenCalledWith(
                expect.objectContaining({ content: makeStage3().content_markdown })
            );
        });

        it('content_source="markdown" when stage3_5 has whitespace-only content_html', async () => {
            const queueId = uuid();
            insertQueueItem(queueRepo, queueId);

            const wpClient = mockWpClient({ createDraftId: 903 });
            const rankMath = mockRankMathService();

            const result = await runStage6({
                queueId,
                stage3: makeStage3(),
                stage3_5: makeStage3_5WithHtml('   \n\t  '),
                stage4: makeStage4(),
                stage5: makeStage5Draft(),
                config,
                wpClient,
                rankMathService: rankMath,
                queueRepo,
                contentIndexRepo,
            });

            expect(result.ok).toBe(true);
            expect(result.output?.content_source).toBe('markdown');
        });
    });
});
