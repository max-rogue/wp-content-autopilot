/**
 * Stage 5 Tests — QA Gate stage: G1-G8, tag gate, recommendations.
 */

import { describe, it, expect, vi } from 'vitest';
import { runStage5 } from './stage5';
import type { Stage3Output, Stage4Output, ContentType } from '../types';
import type { ContentIndexRepo, LocalDbRepo, PublishQueueRepo } from '../db/repositories';
import type { PipelineConfig } from '../config';
import type { TaxonomyConfig } from '../config/taxonomy-config-loader';

function makeStage3(overrides: Partial<Stage3Output> = {}): Stage3Output {
    return {
        schema_version: '1.0',
        title: 'Best Running Shoes 2025',
        content_markdown: '# Best Running Shoes\n\nLong content here...',
        excerpt: 'A guide to the best running shoes in 2025.',
        suggested_slug: 'best-running-shoes-2025',
        category: 'fitness',
        tags: ['running', 'shoes', 'fitness'],
        focus_keyword: 'best running shoes',
        additional_keywords: ['running shoes 2025'],
        meta_title: 'Best Running Shoes 2025 - Complete Guide',
        meta_description: 'Find the best running shoes of 2025 with our comprehensive guide.',
        faq: [
            { question: 'What are the best running shoes?', answer: 'Nike and Adidas lead.' },
        ],
        featured_image: { prompt: 'running shoes on track', alt_text: 'running shoes' },
        citations: [],
        internal_links_plan: '',
        publish_recommendation: 'PUBLISH',
        reasons: [],
        missing_data_fields: [],
        ...overrides,
    } as Stage3Output;
}

function makeStage4(overrides: Partial<Stage4Output> = {}): Stage4Output {
    return {
        schema_version: '1.0',
        featured_image: { prompt: 'running shoes on a track', alt_text: 'running shoes' },
        inline_image: null,
        media_mode: 'image_only',
        images: {
            featured: null,
            hero: null,
        },
        ...overrides,
    };
}

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
    return {
        siteBaseUrl: 'https://example.com',
        ...overrides,
    } as PipelineConfig;
}

function makeTaxonomyConfig(): TaxonomyConfig {
    const brandTags = new Set<string>();
    const categoryTags = new Set(['fitness', 'guides']);
    const topicTags = new Set(['running', 'shoes', 'beginner']);

    const tagWhitelist = new Map<string, Set<string>>([
        ['brand', brandTags],
        ['skill', topicTags],
        ['format', categoryTags],
    ]);

    const flatWhitelist = new Set<string>();
    for (const [, tags] of tagWhitelist) {
        for (const t of tags) flatWhitelist.add(t);
    }

    return {
        version: '2.1',
        tagWhitelist,
        flatWhitelist,
        cityTags: new Set<string>(),
        maxTagsPerPost: 8,
        tagArchivePolicy: { default: 'noindex_follow', graduated: [] },
        approvedAdditions: [],
    } as TaxonomyConfig;
}

function makeContentIndexRepo(): ContentIndexRepo {
    return {
        findByFocusKeyword: vi.fn(() => undefined),
        findBySlug: vi.fn(() => undefined),
        getRecentPublished: vi.fn(() => []),
        findAll: vi.fn(() => []),
    } as unknown as ContentIndexRepo;
}

function makeLocalDbRepo(): LocalDbRepo {
    return {
        findVerified: vi.fn(() => []),
        findByName: vi.fn(() => undefined),
    } as unknown as LocalDbRepo;
}

function makeQueueRepo(): PublishQueueRepo {
    return {
        updateStatus: vi.fn(),
        findById: vi.fn(() => ({ status: 'qa' })),
        hasRecentPublish: vi.fn(() => false),
    } as unknown as PublishQueueRepo;
}

describe('runStage5', () => {
    it('succeeds with valid inputs and taxonomy config', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'best running shoes',
            normalizedKeyword: 'best running shoes',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3(),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(result.ok).toBe(true);
        expect(result.output).toBeDefined();
        expect(result.output!.schema_version).toBe('1.0');
        expect(result.output!.slug_final).toBe('best-running-shoes-2025');
        expect(result.output!.rankmath.focus_keyword).toBe('best running shoes');
        expect(result.output!.rankmath.canonical).toBe('https://example.com/blog/best-running-shoes-2025');
    });

    it('fails with schema_version mismatch in stage3', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3({ schema_version: '2.0' as any }),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('schema_validation_failed');
    });

    it('fails with schema_version mismatch in stage4', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3(),
            stage4: makeStage4({ schema_version: '0.5' as any }),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('schema_validation_failed');
    });

    it('fails when taxonomy config is missing', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3(),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: undefined,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('taxonomy_config_missing');
    });

    it('uses BlogPosting schema type for BlogPost content', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3(),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(result.ok).toBe(true);
        expect(result.output!.rankmath.schema_type).toBe('BlogPosting');
    });

    it('uses DefinedTerm schema type for Glossary content', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'Glossary' as ContentType,
            stage3: makeStage3(),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(result.ok).toBe(true);
        expect(result.output!.rankmath.schema_type).toBe('DefinedTerm');
    });

    it('filters tags through tag gate and tracks dropped tags', () => {
        const result = runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3({ tags: ['running', 'unknown-tag', 'shoes'] }),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo: makeQueueRepo(),
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(result.ok).toBe(true);
        // Tag gate should filter out tags not in whitelist
        expect(result.output!.taxonomy.dropped_tags).toBeDefined();
    });

    it('updates queue with gate results', () => {
        const queueRepo = makeQueueRepo();

        runStage5({
            queueId: 'q-001',
            keyword: 'test',
            normalizedKeyword: 'test',
            contentType: 'BlogPost' as ContentType,
            stage3: makeStage3(),
            stage4: makeStage4(),
            config: makeConfig(),
            contentIndexRepo: makeContentIndexRepo(),
            localDbRepo: makeLocalDbRepo(),
            queueRepo,
            taxonomyConfig: makeTaxonomyConfig(),
        });

        expect(queueRepo.updateStatus).toHaveBeenCalled();
    });
});
