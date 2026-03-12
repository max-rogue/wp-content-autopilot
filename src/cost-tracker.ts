/**
 * Cost Tracker — per-job and daily cost guardrails.
 * Ref: INTERNAL CONFIG — not exposed via API.
 *
 * Reason taxonomy:
 *   - cost_cap_per_job_exceeded: job stopped before WP write
 *   - cost_cap_daily_exceeded: new jobs blocked for the rest of the day
 *
 * Cost model (conservative estimates):
 *   - LLM call (research/draft/final): ~$0.05 each
 *   - Image generation: ~$0.04
 *   - WP API call: $0.00 (free)
 *
 * Fail-closed: exceeding caps prevents WP writes.
 */

import { logger } from './logger';

export interface CostEntry {
    operation: string;
    estimatedCost: number;
}

export interface DailyCostSummary {
    date: string;
    totalCost: number;
    jobCount: number;
}

/**
 * Estimated costs per operation type.
 * Conservative values to avoid false negatives.
 */
export const COST_ESTIMATES: Record<string, number> = {
    llm_research: 0.05,
    llm_draft: 0.05,
    llm_final_edit: 0.05,
    llm_image_gen: 0.04,
    wp_create_draft: 0.0,
    wp_update_post: 0.0,
    rankmath_write: 0.0,
    rankmath_verify: 0.0,
};

export class CostTracker {
    private jobCosts = new Map<string, number>();
    private dailyCosts = new Map<string, DailyCostSummary>();

    private todayKey(): string {
        return new Date().toISOString().slice(0, 10);
    }

    /**
     * Record a cost for a specific job.
     * Returns the updated job total.
     */
    recordJobCost(jobId: string, operation: string, cost?: number): number {
        const estimatedCost = cost ?? COST_ESTIMATES[operation] ?? 0;
        const current = this.jobCosts.get(jobId) || 0;
        const updated = current + estimatedCost;
        this.jobCosts.set(jobId, updated);

        // Also update daily total
        const today = this.todayKey();
        const daily = this.dailyCosts.get(today) || { date: today, totalCost: 0, jobCount: 0 };
        daily.totalCost += estimatedCost;
        this.dailyCosts.set(today, daily);

        return updated;
    }

    /**
     * Mark a job as started in the daily count.
     */
    recordJobStart(): void {
        const today = this.todayKey();
        const daily = this.dailyCosts.get(today) || { date: today, totalCost: 0, jobCount: 0 };
        daily.jobCount += 1;
        this.dailyCosts.set(today, daily);
    }

    /**
     * Get current cost for a job.
     */
    getJobCost(jobId: string): number {
        return this.jobCosts.get(jobId) || 0;
    }

    /**
     * Get daily cost total.
     */
    getDailyCost(): number {
        const today = this.todayKey();
        return this.dailyCosts.get(today)?.totalCost || 0;
    }

    /**
     * Check if per-job cost cap would be exceeded.
     * Returns reason string if exceeded, null if ok.
     */
    checkPerJobCap(jobId: string, perJobCapUsd: number): string | null {
        const current = this.getJobCost(jobId);
        if (current >= perJobCapUsd) {
            logger.warn('CostTracker: per-job cost cap exceeded', {
                job_id: jobId,
                current_cost: current.toFixed(4),
                cap: perJobCapUsd,
            });
            return 'cost_cap_per_job_exceeded';
        }
        return null;
    }

    /**
     * Check if daily cost cap would be exceeded.
     * Returns reason string if exceeded, null if ok.
     */
    checkDailyCap(dailyCapUsd: number): string | null {
        const current = this.getDailyCost();
        if (current >= dailyCapUsd) {
            logger.warn('CostTracker: daily cost cap exceeded', {
                current_cost: current.toFixed(4),
                cap: dailyCapUsd,
            });
            return 'cost_cap_daily_exceeded';
        }
        return null;
    }

    /**
     * Full pre-flight check: both per-job and daily caps.
     * Returns null if ok, or the reason code string if blocked.
     */
    preFlightCheck(
        jobId: string,
        perJobCapUsd: number,
        dailyCapUsd: number
    ): string | null {
        // Daily cap takes precedence
        const dailyReason = this.checkDailyCap(dailyCapUsd);
        if (dailyReason) return dailyReason;

        const jobReason = this.checkPerJobCap(jobId, perJobCapUsd);
        if (jobReason) return jobReason;

        return null;
    }

    /**
     * Clear tracking for a specific job (for cleanup).
     */
    clearJob(jobId: string): void {
        this.jobCosts.delete(jobId);
    }

    /**
     * Reset all tracking (for testing).
     */
    reset(): void {
        this.jobCosts.clear();
        this.dailyCosts.clear();
    }
}

/** Singleton instance for the process. */
export const costTracker = new CostTracker();
