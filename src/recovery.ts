/**
 * Recovery — deterministic replay/recovery for interrupted pipeline runs.
 * Ref: INTERNAL CONFIG — PIPELINE_RECOVERY_REPLAY_LIMIT, PIPELINE_RECOVERY_LOOKBACK_MINUTES
 *
 * Flow:
 *   1. Scan publish_queue for items stuck in non-terminal states within lookback window.
 *   2. Determine safe resume point (idempotent: won't duplicate WP side effects).
 *   3. Re-queue for processing with the same idempotency_key protection.
 *
 * Invariants:
 *   - Never creates duplicate WP posts (idempotency_key + slug-based dedup in Stage 6).
 *   - Bounded by PIPELINE_RECOVERY_REPLAY_LIMIT items per recovery pass.
 *   - Only scans within PIPELINE_RECOVERY_LOOKBACK_MINUTES window.
 *   - Items already in terminal states (draft_wp, published, hold, failed) are skipped.
 */

import type { PublishQueueRepo } from './db/repositories';
import type { PipelineConfig } from './config';
import type { QueueStatus } from './types';
import { logger } from './logger';

/** Statuses that indicate an interrupted (non-terminal) run. */
const INTERRUPTED_STATUSES: QueueStatus[] = [
    'planned',
    'researching',
    'drafting',
    'qa',
];

/** Terminal statuses — these are complete and should NOT be replayed. */
const TERMINAL_STATUSES: QueueStatus[] = [
    'draft_wp',
    'published',
    'hold',
    'failed',
];

export interface RecoveryCandidate {
    id: string;
    idempotency_key: string;
    status: QueueStatus;
    updated_at: string;
}

export interface RecoveryResult {
    scanned: number;
    candidates: RecoveryCandidate[];
    replayed: number;
    skipped: number;
    reasons: string[];
}

/**
 * Scan for interrupted queue items eligible for replay.
 * Does NOT mutate — returns candidates only.
 */
export function scanRecoveryCandidates(
    queueRepo: PublishQueueRepo,
    config: PipelineConfig
): RecoveryCandidate[] {
    const lookbackMs = config.recoveryLookbackMinutes * 60 * 1000;
    // DB timestamps are stored via sqlite datetime('now') => "YYYY-MM-DD HH:MM:SS" (UTC).
    // Use the same lexical format for deterministic comparisons in SQL.
    const cutoff = new Date(Date.now() - lookbackMs)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
    const limit = config.recoveryReplayLimit;

    // Query items in non-terminal states updated within lookback window
    const items = queueRepo.findInterrupted(INTERRUPTED_STATUSES, cutoff, limit);

    logger.info('Recovery: scanned for interrupted items', {
        lookback_minutes: config.recoveryLookbackMinutes,
        limit,
        found: items.length,
    });

    return items.map((item) => ({
        id: item.id,
        idempotency_key: item.idempotency_key,
        status: item.status,
        updated_at: item.updated_at,
    }));
}

/**
 * Reset interrupted items back to 'planned' for replay.
 * Idempotent: same item replayed twice won't create duplicate WP posts
 * because Stage 6 checks by slug (findBySlug) before creating.
 *
 * Returns the count of items actually reset.
 */
export function replayInterrupted(
    queueRepo: PublishQueueRepo,
    candidates: RecoveryCandidate[]
): number {
    let count = 0;

    for (const candidate of candidates) {
        // Only reset non-terminal statuses
        if (TERMINAL_STATUSES.includes(candidate.status)) {
            logger.info('Recovery: skipping terminal item', {
                id: candidate.id,
                status: candidate.status,
            });
            continue;
        }

        // Reset to 'planned' for re-processing
        queueRepo.updateStatus(candidate.id, 'planned', {
            fail_reasons: JSON.stringify(['recovery_replay']),
        });
        count++;

        logger.info('Recovery: item reset to planned for replay', {
            id: candidate.id,
            previous_status: candidate.status,
            idempotency_key: candidate.idempotency_key,
        });
    }

    return count;
}

/**
 * Full recovery pass: scan + replay within bounded limits.
 * Safe for repeated calls (idempotent).
 */
export function runRecovery(
    queueRepo: PublishQueueRepo,
    config: PipelineConfig
): RecoveryResult {
    const candidates = scanRecoveryCandidates(queueRepo, config);
    const replayed = replayInterrupted(queueRepo, candidates);
    const skipped = candidates.length - replayed;

    const result: RecoveryResult = {
        scanned: candidates.length,
        candidates,
        replayed,
        skipped,
        reasons: replayed > 0 ? ['recovery_replay_executed'] : ['no_interrupted_items'],
    };

    logger.info('Recovery: pass complete', {
        scanned: result.scanned,
        replayed: result.replayed,
        skipped: result.skipped,
    });

    return result;
}
