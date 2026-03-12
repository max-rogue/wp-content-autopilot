/**
 * Stage 3 Tests — draft validation, missing fields, AI safety, schema_parse_failed,
 * raw excerpt diagnostics.
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.4
 *
 * Key invariants tested:
 * - Missing content_markdown does NOT crash (no .toLowerCase() on undefined)
 * - Missing required fields → fail-closed with missing_required_field reasons
 *   AND raw_excerpt persisted in fail_reasons
 * - AI safety check detects banned phrases
 * - schema_parse_failed with excerpt is captured correctly
 * - Valid draft transitions through to qa status
 * - No secrets leak in logs or fail_reasons
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo } from '../db/repositories';
import { runStage3 } from './stage3';
import { SCHEMA_VERSION, type Stage2Output, type Stage3Output } from '../types';
import { v4 as uuid } from 'uuid';
import type { WriterService, DraftResult } from '../services/writer';

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

function makeStage2(): Stage2Output {
    return {
        schema_version: SCHEMA_VERSION,
        queue_id: 'q-test',
        outline_points: ['Introduction', 'Main concept', 'FAQ', 'Conclusion'],
        facts: [{ claim: 'Golf is fun', source_url: 'https://example.com' }],
        definitions: ['Handicap: A measure of ability'],
        unknowns: [],
        citations_required: true,
        citations_present: true,
    };
}

function makeStage3Output(overrides?: Partial<Stage3Output>): Stage3Output {
    return {
        schema_version: SCHEMA_VERSION,
        title: 'Test Title',
        content_markdown: '# Test\n\nContent here.',
        excerpt: 'Test excerpt',
        suggested_slug: 'test-slug',
        category: 'hoc-golf',
        tags: ['golf'],
        focus_keyword: 'test keyword',
        additional_keywords: [],
        meta_title: 'Test | MySite',
        meta_description: 'A test description for the golf article.',
        faq: [
            { question: 'Q1?', answer: 'A1' },
            { question: 'Q2?', answer: 'A2' },
            { question: 'Q3?', answer: 'A3' },
        ],
        featured_image: { prompt: 'Golf illustration', alt_text: 'golf' },
        citations: [{ claim: 'Golf is fun', source_url: 'https://example.com' }],
        publish_recommendation: 'DRAFT',
        reasons: [],
        missing_data_fields: [],
        ...overrides,
    };
}

/** Build a DraftResult for mocking writer.draft() */
function makeDraftResult(
    overrides?: Partial<Stage3Output>,
    rawText = '{"title":"Test Title","content_markdown":"# Test"}'
): DraftResult {
    return {
        output: makeStage3Output(overrides),
        rawText,
    };
}

function seedPlannedRow(db: Database.Database, queueId: string) {
    const queueRepo = new PublishQueueRepo(db);
    queueRepo.insert({
        id: queueId,
        picked_keyword: 'golf swing',
        normalized_keyword: 'golf_swing',
        language: 'vi',
        idempotency_key: `idem-${queueId}`,
        cluster: 'technique',
        content_type: 'BlogPost',
        class_hint: 'B',
        blogpost_subtype: null,
        status: 'researching',
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

// ── Missing fields — raw excerpt diagnostics ────────────────────

describe('Stage 3 — missing required fields (robustness + raw excerpt)', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    const queueId = 'q-missing-fields';

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        seedPlannedRow(db, queueId);
    });

    it('does NOT crash when content_markdown is undefined', async () => {
        const rawText = '{"title":"Test","excerpt":"ok","weird_field":"unexpected"}';
        const draftResult = makeDraftResult(
            { content_markdown: undefined as unknown as string },
            rawText
        );

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        // Must NOT throw — should fail-closed
        expect(result.ok).toBe(false);
        expect(result.failReason).toContain('writer_contract_invalid');
        expect(result.failReason).toContain('missing_required_field:content_markdown');
    });

    it('persists raw_excerpt into fail_reasons when fields missing', async () => {
        const rawText = '{"title":"Valid Title","suggested_slug":"ok","focus_keyword":"golf"}';
        const draftResult = makeDraftResult(
            { content_markdown: undefined as unknown as string },
            rawText
        );

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);

        // Verify fail_reasons includes raw_excerpt
        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('failed');
        const reasons = JSON.parse(row!.fail_reasons!) as string[];
        expect(reasons).toContain('writer_contract_invalid');
        expect(reasons).toContain('missing_required_field:content_markdown');

        // raw_excerpt must be present and contain the raw text
        const excerptReason = reasons.find(r => r.startsWith('raw_excerpt:'));
        expect(excerptReason).toBeDefined();
        expect(excerptReason).toContain('Valid Title');
    });

    it('raw_excerpt is bounded to 500 chars', async () => {
        const longRaw = 'x'.repeat(1000);
        const draftResult = makeDraftResult(
            { content_markdown: undefined as unknown as string },
            longRaw
        );

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        const row = queueRepo.findById(queueId);
        const reasons = JSON.parse(row!.fail_reasons!) as string[];
        const excerptReason = reasons.find(r => r.startsWith('raw_excerpt:'));
        expect(excerptReason).toBeDefined();
        // "raw_excerpt: " is 13 chars + 500 char excerpt max
        expect(excerptReason!.length).toBeLessThanOrEqual(513);
    });

    it('raw_excerpt redacts API key patterns', async () => {
        const rawWithKey = '{"error": "key=AIzaSyABCDEFGHIJKLMNOPQRSTUV is invalid"}';
        const draftResult = makeDraftResult(
            { title: undefined as unknown as string },
            rawWithKey
        );

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        const row = queueRepo.findById(queueId);
        const reasons = JSON.parse(row!.fail_reasons!) as string[];
        const excerptReason = reasons.find(r => r.startsWith('raw_excerpt:'));
        expect(excerptReason).toBeDefined();
        // Must NOT contain the API key
        expect(excerptReason).not.toContain('AIzaSy');
        expect(excerptReason).toContain('[REDACTED_KEY]');
    });

    it('reports all missing fields at once', async () => {
        const draftResult = makeDraftResult({
            content_markdown: undefined as unknown as string,
            title: undefined as unknown as string,
            suggested_slug: undefined as unknown as string,
            focus_keyword: undefined as unknown as string,
        });

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toContain('content_markdown');
        expect(result.failReason).toContain('title');
        expect(result.failReason).toContain('suggested_slug');
        expect(result.failReason).toContain('focus_keyword');

        // Verify DB was updated with fail_reasons including raw_excerpt
        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('failed');
        const reasons = JSON.parse(row!.fail_reasons!) as string[];
        expect(reasons).toContain('writer_contract_invalid');
        expect(reasons).toContain('missing_required_field:content_markdown');
        expect(reasons.some(r => r.startsWith('raw_excerpt:'))).toBe(true);
    });

    it('does NOT crash when title is undefined', async () => {
        const draftResult = makeDraftResult({
            title: undefined as unknown as string,
        });

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toContain('missing_required_field:title');
    });
});

// ── AI safety check ─────────────────────────────────────────────

describe('Stage 3 — AI safety check', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    const queueId = 'q-safety';

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        seedPlannedRow(db, queueId);
    });

    it('detects "as an ai language model" in content', async () => {
        const draftResult = makeDraftResult({
            content_markdown: '# Golf Swing\n\nAs an AI language model, I can help you understand golf.',
        });

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toContain('unsafe_content_or_injection');

        // Should be set to hold, not failed
        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('hold');
    });

    it('detects prohibited topic "gambling" in content', async () => {
        const draftResult = makeDraftResult({
            content_markdown: '# Golf\n\nCombine golf with gambling for better experience.',
        });

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toContain('prohibited topic');
    });
});

// ── Valid draft flow ────────────────────────────────────────────

describe('Stage 3 — valid draft flow', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    const queueId = 'q-valid';

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        seedPlannedRow(db, queueId);
    });

    it('succeeds with valid output and transitions to qa', async () => {
        const draftResult = makeDraftResult();

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(true);
        expect(result.output).toBeDefined();
        expect(result.output!.schema_version).toBe(SCHEMA_VERSION);

        // Should have transitioned to qa
        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('qa');
    });

    it('uses draft as-is when finalEdit throws', async () => {
        const draftResult = makeDraftResult();

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockRejectedValue(new Error('final_edit_failed')),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        // Should succeed with original draft
        expect(result.ok).toBe(true);
        expect(result.output!.title).toBe('Test Title');
    });
});

// ── schema_parse_failed handling ────────────────────────────────

describe('Stage 3 — schema_parse_failed with excerpt', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    const queueId = 'q-parse-fail';

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        seedPlannedRow(db, queueId);
    });

    it('captures excerpt from schema_parse_failed error', async () => {
        const mockWriter = {
            draft: vi.fn().mockRejectedValue(
                new Error('schema_parse_failed: Here is the research data for golf...')
            ),
            finalEdit: vi.fn(),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('schema_parse_failed');

        // Should be hold, not failed
        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('hold');

        const reasons = JSON.parse(row!.fail_reasons!) as string[];
        expect(reasons).toContain('schema_parse_failed');
        // Must include the raw excerpt
        expect(reasons.some((r: string) => r.startsWith('raw_excerpt:'))).toBe(true);
    });

    it('handles generic writer error (not schema_parse_failed)', async () => {
        const mockWriter = {
            draft: vi.fn().mockRejectedValue(new Error('network_timeout')),
            finalEdit: vi.fn(),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('network_timeout');

        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('failed');
    });
});

// ── Contract validation ─────────────────────────────────────────

describe('Stage 3 — contract validation', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    const queueId = 'q-contract';

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        seedPlannedRow(db, queueId);
    });

    it('fails when FAQ has fewer than 3 items', async () => {
        const draftResult = makeDraftResult({
            faq: [{ question: 'Q1?', answer: 'A1' }],
        });

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('writer_contract_invalid');

        const row = queueRepo.findById(queueId);
        expect(row?.status).toBe('failed');
        const reasons = JSON.parse(row!.fail_reasons!) as string[];
        expect(reasons).toContain('FAQ requires >= 3 items');
    });

    it('fails when missing meta_description', async () => {
        const draftResult = makeDraftResult({
            meta_description: undefined as unknown as string,
        });

        const mockWriter = {
            draft: vi.fn().mockResolvedValue(draftResult),
            finalEdit: vi.fn().mockResolvedValue(draftResult.output),
        } as unknown as WriterService;

        const result = await runStage3({
            queueId,
            keyword: 'golf swing',
            contentType: 'BlogPost',
            classHint: 'B',
            blogpostSubtype: null,
            stage2: makeStage2(),
            writerService: mockWriter,
            queueRepo,
        });

        expect(result.ok).toBe(false);
    });
});
