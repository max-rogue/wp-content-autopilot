/**
 * Sitemap Fetcher — T-10 Internal Links from Sitemap.
 * Ref: T-10 prompt contract.
 *
 * Responsibilities:
 *   1. Fetch sitemap.xml from SITE_BASE_URL and parse <loc> entries.
 *   2. Normalize into {slug, title} pairs (title humanized from slug).
 *   3. Filter by cluster/keyword relevance, capped at 20 pairs.
 *
 * Design decisions:
 *   - Simple regex XML parsing (sitemap <loc> tags are well-structured).
 *   - No new dependencies; uses built-in fetch().
 *   - Fail-open: fetch errors → empty array (feature is optional).
 *   - No network crawling — single HTTP GET to sitemap URL.
 */

import { logger } from '../logger';
import type { SitemapPair } from '../types';

const MAX_SITEMAP_PAIRS = 20;

/**
 * Humanize a URL slug segment into a readable title.
 * e.g. "/best-golf-clubs/" → "Best Golf Clubs"
 */
export function humanizeSlug(slug: string): string {
    const cleaned = slug.replace(/^\/|\/$/g, '');
    const lastSegment = cleaned.split('/').pop() || cleaned;
    return lastSegment
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Parse sitemap XML text into an array of URL strings.
 * Handles both sitemap index (<sitemapindex> with <sitemap><loc>) and
 * regular sitemap (<urlset> with <url><loc>).
 *
 * Returns raw URLs extracted from <loc> tags.
 */
export function parseSitemapXml(xml: string): string[] {
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
    const urls: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = locRegex.exec(xml)) !== null) {
        const url = match[1].trim();
        if (url) urls.push(url);
    }
    return urls;
}

/**
 * Check if a sitemap XML is a sitemap index (contains <sitemapindex> tag).
 */
export function isSitemapIndex(xml: string): boolean {
    return /<sitemapindex[\s>]/i.test(xml);
}

/**
 * Convert a full URL into a relative slug path.
 * e.g. "https://example.com/hoc-golf/best-clubs/" → "/hoc-golf/best-clubs/"
 */
export function urlToSlug(url: string): string {
    try {
        const parsed = new URL(url);
        return parsed.pathname;
    } catch {
        // If URL parsing fails, try to extract path manually
        const pathMatch = url.match(/https?:\/\/[^/]+(\/.*)/);
        return pathMatch ? pathMatch[1] : url;
    }
}

/**
 * Fetch sitemap pairs from the site base URL.
 * Fetches /sitemap.xml (or configurable path), parses into {slug, title} pairs.
 *
 * Fail-open: returns empty array on any error.
 * If sitemap is a sitemap index, fetches nested sitemaps (depth 1 only).
 *
 * @param siteBaseUrl - Base URL of the site (e.g. "https://example.com")
 * @param sitemapPath - Path to sitemap (default: "/sitemap.xml")
 * @param timeoutMs - Fetch timeout in milliseconds (default: 10000)
 */
export async function fetchSitemapPairs(
    siteBaseUrl: string,
    sitemapPath = '/sitemap.xml',
    timeoutMs = 10000,
): Promise<SitemapPair[]> {
    try {
        const mainUrl = `${siteBaseUrl.replace(/\/$/, '')}${sitemapPath}`;
        logger.info('SitemapFetcher: fetching sitemap', { url: mainUrl });

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let resp: Response;
        try {
            resp = await fetch(mainUrl, { signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }

        if (!resp.ok) {
            logger.warn('SitemapFetcher: fetch failed', { status: resp.status, url: mainUrl });
            return [];
        }

        const xml = await resp.text();
        let urls: string[];

        if (isSitemapIndex(xml)) {
            // Sitemap index: extract nested sitemap URLs, fetch each (depth=1)
            const nestedUrls = parseSitemapXml(xml);
            urls = [];
            for (const nestedUrl of nestedUrls.slice(0, 5)) {
                // Cap nested sitemaps to avoid excessive fetching
                try {
                    const nestedController = new AbortController();
                    const nestedTimer = setTimeout(() => nestedController.abort(), timeoutMs);
                    let nestedResp: Response;
                    try {
                        nestedResp = await fetch(nestedUrl, { signal: nestedController.signal });
                    } finally {
                        clearTimeout(nestedTimer);
                    }
                    if (nestedResp.ok) {
                        const nestedXml = await nestedResp.text();
                        urls.push(...parseSitemapXml(nestedXml));
                    }
                } catch {
                    // Skip failed nested sitemap
                    logger.warn('SitemapFetcher: nested sitemap fetch failed', { url: nestedUrl });
                }
            }
        } else {
            urls = parseSitemapXml(xml);
        }

        // Convert to pairs, dedup by slug
        const seen = new Set<string>();
        const pairs: SitemapPair[] = [];

        for (const url of urls) {
            const slug = urlToSlug(url);
            // Skip root path and already-seen slugs
            if (slug === '/' || seen.has(slug)) continue;
            seen.add(slug);
            pairs.push({
                slug,
                title: humanizeSlug(slug),
            });
        }

        logger.info('SitemapFetcher: parsed sitemap pairs', { count: pairs.length });
        return pairs;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('SitemapFetcher: error fetching sitemap', { error: msg });
        return [];
    }
}

/**
 * Filter sitemap pairs by cluster affinity and keyword relevance.
 * Deterministic: same inputs → same outputs (no randomness).
 *
 * Priority order:
 *   1. Same cluster (slug contains cluster slug)
 *   2. Keyword overlap (slug or title contains a word from focus keyword)
 *   3. Remaining pairs (alphabetical by slug for determinism)
 *
 * @param pairs - All sitemap pairs
 * @param focusKeyword - Current article's focus keyword
 * @param cluster - Current article's cluster (optional)
 * @param maxPairs - Maximum pairs to return (default: 20)
 */
export function filterByCluster(
    pairs: SitemapPair[],
    focusKeyword: string,
    cluster?: string,
    maxPairs = MAX_SITEMAP_PAIRS,
): SitemapPair[] {
    if (pairs.length === 0) return [];

    const keywordWords = focusKeyword
        .toLowerCase()
        .split(/[\s\-_]+/)
        .filter((w) => w.length > 2); // Skip short words

    const clusterSlug = cluster?.toLowerCase().replace(/[\s_]+/g, '-') || '';

    // Scoring function (higher = more relevant)
    function score(pair: SitemapPair): number {
        const slugLower = pair.slug.toLowerCase();
        const titleLower = pair.title.toLowerCase();
        let s = 0;

        // Cluster match: slug contains cluster name
        if (clusterSlug && slugLower.includes(clusterSlug)) {
            s += 10;
        }

        // Keyword word overlap
        for (const word of keywordWords) {
            if (slugLower.includes(word)) s += 3;
            if (titleLower.includes(word)) s += 2;
        }

        return s;
    }

    // Score and sort (descending score, then alphabetical slug for determinism)
    const scored = pairs.map((p) => ({ pair: p, score: score(p) }));
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.pair.slug.localeCompare(b.pair.slug);
    });

    return scored.slice(0, maxPairs).map((s) => s.pair);
}
