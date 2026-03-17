/**
 * Unit tests for taxonomy module and taxonomy-sync service.
 * Ref: 01_ContentSpec §2 (categories, tags, gated tags, slug normalization).
 *
 * These tests verify the config-loading mechanism and generic behavior.
 * Niche-specific data is loaded from taxonomy_config.yaml — tests verify
 * the pipeline correctly loads and uses whatever config is present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    CANONICAL_CATEGORIES,
    CANONICAL_CATEGORY_SLUGS,
    TAG_WHITELIST,
    TAG_WHITELIST_GROUPS,
    CLUSTER_TO_CATEGORY,
    getDefaultFallbackCategory,
    getCanonicalCategories,
    getCanonicalCategorySlugs,
    getTagWhitelist,
    getClusterToCategory,
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
import { _resetTaxonomyConfigCache } from '../config/taxonomy-config-loader';

// Reset config cache before each test so tests don't interfere
beforeEach(() => {
    _resetTaxonomyConfigCache();
});

// ═══════════════════════════════════════════════════════════════════
// §2.1 — Canonical Categories (loaded from config)
// ═══════════════════════════════════════════════════════════════════

describe('Canonical Categories (§2.1)', () => {
    it('should load at least one category from config', () => {
        const categories = getCanonicalCategories();
        expect(categories.length).toBeGreaterThanOrEqual(1);
    });

    it('should have unique slugs', () => {
        const categories = getCanonicalCategories();
        const slugs = categories.map((c) => c.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('should have non-empty names', () => {
        const categories = getCanonicalCategories();
        for (const cat of categories) {
            expect(cat.name.length).toBeGreaterThan(0);
        }
    });

    it('isCanonicalCategory returns true for loaded category slugs', () => {
        const categories = getCanonicalCategories();
        for (const cat of categories) {
            expect(isCanonicalCategory(cat.slug)).toBe(true);
        }
    });

    it('isCanonicalCategory returns false for unknown slugs', () => {
        expect(isCanonicalCategory('random-slug-xyz')).toBe(false);
        expect(isCanonicalCategory('nonexistent-category')).toBe(false);
        expect(isCanonicalCategory('')).toBe(false);
    });

    it('CANONICAL_CATEGORIES proxy iterates correctly', () => {
        const categories = getCanonicalCategories();
        const proxied = [...CANONICAL_CATEGORIES];
        expect(proxied.length).toBe(categories.length);
        for (let i = 0; i < categories.length; i++) {
            expect(proxied[i].slug).toBe(categories[i].slug);
        }
    });

    it('CANONICAL_CATEGORY_SLUGS.has works', () => {
        const categories = getCanonicalCategories();
        for (const cat of categories) {
            expect(CANONICAL_CATEGORY_SLUGS.has(cat.slug)).toBe(true);
        }
        expect(CANONICAL_CATEGORY_SLUGS.has('nonexistent')).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════
// §2.2 — Tag Whitelist (loaded from config)
// ═══════════════════════════════════════════════════════════════════

describe('Tag Whitelist (§2.2)', () => {
    it('should load tags from config', () => {
        // Default config has at least category tags: guides, reviews, comparisons, glossary
        const whitelist = getTagWhitelist();
        expect(whitelist.size).toBeGreaterThan(0);
    });

    it('should contain tags from default config', () => {
        // Default taxonomy_config.yaml has these category tags
        expect(TAG_WHITELIST.has('guides')).toBe(true);
        expect(TAG_WHITELIST.has('reviews')).toBe(true);
        expect(TAG_WHITELIST.has('comparisons')).toBe(true);
    });

    it('should contain topic tags from default config', () => {
        expect(TAG_WHITELIST.has('beginner')).toBe(true);
        expect(TAG_WHITELIST.has('advanced')).toBe(true);
        expect(TAG_WHITELIST.has('tips')).toBe(true);
    });

    it('isWhitelistedTag returns true for known tags', () => {
        expect(isWhitelistedTag('guides')).toBe(true);
        expect(isWhitelistedTag('reviews')).toBe(true);
    });

    it('isWhitelistedTag returns false for non-whitelist tags', () => {
        expect(isWhitelistedTag('random-tag')).toBe(false);
        expect(isWhitelistedTag('nonexistent-tag')).toBe(false);
    });

    it('should have no overlap between tag groups', () => {
        const groups = Object.values(TAG_WHITELIST_GROUPS);
        const allTags: string[] = [];
        for (const group of groups) {
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
        expect(normalizeSlug('Brand-Alpha')).toBe('brand-alpha');
        expect(normalizeSlug('Brand-Beta')).toBe('brand-beta');
    });

    it('should trim whitespace', () => {
        expect(normalizeSlug('  titleist  ')).toBe('titleist');
    });

    it('should replace spaces with hyphens', () => {
        expect(normalizeSlug('my category')).toBe('my-category');
        expect(normalizeSlug('multi word slug here')).toBe('multi-word-slug-here');
    });

    it('should replace underscores with hyphens', () => {
        expect(normalizeSlug('hcp_0_9')).toBe('hcp-0-9');
    });

    it('should collapse consecutive hyphens', () => {
        expect(normalizeSlug('niche--service')).toBe('niche-service');
        expect(normalizeSlug('a---b')).toBe('a-b');
    });

    it('should remove leading/trailing hyphens', () => {
        expect(normalizeSlug('-niche-')).toBe('niche');
        expect(normalizeSlug('--niche--')).toBe('niche');
    });

    it('should be stable (idempotent)', () => {
        const slugs = ['my-slug', 'hcp-0-9', 'graphite-design', 'multi-word-slug'];
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
            makeRow('article 1 about industry-weekly'),
            makeRow('article 2 about industry-weekly'),
            makeRow('article 3 about industry-weekly'),
        ];
        const result = evaluateGatedTags(['industry-weekly'], rows);
        expect(result.get('industry-weekly')?.qualifies).toBe(true);
        expect(result.get('industry-weekly')?.count).toBe(3);
    });

    it('should NOT qualify a tag that appears in <3 rows', () => {
        const rows: KeywordCsvRow[] = [
            makeRow('article 1 about industry-weekly'),
            makeRow('article 2 about industry-weekly'),
            makeRow('article 3 about other topic'),
        ];
        const result = evaluateGatedTags(['industry-weekly'], rows);
        expect(result.get('industry-weekly')?.qualifies).toBe(false);
        expect(result.get('industry-weekly')?.count).toBe(2);
    });

    it('should skip tags already in whitelist', () => {
        const rows: KeywordCsvRow[] = [
            makeRow('guides review 1'),
            makeRow('guides review 2'),
            makeRow('guides review 3'),
        ];
        const result = evaluateGatedTags(['guides'], rows);
        // 'guides' is whitelisted in default config, so evaluateGatedTags skips it
        expect(result.has('guides')).toBe(false);
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
    it('should map all configured clusters to canonical categories', () => {
        const clusterMap = getClusterToCategory();
        const categorySlugs = getCanonicalCategorySlugs();
        for (const [_cluster, category] of Object.entries(clusterMap)) {
            expect(categorySlugs.has(category)).toBe(true);
        }
    });

    it('should use fallback for unknown clusters', () => {
        const result = resolveClusterCategory('totally-new-cluster');
        expect(result.mapped).toBe(false);
        expect(result.category).toBe(getDefaultFallbackCategory());
    });

    it('should have fallback as a canonical category', () => {
        expect(getCanonicalCategorySlugs().has(getDefaultFallbackCategory())).toBe(true);
    });

    it('should be case-insensitive via trim+lowercase', () => {
        // With default config (no cluster mappings), any cluster maps to fallback
        const fallback = getDefaultFallbackCategory();
        expect(resolveClusterCategory('  Some Cluster  ')).toEqual({
            category: fallback,
            mapped: false,
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// CSV Parser
// ═══════════════════════════════════════════════════════════════════

describe('CSV Parser', () => {
    it('should parse keyword CSV with headers', () => {
        const csv = `keyword,content_type,cluster,priority,notes
keyword1,BlogPost,cluster1,3,category
keyword2,BlogPost,cluster2,1,head term`;
        const rows = parseKeywordCsv(csv);
        expect(rows).toHaveLength(2);
        expect(rows[0].keyword).toBe('keyword1');
        expect(rows[0].cluster).toBe('cluster1');
        expect(rows[1].keyword).toBe('keyword2');
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
        const categories = getCanonicalCategories();
        if (categories.length === 0) return; // skip if no categories in config
        const existingCats = new Set([categories[0].slug]);
        const plan = buildSyncPlan(existingCats, new Set(), []);

        const first = plan.categories.find((c) => c.slug === categories[0].slug);
        expect(first?.action).toBe('exists');
    });

    it('should mark existing tags as "exists"', () => {
        const whitelist = getTagWhitelist();
        if (whitelist.size === 0) return;
        const firstTag = [...whitelist][0];
        const existingTags = new Set([firstTag]);
        const plan = buildSyncPlan(new Set(), existingTags, []);

        const tag = plan.tags.find((t) => t.slug === firstTag);
        expect(tag?.action).toBe('exists');
    });

    it('should include all configured categories in plan', () => {
        const plan = buildSyncPlan(new Set(), new Set(), []);
        expect(plan.categories).toHaveLength(getCanonicalCategories().length);
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
        const catCount = getCanonicalCategories().length;
        const { result } = await executeTaxonomySync(mock as any, []);

        expect(result.categoriesCreated).toBe(catCount);
        expect(result.categoriesExisting).toBe(0);
        expect(mock.createCategory).toHaveBeenCalledTimes(catCount);
    });

    it('should be idempotent — second run creates nothing', async () => {
        const mock = createMockWpClient();
        const catCount = getCanonicalCategories().length;
        const tagCount = getTagWhitelist().size;

        // First run
        await executeTaxonomySync(mock as any, []);

        // Second run — should find everything existing
        mock.listAllCategories.mockResolvedValue([...mock._createdCategories.values()]);
        mock.listAllTags.mockResolvedValue([...mock._createdTags.values()]);

        const { result: result2 } = await executeTaxonomySync(mock as any, []);

        expect(result2.categoriesCreated).toBe(0);
        expect(result2.categoriesExisting).toBe(catCount);
        expect(result2.tagsCreated).toBe(0);
        expect(result2.tagsExisting).toBe(tagCount);
    });

    it('should create all whitelist tags on first run', async () => {
        const mock = createMockWpClient();
        const tagCount = getTagWhitelist().size;
        const { result } = await executeTaxonomySync(mock as any, []);

        expect(result.tagsCreated).toBe(tagCount);
        expect(result.tagsExisting).toBe(0);
    });

    it('should handle WP errors gracefully', async () => {
        const mock = createMockWpClient();
        const categories = getCanonicalCategories();
        if (categories.length < 2) return; // need at least 2 categories to test

        const failSlug = categories[0].slug;
        let callCount = 0;
        mock.createCategory.mockImplementation(async (slug: string, name: string) => {
            callCount++;
            if (slug === failSlug) {
                return { ok: false, created: false, error: 'WP error 500' };
            }
            const id = 200 + callCount;
            mock._createdCategories.set(slug, { id, slug, name });
            return { ok: true, id, slug, created: true };
        });

        const { result } = await executeTaxonomySync(mock as any, []);

        expect(result.categoriesFailed).toHaveLength(1);
        expect(result.categoriesFailed[0].slug).toBe(failSlug);
        expect(result.categoriesCreated).toBe(categories.length - 1);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Category Slug Resolution
// ═══════════════════════════════════════════════════════════════════

describe('Category Slug Resolution', () => {
    it('should resolve canonical slugs as-is', () => {
        const categories = getCanonicalCategories();
        for (const cat of categories) {
            expect(resolveCategorySlug(cat.slug)).toBe(cat.slug);
        }
    });

    it('should resolve display names to canonical slugs', () => {
        const categories = getCanonicalCategories();
        for (const cat of categories) {
            expect(resolveCategorySlug(cat.name)).toBe(cat.slug);
        }
    });

    it('should return null for truly unknown inputs', () => {
        expect(resolveCategorySlug('random-category-xyz')).toBeNull();
        expect(resolveCategorySlug('nonexistent')).toBeNull();
        expect(resolveCategorySlug('')).toBeNull();
        expect(resolveCategorySlug('  ')).toBeNull();
    });

    it('should handle whitespace', () => {
        const categories = getCanonicalCategories();
        if (categories.length === 0) return;
        const cat = categories[0];
        expect(resolveCategorySlug(`  ${cat.slug}  `)).toBe(cat.slug);
    });

    it('should resolve all categories by name', () => {
        for (const cat of getCanonicalCategories()) {
            expect(resolveCategorySlug(cat.name)).toBe(cat.slug);
        }
    });

    it('should resolve all categories by slug', () => {
        for (const cat of getCanonicalCategories()) {
            expect(resolveCategorySlug(cat.slug)).toBe(cat.slug);
        }
    });
});

describe('getCanonicalCategoryName', () => {
    it('should return display name for canonical slugs', () => {
        const categories = getCanonicalCategories();
        for (const cat of categories) {
            expect(getCanonicalCategoryName(cat.slug)).toBe(cat.name);
        }
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
        expect(stripDiacritics('Sản Phẩm')).toBe('San Pham');
        expect(stripDiacritics('Cửa Hàng')).toBe('Cua Hang');
        expect(stripDiacritics('Học Nghề')).toBe('Hoc Nghe');
    });

    it('should handle đ/Đ', () => {
        expect(stripDiacritics('Đường')).toBe('duong');
        expect(stripDiacritics('đ')).toBe('d');
    });

    it('should leave ASCII unchanged', () => {
        expect(stripDiacritics('niche service')).toBe('niche service');
        expect(stripDiacritics('abc123')).toBe('abc123');
    });

    it('should handle empty string', () => {
        expect(stripDiacritics('')).toBe('');
    });
});

describe('normalizeForLookup', () => {
    it('should lowercase, strip diacritics, collapse whitespace', () => {
        expect(normalizeForLookup('  Công  Nghệ   Mới  ')).toBe('cong nghe moi');
    });

    it('should replace & with va', () => {
        expect(normalizeForLookup('Du Lịch & Sự Kiện')).toBe('du lich va su kien');
        expect(normalizeForLookup('Sức Khỏe & Fitness')).toBe('suc khoe va fitness');
    });

    it('should remove punctuation', () => {
        expect(normalizeForLookup('chi-phi-va-van-hoa')).toBe('chi phi va van hoa');
    });

    it('should handle pure ASCII', () => {
        expect(normalizeForLookup('niche service')).toBe('niche service');
    });

    it('should handle empty', () => {
        expect(normalizeForLookup('')).toBe('');
    });
});
