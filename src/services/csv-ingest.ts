/**
 * CSV Keyword Ingestion Service.
 * Reads keyword.csv into publish_queue with status=planned (idempotent).
 *
 * Idempotency key: deterministic hash per CSV row.
 *   - If CSV has row_order column: SHA-256(row_order + "|" + keyword)
 *   - Else: SHA-256(keyword)
 *
 * Duplicates (same queue_idempotency_key already in DB) are silently skipped.
 * No secrets in logs. No new public endpoints.
 *
 * Ref: 13_CONTENT_OPS_PIPELINE §6.2, §6.4
 * Ref: 32_IDEMPOTENCY_AND_RETRY
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { PublishQueueRepo } from '../db/repositories';
import { logger } from '../logger';
import type { ContentType, ContentClass, BlogpostSubtype } from '../types';
import { BLOGPOST_SUBTYPES } from '../types';
import { loadConfig } from '../config';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface IngestOptions {
    /** Path to keyword.csv file */
    csvPath: string;
    /** Maximum rows to ingest (undefined = all) */
    limit?: number;
    /** If true, do not write to DB; just compute counts */
    dryRun?: boolean;
}

export interface IngestResult {
    schema_version: '1.0';
    inserted: number;
    skipped: number;
    total_rows: number;
    file_path: string;
    dry_run: boolean;
}

interface ParsedCsvRow {
    row_order?: string;
    keyword: string;
    content_type?: string;
    canonical_category?: string;
    cluster?: string;
    class_hint?: string;
    blogpost_subtype?: string;
    [key: string]: string | undefined;
}

// ═══════════════════════════════════════════════════════════════════
// CSV Parser (handles quoted fields with internal commas)
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse a CSV line respecting quoted fields (handles commas inside quotes).
 * Minimal implementation — no external deps.
 */
function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                // Check for escaped quote ""
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                fields.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
    }
    fields.push(current.trim());
    return fields;
}

/**
 * Parse keyword CSV content into structured rows.
 * First row must be headers. Must contain 'keyword' column.
 */
export function parseIngestCsv(csvContent: string): ParsedCsvRow[] {
    const lines = csvContent
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((l) => l.trim());

    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]);
    const keywordIdx = headers.indexOf('keyword');
    if (keywordIdx === -1) {
        throw new Error('CSV missing required column: keyword');
    }

    const rows: ParsedCsvRow[] = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i]);
        const row: Record<string, string> = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = values[j] || '';
        }
        // Skip rows with empty keyword
        if (!row.keyword || !row.keyword.trim()) continue;
        rows.push(row as ParsedCsvRow);
    }

    return rows;
}

// ═══════════════════════════════════════════════════════════════════
// Deterministic Idempotency Key
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute a deterministic idempotency key for a CSV row.
 *
 * Strategy:
 *   - If row_order is present and non-empty: SHA-256(row_order + "|" + keyword)
 *   - Else: SHA-256(keyword)
 *
 * The keyword is trimmed but NOT lowercased — the hash input is the
 * exact trimmed string so that different keywords always get different keys.
 */
export function computeIdempotencyKey(row: ParsedCsvRow): string {
    const keyword = (row.keyword || '').trim();
    const rowOrder = (row.row_order || '').trim();

    let input: string;
    if (rowOrder) {
        input = `${rowOrder}|${keyword}`;
    } else {
        input = keyword;
    }

    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// Validate & Normalize
// ═══════════════════════════════════════════════════════════════════

const VALID_CONTENT_TYPES = new Set<string>([
    'BlogPost',
    'Glossary',
    'CategoryPage',
    'LandingSection',
]);

function resolveContentType(raw?: string): ContentType {
    if (raw && VALID_CONTENT_TYPES.has(raw)) {
        return raw as ContentType;
    }
    return 'BlogPost'; // safe default
}

/**
 * Resolve class_hint from CSV column. Default to 'B' if missing or invalid.
 * LOCKED: class_hint from keyword_schedule.csv column class_hint. Default if missing: "B".
 */
const VALID_CLASS_HINTS = new Set<string>(['A', 'B', 'C']);

function resolveClassHint(raw?: string): ContentClass {
    if (raw && VALID_CLASS_HINTS.has(raw.trim().toUpperCase())) {
        return raw.trim().toUpperCase() as ContentClass;
    }
    return 'B'; // LOCKED default
}

/**
 * Resolve blogpost_subtype from CSV column. Returns null if missing or invalid.
 * LOCKED enum: HowTo | BuyingGuide | Comparison | Guide
 */
function resolveBlogpostSubtype(raw?: string): BlogpostSubtype | null {
    if (!raw || !raw.trim()) return null;
    const trimmed = raw.trim();
    if ((BLOGPOST_SUBTYPES as readonly string[]).includes(trimmed)) {
        return trimmed as BlogpostSubtype;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════
// Ingest Engine
// ═══════════════════════════════════════════════════════════════════

/**
 * Ingest keyword CSV into publish_queue.
 *
 * - Reads the CSV from disk.
 * - Sorts by row_order (if present) for deterministic ordering.
 * - Computes idempotency key per row.
 * - Inserts as status=planned; skips if key already exists.
 * - Returns summary JSON.
 */
export function ingestKeywords(
    db: Database.Database,
    options: IngestOptions
): IngestResult {
    const { csvPath, limit, dryRun = false } = options;
    const absPath = path.resolve(csvPath);

    // Validate file exists
    if (!fs.existsSync(absPath)) {
        throw new Error(`CSV file not found: ${absPath}`);
    }

    const csvContent = fs.readFileSync(absPath, 'utf-8');
    let rows = parseIngestCsv(csvContent);

    // Sort by row_order if present (numeric sort)
    const hasRowOrder = rows.length > 0 && rows[0].row_order !== undefined && rows[0].row_order !== '';
    if (hasRowOrder) {
        rows.sort((a, b) => {
            const ao = parseInt(a.row_order || '0', 10);
            const bo = parseInt(b.row_order || '0', 10);
            return ao - bo;
        });
    }

    const totalRows = rows.length;

    // Apply limit
    if (limit !== undefined && limit > 0) {
        rows = rows.slice(0, limit);
    }

    const queueRepo = new PublishQueueRepo(db);
    let inserted = 0;
    let skipped = 0;

    for (const row of rows) {
        const keyword = (row.keyword || '').trim();
        if (!keyword) {
            skipped++;
            continue;
        }

        const idempotencyKey = computeIdempotencyKey(row);

        // Check for existing row with same key
        const existing = queueRepo.findByIdempotencyKey(idempotencyKey);
        if (existing) {
            skipped++;
            continue;
        }

        if (dryRun) {
            inserted++;
            continue;
        }

        // Build the queue row
        const id = uuid();
        const contentType = resolveContentType(row.content_type);
        const canonicalCategory = (row.canonical_category || '').trim() || null;
        const cluster = (row.cluster || '').trim();
        const classHint = resolveClassHint(row.class_hint);
        const blogpostSubtype = resolveBlogpostSubtype(row.blogpost_subtype);

        const config = loadConfig();

        queueRepo.insert({
            id,
            picked_keyword: keyword,
            normalized_keyword: keyword.toLowerCase().trim(),
            language: config.defaultLanguage,
            idempotency_key: idempotencyKey,
            cluster,
            content_type: contentType,
            class_hint: classHint,
            blogpost_subtype: blogpostSubtype,
            status: 'planned',
            scheduled_for: null,
            published_url: null,
            published_wp_id: null,
            fail_reasons: null,
            model_trace: null,
            similarity_score: null,
            similarity_band: null,
            robots_decision: null,
            gate_results: null,
            dropped_tags: null,
            wp_tag_not_found: null,
            canonical_category: canonicalCategory,
            news_source_url: null,
            news_source_name: null,
        });

        inserted++;
        logger.info('csv-ingest: row inserted', {
            row_order: row.row_order || 'N/A',
            keyword_len: keyword.length,
            content_type: contentType,
        });
    }

    logger.info('csv-ingest: complete', {
        inserted,
        skipped,
        total_rows: totalRows,
        dry_run: dryRun,
    });

    return {
        schema_version: '1.0',
        inserted,
        skipped,
        total_rows: totalRows,
        file_path: absPath,
        dry_run: dryRun,
    };
}
