/**
 * Weekly Dropped-Tag Report Generator.
 * Ref: 03_PublishingOps.md §6 — Weekly Dropped-Tag Review Process
 *
 * Aggregates dropped_tags[] and wp_tag_not_found[] from publish_queue
 * over a configurable window (default 7 days).
 * Outputs a deterministic JSON artifact for human review.
 *
 * Design:
 *   - Query publish_queue for rows with non-null dropped_tags or wp_tag_not_found
 *     within the window.
 *   - Aggregate counts per tag slug, sorted deterministically (desc by count, then alpha).
 *   - Write JSON artifact to logs/ directory.
 *   - Log summary counts only (no secret material).
 */

import type Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';

// ─── Types ──────────────────────────────────────────────────────

export interface TagCount {
    slug: string;
    count: number;
}

export interface DroppedTagReport {
    schema_version: '1.0';
    report_type: 'weekly_dropped_tags';
    generated_at: string;
    window_start: string;
    window_end: string;
    window_days: number;
    total_queue_rows_scanned: number;
    dropped_tags: {
        total_unique: number;
        total_occurrences: number;
        top: TagCount[];
    };
    wp_tag_not_found: {
        total_unique: number;
        total_occurrences: number;
        top: TagCount[];
    };
}

// ─── Query ──────────────────────────────────────────────────────

interface QueueTagRow {
    id: string;
    dropped_tags: string | null;
    wp_tag_not_found: string | null;
}

/**
 * Query publish_queue for rows with tag data within the window.
 */
function queryTagRows(db: Database.Database, windowDays: number): QueueTagRow[] {
    return db
        .prepare(
            `SELECT id, dropped_tags, wp_tag_not_found
       FROM publish_queue
       WHERE (dropped_tags IS NOT NULL OR wp_tag_not_found IS NOT NULL)
         AND updated_at >= datetime('now', '-' || ? || ' days')
       ORDER BY updated_at DESC`
        )
        .all(windowDays) as QueueTagRow[];
}

/**
 * Safely parse a JSON string array field, returning [] on failure.
 */
function safeParseArray(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === 'string');
    } catch {
        // malformed JSON — skip, don't crash
    }
    return [];
}

/**
 * Aggregate tag occurrences from parsed arrays.
 * Returns sorted TagCount[] — descending by count, then ascending alpha.
 */
function aggregateCounts(allTags: string[]): TagCount[] {
    const map = new Map<string, number>();
    for (const tag of allTags) {
        const slug = tag.trim().toLowerCase();
        if (!slug) continue;
        map.set(slug, (map.get(slug) || 0) + 1);
    }

    return [...map.entries()]
        .map(([slug, count]) => ({ slug, count }))
        .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count; // desc by count
            return a.slug.localeCompare(b.slug); // asc alpha
        });
}

// ─── Report Generator ───────────────────────────────────────────

export interface GenerateReportOptions {
    db: Database.Database;
    windowDays?: number;
    topN?: number;
    outputDir?: string;
}

/**
 * Generate the weekly dropped-tag report.
 *
 * @returns The report object and the path to the written artifact.
 */
export function generateDroppedTagReport(
    options: GenerateReportOptions
): { report: DroppedTagReport; artifactPath: string } {
    const { db, windowDays = 7, topN = 20 } = options;

    // Default output directory: packages/pipeline/logs/
    const outputDir =
        options.outputDir || path.resolve(__dirname, '..', '..', 'logs');

    // 1. Query
    const rows = queryTagRows(db, windowDays);

    // 2. Collect all tags
    const allDropped: string[] = [];
    const allNotFound: string[] = [];

    for (const row of rows) {
        allDropped.push(...safeParseArray(row.dropped_tags));
        allNotFound.push(...safeParseArray(row.wp_tag_not_found));
    }

    // 3. Aggregate
    const droppedAgg = aggregateCounts(allDropped);
    const notFoundAgg = aggregateCounts(allNotFound);

    // 4. Build report
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const report: DroppedTagReport = {
        schema_version: '1.0',
        report_type: 'weekly_dropped_tags',
        generated_at: now.toISOString(),
        window_start: windowStart.toISOString(),
        window_end: now.toISOString(),
        window_days: windowDays,
        total_queue_rows_scanned: rows.length,
        dropped_tags: {
            total_unique: droppedAgg.length,
            total_occurrences: allDropped.length,
            top: droppedAgg.slice(0, topN),
        },
        wp_tag_not_found: {
            total_unique: notFoundAgg.length,
            total_occurrences: allNotFound.length,
            top: notFoundAgg.slice(0, topN),
        },
    };

    // 5. Write artifact
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = `dropped-tag-report-${now.toISOString().slice(0, 10)}.json`;
    const artifactPath = path.join(outputDir, filename);
    // Normalize to forward slashes for cross-platform deterministic paths in logs
    const normalizedArtifactPath = artifactPath.split(path.sep).join('/');
    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2), 'utf-8');

    // 6. Log summary counts only (no secret material)
    logger.info('Dropped-tag report generated', {
        window_days: windowDays,
        rows_scanned: rows.length,
        dropped_unique: droppedAgg.length,
        dropped_total: allDropped.length,
        not_found_unique: notFoundAgg.length,
        not_found_total: allNotFound.length,
        artifact_path: normalizedArtifactPath,
    });

    // Return normalized path so callers/logs are cross-platform deterministic.
    return { report, artifactPath: normalizedArtifactPath };
}
