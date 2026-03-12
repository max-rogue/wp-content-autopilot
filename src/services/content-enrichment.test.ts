/**
 * Content Enrichment Tests — Hero Image + TOC injection
 *
 * Tests cover:
 * - Hero injection when wp_media_id exists and no existing image
 * - Hero NOT injected when content already has <img> or wp:image
 * - TOC injection when >= 3 H2/H3 headings
 * - TOC NOT injected when < 3 headings
 * - Anchor slug stability and correctness
 * - TOC links match injected heading IDs
 * - Existing heading IDs are preserved
 * - Non-blocking behavior: errors produce reasons without throwing
 * - Gate compatibility: injected markup does NOT trigger G5 banned patterns
 */

import { describe, it, expect } from 'vitest';
import {
    toSlugAnchor,
    parseHeadings,
    injectHeadingIds,
    buildHeroBlock,
    buildTocBlock,
    contentHasImage,
    contentHasTopHeroImage,
    contentHasTocBlock,
    enrichContent,
} from './content-enrichment';

// ─── toSlugAnchor ───────────────────────────────────────────────

describe('toSlugAnchor', () => {
    it('converts text to kebab-case', () => {
        expect(toSlugAnchor('Hello World')).toBe('hello-world');
    });

    it('handles Vietnamese diacritics', () => {
        expect(toSlugAnchor('Học Golf Cơ Bản')).toBe('hoc-golf-co-ban');
    });

    it('handles đ/Đ', () => {
        expect(toSlugAnchor('Địa Điểm')).toBe('dia-diem');
    });

    it('removes special characters', () => {
        expect(toSlugAnchor('What is golf? (Full Guide!)')).toBe('what-is-golf-full-guide');
    });

    it('collapses double hyphens', () => {
        expect(toSlugAnchor('Golf -- Tips')).toBe('golf-tips');
    });

    it('max 75 chars', () => {
        const longText = 'a'.repeat(100);
        expect(toSlugAnchor(longText).length).toBeLessThanOrEqual(75);
    });

    it('no trailing hyphen from truncation', () => {
        const longText = 'word '.repeat(20); // "word word word ..."
        const result = toSlugAnchor(longText);
        expect(result.endsWith('-')).toBe(false);
    });

    it('empty string produces empty', () => {
        expect(toSlugAnchor('')).toBe('');
    });

    it('same text produces same slug (stable)', () => {
        const text = 'Cách Chọn Gậy Golf Phù Hợp';
        expect(toSlugAnchor(text)).toBe(toSlugAnchor(text));
    });
});

// ─── parseHeadings ──────────────────────────────────────────────

describe('parseHeadings', () => {
    it('parses H2 and H3 headings', () => {
        const content = '<h2>First</h2><p>text</p><h3>Second</h3><h2>Third</h2>';
        const headings = parseHeadings(content);
        expect(headings).toHaveLength(3);
        expect(headings[0]).toMatchObject({ level: 2, text: 'First' });
        expect(headings[1]).toMatchObject({ level: 3, text: 'Second' });
        expect(headings[2]).toMatchObject({ level: 2, text: 'Third' });
    });

    it('ignores H1 headings', () => {
        const content = '<h1>Title</h1><h2>Section</h2>';
        const headings = parseHeadings(content);
        expect(headings).toHaveLength(1);
        expect(headings[0].text).toBe('Section');
    });

    it('preserves existing id attributes', () => {
        const content = '<h2 id="custom-id">Section</h2>';
        const headings = parseHeadings(content);
        expect(headings[0].id).toBe('custom-id');
        expect(headings[0].existingId).toBe(true);
    });

    it('generates id from text when missing', () => {
        const content = '<h2>My Section Title</h2>';
        const headings = parseHeadings(content);
        expect(headings[0].id).toBe('my-section-title');
        expect(headings[0].existingId).toBe(false);
    });

    it('strips inner HTML from heading text', () => {
        const content = '<h2><strong>Bold</strong> Text</h2>';
        const headings = parseHeadings(content);
        expect(headings[0].text).toBe('Bold Text');
    });

    it('returns empty array for no headings', () => {
        expect(parseHeadings('<p>no headings</p>')).toEqual([]);
    });

    it('generates deterministic collision-safe IDs for duplicate headings', () => {
        const content = '<h2>Section</h2><h2>Section</h2><h2>Section</h2>';
        const headings = parseHeadings(content);
        expect(headings.map((h) => h.id)).toEqual(['section', 'section-2', 'section-3']);
    });

    it('handles headings with classes and attributes', () => {
        const content = '<h2 class="wp-block-heading" data-custom="x">Topic</h2>';
        const headings = parseHeadings(content);
        expect(headings).toHaveLength(1);
        expect(headings[0].text).toBe('Topic');
        expect(headings[0].existingId).toBe(false);
    });
});

// ─── contentHasImage ────────────────────────────────────────────

describe('contentHasImage', () => {
    it('detects <img> tag', () => {
        expect(contentHasImage('<p>text</p><img src="x.jpg"/>')).toBe(true);
    });

    it('detects <img > with space', () => {
        expect(contentHasImage('<img src="x.jpg">')).toBe(true);
    });

    it('detects wp:image block', () => {
        expect(contentHasImage('<!-- wp:image {"id":1} --><figure><img/></figure><!-- /wp:image -->')).toBe(true);
    });

    it('returns false for no image', () => {
        expect(contentHasImage('<p>text only</p>')).toBe(false);
    });

    it('case insensitive', () => {
        expect(contentHasImage('<IMG src="x.jpg">')).toBe(true);
    });
});

describe('contentHasTopHeroImage', () => {
    it('returns true when image is near top', () => {
        const content = '<p>intro</p><img src="x.jpg"/><p>body</p>';
        expect(contentHasTopHeroImage(content, 1200)).toBe(true);
    });

    it('returns false when first image is deep in content', () => {
        const content = '<p>' + 'a'.repeat(2000) + '</p><img src="x.jpg"/>';
        expect(contentHasTopHeroImage(content, 1200)).toBe(false);
    });

    it('returns true when golfy hero marker exists', () => {
        const content = '<div class="wcap-hero-image"></div>';
        expect(contentHasTopHeroImage(content)).toBe(true);
    });
});

describe('contentHasTocBlock', () => {
    it('detects existing TOC class marker', () => {
        expect(contentHasTocBlock('<details class="wcap-toc">x</details>')).toBe(true);
    });

    it('returns false when TOC marker is absent', () => {
        expect(contentHasTocBlock('<p>no toc</p>')).toBe(false);
    });
});

// ─── buildHeroBlock ─────────────────────────────────────────────

describe('buildHeroBlock', () => {
    it('produces valid Gutenberg wp:image block', () => {
        const block = buildHeroBlock(42, 'https://example.com/hero.jpg', 'Golf hero');
        expect(block).toContain('<!-- wp:image');
        expect(block).toContain('"id":42');
        expect(block).toContain('"sizeSlug":"large"');
        expect(block).toContain('wcap-hero-image');
        expect(block).toContain('src="https://example.com/hero.jpg"');
        expect(block).toContain('alt="Golf hero"');
        expect(block).toContain('<!-- /wp:image -->');
    });

    it('escapes special characters in alt text', () => {
        const block = buildHeroBlock(1, 'https://x.com/a.jpg', 'golf "pro" <tips>');
        expect(block).toContain('&quot;');
        expect(block).toContain('&lt;');
        expect(block).not.toContain('"pro"');
    });
});

// ─── buildTocBlock ──────────────────────────────────────────────

describe('buildTocBlock', () => {
    it('produces valid TOC with correct classes', () => {
        const headings = [
            { level: 2 as const, text: 'First', id: 'first', existingId: false },
            { level: 3 as const, text: 'Sub', id: 'sub', existingId: false },
            { level: 2 as const, text: 'Third', id: 'third', existingId: false },
        ];
        const toc = buildTocBlock(headings);
        expect(toc).toContain('<!-- wp:html -->');
        expect(toc).toContain('wcap-toc');
        expect(toc).toContain('is-collapsible');
        expect(toc).toContain('wcap-toc__title');
        expect(toc).toContain('Mục lục');
        expect(toc).toContain('wcap-toc__nav');
        expect(toc).toContain('wcap-toc__list');
        expect(toc).toContain('<a href="#first">First</a>');
        expect(toc).toContain('<a href="#sub">Sub</a>');
        expect(toc).toContain('<a href="#third">Third</a>');
        expect(toc).toContain('<!-- /wp:html -->');
    });

    it('anchor links match heading IDs', () => {
        const headings = [
            { level: 2 as const, text: 'Abc', id: 'abc', existingId: false },
            { level: 2 as const, text: 'Def', id: 'def', existingId: false },
            { level: 2 as const, text: 'Ghi', id: 'ghi', existingId: false },
        ];
        const toc = buildTocBlock(headings);
        for (const h of headings) {
            expect(toc).toContain(`href="#${h.id}"`);
        }
    });
});

// ─── injectHeadingIds ───────────────────────────────────────────

describe('injectHeadingIds', () => {
    it('adds id attribute to headings without one', () => {
        const content = '<h2>Section One</h2><h3>Sub Section</h3>';
        const headings = parseHeadings(content);
        const result = injectHeadingIds(content, headings);
        expect(result).toContain('id="section-one"');
        expect(result).toContain('id="sub-section"');
    });

    it('preserves existing id attributes', () => {
        const content = '<h2 id="keep-me">Heading</h2>';
        const headings = parseHeadings(content);
        const result = injectHeadingIds(content, headings);
        expect(result).toContain('id="keep-me"');
        expect(result).not.toContain('id="heading"');
    });

    it('does not modify content if all headings have ids', () => {
        const content = '<h2 id="a">A</h2><h3 id="b">B</h3>';
        const headings = parseHeadings(content);
        const result = injectHeadingIds(content, headings);
        expect(result).toBe(content);
    });
});

// ─── enrichContent — Hero Injection ─────────────────────────────

describe('enrichContent — Hero', () => {
    it('injects hero when wpMediaId exists and content has no image', () => {
        const content = '<h2>A</h2><p>text</p><h2>B</h2><p>text</p><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 10,
            sourceUrl: 'https://example.com/hero.jpg',
            altText: 'Hero',
        });
        expect(result.heroInjected).toBe(true);
        expect(result.content).toContain('<!-- wp:image');
        expect(result.content).toContain('wcap-hero-image');
        expect(result.content).toContain('"id":10');
    });

    it('does NOT inject hero when content already has <img>', () => {
        const content = '<img src="existing.jpg"/><h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 10,
            sourceUrl: 'https://example.com/hero.jpg',
            altText: 'Hero',
        });
        expect(result.heroInjected).toBe(false);
        // Only one img should exist (the original)
        expect(result.content).not.toContain('wcap-hero-image');
    });

    it('does NOT inject hero when content has wp:image block', () => {
        const content = '<!-- wp:image {"id":5} --><figure><img src="x.jpg"/></figure><!-- /wp:image --><h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 10,
            sourceUrl: 'https://example.com/hero.jpg',
            altText: 'Hero',
        });
        expect(result.heroInjected).toBe(false);
    });

    it('does NOT inject hero when no wpMediaId', () => {
        const content = '<h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, {});
        expect(result.heroInjected).toBe(false);
    });

    it('does NOT inject hero when no sourceUrl', () => {
        const content = '<h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, { wpMediaId: 10 });
        expect(result.heroInjected).toBe(false);
    });
});

// ─── enrichContent — TOC Injection ──────────────────────────────

describe('enrichContent — TOC', () => {
    it('injects TOC when >= 3 H2/H3 headings', () => {
        const content = '<h2>First</h2><p>text</p><h3>Second</h3><p>text</p><h2>Third</h2>';
        const result = enrichContent(content, {});
        expect(result.tocInjected).toBe(true);
        expect(result.content).toContain('wcap-toc');
        expect(result.content).toContain('#first');
        expect(result.content).toContain('#second');
        expect(result.content).toContain('#third');
    });

    it('does NOT inject TOC when < 3 headings', () => {
        const content = '<h2>First</h2><p>text</p><h2>Second</h2>';
        const result = enrichContent(content, {});
        expect(result.tocInjected).toBe(false);
        expect(result.content).not.toContain('wcap-toc');
    });

    it('does NOT inject TOC when zero headings', () => {
        const content = '<p>no headings here</p>';
        const result = enrichContent(content, {});
        expect(result.tocInjected).toBe(false);
    });

    it('TOC links match injected heading IDs', () => {
        const content = '<h2>Alpha Beta</h2><p>t</p><h2>Gamma</h2><p>t</p><h2>Delta</h2>';
        const result = enrichContent(content, {});
        expect(result.tocInjected).toBe(true);
        // Verify heading IDs are injected
        expect(result.content).toContain('id="alpha-beta"');
        expect(result.content).toContain('id="gamma"');
        expect(result.content).toContain('id="delta"');
        // Verify TOC links match
        expect(result.content).toContain('href="#alpha-beta"');
        expect(result.content).toContain('href="#gamma"');
        expect(result.content).toContain('href="#delta"');
    });

    it('preserves existing heading anchors in TOC links', () => {
        const content = '<h2 id="custom-anchor">Topic</h2><h2>Two</h2><h2>Three</h2>';
        const result = enrichContent(content, {});
        expect(result.tocInjected).toBe(true);
        // custom-anchor preserved, TOC links to it
        expect(result.content).toContain('href="#custom-anchor"');
    });
});

// ─── enrichContent — Hero + TOC combined ────────────────────────

describe('enrichContent — Hero + TOC combined', () => {
    it('hero before TOC when both injected', () => {
        const content = '<h2>A</h2><p>t</p><h2>B</h2><p>t</p><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 42,
            sourceUrl: 'https://cdn.example.com/hero.webp',
            altText: 'Default hero',
        });
        expect(result.heroInjected).toBe(true);
        expect(result.tocInjected).toBe(true);

        const heroPos = result.content.indexOf('wcap-hero-image');
        const tocPos = result.content.indexOf('wcap-toc');
        expect(heroPos).toBeLessThan(tocPos);
    });

    it('no hero + TOC only works', () => {
        const content = '<h2>X</h2><p>t</p><h2>Y</h2><p>t</p><h2>Z</h2>';
        const result = enrichContent(content, {});
        expect(result.heroInjected).toBe(false);
        expect(result.tocInjected).toBe(true);
        expect(result.content).toContain('wcap-toc');
        expect(result.content).not.toContain('wcap-hero-image');
    });

    it('idempotent re-run: does not duplicate hero/TOC/heading ids', () => {
        const content = '<h2>Sec</h2><p>t</p><h2>Sec</h2><p>t</p><h2>Sec</h2>';
        const first = enrichContent(content, {
            wpMediaId: 9,
            sourceUrl: 'https://cdn.example.com/hero.webp',
            altText: 'Hero',
        });
        const second = enrichContent(first.content, {
            wpMediaId: 9,
            sourceUrl: 'https://cdn.example.com/hero.webp',
            altText: 'Hero',
        });

        expect((second.content.match(/wcap-hero-image/g) || []).length).toBe(2); // class appears on block + figure only once hero
        expect((second.content.match(/class="wcap-toc is-collapsible"/g) || []).length).toBe(1);
        expect(second.content).toContain('id="sec"');
        expect(second.content).toContain('id="sec-2"');
        expect(second.content).toContain('id="sec-3"');
    });

    it('injects hero when only deep image exists (keeps top-hero requirement)', () => {
        const content = '<p>' + 'a'.repeat(2000) + '</p><img src="deep.jpg"/><h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 10,
            sourceUrl: 'https://example.com/hero.jpg',
            altText: 'Hero',
        });
        expect(result.heroInjected).toBe(true);
        expect(result.content.startsWith('<!-- wp:image')).toBe(true);
    });
});

// ─── Non-blocking behavior ──────────────────────────────────────

describe('enrichContent — non-blocking', () => {
    it('never throws — returns reasons on internal errors', () => {
        // Even with weird input, enrichContent should not throw
        expect(() => enrichContent('', {})).not.toThrow();
        expect(() => enrichContent(null as any, {})).not.toThrow();
        expect(() => enrichContent('<h2>A</h2><h2>B</h2><h2>C</h2>', { wpMediaId: NaN })).not.toThrow();
    });

    it('returns empty reasons on success', () => {
        const content = '<h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 1,
            sourceUrl: 'https://x.com/a.jpg',
            altText: 'alt',
        });
        expect(result.reasons).toEqual([]);
    });

    it('rejects unsafe media source URL and remains non-blocking', () => {
        const content = '<h2>A</h2><h2>B</h2><h2>C</h2>';
        const result = enrichContent(content, {
            wpMediaId: 1,
            sourceUrl: 'javascript:alert(1)',
            altText: 'alt',
        });
        expect(result.heroInjected).toBe(false);
        expect(result.reasons).toContain('hero_inject_failed');
    });
});

// ─── Gate Compatibility ─────────────────────────────────────────

describe('Gate compatibility — injected markup', () => {
    const BANNED_PATTERNS = [
        { name: 'script', regex: /<script[\s>]/i },
        { name: 'iframe', regex: /<iframe[\s>]/i },
        { name: 'object', regex: /<object[\s>]/i },
        { name: 'embed', regex: /<embed[\s>]/i },
        { name: 'form', regex: /<form[\s>]/i },
        { name: 'event handler', regex: /on\w+\s*=/i },
        { name: 'javascript:', regex: /javascript:/i },
    ];

    it('hero block does not trigger any G5 banned pattern', () => {
        const hero = buildHeroBlock(1, 'https://x.com/img.jpg', 'alt text');
        for (const { name, regex } of BANNED_PATTERNS) {
            expect(regex.test(hero), `hero should not trigger banned: ${name}`).toBe(false);
        }
    });

    it('TOC block does not trigger any G5 banned pattern', () => {
        const headings = [
            { level: 2 as const, text: 'A', id: 'a', existingId: false },
            { level: 2 as const, text: 'B', id: 'b', existingId: false },
            { level: 2 as const, text: 'C', id: 'c', existingId: false },
        ];
        const toc = buildTocBlock(headings);
        for (const { name, regex } of BANNED_PATTERNS) {
            expect(regex.test(toc), `TOC should not trigger banned: ${name}`).toBe(false);
        }
    });

    it('full enriched content does not trigger G5 banned patterns', () => {
        const content = '<h2>Section 1</h2><p>text</p><h2>Section 2</h2><p>text</p><h2>Section 3</h2>';
        const result = enrichContent(content, {
            wpMediaId: 5,
            sourceUrl: 'https://example.com/img.webp',
            altText: 'test',
        });
        for (const { name, regex } of BANNED_PATTERNS) {
            expect(regex.test(result.content), `enriched content should not trigger banned: ${name}`).toBe(false);
        }
    });
});
