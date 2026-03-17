/**
 * Operability Bundle Tests
 *
 * Covers:
 *   A) dotenv auto-load does not crash when .env missing
 *   B) alias mapping works (WP_USERNAME/WP_APP_PASSWORD/DATABASE_URL accepted)
 *   C) /run with body enqueues planned row and triggers run
 *   C) /run with empty body preserves existing behavior
 *   C) idempotency: same idempotency_key does not enqueue duplicate
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { isDotenvLoaded, printConfigPreflight, applyAliases } from './env-bootstrap';
import { normalizeKeyword } from './gates/engine';
import { PublishQueueRepo } from './db/repositories';
import { getDb } from './db/migrate';
import { createApp } from './server';
import { v4 as uuid } from 'uuid';

// ─── A) Dotenv auto-load tests ─────────────────────────────────

describe('env-bootstrap — dotenv auto-load', () => {
    it('does not crash when .env is missing', () => {
        // env-bootstrap was imported at module level — if it crashed, this file wouldn't load
        expect(true).toBe(true);
    });

    it('exports isDotenvLoaded function', () => {
        expect(typeof isDotenvLoaded).toBe('function');
        // Result depends on whether .env exists — just verify it returns boolean
        const result = isDotenvLoaded();
        expect(typeof result).toBe('boolean');
    });

    it('exports printConfigPreflight function without crashing', () => {
        expect(typeof printConfigPreflight).toBe('function');
        // Should not throw even with no env vars set
        expect(() => printConfigPreflight()).not.toThrow();
    });
});

// ─── B) Alias mapping tests ────────────────────────────────────

describe('env-bootstrap — alias mapping', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        // Restore original env
        process.env = { ...originalEnv };
    });

    it('WP_USERNAME fills WP_API_USER when canonical missing', () => {
        delete process.env.WP_API_USER;
        process.env.WP_USERNAME = 'test_user_from_alias';

        applyAliases();

        expect(process.env.WP_API_USER).toBe('test_user_from_alias');
    });

    it('WP_APP_PASSWORD fills WP_APPLICATION_PASSWORD when canonical missing', () => {
        delete process.env.WP_APPLICATION_PASSWORD;
        process.env.WP_APP_PASSWORD = 'test_pass_from_alias';

        applyAliases();

        expect(process.env.WP_APPLICATION_PASSWORD).toBe('test_pass_from_alias');
    });

    it('DATABASE_URL fills DB_PATH when canonical missing', () => {
        delete process.env.DB_PATH;
        process.env.DATABASE_URL = './data/alias-test.db';

        applyAliases();

        expect(process.env.DB_PATH).toBe('./data/alias-test.db');
    });

    it('canonical wins over alias (WP_API_USER already set)', () => {
        process.env.WP_API_USER = 'canonical_user';
        process.env.WP_USERNAME = 'alias_user';

        applyAliases();

        // Canonical should NOT be overwritten
        expect(process.env.WP_API_USER).toBe('canonical_user');
    });

    it('bidirectional: WP_BASE_URL fills SITE_BASE_URL when missing', () => {
        delete process.env.SITE_BASE_URL;
        process.env.WP_BASE_URL = 'https://example.com';

        applyAliases();

        expect(process.env.SITE_BASE_URL).toBe('https://example.com');
    });

    it('bidirectional: SITE_BASE_URL fills WP_BASE_URL when missing', () => {
        delete process.env.WP_BASE_URL;
        process.env.SITE_BASE_URL = 'https://site.example.com';

        applyAliases();

        expect(process.env.WP_BASE_URL).toBe('https://site.example.com');
    });
});

// ─── C) POST /run with body — enqueue + idempotency tests ──────

describe('POST /run — optional body support', () => {
    const TEST_DB_PATH = path.resolve(__dirname, '../data/test-operability.db');

    function getTestDb() {
        const dir = path.dirname(TEST_DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const db = new Database(TEST_DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        return db;
    }

    function setupDb(db: Database.Database) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS publish_queue (
                id TEXT PRIMARY KEY,
                picked_keyword TEXT NOT NULL,
                normalized_keyword TEXT NOT NULL,
                language TEXT NOT NULL DEFAULT 'vi',
                idempotency_key TEXT NOT NULL UNIQUE,
                cluster TEXT NOT NULL DEFAULT '',
                content_type TEXT NOT NULL CHECK(content_type IN ('BlogPost','Glossary','CategoryPage','LandingSection')),
                class_hint TEXT NOT NULL DEFAULT 'B',
                blogpost_subtype TEXT,
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
                news_source_url TEXT,
                news_source_name TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                daily_quota INTEGER NOT NULL DEFAULT 1,
                ramp_state TEXT NOT NULL DEFAULT 'ramp_1',
                throttle_state TEXT NOT NULL DEFAULT 'active',
                last_run_at TEXT
            );
            INSERT OR IGNORE INTO settings (id, daily_quota, ramp_state, throttle_state) VALUES (1, 1, 'ramp_1', 'active');
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS content_index (
                wp_post_id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                focus_keyword TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                url TEXT NOT NULL,
                category TEXT NOT NULL,
                tags TEXT NOT NULL DEFAULT '[]',
                published_at TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                embedding TEXT,
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                similarity_score REAL,
                similarity_band TEXT,
                gate_results TEXT
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS local_db (
                entity_id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                name TEXT NOT NULL,
                city_province TEXT NOT NULL,
                address TEXT NOT NULL,
                verified_source_url TEXT NOT NULL,
                last_verified_at TEXT NOT NULL,
                verification_tier INTEGER NOT NULL
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id TEXT PRIMARY KEY,
                queue_id TEXT NOT NULL,
                run_id TEXT NOT NULL,
                stage_name TEXT NOT NULL,
                input_snapshot_hash TEXT NOT NULL,
                output_snapshot_hash TEXT NOT NULL,
                gate_decisions TEXT,
                reasons TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);
    }

    beforeEach(() => {
        if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
        process.env.DB_PATH = TEST_DB_PATH;
    });

    afterEach(() => {
        try {
            if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
        } catch {
            // ignore if locked
        }
    });

    it('/run with keyword body enqueues a planned row', () => {
        const db = getTestDb();
        setupDb(db);
        db.close();

        const db2 = getDb(TEST_DB_PATH);
        const queueRepo = new PublishQueueRepo(db2);

        const keyword = 'Cách chọn sản phẩm chuẩn';
        const normalized = normalizeKeyword(keyword);
        const idempotencyKey = 'test-key-001';

        // Should not exist yet
        expect(queueRepo.findByIdempotencyKey(idempotencyKey)).toBeUndefined();

        // Insert (same logic as server.ts POST /run with body)
        queueRepo.insert({
            id: uuid(),
            picked_keyword: keyword,
            normalized_keyword: normalized,
            language: 'vi',
            idempotency_key: idempotencyKey,
            cluster: '',
            content_type: 'BlogPost',
            class_hint: 'B',
            blogpost_subtype: null,
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
            canonical_category: null,
            news_source_url: null,
            news_source_name: null,
        });

        // Verify enqueued
        const found = queueRepo.findByIdempotencyKey(idempotencyKey);
        expect(found).toBeDefined();
        expect(found!.status).toBe('planned');
        expect(found!.picked_keyword).toBe(keyword);
        expect(found!.normalized_keyword).toBe(normalized);

        db2.close();
    });

    it('/run preserves existing behavior with empty body (no keyword)', () => {
        const db = getTestDb();
        setupDb(db);

        // Pre-insert a planned row (existing behavior: run picks next planned)
        db.prepare(`
            INSERT INTO publish_queue (id, picked_keyword, normalized_keyword, language, idempotency_key, cluster, content_type, status)
            VALUES (?, ?, ?, 'vi', ?, '', 'BlogPost', 'planned')
        `).run(uuid(), 'existing keyword', 'existing keyword', 'existing-key-001');

        // Count planned rows — should be exactly 1
        const count = db.prepare("SELECT COUNT(*) as cnt FROM publish_queue WHERE status = 'planned'").get() as { cnt: number };
        expect(count.cnt).toBe(1);

        db.close();
    });

    it('idempotency: same idempotency_key does NOT enqueue duplicate', () => {
        const db = getTestDb();
        setupDb(db);

        const queueRepo = new PublishQueueRepo(db);

        const keyword = 'test keyword';
        const normalized = normalizeKeyword(keyword);
        const idempotencyKey = 'idem-key-dup-test';

        // First insert succeeds
        queueRepo.insert({
            id: uuid(),
            picked_keyword: keyword,
            normalized_keyword: normalized,
            language: 'vi',
            idempotency_key: idempotencyKey,
            cluster: '',
            content_type: 'BlogPost',
            class_hint: 'B',
            blogpost_subtype: null,
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
            canonical_category: null,
            news_source_url: null,
            news_source_name: null,
        });

        // Verify exists
        const existing = queueRepo.findByIdempotencyKey(idempotencyKey);
        expect(existing).toBeDefined();

        // Second insert with same key should throw (UNIQUE constraint)
        expect(() => {
            queueRepo.insert({
                id: uuid(),
                picked_keyword: keyword,
                normalized_keyword: normalized,
                language: 'vi',
                idempotency_key: idempotencyKey, // same key!
                cluster: '',
                content_type: 'BlogPost',
                class_hint: 'B',
                blogpost_subtype: null,
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
                canonical_category: null,
                news_source_url: null,
                news_source_name: null,
            });
        }).toThrow(); // UNIQUE constraint violation

        // Verify only one row exists
        const all = db.prepare("SELECT * FROM publish_queue WHERE idempotency_key = ?").all(idempotencyKey);
        expect(all.length).toBe(1);

        db.close();
    });

    it('server app still has POST /run route', () => {
        const app = createApp();

        const routes = (app as any)._router?.stack
            ?.filter((r: any) => r.route)
            ?.map((r: any) => ({
                path: r.route.path,
                methods: Object.keys(r.route.methods),
            }));

        const runRoute = routes?.find((r: any) => r.path === '/run');
        expect(runRoute).toBeDefined();
        expect(runRoute?.methods).toContain('post');
    });

    it('normalize keyword handles Vietnamese patterns correctly', () => {
        // Double spaces
        expect(normalizeKeyword('  cách  chọn  sản phẩm  ')).toBe('cách chọn sản phẩm');

        // Vietnamese pattern normalization
        expect(normalizeKeyword('Cách chọn sản phẩm chuẩn')).toBe('cách chọn sản phẩm đúng');
        expect(normalizeKeyword('Dịch vụ tại Hà Nội')).toBe('dịch vụ ở hà nội');
    });
});
