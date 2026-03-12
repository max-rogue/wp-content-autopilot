/**
 * HTML Sanitizer Tests — T-04.
 *
 * Covers:
 *   1. Unsafe tags (script, style, iframe) → fail
 *   2. Event handlers (on*) → fail
 *   3. javascript: URLs → fail
 *   4. Base64 data URIs → fail
 *   5. Multiple H1 tags → fail
 *   6. Duplicate heading ids → fail (when headingIdsInjected=true)
 *   7. Dup heading ids allowed when headingIdsInjected=false
 *   8. Empty body → fail
 *   9. Valid HTML passes unchanged
 *  10. Complex valid HTML passes
 */

import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from './html-sanitizer';

describe('HTML Sanitizer — T-04', () => {
    // ── Deny list: unsafe tags ────────────────────────────────────

    it('rejects <script> tags', () => {
        const html = '<h1 id="a">Title</h1><p>Text</p><script>alert("xss")</script>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_tag_detected');
        expect(result.reasons[0]).toContain('script');
    });

    it('rejects <style> tags', () => {
        const html = '<h1 id="a">Title</h1><style>body { display: none; }</style><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_tag_detected');
    });

    it('rejects <iframe> tags', () => {
        const html = '<h1 id="a">Title</h1><iframe src="https://evil.com"></iframe><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_tag_detected');
    });

    it('rejects self-closing <script/> tags', () => {
        const html = '<h1 id="a">Title</h1><p>Text</p><script src="evil.js"/>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_tag_detected');
    });

    // ── Deny list: event handlers ─────────────────────────────────

    it('rejects on* event handler attributes', () => {
        const html = '<h1 id="a">Title</h1><img src="x" onerror="alert(1)"><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_attribute_detected');
    });

    it('rejects onclick attributes', () => {
        const html = '<h1 id="a">Title</h1><p onclick="doEvil()">Click me</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('on* event handler');
    });

    // ── Deny list: javascript: URLs ───────────────────────────────

    it('rejects javascript: URLs in href', () => {
        const html = '<h1 id="a">Title</h1><a href="javascript:alert(1)">Click</a><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_url_detected');
    });

    it('rejects javascript: URLs in src', () => {
        const html = '<h1 id="a">Title</h1><img src="javascript:exploit()"><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_url_detected');
    });

    // ── Deny list: base64 data URIs ───────────────────────────────

    it('rejects inline base64 data URIs in src', () => {
        const html = '<h1 id="a">Title</h1><img src="data:image/png;base64,iVBOR"><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('unsafe_src_detected');
    });

    // ── Structural: H1 count ──────────────────────────────────────

    it('rejects HTML with multiple H1 tags', () => {
        const html = '<h1 id="a">First</h1><p>Text</p><h1 id="b">Second</h1>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('structural_violation');
        expect(result.reasons[0]).toContain('h1');
    });

    // ── Structural: heading id uniqueness ─────────────────────────

    it('rejects duplicate heading ids when headingIdsInjected=true', () => {
        const html = '<h1 id="intro">Intro</h1><h2 id="intro">Dup</h2><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: true });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('duplicate heading id');
        expect(result.reasons[0]).toContain('intro');
    });

    it('allows duplicate heading ids when headingIdsInjected=false', () => {
        const html = '<h1 id="intro">Intro</h1><h2 id="intro">Dup</h2><p>Text</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        // Multiple h1 will fail, but let's test the specific case:
        // This has 1 h1 + 1 h2 = ok for h1 count. ids_injected=false skips dup check.
        expect(result.ok).toBe(true);
        expect(result.sanitized).toBe(html);
    });

    // ── Structural: empty body ────────────────────────────────────

    it('rejects HTML with no text content', () => {
        const html = '<div><span></span></div>';
        const result = sanitizeHtml(html, { headingIdsInjected: false });
        expect(result.ok).toBe(false);
        expect(result.reasons[0]).toContain('empty body');
    });

    // ── Happy path ────────────────────────────────────────────────

    it('passes valid HTML unchanged', () => {
        const html = '<h1 id="heading-1">Golf Swing Basics</h1><p>Learn proper form.</p><h2 id="heading-2">Grip</h2><p>Hold the club firmly.</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: true });
        expect(result.ok).toBe(true);
        expect(result.sanitized).toBe(html);
        expect(result.reasons).toEqual([]);
    });

    it('passes complex valid HTML with multiple heading levels', () => {
        const html = [
            '<h1 id="main">Main Title</h1>',
            '<p>Introduction paragraph with <strong>bold</strong> text.</p>',
            '<h2 id="section-1">Section 1</h2>',
            '<p>Content with <a href="/hoc-golf/">internal link</a>.</p>',
            '<h3 id="sub-1-1">Sub Section</h3>',
            '<ul><li>Item 1</li><li>Item 2</li></ul>',
            '<h2 id="faq">FAQ</h2>',
            '<p>Common questions.</p>',
        ].join('');
        const result = sanitizeHtml(html, { headingIdsInjected: true });
        expect(result.ok).toBe(true);
        expect(result.sanitized).toBe(html);
    });

    it('passes HTML with zero h1 tags (heading provided separately)', () => {
        const html = '<h2 id="section">Section</h2><p>Some content here.</p>';
        const result = sanitizeHtml(html, { headingIdsInjected: true });
        expect(result.ok).toBe(true);
        expect(result.sanitized).toBe(html);
    });
});
