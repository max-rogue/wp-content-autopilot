/**
 * Stage 5 — SEO Editor and QA Gate
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.6
 * Ref: 03_PublishingOps.md Stage 5 — Tag Gate
 * Ref: 01_ContentSpec.md §2.2, §7.6
 *
 * Runs G1–G8 gate engine + Tag Gate, determines publish recommendation.
 * Status transitions: qa → proceed/draft_wp/hold/failed.
 */

import { SCHEMA_VERSION } from '../types';
import type { Stage3Output, Stage4Output, Stage5Output, ContentType } from '../types';
import { runGates, type GateContext } from '../gates/engine';
import { runTagGate, type TagGateInput } from '../gates/tag-gate';
import type { TaxonomyConfig } from '../config/taxonomy-config-loader';
import type {
  ContentIndexRepo,
  LocalDbRepo,
  PublishQueueRepo,
} from '../db/repositories';
import type { PipelineConfig } from '../config';
import { logger } from '../logger';

export interface Stage5Input {
  queueId: string;
  keyword: string;
  normalizedKeyword: string;
  contentType: ContentType;
  stage3: Stage3Output;
  stage4: Stage4Output;
  config: PipelineConfig;
  contentIndexRepo: ContentIndexRepo;
  localDbRepo: LocalDbRepo;
  queueRepo: PublishQueueRepo;
  localModifier?: string;
  /** Taxonomy config loaded from taxonomy_config.yaml */
  taxonomyConfig?: TaxonomyConfig;
}

export interface Stage5Result {
  ok: boolean;
  output?: Stage5Output;
  failReason?: string;
}

export function runStage5(input: Stage5Input): Stage5Result {
  const {
    queueId,
    keyword,
    normalizedKeyword,
    contentType,
    stage3,
    stage4,
    config,
    contentIndexRepo,
    localDbRepo,
    queueRepo,
    localModifier,
    taxonomyConfig,
  } = input;

  // Pre-WP schema_version validation  (§6.3.0)
  if (stage3.schema_version !== '1.0' || stage4.schema_version !== '1.0') {
    logger.error('Stage 5: schema_version mismatch — fail closed', {
      stage3_version: stage3.schema_version,
      stage4_version: stage4.schema_version,
    });
    queueRepo.updateStatus(queueId, 'hold', {
      fail_reasons: JSON.stringify(['schema_validation_failed']),
    });
    return { ok: false, failReason: 'schema_validation_failed' };
  }

  // Build gate context
  const gateCtx: GateContext = {
    queueId,
    keyword,
    normalizedKeyword,
    contentType,
    stage3,
    stage4,
    contentIndexRepo,
    localDbRepo,
    queueRepo,
    localModifier,
  };

  // Run all gates (G1–G8)
  const gateResult = runGates(gateCtx);

  // ── Tag Gate ─────────────────────────────────────────────────
  // Deterministic tag filtering per spec §2.2, §7.6
  let finalTags: string[] = [];
  let droppedTags: string[] = [];
  let tagReasons: string[] = [];

  if (!taxonomyConfig) {
    queueRepo.updateStatus(queueId, 'failed', {
      fail_reasons: JSON.stringify(['taxonomy_config_missing']),
    });
    logger.error('Stage 5: taxonomy config missing — fail closed');
    return { ok: false, failReason: 'taxonomy_config_missing' };
  }

  // Determine if content has verified local value
  // (checked via G3 local doorway gate result)
  const g3Result = gateResult.results.find((r) => r.gate_id === 'G3_LOCAL_DOORWAY');
  const hasVerifiedLocalValue = g3Result?.status === 'PASS' && !!localModifier;

  const tagGateInput: TagGateInput = {
    proposedTags: stage3.tags || [],
    taxonomyConfig,
    hasVerifiedLocalValue,
    // plannedTagCounts not provided — strict whitelist mode
  };

  const tagGateResult = runTagGate(tagGateInput);
  finalTags = tagGateResult.finalTags;
  droppedTags = tagGateResult.droppedTags;
  tagReasons = tagGateResult.reasons;

  // Merge tag reasons into gate reasons
  const allReasons = [...gateResult.reasons, ...tagReasons];

  // Build canonical URL
  const canonical = `${config.siteBaseUrl}/blog/${stage3.suggested_slug}`;

  // Determine schema type based on content type
  let schemaType = 'BlogPosting';
  if (contentType === 'Glossary') schemaType = 'DefinedTerm';
  if (contentType === 'LandingSection' || contentType === 'CategoryPage') {
    schemaType = 'WebPage';
  }

  const output: Stage5Output = {
    schema_version: SCHEMA_VERSION,
    publish_recommendation: gateResult.recommendation,
    slug_final: stage3.suggested_slug,
    rankmath: {
      focus_keyword: stage3.focus_keyword,
      meta_title: stage3.meta_title,
      meta_description: stage3.meta_description,
      canonical,
      robots: gateResult.robotsDecision,
      schema_type: schemaType,
    },
    taxonomy: {
      category: stage3.category,
      tags: finalTags,
      dropped_tags: droppedTags,
    },
    gate_results: Object.fromEntries(
      gateResult.results.map((r) => [
        r.gate_id,
        { gate_id: r.gate_id, status: r.status, reasons: r.reasons },
      ])
    ),
    reasons: allReasons,
  };

  // Update queue with gate results + dropped tags
  queueRepo.updateStatus(queueId, queueId ? input.queueRepo.findById(queueId)?.status || 'qa' : 'qa', {
    similarity_score: 0,
    similarity_band: gateResult.results.find((r) => r.gate_id === 'G2_SIMILARITY')?.status as any || 'PASS',
    robots_decision: gateResult.robotsDecision,
    gate_results: JSON.stringify(output.gate_results),
    dropped_tags: droppedTags.length > 0 ? JSON.stringify(droppedTags) : null,
  });

  logger.info('Stage 5: QA gate complete', {
    queue_id: queueId,
    recommendation: gateResult.recommendation,
    robots: gateResult.robotsDecision,
    final_tags_count: finalTags.length,
    dropped_tags_count: droppedTags.length,
  });

  return { ok: true, output };
}
