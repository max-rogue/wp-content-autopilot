/**
 * Recovery Module Tests
 * Ref: INTERNAL CONFIG — PIPELINE_RECOVERY_REPLAY_LIMIT, PIPELINE_RECOVERY_LOOKBACK_MINUTES
 *
 * Tests:
 *   - Scans for interrupted items within lookback window
 *   - Respects replay limit
 *   - Does NOT replay terminal items
 *   - Items are reset to 'planned' for re-processing
 *   - Recovery is idempotent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanRecoveryCandidates, replayInterrupted, runRecovery } from './recovery';
import type { PipelineConfig } from './config';

// Mock PublishQueueRepo
function createMockQueueRepo(items: any[] = []) {
    return {
        findInterrupted: vi.fn().mockReturnValue(items),
        updateStatus: vi.fn(),
    } as any;
}

function createTestConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
    return {
        recoveryReplayLimit: 20,
        recoveryLookbackMinutes: 60,
        ...overrides,
    } as PipelineConfig;
}

describe('Recovery Module', () => {
    describe('scanRecoveryCandidates', () => {
        it('returns items in interrupted statuses within lookback', () => {
            const items = [
                { id: 'q-1', idempotency_key: 'k-1', status: 'researching', updated_at: new Date().toISOString() },
                { id: 'q-2', idempotency_key: 'k-2', status: 'drafting', updated_at: new Date().toISOString() },
            ];
            const repo = createMockQueueRepo(items);
            const config = createTestConfig();

            const result = scanRecoveryCandidates(repo, config);
            expect(result).toHaveLength(2);
            expect(result[0].id).toBe('q-1');
            expect(result[1].status).toBe('drafting');
        });

        it('passes lookback and limit to repo', () => {
            const repo = createMockQueueRepo([]);
            const config = createTestConfig({ recoveryLookbackMinutes: 30, recoveryReplayLimit: 5 });

            scanRecoveryCandidates(repo, config);
            expect(repo.findInterrupted).toHaveBeenCalledWith(
                expect.arrayContaining(['planned', 'researching', 'drafting', 'qa']),
                expect.any(String),
                5
            );
        });
    });

    describe('replayInterrupted', () => {
        it('resets non-terminal items to planned', () => {
            const candidates = [
                { id: 'q-1', idempotency_key: 'k-1', status: 'researching' as const, updated_at: '' },
                { id: 'q-2', idempotency_key: 'k-2', status: 'qa' as const, updated_at: '' },
            ];
            const repo = createMockQueueRepo();

            const count = replayInterrupted(repo, candidates);
            expect(count).toBe(2);
            expect(repo.updateStatus).toHaveBeenCalledTimes(2);
            expect(repo.updateStatus).toHaveBeenCalledWith('q-1', 'planned', expect.any(Object));
        });

        it('skips terminal items', () => {
            const candidates = [
                { id: 'q-1', idempotency_key: 'k-1', status: 'draft_wp' as const, updated_at: '' },
                { id: 'q-2', idempotency_key: 'k-2', status: 'failed' as const, updated_at: '' },
                { id: 'q-3', idempotency_key: 'k-3', status: 'hold' as const, updated_at: '' },
                { id: 'q-4', idempotency_key: 'k-4', status: 'published' as const, updated_at: '' },
            ];
            const repo = createMockQueueRepo();

            const count = replayInterrupted(repo, candidates);
            expect(count).toBe(0);
            expect(repo.updateStatus).not.toHaveBeenCalled();
        });

        it('returns zero for empty candidates', () => {
            const repo = createMockQueueRepo();
            const count = replayInterrupted(repo, []);
            expect(count).toBe(0);
        });
    });

    describe('runRecovery', () => {
        it('runs full recovery pass: scan + replay', () => {
            const items = [
                { id: 'q-1', idempotency_key: 'k-1', status: 'researching', updated_at: new Date().toISOString() },
            ];
            const repo = createMockQueueRepo(items);
            const config = createTestConfig();

            const result = runRecovery(repo, config);
            expect(result.scanned).toBe(1);
            expect(result.replayed).toBe(1);
            expect(result.skipped).toBe(0);
            expect(result.reasons).toContain('recovery_replay_executed');
        });

        it('reports no_interrupted_items when nothing found', () => {
            const repo = createMockQueueRepo([]);
            const config = createTestConfig();

            const result = runRecovery(repo, config);
            expect(result.scanned).toBe(0);
            expect(result.replayed).toBe(0);
            expect(result.reasons).toContain('no_interrupted_items');
        });
    });
});
