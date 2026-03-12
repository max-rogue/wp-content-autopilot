/**
 * Sitemap Fetcher Tests — T-10 Internal Links.
 * Tests XML parsing, slug humanization, cluster filtering, and error handling.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    humanizeSlug,
    parseSitemapXml,
    isSitemapIndex,
    urlToSlug,
    filterByCluster,
    fetchSitemapPairs,
} from './sitemap-fetcher';
import type { SitemapPair } from '../types';

// ── humanizeSlug ────────────────────────────────────────────────

describe('humanizeSlug', () => {
    it('converts simple slug to title case', () => {
        expect(humanizeSlug('/best-golf-clubs/')).toBe('Best Golf Clubs');
    });

    it('handles nested paths (uses last segment)', () => {
        expect(humanizeSlug('/hoc-golf/swing-tips/')).toBe('Swing Tips');
    });

    it('handles slug without slashes', () => {
        expect(humanizeSlug('golf-basics')).toBe('Golf Basics');
    });

    it('handles single-word slug', () => {
        expect(humanizeSlug('/golf/')).toBe('Golf');
    });

    it('handles empty slug', () => {
        expect(humanizeSlug('/')).toBe('');
    });
});

// ── parseSitemapXml ─────────────────────────────────────────────

describe('parseSitemapXml', () => {
    it('parses standard urlset sitemap', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://example.com/hoc-golf/</loc></url>
      <url><loc>https://example.com/san-golf/</loc></url>
      <url><loc>https://example.com/mua-sam/</loc></url>
    </urlset>`;

        const urls = parseSitemapXml(xml);
        expect(urls).toHaveLength(3);
        expect(urls[0]).toBe('https://example.com/hoc-golf/');
        expect(urls[1]).toBe('https://example.com/san-golf/');
        expect(urls[2]).toBe('https://example.com/mua-sam/');
    });

    it('returns empty array for empty XML', () => {
        expect(parseSitemapXml('')).toEqual([]);
    });

    it('returns empty array for XML without <loc> tags', () => {
        expect(parseSitemapXml('<root><item>test</item></root>')).toEqual([]);
    });

    it('handles whitespace in <loc> tags', () => {
        const xml = '<urlset><url><loc>  https://example.com/test/  </loc></url></urlset>';
        const urls = parseSitemapXml(xml);
        expect(urls[0]).toBe('https://example.com/test/');
    });
});

// ── isSitemapIndex ──────────────────────────────────────────────

describe('isSitemapIndex', () => {
    it('detects sitemapindex tag', () => {
        const xml = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/sitemap-post.xml</loc></sitemap></sitemapindex>';
        expect(isSitemapIndex(xml)).toBe(true);
    });

    it('returns false for regular urlset', () => {
        const xml = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>';
        expect(isSitemapIndex(xml)).toBe(false);
    });
});

// ── urlToSlug ───────────────────────────────────────────────────

describe('urlToSlug', () => {
    it('extracts path from full URL', () => {
        expect(urlToSlug('https://example.com/hoc-golf/swing-tips/')).toBe('/hoc-golf/swing-tips/');
    });

    it('handles URL without trailing slash', () => {
        expect(urlToSlug('https://example.com/hoc-golf')).toBe('/hoc-golf');
    });

    it('handles root URL', () => {
        expect(urlToSlug('https://example.com/')).toBe('/');
    });

    it('handles malformed URL gracefully', () => {
        const result = urlToSlug('not-a-url');
        expect(typeof result).toBe('string');
    });
});

// ── filterByCluster ─────────────────────────────────────────────

describe('filterByCluster', () => {
    const samplePairs: SitemapPair[] = [
        { slug: '/hoc-golf/swing-basics/', title: 'Swing Basics' },
        { slug: '/hoc-golf/putting-tips/', title: 'Putting Tips' },
        { slug: '/san-golf/long-bien/', title: 'Long Bien' },
        { slug: '/san-golf/phu-my/', title: 'Phu My' },
        { slug: '/mua-sam/gay-golf-tot-nhat/', title: 'Gay Golf Tot Nhat' },
        { slug: '/hoc-golf/grip-technique/', title: 'Grip Technique' },
        { slug: '/tin-tuc/tournament-2024/', title: 'Tournament 2024' },
        { slug: '/hoc-golf/bunker-shots/', title: 'Bunker Shots' },
        { slug: '/hoc-golf/driver-distance/', title: 'Driver Distance' },
        { slug: '/hoc-golf/iron-accuracy/', title: 'Iron Accuracy' },
    ];

    it('prioritizes same-cluster matches', () => {
        const result = filterByCluster(samplePairs, 'golf swing', 'hoc-golf', 5);
        expect(result.length).toBeLessThanOrEqual(5);
        // All hoc-golf items should be prioritized
        expect(result.some(p => p.slug.includes('/hoc-golf/'))).toBe(true);
    });

    it('falls back to keyword overlap when no cluster', () => {
        const result = filterByCluster(samplePairs, 'swing techniques', undefined, 5);
        // Should find "swing-basics" via keyword overlap
        expect(result.some(p => p.slug.includes('swing'))).toBe(true);
    });

    it('caps result at maxPairs', () => {
        const result = filterByCluster(samplePairs, 'golf', 'hoc-golf', 3);
        expect(result.length).toBeLessThanOrEqual(3);
    });

    it('caps result at default 20', () => {
        // Generate 30 pairs
        const manyPairs: SitemapPair[] = Array.from({ length: 30 }, (_, i) => ({
            slug: `/page-${i}/`,
            title: `Page ${i}`,
        }));
        const result = filterByCluster(manyPairs, 'golf', undefined);
        expect(result.length).toBeLessThanOrEqual(20);
    });

    it('returns empty array for empty input', () => {
        expect(filterByCluster([], 'golf', 'hoc-golf')).toEqual([]);
    });

    it('is deterministic — same inputs produce same outputs', () => {
        const result1 = filterByCluster(samplePairs, 'golf swing', 'hoc-golf', 5);
        const result2 = filterByCluster(samplePairs, 'golf swing', 'hoc-golf', 5);
        expect(result1).toEqual(result2);
    });
});

// ── fetchSitemapPairs ───────────────────────────────────────────

describe('fetchSitemapPairs', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns empty array on fetch failure (fail-open)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
        const result = await fetchSitemapPairs('https://example.com');
        expect(result).toEqual([]);
    });

    it('returns empty array on non-200 response', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: false, status: 404 }),
        );
        const result = await fetchSitemapPairs('https://example.com');
        expect(result).toEqual([]);
    });

    it('parses valid sitemap response into pairs', async () => {
        const sitemapXml = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://example.com/hoc-golf/swing/</loc></url>
      <url><loc>https://example.com/san-golf/review/</loc></url>
    </urlset>`;

        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(sitemapXml) }),
        );

        const result = await fetchSitemapPairs('https://example.com');
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ slug: '/hoc-golf/swing/', title: 'Swing' });
        expect(result[1]).toEqual({ slug: '/san-golf/review/', title: 'Review' });
    });

    it('deduplicates URLs by slug', async () => {
        const sitemapXml = `<urlset>
      <url><loc>https://example.com/golf-tips/</loc></url>
      <url><loc>https://example.com/golf-tips/</loc></url>
    </urlset>`;

        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(sitemapXml) }),
        );

        const result = await fetchSitemapPairs('https://example.com');
        expect(result).toHaveLength(1);
    });

    it('skips root path /', async () => {
        const sitemapXml = `<urlset>
      <url><loc>https://example.com/</loc></url>
      <url><loc>https://example.com/about/</loc></url>
    </urlset>`;

        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(sitemapXml) }),
        );

        const result = await fetchSitemapPairs('https://example.com');
        expect(result).toHaveLength(1);
        expect(result[0].slug).toBe('/about/');
    });
});
