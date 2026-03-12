/**
 * Sitemap Snippet Builder — produces a compact prompt-context string
 * from SitemapPair[] data, bounded by URL count and character limits.
 *
 * Used by runner.ts to pass existing site URLs to Stage 3 so the LLM
 * can reference them in content. Whether the LLM uses the snippet is
 * controlled by prompts, NOT by pipeline logic.
 *
 * No gating by INTERNAL_LINKS_ENABLED or threshold here.
 */

import type { SitemapPair } from '../types';

/**
 * Build a compact sitemap snippet string suitable for LLM prompt context.
 *
 * Format: one line per entry: "slug | title"
 * Bounded by maxUrls and maxChars.
 *
 * @param pairs - Full sitemap pairs (already parsed from sitemap.xml)
 * @param maxUrls - Maximum number of entries (default 20)
 * @param maxChars - Maximum total character length (default 4000)
 * @returns Compact multi-line string. Empty string if no pairs.
 */
export function buildSitemapSnippet(
    pairs: SitemapPair[],
    maxUrls = 20,
    maxChars = 4000,
): string {
    if (!pairs || pairs.length === 0) return '';

    const lines: string[] = [];
    let totalChars = 0;

    const capped = pairs.slice(0, maxUrls);

    for (const pair of capped) {
        const line = `${pair.slug} | ${pair.title}`;
        // Check if adding this line would exceed the char cap
        // Account for newline separator between lines
        const projected = totalChars + line.length + (lines.length > 0 ? 1 : 0);
        if (projected > maxChars) break;
        lines.push(line);
        totalChars = projected;
    }

    return lines.join('\n');
}
