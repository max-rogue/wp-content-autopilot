/**
 * Stage 1 — Planner
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.2
 *
 * Takes a queue item, normalizes keyword, runs G1 dedup, outputs plan.
 * Status transition: planned → researching.
 */

import { SCHEMA_VERSION } from '../types';
import type { Stage1Output, PublishQueueRow, ContentClass, BlogpostSubtype } from '../types';
import { normalizeKeyword } from '../gates/engine';
import type { ContentIndexRepo, PublishQueueRepo } from '../db/repositories';
import { logger } from '../logger';

export interface Stage1Input {
  queueItem: PublishQueueRow;
  queueRepo: PublishQueueRepo;
  contentIndexRepo: ContentIndexRepo;
  /** Optional local modifier (city/province) if detected from keyword or CSV */
  localModifier?: string;
}

export interface Stage1Result {
  ok: boolean;
  output?: Stage1Output;
  failReason?: string;
}

/**
 * Populate required_data_flags deterministically based on class_hint,
 * local modifiers, and content_type / blogpost_subtype.
 *
 * Logic (minimal, configurable via taxonomy config if it exists):
 *   - Class C + local modifier → local_business_data, local_citations
 *   - BuyingGuide subtype → pricing_data, product_names
 *   - Comparison subtype → competitor_data
 *   - Class A → minimal (no extra data flags)
 *   - Class B → baseline (no extra data flags)
 */
export function computeRequiredDataFlags(
  classHint: ContentClass,
  blogpostSubtype: BlogpostSubtype | null,
  localModifier?: string,
): string[] {
  const flags: string[] = [];

  // Class C with local intent → require local data
  if (classHint === 'C' && localModifier) {
    flags.push('local_business_data', 'local_citations');
  }

  // Subtype-driven flags
  if (blogpostSubtype === 'BuyingGuide') {
    flags.push('pricing_data', 'product_names');
  }
  if (blogpostSubtype === 'Comparison') {
    flags.push('competitor_data');
  }

  return flags;
}

export function runStage1(input: Stage1Input): Stage1Result {
  const { queueItem, queueRepo, contentIndexRepo, localModifier } = input;

  // Validate required fields
  if (!queueItem.picked_keyword) {
    queueRepo.updateStatus(queueItem.id, 'failed', {
      fail_reasons: JSON.stringify(['invalid_input: missing picked_keyword']),
    });
    return { ok: false, failReason: 'invalid_input' };
  }

  const normalized = normalizeKeyword(queueItem.picked_keyword);

  // G1 Keyword Dedup check (§6.3.2)
  const existingInIndex = contentIndexRepo.findByFocusKeyword(normalized);
  if (existingInIndex) {
    logger.info('Stage 1: keyword already in content_index', {
      keyword: normalized,
      wp_post_id: existingInIndex.wp_post_id,
    });
    queueRepo.updateStatus(queueItem.id, 'hold', {
      fail_reasons: JSON.stringify(['keyword_dedup: already published']),
    });
    return { ok: false, failReason: 'keyword_dedup' };
  }

  // Check for existing in queue (not self)
  const existingInQueue = queueRepo.findByIdempotencyKey(queueItem.idempotency_key);
  if (existingInQueue && existingInQueue.id !== queueItem.id) {
    logger.info('Stage 1: idempotency key conflict', { key: queueItem.idempotency_key });
    queueRepo.updateStatus(queueItem.id, 'hold', {
      fail_reasons: JSON.stringify(['idempotency_key_conflict']),
    });
    return { ok: false, failReason: 'idempotency_key_conflict' };
  }

  // Resolve class_hint + blogpost_subtype from queue row
  const classHint: ContentClass = queueItem.class_hint || 'B';
  const blogpostSubtype: BlogpostSubtype | null = queueItem.blogpost_subtype || null;

  // Populate required_data_flags deterministically
  const requiredDataFlags = computeRequiredDataFlags(
    classHint,
    blogpostSubtype,
    localModifier,
  );

  // Transition: planned → researching
  queueRepo.updateStatus(queueItem.id, 'researching');

  const output: Stage1Output = {
    schema_version: SCHEMA_VERSION,
    queue_id: queueItem.id,
    picked_keyword: queueItem.picked_keyword,
    normalized_keyword: normalized,
    cluster: queueItem.cluster,
    content_type: queueItem.content_type,
    class_hint: classHint,
    blogpost_subtype: blogpostSubtype,
    angle: `Comprehensive guide on ${queueItem.picked_keyword}`,
    required_data_flags: requiredDataFlags,
    planner_notes: [],
  };

  logger.info('Stage 1: planning complete', {
    queue_id: queueItem.id,
    normalized: normalized,
    class_hint: classHint,
    blogpost_subtype: blogpostSubtype || 'none',
    data_flags_count: requiredDataFlags.length,
  });

  return { ok: true, output };
}
