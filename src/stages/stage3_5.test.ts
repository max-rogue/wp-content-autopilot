/**
 * Stage 3.5 Tests — Final HTML Composer
 * Ref: T-03
 *
 * Tests:
 *   1. Happy path: mock LLM returns valid raw HTML → html_artifact populated, html_len > 0
 *   2. Failure path: LLM throws → fallback empty content_html + warning
 *   3. Non-HTML response: LLM returns plain text → fallback
 *   4. Empty response: LLM returns empty string → fallback
 *   5. Mock mode: returns fallback immediately (no LLM call)
 *   6. schema_version = "1.0" always
 *   7. Deterministic source_markdown_hash
 *   8. Sanitizer rejects unsafe HTML → fallback
 *   9. Sanitizer rejects duplicate heading ids → fallback
 *  10. Headings extracted correctly from raw HTML
 *  11. Markdown fences stripped from LLM output
 *  12. heading_ids_injected = false when headings lack ids
 *  13. No responseMimeType sent to LLM (raw HTML, not JSON)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runStage3_5, extractHeadingsFromHtml } from './stage3_5';
import type { Stage3Output } from '../types';
import { SCHEMA_VERSION } from '../types';

// Mock logger
vi.mock('../logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

// Mock prompt-loader — return a real system prompt for stage_final_html
vi.mock('../config/prompt-loader', () => ({
    loadPromptRegistry: vi.fn(() => ({
        stage2: { system: '', user: '' },
        stage3_draft: { system: '', user: '' },
        stage3_finalEdit: { system: '', user: '' },
        stage_final_html: {
            system: 'You are an HTML composer. Convert markdown to clean HTML.',
            user: '',
        },
        stage4_image: { system: '', user: '' },
    })),
}));

// ─── Fixtures ───────────────────────────────────────────────────

function makeStage3Output(overrides?: Partial<Stage3Output>): Stage3Output {
    return {
        schema_version: SCHEMA_VERSION,
        title: 'Test Article',
        content_markdown: '# Heading 1\n\nParagraph text.\n\n## Heading 2\n\nMore text.',
        excerpt: 'Test excerpt',
        suggested_slug: 'test-article',
        category: 'golf-tips',
        tags: ['golf'],
        focus_keyword: 'test keyword',
        additional_keywords: [],
        meta_title: 'Test Article | MySite',
        meta_description: 'Test description for the article.',
        faq: [
            { question: 'Q1?', answer: 'A1' },
            { question: 'Q2?', answer: 'A2' },
            { question: 'Q3?', answer: 'A3' },
        ],
        featured_image: { prompt: 'golf course', alt_text: 'golf course image' },
        citations: [],
        publish_recommendation: 'PUBLISH',
        reasons: [],
        missing_data_fields: [],
        ...overrides,
    };
}

/** Valid raw HTML response (NO JSON wrapper — just HTML text) */
const VALID_HTML_RESPONSE =
    '<section id="intro"><p>Introduction text.</p></section>' +
    '<h2 id="heading-1">Heading 1</h2><p>Paragraph text.</p>' +
    '<h2 id="heading-2">Heading 2</h2><p>More text.</p>';

function makeWriterService(options: {
    mockMode?: boolean;
    callLlmResult?: string;
    callLlmError?: Error;
}): any {
    const { mockMode = false, callLlmResult, callLlmError } = options;
    return {
        isMockMode: () => mockMode,
        config: {
            llmFinalProvider: 'openai',
            llmFinalModel: 'gpt-4o',
            maxOutputTokensHtml: 8192,
            geminiThinkingLevel: 'HIGH',
        },
        callLlm: callLlmError
            ? vi.fn().mockRejectedValue(callLlmError)
            : vi.fn().mockResolvedValue(callLlmResult ?? VALID_HTML_RESPONSE),
    };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Stage 3.5 — HTML Composer (raw HTML mode)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // ── Test 1: Happy path — valid raw HTML ─────────────────────

    it('produces html_artifact with required fields on valid raw HTML response', async () => {
        const writer = makeWriterService({});
        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.schema_version).toBe(SCHEMA_VERSION);
        expect(result.output.html_artifact.content_html.length).toBeGreaterThan(0);
        expect(result.output.html_artifact.content_html).toContain('<h2');
        expect(result.output.html_artifact.content_html).toContain('Heading 1');
        expect(result.output.html_artifact.headings).toHaveLength(2);
        expect(result.output.html_artifact.headings[0]).toEqual({
            level: 2,
            text: 'Heading 1',
            id: 'heading-1',
        });
        expect(result.output.html_artifact.heading_ids_injected).toBe(true);
        expect(result.output.source_markdown_hash).toHaveLength(16);
        expect(result.output.qa_notes).toHaveLength(0);

        // Verify LLM was called
        expect(writer.callLlm).toHaveBeenCalledOnce();
    });

    // ── Test 2: LLM throws → fallback ──────────────────────────

    it('returns fallback when LLM throws', async () => {
        const writer = makeWriterService({
            callLlmError: new Error('network_error_simulated'),
        });

        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html).toBe('');
        expect(result.output.html_artifact.headings).toEqual([]);
        expect(result.output.html_artifact.heading_ids_injected).toBe(false);
        expect(result.output.qa_notes).toHaveLength(1);
        expect(result.output.qa_notes[0]).toContain('html_composer_fallback');
        expect(result.output.qa_notes[0]).toContain('network_error_simulated');
    });

    // ── Test 3: LLM returns non-HTML text → fallback ────────────

    it('returns fallback when LLM returns non-HTML text', async () => {
        const writer = makeWriterService({
            callLlmResult: 'This is just plain text, not HTML at all.',
        });

        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html).toBe('');
        expect(result.output.qa_notes[0]).toContain('response_not_html');
    });

    // ── Test 4: LLM returns empty string → fallback ─────────────

    it('returns fallback when LLM returns empty string', async () => {
        const writer = makeWriterService({
            callLlmResult: '',
        });

        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html).toBe('');
        expect(result.output.qa_notes[0]).toContain('empty_response');
    });

    // ── Test 5: Mock mode → immediate fallback ─────────────────

    it('returns fallback in mock mode without calling LLM', async () => {
        const writer = makeWriterService({ mockMode: true });

        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html).toBe('');
        expect(result.output.qa_notes[0]).toContain('mock_mode');
        expect(writer.callLlm).not.toHaveBeenCalled();
    });

    // ── Test 6: schema_version = "1.0" ─────────────────────────

    it('always includes schema_version "1.0"', async () => {
        const writer = makeWriterService({});

        const happyResult = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });
        expect(happyResult.output.schema_version).toBe('1.0');

        const errorWriter = makeWriterService({
            callLlmError: new Error('fail'),
        });
        const errorResult = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: errorWriter,
        });
        expect(errorResult.output.schema_version).toBe('1.0');
    });

    // ── Test 7: source_markdown_hash is deterministic ──────────

    it('produces deterministic source_markdown_hash', async () => {
        const writer = makeWriterService({});
        const stage3 = makeStage3Output();

        const r1 = await runStage3_5({ stage3, writerService: writer });
        const r2 = await runStage3_5({ stage3, writerService: writer });

        expect(r1.output.source_markdown_hash).toBe(r2.output.source_markdown_hash);
        expect(r1.output.source_markdown_hash).toHaveLength(16);
    });

    // ── Test 8: Sanitizer rejects unsafe HTML → fallback ───────

    it('returns fallback when LLM response contains unsafe tags', async () => {
        const unsafeHtml =
            '<h2 id="heading-1">Title</h2><script>alert("xss")</script><p>Text</p>';

        const writer = makeWriterService({ callLlmResult: unsafeHtml });
        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html).toBe('');
        expect(result.output.qa_notes[0]).toContain('html_sanitize_failed');
        expect(result.output.qa_notes[0]).toContain('unsafe_tag_detected');
    });

    // ── Test 9: Sanitizer rejects duplicate heading ids → fallback

    it('returns fallback when HTML has duplicate heading ids', async () => {
        const dupIdHtml =
            '<h2 id="intro">Intro</h2><h2 id="intro">Also Intro</h2><p>Text</p>';

        const writer = makeWriterService({ callLlmResult: dupIdHtml });
        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html).toBe('');
        expect(result.output.qa_notes[0]).toContain('html_sanitize_failed');
        expect(result.output.qa_notes[0]).toContain('duplicate heading id');
    });

    // ── Test 10: Headings extracted correctly from raw HTML ─────

    it('extracts headings with levels, text, and ids from raw HTML', async () => {
        const htmlWithHeadings =
            '<section id="intro"><p>Intro text.</p></section>' +
            '<h2 id="cach-chon">Cách chọn</h2><p>Content.</p>' +
            '<h3 id="sub-section">Sub section</h3><p>More.</p>' +
            '<h2 id="ket-luan">Kết luận</h2><p>End.</p>';

        const writer = makeWriterService({ callLlmResult: htmlWithHeadings });
        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html.length).toBeGreaterThan(0);
        expect(result.output.html_artifact.headings).toHaveLength(3);
        expect(result.output.html_artifact.headings[0]).toEqual({
            level: 2,
            text: 'Cách chọn',
            id: 'cach-chon',
        });
        expect(result.output.html_artifact.headings[1]).toEqual({
            level: 3,
            text: 'Sub section',
            id: 'sub-section',
        });
        expect(result.output.html_artifact.headings[2]).toEqual({
            level: 2,
            text: 'Kết luận',
            id: 'ket-luan',
        });
        expect(result.output.html_artifact.heading_ids_injected).toBe(true);
    });

    // ── Test 11: Markdown fences are stripped from LLM output ────

    it('strips markdown fences and accepts the HTML inside', async () => {
        const fencedHtml = '```html\n<h2 id="test">Test</h2><p>Content here.</p>\n```';

        const writer = makeWriterService({ callLlmResult: fencedHtml });
        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html.length).toBeGreaterThan(0);
        expect(result.output.html_artifact.content_html).toContain('<h2 id="test">Test</h2>');
        expect(result.output.html_artifact.content_html).not.toContain('```');
    });

    // ── Test 12: heading_ids_injected = false when headings have no ids

    it('sets heading_ids_injected=false when headings lack id attributes', async () => {
        const htmlNoIds = '<h2>Heading Without ID</h2><p>Some text.</p>';

        const writer = makeWriterService({ callLlmResult: htmlNoIds });
        const result = await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(result.ok).toBe(true);
        expect(result.output.html_artifact.content_html.length).toBeGreaterThan(0);
        expect(result.output.html_artifact.heading_ids_injected).toBe(false);
        expect(result.output.html_artifact.headings[0].id).toBe('');
    });

    // ── Test 13: No responseMimeType in LLM call ────────────────

    it('does not send responseMimeType to LLM (accepts raw HTML, not JSON)', async () => {
        const writer = makeWriterService({});
        await runStage3_5({
            stage3: makeStage3Output(),
            writerService: writer,
        });

        expect(writer.callLlm).toHaveBeenCalledOnce();
        const callArgs = writer.callLlm.mock.calls[0][0];
        expect(callArgs).not.toHaveProperty('responseMimeType');
    });
});

// ─── extractHeadingsFromHtml unit tests ─────────────────────────

describe('extractHeadingsFromHtml', () => {
    it('extracts h1-h6 with ids', () => {
        const html = '<h1 id="title">Main Title</h1><h2 id="sec1">Section 1</h2><h3 id="sub">Sub</h3>';
        const result = extractHeadingsFromHtml(html);
        expect(result).toEqual([
            { level: 1, text: 'Main Title', id: 'title' },
            { level: 2, text: 'Section 1', id: 'sec1' },
            { level: 3, text: 'Sub', id: 'sub' },
        ]);
    });

    it('returns empty id when heading has no id attribute', () => {
        const html = '<h2>No ID Here</h2>';
        const result = extractHeadingsFromHtml(html);
        expect(result).toEqual([{ level: 2, text: 'No ID Here', id: '' }]);
    });

    it('strips inner tags from heading text', () => {
        const html = '<h2 id="bold-heading"><strong>Bold</strong> Heading</h2>';
        const result = extractHeadingsFromHtml(html);
        expect(result).toEqual([{ level: 2, text: 'Bold Heading', id: 'bold-heading' }]);
    });

    it('returns empty array for HTML with no headings', () => {
        const html = '<p>Just a paragraph.</p><div>And a div.</div>';
        const result = extractHeadingsFromHtml(html);
        expect(result).toEqual([]);
    });
});
