/**
 * Stage 3.5 — Final HTML Composer (non-blocking fallback)
 * Ref: T-03
 *
 * Converts Stage3 content_markdown → HTML via LLM.
 * Uses `stage_final_html` prompt from PromptRegistry.
 *
 * Behavior:
 *   LLM is instructed to return ONLY raw HTML (no JSON wrapper).
 *   On success: populates html_artifact with content_html + extracted headings.
 *   On failure (empty response, non-HTML, sanitizer reject, LLM error):
 *     sets content_html = "", headings = [], heading_ids_injected = false,
 *     and appends warning to qa_notes.
 *   ALWAYS returns ok: true — pipeline continues with markdown path.
 */

import crypto from 'crypto';
import type { Stage3Output, Stage3_5Output } from '../types';
import { SCHEMA_VERSION } from '../types';
import type { WriterService } from '../services/writer';
import { loadPromptRegistry } from '../config/prompt-loader';
import { sanitizeHtml } from '../services/html-sanitizer';
import { logger } from '../logger';

// ─── Input / Result ─────────────────────────────────────────────

export interface Stage3_5Input {
    stage3: Stage3Output;
    writerService: WriterService;
}

export interface Stage3_5Result {
    ok: true; // Always true — non-blocking
    output: Stage3_5Output;
}

// ─── Helpers ────────────────────────────────────────────────────

function hashMarkdown(markdown: string): string {
    return crypto.createHash('sha256').update(markdown).digest('hex').slice(0, 16);
}

function makeFallbackOutput(markdownHash: string, reason: string): Stage3_5Output {
    return {
        schema_version: SCHEMA_VERSION,
        html_artifact: {
            content_html: '',
            headings: [],
            heading_ids_injected: false,
        },
        source_markdown_hash: markdownHash,
        qa_notes: [`html_composer_fallback: ${reason}`],
    };
}

/**
 * Extract headings (h1-h6) from raw HTML string.
 * Returns level, inner text (tags stripped), and id attribute if present.
 */
export function extractHeadingsFromHtml(
    html: string,
): Array<{ level: number; text: string; id: string }> {
    const headings: Array<{ level: number; text: string; id: string }> = [];
    const re = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        const level = parseInt(match[1], 10);
        const attrs = match[2];
        const text = match[3].replace(/<[^>]*>/g, '').trim();
        const idMatch = /id\s*=\s*"([^"]*)"/i.exec(attrs);
        const id = idMatch ? idMatch[1] : '';
        headings.push({ level, text, id });
    }
    return headings;
}

/**
 * Quick check: does the trimmed string look like HTML?
 * Must start with '<' and contain at least one closing tag.
 */
function looksLikeHtml(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith('<')) return false;
    // Must contain at least one closing tag  e.g. </p>, </h2>, </section>
    return /<\/[a-z][a-z0-9]*\s*>/i.test(trimmed);
}

/**
 * Strip markdown fences that the LLM may wrap around the HTML output.
 * Handles ```html ... ``` and ``` ... ``` wrappers.
 */
function stripMarkdownFences(text: string): string {
    let result = text.trim();
    // Remove opening fence: ```html or ```
    const openFenceRe = /^```(?:html)?\s*\n/i;
    if (openFenceRe.test(result)) {
        result = result.replace(openFenceRe, '');
        // Remove trailing closing fence
        result = result.replace(/\n```\s*$/, '');
    }
    return result.trim();
}

// ─── Completion logger (fires on every path) ───────────────────

function logCompletion(output: Stage3_5Output): void {
    const qaNotes = output.qa_notes;
    logger.info('Stage 3.5: completion', {
        ok: true,
        html_len: output.html_artifact.content_html.length,
        qa_notes_count: qaNotes.length,
        qa_notes_preview: qaNotes.length > 0 ? qaNotes[0].slice(0, 80) : '',
        sanitizer_rejected: qaNotes.some((n) => n.includes('html_sanitize_failed')),
    });
}

// ─── Stage runner ───────────────────────────────────────────────

export async function runStage3_5(input: Stage3_5Input): Promise<Stage3_5Result> {
    const { stage3, writerService } = input;
    const markdownHash = hashMarkdown(stage3.content_markdown || '');

    // ── Mock mode → fallback ──────────────────────────────────────
    if (writerService.isMockMode()) {
        logger.info('Stage 3.5: MOCK MODE — returning fallback HTML artifact');
        const output = makeFallbackOutput(markdownHash, 'mock_mode');
        logCompletion(output);
        return { ok: true, output };
    }

    try {
        const prompts = loadPromptRegistry();
        const systemPrompt = prompts.stage_final_html.system;

        // If no system prompt configured (embedded default is empty), skip
        if (!systemPrompt || systemPrompt.trim() === '') {
            logger.info('Stage 3.5: no stage_final_html prompt configured — skipping');
            const output = makeFallbackOutput(markdownHash, 'no_prompt_configured');
            logCompletion(output);
            return { ok: true, output };
        }

        const userPayload = JSON.stringify({
            title: stage3.title,
            content_markdown: stage3.content_markdown,
            focus_keyword: stage3.focus_keyword,
            faq: stage3.faq,
            suggested_slug: stage3.suggested_slug,
        });

        // Build thinkingConfig from config (inline to avoid private method access)
        const thinkingLevel = writerService['config'].geminiThinkingLevel;
        const thinkingConfig = thinkingLevel
            ? { thinkingLevel: thinkingLevel as import('@google/genai').ThinkingLevel }
            : undefined;

        const raw = await writerService.callLlm({
            provider: writerService['config'].llmFinalProvider,
            model: writerService['config'].llmFinalModel,
            systemPrompt,
            userPrompt: `Convert this article JSON to WordPress-safe HTML body content. Output ONLY the HTML, starting with the first HTML tag. No JSON. No markdown fences. No explanation.\n\nFocus keyword: ${stage3.focus_keyword}\n\nArticle JSON:\n${userPayload}`,
            maxTokens: writerService['config'].maxOutputTokensHtml,
            // NOTE: No responseMimeType — we want raw HTML text, NOT JSON
            thinkingConfig,
        });

        // ── Process response as raw HTML text ─────────────────────────
        const rawTrimmed = stripMarkdownFences(raw);

        if (!rawTrimmed || rawTrimmed.length === 0) {
            logger.warn('Stage 3.5: LLM returned empty response — fallback');
            const output = makeFallbackOutput(markdownHash, 'empty_response');
            logCompletion(output);
            return { ok: true, output };
        }

        if (!looksLikeHtml(rawTrimmed)) {
            logger.warn('Stage 3.5: LLM response does not look like HTML — fallback', {
                raw_length: rawTrimmed.length,
                raw_head: rawTrimmed.slice(0, 80),
            });
            const output = makeFallbackOutput(markdownHash, 'response_not_html');
            logCompletion(output);
            return { ok: true, output };
        }

        // ── Extract headings from the raw HTML ────────────────────────
        const headings = extractHeadingsFromHtml(rawTrimmed);
        const headingIdsInjected = headings.length > 0 && headings.every((h) => h.id.length > 0);

        // ── T-04: Sanitize / validate HTML ────────────────────────────
        const sanitizeResult = sanitizeHtml(rawTrimmed, {
            headingIdsInjected,
        });

        if (!sanitizeResult.ok) {
            logger.warn('Stage 3.5: HTML sanitization failed — fallback', {
                reason_count: sanitizeResult.reasons.length,
                reasons: sanitizeResult.reasons,
            });
            const output = makeFallbackOutput(
                markdownHash,
                `html_sanitize_failed: ${sanitizeResult.reasons.join('; ')}`,
            );
            logCompletion(output);
            return { ok: true, output };
        }

        logger.info('Stage 3.5: HTML composer complete', {
            headings_count: headings.length,
            ids_injected: headingIdsInjected,
            html_length: sanitizeResult.sanitized!.length,
        });

        const successOutput: Stage3_5Output = {
            schema_version: SCHEMA_VERSION,
            html_artifact: {
                content_html: sanitizeResult.sanitized!,
                headings,
                heading_ids_injected: headingIdsInjected,
            },
            source_markdown_hash: markdownHash,
            qa_notes: [],
        };
        logCompletion(successOutput);
        return { ok: true, output: successOutput };
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('Stage 3.5: HTML composer failed — fallback', { reason });
        const output = makeFallbackOutput(markdownHash, reason);
        logCompletion(output);
        return { ok: true, output };
    }
}
