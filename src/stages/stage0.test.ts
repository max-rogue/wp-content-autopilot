/**
 * Stage 0 Tests — quota resolution with PIPELINE_DAILY_QUOTA env override.
 * Validates Option A: effectiveQuota = envOverride ?? dbQuota (no DB writes).
 */

import { describe, it, expect, vi } from 'vitest';
import { runStage0 } from './stage0';
import type { SettingsRow, PublishQueueRow } from '../types';
import type { SettingsRepo, PublishQueueRepo } from '../db/repositories';

function makeSettingsRepo(settings: Partial<SettingsRow> = {}): SettingsRepo {
    const row: SettingsRow = {
        daily_quota: 5,
        ramp_state: 'ramp_1',
        throttle_state: 'active',
        last_run_at: null,
        ...settings,
    };
    return {
        get: vi.fn(() => row),
        update: vi.fn(),
    } as unknown as SettingsRepo;
}

function makeQueueRepo(planned: Array<{ id: string }>): PublishQueueRepo {
    return {
        findPlannedForRun: vi.fn((_limit: number) => planned as PublishQueueRow[]),
    } as unknown as PublishQueueRepo;
}

describe('Stage 0 — effective quota resolution', () => {
    it('uses DB quota when PIPELINE_DAILY_QUOTA is not set (backward compat)', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 3 });
        const queueRepo = makeQueueRepo([{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }]);

        const result = runStage0({ settingsRepo, queueRepo });

        expect(result.target_posts_count).toBe(3);
        expect(result.selected_queue_ids).toEqual(['q1', 'q2', 'q3']);
        expect(result.quota_reason).toBe('ok');
        // queueRepo should have been called with DB quota
        expect(queueRepo.findPlannedForRun).toHaveBeenCalledWith(3);
    });

    it('uses DB quota when pipelineDailyQuota is explicitly undefined', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 4 });
        const queueRepo = makeQueueRepo([{ id: 'q1' }]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: undefined });

        expect(result.target_posts_count).toBe(1);
        expect(queueRepo.findPlannedForRun).toHaveBeenCalledWith(4);
    });

    it('overrides DB quota when PIPELINE_DAILY_QUOTA=10', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 3 });
        const queueRepo = makeQueueRepo([
            { id: 'q1' }, { id: 'q2' }, { id: 'q3' },
            { id: 'q4' }, { id: 'q5' }, { id: 'q6' },
        ]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: 10 });

        // env override = 10, but only 6 planned items exist
        expect(result.target_posts_count).toBe(6);
        expect(result.quota_reason).toBe('ok');
        expect(queueRepo.findPlannedForRun).toHaveBeenCalledWith(10);
    });

    it('overrides DB quota when PIPELINE_DAILY_QUOTA=0 → quota exhausted', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 5 });
        const queueRepo = makeQueueRepo([{ id: 'q1' }]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: 0 });

        expect(result.target_posts_count).toBe(0);
        expect(result.quota_reason).toBe('quota_exhausted');
        expect(result.selected_queue_ids).toEqual([]);
        // queueRepo.findPlannedForRun should NOT be called when target=0
        expect(queueRepo.findPlannedForRun).not.toHaveBeenCalled();
    });

    it('env override=1 with throttle_state=reduced → target stays 1 (max(1, floor(1/2)))', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 10, throttle_state: 'reduced' });
        const queueRepo = makeQueueRepo([{ id: 'q1' }]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: 1 });

        expect(result.target_posts_count).toBe(1);
        expect(result.quota_reason).toBe('ok');
        // reduced halves: max(1, floor(1/2)) = max(1, 0) = 1
        expect(queueRepo.findPlannedForRun).toHaveBeenCalledWith(1);
    });

    it('env override=6 with throttle_state=reduced → target=3', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 10, throttle_state: 'reduced' });
        const queueRepo = makeQueueRepo([{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: 6 });

        // reduced halves: max(1, floor(6/2)) = 3
        expect(result.target_posts_count).toBe(3);
        expect(queueRepo.findPlannedForRun).toHaveBeenCalledWith(3);
    });

    it('throttle_state=paused still blocks even with env override', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 5, throttle_state: 'paused' });
        const queueRepo = makeQueueRepo([{ id: 'q1' }]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: 100 });

        expect(result.target_posts_count).toBe(0);
        expect(result.quota_reason).toBe('throttle_paused');
    });

    it('no planned items returns no_planned_items regardless of quota', () => {
        const settingsRepo = makeSettingsRepo({ daily_quota: 5 });
        const queueRepo = makeQueueRepo([]);

        const result = runStage0({ settingsRepo, queueRepo, pipelineDailyQuota: 10 });

        expect(result.target_posts_count).toBe(0);
        expect(result.quota_reason).toBe('no_planned_items');
    });
});
