/**
 * Unit tests for taxonomy module and taxonomy-sync service.
 * Ref: 01_ContentSpec §2 (categories, tags, gated tags, slug normalization).
 *
 * Tests:
 *   - Canonical categories list enforcement (no extra, no missing)
 *   - Tag whitelist enforcement + gated tag rule (≥3/60d)
 *   - Slug normalization stability
 *   - WP sync idempotency (mock wp-client)
 *   - Cluster → category mapping
 *   - City tags always skipped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    CANONICAL_CATEGORIES,
    CANONICAL_CATEGORY_SLUGS,
    TAG_WHITELIST,
    TAG_WHITELIST_GROUPS,
    CLUSTER_TO_CATEGORY,
    DEFAULT_FALLBACK_CATEGORY,
    normalizeSlug,
    resolveClusterCategory,
    isWhitelistedTag,
    isCanonicalCategory,
    evaluateGatedTags,
    resolveCategorySlug,
    getCanonicalCategoryName,
    stripDiacritics,
    normalizeForLookup,
    type KeywordCsvRow,
} from './taxonomy';
import { buildSyncPlan, parseKeywordCsv, executeTaxonomySync } from './taxonomy-sync';

// ═══════════════════════════════════════════════════════════════════
// §2.1 — Canonical Categories
// ═══════════════════════════════════════════════════════════════════

describe('Canonical Categories (§2.1)', () => {
    const EXPECTED_SLUGS = [
        'gay-golf',
        'golf-fitting',
        'hoc-golf',
        'san-golf',
        'shop-golf',
        'luat-golf',
        'golf-cong-nghe',
        'chi-phi-va-van-hoa',
        'suc-khoe-fitness',
        'du-lich-su-kien',
    ];

    it('should contain exactly 10 canonical categories', () => {
        expect(CANONICAL_CATEGORIES).toHaveLength(10);
    });

    it('should contain all required slugs', () => {
        const slugs = CANONICAL_CATEGORIES.map((c) => c.slug);
        for (const expected of EXPECTED_SLUGS) {
            expect(slugs).toContain(expected);
        }
    });

    it('should not contain any extra categories', () => {
        const slugs = CANONICAL_CATEGORIES.map((c) => c.slug);
        for (const slug of slugs) {
            expect(EXPECTED_SLUGS).toContain(slug);
        }
    });

    it('should have unique slugs', () => {
        const slugs = CANONICAL_CATEGORIES.map((c) => c.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('should have non-empty names', () => {
        for (const cat of CANONICAL_CATEGORIES) {
            expect(cat.name.length).toBeGreaterThan(0);
        }
    });

    it('isCanonicalCategory returns true for all canonical slugs', () => {
        for (const slug of EXPECTED_SLUGS) {
            expect(isCanonicalCategory(slug)).toBe(true);
        }
    });

    it('isCanonicalCategory returns false for unknown slugs', () => {
        expect(isCanonicalCategory('random-slug')).toBe(false);
        expect(isCanonicalCategory('golf-news')).toBe(false);
        expect(isCanonicalCategory('')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §2.2 — Tag Whitelist
// ═══════════════════════════════════════════════════════════════════

describe('Tag Whitelist (§2.2)', () => {
    it('should contain brand tags', () => {
        expect(TAG_WHITELIST.has('titleist')).toBe(true);
        expect(TAG_WHITELIST.has('taylormade')).toBe(true);
        expect(TAG_WHITELIST.has('callaway')).toBe(true);
        expect(TAG_WHITELIST.has('ping')).toBe(true);
        expect(TAG_WHITELIST.has('honma')).toBe(true);
        expect(TAG_WHITELIST.has('mizuno')).toBe(true);
        expect(TAG_WHITELIST.has('srixon')).toBe(true);
        expect(TAG_WHITELIST.has('cobra')).toBe(true);
        expect(TAG_WHITELIST.has('cleveland')).toBe(true);
        expect(TAG_WHITELIST.has('xxio')).toBe(true);
        expect(TAG_WHITELIST.has('pxg')).toBe(true);
    });

    it('should contain shaft brand tags', () => {
        expect(TAG_WHITELIST.has('fujikura')).toBe(true);
        expect(TAG_WHITELIST.has('graphite-design')).toBe(true);
        expect(TAG_WHITELIST.has('project-x')).toBe(true);
        expect(TAG_WHITELIST.has('kbs')).toBe(true);
        expect(TAG_WHITELIST.has('nippon')).toBe(true);
        expect(TAG_WHITELIST.has('mitsubishi')).toBe(true);
        expect(TAG_WHITELIST.has('ust-mamiya')).toBe(true);
        expect(TAG_WHITELIST.has('accra')).toBe(true);
    });

    it('should contain ball brand tags', () => {
        expect(TAG_WHITELIST.has('pro-v1')).toBe(true);
        expect(TAG_WHITELIST.has('tp5')).toBe(true);
        expect(TAG_WHITELIST.has('chrome-soft')).toBe(true);
        expect(TAG_WHITELIST.has('z-star')).toBe(true);
        expect(TAG_WHITELIST.has('tour-b')).toBe(true);
    });

    it('should contain skill/problem tags', () => {
        expect(TAG_WHITELIST.has('slice')).toBe(true);
        expect(TAG_WHITELIST.has('hook')).toBe(true);
        expect(TAG_WHITELIST.has('topping')).toBe(true);
        expect(TAG_WHITELIST.has('chunk')).toBe(true);
        expect(TAG_WHITELIST.has('putting')).toBe(true);
        expect(TAG_WHITELIST.has('chipping')).toBe(true);
        expect(TAG_WHITELIST.has('bunker')).toBe(true);
    });

    it('should contain handicap band tags', () => {
        expect(TAG_WHITELIST.has('hcp-0-9')).toBe(true);
        expect(TAG_WHITELIST.has('hcp-10-19')).toBe(true);
        expect(TAG_WHITELIST.has('hcp-20-36')).toBe(true);
    });

    it('should NOT contain city/province tags in static whitelist', () => {
        // City tags require verified local value — never in static whitelist
        expect(TAG_WHITELIST.has('ho-chi-minh')).toBe(false);
        expect(TAG_WHITELIST.has('ha-noi')).toBe(false);
        expect(TAG_WHITELIST.has('da-nang')).toBe(false);
    });

    it('isWhitelistedTag returns true for known tags', () => {
        expect(isWhitelistedTag('titleist')).toBe(true);
        expect(isWhitelistedTag('hcp-0-9')).toBe(true);
        expect(isWhitelistedTag('slice')).toBe(true);
    });

    it('isWhitelistedTag returns false for non-whitelist tags', () => {
        expect(isWhitelistedTag('random-tag')).toBe(false);
        expect(isWhitelistedTag('ho-chi-minh')).toBe(false);
    });

    it('should have no overlap between tag groups', () => {
        const allTags: string[] = [];
        for (const group of Object.values(TAG_WHITELIST_GROUPS)) {
            allTags.push(...group);
        }
        expect(new Set(allTags).size).toBe(allTags.length);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Slug Normalization
// ═══════════════════════════════════════════════════════════════════

describe('Slug Normalization', () => {
    it('should lowercase', () => {
        expect(normalizeSlug('Titleist')).toBe('titleist');
        expect(normalizeSlug('TaylorMade')).toBe('taylormade');
    });

    it('should trim whitespace', () => {
        expect(normalizeSlug('  titleist  ')).toBe('titleist');
    });

    it('should replace spaces with hyphens', () => {
        expect(normalizeSlug('hoc golf')).toBe('hoc-golf');
        expect(normalizeSlug('chi phi va van hoa')).toBe('chi-phi-va-van-hoa');
    });

    it('should replace underscores with hyphens', () => {
        expect(normalizeSlug('hcp_0_9')).toBe('hcp-0-9');
    });

    it('should collapse consecutive hyphens', () => {
        expect(normalizeSlug('golf--fitting')).toBe('golf-fitting');
        expect(normalizeSlug('a---b')).toBe('a-b');
    });

    it('should remove leading/trailing hyphens', () => {
        expect(normalizeSlug('-golf-')).toBe('golf');
        expect(normalizeSlug('--golf--')).toBe('golf');
    });

    it('should be stable (idempotent)', () => {
        const slugs = ['gay-golf', 'hcp-0-9', 'graphite-design', 'chi-phi-va-van-hoa'];
        for (const slug of slugs) {
            expect(normalizeSlug(slug)).toBe(slug);
            expect(normalizeSlug(normalizeSlug(slug))).toBe(slug);
        }
    });

    it('should handle empty string', () => {
        expect(normalizeSlug('')).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════
// §2.3 — Gated Tag Rule (≥3 planned articles within 60 days)
// ═══════════════════════════════════════════════════════════════════

describe('Gated Tag Rule (§2.3)', () => {
    const makeRow = (keyword: string, notes: string = ''): KeywordCsvRow => ({
        keyword,
        content_type: 'BlogPost',
        cluster: 'test',
        priority: '1',
        notes,
    });

    it('should qualify a tag that appears in ≥3 rows', () => {
        const rows: KeywordCsvRow[] = [
            makeRow('bài 1 về pga-tour'),
            makeRow('bài 2 về pga-tour'),
            makeRow('bài 3 về pga-tour'),
        ];
        const result = evaluateGatedTags(['pga-tour'], rows);
        expect(result.get('pga-tour')?.qualifies).toBe(true);
        expect(result.get('pga-tour')?.count).toBe(3);
    });

    it('should NOT qualify a tag that appears in <3 rows', () => {
        const rows: KeywordCsvRow[] = [
            makeRow('bài 1 về pga-tour'),
            makeRow('bài 2 về pga-tour'),
            makeRow('bài 3 về other topic'),
        ];
        const result = evaluateGatedTags(['pga-tour'], rows);
        expect(result.get('pga-tour')?.qualifies).toBe(false);
        expect(result.get('pga-tour')?.count).toBe(2);
    });

    it('should skip tags already in whitelist', () => {
        const rows: KeywordCsvRow[] = [
            makeRow('titleist review 1'),
            makeRow('titleist review 2'),
            makeRow('titleist review 3'),
        ];
        const result = evaluateGatedTags(['titleist'], rows);
        // titleist is whitelisted, so evaluateGatedTags skips it
        expect(result.has('titleist')).toBe(false);
    });

    it('should handle zero candidate tags', () => {
        const result = evaluateGatedTags([], []);
        expect(result.size).toBe(0);
    });

    it('should handle empty CSV rows', () => {
        const result = evaluateGatedTags(['new-tag'], []);
        expect(result.get('new-tag')?.qualifies).toBe(false);
        expect(result.get('new-tag')?.count).toBe(0);
    });

    it('should count notes matches too', () => {
        const rows: KeywordCsvRow[] = [
            makeRow('unrelated keyword 1', 'mentions custom-grip here'),
            makeRow('unrelated keyword 2', 'custom-grip testing'),
            makeRow('unrelated keyword 3', 'custom-grip review'),
        ];
        const result = evaluateGatedTags(['custom-grip'], rows);
        expect(result.get('custom-grip')?.qualifies).toBe(true);
        expect(result.get('custom-grip')?.count).toBe(3);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Cluster → Category Mapping
// ═══════════════════════════════════════════════════════════════════

describe('Cluster → Category Mapping', () => {
    it('should map all known clusters to canonical categories', () => {
        for (const [cluster, category] of Object.entries(CLUSTER_TO_CATEGORY)) {
            expect(CANONICAL_CATEGORY_SLUGS.has(category)).toBe(true);
        }
    });

    it('should map gậy golf clusters to gay-golf', () => {
        expect(resolveClusterCategory('gậy golf')).toEqual({ category: 'gay-golf', mapped: true });
        expect(resolveClusterCategory('brand gậy golf')).toEqual({ category: 'gay-golf', mapped: true });
        expect(resolveClusterCategory('bóng golf')).toEqual({ category: 'gay-golf', mapped: true });
    });

    it('should map learning clusters to hoc-golf', () => {
        expect(resolveClusterCategory('học golf')).toEqual({ category: 'hoc-golf', mapped: true });
        expect(resolveClusterCategory('handicap')).toEqual({ category: 'hoc-golf', mapped: true });
    });

    it('should use fallback for unknown clusters', () => {
        const result = resolveClusterCategory('totally-new-cluster');
        expect(result.mapped).toBe(false);
        expect(result.category).toBe(DEFAULT_FALLBACK_CATEGORY);
    });

    it('should have fallback as a canonical category', () => {
        expect(CANONICAL_CATEGORY_SLUGS.has(DEFAULT_FALLBACK_CATEGORY)).toBe(true);
    });

    it('should be case-insensitive via trim+lowercase', () => {
        expect(resolveClusterCategory('  Học Golf  ')).toEqual({
            category: 'hoc-golf',
            mapped: true,
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// CSV Parser
// ═══════════════════════════════════════════════════════════════════

describe('CSV Parser', () => {
    it('should parse keyword CSV with headers', () => {
        const csv = `keyword,content_type,cluster,priority,notes
bóng golf,BlogPost,bóng golf,3,category
golf fitting,BlogPost,golf fitting,1,head term`;
        const rows = parseKeywordCsv(csv);
        expect(rows).toHaveLength(2);
        expect(rows[0].keyword).toBe('bóng golf');
        expect(rows[0].cluster).toBe('bóng golf');
        expect(rows[1].keyword).toBe('golf fitting');
    });

    it('should handle empty CSV', () => {
        expect(parseKeywordCsv('')).toHaveLength(0);
    });

    it('should handle CSV with only headers', () => {
        expect(parseKeywordCsv('keyword,content_type\n')).toHaveLength(0);
    });

    it('should handle CRLF line endings', () => {
        const csv = 'keyword,content_type\r\ntest,BlogPost\r\n';
        const rows = parseKeywordCsv(csv);
        expect(rows).toHaveLength(1);
        expect(rows[0].keyword).toBe('test');
    });
});

// ═══════════════════════════════════════════════════════════════════
// Sync Plan Builder
// ═══════════════════════════════════════════════════════════════════

describe('Sync Plan Builder', () => {
    it('should mark existing categories as "exists"', () => {
        const existingCats = new Set(['gay-golf', 'hoc-golf']);
        const plan = buildSyncPlan(existingCats, new Set(), []);

        const gayGolf = plan.categories.find((c) => c.slug === 'gay-golf');
        const hocGolf = plan.categories.find((c) => c.slug === 'hoc-golf');
        const sanGolf = plan.categories.find((c) => c.slug === 'san-golf');

        expect(gayGolf?.action).toBe('exists');
        expect(hocGolf?.action).toBe('exists');
        expect(sanGolf?.action).toBe('create');
    });

    it('should mark existing tags as "exists"', () => {
        const existingTags = new Set(['titleist', 'slice']);
        const plan = buildSyncPlan(new Set(), existingTags, []);

        const titleist = plan.tags.find((t) => t.slug === 'titleist');
        const slice = plan.tags.find((t) => t.slug === 'slice');
        const taylormade = plan.tags.find((t) => t.slug === 'taylormade');

        expect(titleist?.action).toBe('exists');
        expect(slice?.action).toBe('exists');
        expect(taylormade?.action).toBe('create');
    });

    it('should include all 10 categories in plan', () => {
        const plan = buildSyncPlan(new Set(), new Set(), []);
        expect(plan.categories).toHaveLength(10);
    });

    it('should include all whitelist tags in plan', () => {
        const plan = buildSyncPlan(new Set(), new Set(), []);
        expect(plan.tags.length).toBe(TAG_WHITELIST.size);
    });
});

// ═══════════════════════════════════════════════════════════════════
// WP Sync Idempotency (Mock WpClient)
// ═══════════════════════════════════════════════════════════════════

describe('WP Sync Idempotency (mock wp-client)', () => {
    function createMockWpClient() {
        const createdCategories = new Map<string, { id: number; slug: string; name: string }>();
        const createdTags = new Map<string, { id: number; slug: string; name: string }>();
        let nextId = 100;

        return {
            listAllCategories: vi.fn(async () => [...createdCategories.values()]),
            listAllTags: vi.fn(async () => [...createdTags.values()]),
            findCategoryBySlug: vi.fn(async (slug: string) => {
                const cat = createdCategories.get(slug);
                return cat ? { id: cat.id, slug: cat.slug } : undefined;
            }),
            findTagBySlug: vi.fn(async (slug: string) => {
                const tag = createdTags.get(slug);
                return tag ? { id: tag.id, slug: tag.slug } : undefined;
            }),
            createCategory: vi.fn(async (slug: string, name: string) => {
                const existing = createdCategories.get(slug);
                if (existing) {
                    return { ok: true, id: existing.id, slug: existing.slug, created: false };
                }
                const id = nextId++;
                createdCategories.set(slug, { id, slug, name });
                return { ok: true, id, slug, created: true };
            }),
            createTag: vi.fn(async (slug: string, name: string) => {
                const existing = createdTags.get(slug);
                if (existing) {
                    return { ok: true, id: existing.id, slug: existing.slug, created: false };
                }
                const id = nextId++;
                createdTags.set(slug, { id, slug, name });
                return { ok: true, id, slug, created: true };
            }),
            _createdCategories: createdCategories,
            _createdTags: createdTags,
        };
    }

    it('should create all categories on first run', async () => {
        const mock = createMockWpClient();
        const { result } = await executeTaxonomySync(mock as any, []);

        expect(result.categoriesCreated).toBe(10);
        expect(result.categoriesExisting).toBe(0);
        expect(mock.createCategory).toHaveBeenCalledTimes(10);
    });

    it('should be idempotent — second run creates nothing', async () => {
        const mock = createMockWpClient();

        // First run
        await executeTaxonomySync(mock as any, []);

        // Second run — should find everything existing
        mock.listAllCategories.mockResolvedValue([...mock._createdCategories.values()]);
        mock.listAllTags.mockResolvedValue([...mock._createdTags.values()]);

        const { result: result2 } = await executeTaxonomySync(mock as any, []);

        expect(result2.categoriesCreated).toBe(0);
        expect(result2.categoriesExisting).toBe(10);
        expect(result2.tagsCreated).toBe(0);
        expect(result2.tagsExisting).toBe(TAG_WHITELIST.size);
    });

    it('should create all whitelist tags on first run', async () => {
        const mock = createMockWpClient();
        const { result } = await executeTaxonomySync(mock as any, []);

        expect(result.tagsCreated).toBe(TAG_WHITELIST.size);
        expect(result.tagsExisting).toBe(0);
    });

    it('should not create city tags', async () => {
        const mock = createMockWpClient();
        const { result } = await executeTaxonomySync(mock as any, []);

        // City tags should not be in created tags
        expect(mock._createdTags.has('ho-chi-minh')).toBe(false);
        expect(mock._createdTags.has('ha-noi')).toBe(false);
        expect(mock._createdTags.has('da-nang')).toBe(false);
    });

    it('should handle WP errors gracefully', async () => {
        const mock = createMockWpClient();
        // Make createCategory fail for one slug
        let callCount = 0;
        mock.createCategory.mockImplementation(async (slug: string, name: string) => {
            callCount++;
            if (slug === 'san-golf') {
                return { ok: false, created: false, error: 'WP error 500' };
            }
            const id = 200 + callCount;
            mock._createdCategories.set(slug, { id, slug, name });
            return { ok: true, id, slug, created: true };
        });

        const { result } = await executeTaxonomySync(mock as any, []);

        expect(result.categoriesFailed).toHaveLength(1);
        expect(result.categoriesFailed[0].slug).toBe('san-golf');
        expect(result.categoriesCreated).toBe(9);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Category Slug Resolution (display name → canonical slug)
// ═══════════════════════════════════════════════════════════════════

describe('Category Slug Resolution', () => {
    it('should resolve canonical slugs as-is', () => {
        expect(resolveCategorySlug('golf-cong-nghe')).toBe('golf-cong-nghe');
        expect(resolveCategorySlug('hoc-golf')).toBe('hoc-golf');
        expect(resolveCategorySlug('gay-golf')).toBe('gay-golf');
    });

    it('should resolve display names to canonical slugs', () => {
        expect(resolveCategorySlug('Golf Công Nghệ')).toBe('golf-cong-nghe');
        expect(resolveCategorySlug('Gậy Golf')).toBe('gay-golf');
        expect(resolveCategorySlug('Học Golf')).toBe('hoc-golf');
        expect(resolveCategorySlug('Sân Golf')).toBe('san-golf');
        expect(resolveCategorySlug('Du Lịch & Sự Kiện')).toBe('du-lich-su-kien');
    });

    it('BUG REGRESSION: name "Công Nghệ Golf" maps to slug "golf-cong-nghe" via cluster mapping', () => {
        // This is the exact bug: the LLM returned the display name in different order
        // The cluster map has key "golf công nghệ" → "golf-cong-nghe"
        expect(resolveCategorySlug('golf công nghệ')).toBe('golf-cong-nghe');
    });

    it('should resolve cluster names to canonical slugs', () => {
        expect(resolveCategorySlug('gậy golf')).toBe('gay-golf');
        expect(resolveCategorySlug('golf fitting')).toBe('golf-fitting');
        expect(resolveCategorySlug('luật golf')).toBe('luat-golf');
    });

    it('should be case-insensitive', () => {
        expect(resolveCategorySlug('GOLF CÔNG NGHỆ')).toBe('golf-cong-nghe');
        expect(resolveCategorySlug('golf-cong-nghe')).toBe('golf-cong-nghe');
    });

    it('should handle whitespace', () => {
        expect(resolveCategorySlug('  golf-cong-nghe  ')).toBe('golf-cong-nghe');
        expect(resolveCategorySlug('  Golf Công Nghệ  ')).toBe('golf-cong-nghe');
    });

    it('should return null for truly unknown inputs', () => {
        expect(resolveCategorySlug('random-category')).toBeNull();
        expect(resolveCategorySlug('tin tuc golf')).toBeNull();
        expect(resolveCategorySlug('')).toBeNull();
        expect(resolveCategorySlug('  ')).toBeNull();
    });

    it('BUG REGRESSION: "Công Nghệ Golf" (word-order variant) resolves to golf-cong-nghe', () => {
        expect(resolveCategorySlug('Công Nghệ Golf')).toBe('golf-cong-nghe');
    });

    it('should resolve all 10 canonical CANONICAL_CATEGORIES by name', () => {
        for (const cat of CANONICAL_CATEGORIES) {
            expect(resolveCategorySlug(cat.name)).toBe(cat.slug);
        }
    });

    it('should resolve all 10 canonical slugs by slug', () => {
        for (const cat of CANONICAL_CATEGORIES) {
            expect(resolveCategorySlug(cat.slug)).toBe(cat.slug);
        }
    });
});

describe('getCanonicalCategoryName', () => {
    it('should return display name for canonical slugs', () => {
        expect(getCanonicalCategoryName('golf-cong-nghe')).toBe('Golf Công Nghệ');
        expect(getCanonicalCategoryName('gay-golf')).toBe('Gậy Golf');
        expect(getCanonicalCategoryName('hoc-golf')).toBe('Học Golf');
    });

    it('should return undefined for non-canonical slugs', () => {
        expect(getCanonicalCategoryName('random-slug')).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════
// Normalization Helpers
// ═══════════════════════════════════════════════════════════════════

describe('stripDiacritics', () => {
    it('should strip Vietnamese tone marks', () => {
        expect(stripDiacritics('Công Nghệ')).toBe('Cong Nghe');
        expect(stripDiacritics('Gậy Golf')).toBe('Gay Golf');
        expect(stripDiacritics('Sân Golf')).toBe('San Golf');
        expect(stripDiacritics('Học Golf')).toBe('Hoc Golf');
    });

    it('should handle đ/Đ', () => {
        expect(stripDiacritics('Đường')).toBe('duong');
        expect(stripDiacritics('đ')).toBe('d');
    });

    it('should leave ASCII unchanged', () => {
        expect(stripDiacritics('golf fitting')).toBe('golf fitting');
        expect(stripDiacritics('abc123')).toBe('abc123');
    });

    it('should handle empty string', () => {
        expect(stripDiacritics('')).toBe('');
    });
});

describe('normalizeForLookup', () => {
    it('should lowercase, strip diacritics, collapse whitespace', () => {
        expect(normalizeForLookup('  Công  Nghệ   Golf  ')).toBe('cong nghe golf');
    });

    it('should replace & with va', () => {
        expect(normalizeForLookup('Du Lịch & Sự Kiện')).toBe('du lich va su kien');
        expect(normalizeForLookup('Sức Khỏe & Fitness')).toBe('suc khoe va fitness');
    });

    it('should remove punctuation', () => {
        expect(normalizeForLookup('chi-phi-va-van-hoa')).toBe('chi phi va van hoa');
    });

    it('should handle pure ASCII', () => {
        expect(normalizeForLookup('golf fitting')).toBe('golf fitting');
    });

    it('should handle empty', () => {
        expect(normalizeForLookup('')).toBe('');
    });
});

// ═══════════════════════════════════════════════════════════════════
// Alias-Based Category Resolution
// ═══════════════════════════════════════════════════════════════════

describe('Alias-Based Category Resolution', () => {
    it('resolves word-order variant: "Công Nghệ Golf" → golf-cong-nghe', () => {
        expect(resolveCategorySlug('Công Nghệ Golf')).toBe('golf-cong-nghe');
    });

    it('resolves diacritic-stripped form: "cong nghe golf" → golf-cong-nghe', () => {
        expect(resolveCategorySlug('cong nghe golf')).toBe('golf-cong-nghe');
    });

    it('resolves with extra whitespace: "  Công   Nghệ   Golf  " → golf-cong-nghe', () => {
        expect(resolveCategorySlug('  Công   Nghệ   Golf  ')).toBe('golf-cong-nghe');
    });

    it('resolves ampersand vs "và" equivalence', () => {
        expect(resolveCategorySlug('Du Lịch Và Sự Kiện')).toBe('du-lich-su-kien');
        expect(resolveCategorySlug('Sức Khỏe Và Fitness')).toBe('suc-khoe-fitness');
    });

    it('resolves reordered "Sự Kiện Du Lịch" → du-lich-su-kien', () => {
        expect(resolveCategorySlug('Sự Kiện Du Lịch')).toBe('du-lich-su-kien');
    });

    it('resolves all-caps variant', () => {
        expect(resolveCategorySlug('CÔNG NGHỆ GOLF')).toBe('golf-cong-nghe');
    });

    it('still resolves canon display names (no regression)', () => {
        for (const cat of CANONICAL_CATEGORIES) {
            expect(resolveCategorySlug(cat.name)).toBe(cat.slug);
        }
    });

    it('still resolves canon slugs (no regression)', () => {
        for (const cat of CANONICAL_CATEGORIES) {
            expect(resolveCategorySlug(cat.slug)).toBe(cat.slug);
        }
    });

    it('still returns null for truly unknown categories', () => {
        expect(resolveCategorySlug('tin tức golf')).toBeNull();
        expect(resolveCategorySlug('giải trí')).toBeNull();
        expect(resolveCategorySlug('xyz123')).toBeNull();
    });
});
