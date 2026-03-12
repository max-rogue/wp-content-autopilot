/**
 * Stage 6 — Publisher
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.7
 * Ref: 03_PublishingOps.md Stage 6 — Tag Attachment Rules
 * Ref: 01_ContentSpec.md §2.2 — Option B: Whitelist + Gated Expansion
 *
 * Publish Posture (runtime-configurable via PUBLISH_POSTURE env):
 *   - auto_publish (DEFAULT): publishes when upstream recommendation=PUBLISH and all WP checks pass
 *   - always_draft (operator override): creates/updates WP draft only → final_status=draft_wp
 *
 * Fail-closed: if WP create/update not 2xx or wp_post_id invalid → do NOT set draft_wp.
 *
 * auto_publish fail-closed WP:
 *   - Only set final_status="published" if WP returns 2xx AND wp_post_id>0
 *     AND a follow-up GET confirms post status is "publish".
 *   - If publish attempt fails → keep/rollback to draft_wp + reason "publish_failed".
 *
 * Tag attachment (MUST — idempotent):
 *   - Only attach tags that already exist in WordPress (verified by slug lookup)
 *   - If tag slug not found in WP → skip, log as wp_tag_not_found[]
 *   - NEVER create tags in WP at Stage 6
 *   - Tag attachment is idempotent: re-run doesn't duplicate
 *
 * Invariant: status draft_wp/published ONLY if wp_post_id > 0 AND WP REST returned 2xx.
 */

import { SCHEMA_VERSION } from '../types';
import type { Stage3Output, Stage3_5Output, Stage4Output, Stage5Output, Stage6Output } from '../types';
import type { WpClient } from '../services/wp-client';
import type { RankMathService, RankMathMeta } from '../services/rankmath';
import type { PublishQueueRepo, ContentIndexRepo } from '../db/repositories';
import type { PipelineConfig } from '../config';
import { logger } from '../logger';
import { resolveCategorySlug, getCanonicalCategoryName, isCanonicalCategory, CANONICAL_CATEGORY_SLUGS } from '../services/taxonomy';
import { enrichContent, parseHeadings } from '../services/content-enrichment';
import crypto from 'crypto';

export interface Stage6Input {
  queueId: string;
  stage3: Stage3Output;
  /** Stage 3.5 HTML composer output (optional). When content_html is non-empty, HTML-first is used. */
  stage3_5?: Stage3_5Output;
  stage4: Stage4Output;
  stage5: Stage5Output;
  config: PipelineConfig;
  wpClient: WpClient;
  rankMathService: RankMathService;
  queueRepo: PublishQueueRepo;
  contentIndexRepo: ContentIndexRepo;
  /** CSV canonical_category slug — highest-priority category source */
  csvCanonicalCategory?: string;
}

export interface Stage6Result {
  ok: boolean;
  output?: Stage6Output;
  failReason?: string;
}

export async function runStage6(input: Stage6Input): Promise<Stage6Result> {
  const {
    queueId,
    stage3,
    stage5,
    wpClient,
    rankMathService,
    queueRepo,
    contentIndexRepo,
    config,
    csvCanonicalCategory,
  } = input;

  const reasons: string[] = [];

  // ── Resolve canonical content: HTML-first from Stage 3.5, fallback to markdown ──
  const htmlContent = input.stage3_5?.html_artifact?.content_html;
  const contentSource: 'html' | 'markdown' = (htmlContent && htmlContent.trim().length > 0)
    ? 'html'
    : 'markdown';
  const resolvedContent = contentSource === 'html' ? htmlContent! : stage3.content_markdown;

  // Structured pre-resolve diagnostic (DEBUG_stage3_5_html_availability)
  logger.info('Stage 6: content source pre-resolve', {
    has_stage3_5: !!input.stage3_5,
    html_len: htmlContent?.length || 0,
    html_trim_len: htmlContent?.trim().length || 0,
    resolved_source: contentSource,
  });

  logger.info('Stage 6: content source resolved', {
    content_source: contentSource,
    content_length: resolvedContent.length,
    html_available: !!(htmlContent && htmlContent.trim().length > 0),
  });

  // Read posture from config — safe default enforced at config level
  const posture = config.publishPosture || 'auto_publish';

  // If recommendation is HOLD, do NOT create post (§6.3.7)
  if (stage5.publish_recommendation === 'HOLD') {
    queueRepo.updateStatus(queueId, 'hold', {
      fail_reasons: JSON.stringify(['gate_recommendation_hold']),
      gate_results: JSON.stringify(stage5.gate_results),
    });

    return {
      ok: true,
      output: {
        schema_version: SCHEMA_VERSION,
        queue_id: queueId,
        wp_post_id: 0,
        published_url: '',
        final_status: 'hold',
        rankmath_write_result: 'failed',
        verification_result: 'fail',
        content_index_upsert: 'failed',
        reasons: ['gate_recommendation_hold', ...stage5.reasons],
      },
    };
  }

  // Check idempotency: find existing draft by slug (§6.8)
  const existingPost = await wpClient.findBySlug(stage5.slug_final);
  let wpPostId: number | null = null;
  let publishedUrl = '';

  // ── Safety no-op for always_draft on already-published post ───────
  // Do not edit live content when posture=always_draft (§12 6.8 published conflict).
  if (
    posture === 'always_draft' &&
    existingPost.ok &&
    existingPost.data &&
    existingPost.data.status === 'publish'
  ) {
    logger.warn('Stage 6: always_draft + existing published post — no-op HOLD', {
      wp_post_id: existingPost.data.id,
      slug: existingPost.data.slug,
    });

    queueRepo.updateStatus(queueId, 'hold', {
      published_url: existingPost.data.link,
      published_wp_id: existingPost.data.id,
      fail_reasons: JSON.stringify(['idempotency_published_conflict']),
      gate_results: JSON.stringify(stage5.gate_results),
    });

    return {
      ok: true,
      output: {
        schema_version: SCHEMA_VERSION,
        queue_id: queueId,
        wp_post_id: existingPost.data.id,
        published_url: existingPost.data.link,
        final_status: 'hold',
        rankmath_write_result: 'failed',
        verification_result: 'fail',
        content_index_upsert: 'failed',
        reasons: ['idempotency_published_conflict'],
      },
    };
  }

  // ── Idempotency short-circuit for auto_publish ──────────────────
  // If auto_publish + existing post is already published → idempotent no-op
  if (
    posture === 'auto_publish' &&
    existingPost.ok &&
    existingPost.data &&
    existingPost.data.status === 'publish'
  ) {
    logger.info('Stage 6: already published — idempotent no-op', {
      wp_post_id: existingPost.data.id,
    });

    // Update queue status to published (idempotent)
    queueRepo.updateStatus(queueId, 'published', {
      published_url: existingPost.data.link,
      published_wp_id: existingPost.data.id,
      gate_results: JSON.stringify(stage5.gate_results),
    });

    return {
      ok: true,
      output: {
        schema_version: SCHEMA_VERSION,
        queue_id: queueId,
        wp_post_id: existingPost.data.id,
        published_url: existingPost.data.link,
        final_status: 'published',
        rankmath_write_result: 'ok',
        verification_result: 'pass',
        content_index_upsert: 'ok',
        reasons: ['idempotent_already_published'],
      },
    };
  }

  // ── Category resolution — precedence chain (§2.1, §12 6.5) ─────
  // Priority: csv.canonical_category → stage5.taxonomy.category → stage3.category (label map) → HOLD
  let resolvedCategorySlug: string | null = null;
  let categorySource: string = 'none';

  // 1. CSV canonical_category (highest priority — already a slug)
  if (csvCanonicalCategory && csvCanonicalCategory.trim()) {
    const csvSlug = csvCanonicalCategory.trim();
    if (isCanonicalCategory(csvSlug)) {
      resolvedCategorySlug = csvSlug;
      categorySource = 'csv_canonical_category';
    }
  }

  // 2. stage5.taxonomy.category (if it's already a canonical slug)
  if (!resolvedCategorySlug && stage5.taxonomy?.category) {
    const s5Cat = resolveCategorySlug(stage5.taxonomy.category);
    if (s5Cat) {
      resolvedCategorySlug = s5Cat;
      categorySource = 'stage5_taxonomy';
    }
  }

  // 3. stage3.category — resolve via label/cluster/alias map
  if (!resolvedCategorySlug && stage3.category) {
    const s3Cat = resolveCategorySlug(stage3.category);
    if (s3Cat) {
      resolvedCategorySlug = s3Cat;
      categorySource = 'stage3_category_resolved';
    }
  }

  // Log category resolution diagnostics (redacted-safe)
  logger.info('Stage 6: category resolution', {
    category_source: categorySource,
    category_slug_final: resolvedCategorySlug || 'NONE',
    raw_category: stage3.category ? stage3.category.slice(0, 60) : 'N/A',
  });

  if (!resolvedCategorySlug) {
    // Bounded diagnostics for HOLD
    const allowedSlugs = [...CANONICAL_CATEGORY_SLUGS].slice(0, 10);
    logger.error('Stage 6: category not canonical — HOLD', {
      raw_category: stage3.category ? stage3.category.slice(0, 60) : 'N/A',
      csv_canonical_category: csvCanonicalCategory || 'N/A',
      allowed_slugs: allowedSlugs,
    });
    queueRepo.updateStatus(queueId, 'hold', {
      fail_reasons: JSON.stringify(['category_not_canonical']),
    });
    return {
      ok: true,
      output: {
        schema_version: SCHEMA_VERSION,
        queue_id: queueId,
        wp_post_id: 0,
        published_url: '',
        final_status: 'hold',
        rankmath_write_result: 'failed',
        verification_result: 'fail',
        content_index_upsert: 'failed',
        reasons: ['category_not_canonical'],
      },
    };
  }

  // Lookup WP category by canonical slug
  let category = await wpClient.findCategoryBySlug(resolvedCategorySlug);

  // If not found in WP, auto-create idempotently with canonical (name, slug)
  if (!category) {
    const canonicalName = getCanonicalCategoryName(resolvedCategorySlug) || resolvedCategorySlug;
    logger.info('Stage 6: category not in WP — creating', { slug: resolvedCategorySlug, name: canonicalName });
    const createResult = await wpClient.createCategory(resolvedCategorySlug, canonicalName);
    if (createResult.ok && createResult.id) {
      category = { id: createResult.id, slug: createResult.slug || resolvedCategorySlug };
    } else {
      logger.error('Stage 6: category create failed — HOLD', { slug: resolvedCategorySlug });
      queueRepo.updateStatus(queueId, 'hold', {
        fail_reasons: JSON.stringify(['category_create_failed']),
      });
      return {
        ok: true,
        output: {
          schema_version: SCHEMA_VERSION,
          queue_id: queueId,
          wp_post_id: 0,
          published_url: '',
          final_status: 'hold',
          rankmath_write_result: 'failed',
          verification_result: 'fail',
          content_index_upsert: 'failed',
          reasons: ['category_create_failed'],
        },
      };
    }
  }

  // ── Tag Attachment (idempotent, no auto-create) ─────────────────
  // Use taxonomy-filtered tags from Stage 5, NOT raw stage3.tags
  const filteredTags = stage5.taxonomy?.tags || [];
  const tagIds: number[] = [];
  const wpTagNotFound: string[] = [];

  for (const tagSlug of filteredTags) {
    // Lookup WP tag by slug — DO NOT create if not found (§2.2, §Stage 6 rules)
    const found = await wpClient.findTagBySlug(tagSlug);
    if (found) {
      tagIds.push(found.id);
    } else {
      // Tag not found in WP — skip silently, record for review
      wpTagNotFound.push(tagSlug);
      logger.info('Stage 6: whitelisted tag not in WP — skipped', { tag: tagSlug });
    }
  }

  if (wpTagNotFound.length > 0) {
    reasons.push(`wp_tag_not_found: ${wpTagNotFound.join(', ')}`);
  }

  // ── Determine WP post status based on posture ──────────────────
  // always_draft: always 'draft'
  // auto_publish: 'draft' for DRAFT recommendation, 'publish' for PUBLISH recommendation
  const shouldPublish =
    posture === 'auto_publish' &&
    stage5.publish_recommendation === 'PUBLISH';

  const wpPostStatus: 'draft' | 'publish' = shouldPublish ? 'publish' : 'draft';

  if (existingPost.ok && existingPost.data) {
    // Update existing draft (idempotent)
    logger.info('Stage 6: updating existing post', {
      wp_post_id: existingPost.data.id,
      target_status: wpPostStatus,
    });
    const updateResult = await wpClient.updatePost(existingPost.data.id, {
      title: stage3.title,
      content: resolvedContent,
      excerpt: stage3.excerpt,
      status: wpPostStatus,
      categories: [category.id],
      tags: tagIds,
    });

    if (!updateResult.ok || !updateResult.data) {
      // FAIL-CLOSED: do NOT set draft_wp
      queueRepo.updateStatus(queueId, 'failed', {
        fail_reasons: JSON.stringify([
          `wp_update_failed: HTTP ${updateResult.status}`,
        ]),
      });
      return {
        ok: false,
        output: {
          schema_version: SCHEMA_VERSION,
          queue_id: queueId,
          wp_post_id: 0,
          published_url: '',
          final_status: 'failed',
          rankmath_write_result: 'failed',
          verification_result: 'fail',
          content_index_upsert: 'failed',
          reasons: [`wp_update_failed: HTTP ${updateResult.status}`],
        },
        failReason: 'wp_update_failed',
      };
    }

    wpPostId = updateResult.data.id;
    publishedUrl = updateResult.data.link;
  } else {
    // Create new post
    const createResult = await wpClient.createDraft({
      title: stage3.title,
      content: resolvedContent,
      excerpt: stage3.excerpt,
      slug: stage5.slug_final,
      status: wpPostStatus,
      categories: [category.id],
      tags: tagIds,
    });

    if (!createResult.ok || !createResult.data) {
      // FAIL-CLOSED: do NOT set draft_wp
      queueRepo.updateStatus(queueId, 'failed', {
        fail_reasons: JSON.stringify([
          `wp_create_failed: HTTP ${createResult.status}`,
        ]),
      });
      return {
        ok: false,
        output: {
          schema_version: SCHEMA_VERSION,
          queue_id: queueId,
          wp_post_id: 0,
          published_url: '',
          final_status: 'failed',
          rankmath_write_result: 'failed',
          verification_result: 'fail',
          content_index_upsert: 'failed',
          reasons: [`wp_create_failed: HTTP ${createResult.status}`],
        },
        failReason: 'wp_create_failed',
      };
    }

    wpPostId = createResult.data.id;
    publishedUrl = createResult.data.link;

    // Handle slug collision: WordPress may append -2 (§7.1)
    if (createResult.data.slug !== stage5.slug_final) {
      logger.warn('Stage 6: slug collision detected', {
        requested: stage5.slug_final,
        actual: createResult.data.slug,
      });
      reasons.push(`slug_collision: ${stage5.slug_final} → ${createResult.data.slug}`);
    }
  }

  // INVARIANT CHECK: wp_post_id must be > 0
  if (!wpPostId || wpPostId <= 0) {
    queueRepo.updateStatus(queueId, 'failed', {
      fail_reasons: JSON.stringify(['wp_post_id_invalid']),
    });
    return {
      ok: false,
      output: {
        schema_version: SCHEMA_VERSION,
        queue_id: queueId,
        wp_post_id: 0,
        published_url: '',
        final_status: 'failed',
        rankmath_write_result: 'failed',
        verification_result: 'fail',
        content_index_upsert: 'failed',
        featured_media_result: 'skipped',
        reasons: ['wp_post_id_invalid'],
      },
      failReason: 'wp_post_id_invalid',
    };
  }

  // ── Fail-closed publish verification (auto_publish only) ────────
  // §12 6.7: If we attempted to publish, verify via GET that WP set status='publish'.
  // If verification fails → active rollback to draft + noindex,follow (when supported).
  // If rollback fails → final_status='failed' with 'rollback_failed'.
  // NEVER claim final_status='published' in any verification-fail path.
  let publishConfirmed = false;
  let rollbackFailed = false;
  if (shouldPublish) {
    let verificationPassed = false;
    try {
      const verifyGet = await wpClient.getPost(wpPostId);
      if (verifyGet.ok && verifyGet.data && verifyGet.data.status === 'publish') {
        verificationPassed = true;
        publishConfirmed = true;
        logger.info('Stage 6: publish confirmed via GET', { wp_post_id: wpPostId });
      } else {
        logger.warn('Stage 6: publish NOT confirmed — initiating rollback', {
          wp_post_id: wpPostId,
          returned_status: verifyGet.data?.status || 'unknown',
        });
      }
    } catch (err) {
      // Network error on verification — fail-closed
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Stage 6: publish verification network error — initiating rollback', {
        wp_post_id: wpPostId,
        error: msg.slice(0, 200),
      });
    }

    // ── Active rollback on verification failure (§12 6.7, §13 6.3.7) ──
    if (!verificationPassed) {
      // Step 1: Rollback post status to 'draft'
      try {
        const rollbackResult = await wpClient.updatePost(wpPostId, { status: 'draft' } as any);
        if (rollbackResult.ok) {
          logger.info('Stage 6: rollback to draft succeeded', { wp_post_id: wpPostId });

          // Step 2: Apply noindex,follow when supported (Rank Math meta)
          if (rankMathService.isDiscovered()) {
            try {
              const noindexMeta: RankMathMeta = {
                focus_keyword: stage5.rankmath.focus_keyword,
                meta_title: stage5.rankmath.meta_title,
                meta_description: stage5.rankmath.meta_description,
                canonical: stage5.rankmath.canonical,
                robots: 'noindex,follow',
                schema_type: stage5.rankmath.schema_type,
              };
              const noindexResult = await rankMathService.writeMeta(wpPostId, noindexMeta);
              if (noindexResult.ok) {
                logger.info('Stage 6: noindex,follow applied after rollback', { wp_post_id: wpPostId });
              } else {
                reasons.push('noindex_apply_failed');
                logger.warn('Stage 6: noindex,follow write failed — rollback status still succeeded', {
                  wp_post_id: wpPostId,
                });
              }
            } catch (noindexErr) {
              reasons.push('noindex_apply_failed');
              logger.warn('Stage 6: noindex,follow error — rollback status still succeeded', {
                wp_post_id: wpPostId,
              });
            }
          } else {
            reasons.push('noindex_not_supported');
            logger.info('Stage 6: noindex,follow not applied — Rank Math keys not discovered', {
              wp_post_id: wpPostId,
            });
          }

          reasons.push('verification_failed_rolled_back');
        } else {
          // Rollback itself failed — §12 6.7: final_status='failed', never claim published
          rollbackFailed = true;
          reasons.push('rollback_failed');
          logger.error('Stage 6: rollback to draft FAILED — marking run failed', {
            wp_post_id: wpPostId,
            rollback_status: rollbackResult.status,
          });
        }
      } catch (rollbackErr) {
        // Network error during rollback — same as rollback failed
        rollbackFailed = true;
        reasons.push('rollback_failed');
        const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        logger.error('Stage 6: rollback network error — marking run failed', {
          wp_post_id: wpPostId,
          error: msg.slice(0, 200),
        });
      }
    }
  }

  // ── Featured Image Upload (non-blocking enrichment) ─────────────
  // Upload image bytes from Stage 4 and set as featured_media on the post.
  // Uses dual-image pipeline: images.featured takes priority over legacy image_result.
  // Failure is NON-BLOCKING (mirrors RankMath posture): draft_wp is preserved.
  let featuredMediaResult: 'ok' | 'failed' | 'skipped' = 'skipped';
  let wpMediaId: number | undefined;
  let wpMediaSourceUrl: string | undefined;

  const stage4 = input.stage4;

  // Resolve featured image bytes: prefer images.featured, fallback to legacy image_result
  const featuredImageBytes = stage4.images?.featured?.image_base64
    || stage4.image_result?.image_base64;
  const featuredImageMime = stage4.images?.featured?.mime
    || stage4.image_result?.mime_type
    || 'image/png';
  const featuredImageAlt = stage4.images?.featured?.alt_text
    || stage4.image_result?.alt_text
    || stage3.focus_keyword;

  if (featuredImageBytes) {
    try {
      // Decode base64 to Buffer and upload
      const imageBuffer = Buffer.from(featuredImageBytes, 'base64');
      const ext = featuredImageMime === 'image/jpeg' ? 'jpg' : featuredImageMime === 'image/webp' ? 'webp' : 'png';
      const filename = `featured-${stage5.slug_final}.${ext}`;

      const uploadResult = await wpClient.uploadMedia(
        imageBuffer,
        filename,
        featuredImageAlt,
        featuredImageMime
      );

      if (uploadResult.ok && uploadResult.data) {
        wpMediaId = uploadResult.data.id;
        wpMediaSourceUrl = uploadResult.data.source_url;

        // Set featured_media on the post
        const fmUpdate = await wpClient.updatePost(wpPostId, {
          featured_media: wpMediaId,
        } as any);

        if (fmUpdate.ok) {
          featuredMediaResult = 'ok';
          logger.info('Stage 6: featured image set', {
            wp_post_id: wpPostId,
            wp_media_id: wpMediaId,
            image_role: 'featured',
            featured_media_set: 'yes',
          });
        } else {
          // Update failed but draft still exists — non-blocking
          featuredMediaResult = 'failed';
          reasons.push('featured_media_update_failed');
          logger.warn('Stage 6: featured_media update failed — non-blocking', {
            wp_post_id: wpPostId,
            wp_media_id: wpMediaId,
            image_role: 'featured',
            featured_media_set: 'no',
          });
        }
      } else {
        // Media upload failed — non-blocking
        featuredMediaResult = 'failed';
        reasons.push('media_upload_failed');
        logger.warn('Stage 6: featured media upload failed — non-blocking', {
          wp_post_id: wpPostId,
          image_role: 'featured',
          featured_media_set: 'no',
        });
      }
    } catch (err) {
      // Catch-all for upload — non-blocking
      featuredMediaResult = 'failed';
      reasons.push('media_upload_failed');
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Stage 6: featured media upload error — non-blocking', {
        wp_post_id: wpPostId,
        error: msg.slice(0, 200),
        image_role: 'featured',
        featured_media_set: 'no',
      });
    }
  } else {
    logger.info('Stage 6: no featured image bytes from Stage 4 — skipping featured image', {
      wp_post_id: wpPostId,
      image_role: 'featured',
      featured_media_set: 'no',
    });
  }

  // ── Hero Image Upload (separate from featured) ─────────────────
  // Upload hero image bytes from Stage 4 images.hero.
  // Used for in-content hero block injection (NOT as featured_media).
  let heroMediaResult: 'ok' | 'failed' | 'skipped' = 'skipped';
  let wpHeroMediaId: number | undefined;
  let wpHeroMediaSourceUrl: string | undefined;

  const heroImageBytes = stage4.images?.hero?.image_base64;
  const heroImageMime = stage4.images?.hero?.mime || 'image/png';
  const heroImageAlt = stage4.images?.hero?.alt_text || stage3.focus_keyword;

  if (heroImageBytes) {
    try {
      const heroBuffer = Buffer.from(heroImageBytes, 'base64');
      const heroExt = heroImageMime === 'image/jpeg' ? 'jpg' : heroImageMime === 'image/webp' ? 'webp' : 'png';
      const heroFilename = `hero-${stage5.slug_final}.${heroExt}`;

      const heroUpload = await wpClient.uploadMedia(
        heroBuffer,
        heroFilename,
        heroImageAlt,
        heroImageMime
      );

      if (heroUpload.ok && heroUpload.data) {
        wpHeroMediaId = heroUpload.data.id;
        wpHeroMediaSourceUrl = heroUpload.data.source_url;
        heroMediaResult = 'ok';
        logger.info('Stage 6: hero image uploaded', {
          wp_post_id: wpPostId,
          wp_hero_media_id: wpHeroMediaId,
          image_role: 'hero',
        });
      } else {
        heroMediaResult = 'failed';
        reasons.push('hero_media_upload_failed');
        logger.warn('Stage 6: hero media upload failed — non-blocking', {
          wp_post_id: wpPostId,
          image_role: 'hero',
        });
      }
    } catch (err) {
      heroMediaResult = 'failed';
      reasons.push('hero_media_upload_failed');
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Stage 6: hero media upload error — non-blocking', {
        wp_post_id: wpPostId,
        error: msg.slice(0, 200),
        image_role: 'hero',
      });
    }
  } else {
    logger.info('Stage 6: no hero image bytes from Stage 4 — skipping hero upload', {
      wp_post_id: wpPostId,
      image_role: 'hero',
    });
  }

  // ── Content Enrichment: Hero Image + TOC (non-blocking) ──────
  // Hero injection uses the HERO image (not featured) when available.
  // Falls back to featured image if hero upload failed/skipped.
  // Idempotent guard: if hero block already exists, skip injection.
  let heroInjected = false;
  let tocInjected = false;
  try {
    // Prefer hero image for hero block, fallback to featured
    const enrichMediaId = (heroMediaResult === 'ok' && wpHeroMediaId)
      ? wpHeroMediaId
      : (featuredMediaResult === 'ok' && wpMediaId)
        ? wpMediaId
        : undefined;
    const enrichSourceUrl = (heroMediaResult === 'ok' && wpHeroMediaSourceUrl)
      ? wpHeroMediaSourceUrl
      : (featuredMediaResult === 'ok' && wpMediaSourceUrl)
        ? wpMediaSourceUrl
        : undefined;
    const enrichAltText = (heroMediaResult === 'ok')
      ? heroImageAlt
      : featuredImageAlt;

    const enrichResult = enrichContent(resolvedContent, {
      wpMediaId: enrichMediaId,
      sourceUrl: enrichSourceUrl,
      altText: enrichAltText,
    });

    heroInjected = enrichResult.heroInjected;
    tocInjected = enrichResult.tocInjected;
    if (enrichResult.reasons.length > 0) {
      reasons.push(...enrichResult.reasons);
    }

    // If content was enriched, update the WP post content
    if (heroInjected || tocInjected) {
      const contentUpdate = await wpClient.updatePost(wpPostId, {
        content: enrichResult.content,
      } as any);

      if (contentUpdate.ok) {
        // Diagnostic log for enrichment update — tracks content_source consistency
        const enrichHeadingCount = parseHeadings(enrichResult.content).length;
        logger.info('Stage 6: content enriched', {
          wp_post_id: wpPostId,
          content_source: contentSource,
          content_length: enrichResult.content.length,
          heading_count: enrichHeadingCount,
          toc_injected: tocInjected,
          hero_injected: heroInjected,
          hero_source: (heroMediaResult === 'ok') ? 'hero_image' : 'featured_image',
        });
      } else {
        // Content update failed — non-blocking, revert flags
        heroInjected = false;
        tocInjected = false;
        reasons.push('content_enrichment_update_failed');
        logger.warn('Stage 6: content enrichment update failed — non-blocking', {
          wp_post_id: wpPostId,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    heroInjected = false;
    tocInjected = false;
    reasons.push('content_enrichment_failed');
    logger.warn('Stage 6: content enrichment error — non-blocking', {
      wp_post_id: wpPostId,
      error: msg.slice(0, 200),
    });
  }

  // Write Rank Math meta
  // §6.7 Verification Failure Handling (Best Effort; Non-blocking):
  //   Rank Math verification failures do not change final_status when WP draft
  //   succeeded; they only add reasons[] (and optional enrichment status).
  let rankMathResult: 'ok' | 'failed' = 'failed';
  if (rankMathService.isDiscovered()) {
    const meta: RankMathMeta = {
      focus_keyword: stage5.rankmath.focus_keyword,
      meta_title: stage5.rankmath.meta_title,
      meta_description: stage5.rankmath.meta_description,
      canonical: stage5.rankmath.canonical,
      robots: stage5.rankmath.robots,
      schema_type: stage5.rankmath.schema_type,
    };

    const writeResult = await rankMathService.writeMeta(wpPostId, meta);
    rankMathResult = writeResult.ok ? 'ok' : 'failed';

    if (!writeResult.ok) {
      // NON-BLOCKING: RankMath write failure is enrichment-only (§6.7)
      // DO NOT rollback, DO NOT change final_status — only add reasons[]
      logger.warn('Stage 6: RankMath write failed — non-blocking enrichment failure', {
        wp_post_id: wpPostId,
        error_category: writeResult.error || 'unknown',
      });
      reasons.push('rankmath_write_failed');
    }

    // Verify meta (§6.7) — enrichment-only, non-blocking
    if (writeResult.ok) {
      const verify = await rankMathService.verifyMeta(wpPostId, meta);
      if (!verify.ok) {
        // NON-BLOCKING: verification failure only adds reasons[]
        logger.warn('Stage 6: RankMath verification failed — non-blocking', {
          wp_post_id: wpPostId,
          reason: verify.reason || 'unknown',
        });
        rankMathResult = 'failed';
        reasons.push('rankmath_verification_failed');
      }
    }
  } else {
    reasons.push('rankmath_keys_not_discovered — meta write skipped');
  }

  // ── Determine final status ─────────────────────────────────────
  // INVARIANT: draft_wp ONLY if wp_post_id > 0 and WP REST returned 2xx
  // 'published' ONLY if auto_publish + publish confirmed via GET
  // 'failed' if rollback failed (§12 6.7: never claim published)
  let finalStatus: 'draft_wp' | 'published' | 'failed';

  if (rollbackFailed) {
    // §12 6.7: If rollback fails, mark run 'failed' and MUST NOT claim published
    finalStatus = 'failed';
  } else if (shouldPublish && publishConfirmed) {
    finalStatus = 'published';
  } else {
    finalStatus = 'draft_wp';
  }

  // Upsert content_index
  let contentIndexResult: 'ok' | 'failed' = 'ok';
  try {
    const contentHash = crypto
      .createHash('sha256')
      .update(resolvedContent)
      .digest('hex');

    contentIndexRepo.upsert({
      wp_post_id: wpPostId,
      title: stage3.title,
      focus_keyword: stage3.focus_keyword,
      slug: stage5.slug_final,
      url: publishedUrl,
      category: stage3.category,
      tags: JSON.stringify(filteredTags), // Use filtered tags, not raw
      published_at: new Date().toISOString(),
      content_hash: contentHash,
      embedding: null,
      updated_at: new Date().toISOString(),
      similarity_score: null,
      similarity_band: null,
      gate_results: JSON.stringify(stage5.gate_results),
    });
  } catch (err) {
    contentIndexResult = 'failed';
    reasons.push('content_index_upsert_failed');
  }

  // Build dropped_tags from Stage 5 taxonomy
  const droppedTags = stage5.taxonomy?.dropped_tags || [];

  // Update queue status
  // INVARIANT: if status is 'failed', fail_reasons MUST be non-null/non-empty
  queueRepo.updateStatus(queueId, finalStatus, {
    published_url: publishedUrl,
    published_wp_id: wpPostId,
    gate_results: JSON.stringify(stage5.gate_results),
    dropped_tags: droppedTags.length > 0 ? JSON.stringify(droppedTags) : null,
    wp_tag_not_found: wpTagNotFound.length > 0 ? JSON.stringify(wpTagNotFound) : null,
    ...(reasons.length > 0 ? { fail_reasons: JSON.stringify(reasons) } : {}),
  });

  const output: Stage6Output = {
    schema_version: SCHEMA_VERSION,
    queue_id: queueId,
    wp_post_id: wpPostId,
    published_url: publishedUrl,
    final_status: finalStatus,
    rankmath_write_result: rankMathResult,
    verification_result: rankMathResult === 'ok' ? 'pass' : 'fail',
    content_index_upsert: contentIndexResult,
    featured_media_result: featuredMediaResult,
    wp_media_id: wpMediaId,
    hero_media_result: heroMediaResult,
    wp_hero_media_id: wpHeroMediaId,
    hero_injected: heroInjected,
    toc_injected: tocInjected,
    content_source: contentSource,
    reasons,
  };

  logger.info('Stage 6: publisher complete', {
    queue_id: queueId,
    final_status: finalStatus,
    publish_posture: posture,
    wp_post_id: wpPostId,
    tags_attached: tagIds.length,
    wp_tag_not_found_count: wpTagNotFound.length,
  });

  return { ok: !rollbackFailed, output };
}
