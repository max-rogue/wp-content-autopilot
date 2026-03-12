/**
 * Taxonomy constants and helpers.
 * SOURCE OF TRUTH: docs/spec/marketing/01_ContentSpec.md §2
 *
 * Canonical categories (§2.1): exactly 10 slugs.
 * Tag whitelist (§2.2): brand, shaft-brand, ball-brand, skill/problem, handicap-band.
 * City/province tags: only if verified local value exists (§2.2, §0.3).
 * Taxonomy gate (§2.3): new tag ≥3 planned articles within 60 days.
 *
 * No secrets in logs. No video logic. No hardcoded Rank Math keys.
 */

// ═══════════════════════════════════════════════════════════════════
// §2.1 — Canonical Categories
// ═══════════════════════════════════════════════════════════════════

export interface CanonicalCategory {
    slug: string;
    name: string;
}

/**
 * The 10 canonical category slugs, exactly as defined in 01_ContentSpec §2.1.
 * Names are Title Case Vietnamese for WP display.
 */
export const CANONICAL_CATEGORIES: readonly CanonicalCategory[] = [
    { slug: 'gay-golf', name: 'Gậy Golf' },
    { slug: 'golf-fitting', name: 'Golf Fitting' },
    { slug: 'hoc-golf', name: 'Học Golf' },
    { slug: 'san-golf', name: 'Sân Golf' },
    { slug: 'shop-golf', name: 'Shop Golf' },
    { slug: 'luat-golf', name: 'Luật Golf' },
    { slug: 'golf-cong-nghe', name: 'Golf Công Nghệ' },
    { slug: 'chi-phi-va-van-hoa', name: 'Chi Phí Và Văn Hóa' },
    { slug: 'suc-khoe-fitness', name: 'Sức Khỏe & Fitness' },
    { slug: 'du-lich-su-kien', name: 'Du Lịch & Sự Kiện' },
] as const;

export const CANONICAL_CATEGORY_SLUGS = new Set(
    CANONICAL_CATEGORIES.map((c) => c.slug)
);

// ═══════════════════════════════════════════════════════════════════
// §2.2 — Tag Whitelist (Controlled Vocabulary)
// ═══════════════════════════════════════════════════════════════════

/**
 * Tag groups per §2.2.
 * City/province tags are intentionally EXCLUDED from static whitelist.
 * They require verified local value which we do NOT auto-create.
 */
export const TAG_WHITELIST_GROUPS: Record<string, readonly string[]> = {
    brand: [
        'titleist',
        'taylormade',
        'callaway',
        'ping',
        'honma',
        'mizuno',
        'srixon',
        'cobra',
        'cleveland',
        'xxio',
        'pxg',
    ],
    shaft_brand: [
        'fujikura',
        'graphite-design',
        'project-x',
        'kbs',
        'nippon',
        'mitsubishi',
        'ust-mamiya',
        'accra',
    ],
    ball_brand: ['pro-v1', 'tp5', 'chrome-soft', 'z-star', 'tour-b'],
    skill_problem: [
        'slice',
        'hook',
        'topping',
        'chunk',
        'putting',
        'chipping',
        'bunker',
    ],
    handicap_band: ['hcp-0-9', 'hcp-10-19', 'hcp-20-36'],
};

/** Flat set of all whitelisted tag slugs. */
export const TAG_WHITELIST = new Set<string>(
    Object.values(TAG_WHITELIST_GROUPS).flat()
);

// ═══════════════════════════════════════════════════════════════════
// Cluster → Category Mapping (§2.1 mapping rule)
// ═══════════════════════════════════════════════════════════════════

/**
 * Maps keyword.csv cluster values → one of the 10 canonical category slugs.
 * Derived from inspecting actual cluster values in 04_Keyword.csv.
 *
 * DEFAULT FALLBACK: 'hoc-golf' (most general golf education category).
 */
export const CLUSTER_TO_CATEGORY: Record<string, string> = {
    // gậy golf family
    'gậy golf': 'gay-golf',
    'brand gậy golf': 'gay-golf',
    'brand authority': 'gay-golf',
    'bóng golf': 'gay-golf',
    'phụ kiện golf': 'gay-golf',
    'shaft & specs': 'gay-golf',
    'shaft brand': 'gay-golf',

    // fitting
    'golf fitting': 'golf-fitting',

    // learning
    'học golf': 'hoc-golf',
    handicap: 'hoc-golf',
    'kỹ thuật nâng cao': 'hoc-golf',

    // courses
    'sân golf': 'san-golf',
    'sân tập golf': 'san-golf',

    // shopping
    'shop golf': 'shop-golf',
    'thời trang golf': 'shop-golf',

    // rules
    'luật golf': 'luat-golf',

    // technology
    'golf công nghệ': 'golf-cong-nghe',

    // cost & culture
    'chi phí golf': 'chi-phi-va-van-hoa',
    'văn hóa golf': 'chi-phi-va-van-hoa',

    // health & fitness
    'fitness golf': 'suc-khoe-fitness',
    'sức khỏe golf': 'suc-khoe-fitness',

    // travel & events
    'du lịch golf': 'du-lich-su-kien',
    'sự kiện golf': 'du-lich-su-kien',
};

/** Default fallback category for unmapped clusters. */
export const DEFAULT_FALLBACK_CATEGORY = 'hoc-golf';

/**
 * Resolve a keyword.csv cluster to a canonical category slug.
 * Returns { category, mapped }. If mapped is false, logs a warning.
 */
export function resolveClusterCategory(cluster: string): {
    category: string;
    mapped: boolean;
} {
    const normalized = cluster.trim().toLowerCase();
    const match = CLUSTER_TO_CATEGORY[normalized];
    if (match) {
        return { category: match, mapped: true };
    }
    return { category: DEFAULT_FALLBACK_CATEGORY, mapped: false };
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
 * Evaluate gated tags: tags NOT in whitelist that appear in ≥3 planned articles
 * within a 60-day window. Since keyword.csv rows do not have explicit dates,
 * we count all rows with matching tags in notes/keyword as "within the window".
 *
 * §2.3: "≥3 planned articles within 60 days" → we interpret all CSV rows as
 * the current planned pipeline, so all rows count toward the 60-day window.
 *
 * Returns a map of tag slug → count of appearances.
 */
export function evaluateGatedTags(
    candidateTags: string[],
    csvRows: KeywordCsvRow[]
): Map<string, { count: number; qualifies: boolean }> {
    const result = new Map<string, { count: number; qualifies: boolean }>();
    const THRESHOLD = 3;

    for (const tag of candidateTags) {
        if (TAG_WHITELIST.has(tag)) continue; // already whitelisted, skip

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
    return TAG_WHITELIST.has(normalizeSlug(tagSlug));
}

/**
 * Validate that a category slug is canonical.
 */
export function isCanonicalCategory(slug: string): boolean {
    return CANONICAL_CATEGORY_SLUGS.has(normalizeSlug(slug));
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
 * Reverse lookup: category display name (lowercased) → canonical slug.
 * Built once from CANONICAL_CATEGORIES.
 */
const NAME_TO_SLUG = new Map<string, string>(
    CANONICAL_CATEGORIES.map((c) => [c.name.toLowerCase(), c.slug])
);

/**
 * Explicit alias dictionary: normalizeForLookup(alias) → canonical slug.
 *
 * Only contains safe, well-known display-name variants that map to one
 * of the 10 canonical slugs. No dynamic expansion.
 */
const CATEGORY_ALIASES: Record<string, string> = (() => {
    const aliases: Record<string, string> = {};
    const add = (raw: string, slug: string) => {
        aliases[normalizeForLookup(raw)] = slug;
    };

    // golf-cong-nghe: word-order variant
    add('Công Nghệ Golf', 'golf-cong-nghe');
    add('Golf Công Nghệ', 'golf-cong-nghe');
    add('cong nghe golf', 'golf-cong-nghe');

    // du-lich-su-kien: ampersand vs "và"
    add('Du Lịch Và Sự Kiện', 'du-lich-su-kien');
    add('Sự Kiện Du Lịch', 'du-lich-su-kien');
    add('du lich su kien', 'du-lich-su-kien');

    // suc-khoe-fitness: ampersand vs "và"
    add('Sức Khỏe Và Fitness', 'suc-khoe-fitness');
    add('suc khoe fitness', 'suc-khoe-fitness');

    // chi-phi-va-van-hoa: common truncations / reordering
    add('Chi Phí Golf', 'chi-phi-va-van-hoa');
    add('Văn Hóa Golf', 'chi-phi-va-van-hoa');
    add('chi phi van hoa', 'chi-phi-va-van-hoa');

    return aliases;
})();

/**
 * Sorted-token lookup: maps sorted normalizeForLookup tokens of each
 * canonical display name and cluster key to the canonical slug.
 * This catches arbitrary word-order permutations algorithmically.
 */
const SORTED_TOKEN_TO_SLUG = new Map<string, string>();

// Populate from canonical category names
for (const cat of CANONICAL_CATEGORIES) {
    const key = normalizeForLookup(cat.name).split(' ').sort().join(' ');
    if (!SORTED_TOKEN_TO_SLUG.has(key)) {
        SORTED_TOKEN_TO_SLUG.set(key, cat.slug);
    }
}
// Populate from cluster keys
for (const [cluster, slug] of Object.entries(CLUSTER_TO_CATEGORY)) {
    const key = normalizeForLookup(cluster).split(' ').sort().join(' ');
    if (!SORTED_TOKEN_TO_SLUG.has(key)) {
        SORTED_TOKEN_TO_SLUG.set(key, slug);
    }
}
// Populate from explicit aliases
for (const [normalized, slug] of Object.entries(CATEGORY_ALIASES)) {
    const key = normalized.split(' ').sort().join(' ');
    if (!SORTED_TOKEN_TO_SLUG.has(key)) {
        SORTED_TOKEN_TO_SLUG.set(key, slug);
    }
}

/**
 * Resolve any category input to a canonical slug.
 *
 * Resolution chain (first match wins):
 *   1. Canonical slug pass-through ("golf-cong-nghe")
 *   2. Display name exact match ("Golf Công Nghệ")
 *   3. Cluster name exact match ("golf công nghệ")
 *   4. Explicit alias dictionary (diacritic-stripped, normalized)
 *   5. Sorted-token algorithmic match (catches word-order permutations)
 *
 * Returns the canonical slug, or null if input is not resolvable.
 * This is the SINGLE entry-point Stage 6 should use.
 */
export function resolveCategorySlug(input: string): string | null {
    if (!input || !input.trim()) return null;

    const trimmed = input.trim();

    // 1. Already a canonical slug?
    const asSlug = normalizeSlug(trimmed);
    if (CANONICAL_CATEGORY_SLUGS.has(asSlug)) {
        return asSlug;
    }

    // 2. Display name match (case-insensitive)
    const lower = trimmed.toLowerCase();
    const fromName = NAME_TO_SLUG.get(lower);
    if (fromName) {
        return fromName;
    }

    // 3. Cluster → category mapping (case-insensitive, trimmed)
    const fromCluster = CLUSTER_TO_CATEGORY[lower];
    if (fromCluster) {
        return fromCluster;
    }

    // 4. Alias dictionary (normalized: stripped diacritics, collapsed ws, & → va)
    const normalized = normalizeForLookup(trimmed);
    const fromAlias = CATEGORY_ALIASES[normalized];
    if (fromAlias) {
        return fromAlias;
    }

    // 5. Sorted-token match (word-order permutations)
    const sortedKey = normalized.split(' ').sort().join(' ');
    const fromSorted = SORTED_TOKEN_TO_SLUG.get(sortedKey);
    if (fromSorted) {
        return fromSorted;
    }

    // 6. Not resolvable — caller should HOLD
    return null;
}

/**
 * Get the canonical display name for a category slug.
 * Returns undefined if slug is not canonical.
 */
export function getCanonicalCategoryName(slug: string): string | undefined {
    const entry = CANONICAL_CATEGORIES.find((c) => c.slug === slug);
    return entry?.name;
}
