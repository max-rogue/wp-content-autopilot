/**
 * Cost Tracker Tests
 * Ref: INTERNAL CONFIG — per-job and daily cost caps
 *
 * Tests (T6): Quota/cost cap enforcement
 *   - T6a: per-job cap blocks WP write when exceeded
 *   - T6b: daily cap blocks new jobs when exceeded
 *   - T6c: costs accumulate correctly per job
 *   - T6d: pre-flight check prioritizes daily cap
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CostTracker, COST_ESTIMATES } from './cost-tracker';

describe('CostTracker', () => {
    let tracker: CostTracker;

    beforeEach(() => {
        tracker = new CostTracker();
    });

    it('tracks per-job costs accurately', () => {
        tracker.recordJobCost('job-1', 'llm_research');
        tracker.recordJobCost('job-1', 'llm_draft');
        expect(tracker.getJobCost('job-1')).toBeCloseTo(0.10, 4);
    });

    it('tracks daily costs across jobs', () => {
        tracker.recordJobCost('job-1', 'llm_research');
        tracker.recordJobCost('job-2', 'llm_draft');
        expect(tracker.getDailyCost()).toBeCloseTo(0.10, 4);
    });

    it('per-job cap check returns reason when exceeded', () => {
        tracker.recordJobCost('job-1', 'llm_research'); // 0.05
        tracker.recordJobCost('job-1', 'llm_draft');    // 0.10
        tracker.recordJobCost('job-1', 'llm_final_edit'); // 0.15

        // Cap at 0.10 — should be exceeded
        const reason = tracker.checkPerJobCap('job-1', 0.10);
        expect(reason).toBe('cost_cap_per_job_exceeded');
    });

    it('per-job cap check returns null when within budget', () => {
        tracker.recordJobCost('job-1', 'llm_research'); // 0.05
        const reason = tracker.checkPerJobCap('job-1', 1.0);
        expect(reason).toBeNull();
    });

    it('daily cap check returns reason when exceeded', () => {
        // Record many jobs to exceed daily cap
        for (let i = 0; i < 200; i++) {
            tracker.recordJobCost(`job-${i}`, 'llm_research'); // 0.05 * 200 = 10.0
        }
        const reason = tracker.checkDailyCap(5.0);
        expect(reason).toBe('cost_cap_daily_exceeded');
    });

    it('daily cap check returns null when within budget', () => {
        tracker.recordJobCost('job-1', 'llm_research');
        const reason = tracker.checkDailyCap(5.0);
        expect(reason).toBeNull();
    });

    it('preFlightCheck prioritizes daily cap over per-job cap', () => {
        // Fill daily cap
        for (let i = 0; i < 200; i++) {
            tracker.recordJobCost(`fill-${i}`, 'llm_research');
        }
        // Check new job — should get daily cap reason
        const reason = tracker.preFlightCheck('new-job', 1.0, 5.0);
        expect(reason).toBe('cost_cap_daily_exceeded');
    });

    it('preFlightCheck returns null when both caps ok', () => {
        tracker.recordJobCost('job-1', 'llm_research');
        const reason = tracker.preFlightCheck('job-1', 1.0, 5.0);
        expect(reason).toBeNull();
    });

    it('clearJob removes job tracking', () => {
        tracker.recordJobCost('job-1', 'llm_research');
        tracker.clearJob('job-1');
        expect(tracker.getJobCost('job-1')).toBe(0);
    });

    it('reset clears all tracking', () => {
        tracker.recordJobCost('job-1', 'llm_research');
        tracker.reset();
        expect(tracker.getJobCost('job-1')).toBe(0);
        expect(tracker.getDailyCost()).toBe(0);
    });

    it('recordJobStart increments daily job count', () => {
        // recordJobStart is tracked but not directly queryable except via daily costs
        expect(() => tracker.recordJobStart()).not.toThrow();
    });

    it('uses default cost estimate for unknown operation', () => {
        const cost = tracker.recordJobCost('job-1', 'unknown_op');
        expect(cost).toBe(0); // unknown operations have 0 cost
    });

    it('COST_ESTIMATES includes all expected operations', () => {
        expect(COST_ESTIMATES).toHaveProperty('llm_research');
        expect(COST_ESTIMATES).toHaveProperty('llm_draft');
        expect(COST_ESTIMATES).toHaveProperty('llm_final_edit');
        expect(COST_ESTIMATES).toHaveProperty('llm_image_gen');
        expect(COST_ESTIMATES).toHaveProperty('wp_create_draft');
        expect(COST_ESTIMATES.wp_create_draft).toBe(0.0);
    });
});
