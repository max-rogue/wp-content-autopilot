/**
 * JSON Repair Tests — code fence stripping, JSON extraction, bounded excerpts,
 * brace-matching extraction, parse diagnostics.
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.3 (fail-closed research)
 *
 * Tests:
 *   - tryParseJsonResponse: direct JSON parse (fast path)
 *   - tryParseJsonResponse: strips code fences and parses
 *   - tryParseJsonResponse: extracts JSON from prose
 *   - tryParseJsonResponse: returns excerpt on total failure
 *   - stripCodeFences: various fence formats
 *   - extractJsonSubstring: leading/trailing prose
 *   - extractJsonByBraceMatch: state machine extraction
 *   - boundedExcerpt: length limits
 */

import { describe, it, expect } from 'vitest';
import {
    tryParseJsonResponse,
    stripCodeFences,
    extractJsonSubstring,
    extractJsonByBraceMatch,
    boundedExcerpt,
} from './json-repair';

// ── tryParseJsonResponse ────────────────────────────────────────

describe('tryParseJsonResponse', () => {
    it('parses well-formed JSON directly (fast path)', () => {
        const raw = '{"outline_points": ["intro", "faq"], "facts": []}';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as any).outline_points).toEqual(['intro', 'faq']);
        }
    });

    it('strips ```json code fences and parses', () => {
        const raw = '```json\n{"outline_points": ["A"], "facts": []}\n```';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as any).outline_points).toEqual(['A']);
        }
    });

    it('strips ```JSON code fences (uppercase)', () => {
        const raw = '```JSON\n{"key": "value"}\n```';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
    });

    it('strips ``` code fences without language tag', () => {
        const raw = '```\n{"key": "value"}\n```';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
    });

    it('extracts JSON from leading prose text', () => {
        const raw = 'Here is the research data:\n{"outline_points": ["A"]}';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as any).outline_points).toEqual(['A']);
        }
    });

    it('extracts JSON object from trailing commentary', () => {
        const raw = '{"key": "val"}\n\nI hope this helps!';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as any).key).toBe('val');
        }
    });

    it('extracts JSON array from prose', () => {
        const raw = 'The results are:\n[{"a": 1}, {"a": 2}]\nEnd.';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(Array.isArray(result.data)).toBe(true);
            expect((result.data as any).length).toBe(2);
        }
    });

    it('returns ok:false with excerpt on totally invalid input', () => {
        const raw = 'This is just plain text with no JSON at all.';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.excerpt).toContain('This is just plain text');
        }
    });

    it('returns ok:false with excerpt on malformed JSON', () => {
        const raw = '{"unclosed": "value';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.excerpt.length).toBeGreaterThan(0);
        }
    });

    it('excerpt is bounded to 500 chars max', () => {
        const raw = 'x'.repeat(1000);
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.excerpt.length).toBeLessThanOrEqual(500);
        }
    });

    it('handles complex nested JSON inside code fences', () => {
        const raw = `\`\`\`json
{
  "outline_points": ["Introduction", "History", "Technique", "FAQ"],
  "facts": [
    {"claim": "Golf originated in Scotland", "source_url": "https://example.com/golf-history"},
    {"claim": "Tiger Woods has 82 PGA wins", "source_url": "https://example.com/tiger"}
  ],
  "definitions": ["Handicap: A measure of a golfer's ability"],
  "unknowns": [],
  "citations_required": true,
  "citations_present": true
}
\`\`\``;
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            const data = result.data as any;
            expect(data.outline_points).toHaveLength(4);
            expect(data.facts).toHaveLength(2);
            expect(data.citations_present).toBe(true);
        }
    });

    it('handles empty string input', () => {
        const result = tryParseJsonResponse('');
        expect(result.ok).toBe(false);
    });

    it('handles whitespace-only input', () => {
        const result = tryParseJsonResponse('   \n\n   ');
        expect(result.ok).toBe(false);
    });

    // ── NEW: brace-match extraction tests via tryParseJsonResponse ──

    it('extracts JSON from trailing prose via brace-match (not lastIndexOf)', () => {
        // JSON + trailing prose with } in the prose — old lastIndexOf would grab wrong }
        const raw = '{"key": "value", "nested": {"a": 1}} This is commentary with a closing } brace.';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.data as any).key).toBe('value');
            expect((result.data as any).nested).toEqual({ a: 1 });
        }
    });

    it('handles truncated JSON (missing closing }) via brace-match', () => {
        const raw = '{"outline_points": ["A", "B"], "facts": [{"claim": "test"';
        const result = tryParseJsonResponse(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.excerpt.length).toBeGreaterThan(0);
        }
    });
});

// ── stripCodeFences ─────────────────────────────────────────────

describe('stripCodeFences', () => {
    it('removes ```json fences', () => {
        expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('removes ``` fences (no language)', () => {
        expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('removes ```javascript fences', () => {
        expect(stripCodeFences('```javascript\n{"a":1}\n```')).toBe('{"a":1}');
    });

    it('handles partial fence (no closing)', () => {
        const result = stripCodeFences('```json\n{"a":1}');
        expect(result).toBe('{"a":1}');
    });

    it('returns plain text unchanged', () => {
        expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
    });

    it('trims whitespace', () => {
        expect(stripCodeFences('  {"a":1}  ')).toBe('{"a":1}');
    });
});

// ── extractJsonSubstring ────────────────────────────────────────

describe('extractJsonSubstring', () => {
    it('extracts object from leading text', () => {
        expect(extractJsonSubstring('Here: {"a":1}')).toBe('{"a":1}');
    });

    it('extracts object from trailing text', () => {
        expect(extractJsonSubstring('{"a":1} done!')).toBe('{"a":1}');
    });

    it('extracts array', () => {
        expect(extractJsonSubstring('Results: [1,2,3] end')).toBe('[1,2,3]');
    });

    it('chooses earliest bracket (object before array)', () => {
        expect(extractJsonSubstring('text {"a": [1]} more')).toBe('{"a": [1]}');
    });

    it('returns input unchanged when no brackets found', () => {
        expect(extractJsonSubstring('no json here')).toBe('no json here');
    });
});

// ── extractJsonByBraceMatch ─────────────────────────────────────

describe('extractJsonByBraceMatch', () => {
    it('extracts first complete JSON object from trailing prose', () => {
        const input = '{"key":"val"} Some trailing text here.';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('{"key":"val"}');
    });

    it('extracts first JSON object from leading prose', () => {
        const input = 'Here is the data: {"a": 1, "b": 2}';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('{"a": 1, "b": 2}');
    });

    it('extracts JSON array correctly', () => {
        const input = 'Results: [1, 2, 3] end';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('[1, 2, 3]');
    });

    it('handles nested objects correctly', () => {
        const input = '{"outer": {"inner": {"deep": true}}, "key": "val"} extra garbage } here';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('{"outer": {"inner": {"deep": true}}, "key": "val"}');
        // Ensure the trailing } in garbage is NOT included
        expect(JSON.parse(result!)).toEqual({
            outer: { inner: { deep: true } },
            key: 'val',
        });
    });

    it('ignores braces inside quoted strings', () => {
        const input = '{"message": "Use {curly} and [square] braces carefully"} done';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('{"message": "Use {curly} and [square] braces carefully"}');
        expect(JSON.parse(result!).message).toBe('Use {curly} and [square] braces carefully');
    });

    it('handles escaped quotes inside strings', () => {
        const input = '{"text": "He said \\"hello\\" and left", "n": 1} trailing';
        const result = extractJsonByBraceMatch(input);
        expect(result).not.toBeNull();
        const parsed = JSON.parse(result!);
        expect(parsed.text).toBe('He said "hello" and left');
        expect(parsed.n).toBe(1);
    });

    it('handles backslash-backslash before quote (not an escaped quote)', () => {
        // In JSON: {"path": "C:\\\\"}  →  the string value is C:\\
        const input = '{"path": "C:\\\\"} after';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('{"path": "C:\\\\"}');
        expect(JSON.parse(result!).path).toBe('C:\\');
    });

    it('returns null for truncated JSON (missing closing brace)', () => {
        const input = '{"key": "value", "nested": {"a": 1';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBeNull();
    });

    it('returns null when no braces found', () => {
        const input = 'just plain text with no JSON';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBeNull();
    });

    it('extracts JSON object when prose contains braces after the object', () => {
        // This is the key bug case: lastIndexOf('}') would grab the wrong }
        const input = '{"a": 1, "b": {"c": 2}} Note: use {this} syntax.';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('{"a": 1, "b": {"c": 2}}');
    });

    it('handles arrays with nested objects', () => {
        const input = '[{"a": 1}, {"b": 2}] extra text';
        const result = extractJsonByBraceMatch(input);
        expect(result).toBe('[{"a": 1}, {"b": 2}]');
    });
});

// ── boundedExcerpt ──────────────────────────────────────────────

describe('boundedExcerpt', () => {
    it('truncates to 500 chars by default', () => {
        const long = 'a'.repeat(1000);
        const ex = boundedExcerpt(long);
        expect(ex.length).toBe(500);
        expect(ex.endsWith('...')).toBe(true);
    });

    it('keeps short strings unchanged', () => {
        expect(boundedExcerpt('short')).toBe('short');
    });

    it('redacts API key patterns', () => {
        const input = 'Error with key=AIzaSyABCDEFGHIJKLMNOPQRSTUV in url';
        const ex = boundedExcerpt(input);
        expect(ex).toContain('[REDACTED_KEY]');
        expect(ex).not.toContain('AIzaSy');
    });

    it('custom length works', () => {
        const long = 'b'.repeat(200);
        const ex = boundedExcerpt(long, 50);
        expect(ex.length).toBe(50);
    });
});
