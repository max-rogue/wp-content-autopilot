/**
 * Sitemap Snippet Builder Tests — buildSitemapSnippet
 * Validates URL cap, char cap, empty input, and boundary conditions.
 */

import { describe, it, expect } from 'vitest';
import { buildSitemapSnippet } from './sitemap-snippet';
import type { SitemapPair } from '../types';

function makePairs(count: number): SitemapPair[] {
    return Array.from({ length: count }, (_, i) => ({
        slug: `/category/article-${i + 1}/`,
        title: `Article ${i + 1}`,
    }));
}

describe('buildSitemapSnippet', () => {
    it('returns empty string for empty pairs array', () => {
        expect(buildSitemapSnippet([])).toBe('');
    });

    it('returns empty string for undefined-like input', () => {
        expect(buildSitemapSnippet(null as unknown as SitemapPair[])).toBe('');
    });

    it('builds snippet with all pairs when within caps', () => {
        const pairs = makePairs(3);
        const snippet = buildSitemapSnippet(pairs, 20, 4000);
        expect(snippet).toContain('/category/article-1/ | Article 1');
        expect(snippet).toContain('/category/article-2/ | Article 2');
        expect(snippet).toContain('/category/article-3/ | Article 3');
        expect(snippet.split('\n')).toHaveLength(3);
    });

    it('respects maxUrls cap', () => {
        const pairs = makePairs(30);
        const snippet = buildSitemapSnippet(pairs, 5, 10000);
        const lines = snippet.split('\n');
        expect(lines).toHaveLength(5);
    });

    it('respects maxChars cap', () => {
        const pairs = makePairs(100);
        // Each line ~35 chars: "/category/article-NN/ | Article NN"
        const snippet = buildSitemapSnippet(pairs, 100, 100);
        expect(snippet.length).toBeLessThanOrEqual(100);
        expect(snippet.length).toBeGreaterThan(0);
    });

    it('produces deterministic output for same input', () => {
        const pairs = makePairs(10);
        const a = buildSitemapSnippet(pairs, 20, 4000);
        const b = buildSitemapSnippet(pairs, 20, 4000);
        expect(a).toBe(b);
    });

    it('uses format: slug | title', () => {
        const pairs: SitemapPair[] = [
            { slug: '/guides/best-tools/', title: 'Best Tools' },
        ];
        const snippet = buildSitemapSnippet(pairs);
        expect(snippet).toBe('/guides/best-tools/ | Best Tools');
    });

    it('handles maxChars=0 gracefully', () => {
        const pairs = makePairs(5);
        const snippet = buildSitemapSnippet(pairs, 20, 0);
        expect(snippet).toBe('');
    });

    it('handles maxUrls=0 gracefully', () => {
        const pairs = makePairs(5);
        const snippet = buildSitemapSnippet(pairs, 0, 4000);
        expect(snippet).toBe('');
    });

    it('single pair just under char limit is included', () => {
        const pairs: SitemapPair[] = [
            { slug: '/a/', title: 'A' },
        ];
        const snippet = buildSitemapSnippet(pairs, 20, 10);
        // "/a/ | A" = 7 chars, under 10
        expect(snippet).toBe('/a/ | A');
    });

    it('second pair excluded if it would exceed char limit', () => {
        const pairs: SitemapPair[] = [
            { slug: '/a/', title: 'A' },       // 7 chars
            { slug: '/bb/', title: 'BB' },     // 9 chars + 1 newline = 17 total
        ];
        const snippet = buildSitemapSnippet(pairs, 20, 10);
        expect(snippet).toBe('/a/ | A');
        expect(snippet.split('\n')).toHaveLength(1);
    });
});
