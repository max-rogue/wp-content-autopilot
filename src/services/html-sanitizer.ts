/**
 * HTML Sanitizer / Validator — T-04.
 * Deterministic, zero-dependency HTML validation for Stage 3.5 output.
 *
 * Policy: FAIL-CLOSED (non-blocking fallback to empty content_html).
 *
 * Deny list:
 *   - <script>, <style>, <iframe> tags
 *   - on* event handler attributes (onclick, onerror, etc.)
 *   - javascript: URLs in href/src/action attributes
 *   - Inline base64 data URIs in src attributes
 *
 * Structural checks:
 *   - No more than 1 <h1> tag
 *   - Heading id uniqueness (when heading_ids_injected = true)
 *   - Non-empty body (after tag stripping, must have text content)
 *
 * Returns: { ok, sanitized?, reasons[] }
 *   - ok=true:  HTML passed; `sanitized` contains cleaned HTML
 *   - ok=false: HTML failed validation; use fallback. reasons[] explains why.
 *
 * IMPORTANT: Never logs HTML body — only counts and reason strings.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface SanitizeResult {
    ok: boolean;
    /** Cleaned HTML (only set when ok=true). */
    sanitized?: string;
    /** Human-readable reasons for failure or warnings. */
    reasons: string[];
}

export interface SanitizeOptions {
    /** If true, enforce heading id uniqueness. */
    headingIdsInjected: boolean;
}

// ─── Deny patterns ──────────────────────────────────────────────

/** Banned tags — presence triggers fallback. */
const BANNED_TAG_RE = /<\s*(script|style|iframe)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const BANNED_TAG_OPEN_RE = /<\s*(script|style|iframe)\b[^>]*\/?>/gi;

/** on* event handler attributes. */
const EVENT_HANDLER_RE = /\s+on\w+\s*=\s*["'][^"']*["']/gi;

/** javascript: protocol in href/src/action. */
const JS_URL_RE = /(href|src|action)\s*=\s*["']\s*javascript\s*:/gi;

/** Inline base64 data URIs in src. */
const BASE64_SRC_RE = /src\s*=\s*["']data:[^"']*;base64,[^"']*["']/gi;

// ─── Structural checks ─────────────────────────────────────────

/** Count occurrences of <h1> (open tags). */
function countH1(html: string): number {
    const matches = html.match(/<h1[\s>]/gi);
    return matches ? matches.length : 0;
}

/** Extract heading id values from id="..." attributes on h1-h6 tags. */
function extractHeadingIds(html: string): string[] {
    const ids: string[] = [];
    const re = /<h[1-6][^>]*\bid\s*=\s*"([^"]*)"[^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        ids.push(match[1]);
    }
    return ids;
}

/** Check if HTML has any visible text content (strip tags, check non-whitespace). */
function hasTextContent(html: string): boolean {
    const stripped = html.replace(/<[^>]*>/g, '').trim();
    return stripped.length > 0;
}

// ─── Main sanitizer ─────────────────────────────────────────────

/**
 * Validate and sanitize HTML content from the LLM composer.
 * Deterministic, no network calls.
 */
export function sanitizeHtml(html: string, options: SanitizeOptions): SanitizeResult {
    const reasons: string[] = [];

    // ── Check 1: Banned tags ──────────────────────────────────────
    if (BANNED_TAG_RE.test(html) || BANNED_TAG_OPEN_RE.test(html)) {
        // Reset lastIndex for global regex
        BANNED_TAG_RE.lastIndex = 0;
        BANNED_TAG_OPEN_RE.lastIndex = 0;
        reasons.push('unsafe_tag_detected: script/style/iframe found');
        return { ok: false, reasons };
    }
    BANNED_TAG_RE.lastIndex = 0;
    BANNED_TAG_OPEN_RE.lastIndex = 0;

    // ── Check 2: Event handlers ───────────────────────────────────
    if (EVENT_HANDLER_RE.test(html)) {
        EVENT_HANDLER_RE.lastIndex = 0;
        reasons.push('unsafe_attribute_detected: on* event handler found');
        return { ok: false, reasons };
    }
    EVENT_HANDLER_RE.lastIndex = 0;

    // ── Check 3: javascript: URLs ─────────────────────────────────
    if (JS_URL_RE.test(html)) {
        JS_URL_RE.lastIndex = 0;
        reasons.push('unsafe_url_detected: javascript: protocol in href/src/action');
        return { ok: false, reasons };
    }
    JS_URL_RE.lastIndex = 0;

    // ── Check 4: Base64 data URIs ─────────────────────────────────
    if (BASE64_SRC_RE.test(html)) {
        BASE64_SRC_RE.lastIndex = 0;
        reasons.push('unsafe_src_detected: inline base64 data URI in src');
        return { ok: false, reasons };
    }
    BASE64_SRC_RE.lastIndex = 0;

    // ── Check 5: Single H1 max ────────────────────────────────────
    const h1Count = countH1(html);
    if (h1Count > 1) {
        reasons.push(`structural_violation: ${h1Count} h1 tags found (max 1)`);
        return { ok: false, reasons };
    }

    // ── Check 6: Heading id uniqueness ────────────────────────────
    if (options.headingIdsInjected) {
        const ids = extractHeadingIds(html);
        const seen = new Set<string>();
        for (const id of ids) {
            if (seen.has(id)) {
                reasons.push(`structural_violation: duplicate heading id "${id}"`);
                return { ok: false, reasons };
            }
            seen.add(id);
        }
    }

    // ── Check 7: Non-empty body ───────────────────────────────────
    if (!hasTextContent(html)) {
        reasons.push('structural_violation: empty body (no text content after tag removal)');
        return { ok: false, reasons };
    }

    // ── All checks passed ─────────────────────────────────────────
    return { ok: true, sanitized: html, reasons: [] };
}
