/**
 * Stage 1 Tests — Planner stage: dedup, idempotency, data flags.
 */

import { describe, it, expect, vi } from 'vitest';
import { runStage1, computeRequiredDataFlags } from './stage1';
import type { PublishQueueRow, ContentClass, BlogpostSubtype } from '../types';
import type { ContentIndexRepo, PublishQueueRepo } from '../db/repositories';

function makeQueueItem(overrides: Partial<PublishQueueRow> = {}): PublishQueueRow {
    return {
        id: 'q-001',
        picked_keyword: 'best running shoes',
        normalized_keyword: 'best running shoes',
        language: 'en',
        idempotency_key: 'idem-001',
        cluster: 'fitness',
        content_type: 'BlogPost',
        class_hint: 'B',
        blogpost_subtype: null,
        status: 'planned',
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
        created_at: '2025-01-01 00:00:00',
        updated_at: '2025-01-01 00:00:00',
        ...overrides,
    } as PublishQueueRow;
}

function makeQueueRepo(): PublishQueueRepo {
    return {
        updateStatus: vi.fn(),
        findByIdempotencyKey: vi.fn(() => undefined),
        findById: vi.fn(),
    } as unknown as PublishQueueRepo;
}

function makeContentIndexRepo(existing?: { wp_post_id: number }): ContentIndexRepo {
    return {
        findByFocusKeyword: vi.fn(() => existing || undefined),
    } as unknown as ContentIndexRepo;
}

describe('computeRequiredDataFlags', () => {
    it('returns empty flags for Class A', () => {
        expect(computeRequiredDataFlags('A', null)).toEqual([]);
    });

    it('returns empty flags for Class B with no subtype', () => {
        expect(computeRequiredDataFlags('B', null)).toEqual([]);
    });

    it('returns local flags for Class C with local modifier', () => {
        const flags = computeRequiredDataFlags('C', null, 'Ho Chi Minh');
        expect(flags).toContain('local_business_data');
        expect(flags).toContain('local_citations');
    });

    it('returns no local flags for Class C without local modifier', () => {
        expect(computeRequiredDataFlags('C', null)).toEqual([]);
    });

    it('returns pricing flags for BuyingGuide subtype', () => {
        const flags = computeRequiredDataFlags('B', 'BuyingGuide');
        expect(flags).toContain('pricing_data');
        expect(flags).toContain('product_names');
    });

    it('returns competitor flags for Comparison subtype', () => {
        const flags = computeRequiredDataFlags('B', 'Comparison');
        expect(flags).toContain('competitor_data');
    });

    it('combines Class C local + BuyingGuide flags', () => {
        const flags = computeRequiredDataFlags('C', 'BuyingGuide', 'Da Nang');
        expect(flags).toContain('local_business_data');
        expect(flags).toContain('pricing_data');
        expect(flags.length).toBe(4);
    });
});

describe('runStage1', () => {
    it('succeeds with valid input', () => {
        const queueItem = makeQueueItem();
        const queueRepo = makeQueueRepo();
        const contentIndexRepo = makeContentIndexRepo();

        const result = runStage1({ queueItem, queueRepo, contentIndexRepo });

        expect(result.ok).toBe(true);
        expect(result.output).toBeDefined();
        expect(result.output!.picked_keyword).toBe('best running shoes');
        expect(result.output!.schema_version).toBe('1.0');
        expect(result.output!.content_type).toBe('BlogPost');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'researching');
    });

    it('fails when picked_keyword is missing', () => {
        const queueItem = makeQueueItem({ picked_keyword: '' });
        const queueRepo = makeQueueRepo();
        const contentIndexRepo = makeContentIndexRepo();

        const result = runStage1({ queueItem, queueRepo, contentIndexRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('invalid_input');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'failed', expect.any(Object));
    });

    it('holds when keyword already exists in content_index', () => {
        const queueItem = makeQueueItem();
        const queueRepo = makeQueueRepo();
        const contentIndexRepo = makeContentIndexRepo({ wp_post_id: 42 });

        const result = runStage1({ queueItem, queueRepo, contentIndexRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('keyword_dedup');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'hold', expect.any(Object));
    });

    it('holds on idempotency key conflict', () => {
        const queueItem = makeQueueItem();
        const queueRepo = makeQueueRepo();
        (queueRepo.findByIdempotencyKey as any).mockReturnValue({ id: 'other-id', idempotency_key: 'idem-001' });
        const contentIndexRepo = makeContentIndexRepo();

        const result = runStage1({ queueItem, queueRepo, contentIndexRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('idempotency_key_conflict');
    });

    it('allows same idempotency key if same queue item', () => {
        const queueItem = makeQueueItem();
        const queueRepo = makeQueueRepo();
        (queueRepo.findByIdempotencyKey as any).mockReturnValue({ id: 'q-001', idempotency_key: 'idem-001' });
        const contentIndexRepo = makeContentIndexRepo();

        const result = runStage1({ queueItem, queueRepo, contentIndexRepo });

        expect(result.ok).toBe(true);
    });

    it('populates required_data_flags from class_hint and subtype', () => {
        const queueItem = makeQueueItem({ class_hint: 'C', blogpost_subtype: 'BuyingGuide' });
        const queueRepo = makeQueueRepo();
        const contentIndexRepo = makeContentIndexRepo();

        const result = runStage1({
            queueItem,
            queueRepo,
            contentIndexRepo,
            localModifier: 'Hanoi',
        });

        expect(result.ok).toBe(true);
        expect(result.output!.required_data_flags).toContain('local_business_data');
        expect(result.output!.required_data_flags).toContain('pricing_data');
    });
});
