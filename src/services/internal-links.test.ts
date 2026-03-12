/**
 * Internal Links Integration Tests — T-10.
 * Tests gating logic, ≤20 pairs cap, href stripping, and no schema regression.
 *
 * Key invariants:
 * - isInternalLinksEnabled returns false when flag OFF or pairs < 20
 * - Stage 3 receives ≤ 20 pairs
 * - Final strips unknown hrefs
 * - schema_version = "1.0" and status enum unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo } from '../db/repositories';
import { isInternalLinksEnabled, type PipelineConfig } from '../config';
import { filterByCluster } from './sitemap-fetcher';
import { runStage3 } from '../stages/stage3';
import { SCHEMA_VERSION, QUEUE_STATUSES, GATE_IDS, type Stage2Output, type Stage3Output, type SitemapPair } from '../types';
import type { WriterService, DraftResult } from './writer';

// ── Gating Logic ────────────────────────────────────────────────

describe('T-10 Gating — isInternalLinksEnabled', () => {
    const baseConfig = { internalLinksEnabled: false } as PipelineConfig;

    it('returns false when flag is OFF', () => {
        expect(isInternalLinksEnabled(baseConfig, 50)).toBe(false);
    });

    it('returns false when flag is ON but pairs < 20', () => {
        const cfg = { ...baseConfig, internalLinksEnabled: true } as PipelineConfig;
        expect(isInternalLinksEnabled(cfg, 19)).toBe(false);
    });

    it('returns true when flag is ON and pairs >= 20', () => {
        const cfg = { ...baseConfig, internalLinksEnabled: true } as PipelineConfig;
        expect(isInternalLinksEnabled(cfg, 20)).toBe(true);
    });

    it('returns true when flag is ON and pairs = 100', () => {
        const cfg = { ...baseConfig, internalLinksEnabled: true } as PipelineConfig;
        expect(isInternalLinksEnabled(cfg, 100)).toBe(true);
    });

    it('returns false when flag is ON and pairs = 0', () => {
        const cfg = { ...baseConfig, internalLinksEnabled: true } as PipelineConfig;
        expect(isInternalLinksEnabled(cfg, 0)).toBe(false);
    });
});

// ── Filtering — Stage 3 receives ≤ 20 pairs ────────────────────

describe('T-10 Filtering — ≤ 20 pairs cap', () => {
    it('caps at 20 even with 50 input pairs', () => {
        const pairs: SitemapPair[] = Array.from({ length: 50 }, (_, i) => ({
            slug: `/page-${String(i).padStart(3, '0')}/`,
            title: `Page ${i}`,
        }));
        const result = filterByCluster(pairs, 'golf tips', 'hoc-golf');
        expect(result.length).toBeLessThanOrEqual(20);
    });

    it('returns fewer than 20 when input has fewer', () => {
        const pairs: SitemapPair[] = [
            { slug: '/a/', title: 'A' },
            { slug: '/b/', title: 'B' },
        ];
        const result = filterByCluster(pairs, 'golf', undefined);
        expect(result.length).toBe(2);
    });
});

// ── Href Stripping (fail-closed) ────────────────────────────────

describe('T-10 — Stage 3 strips unknown hrefs', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    const queueId = 'q-internal-links';

    function createTestDb(): Database.Database {
        const database = new Database(':memory:');
        database.pragma('journal_mode = WAL');
        database.pragma('foreign_keys = ON');
        runMigrations(database);
        return database;
    }

    function seedRow(database: Database.Database, id: string) {
        const repo = new PublishQueueRepo(database);
        repo.insert({
            id,
            picked_keyword: 'golf swing',
            normalized_keyword: 'golf_swing',
            language: 'vi',
            idempotency_key: `idem-${id}`,
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

    function makeStage2(): Stage2Output {
        return {
            schema_version: SCHEMA_VERSION,
            queue_id: queueId,
            outline_points: ['Introduction', 'Main', 'FAQ', 'Conclusion'],
            facts: [{ claim: 'Golf is fun', source_url: 'https://example.com' }],
            definitions: [],
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

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        seedRow(db, queueId);
    });

    it('strips <a> tags with hrefs not in sitemap snippet', async () => {
        const sitemapSnippet: SitemapPair[] = [
            { slug: '/hoc-golf/putting/', title: 'Putting' },
            { slug: '/hoc-golf/chipping/', title: 'Chipping' },
        ];

        const contentWithLinks = [
            '# Golf Swing',
            'Learn about <a href="/hoc-golf/putting/">putting techniques</a>.',
            'Also check <a href="/invented-slug/">fake page</a>.',
            'And see <a href="/hoc-golf/chipping/">chipping tips</a>.',
        ].join('\n');

        const draftResult: DraftResult = {
            output: makeStage3Output({ content_markdown: contentWithLinks }),
            rawText: '{}',
        };

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
            sitemapSnippet,
        });

        expect(result.ok).toBe(true);
        const md = result.output!.content_markdown;

        // Valid links should be kept
        expect(md).toContain('<a href="/hoc-golf/putting/">putting techniques</a>');
        expect(md).toContain('<a href="/hoc-golf/chipping/">chipping tips</a>');

        // Invented link should be stripped (text kept, link removed)
        expect(md).not.toContain('<a href="/invented-slug/">');
        expect(md).toContain('fake page'); // anchor text preserved

        // internal_links_used should track the valid links
        expect(result.output!.internal_links_used).toHaveLength(2);
        expect(result.output!.internal_links_used![0].slug).toBe('/hoc-golf/putting/');
        expect(result.output!.internal_links_used![1].slug).toBe('/hoc-golf/chipping/');
    });

    it('does not strip links when no sitemap snippet provided', async () => {
        const contentWithLinks = '# Test\nSee <a href="/any-link/">link</a>.';
        const draftResult: DraftResult = {
            output: makeStage3Output({ content_markdown: contentWithLinks }),
            rawText: '{}',
        };

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
            // No sitemapSnippet
        });

        expect(result.ok).toBe(true);
        // Link should remain untouched
        expect(result.output!.content_markdown).toContain('<a href="/any-link/">link</a>');
    });

    it('handles content with no <a> tags gracefully', async () => {
        const sitemapSnippet: SitemapPair[] = [
            { slug: '/hoc-golf/putting/', title: 'Putting' },
        ];

        const draftResult: DraftResult = {
            output: makeStage3Output({ content_markdown: '# Simple\n\nNo links here.' }),
            rawText: '{}',
        };

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
            sitemapSnippet,
        });

        expect(result.ok).toBe(true);
        expect(result.output!.internal_links_used).toEqual([]);
    });
});

// ── Schema Regression Guard ─────────────────────────────────────

describe('T-10 — No schema regression', () => {
    it('SCHEMA_VERSION is still "1.0"', () => {
        expect(SCHEMA_VERSION).toBe('1.0');
    });

    it('QUEUE_STATUSES enum is unchanged', () => {
        expect(QUEUE_STATUSES).toEqual([
            'planned', 'researching', 'drafting', 'qa',
            'draft_wp', 'published', 'hold', 'failed',
        ]);
    });

    it('GATE_IDS enum is unchanged', () => {
        expect(GATE_IDS).toEqual([
            'G1_KEYWORD_DEDUP', 'G2_SIMILARITY', 'G3_LOCAL_DOORWAY',
            'G4_FACT_CLASS', 'G5_TEMPLATE', 'G6_TONE',
            'G7_IMAGE', 'G8_SEO_META',
        ]);
    });
});
