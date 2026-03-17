/**
 * Taxonomy constants and helpers.
 *
 * All niche-specific data (categories, tags, cluster→category mapping)
 * is loaded from taxonomy_config.yaml via taxonomy-config-loader.ts.
 * This file contains only generic logic — no hardcoded niche references.
 *
 * No secrets in logs. No video logic. No hardcoded Rank Math keys.
 */

import { loadTaxonomyConfig } from '../config/taxonomy-config-loader';
import type { TaxonomyConfig, CategoryEntry } from '../config/taxonomy-config-loader';

// ═══════════════════════════════════════════════════════════════════
// §2.1 — Canonical Categories (loaded from config)
// ═══════════════════════════════════════════════════════════════════

export interface CanonicalCategory {
    slug: string;
    name: string;
}

/**
 * Get canonical categories from loaded config.
 * Returns a frozen copy for backward compatibility with code that
 * used the old CANONICAL_CATEGORIES constant.
 */
export function getCanonicalCategories(): readonly CanonicalCategory[] {
    const config = loadTaxonomyConfig();
    return config.categories;
}

/** Convenience: get canonical categories as a constant (lazy-loaded). */
export const CANONICAL_CATEGORIES: readonly CanonicalCategory[] = new Proxy(
    [] as CanonicalCategory[],
    {
        get(_target, prop) {
            const cats = getCanonicalCategories();
            if (prop === Symbol.iterator) {
                return function* () { yield* cats; };
            }
            if (prop === 'length') return cats.length;
            if (prop === 'map') return cats.map.bind(cats);
            if (prop === 'find') return cats.find.bind(cats);
            if (prop === 'filter') return cats.filter.bind(cats);
            if (prop === 'forEach') return cats.forEach.bind(cats);
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                return cats[parseInt(prop, 10)];
            }
            // Forward any other array accesses
            const val = (cats as unknown as Record<string | symbol, unknown>)[prop];
            return typeof val === 'function' ? (val as Function).bind(cats) : val;
        },
    }
);

export function getCanonicalCategorySlugs(): Set<string> {
    const config = loadTaxonomyConfig();
    return config.categorySlugs;
}

export const CANONICAL_CATEGORY_SLUGS = new Proxy(
    new Set<string>(),
    {
        get(_target, prop) {
            const slugs = getCanonicalCategorySlugs();
            if (prop === 'has') return slugs.has.bind(slugs);
            if (prop === 'size') return slugs.size;
            if (prop === Symbol.iterator) return slugs[Symbol.iterator].bind(slugs);
            const val = (slugs as unknown as Record<string | symbol, unknown>)[prop];
            return typeof val === 'function' ? (val as Function).bind(slugs) : val;
        },
    }
);

// ═══════════════════════════════════════════════════════════════════
// §2.2 — Tag Whitelist (loaded from config)
// ═══════════════════════════════════════════════════════════════════

/**
 * Get tag whitelist groups from loaded config.
 * Backward-compatible Record<string, readonly string[]> format.
 */
export function getTagWhitelistGroups(): Record<string, readonly string[]> {
    const config = loadTaxonomyConfig();
    const result: Record<string, string[]> = {};
    for (const [group, tags] of config.tagWhitelist) {
        result[group] = [...tags];
    }
    return result;
}

/** Backward-compatible constant via proxy. */
export const TAG_WHITELIST_GROUPS: Record<string, readonly string[]> = new Proxy(
    {} as Record<string, readonly string[]>,
    {
        get(_target, prop) {
            const groups = getTagWhitelistGroups();
            if (typeof prop === 'string') return groups[prop];
            return undefined;
        },
        ownKeys() {
            return Object.keys(getTagWhitelistGroups());
        },
        getOwnPropertyDescriptor(_target, prop) {
            const groups = getTagWhitelistGroups();
            if (typeof prop === 'string' && prop in groups) {
                return { configurable: true, enumerable: true, value: groups[prop] };
            }
            return undefined;
        },
    }
);

/** Flat set of all whitelisted tag slugs. */
export function getTagWhitelist(): Set<string> {
    const config = loadTaxonomyConfig();
    return config.flatWhitelist;
}

export const TAG_WHITELIST = new Proxy(
    new Set<string>(),
    {
        get(_target, prop) {
            const wl = getTagWhitelist();
            if (prop === 'has') return wl.has.bind(wl);
            if (prop === 'size') return wl.size;
            if (prop === Symbol.iterator) return wl[Symbol.iterator].bind(wl);
            const val = (wl as unknown as Record<string | symbol, unknown>)[prop];
            return typeof val === 'function' ? (val as Function).bind(wl) : val;
        },
    }
);

// ═══════════════════════════════════════════════════════════════════
// Cluster → Category Mapping (loaded from config)
// ═══════════════════════════════════════════════════════════════════

/**
 * Get cluster→category mapping from config.
 */
export function getClusterToCategory(): Record<string, string> {
    const config = loadTaxonomyConfig();
    return config.clusterToCategory;
}

/** Backward-compatible constant via proxy. */
export const CLUSTER_TO_CATEGORY: Record<string, string> = new Proxy(
    {} as Record<string, string>,
    {
        get(_target, prop) {
            if (typeof prop === 'string') {
                const map = getClusterToCategory();
                return map[prop];
            }
            return undefined;
        },
        ownKeys() {
            return Object.keys(getClusterToCategory());
        },
        getOwnPropertyDescriptor(_target, prop) {
            const map = getClusterToCategory();
            if (typeof prop === 'string' && prop in map) {
                return { configurable: true, enumerable: true, value: map[prop] };
            }
            return undefined;
        },
    }
);

/** Default fallback category from config. */
export function getDefaultFallbackCategory(): string {
    const config = loadTaxonomyConfig();
    return config.defaultFallbackCategory;
}


/**
 * Resolve a keyword.csv cluster to a canonical category slug.
 * Returns { category, mapped }. If mapped is false, means unmapped cluster.
 */
export function resolveClusterCategory(cluster: string): {
    category: string;
    mapped: boolean;
} {
    const config = loadTaxonomyConfig();
    const normalized = cluster.trim().toLowerCase();
    const match = config.clusterToCategory[normalized];
    if (match) {
        return { category: match, mapped: true };
    }
    return { category: config.defaultFallbackCategory, mapped: false };
}

// ═══════════════════════════════════════════════════════════════════
// Slug Normalization
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize a string to a WP-safe slug.
 * - Lowercase
 * - Trim
 * - Replace spaces/underscores with hyphens
 * - Collapse consecutive hyphens
 * - Remove trailing hyphens
 */
export function normalizeSlug(input: string): string {
    return input
        .toLowerCase()
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '');
}

// ═══════════════════════════════════════════════════════════════════
// §2.3 — Taxonomy Gate (Gated Tag Creation)
// ═══════════════════════════════════════════════════════════════════

export interface KeywordCsvRow {
    keyword: string;
    content_type: string;
    cluster: string;
    priority: string;
    notes: string;
    [key: string]: string;
}

/**
 * Evaluate gated tags: tags NOT in whitelist that appear in ≥3 planned articles.
 * Returns a map of tag slug → count of appearances.
 */
export function evaluateGatedTags(
    candidateTags: string[],
    csvRows: KeywordCsvRow[]
): Map<string, { count: number; qualifies: boolean }> {
    const result = new Map<string, { count: number; qualifies: boolean }>();
    const THRESHOLD = 3;
    const whitelist = getTagWhitelist();

    for (const tag of candidateTags) {
        if (whitelist.has(tag)) continue; // already whitelisted, skip

        const slug = normalizeSlug(tag);
        let count = 0;

        for (const row of csvRows) {
            const rowText = `${row.keyword} ${row.notes || ''}`.toLowerCase();
            if (rowText.includes(slug) || rowText.includes(tag.toLowerCase())) {
                count++;
            }
        }

        result.set(slug, { count, qualifies: count >= THRESHOLD });
    }

    return result;
}

/**
 * Check if a tag is in the whitelist.
 */
export function isWhitelistedTag(tagSlug: string): boolean {
    return getTagWhitelist().has(normalizeSlug(tagSlug));
}

/**
 * Validate that a category slug is canonical.
 */
export function isCanonicalCategory(slug: string): boolean {
    return getCanonicalCategorySlugs().has(normalizeSlug(slug));
}

// ═══════════════════════════════════════════════════════════════════
// Diacritic & Normalization Helpers (for alias matching)
// ═══════════════════════════════════════════════════════════════════

/**
 * Strip Vietnamese/Unicode diacritics from a string.
 * Uses NFD decomposition + removal of combining marks.
 */
export function stripDiacritics(s: string): string {
    // Vietnamese đ/Đ must be handled separately — NFD does not decompose them
    return s
        .replace(/[đĐ]/g, 'd')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Normalize a string for fuzzy category lookup:
 *  - lowercase
 *  - strip diacritics
 *  - replace '&' with 'va'
 *  - remove remaining punctuation (keep letters, digits, spaces)
 *  - collapse whitespace
 *  - trim
 */
export function normalizeForLookup(s: string): string {
    let n = s.toLowerCase();
    n = stripDiacritics(n);
    n = n.replace(/&/g, ' va ');
    n = n.replace(/[^a-z0-9\s]/g, ' ');
    n = n.replace(/\s+/g, ' ').trim();
    return n;
}

// ═══════════════════════════════════════════════════════════════════
// Category Resolution (display name / cluster → canonical slug)
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve any category input to a canonical slug.
 *
 * Resolution chain (first match wins):
 *   1. Canonical slug pass-through
 *   2. Display name exact match
 *   3. Cluster name exact match (from config cluster_to_category)
 *   4. Sorted-token algorithmic match (catches word-order permutations)
 *
 * Returns the canonical slug, or null if input is not resolvable.
 */
export function resolveCategorySlug(input: string): string | null {
    if (!input || !input.trim()) return null;

    const config = loadTaxonomyConfig();
    const trimmed = input.trim();

    // 1. Already a canonical slug?
    const asSlug = normalizeSlug(trimmed);
    if (config.categorySlugs.has(asSlug)) {
        return asSlug;
    }

    // 2. Display name match (case-insensitive)
    const lower = trimmed.toLowerCase();
    for (const cat of config.categories) {
        if (cat.name.toLowerCase() === lower) {
            return cat.slug;
        }
    }

    // 3. Cluster → category mapping (case-insensitive, trimmed)
    const fromCluster = config.clusterToCategory[lower];
    if (fromCluster) {
        return fromCluster;
    }

    // 4. Sorted-token match (word-order permutations)
    const normalized = normalizeForLookup(trimmed);
    const sortedKey = normalized.split(' ').sort().join(' ');

    // Build sorted-token lookup from categories and clusters
    for (const cat of config.categories) {
        const catKey = normalizeForLookup(cat.name).split(' ').sort().join(' ');
        if (catKey === sortedKey) return cat.slug;
    }
    for (const [cluster, slug] of Object.entries(config.clusterToCategory)) {
        const clusterKey = normalizeForLookup(cluster).split(' ').sort().join(' ');
        if (clusterKey === sortedKey) return slug;
    }

    // 5. Not resolvable — caller should HOLD
    return null;
}

/**
 * Get the canonical display name for a category slug.
 * Returns undefined if slug is not canonical.
 */
export function getCanonicalCategoryName(slug: string): string | undefined {
    const config = loadTaxonomyConfig();
    const entry = config.categories.find((c) => c.slug === slug);
    return entry?.name;
}
