/**
 * Stage 4 — Dual Image Pipeline Tests
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.5
 *
 * Tests:
 *   - TEST-IMG-001: Both featured + hero images returned on success
 *   - TEST-IMG-002: Featured ok + hero timeout → stage4 fails
 *   - TEST-IMG-003: Rerun hero injection idempotency (via content-enrichment guard)
 *   - No-video enforcement
 *   - Missing alt_text HOLD
 *   - Retry/backoff logging
 *   - Backward compat: image_result populated from images.featured
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo } from '../db/repositories';
import { runStage4, type RetryConfig } from './stage4';
import { SCHEMA_VERSION, type Stage3Output } from '../types';
import { enrichContent } from '../services/content-enrichment';

/** Fast retry config for tests — 2 attempts, 1ms backoff, no real delay */
const FAST_RETRY: RetryConfig = { maxAttempts: 2, baseBackoffMs: 1, backoffCapMs: 1, hardTimeoutMs: 5000 };

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

function makeStage3(overrides?: Partial<Stage3Output>): Stage3Output {
    return {
        schema_version: SCHEMA_VERSION,
        title: 'Cách Chọn Sản Phẩm Tốt',
        content_markdown: '# Cách Chọn Sản Phẩm\n\nNội dung bài viết.',
        excerpt: 'Hướng dẫn sản phẩm.',
        suggested_slug: 'cach-chon-san-pham',
        category: 'guides',
        tags: ['guides'],
        focus_keyword: 'cách chọn sản phẩm',
        additional_keywords: [],
        meta_title: 'Cách Chọn Sản Phẩm | MySite',
        meta_description: 'Hướng dẫn chi tiết cách chọn sản phẩm.',
        faq: [{ question: 'Q?', answer: 'A' }],
        featured_image: { prompt: 'Product illustration', alt_text: 'cách chọn sản phẩm' },
        citations: [],
        publish_recommendation: 'PUBLISH',
        reasons: [],
        missing_data_fields: [],
        ...overrides,
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

function mockWriterService(opts?: {
    imagePromptFail?: boolean;
    featuredBytesFail?: boolean;
    heroBytesFail?: boolean;
}) {
    return {
        generateImage: vi.fn().mockImplementation(async () => {
            if (opts?.imagePromptFail) throw new Error('prompt_gen_failed');
            return { prompt: 'Generated product image prompt', alt_text: 'product alt text' };
        }),
        generateImageBytes: vi.fn().mockImplementation(async (prompt: string, altText: string) => {
            // Detect role from prompt content: hero prompts contain "hero banner"
            const isHero = prompt.toLowerCase().includes('hero banner');

            if (!isHero && opts?.featuredBytesFail) {
                throw new Error('featured_gen_failed');
            }
            if (isHero && opts?.heroBytesFail) {
                throw new Error('hero_gen_failed');
            }
            return {
                image_base64: 'iVBORw0KGgoAAAANSUhEUg==',
                mime_type: 'image/png',
                alt_text: altText,
            };
        }),
    };
}

describe('Stage 4 — Dual Image Pipeline', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
    });

    // ── No-Video Enforcement ─────────────────────────────────────

    it('rejects video request with video_not_allowed', async () => {
        const queueId = 'q-video-1';
        insertQueueItem(queueRepo, queueId);

        const result = await runStage4({
            queueId,
            stage3: makeStage3({
                content_markdown: 'Please generate video content for this post.',
            }),
            queueRepo,
            imageRequired: true,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('video_not_allowed');
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('failed');
    });

    it('does not flag incidental video mention as video request', async () => {
        const queueId = 'q-no-video-1';
        insertQueueItem(queueRepo, queueId);

        const result = await runStage4({
            queueId,
            stage3: makeStage3({
                content_markdown: 'This article discusses video game simulations.',
            }),
            queueRepo,
            imageRequired: false,
        });

        expect(result.ok).toBe(true);
    });

    // ── Missing Alt Text ─────────────────────────────────────────

    it('HOLD when featured_image.alt_text is missing and imageRequired', async () => {
        const queueId = 'q-noalt-1';
        insertQueueItem(queueRepo, queueId);

        const result = await runStage4({
            queueId,
            stage3: makeStage3({
                featured_image: { prompt: 'test', alt_text: '' },
            }),
            queueRepo,
            imageRequired: true,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('missing_alt_text');
    });

    // ── Basic Plan Without Writer Service ────────────────────────

    it('produces image plan without writerService (no bytes)', async () => {
        const queueId = 'q-nowriter-1';
        insertQueueItem(queueRepo, queueId);

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: false,
        });

        expect(result.ok).toBe(true);
        expect(result.output?.schema_version).toBe('1.0');
        expect(result.output?.media_mode).toBe('image_only');
        expect(result.output?.featured_image.prompt).toBeTruthy();
        expect(result.output?.featured_image.alt_text).toBeTruthy();
        // No images generated without writerService
        expect(result.output?.images.featured).toBeNull();
        expect(result.output?.images.hero).toBeNull();
        expect(result.output?.image_result).toBeNull();
    });

    // ── TEST-IMG-001: Both images returned on success ────────────

    it('TEST-IMG-001: generates both featured + hero images successfully', async () => {
        const queueId = 'q-dual-success';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService();

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: true,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.ok).toBe(true);
        expect(result.output).toBeDefined();

        // Featured image
        expect(result.output!.images.featured).not.toBeNull();
        expect(result.output!.images.featured!.image_base64).toBeTruthy();
        expect(result.output!.images.featured!.mime).toBe('image/png');
        expect(result.output!.images.featured!.alt_text).toBeTruthy();
        expect(result.output!.images.featured!.prompt_used).toBeTruthy();
        expect(result.output!.images.featured!.width).toBeGreaterThan(0);
        expect(result.output!.images.featured!.height).toBeGreaterThan(0);

        // Hero image
        expect(result.output!.images.hero).not.toBeNull();
        expect(result.output!.images.hero!.image_base64).toBeTruthy();
        expect(result.output!.images.hero!.mime).toBe('image/png');
        expect(result.output!.images.hero!.alt_text).toContain('hero');

        // Backward compat: image_result mirrors featured
        expect(result.output!.image_result).toBeDefined();
        expect(result.output!.image_result!.image_base64).toBe(result.output!.images.featured!.image_base64);
        expect(result.output!.image_result!.mime_type).toBe('image/png');

        // generateImageBytes called TWICE (featured + hero)
        expect(writer.generateImageBytes).toHaveBeenCalledTimes(2);
    });

    // ── TEST-IMG-002: Featured ok + hero timeout → stage fails ───

    it('TEST-IMG-002: fails when hero generation fails and imageRequired=true', async () => {
        const queueId = 'q-hero-fail';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService({ heroBytesFail: true });

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: true,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('hero_image_generation_failed');
        const item = queueRepo.findById(queueId);
        expect(item?.status).toBe('failed');
    });

    it('continues without hero when generation fails and imageRequired=false', async () => {
        const queueId = 'q-hero-fail-optional';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService({ heroBytesFail: true });

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: false,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.ok).toBe(true);
        expect(result.output!.images.featured).not.toBeNull();
        expect(result.output!.images.hero).toBeNull();
    });

    it('fails when featured generation fails and imageRequired=true', async () => {
        const queueId = 'q-featured-fail';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService({ featuredBytesFail: true });

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: true,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('featured_image_generation_failed');
    });

    // ── TEST-IMG-003: Hero injection idempotency ─────────────────

    it('TEST-IMG-003: enrichContent does not duplicate hero block on rerun', () => {
        // First injection
        const content = '<h2>Section One</h2><p>Content.</p>';
        const opts = {
            wpMediaId: 42,
            sourceUrl: 'http://example.com/hero.jpg',
            altText: 'hero image',
        };

        const firstRun = enrichContent(content, opts);
        expect(firstRun.heroInjected).toBe(true);

        // Second injection (rerun) on already-enriched content
        const secondRun = enrichContent(firstRun.content, opts);
        expect(secondRun.heroInjected).toBe(false);

        // Content should be identical — no duplicate block
        expect(secondRun.content).toBe(firstRun.content);
    });

    // ── schema_version in output ─────────────────────────────────

    it('output always has schema_version "1.0"', async () => {
        const queueId = 'q-schema-1';
        insertQueueItem(queueRepo, queueId);

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: false,
        });

        expect(result.output?.schema_version).toBe('1.0');
    });

    // ── media_mode always image_only ─────────────────────────────

    it('media_mode is always "image_only"', async () => {
        const queueId = 'q-mediamode-1';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService();

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: true,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.output?.media_mode).toBe('image_only');
    });

    // ── Image prompt generation uses LLM when available ──────────

    it('uses writerService.generateImage for prompt when available', async () => {
        const queueId = 'q-prompt-1';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService();

        await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: false,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(writer.generateImage).toHaveBeenCalled();
    });

    it('falls back gracefully when image prompt generation fails', async () => {
        const queueId = 'q-prompt-fail';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService({ imagePromptFail: true });

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: false,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        // Should still succeed — uses stage3 prompts as fallback
        expect(result.ok).toBe(true);
        expect(result.output?.featured_image.prompt).toBeTruthy();
    });

    // ── Hero prompt includes cinematic banner ────────────────────

    it('hero prompt contains cinematic/banner language', async () => {
        const queueId = 'q-hero-prompt';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService();

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: true,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.ok).toBe(true);
        // Hero prompt should be different from featured — contains "hero banner"
        const heroPrompt = result.output!.images.hero!.prompt_used;
        expect(heroPrompt).toContain('hero banner');
    });

    it('hero prompt includes image_only and NO video constraint', async () => {
        const queueId = 'q-hero-no-video';
        insertQueueItem(queueRepo, queueId);
        const writer = mockWriterService();

        const result = await runStage4({
            queueId,
            stage3: makeStage3(),
            queueRepo,
            imageRequired: true,
            writerService: writer as any,
            retryConfig: FAST_RETRY,
        });

        expect(result.ok).toBe(true);
        const heroPrompt = result.output!.images.hero!.prompt_used;
        expect(heroPrompt).toContain('image_only');
        expect(heroPrompt).toContain('NO video');
    });
});
