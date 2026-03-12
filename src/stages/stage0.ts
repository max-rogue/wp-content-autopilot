/**
 * Stage 0 — Cron and Quota Controller
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.1
 *
 * Determines how many posts to process this run based on quota, ramp, and throttle.
 */

import { v4 as uuid } from 'uuid';
import { SCHEMA_VERSION } from '../types';
import type { Stage0Output, ThrottleState } from '../types';
import type { SettingsRepo, PublishQueueRepo } from '../db/repositories';
import { resolveEffectiveQuota } from '../config';
import { logger } from '../logger';

export interface Stage0Input {
  settingsRepo: SettingsRepo;
  queueRepo: PublishQueueRepo;
  /** Optional env-level override for daily quota (PIPELINE_DAILY_QUOTA). */
  pipelineDailyQuota?: number;
}

export function runStage0(input: Stage0Input): Stage0Output {
  const settings = input.settingsRepo.get();
  const runId = uuid();

  // Hard gate: global pause (§6.3.1)
  if (settings.throttle_state === 'paused') {
    logger.info('Stage 0: throttle_state=paused — skipping run');
    return {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      target_posts_count: 0,
      quota_reason: 'throttle_paused',
      selected_queue_ids: [],
    };
  }

  // Resolve effective daily quota: env override (Option A) ?? DB value
  const { effectiveQuota, source: quotaSource } = resolveEffectiveQuota(
    input.pipelineDailyQuota,
    settings.daily_quota,
  );
  logger.info('Stage 0: quota resolved', {
    effective_quota: effectiveQuota,
    source: quotaSource,
    db_quota: settings.daily_quota,
    env_override: input.pipelineDailyQuota ?? 'unset',
  });

  // Calculate target count based on quota and ramp
  let target = effectiveQuota;

  if (settings.throttle_state === 'reduced') {
    target = Math.max(1, Math.floor(target / 2));
  }

  // Ramp state affects quota growth rate (not immediate count)
  // For now, use daily_quota directly

  if (target <= 0) {
    logger.info('Stage 0: quota exhausted');
    return {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      target_posts_count: 0,
      quota_reason: 'quota_exhausted',
      selected_queue_ids: [],
    };
  }

  // Select planned items from queue
  const planned = input.queueRepo.findPlannedForRun(target);

  if (planned.length === 0) {
    logger.info('Stage 0: no planned items in queue');
    return {
      schema_version: SCHEMA_VERSION,
      run_id: runId,
      target_posts_count: 0,
      quota_reason: 'no_planned_items',
      selected_queue_ids: [],
    };
  }

  const selectedIds = planned.map((p) => p.id);

  // Update last_run_at
  input.settingsRepo.update({ last_run_at: new Date().toISOString() });

  logger.info(`Stage 0: selected ${selectedIds.length} items for run ${runId}`);

  return {
    schema_version: SCHEMA_VERSION,
    run_id: runId,
    target_posts_count: selectedIds.length,
    quota_reason: 'ok',
    selected_queue_ids: selectedIds,
  };
}
