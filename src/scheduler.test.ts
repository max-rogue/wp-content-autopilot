/**
 * Scheduler Tests — cron toggle, DB-backed lock, timezone-aware next-run.
 * Ref: Part B requirements
 *
 * Tests:
 *   - CRON_ENABLED=false → scheduler does not start
 *   - DB lock prevents two concurrent cron executions
 *   - Lock acquisition and release work correctly
 *   - computeNextRun timezone correctness (cron-parser based)
 *   - Timezone alias normalization (Asia/Saigon == Asia/Ho_Chi_Minh)
 *   - Integration-ish tick delay verification
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './db/migrate';
import { CronLockRepo } from './db/repositories';
import {
    getLockKey,
    parseCronSchedule,
    startScheduler,
    stopScheduler,
    computeNextRun,
    normalizeTz,
    tzEqual,
    resolveCronTimezone,
    formatLocalWallClock,
} from './scheduler';
import type { PipelineConfig } from './config';

function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
    return {
        appEnv: 'test',
        siteBaseUrl: 'http://localhost:8080',
        serviceBaseUrl: 'http://127.0.0.1:3100',
        servicePort: 3100,
        wpBaseUrl: 'http://localhost:8080',
        wpApiUser: 'test',
        wpApplicationPassword: 'test',
        aiProvider: 'openai',
        aiApiKey: '',
        openaiApiKey: '',
        geminiApiKey: '',
        llmResearchProvider: 'openai',
        llmResearchModel: 'gpt-4o',
        llmDraftProvider: 'openai',
        llmDraftModel: 'gpt-4o',
        llmFinalProvider: 'openai',
        llmFinalModel: 'gpt-4o',
        llmImageProvider: 'gemini',
        llmImageModel: 'gemini-2.0-flash',
        llmResearchGrounding: '',
        llmImageRequired: true,
        geminiApiMode: 'genai_sdk',
        mediaProvider: 'none',
        mediaApiKey: '',
        dailyJobQuota: 1,
        publishPosture: 'always_draft' as const,
        requireHumanApproval: false,
        logLevel: 'silent',
        stopOnCoverageSpike: true,
        stopOnIndexDrop: true,
        stopOnFailRate: true,
        indexingLagThreshold: 0.4,
        coverageErrorWowThreshold: 0.2,
        impressionsDropThreshold: 0.25,
        embeddingProvider: 'disabled',
        embeddingEndpoint: '',
        embeddingApiKey: '',
        localDbEnabled: true,
        dbPath: ':memory:',
        keywordCsvPath: './data/keyword.csv',
        cronEnabled: false,
        cronSchedule: '0 6 * * *',
        cronTimezone: 'Asia/Ho_Chi_Minh',
        rankmath: {
            keyTitle: '',
            keyDescription: '',
            keyFocusKeyword: '',
            keyRobots: '',
            keyCanonical: '',
            keySchemaType: '',
        },
        maxConcurrentRuns: 1,
        maxJobsPerTick: 1,
        dailyCostCapUsd: 5,
        perJobCostCapUsd: 1,
        maxRetryAttempts: 3,
        retryBackoffMs: 2000,
        jitterMs: 250,
        recoveryReplayLimit: 20,
        recoveryLookbackMinutes: 60,
        publishPostureSource: 'default' as const,
        internalLinksEnabled: false,
        geminiThinkingLevel: 'HIGH',
        maxOutputTokensResearch: 8192,
        maxOutputTokensDraft: 8192,
        maxOutputTokensFinal: 8192,
        maxOutputTokensHtml: 8192,
        ...overrides,
    };
}

/* ================================================================== */
/*  Timezone alias normalization                                       */
/* ================================================================== */

describe('Scheduler — timezone alias normalization', () => {
    it('normalizeTz maps Asia/Saigon → Asia/Ho_Chi_Minh', () => {
        expect(normalizeTz('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    });

    it('normalizeTz passes through canonical names', () => {
        expect(normalizeTz('Asia/Ho_Chi_Minh')).toBe('Asia/Ho_Chi_Minh');
        expect(normalizeTz('UTC')).toBe('UTC');
        expect(normalizeTz('America/New_York')).toBe('America/New_York');
    });

    it('tzEqual returns true for alias pairs', () => {
        expect(tzEqual('Asia/Saigon', 'Asia/Ho_Chi_Minh')).toBe(true);
        expect(tzEqual('Asia/Ho_Chi_Minh', 'Asia/Saigon')).toBe(true);
    });

    it('tzEqual returns false for genuinely different zones', () => {
        expect(tzEqual('Asia/Ho_Chi_Minh', 'UTC')).toBe(false);
        expect(tzEqual('America/New_York', 'Asia/Ho_Chi_Minh')).toBe(false);
    });

    it('resolveCronTimezone falls back for missing timezone', () => {
        const r = resolveCronTimezone('');
        expect(r.timezone).toBe('Asia/Ho_Chi_Minh');
        expect(r.usedFallback).toBe(true);
        expect(r.reason).toBe('missing');
    });

    it('resolveCronTimezone falls back for invalid timezone', () => {
        const r = resolveCronTimezone('Invalid/Not_A_Zone');
        expect(r.timezone).toBe('Asia/Ho_Chi_Minh');
        expect(r.usedFallback).toBe(true);
        expect(r.reason).toBe('invalid');
    });

    it('resolveCronTimezone canonicalizes aliases without fallback', () => {
        const r = resolveCronTimezone('Asia/Saigon');
        expect(r.timezone).toBe('Asia/Ho_Chi_Minh');
        expect(r.usedFallback).toBe(false);
    });

    it('formatLocalWallClock renders midnight as 00:00 (not 24:00)', () => {
        const d = new Date('2026-02-26T17:00:00.000Z'); // 00:00 in Asia/Ho_Chi_Minh
        const s = formatLocalWallClock(d, 'Asia/Ho_Chi_Minh');
        expect(s).toContain('00:00');
        expect(s).not.toContain('24:00');
    });

    it('formatLocalWallClock renders 00:58 (not 24:58) for midnight + 58 min', () => {
        // 2026-02-28 00:58 Asia/Ho_Chi_Minh = 2026-02-27 17:58 UTC
        const d = new Date('2026-02-27T17:58:00.000Z');
        const s = formatLocalWallClock(d, 'Asia/Ho_Chi_Minh');
        expect(s).toContain('00:58');
        expect(s).not.toContain('24:58');
    });
});

/* ================================================================== */
/*  computeNextRun — timezone-correct next occurrence                  */
/* ================================================================== */

describe('Scheduler — computeNextRun timezone correctness', () => {
    const TZ = 'Asia/Ho_Chi_Minh'; // UTC+7, no DST

    it('after 00:58 local → next run is next day 00:58 local', () => {
        // 2026-02-27 00:59 Asia/Ho_Chi_Minh = 2026-02-26 17:59 UTC
        const now = new Date('2026-02-26T17:59:00.000Z');
        const { nextDate, delayMs } = computeNextRun('58 0 * * *', TZ, now);

        // Next occurrence: 2026-02-28 00:58 local = 2026-02-27 17:58 UTC
        const localStr = nextDate.toLocaleString('en-US', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        expect(localStr).toBe('00:58');

        // UTC should be 7 hours earlier than local
        expect(nextDate.getUTCHours()).toBe(17);
        expect(nextDate.getUTCMinutes()).toBe(58);

        // Date should be next day
        const localDate = nextDate.toLocaleString('en-US', {
            timeZone: TZ,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
        expect(localDate).toBe('02/28/2026');

        expect(delayMs).toBeGreaterThan(0);
    });

    it('before 00:58 local → next run is same day 00:58 local', () => {
        // 2026-02-27 00:10 Asia/Ho_Chi_Minh = 2026-02-26 17:10 UTC
        const now = new Date('2026-02-26T17:10:00.000Z');
        const { nextDate, delayMs } = computeNextRun('58 0 * * *', TZ, now);

        // Next occurrence: 2026-02-27 00:58 local = 2026-02-26 17:58 UTC
        const localStr = nextDate.toLocaleString('en-US', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        expect(localStr).toBe('00:58');

        // UTC conversion: local 00:58 - 7h = 17:58 UTC same day (Feb 26)
        expect(nextDate.getUTCHours()).toBe(17);
        expect(nextDate.getUTCMinutes()).toBe(58);
        expect(nextDate.getUTCDate()).toBe(26); // same UTC day

        // Delay should be exactly 48 minutes
        const expectedDelayMs = 48 * 60 * 1000;
        expect(delayMs).toBe(expectedDelayMs);
    });

    it('UTC conversion is correct: local time minus 7 hours', () => {
        // 2026-02-27 06:00 Asia/Ho_Chi_Minh = 2026-02-26 23:00 UTC
        const now = new Date('2026-02-26T23:00:00.000Z');
        const { nextDate } = computeNextRun('30 8 * * *', TZ, now);

        // Next: 2026-02-27 08:30 local = 2026-02-27 01:30 UTC
        expect(nextDate.getUTCHours()).toBe(1);
        expect(nextDate.getUTCMinutes()).toBe(30);

        const localStr = nextDate.toLocaleString('en-US', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        expect(localStr).toBe('08:30');
    });

    it('works with Asia/Saigon alias (same as Asia/Ho_Chi_Minh)', () => {
        const now = new Date('2026-02-26T17:10:00.000Z');
        const result1 = computeNextRun('58 0 * * *', 'Asia/Ho_Chi_Minh', now);
        const result2 = computeNextRun('58 0 * * *', 'Asia/Saigon', now);

        expect(result1.nextDate.getTime()).toBe(result2.nextDate.getTime());
        expect(result1.delayMs).toBe(result2.delayMs);
    });

    it('works with UTC timezone', () => {
        const now = new Date('2026-02-27T10:00:00.000Z');
        const { nextDate } = computeNextRun('0 12 * * *', 'UTC', now);

        expect(nextDate.getUTCHours()).toBe(12);
        expect(nextDate.getUTCMinutes()).toBe(0);
        expect(nextDate.getUTCDate()).toBe(27); // same day
    });

    it('falls back safely when timezone is invalid', () => {
        const now = new Date('2026-02-26T17:10:00.000Z');
        const fallback = computeNextRun('58 0 * * *', 'Asia/Ho_Chi_Minh', now);
        const invalid = computeNextRun('58 0 * * *', 'Invalid/Not_A_Zone', now);

        expect(invalid.nextDate.getTime()).toBe(fallback.nextDate.getTime());
        expect(invalid.delayMs).toBe(fallback.delayMs);
    });

    it('DST sanity: America/New_York keeps 08:30 local across DST boundary', () => {
        // Before 08:30 local on DST transition day, next should still be same local wall-clock time.
        const now = new Date('2026-03-08T10:00:00.000Z'); // 06:00 local after DST jump
        const { nextDate } = computeNextRun('30 8 * * *', 'America/New_York', now);

        const localStr = nextDate.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });

        expect(localStr).toBe('03/08/2026, 08:30');
        expect(nextDate.toISOString()).toBe('2026-03-08T12:30:00.000Z'); // UTC-4 after DST
    });

    it('midnight (00:00) schedule works correctly', () => {
        // 2026-02-26 23:30 local = 2026-02-26 16:30 UTC
        const now = new Date('2026-02-26T16:30:00.000Z');
        const { nextDate } = computeNextRun('0 0 * * *', TZ, now);

        // Next midnight local = 2026-02-27 00:00 local = 2026-02-26 17:00 UTC
        const localStr = nextDate.toLocaleString('en-US', {
            timeZone: TZ,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        expect(localStr).toBe('00:00');
        expect(nextDate.getUTCHours()).toBe(17);
        expect(nextDate.getUTCMinutes()).toBe(0);
    });
});

/* ================================================================== */
/*  Integration-ish: computed delay matches expected within tolerance  */
/* ================================================================== */

describe('Scheduler — tick delay accuracy', () => {
    const TZ = 'Asia/Ho_Chi_Minh';
    const TOLERANCE_MS = 2000; // 2s tolerance for rounding

    it('delay for known now and target matches expected', () => {
        // now = 2026-02-27 00:10 local (17:10 UTC prev day)
        // target = 00:58 local → 48 minutes = 2,880,000 ms
        const now = new Date('2026-02-26T17:10:00.000Z');
        const { delayMs } = computeNextRun('58 0 * * *', TZ, now);

        const expectedMs = 48 * 60 * 1000;
        expect(Math.abs(delayMs - expectedMs)).toBeLessThan(TOLERANCE_MS);
    });

    it('delay when target already passed today is ~24h minus elapsed', () => {
        // now = 2026-02-27 01:00 local → target 00:58 already passed
        // next = tomorrow 00:58 → ~23h58m
        const now = new Date('2026-02-26T18:00:00.000Z'); // 01:00 local
        const { delayMs } = computeNextRun('58 0 * * *', TZ, now);

        const expectedMs = (23 * 60 + 58) * 60 * 1000;
        expect(Math.abs(delayMs - expectedMs)).toBeLessThan(TOLERANCE_MS);
    });

    it('delay is always positive', () => {
        const now = new Date();
        const { delayMs } = computeNextRun('58 0 * * *', TZ, now);
        expect(delayMs).toBeGreaterThan(0);
    });
});

/* ================================================================== */
/*  CRON_ENABLED toggle (existing tests — kept)                        */
/* ================================================================== */

describe('Scheduler — CRON_ENABLED toggle', () => {
    afterEach(() => {
        stopScheduler();
    });

    it('startScheduler does nothing when cronEnabled=false', () => {
        const config = makeConfig({ cronEnabled: false });
        // Should not throw or start any timers
        expect(() => startScheduler(config)).not.toThrow();
    });

    it('startScheduler starts when cronEnabled=true without throwing', () => {
        const config = makeConfig({ cronEnabled: true });
        // Should not throw — schedules a future timer
        expect(() => startScheduler(config)).not.toThrow();
        // Clean up
        stopScheduler();
    });
});

/* ================================================================== */
/*  DB-backed lock (existing tests — kept)                             */
/* ================================================================== */

/**
 * Probe whether the better-sqlite3 native binary can load on this platform.
 * Returns true when the binary is missing or was cross-compiled for another OS
 * (e.g., Linux binary on a Windows host) — i.e., tests should be SKIPPED.
 *
 * Remediation: run `npm rebuild better-sqlite3` to recompile for the current
 * platform, or add the rebuild step to CI scripts.
 */
const sqliteNativeUnavailable = (() => {
    try {
        const probe = new Database(':memory:');
        probe.close();
        return false; // binary loaded fine — run tests
    } catch {
        return true; // native binary failed — skip tests
    }
})();

describe.skipIf(sqliteNativeUnavailable)('Scheduler — DB-backed lock (CronLockRepo)', () => {
    let db: Database.Database;
    let lockRepo: CronLockRepo;

    beforeEach(() => {
        db = new Database(':memory:');
        db.pragma('journal_mode = WAL');
        runMigrations(db);
        lockRepo = new CronLockRepo(db);
    });

    afterEach(() => {
        db.close();
    });

    it('tryAcquire succeeds on first call', () => {
        const acquired = lockRepo.tryAcquire('cron-2026-02-25', 'run-1');
        expect(acquired).toBe(true);
    });

    it('tryAcquire fails on second call with same key (prevents duplicate)', () => {
        const first = lockRepo.tryAcquire('cron-2026-02-25', 'run-1');
        expect(first).toBe(true);

        const second = lockRepo.tryAcquire('cron-2026-02-25', 'run-2');
        expect(second).toBe(false);
    });

    it('tryAcquire succeeds with different keys', () => {
        const first = lockRepo.tryAcquire('cron-2026-02-25', 'run-1');
        expect(first).toBe(true);

        const second = lockRepo.tryAcquire('cron-2026-02-26', 'run-2');
        expect(second).toBe(true);
    });

    it('release allows re-acquisition of same key', () => {
        lockRepo.tryAcquire('cron-2026-02-25', 'run-1');
        lockRepo.release('cron-2026-02-25');

        const acquired = lockRepo.tryAcquire('cron-2026-02-25', 'run-2');
        expect(acquired).toBe(true);
    });

    it('cleanup removes old locks', () => {
        // Insert a lock manually with old date
        db.prepare(
            "INSERT INTO cron_locks (lock_key, acquired_at, run_id) VALUES (?, datetime('now', '-10 days'), ?)"
        ).run('cron-old', 'run-old');

        lockRepo.cleanup(7);

        // Old lock should be gone
        const acquired = lockRepo.tryAcquire('cron-old', 'run-new');
        expect(acquired).toBe(true);
    });

    it('two concurrent lock attempts: only one succeeds', () => {
        const key = 'cron-concurrent-test';
        const results = [
            lockRepo.tryAcquire(key, 'instance-a'),
            lockRepo.tryAcquire(key, 'instance-b'),
        ];

        // Exactly one should succeed
        expect(results.filter(Boolean).length).toBe(1);
        expect(results.filter((r) => !r).length).toBe(1);
    });
});

/* ================================================================== */
/*  Helper functions (existing tests — kept)                           */
/* ================================================================== */

describe('Scheduler — helper functions', () => {
    it('getLockKey returns cron-YYYY-MM-DD format', () => {
        const key = getLockKey();
        expect(key).toMatch(/^cron-\d{4}-\d{2}-\d{2}$/);
    });

    it('parseCronSchedule extracts hour and minute', () => {
        expect(parseCronSchedule('0 6 * * *')).toEqual({ hour: 6, minute: 0 });
        expect(parseCronSchedule('30 7 * * *')).toEqual({ hour: 7, minute: 30 });
        expect(parseCronSchedule('15 14 * * *')).toEqual({ hour: 14, minute: 15 });
    });

    it('parseCronSchedule defaults to 06:00 on invalid input', () => {
        expect(parseCronSchedule('invalid')).toEqual({ hour: 6, minute: 0 });
    });
});
