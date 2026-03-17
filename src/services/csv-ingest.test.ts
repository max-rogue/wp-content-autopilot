/**
 * CSV Keyword Ingestion Tests
 * Ref: 13_CONTENT_OPS_PIPELINE §6.2, §6.4
 * Ref: 32_IDEMPOTENCY_AND_RETRY
 *
 * Tests:
 *   - Ingest inserts planned rows from sample CSV
 *   - Re-run is idempotent (skips duplicates)
 *   - --limit works deterministically
 *   - canonical_category is persisted and usable by Stage 6
 *   - Handles missing columns gracefully
 *   - Dry-run does not write to DB
 *   - Idempotency key computation is deterministic
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo } from '../db/repositories';
import {
    parseIngestCsv,
    computeIdempotencyKey,
    ingestKeywords,
} from './csv-ingest';

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

// ─── Sample CSVs ────────────────────────────────────────────────

const SAMPLE_CSV_WITH_ROW_ORDER = [
    'row_order,keyword,content_type,canonical_category,cluster',
    '1,quản lý chi tiêu cá nhân,BlogPost,chi-phi-va-van-hoa,chi phí cá nhân',
    '2,Trackman là gì,Glossary,cong-nghe,công nghệ',
    '3,kỹ thuật fitting là gì,Glossary,ky-thuat-fitting,kỹ thuật fitting',
    '4,cách tính kỹ năng cơ bản,BlogPost,hoc-co-ban,handicap',
    '5,kỹ thuật grip là gì,BlogPost,hoc-co-ban,học cơ bản',
].join('\n');

const SAMPLE_CSV_NO_ROW_ORDER = [
    'keyword,content_type,canonical_category,cluster',
    'quản lý chi tiêu cá nhân,BlogPost,chi-phi-va-van-hoa,chi phí cá nhân',
    'Trackman là gì,Glossary,cong-nghe,công nghệ',
    'kỹ thuật fitting là gì,Glossary,ky-thuat-fitting,kỹ thuật fitting',
].join('\n');

const SAMPLE_CSV_MINIMAL = [
    'keyword',
    'quản lý chi tiêu cá nhân',
    'Trackman là gì',
].join('\n');

const SAMPLE_CSV_WITH_QUOTES = [
    'row_order,keyword,content_type,canonical_category,tags',
    '1,quản lý chi tiêu cá nhân,BlogPost,chi-phi-va-van-hoa,"tag1,tag2,tag3"',
    '2,Trackman là gì,Glossary,cong-nghe,"tag4,tag5"',
].join('\n');

// ─── Helper: write CSV to temp file ─────────────────────────────

function writeTempCsv(content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcap-ingest-test-'));
    const csvPath = path.join(tmpDir, 'keyword.csv');
    fs.writeFileSync(csvPath, content, 'utf-8');
    return csvPath;
}

function cleanupTempFile(csvPath: string): void {
    try {
        fs.unlinkSync(csvPath);
        fs.rmdirSync(path.dirname(csvPath));
    } catch { /* noop */ }
}

// ═══════════════════════════════════════════════════════════════════
// Unit Tests: CSV Parser
// ═══════════════════════════════════════════════════════════════════

describe('parseIngestCsv', () => {
    it('parses CSV with all columns', () => {
        const rows = parseIngestCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        expect(rows).toHaveLength(5);
        expect(rows[0].keyword).toBe('quản lý chi tiêu cá nhân');
        expect(rows[0].row_order).toBe('1');
        expect(rows[0].content_type).toBe('BlogPost');
        expect(rows[0].canonical_category).toBe('chi-phi-va-van-hoa');
    });

    it('parses CSV without row_order', () => {
        const rows = parseIngestCsv(SAMPLE_CSV_NO_ROW_ORDER);
        expect(rows).toHaveLength(3);
        expect(rows[0].keyword).toBe('quản lý chi tiêu cá nhân');
        expect(rows[0].row_order).toBeUndefined();
    });

    it('parses minimal CSV with only keyword column', () => {
        const rows = parseIngestCsv(SAMPLE_CSV_MINIMAL);
        expect(rows).toHaveLength(2);
        expect(rows[0].keyword).toBe('quản lý chi tiêu cá nhân');
    });

    it('handles quoted fields with internal commas', () => {
        const rows = parseIngestCsv(SAMPLE_CSV_WITH_QUOTES);
        expect(rows).toHaveLength(2);
        expect(rows[0].tags).toBe('tag1,tag2,tag3');
        expect(rows[1].tags).toBe('tag4,tag5');
    });

    it('throws on CSV missing keyword column', () => {
        const bad = 'name,content_type\nfoo,BlogPost';
        expect(() => parseIngestCsv(bad)).toThrow('keyword');
    });

    it('returns empty for CSV with only headers', () => {
        const rows = parseIngestCsv('keyword,content_type');
        expect(rows).toHaveLength(0);
    });

    it('skips rows with empty keyword', () => {
        const csv = 'keyword,content_type\n,BlogPost\nreal keyword,BlogPost';
        const rows = parseIngestCsv(csv);
        expect(rows).toHaveLength(1);
        expect(rows[0].keyword).toBe('real keyword');
    });
});

// ═══════════════════════════════════════════════════════════════════
// Unit Tests: Idempotency Key
// ═══════════════════════════════════════════════════════════════════

describe('computeIdempotencyKey', () => {
    it('uses row_order + keyword when row_order present', () => {
        const key1 = computeIdempotencyKey({ keyword: 'niche', row_order: '1' });
        const key2 = computeIdempotencyKey({ keyword: 'niche', row_order: '2' });
        expect(key1).not.toBe(key2);
    });

    it('uses keyword only when no row_order', () => {
        const key1 = computeIdempotencyKey({ keyword: 'niche' });
        const key2 = computeIdempotencyKey({ keyword: 'niche' });
        expect(key1).toBe(key2);
    });

    it('is deterministic (same input → same key)', () => {
        const row = { keyword: 'Trackman là gì', row_order: '5' };
        const a = computeIdempotencyKey(row);
        const b = computeIdempotencyKey(row);
        expect(a).toBe(b);
        expect(a).toHaveLength(64); // SHA-256 hex
    });

    it('different keywords produce different keys', () => {
        const k1 = computeIdempotencyKey({ keyword: 'niche a' });
        const k2 = computeIdempotencyKey({ keyword: 'niche b' });
        expect(k1).not.toBe(k2);
    });
});

// ═══════════════════════════════════════════════════════════════════
// Integration Tests: ingestKeywords
// ═══════════════════════════════════════════════════════════════════

describe('ingestKeywords', () => {
    let db: Database.Database;
    let csvPath: string;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        db.close();
        if (csvPath) cleanupTempFile(csvPath);
    });

    it('inserts planned rows from sample CSV', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        const result = ingestKeywords(db, { csvPath });

        expect(result.schema_version).toBe('1.0');
        expect(result.inserted).toBe(5);
        expect(result.skipped).toBe(0);
        expect(result.total_rows).toBe(5);
        expect(result.dry_run).toBe(false);

        // Verify DB state
        const repo = new PublishQueueRepo(db);
        const counts = repo.countByStatus();
        expect(counts.planned).toBe(5);
    });

    it('re-run is idempotent — skips duplicates', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);

        const first = ingestKeywords(db, { csvPath });
        expect(first.inserted).toBe(5);

        const second = ingestKeywords(db, { csvPath });
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBe(5);

        // Still only 5 rows in DB
        const repo = new PublishQueueRepo(db);
        const counts = repo.countByStatus();
        expect(counts.planned).toBe(5);
    });

    it('--limit works deterministically (inserts first N rows by row_order)', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        const result = ingestKeywords(db, { csvPath, limit: 2 });

        expect(result.inserted).toBe(2);
        expect(result.skipped).toBe(0);
        expect(result.total_rows).toBe(5);

        // Verify the correct 2 rows were inserted (row_order 1 and 2)
        const repo = new PublishQueueRepo(db);
        const planned = repo.findByStatus('planned');
        expect(planned).toHaveLength(2);

        const keywords = planned.map(r => r.picked_keyword).sort();
        expect(keywords).toContain('quản lý chi tiêu cá nhân');
        expect(keywords).toContain('Trackman là gì');
    });

    it('--limit + re-run ingests remaining rows', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);

        // First: ingest 2
        const first = ingestKeywords(db, { csvPath, limit: 2 });
        expect(first.inserted).toBe(2);

        // Second: ingest all — first 2 skipped, last 3 inserted
        const second = ingestKeywords(db, { csvPath });
        expect(second.inserted).toBe(3);
        expect(second.skipped).toBe(2);

        const repo = new PublishQueueRepo(db);
        expect(repo.countByStatus().planned).toBe(5);
    });

    it('canonical_category is persisted from CSV', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        ingestKeywords(db, { csvPath });

        const repo = new PublishQueueRepo(db);
        const planned = repo.findByStatus('planned');

        // Find the cong-nghe row
        const trackman = planned.find(r => r.picked_keyword === 'Trackman là gì');
        expect(trackman).toBeDefined();
        expect(trackman!.canonical_category).toBe('cong-nghe');

        // Find the chi-phi-va-van-hoa row
        const chiphi = planned.find(r => r.picked_keyword === 'quản lý chi tiêu cá nhân');
        expect(chiphi).toBeDefined();
        expect(chiphi!.canonical_category).toBe('chi-phi-va-van-hoa');
    });

    it('canonical_category precedence — CSV slug used by Stage 6', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        ingestKeywords(db, { csvPath });

        const repo = new PublishQueueRepo(db);
        const planned = repo.findByStatus('planned');

        // All rows with canonical_category should have valid slugs
        for (const row of planned) {
            if (row.canonical_category) {
                // Verify it's a non-empty string (actual slug validation is taxonomy.ts concern)
                expect(row.canonical_category.length).toBeGreaterThan(0);
                expect(row.canonical_category).not.toContain(' ');
            }
        }
    });

    it('content_type defaults to BlogPost when not in CSV', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_MINIMAL);
        ingestKeywords(db, { csvPath });

        const repo = new PublishQueueRepo(db);
        const planned = repo.findByStatus('planned');
        for (const row of planned) {
            expect(row.content_type).toBe('BlogPost');
        }
    });

    it('dry-run does not write to DB', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        const result = ingestKeywords(db, { csvPath, dryRun: true });

        expect(result.inserted).toBe(5);
        expect(result.skipped).toBe(0);
        expect(result.dry_run).toBe(true);

        // DB should be empty
        const repo = new PublishQueueRepo(db);
        expect(repo.countByStatus().planned).toBe(0);
    });

    it('dry-run shows correct skip count on re-run', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);

        // First: actual insert
        ingestKeywords(db, { csvPath });

        // Second: dry-run — should show all as skipped
        const dryResult = ingestKeywords(db, { csvPath, dryRun: true });
        expect(dryResult.inserted).toBe(0);
        expect(dryResult.skipped).toBe(5);
    });

    it('status is always planned for newly inserted rows', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        ingestKeywords(db, { csvPath });

        const repo = new PublishQueueRepo(db);
        const all = repo.findByStatus('planned');
        expect(all).toHaveLength(5);
        for (const row of all) {
            expect(row.status).toBe('planned');
        }
    });

    it('throws on missing CSV file', () => {
        expect(() =>
            ingestKeywords(db, { csvPath: '/nonexistent/keyword.csv' })
        ).toThrow('not found');
    });

    it('handles CSV without row_order — uses keyword-only key', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_NO_ROW_ORDER);
        const result = ingestKeywords(db, { csvPath });

        expect(result.inserted).toBe(3);

        // Idempotent on re-run
        const second = ingestKeywords(db, { csvPath });
        expect(second.inserted).toBe(0);
        expect(second.skipped).toBe(3);
    });

    it('cluster field is persisted from CSV', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_WITH_ROW_ORDER);
        ingestKeywords(db, { csvPath });

        const repo = new PublishQueueRepo(db);
        const planned = repo.findByStatus('planned');
        const trackman = planned.find(r => r.picked_keyword === 'Trackman là gì');
        expect(trackman!.cluster).toBe('công nghệ');
    });

    it('language defaults to config default (en)', () => {
        csvPath = writeTempCsv(SAMPLE_CSV_MINIMAL);
        ingestKeywords(db, { csvPath });

        const repo = new PublishQueueRepo(db);
        const planned = repo.findByStatus('planned');
        for (const row of planned) {
            expect(row.language).toBe('en');
        }
    });
});
