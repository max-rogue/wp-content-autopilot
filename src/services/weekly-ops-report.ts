/**
 * Weekly Ops Report Generator.
 * Ref: Deployment §6.6 — Weekly Ops Review Report Contract (MUST)
 *
 * Produces a single JSON report with:
 *   - schema_version: "1.0"
 *   - week_start / week_end (Asia/Ho_Chi_Minh)
 *   - totals per queue status
 *   - taxonomy: aggregated dropped_tags[] + wp_tag_not_found[] with counts
 *   - §6.6 fields: publish_counts, top_hold_reasons, top_draft_reasons,
 *     gate_pass_rate_30d, indexing_lag_14d, coverage_errors_trend,
 *     impressions_clicks_trend, noindex_draft_backlog, needs_refresh_queue,
 *     throttle_actions
 *
 * Fail-closed: if GSC signals unavailable, explicit "data_unavailable" markers.
 * Complementary to dropped-tag-report (which is kept as-is).
 */

import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import type { QueueStatus } from '../types';

// ─── Types ──────────────────────────────────────────────────────

export interface TagAggregate {
    slug: string;
    count: number;
}

export interface ReasonAggregate {
    reason: string;
    count: number;
}

export interface NoindexDraftItem {
    queue_id: string;
    keyword: string;
    reason: string;
}

export interface NeedsRefreshItem {
    queue_id: string;
    keyword: string;
    status: string;
    fail_reasons: string | null;
}

export interface GatePassRate {
    total_gates_evaluated: number;
    total_passed: number;
    pass_rate: number; // 0.0–1.0
}

export interface ThrottleActions {
    current_throttle_state: string;
    current_ramp_state: string;
    daily_quota: number;
    action_history: 'history_unavailable';
}

export interface PublishCounts {
    published: number;
    draft: number;
    hold: number;
    total_attempted: number;
}

export interface WeeklyOpsReport {
    schema_version: '1.0';
    report_type: 'weekly_ops';
    generated_at: string;
    week_start: string;  // Asia/Ho_Chi_Minh local date-time
    week_end: string;    // Asia/Ho_Chi_Minh local date-time
    totals: Record<QueueStatus, number>;
    taxonomy: {
        dropped_tags: TagAggregate[];
        dropped_tags_total: number;
        wp_tag_not_found: TagAggregate[];
        wp_tag_not_found_total: number;
    };

    // §6.6 (1) Publish counts by status
    publish_counts: PublishCounts;

    // §6.6 (2) Top HOLD reasons (top 5) and top DRAFT reasons (top 5)
    top_hold_reasons: ReasonAggregate[];
    top_draft_reasons: ReasonAggregate[];

    // §6.6 (3) Gate pass rate rolling 30 days
    gate_pass_rate_30d: GatePassRate | 'data_unavailable';

    // §6.6 (4) Indexing lag 14d and coverage errors trend
    indexing_lag_14d: number | 'data_unavailable';
    coverage_errors_trend: Array<{ date: string; count: number }> | 'data_unavailable';

    // §6.6 (5) Impressions/clicks trend
    impressions_clicks_trend: Array<{
        date: string; impressions: number; clicks: number;
    }> | 'data_unavailable';

    // §6.6 (6) NOINDEX_DRAFT backlog list with reason per item
    noindex_draft_backlog: NoindexDraftItem[];

    // §6.6 (7) NEEDS_REFRESH queue list
    needs_refresh_queue: NeedsRefreshItem[];

    // §6.6 (8) Actions taken for throttle/cadence changes
    throttle_actions: ThrottleActions;
}

// ─── Helpers ────────────────────────────────────────────────────

const ASIA_HCM = 'Asia/Ho_Chi_Minh';

/**
 * Format a Date as Asia/Ho_Chi_Minh local ISO-like string.
 * Returns e.g. "2026-02-27T20:52:28+07:00"
 */
function formatHCM(date: Date): string {
    // Use Intl to get local time parts
    const fmt = new Intl.DateTimeFormat('sv-SE', {
        timeZone: ASIA_HCM,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+07:00`;
}

/**
 * Safely parse a JSON string array, returning [] on failure.
 */
function safeParseArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === 'string');
    } catch {
        // malformed JSON — skip
    }
    return [];
}

/**
 * Safely parse a JSON object, returning null on failure.
 */
function safeParseJson(raw: string | null): unknown {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Aggregate tag slugs into sorted TagAggregate[] (desc by count, then alpha).
 */
function aggregateTags(allTags: string[]): TagAggregate[] {
    const map = new Map<string, number>();
    for (const tag of allTags) {
        const slug = tag.trim().toLowerCase();
        if (!slug) continue;
        map.set(slug, (map.get(slug) || 0) + 1);
    }
    return [...map.entries()]
        .map(([slug, count]) => ({ slug, count }))
        .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.slug.localeCompare(b.slug);
        });
}

/**
 * Aggregate reason strings into sorted ReasonAggregate[] (desc by count, then alpha).
 * Returns at most `limit` entries.
 */
function aggregateReasons(allReasons: string[], limit: number): ReasonAggregate[] {
    const map = new Map<string, number>();
    for (const reason of allReasons) {
        const r = reason.trim();
        if (!r) continue;
        map.set(r, (map.get(r) || 0) + 1);
    }
    return [...map.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.reason.localeCompare(b.reason);
        })
        .slice(0, limit);
}

/**
 * Extract reasons from fail_reasons (JSON string array) and gate_results
 * (JSON array of {gate_id, status, reasons}).
 */
function extractReasons(failReasons: string | null, gateResults: string | null): string[] {
    const reasons: string[] = [];

    // From fail_reasons (JSON string array)
    const fr = safeParseArray(failReasons);
    reasons.push(...fr);

    // From gate_results (JSON array of GateResult objects)
    const gr = safeParseJson(gateResults);
    if (Array.isArray(gr)) {
        for (const gate of gr) {
            if (gate && typeof gate === 'object' && Array.isArray(gate.reasons)) {
                reasons.push(...gate.reasons.filter((r: unknown) => typeof r === 'string'));
            }
        }
    }

    return reasons;
}

// ─── Report Generator ───────────────────────────────────────────

export interface WeeklyOpsReportOptions {
    db: Database.Database;
    windowDays?: number; // default 7
    outputDir?: string;
}

/**
 * Generate the weekly ops report.
 *
 * @returns The report object and the artifact file path.
 */
export function generateWeeklyOpsReport(
    options: WeeklyOpsReportOptions
): { report: WeeklyOpsReport; artifactPath: string } {
    const { db, windowDays = 7 } = options;
    const outputDir =
        options.outputDir || path.resolve(__dirname, '..', '..', 'logs');

    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    // ── 1. Status totals within the window ──────────────────────
    const statusRows = db
        .prepare(
            `SELECT status, COUNT(*) as cnt FROM publish_queue
             WHERE updated_at >= datetime('now', '-' || ? || ' days')
             GROUP BY status`
        )
        .all(windowDays) as Array<{ status: string; cnt: number }>;

    const totals: Record<string, number> = {
        planned: 0,
        researching: 0,
        drafting: 0,
        qa: 0,
        draft_wp: 0,
        published: 0,
        hold: 0,
        failed: 0,
    };
    for (const row of statusRows) {
        if (row.status in totals) {
            totals[row.status] = row.cnt;
        }
    }

    // ── 2. Taxonomy aggregation ─────────────────────────────────
    const tagRows = db
        .prepare(
            `SELECT dropped_tags, wp_tag_not_found FROM publish_queue
             WHERE (dropped_tags IS NOT NULL OR wp_tag_not_found IS NOT NULL)
               AND updated_at >= datetime('now', '-' || ? || ' days')`
        )
        .all(windowDays) as Array<{ dropped_tags: string | null; wp_tag_not_found: string | null }>;

    const allDropped: string[] = [];
    const allNotFound: string[] = [];
    for (const row of tagRows) {
        allDropped.push(...safeParseArray(row.dropped_tags));
        allNotFound.push(...safeParseArray(row.wp_tag_not_found));
    }

    const droppedAgg = aggregateTags(allDropped);
    const notFoundAgg = aggregateTags(allNotFound);

    // ── 3. §6.6 (1): Publish counts by status ──────────────────
    const publishCounts: PublishCounts = {
        published: totals.published,
        draft: totals.draft_wp,
        hold: totals.hold,
        total_attempted: totals.researching + totals.drafting + totals.qa
            + totals.draft_wp + totals.published + totals.hold + totals.failed,
    };

    // ── 4. §6.6 (2): Top HOLD reasons (top 5) + DRAFT reasons (top 5)
    const holdReasonRows = db
        .prepare(
            `SELECT fail_reasons, gate_results FROM publish_queue
             WHERE status = 'hold'
               AND updated_at >= datetime('now', '-' || ? || ' days')`
        )
        .all(windowDays) as Array<{ fail_reasons: string | null; gate_results: string | null }>;

    const allHoldReasons: string[] = [];
    for (const row of holdReasonRows) {
        allHoldReasons.push(...extractReasons(row.fail_reasons, row.gate_results));
    }
    const topHoldReasons = aggregateReasons(allHoldReasons, 5);

    const draftReasonRows = db
        .prepare(
            `SELECT fail_reasons, gate_results FROM publish_queue
             WHERE status = 'draft_wp'
               AND updated_at >= datetime('now', '-' || ? || ' days')`
        )
        .all(windowDays) as Array<{ fail_reasons: string | null; gate_results: string | null }>;

    const allDraftReasons: string[] = [];
    for (const row of draftReasonRows) {
        allDraftReasons.push(...extractReasons(row.fail_reasons, row.gate_results));
    }
    const topDraftReasons = aggregateReasons(allDraftReasons, 5);

    // ── 5. §6.6 (3): Gate pass rate rolling 30 days ─────────────
    let gatePassRate30d: GatePassRate | 'data_unavailable' = 'data_unavailable';
    try {
        const gateRows = db
            .prepare(
                `SELECT gate_results FROM publish_queue
                 WHERE gate_results IS NOT NULL
                   AND updated_at >= datetime('now', '-30 days')`
            )
            .all() as Array<{ gate_results: string }>;

        let totalGates = 0;
        let totalPassed = 0;
        for (const row of gateRows) {
            const parsed = safeParseJson(row.gate_results);
            if (Array.isArray(parsed)) {
                for (const gate of parsed) {
                    if (gate && typeof gate === 'object' && 'status' in gate) {
                        totalGates++;
                        if (gate.status === 'PASS') totalPassed++;
                    }
                }
            }
        }

        gatePassRate30d = {
            total_gates_evaluated: totalGates,
            total_passed: totalPassed,
            pass_rate: totalGates > 0 ? Math.round((totalPassed / totalGates) * 10000) / 10000 : 0,
        };
    } catch {
        gatePassRate30d = 'data_unavailable';
    }

    // ── 6. §6.6 (4): indexing_lag_14d + coverage_errors_trend ──
    // No GSC table — fail-closed with explicit markers
    const indexingLag14d: number | 'data_unavailable' = 'data_unavailable';
    const coverageErrorsTrend: Array<{ date: string; count: number }> | 'data_unavailable' = 'data_unavailable';

    // ── 7. §6.6 (5): impressions/clicks trend ──────────────────
    // No GSC table — fail-closed with explicit markers
    const impressionsClicksTrend: Array<{ date: string; impressions: number; clicks: number }> | 'data_unavailable' = 'data_unavailable';

    // ── 8. §6.6 (6): NOINDEX_DRAFT backlog ─────────────────────
    let noindexDraftBacklog: NoindexDraftItem[] = [];
    try {
        const noindexRows = db
            .prepare(
                `SELECT id, picked_keyword, fail_reasons FROM publish_queue
                 WHERE robots_decision = 'noindex,follow'
                   AND status = 'draft_wp'`
            )
            .all() as Array<{ id: string; picked_keyword: string; fail_reasons: string | null }>;

        noindexDraftBacklog = noindexRows.map(row => ({
            queue_id: row.id,
            keyword: row.picked_keyword,
            reason: row.fail_reasons || 'no_reason_recorded',
        }));
    } catch {
        noindexDraftBacklog = [];
    }

    // ── 9. §6.6 (7): NEEDS_REFRESH queue ───────────────────────
    let needsRefreshQueue: NeedsRefreshItem[] = [];
    try {
        const refreshRows = db
            .prepare(
                `SELECT id, picked_keyword, status, fail_reasons FROM publish_queue
                 WHERE status IN ('hold', 'failed')`
            )
            .all() as Array<{ id: string; picked_keyword: string; status: string; fail_reasons: string | null }>;

        needsRefreshQueue = refreshRows.map(row => ({
            queue_id: row.id,
            keyword: row.picked_keyword,
            status: row.status,
            fail_reasons: row.fail_reasons,
        }));
    } catch {
        needsRefreshQueue = [];
    }

    // ── 10. §6.6 (8): Throttle/cadence actions ─────────────────
    let throttleActions: ThrottleActions = {
        current_throttle_state: 'active',
        current_ramp_state: 'ramp_1',
        daily_quota: 1,
        action_history: 'history_unavailable',
    };
    try {
        const settingsRow = db
            .prepare(`SELECT * FROM settings WHERE id = 1`)
            .get() as { throttle_state?: string; ramp_state?: string; daily_quota?: number } | undefined;

        if (settingsRow) {
            throttleActions = {
                current_throttle_state: settingsRow.throttle_state || 'active',
                current_ramp_state: settingsRow.ramp_state || 'ramp_1',
                daily_quota: settingsRow.daily_quota ?? 1,
                action_history: 'history_unavailable',
            };
        }
    } catch {
        // settings table may not exist in test contexts — use defaults
    }

    // ── 11. Build report ────────────────────────────────────────
    const report: WeeklyOpsReport = {
        schema_version: '1.0',
        report_type: 'weekly_ops',
        generated_at: now.toISOString(),
        week_start: formatHCM(windowStart),
        week_end: formatHCM(now),
        totals: totals as Record<QueueStatus, number>,
        taxonomy: {
            dropped_tags: droppedAgg,
            dropped_tags_total: allDropped.length,
            wp_tag_not_found: notFoundAgg,
            wp_tag_not_found_total: allNotFound.length,
        },
        publish_counts: publishCounts,
        top_hold_reasons: topHoldReasons,
        top_draft_reasons: topDraftReasons,
        gate_pass_rate_30d: gatePassRate30d,
        indexing_lag_14d: indexingLag14d,
        coverage_errors_trend: coverageErrorsTrend,
        impressions_clicks_trend: impressionsClicksTrend,
        noindex_draft_backlog: noindexDraftBacklog,
        needs_refresh_queue: needsRefreshQueue,
        throttle_actions: throttleActions,
    };

    // ── 12. Write artifact ──────────────────────────────────────
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = `weekly-ops-report-${now.toISOString().slice(0, 10)}.json`;
    const artifactPath = path.join(outputDir, filename)
        .split(path.sep)
        .join('/'); // normalize for cross-platform deterministic logs

    fs.writeFileSync(
        path.join(outputDir, filename),
        JSON.stringify(report, null, 2),
        'utf-8'
    );

    // ── 13. Log summary (no secrets) ────────────────────────────
    logger.info('Weekly ops report generated', {
        window_days: windowDays,
        week_start: report.week_start,
        week_end: report.week_end,
        total_statuses: totals,
        publish_counts: publishCounts,
        hold_reasons_count: topHoldReasons.length,
        draft_reasons_count: topDraftReasons.length,
        gate_pass_rate_30d: typeof gatePassRate30d === 'string' ? gatePassRate30d : gatePassRate30d.pass_rate,
        noindex_draft_count: noindexDraftBacklog.length,
        needs_refresh_count: needsRefreshQueue.length,
        dropped_tags_count: allDropped.length,
        wp_tag_not_found_count: allNotFound.length,
        artifact_path: artifactPath,
    });

    return { report, artifactPath };
}
