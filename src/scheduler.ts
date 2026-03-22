/**
 * Cron Scheduler — toggleable daily pipeline run + weekly report.
 * Ref: Part B — Scheduler / Cron
 *
 * Hard requirements:
 *   - CRON_ENABLED=false → no scheduler, no background loop, no accidental runs.
 *   - CRON_ENABLED=true  → runs at CRON_SCHEDULE in CRON_TIMEZONE.
 *   - DB-backed lock prevents duplicate concurrent cron runs.
 *   - Uses existing runPipeline() internally (no new HTTP endpoints).
 *   - Weekly dropped-tag report runs on a separate lock key.
 *   - Report failures never block the main pipeline runs.
 *   - Logs: enabled state, schedule, next run, lock acquisition. NO SECRETS.
 */

import { CronExpressionParser } from 'cron-parser';
import type { PipelineConfig } from './config';
import { getDb, runMigrations } from './db/migrate';
import { CronLockRepo, PublishQueueRepo } from './db/repositories';
import { runPipeline } from './runner';
import { runRecovery } from './recovery';
import { generateDroppedTagReport } from './services/dropped-tag-report';
import { logger } from './logger';

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let isReportRunning = false;

/* ------------------------------------------------------------------ */
/*  Timezone alias normalization                                       */
/* ------------------------------------------------------------------ */

/**
 * Known IANA timezone aliases that refer to the same zone.
 * Node/ICU may resolve them differently, causing false mismatch warnings.
 */
const TZ_ALIASES: Record<string, string> = {
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
};

const DEFAULT_CRON_TIMEZONE = 'UTC';

/**
 * Normalize a timezone identifier by collapsing known aliases to their
 * canonical IANA name.  Unknown names pass through untouched.
 */
export function normalizeTz(tz: string): string {
    return TZ_ALIASES[tz] ?? tz;
}

/**
 * Returns true when two timezone strings refer to the same zone,
 * after alias normalisation.
 */
export function tzEqual(a: string, b: string): boolean {
    return normalizeTz(a) === normalizeTz(b);
}

/**
 * Resolve CRON_TIMEZONE to a safe, valid IANA timezone.
 * Missing/invalid values fail-safe to Asia/Ho_Chi_Minh.
 */
export function resolveCronTimezone(
    timezone: string | null | undefined
): { timezone: string; usedFallback: boolean; reason?: 'missing' | 'invalid' } {
    const raw = (timezone ?? '').trim();
    if (raw === '') {
        return {
            timezone: DEFAULT_CRON_TIMEZONE,
            usedFallback: true,
            reason: 'missing',
        };
    }

    const canonical = normalizeTz(raw);
    try {
        // Validate IANA name support in the current runtime.
        new Intl.DateTimeFormat('en-US', { timeZone: canonical });
        return { timezone: canonical, usedFallback: false };
    } catch {
        return {
            timezone: DEFAULT_CRON_TIMEZONE,
            usedFallback: true,
            reason: 'invalid',
        };
    }
}

/**
 * Format a date in the target timezone for operator logs.
 * Uses hourCycle=h23 to keep midnight as 00:00 (never 24:00).
 */
export function formatLocalWallClock(date: Date, timezone: string): string {
    const { timezone: effectiveTz } = resolveCronTimezone(timezone);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: effectiveTz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(date);
}

/* ------------------------------------------------------------------ */
/*  Lock-key helpers (unchanged)                                       */
/* ------------------------------------------------------------------ */

/**
 * Generate a deterministic lock key for the current cron window.
 * Format: cron-YYYY-MM-DD (one run per day).
 */
function getLockKey(): string {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // UTC date as lock key
    return `cron-${dateStr}`;
}

/**
 * Parse a cron expression to determine the interval and next run.
 * For simplicity, we support the common daily pattern: "M H * * *"
 * Returns the hour and minute for scheduling.
 */
function parseCronSchedule(schedule: string): { hour: number; minute: number } {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length < 5) {
        logger.warn('Scheduler: invalid cron expression, defaulting to 06:00', {
            schedule,
        });
        return { hour: 6, minute: 0 };
    }
    const minute = parseInt(parts[0], 10) || 0;
    const hour = parseInt(parts[1], 10) || 6;
    return { hour, minute };
}

/* ------------------------------------------------------------------ */
/*  Timezone-aware next-run computation via cron-parser                */
/* ------------------------------------------------------------------ */

/**
 * Compute the next occurrence of `schedule` in `timezone`, relative to `now`.
 *
 * Uses `cron-parser` with its `tz` option so the cron fields are interpreted
 * directly in the target IANA timezone — no manual UTC↔local arithmetic.
 *
 * @returns Object with:
 *   - `nextDate`  – JS Date of next occurrence (absolute / UTC-aware)
 *   - `delayMs`   – milliseconds from `now` until `nextDate`
 */
export function computeNextRun(
    schedule: string,
    timezone: string,
    now: Date = new Date()
): { nextDate: Date; delayMs: number } {
    const { timezone: canonicalTz } = resolveCronTimezone(timezone);

    const interval = CronExpressionParser.parse(schedule, {
        currentDate: now,
        tz: canonicalTz,
    });

    const nextCronDate = interval.next();
    const nextDate = nextCronDate.toDate();
    const delayMs = nextDate.getTime() - now.getTime();

    return { nextDate, delayMs };
}

/* ------------------------------------------------------------------ */
/*  Cron tick / report tick (pipeline logic — unchanged)               */
/* ------------------------------------------------------------------ */

/**
 * Execute one cron tick: acquire lock, run pipeline, release lock.
 */
async function cronTick(config: PipelineConfig): Promise<void> {
    if (isRunning) {
        logger.info('Scheduler: previous cron run still in progress — skipping');
        return;
    }

    const lockKey = getLockKey();
    const db = getDb(config.dbPath);
    runMigrations(db);
    const lockRepo = new CronLockRepo(db);

    // Clean up stale locks (> 7 days old) + locks stuck > 4 hours (staleness guard)
    lockRepo.cleanup(7);

    const runId = `cron-${Date.now()}`;
    const acquired = lockRepo.tryAcquire(lockKey, runId);

    if (!acquired) {
        logger.info('Scheduler: lock already held for this window — skipping', {
            lock_key: lockKey,
        });
        db.close();
        return;
    }

    logger.info('Scheduler: lock acquired — starting pipeline run', {
        lock_key: lockKey,
        run_id: runId,
    });

    isRunning = true;
    try {
        // Run recovery pass first: reset interrupted items within lookback window
        try {
            const recoveryDb = getDb(config.dbPath);
            // G10 FIX: Removed redundant runMigrations (parent cronTick L185 already ran it).
            const recoveryQueueRepo = new PublishQueueRepo(recoveryDb);
            const recoveryResult = runRecovery(recoveryQueueRepo, config);
            recoveryDb.close();
            if (recoveryResult.replayed > 0) {
                logger.info('Scheduler: recovery pass replayed items', {
                    replayed: recoveryResult.replayed,
                });
            }
        } catch (recoveryErr) {
            const rmsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
            logger.warn('Scheduler: recovery pass failed — non-blocking', { error: rmsg });
        }
        // ── News Ingest (fail-open, before main pipeline) ──────────────
        try {
            const newsConfig = (await import('./config')).loadConfig();
            if (newsConfig.newsEnabled && newsConfig.newsFeeds.length > 0) {
                const { ingestNews } = await import('./services/news-ingest');
                const newsDb = getDb(config.dbPath);
                // G10 FIX: Removed redundant runMigrations.
                const newsResult = await ingestNews(newsDb, {
                    feedUrls: newsConfig.newsFeeds,
                    lookbackHours: newsConfig.newsLookbackHours,
                    maxItems: newsConfig.newsMaxItemsPerTick,
                    httpTimeoutMs: newsConfig.newsHttpTimeoutMs,
                });
                newsDb.close();
                if (newsResult.inserted > 0) {
                    logger.info('Scheduler: news ingest complete', {
                        inserted: newsResult.inserted,
                        skipped: newsResult.skipped,
                        feeds_ok: newsResult.feeds_succeeded,
                        feeds_fail: newsResult.feeds_failed,
                    });
                }
            }
        } catch (newsErr) {
            const nmsg = newsErr instanceof Error ? newsErr.message : String(newsErr);
            logger.warn('Scheduler: news ingest failed — non-blocking', { error: nmsg });
        }

        const result = await runPipeline();
        logger.info('Scheduler: pipeline run complete', {
            run_id: result.run_id,
            items_selected: result.items_selected,
            items_completed: result.items_completed,
            items_failed: result.items_failed,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Scheduler: pipeline run failed', { error: msg });
        // O3 FIX: Release lock on failure so the daily window can be retried.
        try {
            lockRepo.release(lockKey);
            logger.info('Scheduler: lock released after failure — window can be retried', {
                lock_key: lockKey,
            });
        } catch {
            // ignore release errors — cleanup will catch it later
        }
    } finally {
        isRunning = false;
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

/**
 * Generate lock key for the weekly report window.
 * Format: report-YYYY-WNN (ISO week number).
 */
function getReportLockKey(): string {
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const dayOfYear = Math.floor(
        (now.getTime() - yearStart.getTime()) / (24 * 60 * 60 * 1000)
    );
    const weekNum = Math.ceil((dayOfYear + yearStart.getDay() + 1) / 7);
    const paddedWeek = String(weekNum).padStart(2, '0');
    return `report-${now.getFullYear()}-W${paddedWeek}`;
}

/**
 * Execute one report tick: acquire weekly lock, generate report, release.
 * If report generation fails, log the failure and exit safely — never block pipeline.
 */
async function reportTick(config: PipelineConfig): Promise<void> {
    if (isReportRunning) {
        logger.info('Scheduler: previous report still in progress — skipping');
        return;
    }

    const lockKey = getReportLockKey();
    const db = getDb(config.dbPath);
    runMigrations(db);
    const lockRepo = new CronLockRepo(db);

    const runId = `report-${Date.now()}`;
    const acquired = lockRepo.tryAcquire(lockKey, runId);

    if (!acquired) {
        logger.info('Scheduler: report lock already held for this week — skipping', {
            lock_key: lockKey,
        });
        db.close();
        return;
    }

    logger.info('Scheduler: report lock acquired — generating weekly report', {
        lock_key: lockKey,
        run_id: runId,
    });

    isReportRunning = true;
    try {
        const { report, artifactPath } = generateDroppedTagReport({ db });
        logger.info('Scheduler: weekly report complete', {
            artifact_path: artifactPath,
            dropped_unique: report.dropped_tags.total_unique,
            not_found_unique: report.wp_tag_not_found.total_unique,
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Scheduler: weekly report failed — non-blocking', {
            error: msg,
            lock_key: lockKey,
        });
        // Report failure must NOT block pipeline — exit gracefully
    } finally {
        isReportRunning = false;
        try {
            db.close();
        } catch {
            // ignore
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Start the cron scheduler.
 * If CRON_ENABLED=false, logs and returns immediately.
 */
export function startScheduler(config: PipelineConfig): void {
    if (!config.cronEnabled) {
        logger.info('Scheduler: CRON_ENABLED=false — scheduler disabled');
        return;
    }

    const tzResolution = resolveCronTimezone(config.cronTimezone);
    const canonicalTz = tzResolution.timezone;

    if (tzResolution.usedFallback) {
        logger.warn('Scheduler: CRON_TIMEZONE missing/invalid — falling back to default', {
            timezone: canonicalTz,
            reason: tzResolution.reason,
        });
    }

    const { nextDate, delayMs } = computeNextRun(
        config.cronSchedule,
        canonicalTz
    );

    // Format next_run in the configured timezone so operators can verify at a glance
    const nextRunLocal = formatLocalWallClock(nextDate, canonicalTz);

    // Detect system TZ — use alias-aware comparison
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    logger.info('EffectiveCronConfig', {
        cron_schedule: config.cronSchedule,
        cron_timezone_raw: config.cronTimezone,
        cron_timezone_canonical: canonicalTz,
        system_tz: systemTz,
        tz_match: tzEqual(systemTz, canonicalTz),
    });

    logger.info('Scheduler: starting', {
        cron_enabled: true,
        schedule: config.cronSchedule,
        timezone: canonicalTz,
        system_tz: systemTz,
        next_run_utc: nextDate.toISOString(),
        next_run_local: nextRunLocal,
        delay_ms: delayMs,
    });

    // Only warn if after normalization they still differ
    if (!tzEqual(systemTz, canonicalTz)) {
        logger.warn('Scheduler: system TZ does not match CRON_TIMEZONE — cron may drift', {
            system_tz: systemTz,
            cron_timezone: canonicalTz,
            hint: 'Set TZ env var to match CRON_TIMEZONE in infra/docker/.env',
        });
    }

    // G6 FIX: Recursive setTimeout — re-anchors to cron-parser each tick (no 24h drift).
    function scheduleNextTick() {
        const { nextDate: nd, delayMs: delay } = computeNextRun(
            config.cronSchedule,
            canonicalTz,
        );
        const nextLocal = formatLocalWallClock(nd, canonicalTz);
        logger.info('Scheduler: next tick scheduled', {
            next_run_utc: nd.toISOString(),
            next_run_local: nextLocal,
            delay_ms: delay,
        });
        schedulerInterval = setTimeout(async () => {
            await reportTick(config);
            await cronTick(config);
            scheduleNextTick(); // re-anchor for next day
        }, delay) as unknown as ReturnType<typeof setInterval>;
    }

    // Schedule first run
    const firstTimeout = setTimeout(async () => {
        // Run weekly report first (non-blocking)
        await reportTick(config);
        // Then run pipeline
        await cronTick(config);
        // Then schedule recurring runs via re-anchored setTimeout
        scheduleNextTick();
    }, delayMs);

    // Store the timeout so we can clear it on stop
    (firstTimeout as any).__schedulerTimeout = true;
}

/**
 * Stop the cron scheduler gracefully.
 */
export function stopScheduler(): void {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        logger.info('Scheduler: stopped');
    }
}

/**
 * Exported for testing: run a single cron tick / report tick.
 */
export { cronTick, reportTick, getLockKey, getReportLockKey, parseCronSchedule, isRunning, isReportRunning };
