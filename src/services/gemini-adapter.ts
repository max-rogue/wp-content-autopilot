/**
 * Gemini Adapter — thin wrapper around the official @google/genai SDK.
 * Handles endpoint/version nuances, request shape, and grounding configuration.
 *
 * Why SDK over raw HTTP:
 *   - The SDK owns endpoint routing (v1beta vs v1) and request shape nuances.
 *   - Grounding tools use camelCase naming: { googleSearch: {} }, { urlContext: {} }.
 *   - The raw REST API used snake_case and gave 400 errors on grounding payloads.
 *
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.3 (research grounding)
 * Ref: @google/genai SDK — generateContent with tools
 *
 * Secret safety: API key is passed in-memory, never logged (14_SECURITY_PRIVACY §6.2).
 */

import { GoogleGenAI } from '@google/genai';
import type {
    GenerateContentResponse,
    ThinkingConfig,
    Tool,
} from '@google/genai';
import { logger } from '../logger';

export interface GeminiSdkCallOptions {
    apiKey: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens?: number;
    temperature?: number;
    /** If true, enable googleSearch grounding tool */
    enableGoogleSearch?: boolean;
    /** If set (e.g. 'application/json'), constrains model output format */
    responseMimeType?: string;
    /** OpenAPI 3.0 schema subset — forces structured JSON output */
    responseSchema?: unknown;
    /** Gemini thinking config (3.x models): { thinkingLevel: 'HIGH' | 'LOW' | ... } */
    thinkingConfig?: ThinkingConfig;
}

export interface GeminiSdkResult {
    text: string;
    groundingMetadata?: unknown;
}

/**
 * Extract text from a GenerateContentResponse with robust fallback chain.
 *
 * a) Primary: response.text (trimmed) — SDK aggregates first candidate, excludes thoughts
 * b) Secondary: iterate ALL candidates, collect non-empty part.text
 *    (where typeof text === 'string' and text.trim().length > 0)
 *    DO NOT exclude parts just because part.thought is true.
 * c) Defensive: check dynamic aliases output_text / outputText if present at runtime
 * d) If still empty: throw gemini_empty_text_response with bounded diagnostics
 *
 * Never returns "" on success path.
 */
export function extractTextFromGenerateContentResponse(
    response: GenerateContentResponse,
): string {
    // (a) Primary: response.text
    try {
        const primary = (response.text ?? '').trim();
        if (primary) return primary;
    } catch {
        // response.text getter may throw if no candidates — fall through
    }

    // (b) Secondary: iterate all candidates/parts
    const candidates = response.candidates ?? [];
    const collectedParts: string[] = [];
    let partCount = 0;
    let textPartCount = 0;
    let nonemptyTextPartCount = 0;

    for (const candidate of candidates) {
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
            partCount++;
            if (typeof part.text === 'string') {
                textPartCount++;
                const trimmed = part.text.trim();
                if (trimmed.length > 0) {
                    nonemptyTextPartCount++;
                    collectedParts.push(trimmed);
                }
            }
        }
    }

    if (collectedParts.length > 0) {
        return collectedParts.join('\n');
    }

    // (c) Defensive: check dynamic aliases output_text / outputText
    const respAny = response as unknown as Record<string, unknown>;
    for (const alias of ['output_text', 'outputText']) {
        if (typeof respAny[alias] === 'string') {
            const aliasText = (respAny[alias] as string).trim();
            if (aliasText) return aliasText;
        }
    }

    // (d) Still empty — throw with bounded diagnostics (no secrets)
    const diagnostics = {
        candidate_count: candidates.length,
        part_count: partCount,
        text_part_count: textPartCount,
        nonempty_text_part_count: nonemptyTextPartCount,
        has_response_text: (() => {
            try { return response.text !== undefined; } catch { return false; }
        })(),
    };

    logger.warn('Gemini: empty extracted text', diagnostics);
    throw new Error(
        `gemini_empty_text_response: candidate_count=${diagnostics.candidate_count} part_count=${diagnostics.part_count} text_part_count=${diagnostics.text_part_count} nonempty_text_part_count=${diagnostics.nonempty_text_part_count}`,
    );
}

/**
 * Redact an error body for safe inclusion in fail_reason.
 * - Truncates to maxLen characters
 * - Strips any string looking like an API key (AIza*, sk-*, etc.)
 */
export function redactErrorBody(raw: string, maxLen = 300): string {
    // Strip potential API keys
    let safe = raw.replace(/AIza[A-Za-z0-9_-]{20,}/g, '[REDACTED_KEY]');
    safe = safe.replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_KEY]');
    safe = safe.replace(/key=[A-Za-z0-9_-]{20,}/g, 'key=[REDACTED_KEY]');

    if (safe.length > maxLen) {
        safe = safe.slice(0, maxLen - 3) + '...';
    }
    return safe;
}

/**
 * Call Gemini via the official @google/genai SDK.
 * Handles grounding tools in the correct camelCase shape.
 */
export async function callGeminiSdk(
    options: GeminiSdkCallOptions
): Promise<GeminiSdkResult> {
    const ai = new GoogleGenAI({ apiKey: options.apiKey });

    // Build tools array
    const tools: Tool[] = [];
    if (options.enableGoogleSearch) {
        tools.push({ googleSearch: {} });
    }

    let response: GenerateContentResponse;
    try {
        response = await ai.models.generateContent({
            model: options.model,
            contents: options.userPrompt,
            config: {
                systemInstruction: options.systemPrompt,
                maxOutputTokens: options.maxOutputTokens ?? 4096,
                temperature: options.temperature ?? 0.7,
                ...(tools.length > 0 ? { tools } : {}),
                ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {}),
                ...(options.responseSchema ? { responseSchema: options.responseSchema } : {}),
                ...(options.thinkingConfig
                    ? { thinkingConfig: { ...options.thinkingConfig, includeThoughts: false } }
                    : {}),
            },
        });
    } catch (err: unknown) {
        // Extract bounded, redacted error message for fail_reason
        const errMsg =
            err instanceof Error ? err.message : String(err);
        const redacted = redactErrorBody(errMsg);
        throw new Error(`gemini_sdk_error: ${redacted}`);
    }

    // Robust text extraction with fallback chain
    const text = extractTextFromGenerateContentResponse(response);
    const groundingMeta =
        response.candidates?.[0]?.groundingMetadata ?? undefined;

    return { text, groundingMetadata: groundingMeta };
}

// ─── Image Generation ─────────────────────────────────────────────

export interface GeminiImageGenOptions {
    apiKey: string;
    model: string;
    prompt: string;
    /** Gemini thinking config (3.x models) */
    thinkingConfig?: ThinkingConfig;
}

export interface GeminiImageGenResult {
    /** Base64-encoded image data */
    image_base64: string;
    /** MIME type of the generated image (e.g. 'image/png') */
    mime_type: string;
}

/**
 * Generate an image using Gemini's native image generation.
 * Uses generateContent with responseModalities: ['IMAGE', 'TEXT'].
 *
 * The model must support image output (e.g. gemini-2.0-flash-exp, gemini-3-pro-image-preview).
 * Returns base64-encoded image bytes and MIME type.
 *
 * Secret safety: API key is passed in-memory, never logged (14_SECURITY_PRIVACY §6.2).
 */
export async function generateGeminiImage(
    options: GeminiImageGenOptions
): Promise<GeminiImageGenResult> {
    const ai = new GoogleGenAI({ apiKey: options.apiKey });

    let response: GenerateContentResponse;
    try {
        response = await ai.models.generateContent({
            model: options.model,
            contents: options.prompt,
            config: {
                responseModalities: ['IMAGE', 'TEXT'],
                maxOutputTokens: 4096,
                ...(options.thinkingConfig
                    ? { thinkingConfig: { ...options.thinkingConfig, includeThoughts: false } }
                    : {}),
            },
        });
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const redacted = redactErrorBody(errMsg);
        throw new Error(`gemini_image_gen_error: ${redacted}`);
    }

    // Extract inline image data from the response parts
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts;

    if (!parts || parts.length === 0) {
        throw new Error('gemini_image_gen_error: no parts in response');
    }

    // Find the part with inline image data
    for (const part of parts) {
        if (part.inlineData?.data && part.inlineData?.mimeType) {
            return {
                image_base64: part.inlineData.data,
                mime_type: part.inlineData.mimeType,
            };
        }
    }

    throw new Error('gemini_image_gen_error: no image data in response parts');
}
