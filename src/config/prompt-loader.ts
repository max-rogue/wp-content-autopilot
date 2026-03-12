/**
 * External Prompt Loader — reads pipeline prompts from a markdown file.
 *
 * Contract:
 *   - Env var: PROMPTS_FILE_PATH (absolute path to prompts .md file)
 *   - If unset/empty/unreadable → fallback to embedded prompts (no crash)
 *   - Parsed once per process (cached)
 *   - Logs: source, path, checksum, keys present — NEVER logs prompt content
 *
 * Markdown format (stable H2 headings):
 *   ## STAGE 2 — Research Agent
 *   ## STAGE 3 — Writer Agent (Draft)
 *   ## STAGE 3 — finalEdit
 *   ## STAGE FINAL — HTML Composer
 *   ## STAGE 4 — Image Generation
 *
 * Under each H2, subsections:
 *   ### System Prompt
 *   ### User Prompt
 */

import fs from 'fs';
import crypto from 'crypto';
import { logger } from '../logger';

// ─── Types ──────────────────────────────────────────────────────

export interface PromptBlock {
    system: string;
    user: string;
}

export type PromptStageKey =
    | 'stage2'
    | 'stage3_draft'
    | 'stage3_finalEdit'
    | 'stage_final_html'
    | 'stage4_image';

export type PromptRegistry = Record<PromptStageKey, PromptBlock>;

// ─── Heading → Key mapping (LOCKED) ────────────────────────────

const HEADING_TO_KEY: Record<string, PromptStageKey> = {
    '## STAGE 2 — Research Agent': 'stage2',
    '## STAGE 3 — Writer Agent (Draft)': 'stage3_draft',
    '## STAGE 3 — finalEdit': 'stage3_finalEdit',
    '## STAGE FINAL — HTML Composer': 'stage_final_html',
    '## STAGE 4 — Image Generation': 'stage4_image',
};

// Normalized heading matchers (trim trailing whitespace, case-sensitive on purpose)
const HEADING_PATTERNS: Array<{ pattern: string; key: PromptStageKey }> =
    Object.entries(HEADING_TO_KEY).map(([heading, key]) => ({
        pattern: heading.replace(/\s+/g, ' ').trim(),
        key,
    }));

// ─── Embedded defaults (generic templates) ─────────────────────

export const EMBEDDED_PROMPTS: PromptRegistry = {
    stage2: {
        system: [
            '# ROLE',
            'You are a content researcher. Your job is to gather factual, citable information for a high-quality SEO article.',
            '',
            '# OUTPUT FORMAT',
            'Return ONLY valid, compact JSON matching the Stage2Output schema.',
            'No markdown, no prose, no code fences — raw JSON only.',
            'Schema: { "outline_points": string[], "facts": [{"claim": string, "source_url": string}],',
            '  "definitions": string[], "unknowns": string[],',
            '  "citations_required": boolean, "citations_present": boolean }',
            '',
            '# CITATION RULES',
            '- Include credible sources in facts[].',
            '- If a claim CANNOT be verified: put it into unknowns[] — DO NOT invent data.',
            '',
            '# OUTLINE QUALITY',
            'outline_points must have at minimum: Introduction, 3+ body sections, FAQ section, Conclusion.',
            '',
            'Return valid JSON only.',
        ].join('\n'),
        user: '', // User prompt is built dynamically at callsite
    },

    stage3_draft: {
        system: [
            '# ROLE',
            'You are a senior content writer. Write article text in the language specified by the context.',
            '',
            '# OUTPUT FORMAT',
            'Return ONLY valid, compact JSON matching the Stage3Output schema.',
            'No markdown fences, no prose outside JSON, no truncation.',
            'Use EXACT key names:',
            '  title, content_markdown, excerpt, suggested_slug, category, tags,',
            '  focus_keyword, additional_keywords, meta_title, meta_description,',
            '  faq (array of {question, answer}), featured_image ({prompt, alt_text}),',
            '  citations (array of {claim, source_url}), publish_recommendation,',
            '  reasons, missing_data_fields.',
            'ALIAS PROHIBITION:',
            '  Do NOT use "content" — use "content_markdown".',
            '  Do NOT use "description" — use "meta_description".',
            '  Do NOT use "slug" — use "suggested_slug".',
            '  Do NOT use "keyword" — use "focus_keyword".',
            '',
            '# STRUCTURE',
            '- Use dense H2/H3 structure.',
            '- TL;DR: 2–3 sentence summary near top.',
            '- FAQ: At least 5 items in the faq[] array.',
            '',
            '# SEO',
            '- meta_title: 50–60 chars, include focus_keyword.',
            '- meta_description: 120–155 chars, compelling, include focus_keyword.',
            '',
            'Return valid JSON only.',
        ].join('\n'),
        user: '', // User prompt is built dynamically at callsite
    },

    stage3_finalEdit: {
        system: [
            '# ROLE',
            'You are a senior content editor. This is a PATCH-ONLY pass.',
            '',
            '# TASK',
            'Polish the draft article for publication quality:',
            '- Fix grammar and spelling.',
            '- Improve sentence flow and readability.',
            '- Ensure focus_keyword appears in first 100 words.',
            '- Tighten verbose paragraphs.',
            '',
            '# IMMUTABILITY GUARD — DO NOT CHANGE:',
            '- suggested_slug (must be returned verbatim)',
            '- category (must be returned verbatim)',
            '- tags (must be returned verbatim)',
            '- focus_keyword (must be returned verbatim)',
            '- additional_keywords (must be returned verbatim)',
            '- citations (must be returned verbatim)',
            '- featured_image (must be returned verbatim)',
            '- publish_recommendation (must be returned verbatim)',
            '- faq questions (you may only improve answer wording, not add/remove/reorder items)',
            '',
            '# OUTPUT FORMAT',
            'Return ONLY valid, compact JSON matching the Stage3Output schema.',
            'No markdown fences, no prose outside JSON, no truncation.',
            'All fields from the input MUST appear in output.',
            '',
            'Return valid JSON only.',
        ].join('\n'),
        user: '', // User prompt is built dynamically at callsite
    },

    stage_final_html: {
        system: [
            '# ROLE',
            'You are a senior HTML composer for a WordPress website.',
            '',
            '# TASK',
            'Convert the provided markdown article into clean, semantic HTML.',
            '- Preserve all heading hierarchy (H2, H3, H4).',
            '- Inject unique, kebab-case `id` attributes on every heading element.',
            '- Wrap FAQ items in appropriate semantic markup.',
            '- Preserve all inline <a> links verbatim.',
            '- Do NOT add <html>, <head>, or <body> wrapper tags — output the article body fragment only.',
            '- Do NOT inject <script>, <style>, <iframe>, or event-handler attributes.',
            '',
            '# OUTPUT FORMAT',
            'Return ONLY valid, compact JSON with this schema:',
            '  { "content_html": string, "headings": [{"level": number, "text": string, "id": string}], "heading_ids_injected": boolean }',
            '',
            'No markdown fences, no prose outside JSON.',
            'Return valid JSON only.',
        ].join('\n'),
        user: '', // User prompt is built dynamically at callsite
    },

    stage4_image: {
        system: [
            'You are an image prompt specialist for a blog website.',
            'Generate a detailed image prompt for a blog featured image.',
            '',
            '# NEGATIVE RULES (MUST OBEY)',
            '- No text / No words / No letters anywhere in the image.',
            '- No watermarks, no logos, no overlaid UI elements.',
            '- No video, no animation, no GIF — static image only.',
            '',
            '# STYLE',
            '- Professional, editorial quality, vibrant colors.',
            '- Appropriate for a professional publication.',
            '',
            'Return JSON: {"prompt": "...", "alt_text": "..."}',
        ].join('\n'),
        user: '', // User prompt is built dynamically at callsite
    },
};

// ─── Parser ─────────────────────────────────────────────────────

/**
 * Parse a markdown prompt file into a partial PromptRegistry.
 * Only returns keys whose H2 heading was found and had parseable subsections.
 */
export function parsePromptFile(content: string): Partial<PromptRegistry> {
    const result: Partial<PromptRegistry> = {};
    const lines = content.split('\n');

    let currentKey: PromptStageKey | null = null;
    let currentSubsection: 'system' | 'user' | null = null;
    let buffer: string[] = [];

    const flushBuffer = () => {
        if (currentKey && currentSubsection) {
            if (!result[currentKey]) {
                result[currentKey] = { system: '', user: '' };
            }
            result[currentKey]![currentSubsection] = buffer.join('\n').trim();
        }
        buffer = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');

        // Check for H2 heading — ONLY recognized headings act as section delimiters.
        // Unrecognized ## lines (e.g. "## HowTo" inside prompt content) are treated as body text.
        if (line.startsWith('## ')) {
            const normalized = line.replace(/\s+/g, ' ').trim();
            const match = HEADING_PATTERNS.find((p) => normalized === p.pattern);
            if (match) {
                flushBuffer();
                currentSubsection = null;
                currentKey = match.key;
                continue;
            }
            // Unrecognized ## heading — fall through to be treated as content
        }

        // Check for H3 subsection under a recognized H2 — ONLY "System Prompt" and
        // "User Prompt" act as subsection delimiters. Other ### headings (e.g. "### Rules")
        // inside prompt content are treated as body text.
        if (line.startsWith('### ') && currentKey) {
            const sub = line.replace(/^###\s*/, '').trim().toLowerCase();
            if (sub === 'system prompt') {
                flushBuffer();
                currentSubsection = 'system';
                continue;
            }
            if (sub === 'user prompt') {
                flushBuffer();
                currentSubsection = 'user';
                continue;
            }
            // Unrecognized ### heading — fall through to be treated as content
        }

        // Accumulate body lines under a recognized subsection
        if (currentKey && currentSubsection) {
            buffer.push(line);
        }
    }

    // Flush final buffer
    flushBuffer();

    return result;
}

// ─── Loader (cached) ────────────────────────────────────────────

let _cached: PromptRegistry | null = null;

/**
 * Load the prompt registry.
 * - If PROMPTS_FILE_PATH is set → use that path.
 * - Else → try ./prompts/my_prompts.md (relative to CWD).
 * - If path is readable → parse it and merge over embedded defaults.
 * - Otherwise → return embedded defaults (CI-safe fallback).
 * - Caches result (load once per process).
 */
export function loadPromptRegistry(): PromptRegistry {
    if (_cached) return _cached;

    const envPath = process.env.PROMPTS_FILE_PATH;
    const filePath = (envPath && envPath.trim() !== '') ? envPath : './prompts/my_prompts.md';

    logger.info('PromptLoader: resolved prompts file path', {
        env_set: !!(envPath && envPath.trim() !== ''),
        path: filePath,
    });

    // ── File not readable → fallback ──
    let rawContent: string;
    try {
        rawContent = fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('PromptLoader: external file unreadable, falling back to embedded prompts', {
            source: 'fallback',
            path: filePath,
            reason,
        });
        _cached = { ...EMBEDDED_PROMPTS };
        return _cached;
    }

    // ── Parse external file ──
    const checksum = crypto.createHash('sha256').update(rawContent).digest('hex').slice(0, 16);
    const parsed = parsePromptFile(rawContent);
    const parsedKeys = Object.keys(parsed) as PromptStageKey[];
    const allKeys: PromptStageKey[] = ['stage2', 'stage3_draft', 'stage3_finalEdit', 'stage_final_html', 'stage4_image'];
    const missingKeys = allKeys.filter((k) => !parsedKeys.includes(k));

    if (missingKeys.length > 0) {
        logger.warn('PromptLoader: some headings missing from external file, using embedded fallback for those keys', {
            source: 'external',
            path: filePath,
            checksum,
            keys_present: parsedKeys,
            keys_missing: missingKeys,
        });
    } else {
        logger.info('PromptLoader: loaded prompts from external file', {
            source: 'external',
            path: filePath,
            checksum,
            keys_present: parsedKeys,
        });
    }

    // Log parsed section diagnostics (safe — no prompt content)
    logger.info('PromptLoader: section diagnostics', {
        sections_found: parsedKeys.length,
        section_names: parsedKeys,
        has_system: parsedKeys.filter((k) => (parsed[k]?.system || '').length > 0),
        has_user: parsedKeys.filter((k) => (parsed[k]?.user || '').length > 0),
    });

    // Merge: external overrides embedded for present keys
    const merged: PromptRegistry = { ...EMBEDDED_PROMPTS };
    for (const key of parsedKeys) {
        const block = parsed[key]!;
        merged[key] = {
            system: block.system || EMBEDDED_PROMPTS[key].system,
            user: block.user || EMBEDDED_PROMPTS[key].user,
        };
    }

    // Confirm HTML Composer section is non-empty
    logger.info('PromptLoader: HTML Composer section check', {
        html_composer_system_len: merged.stage_final_html.system.length,
        html_composer_has_content: merged.stage_final_html.system.trim().length > 0,
    });

    _cached = merged;
    return _cached;
}

/**
 * Reset cached registry (for testing only).
 */
export function _resetPromptRegistryCache(): void {
    _cached = null;
}
