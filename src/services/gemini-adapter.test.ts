/**
 * Gemini Adapter Tests — SDK integration, error redaction, grounding config.
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.3
 *
 * Tests:
 *   - redactErrorBody truncates to 300 chars
 *   - redactErrorBody strips API key patterns
 *   - callGeminiSdk builds correct tools shape with grounding
 *   - callGeminiSdk builds no tools when grounding disabled
 *   - callGeminiSdk wraps SDK errors with bounded redacted reason
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redactErrorBody, extractTextFromGenerateContentResponse } from './gemini-adapter';
import type { GenerateContentResponse } from '@google/genai';

// ── redactErrorBody ─────────────────────────────────────────────

describe('redactErrorBody', () => {
    it('truncates long error to 300 chars', () => {
        const longMsg = 'x'.repeat(500);
        const result = redactErrorBody(longMsg);
        expect(result.length).toBe(300);
        expect(result.endsWith('...')).toBe(true);
    });

    it('keeps short errors as-is', () => {
        expect(redactErrorBody('bad request')).toBe('bad request');
    });

    it('redacts AIza... API key patterns', () => {
        const msg = 'Error with key AIzaSyABCDEFGHIJKLMNOPQRSTUV in request';
        const result = redactErrorBody(msg);
        expect(result).not.toContain('AIzaSy');
        expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts sk-... API key patterns', () => {
        const msg = 'Authorization failed for sk-proj-1234567890abcdefghijkl key';
        const result = redactErrorBody(msg);
        expect(result).not.toContain('sk-proj');
        expect(result).toContain('[REDACTED_KEY]');
    });

    it('redacts key=... query param patterns', () => {
        const msg = 'URL: ?key=AIzaSyABCDEFGHIJKLMNOPQRSTUV';
        const result = redactErrorBody(msg);
        expect(result).toContain('key=[REDACTED_KEY]');
    });

    it('handles empty string', () => {
        expect(redactErrorBody('')).toBe('');
    });

    it('custom maxLen works', () => {
        const msg = 'a'.repeat(100);
        const result = redactErrorBody(msg, 50);
        expect(result.length).toBe(50);
        expect(result.endsWith('...')).toBe(true);
    });
});

// ── callGeminiSdk — tool shape verification via mock ────────────

// We mock @google/genai to verify the request shape
vi.mock('@google/genai', () => {
    let lastCallArgs: Record<string, unknown> | null = null;

    const mockGenerateContent = vi.fn(async (args: Record<string, unknown>) => {
        lastCallArgs = args;
        return {
            text: '{"result": "ok"}',
            candidates: [
                {
                    content: {
                        parts: [
                            { text: '{"result": "ok"}' },
                        ],
                    },
                    groundingMetadata: {
                        groundingChunks: [
                            { web: { title: 'Test', uri: 'https://example.com' } },
                        ],
                    },
                },
            ],
        };
    });

    return {
        GoogleGenAI: vi.fn().mockImplementation(() => ({
            models: {
                generateContent: mockGenerateContent,
            },
        })),
        _getLastCallArgs: () => lastCallArgs,
        _getMockGenerateContent: () => mockGenerateContent,
    };
});

describe('callGeminiSdk — tool shape verification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('includes googleSearch tool when enableGoogleSearch=true', async () => {
        // Import after mock setup
        const { callGeminiSdk } = await import('./gemini-adapter');
        const { _getLastCallArgs } = await import('@google/genai') as any;

        await callGeminiSdk({
            apiKey: 'AIzaSyTestKey1234567890abc',
            model: 'gemini-2.0-flash',
            systemPrompt: 'You are a researcher',
            userPrompt: 'Research golf',
            enableGoogleSearch: true,
        });

        const args = _getLastCallArgs();
        expect(args).not.toBeNull();
        expect(args!.model).toBe('gemini-2.0-flash');
        expect(args!.config).toBeDefined();

        const config = args!.config as Record<string, unknown>;
        expect(config.tools).toBeDefined();

        const tools = config.tools as Array<Record<string, unknown>>;
        expect(tools).toHaveLength(1);
        // Must use camelCase googleSearch — NOT snake_case google_search
        expect(tools[0]).toHaveProperty('googleSearch');
        expect(tools[0]).not.toHaveProperty('google_search');
    });

    it('does NOT include tools when enableGoogleSearch=false', async () => {
        const { callGeminiSdk } = await import('./gemini-adapter');
        const { _getLastCallArgs } = await import('@google/genai') as any;

        await callGeminiSdk({
            apiKey: 'AIzaSyTestKey1234567890abc',
            model: 'gemini-2.0-flash',
            systemPrompt: 'You are a writer',
            userPrompt: 'Write about golf',
            enableGoogleSearch: false,
        });

        const args = _getLastCallArgs();
        expect(args).not.toBeNull();

        const config = args!.config as Record<string, unknown>;
        // tools should not be present
        expect(config.tools).toBeUndefined();
    });

    it('does NOT include tools when enableGoogleSearch is omitted', async () => {
        const { callGeminiSdk } = await import('./gemini-adapter');
        const { _getLastCallArgs } = await import('@google/genai') as any;

        await callGeminiSdk({
            apiKey: 'AIzaSyTestKey1234567890abc',
            model: 'gemini-2.0-flash',
            systemPrompt: 'test',
            userPrompt: 'test',
        });

        const args = _getLastCallArgs();
        const config = args!.config as Record<string, unknown>;
        expect(config.tools).toBeUndefined();
    });

    it('returns text from SDK response', async () => {
        const { callGeminiSdk } = await import('./gemini-adapter');

        const result = await callGeminiSdk({
            apiKey: 'AIzaSyTestKey1234567890abc',
            model: 'gemini-2.0-flash',
            systemPrompt: 'test',
            userPrompt: 'test',
        });

        expect(result.text).toBe('{"result": "ok"}');
    });

    it('wraps SDK errors with bounded, redacted message', async () => {
        const { _getMockGenerateContent } = await import('@google/genai') as any;
        const { callGeminiSdk } = await import('./gemini-adapter');

        const mockFn = _getMockGenerateContent();
        mockFn.mockRejectedValueOnce(
            new Error('400 Bad Request: key=AIzaSyRealKeyThatShouldNotLeak12345 is invalid')
        );

        await expect(
            callGeminiSdk({
                apiKey: 'AIzaSyTestKey1234567890abc',
                model: 'gemini-2.0-flash',
                systemPrompt: 'test',
                userPrompt: 'test',
            })
        ).rejects.toThrow('gemini_sdk_error');

        // The error message should be bounded and redacted
        try {
            await callGeminiSdk({
                apiKey: 'AIzaSyTestKey1234567890abc',
                model: 'gemini-2.0-flash',
                systemPrompt: 'test',
                userPrompt: 'test',
            });
        } catch (e: unknown) {
            if (e instanceof Error) {
                // Must not exceed 300 chars in the body portion
                expect(e.message.length).toBeLessThanOrEqual(400);
                // Must not leak API keys
                expect(e.message).not.toContain('AIzaSyReal');
            }
        }
    });

    it('passes systemInstruction and content parameters correctly', async () => {
        const { callGeminiSdk } = await import('./gemini-adapter');
        const { _getLastCallArgs } = await import('@google/genai') as any;

        await callGeminiSdk({
            apiKey: 'AIzaSyTestKey1234567890abc',
            model: 'gemini-2.0-flash',
            systemPrompt: 'You are a golf researcher',
            userPrompt: 'Research "golf swing" for a BlogPost article',
            maxOutputTokens: 8192,
            temperature: 0.5,
        });

        const args = _getLastCallArgs();
        expect(args!.contents).toBe('Research "golf swing" for a BlogPost article');
        expect(args!.model).toBe('gemini-2.0-flash');

        const config = args!.config as Record<string, unknown>;
        expect(config.systemInstruction).toBe('You are a golf researcher');
        expect(config.maxOutputTokens).toBe(8192);
        expect(config.temperature).toBe(0.5);
    });

    it('sets includeThoughts=false when thinkingConfig is provided', async () => {
        const { callGeminiSdk } = await import('./gemini-adapter');
        const { _getLastCallArgs } = await import('@google/genai') as any;

        await callGeminiSdk({
            apiKey: 'AIzaSyTestKey1234567890abc',
            model: 'gemini-2.0-flash',
            systemPrompt: 'test',
            userPrompt: 'test',
            thinkingConfig: { thinkingLevel: 'HIGH' as any },
        });

        const args = _getLastCallArgs();
        const config = args!.config as Record<string, unknown>;
        const tc = config.thinkingConfig as Record<string, unknown>;
        expect(tc).toBeDefined();
        expect(tc.thinkingLevel).toBe('HIGH');
        expect(tc.includeThoughts).toBe(false);
    });
});

// ── extractTextFromGenerateContentResponse ──────────────────────

describe('extractTextFromGenerateContentResponse', () => {
    it('A) response.text empty but candidates contain text in later parts => returns non-empty', () => {
        const response = {
            text: undefined,
            candidates: [
                {
                    content: {
                        parts: [
                            { thought: true, text: '' }, // thought part, empty text
                            { functionCall: { name: 'tool', args: {} } }, // non-text part
                            { text: 'actual answer from model' }, // text in later part
                        ],
                    },
                },
            ],
        } as unknown as GenerateContentResponse;

        const result = extractTextFromGenerateContentResponse(response);
        expect(result).toBe('actual answer from model');
    });

    it('A) text spread across multiple candidates => concatenated', () => {
        const response = {
            text: undefined,
            candidates: [
                {
                    content: {
                        parts: [
                            { text: 'part one' },
                        ],
                    },
                },
                {
                    content: {
                        parts: [
                            { text: 'part two' },
                        ],
                    },
                },
            ],
        } as unknown as GenerateContentResponse;

        const result = extractTextFromGenerateContentResponse(response);
        expect(result).toContain('part one');
        expect(result).toContain('part two');
    });

    it('B) candidates exist but all text parts empty => throws gemini_empty_text_response', () => {
        const response = {
            text: undefined,
            candidates: [
                {
                    content: {
                        parts: [
                            { text: '' },
                            { text: '   ' }, // whitespace-only
                            { functionCall: { name: 'tool', args: {} } },
                        ],
                    },
                },
            ],
        } as unknown as GenerateContentResponse;

        expect(() => extractTextFromGenerateContentResponse(response))
            .toThrow('gemini_empty_text_response');
    });

    it('B) no candidates at all => throws gemini_empty_text_response', () => {
        const response = {
            text: undefined,
            candidates: [],
        } as unknown as GenerateContentResponse;

        expect(() => extractTextFromGenerateContentResponse(response))
            .toThrow('gemini_empty_text_response');
    });

    it('B) error diagnostics include bounded counts', () => {
        const response = {
            text: undefined,
            candidates: [
                {
                    content: {
                        parts: [
                            { text: '' },
                            { functionCall: { name: 'tool', args: {} } },
                        ],
                    },
                },
            ],
        } as unknown as GenerateContentResponse;

        try {
            extractTextFromGenerateContentResponse(response);
            expect.fail('should have thrown');
        } catch (e: unknown) {
            const err = e as Error;
            expect(err.message).toContain('candidate_count=1');
            expect(err.message).toContain('part_count=2');
            expect(err.message).toContain('text_part_count=1');
            expect(err.message).toContain('nonempty_text_part_count=0');
        }
    });

    it('uses response.text as primary when available', () => {
        const response = {
            text: 'primary text',
            candidates: [
                {
                    content: {
                        parts: [
                            { text: 'secondary text' },
                        ],
                    },
                },
            ],
        } as unknown as GenerateContentResponse;

        const result = extractTextFromGenerateContentResponse(response);
        expect(result).toBe('primary text');
    });
});
