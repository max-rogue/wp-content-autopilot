/**
 * Stage 2 Tests — Research stage: LLM research, citation gates, error handling.
 */

import { describe, it, expect, vi } from 'vitest';
import { runStage2 } from './stage2';
import type { Stage1Output, Stage2Output } from '../types';
import type { WriterService } from '../services/writer';
import type { PublishQueueRepo } from '../db/repositories';

function makeStage1(overrides: Partial<Stage1Output> = {}): Stage1Output {
    return {
        schema_version: '1.0',
        queue_id: 'q-001',
        picked_keyword: 'best running shoes',
        normalized_keyword: 'best running shoes',
        cluster: 'fitness',
        content_type: 'BlogPost',
        class_hint: 'B',
        blogpost_subtype: null,
        angle: 'Comprehensive guide on best running shoes',
        required_data_flags: [],
        planner_notes: [],
        ...overrides,
    } as Stage1Output;
}

function makeWriterService(output?: Partial<Stage2Output>, shouldThrow?: string): WriterService {
    const research = shouldThrow
        ? vi.fn().mockRejectedValue(new Error(shouldThrow))
        : vi.fn().mockResolvedValue({
            schema_version: '1.0',
            outline_points: ['intro', 'body', 'conclusion'],
            facts: [{ claim: 'test fact', source_url: 'https://example.com' }],
            definitions: [],
            tables: [],
            quotes: [],
            unknowns: [],
            citations_required: false,
            citations_present: false,
            local_data_found: false,
            research_confidence: 'HIGH',
            ...output,
        });

    return { research } as unknown as WriterService;
}

function makeQueueRepo(): PublishQueueRepo {
    return {
        updateStatus: vi.fn(),
    } as unknown as PublishQueueRepo;
}

describe('runStage2', () => {
    it('succeeds with valid research output', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService();
        const queueRepo = makeQueueRepo();

        const result = await runStage2({ stage1, writerService, queueRepo });

        expect(result.ok).toBe(true);
        expect(result.output).toBeDefined();
        expect(result.output!.outline_points).toHaveLength(3);
        expect(writerService.research).toHaveBeenCalledWith(
            'q-001', 'best running shoes', 'BlogPost', [], 'B', null, undefined
        );
    });

    it('holds when citations required but not present', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService({
            citations_required: true,
            citations_present: false,
        });
        const queueRepo = makeQueueRepo();

        const result = await runStage2({ stage1, writerService, queueRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('missing_citations');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'hold', expect.any(Object));
    });

    it('passes when citations required AND present', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService({
            citations_required: true,
            citations_present: true,
        });
        const queueRepo = makeQueueRepo();

        const result = await runStage2({ stage1, writerService, queueRepo });

        expect(result.ok).toBe(true);
    });

    it('fails when outline_points is empty', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService({ outline_points: [] });
        const queueRepo = makeQueueRepo();

        const result = await runStage2({ stage1, writerService, queueRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('research_failed');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'failed', expect.any(Object));
    });

    it('handles schema_parse_failed error with hold', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService(undefined, 'schema_parse_failed: invalid JSON at position 42');
        const queueRepo = makeQueueRepo();

        const result = await runStage2({ stage1, writerService, queueRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('schema_parse_failed');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'hold', expect.any(Object));
    });

    it('handles generic error with failed status', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService(undefined, 'API rate limit exceeded');
        const queueRepo = makeQueueRepo();

        const result = await runStage2({ stage1, writerService, queueRepo });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('API rate limit exceeded');
        expect(queueRepo.updateStatus).toHaveBeenCalledWith('q-001', 'failed', expect.any(Object));
    });

    it('passes newsSourceUrl to writer service when provided', async () => {
        const stage1 = makeStage1();
        const writerService = makeWriterService();
        const queueRepo = makeQueueRepo();

        // Mock global fetch for news source
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue('<html><body>News article content</body></html>'),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await runStage2({
            stage1,
            writerService,
            queueRepo,
            newsSourceUrl: 'https://news.example.com/article',
        });

        expect(result.ok).toBe(true);
        // Writer should receive the stripped text as newsContext
        expect(writerService.research).toHaveBeenCalledWith(
            'q-001', 'best running shoes', 'BlogPost', [], 'B', null,
            expect.stringContaining('News article content')
        );

        vi.unstubAllGlobals();
    });
});
