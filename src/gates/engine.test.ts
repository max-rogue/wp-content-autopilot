/**
 * Gate Engine Tests
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.6, §6.3.8
 *
 * Tests:
 * - G1-G8 individual gate logic
 * - Gate engine happy/fail paths
 * - Publish recommendation HOLD > DRAFT > PUBLISH precedence
 * - G2 hardcoded thresholds
 * - Similarity band computation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo, ContentIndexRepo, LocalDbRepo } from '../db/repositories';
import {
    runGates,
    normalizeKeyword,
    type GateContext,
} from '../gates/engine';
import { SCHEMA_VERSION, similarityBand, GATE_IDS, type Stage3Output, type Stage4Output } from '../types';

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
        title: 'Cách Đánh Golf Chuẩn',
        content_markdown: '# Cách Đánh Golf\n\n' + Array(310).fill('Nội dung bài viết').join(' '),
        excerpt: 'Hướng dẫn đánh golf chuẩn.',
        suggested_slug: 'cach-danh-golf-chuan',
        category: 'hoc-golf',
        tags: ['golf', 'swing'],
        focus_keyword: 'cách đánh golf',
        additional_keywords: ['swing golf', 'kỹ thuật đánh golf', 'học golf cơ bản'],
        meta_title: 'Cách Đánh Golf Chuẩn Kỹ Thuật Cho Người Mới | MySite',
        meta_description:
            'Hướng dẫn chi tiết cách đánh golf chuẩn kỹ thuật dành cho golfer Việt Nam. Tìm hiểu kỹ thuật swing, grip, stance và tips từ chuyên gia golf hàng đầu.',
        faq: [
            { question: 'Cách đánh golf là gì?', answer: 'Kỹ thuật cơ bản.' },
            { question: 'Tại sao cần học?', answer: 'Để cải thiện.' },
            { question: 'Bắt đầu như thế nào?', answer: 'Từ grip.' },
        ],
        featured_image: { prompt: 'Golf swing illustration', alt_text: 'cách đánh golf' },
        citations: [{ claim: 'Golf is popular', source_url: 'https://example.com' }],
        publish_recommendation: 'PUBLISH',
        reasons: [],
        missing_data_fields: [],
        ...overrides,
    };
}

function makeStage4(overrides?: Partial<Stage4Output>): Stage4Output {
    return {
        schema_version: SCHEMA_VERSION,
        featured_image: { prompt: 'Golf illustration', alt_text: 'cách đánh golf' },
        inline_image: null,
        media_mode: 'image_only',
        images: { featured: null, hero: null },
        ...overrides,
    };
}

describe('Gate Engine', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    let contentIndexRepo: ContentIndexRepo;
    let localDbRepo: LocalDbRepo;

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        contentIndexRepo = new ContentIndexRepo(db);
        localDbRepo = new LocalDbRepo(db);
    });

    function makeContext(overrides?: Partial<GateContext>): GateContext {
        return {
            queueId: 'test-q-1',
            keyword: 'cách đánh golf',
            normalizedKeyword: 'cách đánh golf',
            contentType: 'BlogPost',
            stage3: makeStage3(),
            stage4: makeStage4(),
            contentIndexRepo,
            localDbRepo,
            queueRepo,
            ...overrides,
        };
    }

    // ── Gate IDs ──────────────────────────────────────────────────

    it('should define exactly G1–G8 gate IDs', () => {
        expect(GATE_IDS).toEqual([
            'G1_KEYWORD_DEDUP',
            'G2_SIMILARITY',
            'G3_LOCAL_DOORWAY',
            'G4_FACT_CLASS',
            'G5_TEMPLATE',
            'G6_TONE',
            'G7_IMAGE',
            'G8_SEO_META',
        ]);
    });

    // ── Happy Path ────────────────────────────────────────────────

    it('all gates PASS → recommendation PUBLISH', () => {
        const ctx = makeContext();
        const result = runGates(ctx);

        expect(result.recommendation).toBe('PUBLISH');
        expect(result.results).toHaveLength(8);
        result.results.forEach((r) => {
            expect(['PASS', 'DRAFT']).toContain(r.status);
        });
    });

    // ── G1 Keyword Dedup ─────────────────────────────────────────

    it('G1 HOLD when keyword already published', () => {
        contentIndexRepo.upsert({
            wp_post_id: 42,
            title: 'Existing',
            focus_keyword: 'cách đánh golf',
            slug: 'cach-danh-golf',
            url: 'https://example.com/blog/cach-danh-golf',
            category: 'hoc-golf',
            tags: '[]',
            published_at: new Date().toISOString(),
            content_hash: 'abc',
            embedding: null,
            updated_at: new Date().toISOString(),
            similarity_score: null,
            similarity_band: null,
            gate_results: null,
        });

        const ctx = makeContext();
        const result = runGates(ctx);

        expect(result.recommendation).toBe('HOLD');
        const g1 = result.results.find((r) => r.gate_id === 'G1_KEYWORD_DEDUP');
        expect(g1?.status).toBe('HOLD');
    });

    // ── G2 Similarity Thresholds (Hardcoded) ─────────────────────

    it('similarityBand: >= 0.80 → HOLD', () => {
        expect(similarityBand(0.80)).toBe('HOLD');
        expect(similarityBand(0.95)).toBe('HOLD');
    });

    it('similarityBand: 0.70–0.79 → DRAFT', () => {
        expect(similarityBand(0.70)).toBe('DRAFT');
        expect(similarityBand(0.75)).toBe('DRAFT');
        expect(similarityBand(0.79)).toBe('DRAFT');
    });

    it('similarityBand: < 0.70 → PASS', () => {
        expect(similarityBand(0.69)).toBe('PASS');
        expect(similarityBand(0.0)).toBe('PASS');
    });

    // ── G3 Local Doorway ─────────────────────────────────────────

    it('G3 PASS when no local modifier', () => {
        const ctx = makeContext({ localModifier: undefined });
        const result = runGates(ctx);
        const g3 = result.results.find((r) => r.gate_id === 'G3_LOCAL_DOORWAY');
        expect(g3?.status).toBe('PASS');
    });

    it('G3 HOLD for Landing content without verified entry', () => {
        const ctx = makeContext({
            localModifier: 'Hà Nội',
            contentType: 'LandingSection',
        });
        const result = runGates(ctx);
        const g3 = result.results.find((r) => r.gate_id === 'G3_LOCAL_DOORWAY');
        expect(g3?.status).toBe('HOLD');
    });

    it('G3 DRAFT for BlogPost without verified local entry', () => {
        const ctx = makeContext({ localModifier: 'Hà Nội' });
        const result = runGates(ctx);
        const g3 = result.results.find((r) => r.gate_id === 'G3_LOCAL_DOORWAY');
        expect(g3?.status).toBe('DRAFT');
        expect(result.robotsDecision).toBe('noindex,follow');
    });

    it('G3 PASS when verified local entry exists', () => {
        localDbRepo.insert({
            entity_id: 'e1',
            entity_type: 'venue',
            name: 'Sân golf Hà Nội',
            city_province: 'Hà Nội',
            address: '123 Main St',
            verified_source_url: 'https://example.com',
            last_verified_at: new Date().toISOString(),
            verification_tier: 1,
        });

        const ctx = makeContext({ localModifier: 'Hà Nội' });
        const result = runGates(ctx);
        const g3 = result.results.find((r) => r.gate_id === 'G3_LOCAL_DOORWAY');
        expect(g3?.status).toBe('PASS');
    });

    // ── G5 Template Completeness ─────────────────────────────────

    it('G5 DRAFT when title missing', () => {
        const ctx = makeContext({
            stage3: makeStage3({ title: '' }),
        });
        const result = runGates(ctx);
        const g5 = result.results.find((r) => r.gate_id === 'G5_TEMPLATE');
        expect(g5?.status).toBe('DRAFT');
    });

    // ── G6 Tone/Brand Voice ──────────────────────────────────────

    it('G6 DRAFT when AI phrase detected', () => {
        const ctx = makeContext({
            stage3: makeStage3({
                content_markdown: '# Test\n\nAs an AI language model, I cannot do this.',
            }),
        });
        const result = runGates(ctx);
        const g6 = result.results.find((r) => r.gate_id === 'G6_TONE');
        expect(g6?.status).toBe('DRAFT');
    });

    // ── G7 Image ─────────────────────────────────────────────────

    it('G7 HOLD when featured image missing', () => {
        const ctx = makeContext({
            stage4: makeStage4({
                featured_image: { prompt: '', alt_text: '' },
            }),
        });
        const result = runGates(ctx);
        const g7 = result.results.find((r) => r.gate_id === 'G7_IMAGE');
        expect(g7?.status).toBe('HOLD');
    });

    // ── G8 SEO Meta ──────────────────────────────────────────────

    it('G8 DRAFT when meta_title missing', () => {
        const ctx = makeContext({
            stage3: makeStage3({ meta_title: '' }),
        });
        const result = runGates(ctx);
        const g8 = result.results.find((r) => r.gate_id === 'G8_SEO_META');
        expect(g8?.status).toBe('DRAFT');
    });

    // ── Recommendation Precedence ────────────────────────────────

    it('HOLD > DRAFT > PUBLISH precedence: any HOLD → recommendation HOLD', () => {
        // G7 HOLD + G6 DRAFT
        const ctx = makeContext({
            stage3: makeStage3({
                content_markdown: 'As an AI language model, here is content.',
            }),
            stage4: makeStage4({
                featured_image: { prompt: '', alt_text: '' },
            }),
        });
        const result = runGates(ctx);
        expect(result.recommendation).toBe('HOLD');
    });

    it('No HOLD + any DRAFT → recommendation DRAFT', () => {
        const ctx = makeContext({
            stage3: makeStage3({
                content_markdown: 'As an AI language model, here is golf content.',
            }),
        });
        const result = runGates(ctx);
        expect(result.recommendation).toBe('DRAFT');
    });

    // ── Keyword Normalization ────────────────────────────────────

    it('normalizeKeyword: lowercase + trim + collapse spaces', () => {
        expect(normalizeKeyword('  Cách ĐÁNH Golf  ')).toBe('cách đánh golf');
        expect(normalizeKeyword('Cách  đánh  golf')).toBe('cách đánh golf');
    });

    it('normalizeKeyword: "tại" → "ở", "chuẩn" → "đúng"', () => {
        expect(normalizeKeyword('golf tại Hà Nội')).toBe('golf ở hà nội');
        expect(normalizeKeyword('cách đánh chuẩn')).toBe('cách đánh đúng');
    });
});
