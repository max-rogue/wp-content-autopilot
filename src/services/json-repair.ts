/**
 * JSON Repair Utility — safely extracts valid JSON from model outputs.
 *
 * LLMs (especially with grounding) often return JSON wrapped in markdown
 * code fences, prose, or trailing commentary. This module strips those
 * wrappers and attempts a single repair pass before giving up.
 *
 * Uses a brace-matching state machine to extract the first complete
 * JSON object/array, correctly handling braces inside string literals.
 *
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.3 (fail-closed research)
 * Ref: 14_SECURITY_PRIVACY §6.2 (no secrets in logs — excerpt is redacted)
 */

import { redactErrorBody } from './gemini-adapter';
import { logger } from '../logger';

/**
 * Attempt to extract and parse JSON from a raw LLM response string.
 *
 * Repair steps:
 *   1. Strip markdown code fences (```json ... ```, ```...```)
 *   2. Trim leading/trailing whitespace
 *   3. Brace-matching extraction: walk chars with state machine to find
 *      the first complete JSON object/array (ignores braces inside strings)
 *   4. JSON.parse the cleaned string
 *
 *   If all steps fail, returns { ok: false, excerpt } with a bounded excerpt.
 *   Logs precise diagnostics on every JSON.parse failure (no secrets).
 */
export function tryParseJsonResponse(
    raw: string
): { ok: true; data: unknown } | { ok: false; excerpt: string } {
    // Step 0: quick fast path — try direct parse first
    try {
        return { ok: true, data: JSON.parse(raw) };
    } catch (err: unknown) {
        // Log diagnostics on fast-path failure
        logParseDiagnostics('fast_path', err, raw);
    }

    // Step 1: strip code fences
    let cleaned = stripCodeFences(raw);

    // Step 2: trim
    cleaned = cleaned.trim();

    // Step 2b: try parse after stripping fences
    try {
        return { ok: true, data: JSON.parse(cleaned) };
    } catch (err: unknown) {
        logParseDiagnostics('strip_fences', err, cleaned);
    }

    // Step 3: brace-matching extraction (state machine)
    const extracted = extractJsonByBraceMatch(cleaned);
    if (extracted !== null) {
        try {
            return { ok: true, data: JSON.parse(extracted) };
        } catch (err: unknown) {
            logParseDiagnostics('brace_match', err, extracted);
        }
    }

    // Step 3b: legacy substring fallback (for arrays where brace-match targets objects)
    const legacyExtracted = extractJsonSubstring(cleaned);
    if (legacyExtracted !== cleaned) {
        try {
            return { ok: true, data: JSON.parse(legacyExtracted) };
        } catch (err: unknown) {
            logParseDiagnostics('legacy_substring', err, legacyExtracted);
        }
    }

    // All repair steps failed — produce bounded excerpt
    const excerpt = boundedExcerpt(raw, 500);
    return { ok: false, excerpt };
}

/**
 * Log bounded, secret-safe diagnostics for a JSON.parse failure.
 * Fields: stage, parse_error_message, raw_len, head_120, tail_120.
 * Never includes full payload.
 */
function logParseDiagnostics(stage: string, err: unknown, input: string): void {
    const parseErrorMessage = err instanceof Error ? err.message : String(err);
    const rawLen = input.length;
    const head120 = input.slice(0, 120);
    const tail120 = input.slice(-120);

    logger.warn('Stage2 JSON parse error', {
        stage,
        parse_error_message: parseErrorMessage,
        raw_len: rawLen,
        head_120: redactErrorBody(head120, 120),
        tail_120: redactErrorBody(tail120, 120),
    });
}

/**
 * Extract the first complete JSON object or array from a string using
 * a brace-matching state machine that correctly ignores braces inside
 * string literals (including escaped characters).
 *
 * Algorithm:
 *   1. Find the first '{' or '['
 *   2. Walk characters tracking:
 *      - brace depth (incremented on {/[, decremented on }/])
 *      - whether we are inside a JSON string literal
 *      - escape sequences inside strings
 *   3. When depth returns to 0 → return the substring
 *   4. If depth never returns to 0 → log truncation indicator, return null
 *
 * Returns null if no complete JSON object/array found.
 */
export function extractJsonByBraceMatch(raw: string): string | null {
    // Find first '{' or '['
    let start = -1;
    let openChar = '';
    let closeChar = '';

    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '{') {
            start = i;
            openChar = '{';
            closeChar = '}';
            break;
        }
        if (raw[i] === '[') {
            start = i;
            openChar = '[';
            closeChar = ']';
            break;
        }
    }

    if (start === -1) return null; // no JSON start found

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < raw.length; i++) {
        const ch = raw[i];

        if (escaped) {
            // Skip this char — it's the character after a backslash inside a string
            escaped = false;
            continue;
        }

        if (inString) {
            if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        // Outside string
        if (ch === '"') {
            inString = true;
        } else if (ch === openChar || (openChar === '{' && ch === '[') || (openChar === '[' && ch === '{')) {
            // Count all opening brackets/braces
            if (ch === '{' || ch === '[') depth++;
        } else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0) {
                return raw.slice(start, i + 1);
            }
        }
    }

    // Never balanced — likely truncated
    logger.warn('likely_truncated_json', {
        raw_len: raw.length,
        tail_120: redactErrorBody(raw.slice(-120), 120),
        depth_remaining: depth,
    });

    return null;
}

/**
 * Strip markdown code fences from a string.
 * Handles: ```json\n ... \n```, ```\n ... \n```, ```json ...\n```, etc.
 */
export function stripCodeFences(raw: string): string {
    let s = raw.trim();

    // Pattern: ```json\n ... \n``` or ```\n ... \n```
    // Also handles ```JSON, ```js, etc.
    const fenceMatch = s.match(
        /^```(?:json|JSON|js|javascript|typescript)?\s*\n?([\s\S]*?)(?:\n?\s*```)$/
    );
    if (fenceMatch) {
        return fenceMatch[1].trim();
    }

    // Partial fence: starts with ``` but no ending (model cut off)
    if (s.startsWith('```')) {
        // Remove the opening fence line
        const firstNewline = s.indexOf('\n');
        if (firstNewline > 0) {
            s = s.slice(firstNewline + 1);
        }
        // Remove trailing ``` if present
        if (s.endsWith('```')) {
            s = s.slice(0, -3);
        }
        return s.trim();
    }

    return s;
}

/**
 * Extract the first JSON object or array from a string that may
 * have leading prose or trailing commentary.
 *
 * Legacy fallback — uses indexOf/lastIndexOf for simple cases.
 * The brace-matching extractor (extractJsonByBraceMatch) is preferred.
 */
export function extractJsonSubstring(raw: string): string {
    const objStart = raw.indexOf('{');
    const arrStart = raw.indexOf('[');

    let start: number;
    let endChar: string;

    if (objStart === -1 && arrStart === -1) return raw;

    if (objStart === -1) {
        start = arrStart;
        endChar = ']';
    } else if (arrStart === -1) {
        start = objStart;
        endChar = '}';
    } else if (objStart < arrStart) {
        start = objStart;
        endChar = '}';
    } else {
        start = arrStart;
        endChar = ']';
    }

    const end = raw.lastIndexOf(endChar);
    if (end <= start) return raw;

    return raw.slice(start, end + 1);
}

/**
 * Produce a bounded, redacted excerpt of raw LLM output.
 * Used in error messages and fail_reasons — safe for logging.
 * Max length: maxLen (default 500).
 */
export function boundedExcerpt(raw: string, maxLen = 500): string {
    return redactErrorBody(raw, maxLen);
}
