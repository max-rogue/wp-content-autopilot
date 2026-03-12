/**
 * Weekly Ops Report Tests.
 *
 * Covers:
 *   - Report shape: all required fields present (including §6.6 additions)
 *   - schema_version is "1.0"
 *   - week_start / week_end are valid date strings in +07:00
 *   - Status totals include all 8 queue statuses
 *   - Taxonomy aggregation (dropped_tags + wp_tag_not_found)
 *   - Empty DB produces zero-filled report correctly
 *   - §6.6 (1): publish_counts shape and correctness
 *   - §6.6 (2): top_hold_reasons / top_draft_reasons (top 5)
 *   - §6.6 (3): gate_pass_rate_30d
 *   - §6.6 (4): indexing_lag_14d + coverage_errors_trend → data_unavailable
 *   - §6.6 (5): impressions_clicks_trend → data_unavailable
 *   - §6.6 (6): noindex_draft_backlog
 *   - §6.6 (7): needs_refresh_queue
 *   - §6.6 (8): throttle_actions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { generateWeeklyOpsReport } from './weekly-ops-report';
import type { WeeklyOpsReport } from './weekly-ops-report';

const TEST_DB_PATH = path.resolve(__dirname, '../../data/test-weekly-ops.db');
const TEST_OUTPUT_DIR = path.resolve(__dirname, '../../data/test-weekly-ops-output');

function createTestDb(): Database.Database {
    const dir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(TEST_DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS publish_queue (
            id TEXT PRIMARY KEY,
            picked_keyword TEXT NOT NULL,
            normalized_keyword TEXT NOT NULL,
            language TEXT NOT NULL DEFAULT 'vi',
            idempotency_key TEXT NOT NULL UNIQUE,
            cluster TEXT NOT NULL DEFAULT '',
            content_type TEXT NOT NULL CHECK(content_type IN ('BlogPost','Glossary','CategoryPage','LandingSection')),
            status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','researching','drafting','qa','draft_wp','published','hold','failed')),
            scheduled_for TEXT,
            published_url TEXT,
            published_wp_id INTEGER,
            fail_reasons TEXT,
            model_trace TEXT,
            similarity_score REAL,
            similarity_band TEXT CHECK(similarity_band IS NULL OR similarity_band IN ('PASS','DRAFT','HOLD')),
            robots_decision TEXT CHECK(robots_decision IS NULL OR robots_decision IN ('index,follow','noindex,follow')),
            gate_results TEXT,
            dropped_tags TEXT,
            wp_tag_not_found TEXT,
            canonical_category TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);

    // Settings table for §6.6 (8)
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            daily_quota INTEGER NOT NULL DEFAULT 1,
            ramp_state TEXT NOT NULL DEFAULT 'ramp_1' CHECK(ramp_state IN ('ramp_1','ramp_2','ramp_3','steady')),
            throttle_state TEXT NOT NULL DEFAULT 'active' CHECK(throttle_state IN ('active','reduced','paused')),
            last_run_at TEXT
        );
        INSERT OR IGNORE INTO settings (id, daily_quota, ramp_state, throttle_state) VALUES (1, 1, 'ramp_1', 'active');
    `);

    return db;
}

function insertRow(
    db: Database.Database,
    overrides: {
        status?: string;
        dropped_tags?: string | null;
        wp_tag_not_found?: string | null;
        fail_reasons?: string | null;
        gate_results?: string | null;
        robots_decision?: string | null;
    } = {}
): string {
    const id = uuid();
    db.prepare(`
        INSERT INTO publish_queue (
            id, picked_keyword, normalized_keyword, language, idempotency_key,
            cluster, content_type, status, dropped_tags, wp_tag_not_found,
            fail_reasons, gate_results, robots_decision
        ) VALUES (?, 'test keyword', 'test keyword', 'vi', ?, '', 'BlogPost', ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        `idem-${id}`,
        overrides.status ?? 'planned',
        overrides.dropped_tags ?? null,
        overrides.wp_tag_not_found ?? null,
        overrides.fail_reasons ?? null,
        overrides.gate_results ?? null,
        overrides.robots_decision ?? null
    );
    return id;
}

function cleanUp(): void {
    try { if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH); } catch { /* */ }
    try { if (fs.existsSync(TEST_OUTPUT_DIR)) fs.rmSync(TEST_OUTPUT_DIR, { recursive: true }); } catch { /* */ }
}

describe('generateWeeklyOpsReport', () => {
    beforeEach(() => {
        cleanUp();
    });

    afterEach(() => {
        cleanUp();
    });

    it('report has schema_version "1.0"', () => {
        const db = createTestDb();
        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.schema_version).toBe('1.0');
    });

    it('report has report_type "weekly_ops"', () => {
        const db = createTestDb();
        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.report_type).toBe('weekly_ops');
    });

    it('report has required shape: all fields present (including §6.6)', () => {
        const db = createTestDb();
        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        // Original top-level fields
        expect(report).toHaveProperty('schema_version');
        expect(report).toHaveProperty('report_type');
        expect(report).toHaveProperty('generated_at');
        expect(report).toHaveProperty('week_start');
        expect(report).toHaveProperty('week_end');
        expect(report).toHaveProperty('totals');
        expect(report).toHaveProperty('taxonomy');

        // Totals shape: all 8 statuses
        const expectedStatuses = [
            'planned', 'researching', 'drafting', 'qa',
            'draft_wp', 'published', 'hold', 'failed',
        ];
        for (const s of expectedStatuses) {
            expect(report.totals).toHaveProperty(s);
            expect(typeof (report.totals as Record<string, number>)[s]).toBe('number');
        }

        // Taxonomy shape
        expect(report.taxonomy).toHaveProperty('dropped_tags');
        expect(report.taxonomy).toHaveProperty('dropped_tags_total');
        expect(report.taxonomy).toHaveProperty('wp_tag_not_found');
        expect(report.taxonomy).toHaveProperty('wp_tag_not_found_total');
        expect(Array.isArray(report.taxonomy.dropped_tags)).toBe(true);
        expect(Array.isArray(report.taxonomy.wp_tag_not_found)).toBe(true);

        // §6.6 fields
        expect(report).toHaveProperty('publish_counts');
        expect(report.publish_counts).toHaveProperty('published');
        expect(report.publish_counts).toHaveProperty('draft');
        expect(report.publish_counts).toHaveProperty('hold');
        expect(report.publish_counts).toHaveProperty('total_attempted');

        expect(report).toHaveProperty('top_hold_reasons');
        expect(Array.isArray(report.top_hold_reasons)).toBe(true);

        expect(report).toHaveProperty('top_draft_reasons');
        expect(Array.isArray(report.top_draft_reasons)).toBe(true);

        expect(report).toHaveProperty('gate_pass_rate_30d');

        expect(report).toHaveProperty('indexing_lag_14d');
        expect(report).toHaveProperty('coverage_errors_trend');
        expect(report).toHaveProperty('impressions_clicks_trend');

        expect(report).toHaveProperty('noindex_draft_backlog');
        expect(Array.isArray(report.noindex_draft_backlog)).toBe(true);

        expect(report).toHaveProperty('needs_refresh_queue');
        expect(Array.isArray(report.needs_refresh_queue)).toBe(true);

        expect(report).toHaveProperty('throttle_actions');
        expect(report.throttle_actions).toHaveProperty('current_throttle_state');
        expect(report.throttle_actions).toHaveProperty('current_ramp_state');
        expect(report.throttle_actions).toHaveProperty('daily_quota');
        expect(report.throttle_actions).toHaveProperty('action_history');
    });

    it('week_start / week_end contain +07:00 timezone', () => {
        const db = createTestDb();
        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.week_start).toContain('+07:00');
        expect(report.week_end).toContain('+07:00');
    });

    it('empty DB returns zero totals and safe defaults for §6.6 fields', () => {
        const db = createTestDb();
        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        for (const count of Object.values(report.totals)) {
            expect(count).toBe(0);
        }
        expect(report.taxonomy.dropped_tags).toEqual([]);
        expect(report.taxonomy.dropped_tags_total).toBe(0);
        expect(report.taxonomy.wp_tag_not_found).toEqual([]);
        expect(report.taxonomy.wp_tag_not_found_total).toBe(0);

        // §6.6 safe defaults
        expect(report.publish_counts.published).toBe(0);
        expect(report.publish_counts.draft).toBe(0);
        expect(report.publish_counts.hold).toBe(0);
        expect(report.publish_counts.total_attempted).toBe(0);

        expect(report.top_hold_reasons).toEqual([]);
        expect(report.top_draft_reasons).toEqual([]);

        expect(report.gate_pass_rate_30d).toEqual({
            total_gates_evaluated: 0,
            total_passed: 0,
            pass_rate: 0,
        });

        expect(report.indexing_lag_14d).toBe('data_unavailable');
        expect(report.coverage_errors_trend).toBe('data_unavailable');
        expect(report.impressions_clicks_trend).toBe('data_unavailable');

        expect(report.noindex_draft_backlog).toEqual([]);
        expect(report.needs_refresh_queue).toEqual([]);

        expect(report.throttle_actions.current_throttle_state).toBe('active');
        expect(report.throttle_actions.current_ramp_state).toBe('ramp_1');
        expect(report.throttle_actions.daily_quota).toBe(1);
        expect(report.throttle_actions.action_history).toBe('history_unavailable');
    });

    it('counts statuses correctly', () => {
        const db = createTestDb();

        insertRow(db, { status: 'planned' });
        insertRow(db, { status: 'planned' });
        insertRow(db, { status: 'published' });
        insertRow(db, { status: 'failed' });
        insertRow(db, { status: 'draft_wp' });

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.totals.planned).toBe(2);
        expect(report.totals.published).toBe(1);
        expect(report.totals.failed).toBe(1);
        expect(report.totals.draft_wp).toBe(1);
        expect(report.totals.researching).toBe(0);
    });

    it('aggregates dropped_tags and wp_tag_not_found', () => {
        const db = createTestDb();

        insertRow(db, {
            status: 'published',
            dropped_tags: JSON.stringify(['golf-tips', 'golf-tips', 'swing-basics']),
            wp_tag_not_found: JSON.stringify(['seo-golf']),
        });
        insertRow(db, {
            status: 'published',
            dropped_tags: JSON.stringify(['golf-tips']),
            wp_tag_not_found: JSON.stringify(['seo-golf', 'course-review']),
        });

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        // dropped_tags: golf-tips=3, swing-basics=1
        expect(report.taxonomy.dropped_tags_total).toBe(4);
        expect(report.taxonomy.dropped_tags.length).toBe(2);
        expect(report.taxonomy.dropped_tags[0].slug).toBe('golf-tips');
        expect(report.taxonomy.dropped_tags[0].count).toBe(3);
        expect(report.taxonomy.dropped_tags[1].slug).toBe('swing-basics');
        expect(report.taxonomy.dropped_tags[1].count).toBe(1);

        // wp_tag_not_found: seo-golf=2, course-review=1
        expect(report.taxonomy.wp_tag_not_found_total).toBe(3);
        expect(report.taxonomy.wp_tag_not_found[0].slug).toBe('seo-golf');
        expect(report.taxonomy.wp_tag_not_found[0].count).toBe(2);
    });

    it('writes artifact file to disk', () => {
        const db = createTestDb();
        const { artifactPath } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        // Normalize path for fs check (cross-platform)
        const fsPath = artifactPath.split('/').join(path.sep);
        expect(fs.existsSync(fsPath)).toBe(true);

        const content = JSON.parse(fs.readFileSync(fsPath, 'utf-8')) as WeeklyOpsReport;
        expect(content.schema_version).toBe('1.0');
        expect(content.report_type).toBe('weekly_ops');
    });

    // ─── §6.6 (1): publish_counts ──────────────────────────────

    it('§6.6 (1): publish_counts are correct', () => {
        const db = createTestDb();

        insertRow(db, { status: 'published' });
        insertRow(db, { status: 'published' });
        insertRow(db, { status: 'draft_wp' });
        insertRow(db, { status: 'hold' });
        insertRow(db, { status: 'hold' });
        insertRow(db, { status: 'hold' });
        insertRow(db, { status: 'failed' });
        insertRow(db, { status: 'researching' });
        insertRow(db, { status: 'planned' }); // planned not counted in total_attempted

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.publish_counts.published).toBe(2);
        expect(report.publish_counts.draft).toBe(1);  // draft_wp mapped to draft
        expect(report.publish_counts.hold).toBe(3);
        // total_attempted = researching(1) + drafting(0) + qa(0) + draft_wp(1) + published(2) + hold(3) + failed(1)
        expect(report.publish_counts.total_attempted).toBe(8);
    });

    // ─── §6.6 (2): Top HOLD and DRAFT reasons ─────────────────

    it('§6.6 (2): top_hold_reasons returns top 5 sorted by count', () => {
        const db = createTestDb();

        // Insert hold rows with fail_reasons
        insertRow(db, { status: 'hold', fail_reasons: JSON.stringify(['similarity_too_high', 'doorway_detected']) });
        insertRow(db, { status: 'hold', fail_reasons: JSON.stringify(['similarity_too_high']) });
        insertRow(db, { status: 'hold', fail_reasons: JSON.stringify(['similarity_too_high', 'template_mismatch']) });
        insertRow(db, { status: 'hold', fail_reasons: JSON.stringify(['doorway_detected']) });

        // This non-hold row should NOT contribute to hold reasons
        insertRow(db, { status: 'published', fail_reasons: JSON.stringify(['unrelated_reason']) });

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.top_hold_reasons.length).toBeGreaterThan(0);
        expect(report.top_hold_reasons.length).toBeLessThanOrEqual(5);
        // similarity_too_high=3, doorway_detected=2, template_mismatch=1
        expect(report.top_hold_reasons[0].reason).toBe('similarity_too_high');
        expect(report.top_hold_reasons[0].count).toBe(3);
        expect(report.top_hold_reasons[1].reason).toBe('doorway_detected');
        expect(report.top_hold_reasons[1].count).toBe(2);
    });

    it('§6.6 (2): top_draft_reasons from gate_results', () => {
        const db = createTestDb();

        const gateResults = JSON.stringify([
            { gate_id: 'G3_LOCAL_DOORWAY', status: 'DRAFT', reasons: ['no_verified_local_entry'] },
            { gate_id: 'G2_SIMILARITY', status: 'DRAFT', reasons: ['similarity_band_DRAFT'] },
        ]);
        insertRow(db, { status: 'draft_wp', gate_results: gateResults });
        insertRow(db, { status: 'draft_wp', gate_results: gateResults });
        insertRow(db, { status: 'draft_wp', fail_reasons: JSON.stringify(['stage6_rollback']) });

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.top_draft_reasons.length).toBeGreaterThan(0);
        expect(report.top_draft_reasons.length).toBeLessThanOrEqual(5);
        // no_verified_local_entry=2, similarity_band_DRAFT=2, stage6_rollback=1
        expect(report.top_draft_reasons[0].count).toBe(2);
        expect(report.top_draft_reasons[2].reason).toBe('stage6_rollback');
        expect(report.top_draft_reasons[2].count).toBe(1);
    });

    // ─── §6.6 (3): gate_pass_rate_30d ──────────────────────────

    it('§6.6 (3): gate_pass_rate_30d computes correctly', () => {
        const db = createTestDb();

        const gatesPassed = JSON.stringify([
            { gate_id: 'G1_KEYWORD_DEDUP', status: 'PASS', reasons: [] },
            { gate_id: 'G2_SIMILARITY', status: 'PASS', reasons: [] },
            { gate_id: 'G4_FACT_CLASS', status: 'PASS', reasons: [] },
        ]);
        const gatesMixed = JSON.stringify([
            { gate_id: 'G1_KEYWORD_DEDUP', status: 'PASS', reasons: [] },
            { gate_id: 'G2_SIMILARITY', status: 'HOLD', reasons: ['too_similar'] },
            { gate_id: 'G4_FACT_CLASS', status: 'DRAFT', reasons: ['low_quality'] },
        ]);

        insertRow(db, { status: 'published', gate_results: gatesPassed });
        insertRow(db, { status: 'hold', gate_results: gatesMixed });

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.gate_pass_rate_30d).not.toBe('data_unavailable');
        const rate = report.gate_pass_rate_30d as { total_gates_evaluated: number; total_passed: number; pass_rate: number };
        expect(rate.total_gates_evaluated).toBe(6); // 3 + 3
        expect(rate.total_passed).toBe(4);           // 3 + 1
        expect(rate.pass_rate).toBeCloseTo(4 / 6, 4);
    });

    // ─── §6.6 (4-5): GSC data_unavailable ──────────────────────

    it('§6.6 (4-5): GSC fields are data_unavailable when no GSC integration', () => {
        const db = createTestDb();
        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.indexing_lag_14d).toBe('data_unavailable');
        expect(report.coverage_errors_trend).toBe('data_unavailable');
        expect(report.impressions_clicks_trend).toBe('data_unavailable');
    });

    // ─── §6.6 (6): noindex_draft_backlog ───────────────────────

    it('§6.6 (6): noindex_draft_backlog lists correct items', () => {
        const db = createTestDb();

        // Should appear: draft_wp + noindex
        const id1 = insertRow(db, {
            status: 'draft_wp',
            robots_decision: 'noindex,follow',
            fail_reasons: JSON.stringify(['stage6_rollback']),
        });
        // Should appear: draft_wp + noindex, no fail_reasons
        const id2 = insertRow(db, {
            status: 'draft_wp',
            robots_decision: 'noindex,follow',
        });
        // Should NOT appear: published + noindex (not draft_wp)
        insertRow(db, {
            status: 'published',
            robots_decision: 'noindex,follow',
        });
        // Should NOT appear: draft_wp + index (not noindex)
        insertRow(db, {
            status: 'draft_wp',
            robots_decision: 'index,follow',
        });

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.noindex_draft_backlog.length).toBe(2);
        const ids = report.noindex_draft_backlog.map(item => item.queue_id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);

        const item1 = report.noindex_draft_backlog.find(i => i.queue_id === id1)!;
        expect(item1.reason).toBe(JSON.stringify(['stage6_rollback']));

        const item2 = report.noindex_draft_backlog.find(i => i.queue_id === id2)!;
        expect(item2.reason).toBe('no_reason_recorded');
    });

    // ─── §6.6 (7): needs_refresh_queue ─────────────────────────

    it('§6.6 (7): needs_refresh_queue lists hold/failed items', () => {
        const db = createTestDb();

        const id1 = insertRow(db, { status: 'hold', fail_reasons: JSON.stringify(['similarity_too_high']) });
        const id2 = insertRow(db, { status: 'failed', fail_reasons: JSON.stringify(['wp_api_error']) });
        insertRow(db, { status: 'published' });  // should NOT appear
        insertRow(db, { status: 'planned' });     // should NOT appear

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.needs_refresh_queue.length).toBe(2);
        const ids = report.needs_refresh_queue.map(item => item.queue_id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);

        const holdItem = report.needs_refresh_queue.find(i => i.queue_id === id1)!;
        expect(holdItem.status).toBe('hold');
        expect(holdItem.fail_reasons).toBe(JSON.stringify(['similarity_too_high']));

        const failItem = report.needs_refresh_queue.find(i => i.queue_id === id2)!;
        expect(failItem.status).toBe('failed');
    });

    // ─── §6.6 (8): throttle_actions ────────────────────────────

    it('§6.6 (8): throttle_actions reflects settings table state', () => {
        const db = createTestDb();

        // Update settings to non-default values
        db.prepare(`UPDATE settings SET throttle_state = 'reduced', ramp_state = 'ramp_2', daily_quota = 3 WHERE id = 1`).run();

        const { report } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        expect(report.throttle_actions.current_throttle_state).toBe('reduced');
        expect(report.throttle_actions.current_ramp_state).toBe('ramp_2');
        expect(report.throttle_actions.daily_quota).toBe(3);
        expect(report.throttle_actions.action_history).toBe('history_unavailable');
    });

    // ─── Disk artifact includes §6.6 fields ────────────────────

    it('written artifact JSON includes all §6.6 fields', () => {
        const db = createTestDb();
        insertRow(db, { status: 'published' });
        insertRow(db, { status: 'hold', fail_reasons: JSON.stringify(['test_reason']) });

        const { artifactPath } = generateWeeklyOpsReport({ db, outputDir: TEST_OUTPUT_DIR });
        db.close();

        const fsPath = artifactPath.split('/').join(path.sep);
        const content = JSON.parse(fs.readFileSync(fsPath, 'utf-8'));

        expect(content.schema_version).toBe('1.0');
        expect(content).toHaveProperty('publish_counts');
        expect(content).toHaveProperty('top_hold_reasons');
        expect(content).toHaveProperty('top_draft_reasons');
        expect(content).toHaveProperty('gate_pass_rate_30d');
        expect(content).toHaveProperty('indexing_lag_14d');
        expect(content).toHaveProperty('coverage_errors_trend');
        expect(content).toHaveProperty('impressions_clicks_trend');
        expect(content).toHaveProperty('noindex_draft_backlog');
        expect(content).toHaveProperty('needs_refresh_queue');
        expect(content).toHaveProperty('throttle_actions');
    });
});
