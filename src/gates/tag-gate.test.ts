/**
 * Tag Gate Tests — deterministic whitelist filtering
 * Ref: 01_ContentSpec §2.2, 03_PublishingOps Stage 5 Tag Gate
 *
 * Tests:
 *   - Tag slug normalization (Vietnamese/Unicode → ASCII)
 *   - Whitelist intersection (accept/reject)
 *   - City tag rule (verified local required)
 *   - Priority-based cap (Brand > Skill > City > Format, max 8)
 *   - Gated expansion (non-whitelist → always dropped)
 *   - Empty tags → no error
 *   - Dropped tags logging
 */

import { describe, it, expect } from 'vitest';
import { normalizeTagSlug, runTagGate, type TagGateInput, type TagGateResult } from './tag-gate';
import type { TaxonomyConfig, TagGroupName } from '../config/taxonomy-config-loader';

function makeTaxonomyConfig(overrides?: Partial<TaxonomyConfig>): TaxonomyConfig {
    const brandTags = new Set(['brand-alpha', 'brand-beta', 'brand-gamma', 'brand-delta', 'brand-echo', 'brand-foxtrot',
        'brand-golf', 'brand-hotel', 'brand-india', 'brand-juliet', 'brand-kilo', 'brand-lima']);
    const skillTags = new Set(['skill-basic', 'skill-intermediate', 'skill-advanced', 'skill-expert', 'skill-pro', 'skill-master',
        'skill-speed', 'skill-precision']);
    const cityTags = new Set(['ho-chi-minh', 'ha-noi', 'da-nang', 'can-tho']);
    const formatTags = new Set(['buying-guide', 'comparison', 'review', 'glossary']);
    const technologyTags = new Set(['tech-sensor', 'tech-simulator', 'tech-monitor']);

    const tagWhitelist = new Map<TagGroupName, Set<string>>([
        ['brand', brandTags],
        ['skill', skillTags],
        ['city', cityTags],
        ['format', formatTags],
        ['technology', technologyTags],
    ]);

    const flatWhitelist = new Set<string>();
    for (const [, tags] of tagWhitelist) {
        for (const tag of tags) flatWhitelist.add(tag);
    }

    return {
        version: '2.3',
        tagWhitelist,
        flatWhitelist,
        cityTags,
        maxTagsPerPost: 8,
        tagArchivePolicy: { default: 'noindex_follow', graduated: [] },
        ...overrides,
    };
}

// ─── Slug Normalization ─────────────────────────────────────────

describe('normalizeTagSlug', () => {
    it('lowercases and trims', () => {
        expect(normalizeTagSlug(' Brand-Alpha ')).toBe('brand-alpha');
    });

    it('replaces spaces with hyphens', () => {
        expect(normalizeTagSlug('buying guide')).toBe('buying-guide');
    });

    it('strips Vietnamese diacritics → ASCII', () => {
        expect(normalizeTagSlug('Đà Nẵng')).toBe('da-nang');
        expect(normalizeTagSlug('Hồ Chí Minh')).toBe('ho-chi-minh');
    });

    it('handles đ/Đ explicitly', () => {
        expect(normalizeTagSlug('Đánh bóng')).toBe('danh-bong');
    });

    it('collapses multiple hyphens', () => {
        expect(normalizeTagSlug('tech---simulator')).toBe('tech-simulator');
    });

    it('removes non-alphanumeric chars', () => {
        expect(normalizeTagSlug('Pro V1®')).toBe('pro-v1');
    });

    it('returns empty string for empty input', () => {
        expect(normalizeTagSlug('')).toBe('');
        expect(normalizeTagSlug('   ')).toBe('');
    });
});

// ─── Whitelist Intersection ─────────────────────────────────────

describe('runTagGate — whitelist intersection', () => {
    it('accepts whitelisted tags', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['Brand-Alpha', 'skill-expert', 'buying-guide'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toContain('brand-alpha');
        expect(result.finalTags).toContain('skill-expert');
        expect(result.finalTags).toContain('buying-guide');
        expect(result.droppedTags).toHaveLength(0);
    });

    it('rejects non-whitelisted tags', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['random-tag', 'invented-topic'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toHaveLength(0);
        expect(result.droppedTags).toContain('random-tag');
        expect(result.droppedTags).toContain('invented-topic');
        expect(result.reasons).toContain('tag_policy_drop_nonwhitelist');
    });

    it('normalizes proposed tags before matching', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['BRAND-ALPHA', 'Buying Guide', 'Đà Nẵng'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: true,
        });

        expect(result.finalTags).toContain('brand-alpha');
        expect(result.finalTags).toContain('buying-guide');
        expect(result.finalTags).toContain('da-nang');
    });

    it('deduplicates tags by slug', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['Brand-Alpha', 'brand-alpha', 'BRAND-ALPHA'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toEqual(['brand-alpha']);
    });
});

// ─── City Rule ──────────────────────────────────────────────────

describe('runTagGate — city rule', () => {
    it('drops city tags when hasVerifiedLocalValue is false', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['ho-chi-minh', 'brand-alpha'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).not.toContain('ho-chi-minh');
        expect(result.droppedTags).toContain('ho-chi-minh');
        expect(result.finalTags).toContain('brand-alpha');
    });

    it('allows city tags when hasVerifiedLocalValue is true', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['ho-chi-minh', 'brand-alpha'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: true,
        });

        expect(result.finalTags).toContain('ho-chi-minh');
        expect(result.finalTags).toContain('brand-alpha');
    });
});

// ─── Priority Cap ───────────────────────────────────────────────

describe('runTagGate — priority cap', () => {
    it('caps at max_tags_per_post (8)', () => {
        const config = makeTaxonomyConfig({ maxTagsPerPost: 8 });
        const result = runTagGate({
            proposedTags: [
                'brand-alpha', 'brand-beta', 'brand-gamma', 'brand-delta',
                'brand-echo', 'brand-foxtrot', 'brand-golf', 'brand-hotel',
                'brand-india', 'brand-juliet', // 10 tags
            ],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toHaveLength(8);
        expect(result.droppedTags.length).toBeGreaterThan(0);
    });

    it('preserves priority order: Brand > Skill > City > Format', () => {
        const config = makeTaxonomyConfig({ maxTagsPerPost: 3 });
        const result = runTagGate({
            proposedTags: [
                'buying-guide', // format (lowest priority)
                'skill-basic',  // skill
                'brand-alpha',  // brand (highest priority)
                'ho-chi-minh',  // city
            ],
            taxonomyConfig: config,
            hasVerifiedLocalValue: true,
        });

        // Should keep brand, skill, and city (higher priority than format)
        expect(result.finalTags).toContain('brand-alpha');
        expect(result.finalTags).toContain('skill-basic');
        // Format should be dropped (lowest priority)
        expect(result.finalTags).not.toContain('buying-guide');
        expect(result.droppedTags).toContain('buying-guide');
    });

    it('no cap needed when <= max', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['brand-alpha', 'skill-expert'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toHaveLength(2);
        expect(result.droppedTags).toHaveLength(0);
    });
});

// ─── Gated Expansion ───────────────────────────────────────────

describe('runTagGate — gated expansion', () => {
    it('non-whitelist tag is always dropped (even with high planned count)', () => {
        const config = makeTaxonomyConfig();
        const plannedCounts = new Map([['new-brand', 5]]); // >= 3 threshold but NOT in whitelist

        const result = runTagGate({
            proposedTags: ['new-brand'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
            plannedTagCounts: plannedCounts,
        });

        // Per spec: human must add to whitelist first
        expect(result.finalTags).not.toContain('new-brand');
        expect(result.droppedTags).toContain('new-brand');
    });

    it('non-whitelist tag without planned count is dropped', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['unknown-tag'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).not.toContain('unknown-tag');
        expect(result.droppedTags).toContain('unknown-tag');
    });
});

// ─── Edge Cases ─────────────────────────────────────────────────

describe('runTagGate — edge cases', () => {
    it('empty proposedTags → empty output', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: [],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toHaveLength(0);
        expect(result.droppedTags).toHaveLength(0);
        expect(result.reasons).toHaveLength(0);
    });

    it('all tags dropped → includes tag_policy_drop_nonwhitelist reason', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['fake-tag-1', 'fake-tag-2'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toHaveLength(0);
        expect(result.reasons).toContain('tag_policy_drop_nonwhitelist');
    });

    it('handles null/undefined gracefully', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: undefined as any,
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toHaveLength(0);
        expect(result.droppedTags).toHaveLength(0);
    });

    it('mixed whitelisted and non-whitelisted tags', () => {
        const config = makeTaxonomyConfig();
        const result = runTagGate({
            proposedTags: ['brand-alpha', 'unknown-brand', 'skill-expert', 'random-skill'],
            taxonomyConfig: config,
            hasVerifiedLocalValue: false,
        });

        expect(result.finalTags).toContain('brand-alpha');
        expect(result.finalTags).toContain('skill-expert');
        expect(result.droppedTags).toContain('unknown-brand');
        expect(result.droppedTags).toContain('random-skill');
    });
});
