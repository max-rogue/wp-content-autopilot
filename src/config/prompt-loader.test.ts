/**
 * Prompt Loader Tests — T-02 external prompt loading with CI-safe fallback.
 *
 * Tests:
 *   1. Happy path: temp file with all headings → correct blocks returned
 *   2. File missing fallback: no crash, returns embedded defaults
 *   3. Missing heading warning: partial file → fallback for missing keys
 *   4. Caching: same reference on repeated calls
 *   5. Never logs prompt content: logger calls contain only metadata
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    loadPromptRegistry,
    parsePromptFile,
    _resetPromptRegistryCache,
    EMBEDDED_PROMPTS,
    type PromptRegistry,
} from './prompt-loader';

// Mock the logger to inspect calls
vi.mock('../logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

import { logger } from '../logger';

// ─── Test fixtures ──────────────────────────────────────────────

const FULL_PROMPTS_MD = `
# Pipeline Prompts

## STAGE 2 — Research Agent

### System Prompt

You are a test research agent system prompt.
Line 2 of research system.

### User Prompt

Research user prompt template.

## STAGE 3 — Writer Agent (Draft)

### System Prompt

You are a test draft writer system prompt.
Multi-line draft system.

### User Prompt

Draft user prompt template.

## STAGE 3 — finalEdit

### System Prompt

You are a test final editor system prompt.

### User Prompt

FinalEdit user prompt template.

## STAGE FINAL — HTML Composer

### System Prompt

You are a test HTML composer system prompt.

### User Prompt

HTML user prompt template.

## STAGE 4 — Image Generation

### System Prompt

You are a test image prompt specialist.

### User Prompt

Image user prompt template.
`;

const PARTIAL_PROMPTS_MD = `
# Pipeline Prompts

## STAGE 2 — Research Agent

### System Prompt

Partial research system prompt.

### User Prompt

Partial research user prompt.

## STAGE 3 — finalEdit

### System Prompt

Partial finalEdit system prompt.

### User Prompt

Partial finalEdit user prompt.
`;

describe('parsePromptFile', () => {
    it('parses all 5 stage headings from a complete file', () => {
        const result = parsePromptFile(FULL_PROMPTS_MD);

        expect(result.stage2).toBeDefined();
        expect(result.stage3_draft).toBeDefined();
        expect(result.stage3_finalEdit).toBeDefined();
        expect(result.stage_final_html).toBeDefined();
        expect(result.stage4_image).toBeDefined();

        expect(result.stage2!.system).toContain('test research agent system prompt');
        expect(result.stage2!.system).toContain('Line 2 of research system');
        expect(result.stage2!.user).toContain('Research user prompt template');

        expect(result.stage3_draft!.system).toContain('test draft writer system prompt');
        expect(result.stage3_draft!.user).toContain('Draft user prompt template');

        expect(result.stage3_finalEdit!.system).toContain('test final editor system prompt');
        expect(result.stage4_image!.system).toContain('test image prompt specialist');
        expect(result.stage_final_html!.system).toContain('test HTML composer system prompt');
    });

    it('returns only present keys from partial file', () => {
        const result = parsePromptFile(PARTIAL_PROMPTS_MD);

        expect(result.stage2).toBeDefined();
        expect(result.stage3_finalEdit).toBeDefined();

        expect(result.stage3_draft).toBeUndefined();
        expect(result.stage_final_html).toBeUndefined();
        expect(result.stage4_image).toBeUndefined();

        expect(result.stage2!.system).toContain('Partial research system prompt');
        expect(result.stage3_finalEdit!.system).toContain('Partial finalEdit system prompt');
    });

    it('returns empty object for content without matching headings', () => {
        const result = parsePromptFile('# Just a title\n\nSome random text.');
        expect(Object.keys(result)).toHaveLength(0);
    });
});

describe('loadPromptRegistry', () => {
    const originalEnv = process.env.PROMPTS_FILE_PATH;

    beforeEach(() => {
        _resetPromptRegistryCache();
        delete process.env.PROMPTS_FILE_PATH;
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.PROMPTS_FILE_PATH = originalEnv;
        } else {
            delete process.env.PROMPTS_FILE_PATH;
        }
    });

    // ── Test 1: Happy path ──────────────────────────────────────

    it('loads prompts from external file when PROMPTS_FILE_PATH is set', () => {
        const tmpPath = path.join(os.tmpdir(), `test-prompts-${Date.now()}.md`);
        fs.writeFileSync(tmpPath, FULL_PROMPTS_MD, 'utf-8');

        try {
            process.env.PROMPTS_FILE_PATH = tmpPath;
            const registry = loadPromptRegistry();

            expect(registry.stage2.system).toContain('test research agent system prompt');
            expect(registry.stage3_draft.system).toContain('test draft writer system prompt');
            expect(registry.stage3_finalEdit.system).toContain('test final editor system prompt');
            expect(registry.stage_final_html.system).toContain('test HTML composer system prompt');
            expect(registry.stage4_image.system).toContain('test image prompt specialist');

            // Verify logging metadata
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('loaded prompts from external file'),
                expect.objectContaining({
                    source: 'external',
                    path: tmpPath,
                    checksum: expect.any(String),
                    keys_present: expect.arrayContaining(['stage2', 'stage3_draft']),
                }),
            );
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });

    // ── Test 2: File missing fallback ───────────────────────────

    it('falls back to embedded prompts when both env var is unset and default path is unreadable', () => {
        // Mock fs.readFileSync to simulate default file not existing
        const originalReadFileSync = fs.readFileSync;
        const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: unknown[]) => {
            const filePath = args[0] as string;
            // Block the default path to force fallback
            if (filePath.includes('custom_prompts_v2')) {
                throw new Error('ENOENT: no such file or directory');
            }
            return originalReadFileSync.apply(fs, args as Parameters<typeof originalReadFileSync>);
        });

        try {
            const registry = loadPromptRegistry();

            expect(registry.stage2.system).toBe(EMBEDDED_PROMPTS.stage2.system);
            expect(registry.stage3_draft.system).toBe(EMBEDDED_PROMPTS.stage3_draft.system);
            expect(registry.stage3_finalEdit.system).toBe(EMBEDDED_PROMPTS.stage3_finalEdit.system);
            expect(registry.stage4_image.system).toBe(EMBEDDED_PROMPTS.stage4_image.system);

            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('external file unreadable'),
                expect.objectContaining({
                    source: 'fallback',
                }),
            );
        } finally {
            spy.mockRestore();
        }
    });

    it('falls back when PROMPTS_FILE_PATH points to nonexistent file', () => {
        process.env.PROMPTS_FILE_PATH = '/nonexistent/path/prompts.md';
        const registry = loadPromptRegistry();

        expect(registry.stage2.system).toBe(EMBEDDED_PROMPTS.stage2.system);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('external file unreadable'),
            expect.objectContaining({
                source: 'fallback',
                path: '/nonexistent/path/prompts.md',
            }),
        );
    });

    // ── Test 3: Missing heading warning ─────────────────────────

    it('uses fallback for missing keys and emits structured warning', () => {
        const tmpPath = path.join(os.tmpdir(), `test-prompts-partial-${Date.now()}.md`);
        fs.writeFileSync(tmpPath, PARTIAL_PROMPTS_MD, 'utf-8');

        try {
            process.env.PROMPTS_FILE_PATH = tmpPath;
            const registry = loadPromptRegistry();

            // Present keys should be overridden
            expect(registry.stage2.system).toContain('Partial research system prompt');
            expect(registry.stage3_finalEdit.system).toContain('Partial finalEdit system prompt');

            // Missing keys should use embedded defaults
            expect(registry.stage3_draft.system).toBe(EMBEDDED_PROMPTS.stage3_draft.system);
            expect(registry.stage_final_html.system).toBe(EMBEDDED_PROMPTS.stage_final_html.system);
            expect(registry.stage4_image.system).toBe(EMBEDDED_PROMPTS.stage4_image.system);

            // Warning emitted
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('some headings missing'),
                expect.objectContaining({
                    source: 'external',
                    keys_missing: expect.arrayContaining(['stage3_draft', 'stage_final_html', 'stage4_image']),
                }),
            );
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });

    // ── Test 4: Caching ─────────────────────────────────────────

    it('caches registry on subsequent calls', () => {
        const first = loadPromptRegistry();
        const second = loadPromptRegistry();

        expect(first).toBe(second); // Same reference
    });

    // ── Test 5: Never logs prompt content ───────────────────────

    it('logger calls contain only metadata, never prompt content', () => {
        const tmpPath = path.join(os.tmpdir(), `test-prompts-noleak-${Date.now()}.md`);
        fs.writeFileSync(tmpPath, FULL_PROMPTS_MD, 'utf-8');

        try {
            process.env.PROMPTS_FILE_PATH = tmpPath;
            loadPromptRegistry();

            const allLogCalls = [
                ...vi.mocked(logger.info).mock.calls,
                ...vi.mocked(logger.warn).mock.calls,
            ];

            for (const call of allLogCalls) {
                const serialized = JSON.stringify(call);
                // None of the actual prompt bodies should appear in log calls
                expect(serialized).not.toContain('test research agent system prompt');
                expect(serialized).not.toContain('test draft writer system prompt');
                expect(serialized).not.toContain('test final editor system prompt');
                expect(serialized).not.toContain('test image prompt specialist');
            }
        } finally {
            fs.unlinkSync(tmpPath);
        }
    });
});

// ─── V2 Parser Stability Tests ──────────────────────────────────

/**
 * V2 fixture: has internal ## / ### / #### headings inside prompt content.
 * The parser must treat ONLY the 5 known ## headings as section delimiters.
 */
const V2_FIXTURE_MD = `
# Project Pipeline Prompts v2

## STAGE 2 — Research Agent

### System Prompt

# ROLE
You are a research agent.

### Internal Rules
- Rule 1
- Rule 2

#### Sub-rule
- Sub-rule detail

### User Prompt

Research the keyword "{{keyword}}" for a {{contentType}} article.
Context: {{contextPayload}}

## STAGE 3 — Writer Agent (Draft)

### System Prompt

# ROLE
You are a writer.

## HowTo
- This is a subtype structure guide inside the prompt content.
## BuyingGuide
- Another subtype inside prompt content.

### User Prompt

Write a {{contentType}} article about "{{keyword}}".
Context: {{contextPayload}}

## STAGE 3 — finalEdit

### System Prompt

# ROLE
You are a senior editor. This is a PATCH-ONLY pass.

### Internal Guidelines
- Fix grammar
- Improve flow

### User Prompt

Polish this draft article:
{{draft}}

## STAGE FINAL — HTML Composer

### System Prompt

# ROLE
You are a senior HTML composer.
Convert markdown to clean semantic HTML.

### User Prompt

Convert this article to HTML with structured heading IDs:
{{userPayload}}

## STAGE 4 — Image Generation

### System Prompt

You are an image prompt specialist.
No text / No words / No letters (English or Vietnamese).
No video, no animation, no GIF.

### User Prompt

Create a featured image prompt for: "{{title}}" (keyword: {{keyword}})
`;

describe('parsePromptFile — v2 stability (internal ## / ### / #### headings)', () => {
    it('parses exactly 5 sections from v2 fixture', () => {
        const result = parsePromptFile(V2_FIXTURE_MD);
        const keys = Object.keys(result);

        expect(keys).toHaveLength(5);
        expect(keys).toContain('stage2');
        expect(keys).toContain('stage3_draft');
        expect(keys).toContain('stage3_finalEdit');
        expect(keys).toContain('stage_final_html');
        expect(keys).toContain('stage4_image');
    });

    it('every section has non-empty system and user prompts', () => {
        const result = parsePromptFile(V2_FIXTURE_MD);

        for (const key of ['stage2', 'stage3_draft', 'stage3_finalEdit', 'stage_final_html', 'stage4_image'] as const) {
            const block = result[key];
            expect(block, `${key} should be defined`).toBeDefined();
            expect(block!.system.trim().length, `${key}.system should be non-empty`).toBeGreaterThan(0);
            expect(block!.user.trim().length, `${key}.user should be non-empty`).toBeGreaterThan(0);
        }
    });

    it('preserves internal ## headings as content (no section explosion)', () => {
        const result = parsePromptFile(V2_FIXTURE_MD);

        // "## HowTo" and "## BuyingGuide" inside Stage 3 draft system prompt
        // should be preserved as body text, not cause new sections
        expect(result.stage3_draft!.system).toContain('## HowTo');
        expect(result.stage3_draft!.system).toContain('## BuyingGuide');
    });

    it('preserves internal ### headings as content (not treated as subsection delimiters)', () => {
        const result = parsePromptFile(V2_FIXTURE_MD);

        // "### Internal Rules" inside Stage 2 system prompt should be content
        expect(result.stage2!.system).toContain('### Internal Rules');
        expect(result.stage2!.system).toContain('#### Sub-rule');

        // "### Internal Guidelines" inside finalEdit system prompt should be content
        expect(result.stage3_finalEdit!.system).toContain('### Internal Guidelines');
    });

    it('loads v2 fixture file via loadPromptRegistry with all 5 sections populated', () => {
        const tmpPath = path.join(os.tmpdir(), `test-prompts-v2-${Date.now()}.md`);
        fs.writeFileSync(tmpPath, V2_FIXTURE_MD, 'utf-8');

        try {
            _resetPromptRegistryCache();
            process.env.PROMPTS_FILE_PATH = tmpPath;
            const registry = loadPromptRegistry();

            // Stage 3.5 (HTML Composer) MUST NOT be empty
            expect(registry.stage_final_html.system.trim().length).toBeGreaterThan(0);
            expect(registry.stage_final_html.system).toContain('HTML composer');

            // Stage 4 MUST contain NO TEXT negative instruction
            expect(registry.stage4_image.system).toContain('No text');
            expect(registry.stage4_image.system).toContain('No words');

            // All 5 stages have system prompts
            for (const key of ['stage2', 'stage3_draft', 'stage3_finalEdit', 'stage_final_html', 'stage4_image'] as const) {
                expect(registry[key].system.trim().length, `${key}.system should be non-empty`).toBeGreaterThan(0);
            }

            // Section diagnostics logged
            expect(logger.info).toHaveBeenCalledWith(
                expect.stringContaining('section diagnostics'),
                expect.objectContaining({
                    sections_found: 5,
                }),
            );
        } finally {
            _resetPromptRegistryCache();
            delete process.env.PROMPTS_FILE_PATH;
            fs.unlinkSync(tmpPath);
        }
    });
});

// ─── Embedded Prompt Non-Emptiness Guards ───────────────────────

describe('EMBEDDED_PROMPTS — non-emptiness guards', () => {
    it('stage_final_html has non-empty system prompt (prevents Stage 3.5 skip)', () => {
        expect(EMBEDDED_PROMPTS.stage_final_html.system.trim().length).toBeGreaterThan(0);
        expect(EMBEDDED_PROMPTS.stage_final_html.system).toContain('HTML');
    });

    it('stage4_image has "No text / No words" negative rules', () => {
        expect(EMBEDDED_PROMPTS.stage4_image.system).toContain('No text');
        expect(EMBEDDED_PROMPTS.stage4_image.system).toContain('No words');
        expect(EMBEDDED_PROMPTS.stage4_image.system).toContain('No letters');
    });

    it('stage4_image has "No video" rule', () => {
        expect(EMBEDDED_PROMPTS.stage4_image.system).toContain('No video');
    });
});
