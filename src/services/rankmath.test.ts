/**
 * Rank Math Discovery Tests
 * Ref: 12_WORDPRESS_INTEGRATION §6.6
 *
 * Key requirement: Rank Math keys are DISCOVERED per environment, never hardcoded.
 * If keys are not discovered, writes must fail-closed.
 */

import { describe, it, expect, vi } from 'vitest';
import { RankMathService } from '../services/rankmath';
import type { PipelineConfig } from '../config';

function makeConfig(keys?: Partial<PipelineConfig['rankmath']>): PipelineConfig {
    return {
        appEnv: 'test',
        siteBaseUrl: 'http://localhost',
        serviceBaseUrl: 'http://localhost:3100',
        servicePort: 3100,
        wpBaseUrl: 'http://localhost',
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
            keyTitle: keys?.keyTitle ?? '',
            keyDescription: keys?.keyDescription ?? '',
            keyFocusKeyword: keys?.keyFocusKeyword ?? '',
            keyRobots: keys?.keyRobots ?? '',
            keyCanonical: keys?.keyCanonical ?? '',
            keySchemaType: keys?.keySchemaType ?? '',
        },
        // Throughput & Cost Control (INTERNAL CONFIG)
        maxConcurrentRuns: 1,
        maxJobsPerTick: 1,
        dailyCostCapUsd: 5,
        perJobCostCapUsd: 1,
        maxRetryAttempts: 3,
        retryBackoffMs: 2000,
        jitterMs: 250,
        // Recovery (INTERNAL CONFIG)
        recoveryReplayLimit: 20,
        recoveryLookbackMinutes: 60,
        publishPostureSource: 'default' as const,
        internalLinksEnabled: false,
        geminiThinkingLevel: 'HIGH',
        maxOutputTokensResearch: 8192,
        maxOutputTokensDraft: 8192,
        maxOutputTokensFinal: 8192,
        maxOutputTokensHtml: 8192,
    };
}

function mockWpClient() {
    return {
        createDraft: vi.fn(),
        updatePost: vi.fn().mockResolvedValue({ ok: true, data: {}, status: 200 }),
        getPost: vi.fn().mockResolvedValue({
            ok: true,
            data: {
                id: 1,
                meta: {
                    rank_math_title: 'Test',
                    rank_math_description: 'Test',
                    rank_math_focus_keyword: 'test',
                },
            },
            status: 200,
        }),
        findBySlug: vi.fn(),
        findCategoryBySlug: vi.fn(),
        findTagBySlug: vi.fn(),
        uploadMedia: vi.fn(),
    } as any;
}

describe('RankMath Discovery', () => {

    it('isDiscovered() returns false when keys not set', () => {
        const config = makeConfig();
        const wpClient = mockWpClient();
        const service = new RankMathService(config, wpClient);

        expect(service.isDiscovered()).toBe(false);
    });

    it('isDiscovered() returns true when required keys are set', () => {
        const config = makeConfig({
            keyTitle: 'rank_math_title',
            keyDescription: 'rank_math_description',
            keyFocusKeyword: 'rank_math_focus_keyword',
        });
        const wpClient = mockWpClient();
        const service = new RankMathService(config, wpClient);

        expect(service.isDiscovered()).toBe(true);
    });

    it('writeMeta fails-closed when keys not discovered', async () => {
        const config = makeConfig();
        const wpClient = mockWpClient();
        const service = new RankMathService(config, wpClient);

        const result = await service.writeMeta(1, {
            focus_keyword: 'test',
            meta_title: 'Test',
            meta_description: 'Test desc',
            canonical: 'http://localhost/test',
            robots: 'index,follow',
        });

        expect(result.ok).toBe(false);
        expect(result.error).toContain('discovery_missing');
    });

    it('buildMetaObject uses discovered keys — not hardcoded names', () => {
        const config = makeConfig({
            keyTitle: 'my_custom_rm_title',
            keyDescription: 'my_custom_rm_desc',
            keyFocusKeyword: 'my_custom_rm_kw',
            keyCanonical: 'my_custom_canonical',
            keyRobots: 'my_custom_robots',
        });
        const wpClient = mockWpClient();
        const service = new RankMathService(config, wpClient);

        const meta = service.buildMetaObject({
            focus_keyword: 'golf swing',
            meta_title: 'Golf Swing | MySite',
            meta_description: 'Learn golf swing',
            canonical: 'http://localhost/golf-swing',
            robots: 'index,follow',
        });

        // Keys should match discovered names
        expect(meta['my_custom_rm_title']).toBe('Golf Swing | MySite');
        expect(meta['my_custom_rm_desc']).toBe('Learn golf swing');
        expect(meta['my_custom_rm_kw']).toBe('golf swing');
        expect(meta['my_custom_canonical']).toBe('http://localhost/golf-swing');
        expect(meta['my_custom_robots']).toBe('index,follow');

        // Should NOT contain hardcoded key names
        expect(meta['rank_math_title']).toBeUndefined();
        expect(meta['rank_math_description']).toBeUndefined();
    });

    it('buildMetaObject throws when keys not discovered', () => {
        const config = makeConfig();
        const wpClient = mockWpClient();
        const service = new RankMathService(config, wpClient);

        expect(() =>
            service.buildMetaObject({
                focus_keyword: 'test',
                meta_title: 'Test',
                meta_description: 'Test',
                canonical: 'http://localhost/test',
                robots: 'index,follow',
            })
        ).toThrow(/not discovered/);
    });
});
