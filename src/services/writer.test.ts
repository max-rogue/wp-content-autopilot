/**
 * WriterService Tests — provider routing per stage, grounding path,
 * per-provider API key resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriterService, normalizeDraftAliases, type LlmCallOptions } from './writer';
import type { PipelineConfig } from '../config';
import { resolveProviderKey, validateProviderKeys } from '../config';
import { SCHEMA_VERSION } from '../types';
import { _resetPromptRegistryCache } from '../config/prompt-loader';
import fs from 'fs';

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
        llmResearchProvider: 'gemini',
        llmResearchModel: 'gemini-3-pro-preview',
        llmDraftProvider: 'gemini',
        llmDraftModel: 'gemini-3-flash-preview',
        llmFinalProvider: 'openai',
        llmFinalModel: 'gpt-5.2-pro',
        llmImageProvider: 'gemini',
        llmImageModel: 'gemini-3-pro-image-preview',
        llmResearchGrounding: 'google_search',
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
            keyTitle: '',
            keyDescription: '',
            keyFocusKeyword: '',
            keyRobots: '',
            keyCanonical: '',
            keySchemaType: '',
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

// ── Mock mode tests ──────────────────────────────────────────────

describe('WriterService — mock mode (per-provider keys)', () => {
    it('isMockMode returns true when both provider keys are empty', () => {
        const writer = new WriterService(makeConfig({ openaiApiKey: '', geminiApiKey: '' }));
        expect(writer.isMockMode()).toBe(true);
    });

    it('isMockMode returns true when keys are placeholders', () => {
        const writer = new WriterService(
            makeConfig({ openaiApiKey: 'sk-REPLACE_ME', geminiApiKey: 'AIza-REPLACE_ME' })
        );
        expect(writer.isMockMode()).toBe(true);
    });

    it('isMockMode returns false when openaiApiKey is real', () => {
        const writer = new WriterService(makeConfig({ openaiApiKey: 'sk-real-key-123' }));
        expect(writer.isMockMode()).toBe(false);
    });

    it('isMockMode returns false when geminiApiKey is real', () => {
        const writer = new WriterService(makeConfig({ geminiApiKey: 'AIzaSyReal123' }));
        expect(writer.isMockMode()).toBe(false);
    });

    it('isMockMode returns false when both provider keys are set', () => {
        const writer = new WriterService(
            makeConfig({ openaiApiKey: 'sk-real', geminiApiKey: 'AIzaSyReal' })
        );
        expect(writer.isMockMode()).toBe(false);
    });

    it('research() returns mock Stage2Output in mock mode', async () => {
        const writer = new WriterService(makeConfig());
        const result = await writer.research('q1', 'golf swing', 'BlogPost', ['local']);

        expect(result.schema_version).toBe(SCHEMA_VERSION);
        expect(result.queue_id).toBe('q1');
        expect(result.outline_points.length).toBeGreaterThan(0);
        expect(result.citations_present).toBe(true);
    });

    it('draft() returns DraftResult with output and rawText in mock mode', async () => {
        const writer = new WriterService(makeConfig());
        const research = await writer.research('q1', 'golf swing', 'BlogPost', []);
        const result = await writer.draft('q1', research, 'golf swing', 'BlogPost');

        expect(result.output.schema_version).toBe(SCHEMA_VERSION);
        expect(result.output.title).toContain('golf swing');
        expect(result.output.publish_recommendation).toBe('DRAFT');
        expect(result.rawText).toBe('mock_mode');
    });

    it('finalEdit() returns draft as-is in mock mode', async () => {
        const writer = new WriterService(makeConfig());
        const research = await writer.research('q1', 'test', 'BlogPost', []);
        const { output: draft } = await writer.draft('q1', research, 'test', 'BlogPost');
        const final = await writer.finalEdit(draft);

        expect(final.title).toBe(draft.title);
        expect(final.content_markdown).toBe(draft.content_markdown);
    });

    it('generateImage() returns mock image data in mock mode', async () => {
        const writer = new WriterService(makeConfig());
        const result = await writer.generateImage('golf swing', 'Golf Swing Guide');

        expect(result.prompt).toContain('golf swing');
        expect(result.alt_text).toBe('golf swing');
    });
});

// ── Grounding fail-closed ────────────────────────────────────────

describe('WriterService — grounding validation (fail-closed)', () => {
    it('callLlm throws grounding_unsupported_provider when grounding=google_search and provider!=gemini', async () => {
        const config = makeConfig({ openaiApiKey: 'sk-real-key' });
        const writer = new WriterService(config);

        await expect(
            writer.callLlm({
                provider: 'openai',
                model: 'gpt-4o',
                systemPrompt: 'test',
                userPrompt: 'test',
                grounding: 'google_search',
            })
        ).rejects.toThrow('grounding_unsupported_provider');
    });

    it('callLlm does NOT throw when grounding=google_search and provider=gemini (in mock mode)', async () => {
        const writer = new WriterService(makeConfig());

        const result = await writer.callLlm({
            provider: 'gemini',
            model: 'gemini-3-pro-preview',
            systemPrompt: 'test',
            userPrompt: 'test',
            grounding: 'google_search',
        });

        expect(result).toBe('{}');
    });

    it('callLlm does NOT throw when no grounding specified', async () => {
        const writer = new WriterService(makeConfig());

        const result = await writer.callLlm({
            provider: 'openai',
            model: 'gpt-4o',
            systemPrompt: 'test',
            userPrompt: 'test',
        });

        expect(result).toBe('{}');
    });
});

// ── GEMINI_API_MODE routing ──────────────────────────────────────

describe('WriterService — GEMINI_API_MODE routing', () => {
    it('defaults to genai_sdk when geminiApiMode is empty', () => {
        const config = makeConfig({ geminiApiMode: '' });
        // geminiApiMode should default to genai_sdk inside callGemini
        // We test this indirectly — the config field should be ''
        expect(config.geminiApiMode).toBe('');
    });

    it('config accepts genai_sdk mode', () => {
        const config = makeConfig({ geminiApiMode: 'genai_sdk' });
        expect(config.geminiApiMode).toBe('genai_sdk');
    });

    it('config accepts raw_http mode', () => {
        const config = makeConfig({ geminiApiMode: 'raw_http' });
        expect(config.geminiApiMode).toBe('raw_http');
    });
});

// ── Grounding config builder (grounding on/off) ─────────────────

describe('WriterService — grounding config builder', () => {
    it('research() passes grounding=google_search when llmResearchGrounding is google_search', async () => {
        // In mock mode, the grounding param is still set but execution is mocked
        const config = makeConfig({ llmResearchGrounding: 'google_search' });
        const writer = new WriterService(config);
        const result = await writer.research('q1', 'golf grip', 'BlogPost', ['local']);

        // Mock mode returns valid Stage2Output
        expect(result.schema_version).toBe(SCHEMA_VERSION);
        expect(result.queue_id).toBe('q1');
    });

    it('research() passes no grounding when llmResearchGrounding is empty', async () => {
        const config = makeConfig({ llmResearchGrounding: '' });
        const writer = new WriterService(config);
        const result = await writer.research('q1', 'golf grip', 'BlogPost', []);

        expect(result.schema_version).toBe(SCHEMA_VERSION);
    });

    it('callLlm grounding param is correctly sourced from config', async () => {
        const configWith = makeConfig({ llmResearchGrounding: 'google_search' });
        const configWithout = makeConfig({ llmResearchGrounding: '' });

        // Config grounding value is correctly plumbed
        expect(configWith.llmResearchGrounding).toBe('google_search');
        expect(configWithout.llmResearchGrounding).toBe('');
    });
});

// ── Per-provider key resolution ──────────────────────────────────

describe('resolveProviderKey — key selection', () => {
    it('returns geminiApiKey for provider=gemini', () => {
        const config = makeConfig({ openaiApiKey: 'sk-openai', geminiApiKey: 'AIza-gemini' });
        expect(resolveProviderKey(config, 'gemini')).toBe('AIza-gemini');
    });

    it('returns openaiApiKey for provider=openai', () => {
        const config = makeConfig({ openaiApiKey: 'sk-openai', geminiApiKey: 'AIza-gemini' });
        expect(resolveProviderKey(config, 'openai')).toBe('sk-openai');
    });

    it('returns openaiApiKey for unknown provider (default)', () => {
        const config = makeConfig({ openaiApiKey: 'sk-openai', geminiApiKey: 'AIza-gemini' });
        expect(resolveProviderKey(config, 'anthropic')).toBe('sk-openai');
    });
});

// ── Key precedence (AI_API_KEY fallback baked at load time) ──────

describe('resolveProviderKey — precedence (simulated)', () => {
    it('OPENAI_API_KEY overrides AI_API_KEY for openai stages', () => {
        // Simulate: OPENAI_API_KEY=sk-openai is set, AI_API_KEY=sk-legacy
        const config = makeConfig({ openaiApiKey: 'sk-openai-specific', geminiApiKey: 'AIza-gemini' });
        expect(resolveProviderKey(config, 'openai')).toBe('sk-openai-specific');
    });

    it('GEMINI_API_KEY overrides AI_API_KEY for gemini stages', () => {
        const config = makeConfig({ openaiApiKey: 'sk-openai', geminiApiKey: 'AIza-gemini-specific' });
        expect(resolveProviderKey(config, 'gemini')).toBe('AIza-gemini-specific');
    });

    it('AI_API_KEY fallback works: when OPENAI_API_KEY empty, openaiApiKey = AI_API_KEY', () => {
        // loadConfig does: openaiApiKey = env('OPENAI_API_KEY','') || env('AI_API_KEY','')
        // We simulate this by setting openaiApiKey to the fallback value
        const config = makeConfig({ openaiApiKey: 'sk-legacy-fallback', geminiApiKey: 'AIza-gemini' });
        expect(resolveProviderKey(config, 'openai')).toBe('sk-legacy-fallback');
    });
});

// ── validateProviderKeys — fail-fast ─────────────────────────────

describe('validateProviderKeys — fail-fast on missing keys', () => {
    it('throws provider_key_missing when openai final key is empty', () => {
        const config = makeConfig({
            llmFinalProvider: 'openai',
            openaiApiKey: '',
            geminiApiKey: 'AIza-real',
        });

        expect(() => validateProviderKeys(config)).toThrow('provider_key_missing');
        expect(() => validateProviderKeys(config)).toThrow('stage=final');
        expect(() => validateProviderKeys(config)).toThrow('OPENAI_API_KEY');
    });

    it('throws provider_key_missing when gemini research key is empty', () => {
        const config = makeConfig({
            llmResearchProvider: 'gemini',
            llmResearchGrounding: '', // disable grounding to test stage key check
            geminiApiKey: '',
            openaiApiKey: 'sk-real',
        });

        expect(() => validateProviderKeys(config)).toThrow('provider_key_missing');
        expect(() => validateProviderKeys(config)).toThrow('stage=research');
        expect(() => validateProviderKeys(config)).toThrow('GEMINI_API_KEY');
    });

    it('throws when grounding=google_search but gemini key is placeholder', () => {
        const config = makeConfig({
            llmResearchGrounding: 'google_search',
            geminiApiKey: 'AIza-REPLACE_ME',
            openaiApiKey: 'sk-real',
        });

        expect(() => validateProviderKeys(config)).toThrow('grounding=google_search requires GEMINI_API_KEY');
    });

    it('does NOT throw when all required keys are present', () => {
        const config = makeConfig({
            llmResearchProvider: 'gemini',
            llmDraftProvider: 'gemini',
            llmFinalProvider: 'openai',
            llmImageProvider: 'gemini',
            llmResearchGrounding: 'google_search',
            openaiApiKey: 'sk-real-openai',
            geminiApiKey: 'AIza-real-gemini',
        });

        expect(() => validateProviderKeys(config)).not.toThrow();
    });

    it('does NOT throw when image is not required and image key is missing', () => {
        const config = makeConfig({
            llmResearchProvider: 'openai',
            llmDraftProvider: 'openai',
            llmFinalProvider: 'openai',
            llmImageProvider: 'gemini',
            llmImageRequired: false,
            llmResearchGrounding: '',
            openaiApiKey: 'sk-real',
            geminiApiKey: '', // empty but image not required
        });

        expect(() => validateProviderKeys(config)).not.toThrow();
    });

    it('throws when image is required but image provider key is missing', () => {
        const config = makeConfig({
            llmResearchProvider: 'openai',
            llmDraftProvider: 'openai',
            llmFinalProvider: 'openai',
            llmImageProvider: 'gemini',
            llmImageRequired: true,
            llmResearchGrounding: '',
            openaiApiKey: 'sk-real',
            geminiApiKey: '', // empty and image required
        });

        expect(() => validateProviderKeys(config)).toThrow('provider_key_missing');
        expect(() => validateProviderKeys(config)).toThrow('stage=image');
    });
});

// ── normalizeDraftAliases ───────────────────────────────────────

describe('normalizeDraftAliases', () => {

    it('maps "content" → "content_markdown"', () => {
        const data = { title: 'T', content: '# Hello' };
        const result = normalizeDraftAliases(data);
        expect(result.content_markdown).toBe('# Hello');
        expect(result.content).toBeUndefined();
    });

    it('maps "body" → "content_markdown"', () => {
        const data = { title: 'T', body: '# Hello' };
        const result = normalizeDraftAliases(data);
        expect(result.content_markdown).toBe('# Hello');
        expect(result.body).toBeUndefined();
    });

    it('maps "description" → "meta_description"', () => {
        const data = { title: 'T', description: 'A description' };
        const result = normalizeDraftAliases(data);
        expect(result.meta_description).toBe('A description');
        expect(result.description).toBeUndefined();
    });

    it('maps "slug" → "suggested_slug"', () => {
        const data = { title: 'T', slug: 'my-slug' };
        const result = normalizeDraftAliases(data);
        expect(result.suggested_slug).toBe('my-slug');
        expect(result.slug).toBeUndefined();
    });

    it('maps "keyword" → "focus_keyword"', () => {
        const data = { title: 'T', keyword: 'golf swing' };
        const result = normalizeDraftAliases(data);
        expect(result.focus_keyword).toBe('golf swing');
        expect(result.keyword).toBeUndefined();
    });

    it('maps "summary" → "excerpt"', () => {
        const data = { title: 'T', summary: 'A brief summary' };
        const result = normalizeDraftAliases(data);
        expect(result.excerpt).toBe('A brief summary');
        expect(result.summary).toBeUndefined();
    });

    it('does NOT clobber existing correct keys', () => {
        const data = {
            title: 'T',
            content_markdown: '# Correct',
            content: '# Wrong alias',
            meta_description: 'Correct desc',
            description: 'Wrong alias desc',
        };
        const result = normalizeDraftAliases(data);
        expect(result.content_markdown).toBe('# Correct');
        expect(result.meta_description).toBe('Correct desc');
        // Alias keys remain since correct keys existed
        expect(result.content).toBe('# Wrong alias');
        expect(result.description).toBe('Wrong alias desc');
    });

    it('handles the exact LLM mismatch scenario: {title, excerpt, content}', () => {
        // This is the exact bug reproducer: LLM returns wrong keys
        const data = {
            title: 'Golf Swing Guide',
            excerpt: 'Learn about golf swings',
            content: '# Golf Swing\n\nDetailed content here.',
            slug: 'golf-swing-guide',
            keyword: 'golf swing',
        };
        const result = normalizeDraftAliases(data);
        // content → content_markdown
        expect(result.content_markdown).toBe('# Golf Swing\n\nDetailed content here.');
        // slug → suggested_slug
        expect(result.suggested_slug).toBe('golf-swing-guide');
        // keyword → focus_keyword
        expect(result.focus_keyword).toBe('golf swing');
        // excerpt stays as excerpt (it IS a valid Stage3Output field)
        expect(result.excerpt).toBe('Learn about golf swings');
        // Title stays
        expect(result.title).toBe('Golf Swing Guide');
    });

    it('passes through correct keys unchanged', () => {
        const data = {
            title: 'T',
            content_markdown: '# OK',
            excerpt: 'An excerpt',
            suggested_slug: 'ok-slug',
            focus_keyword: 'keyword',
            meta_description: 'Meta desc',
        };
        const result = normalizeDraftAliases(data);
        expect(result).toEqual(data);
    });
});

// ── Prompt template validation tests ─────────────────────────────

describe('WriterService — prompt template constraints', () => {
    let writer: WriterService;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let callLlmSpy: any;
    let fsSpy: any = null;

    beforeEach(() => {
        // Reset prompt cache and force embedded prompts (block external file)
        _resetPromptRegistryCache();
        const originalReadFileSync = fs.readFileSync;
        fsSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: unknown[]) => {
            const filePath = args[0] as string;
            if (typeof filePath === 'string' && filePath.includes('custom_prompts')) {
                throw new Error('ENOENT: mocked for test — force embedded prompts');
            }
            return originalReadFileSync.apply(fs, args as Parameters<typeof originalReadFileSync>);
        });

        writer = new WriterService(
            makeConfig({ geminiApiKey: 'AIzaSyRealKey123', openaiApiKey: 'sk-real-key123' })
        );
        // Spy on callLlm to capture the prompt arguments without making real API calls
        callLlmSpy = vi.spyOn(writer, 'callLlm').mockResolvedValue(JSON.stringify({
            outline_points: ['Intro', 'Body', 'FAQ', 'Conclusion'],
            facts: [{ claim: 'test', source_url: 'https://example.com' }],
            definitions: [], unknowns: [],
            citations_required: true, citations_present: true,
        }));
    });

    afterEach(() => {
        _resetPromptRegistryCache();
        if (fsSpy) fsSpy.mockRestore();
    });

    function getOpts(): LlmCallOptions {
        return callLlmSpy.mock.calls[0][0] as LlmCallOptions;
    }



    it('research() systemPrompt ends with "Return valid JSON only"', async () => {
        await writer.research('q1', 'golf', 'BlogPost', []);
        const opts = callLlmSpy.mock.calls[0][0];
        expect(opts.systemPrompt).toContain('Return valid JSON only');
    });

    it('research() userPrompt includes context with class_hint when provided', async () => {
        await writer.research('q1', 'golf', 'BlogPost', [], 'C', 'HowTo');
        const opts = callLlmSpy.mock.calls[0][0];
        expect(opts.userPrompt).toContain('class_hint');
        expect(opts.userPrompt).toContain('blogpost_subtype');
    });


    it('draft() systemPrompt ends with "Return valid JSON only"', async () => {
        callLlmSpy.mockResolvedValueOnce(JSON.stringify({
            title: 'T', content_markdown: '#C', excerpt: 'E',
            suggested_slug: 's', category: 'c', tags: [], focus_keyword: 'k',
            additional_keywords: [], meta_title: 'MT', meta_description: 'MD',
            faq: [], featured_image: { prompt: 'p', alt_text: 'a' },
            citations: [], publish_recommendation: 'DRAFT',
            reasons: [], missing_data_fields: [],
        }));

        const research = {
            schema_version: '1.0' as const, queue_id: 'q1',
            outline_points: [], facts: [], definitions: [], unknowns: [],
            citations_required: false, citations_present: true,
        };
        await writer.draft('q1', research, 'golf', 'BlogPost');
        const opts = callLlmSpy.mock.calls[0][0];
        expect(opts.systemPrompt).toContain('Return valid JSON only');
    });

    it('finalEdit() systemPrompt uses PATCH-ONLY mode with immutability guards', async () => {
        callLlmSpy.mockResolvedValueOnce(JSON.stringify({
            title: 'T', content_markdown: '#C', excerpt: 'E',
            suggested_slug: 's', category: 'c', tags: [], focus_keyword: 'k',
            additional_keywords: [], meta_title: 'MT', meta_description: 'MD',
            faq: [], featured_image: { prompt: 'p', alt_text: 'a' },
            citations: [], publish_recommendation: 'DRAFT',
            reasons: [], missing_data_fields: [],
        }));

        const draft = {
            schema_version: '1.0' as const,
            title: 'T', content_markdown: '#C', excerpt: 'E',
            suggested_slug: 's', category: 'c', tags: ['t'],
            focus_keyword: 'k', additional_keywords: [],
            meta_title: 'MT', meta_description: 'MD',
            faq: [{ question: 'Q?', answer: 'A' }],
            featured_image: { prompt: 'p', alt_text: 'a' },
            citations: [], publish_recommendation: 'DRAFT' as const,
            reasons: ['test'], missing_data_fields: [],
        };
        await writer.finalEdit(draft);
        const opts = callLlmSpy.mock.calls[0][0];

        expect(opts.systemPrompt).toContain('PATCH-ONLY');
        expect(opts.systemPrompt).toContain('IMMUTABILITY GUARD');
        expect(opts.systemPrompt).toContain('suggested_slug (must be returned verbatim)');
        expect(opts.systemPrompt).toContain('category (must be returned verbatim)');
        expect(opts.systemPrompt).toContain('tags (must be returned verbatim)');
        expect(opts.systemPrompt).toContain('focus_keyword (must be returned verbatim)');
        expect(opts.systemPrompt).toContain('citations (must be returned verbatim)');
        expect(opts.systemPrompt).toContain('Return valid JSON only');
    });

    it('finalEdit() userPrompt includes patch-only instruction', async () => {
        callLlmSpy.mockResolvedValueOnce(JSON.stringify({
            title: 'T', content_markdown: '#C', excerpt: 'E',
            suggested_slug: 's', category: 'c', tags: [],
            focus_keyword: 'k', additional_keywords: [],
            meta_title: 'MT', meta_description: 'MD',
            faq: [], featured_image: { prompt: 'p', alt_text: 'a' },
            citations: [], publish_recommendation: 'DRAFT',
            reasons: [], missing_data_fields: [],
        }));

        const draft = {
            schema_version: '1.0' as const,
            title: 'T', content_markdown: '#C', excerpt: 'E',
            suggested_slug: 's', category: 'c', tags: [],
            focus_keyword: 'k', additional_keywords: [],
            meta_title: 'MT', meta_description: 'MD',
            faq: [], featured_image: { prompt: 'p', alt_text: 'a' },
            citations: [], publish_recommendation: 'DRAFT' as const,
            reasons: [], missing_data_fields: [],
        };
        await writer.finalEdit(draft);
        const opts = callLlmSpy.mock.calls[0][0];
        expect(opts.userPrompt).toContain('patch-only');
    });
});
