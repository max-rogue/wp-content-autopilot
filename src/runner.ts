/**
 * Pipeline Runner — orchestrates Stages 0–6 for each queue item.
 * Ref: 13_CONTENT_OPS_PIPELINE §6, 15_DEPLOYMENT_AND_RUNBOOK §6.2
 *
 * Execution flow:
 *   Stage 0 (quota/cron) → for each selected queue_id:
 *     Stage 1 (planner) → Stage 2 (research) → Stage 3 (writer) →
 *     Stage 3.5 (HTML composer) → Stage 4 (media) → Stage 5 (gates/QA) → Stage 6 (publisher)
 *
 * Audit entries are written after each stage (§6.6).
 * run_id is unique per execution (§6.6).
 *
 * Cost guardrails (INTERNAL CONFIG):
 *   - per-job cap: hold/fail closed BEFORE WP write if exceeded.
 *   - daily cap: block additional jobs deterministically.
 *   - Reason taxonomy: cost_cap_per_job_exceeded, cost_cap_daily_exceeded.
 *
 * Concurrency: controlled by maxConcurrentRuns. Single-threaded by default.
 */

import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { SCHEMA_VERSION } from './types';
import type { Stage6Output } from './types';
import { loadConfig, type PipelineConfig } from './config';
import { getDb, runMigrations } from './db/migrate';
import {
    PublishQueueRepo,
    ContentIndexRepo,
    SettingsRepo,
    LocalDbRepo,
    AuditLogRepo,
} from './db/repositories';
import { WpClient } from './services/wp-client';
import { RankMathService } from './services/rankmath';
import { WriterService } from './services/writer';
import { loadTaxonomyConfig } from './config/taxonomy-config-loader';
import { runStage0 } from './stages/stage0';
import { runStage1 } from './stages/stage1';
import { runStage2 } from './stages/stage2';
import { runStage3 } from './stages/stage3';
import { runStage3_5 } from './stages/stage3_5';
import { runStage4 } from './stages/stage4';
import { runStage5 } from './stages/stage5';
import { runStage6 } from './stages/stage6';
import { costTracker } from './cost-tracker';
import { fetchSitemapPairs } from './services/sitemap-fetcher';
import { buildSitemapSnippet } from './services/sitemap-snippet';
import { logger } from './logger';

export interface RunResult {
    schema_version: typeof SCHEMA_VERSION;
    run_id: string;
    items_selected: number;
    items_completed: number;
    items_failed: number;
    cost_blocked: number;
    results: Array<{
        queue_id: string;
        final_status: string;
        wp_post_id: number;
        reasons: string[];
    }>;
}

/** Global concurrency guard — counts active pipeline runs. */
let _activeRuns = 0;

/** Exported for testing only. */
export function getActiveRuns(): number { return _activeRuns; }
export function resetActiveRuns(): void { _activeRuns = 0; }

function hashSnapshot(data: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

export async function runPipeline(configOverride?: Partial<PipelineConfig>): Promise<RunResult> {
    const config = { ...loadConfig(), ...configOverride };

    // ── Concurrency guard ──────────────────────────────────────────
    if (_activeRuns >= config.maxConcurrentRuns) {
        logger.warn('Runner: concurrency limit reached — rejecting run', {
            active_runs: _activeRuns,
            max: config.maxConcurrentRuns,
        });
        return {
            schema_version: SCHEMA_VERSION,
            run_id: '',
            items_selected: 0,
            items_completed: 0,
            items_failed: 0,
            cost_blocked: 0,
            results: [],
        };
    }

    _activeRuns++;

    try {
        return await _runPipelineInner(config);
    } finally {
        _activeRuns--;
    }
}

async function _runPipelineInner(config: PipelineConfig): Promise<RunResult> {
    const db = getDb(config.dbPath);
    runMigrations(db);

    const queueRepo = new PublishQueueRepo(db);
    const contentIndexRepo = new ContentIndexRepo(db);
    const settingsRepo = new SettingsRepo(db);
    const localDbRepo = new LocalDbRepo(db);
    const auditRepo = new AuditLogRepo(db);

    const wpClient = new WpClient(config);
    const rankMathService = new RankMathService(config, wpClient);
    const writerService = new WriterService(config);

    // Load taxonomy config for tag gate (per-process, cached).
    // Fail-closed: Option B tag pipeline requires taxonomy_config.yaml as runtime source of truth.
    const taxonomyConfig = loadTaxonomyConfig();

    // ── Daily cost cap check (before any work) ──────────────────────
    const dailyCostReason = costTracker.checkDailyCap(config.dailyCostCapUsd);
    if (dailyCostReason) {
        logger.warn('Runner: daily cost cap reached — blocking run', {
            reason: dailyCostReason,
            daily_cost: costTracker.getDailyCost().toFixed(4),
            cap: config.dailyCostCapUsd,
        });
        db.close();
        return {
            schema_version: SCHEMA_VERSION,
            run_id: '',
            items_selected: 0,
            items_completed: 0,
            items_failed: 0,
            cost_blocked: 1,
            results: [{ queue_id: '', final_status: 'failed', wp_post_id: 0, reasons: [dailyCostReason] }],
        };
    }

    // ── Stage 0 ──────────────────────────────────────────────────
    const stage0 = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: config.pipelineDailyQuota });

    auditRepo.insert({
        id: uuid(),
        queue_id: '_run',
        run_id: stage0.run_id,
        stage_name: 'stage0',
        input_snapshot_hash: hashSnapshot({ daily_quota: settingsRepo.get().daily_quota }),
        output_snapshot_hash: hashSnapshot(stage0),
        gate_decisions: null,
        reasons: JSON.stringify([stage0.quota_reason]),
        created_at: new Date().toISOString(),
    });

    if (stage0.selected_queue_ids.length === 0) {
        logger.info('Runner: no items selected — run complete', { run_id: stage0.run_id });
        db.close();
        return {
            schema_version: SCHEMA_VERSION,
            run_id: stage0.run_id,
            items_selected: 0,
            items_completed: 0,
            items_failed: 0,
            cost_blocked: 0,
            results: [],
        };
    }

    // ── Sitemap fetch (once per run, fail-safe) ─────────────────────
    // Always fetch — no INTERNAL_LINKS_ENABLED gating here.
    // The snippet is passed to Stage 3 as prompt context; whether the LLM
    // uses it is controlled by prompts, not by pipeline logic.
    let sitemapSnippet: import('./types').SitemapPair[] = [];
    let sitemapSnippetText = '';
    try {
        const pairs = await fetchSitemapPairs(config.siteBaseUrl);
        sitemapSnippet = pairs;
        sitemapSnippetText = buildSitemapSnippet(
            pairs,
            config.sitemapSnippetMaxUrls,
            config.sitemapSnippetMaxChars,
        );
        logger.info('Runner: sitemap snippet built', {
            run_id: stage0.run_id,
            pairs_fetched: pairs.length,
            snippet_len: sitemapSnippetText.length,
            snippet_urls: Math.min(pairs.length, config.sitemapSnippetMaxUrls),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Runner: sitemap fetch failed — proceeding with empty snippet', {
            run_id: stage0.run_id,
            error: msg,
        });
    }

    // ── Per-tick claim limit ─────────────────────────────────────────
    // Only process up to maxJobsPerTick items per run (deterministic ordering preserved)
    const claimedIds = stage0.selected_queue_ids.slice(0, config.maxJobsPerTick);
    if (claimedIds.length < stage0.selected_queue_ids.length) {
        logger.info('Runner: per-tick claim limit applied', {
            requested: stage0.selected_queue_ids.length,
            claimed: claimedIds.length,
            max_per_tick: config.maxJobsPerTick,
        });
    }

    const results: RunResult['results'] = [];
    let completed = 0;
    let failed = 0;
    let costBlocked = 0;

    for (const queueId of claimedIds) {
        const queueItem = queueRepo.findById(queueId);
        if (!queueItem) {
            logger.warn('Runner: queue item not found', { queue_id: queueId });
            failed++;
            continue;
        }

        // ── Per-job cost cap check (before processing) ──────────────
        const jobCostReason = costTracker.preFlightCheck(
            queueId,
            config.perJobCostCapUsd,
            config.dailyCostCapUsd
        );
        if (jobCostReason) {
            logger.warn('Runner: cost cap — blocking job', {
                queue_id: queueId,
                reason: jobCostReason,
            });
            queueRepo.updateStatus(queueId, 'hold', {
                fail_reasons: JSON.stringify([jobCostReason]),
            });
            costBlocked++;
            results.push({
                queue_id: queueId,
                final_status: 'hold',
                wp_post_id: 0,
                reasons: [jobCostReason],
            });
            continue;
        }

        costTracker.recordJobStart();

        try {
            // ── Stage 1 ────────────────────────────────────────────
            costTracker.recordJobCost(queueId, 'llm_research');
            const s1 = runStage1({ queueItem, queueRepo, contentIndexRepo });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage1',
                input_snapshot_hash: hashSnapshot(queueItem),
                output_snapshot_hash: hashSnapshot(s1.output || {}),
                gate_decisions: null,
                reasons: s1.failReason ? JSON.stringify([s1.failReason]) : null,
                created_at: new Date().toISOString(),
            });

            if (!s1.ok || !s1.output) {
                failed++;
                results.push({
                    queue_id: queueId,
                    final_status: 'failed',
                    wp_post_id: 0,
                    reasons: [s1.failReason || 'stage1_failed'],
                });
                continue;
            }

            // ── Stage 2 ────────────────────────────────────────────
            costTracker.recordJobCost(queueId, 'llm_research');
            const s2 = await runStage2({ stage1: s1.output, writerService, queueRepo, newsSourceUrl: queueItem.news_source_url || undefined });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage2',
                input_snapshot_hash: hashSnapshot(s1.output),
                output_snapshot_hash: hashSnapshot(s2.output || {}),
                gate_decisions: null,
                reasons: s2.failReason ? JSON.stringify([s2.failReason]) : null,
                created_at: new Date().toISOString(),
            });

            if (!s2.ok || !s2.output) {
                failed++;
                results.push({
                    queue_id: queueId,
                    final_status: 'failed',
                    wp_post_id: 0,
                    reasons: [s2.failReason || 'stage2_failed'],
                });
                continue;
            }

            // ── Stage 3 ────────────────────────────────────────────
            costTracker.recordJobCost(queueId, 'llm_draft');
            const s3 = await runStage3({
                queueId,
                keyword: s1.output.picked_keyword,
                contentType: s1.output.content_type,
                classHint: s1.output.class_hint,
                blogpostSubtype: s1.output.blogpost_subtype,
                stage2: s2.output,
                writerService,
                queueRepo,
                sitemapSnippet: sitemapSnippet.length > 0 ? sitemapSnippet : undefined,
                newsSourceUrl: queueItem.news_source_url || undefined,
            });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage3',
                input_snapshot_hash: hashSnapshot(s2.output),
                output_snapshot_hash: hashSnapshot(s3.output || {}),
                gate_decisions: null,
                reasons: s3.failReason ? JSON.stringify([s3.failReason]) : null,
                created_at: new Date().toISOString(),
            });

            if (!s3.ok || !s3.output) {
                failed++;
                results.push({
                    queue_id: queueId,
                    final_status: 'failed',
                    wp_post_id: 0,
                    reasons: [s3.failReason || 'stage3_failed'],
                });
                continue;
            }

            // ── Stage 3.5 (non-blocking HTML composer) ──────────────
            const s3_5 = await runStage3_5({
                stage3: s3.output,
                writerService,
            });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage3_5',
                input_snapshot_hash: hashSnapshot(s3.output),
                output_snapshot_hash: hashSnapshot(s3_5.output),
                gate_decisions: null,
                reasons: s3_5.output.qa_notes.length > 0 ? JSON.stringify(s3_5.output.qa_notes) : null,
                created_at: new Date().toISOString(),
            });

            // ── Per-job cost cap check before Stage 4+ (pre-WP guardrail) ──
            const midJobCostReason = costTracker.preFlightCheck(
                queueId,
                config.perJobCostCapUsd,
                config.dailyCostCapUsd
            );
            if (midJobCostReason) {
                logger.warn('Runner: cost cap mid-job — holding before WP write', {
                    queue_id: queueId,
                    reason: midJobCostReason,
                    job_cost: costTracker.getJobCost(queueId).toFixed(4),
                });
                queueRepo.updateStatus(queueId, 'hold', {
                    fail_reasons: JSON.stringify([midJobCostReason]),
                });
                costBlocked++;
                results.push({
                    queue_id: queueId,
                    final_status: 'hold',
                    wp_post_id: 0,
                    reasons: [midJobCostReason],
                });
                continue;
            }

            // ── Stage 4 ────────────────────────────────────────────
            costTracker.recordJobCost(queueId, 'llm_image_gen');
            const s4 = await runStage4({
                queueId,
                stage3: s3.output,
                queueRepo,
                imageRequired: config.llmImageRequired,
                writerService,
            });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage4',
                input_snapshot_hash: hashSnapshot(s3.output),
                output_snapshot_hash: hashSnapshot(s4.output || {}),
                gate_decisions: null,
                reasons: s4.failReason ? JSON.stringify([s4.failReason]) : null,
                created_at: new Date().toISOString(),
            });

            if (!s4.ok || !s4.output) {
                failed++;
                results.push({
                    queue_id: queueId,
                    final_status: 'failed',
                    wp_post_id: 0,
                    reasons: [s4.failReason || 'stage4_failed'],
                });
                continue;
            }

            // ── Stage 5 ────────────────────────────────────────────
            const s5 = runStage5({
                queueId,
                keyword: s1.output.picked_keyword,
                normalizedKeyword: s1.output.normalized_keyword,
                contentType: s1.output.content_type,
                stage3: s3.output,
                stage4: s4.output,
                config,
                contentIndexRepo,
                localDbRepo,
                queueRepo,
                localModifier: undefined, // derived from keyword if applicable
                taxonomyConfig,
            });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage5',
                input_snapshot_hash: hashSnapshot({ s3: s3.output, s4: s4.output }),
                output_snapshot_hash: hashSnapshot(s5.output || {}),
                gate_decisions: s5.output ? JSON.stringify(s5.output.gate_results) : null,
                reasons: s5.failReason ? JSON.stringify([s5.failReason]) : null,
                created_at: new Date().toISOString(),
            });

            if (!s5.ok || !s5.output) {
                failed++;
                results.push({
                    queue_id: queueId,
                    final_status: 'failed',
                    wp_post_id: 0,
                    reasons: [s5.failReason || 'stage5_failed'],
                });
                continue;
            }

            // ── Final cost cap check before WP write (Stage 6) ─────
            const preWpCostReason = costTracker.preFlightCheck(
                queueId,
                config.perJobCostCapUsd,
                config.dailyCostCapUsd
            );
            if (preWpCostReason) {
                logger.warn('Runner: cost cap pre-WP — holding job', {
                    queue_id: queueId,
                    reason: preWpCostReason,
                });
                queueRepo.updateStatus(queueId, 'hold', {
                    fail_reasons: JSON.stringify([preWpCostReason]),
                });
                costBlocked++;
                results.push({
                    queue_id: queueId,
                    final_status: 'hold',
                    wp_post_id: 0,
                    reasons: [preWpCostReason],
                });
                continue;
            }

            // ── Stage 6 ────────────────────────────────────────────
            costTracker.recordJobCost(queueId, 'wp_create_draft');
            const s6 = await runStage6({
                queueId,
                stage3: s3.output,
                stage3_5: s3_5.output,
                stage4: s4.output,
                stage5: s5.output,
                config,
                wpClient,
                rankMathService,
                queueRepo,
                contentIndexRepo,
                csvCanonicalCategory: queueItem.canonical_category || undefined,
            });
            auditRepo.insert({
                id: uuid(),
                queue_id: queueId,
                run_id: stage0.run_id,
                stage_name: 'stage6',
                input_snapshot_hash: hashSnapshot(s5.output),
                output_snapshot_hash: hashSnapshot(s6.output || {}),
                gate_decisions: null,
                reasons: s6.output ? JSON.stringify(s6.output.reasons) : null,
                created_at: new Date().toISOString(),
            });

            const finalOutput = s6.output as Stage6Output;
            results.push({
                queue_id: queueId,
                final_status: finalOutput.final_status,
                wp_post_id: finalOutput.wp_post_id,
                reasons: finalOutput.reasons,
            });

            if (finalOutput.final_status === 'failed') {
                failed++;
            } else {
                completed++;
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error('Runner: unhandled error for queue item', { queue_id: queueId, error: msg });
            failed++;

            // G7 FIX: Persist failure to queue + audit log so recovery doesn't retry endlessly.
            try {
                queueRepo.updateStatus(queueId, 'failed', {
                    fail_reasons: JSON.stringify([`unhandled_error: ${msg}`]),
                });
                auditRepo.insert({
                    id: uuid(),
                    queue_id: queueId,
                    run_id: stage0.run_id,
                    stage_name: 'unhandled_error',
                    input_snapshot_hash: '',
                    output_snapshot_hash: '',
                    gate_decisions: null,
                    reasons: JSON.stringify([`unhandled_error: ${msg}`]),
                    created_at: new Date().toISOString(),
                });
            } catch (persistErr) {
                logger.error('Runner: failed to persist unhandled error', {
                    queue_id: queueId,
                    persist_error: persistErr instanceof Error ? persistErr.message : String(persistErr),
                });
            }

            results.push({
                queue_id: queueId,
                final_status: 'failed',
                wp_post_id: 0,
                reasons: [`unhandled_error: ${msg}`],
            });
        }
    }

    db.close();

    return {
        schema_version: SCHEMA_VERSION,
        run_id: stage0.run_id,
        items_selected: claimedIds.length,
        items_completed: completed,
        items_failed: failed,
        cost_blocked: costBlocked,
        results,
    };
}
