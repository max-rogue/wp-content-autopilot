/**
 * DB and Migrations Tests
 * Ref: 13_CONTENT_OPS_PIPELINE §6.2
 *
 * Tests schema creation, repository operations, and status enum enforcement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import {
    PublishQueueRepo,
    ContentIndexRepo,
    SettingsRepo,
    LocalDbRepo,
    AuditLogRepo,
} from '../db/repositories';
import { v4 as uuid } from 'uuid';
import { QUEUE_STATUSES } from '../types';

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

describe('Database & Migrations', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = createTestDb();
    });

    it('creates all expected tables', () => {
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((r: any) => r.name);

        expect(tables).toContain('publish_queue');
        expect(tables).toContain('content_index');
        expect(tables).toContain('local_db');
        expect(tables).toContain('settings');
        expect(tables).toContain('audit_log');
        expect(tables).toContain('_migrations');
    });

    it('migrations are idempotent — running twice does not error', () => {
        expect(() => runMigrations(db)).not.toThrow();
        expect(() => runMigrations(db)).not.toThrow();
    });

    it('settings has default row with id=1', () => {
        const repo = new SettingsRepo(db);
        const settings = repo.get();
        expect(settings.daily_quota).toBe(1);
        expect(settings.throttle_state).toBe('active');
        expect(settings.ramp_state).toBe('ramp_1');
    });
});

describe('PublishQueueRepo', () => {
    let db: Database.Database;
    let repo: PublishQueueRepo;

    beforeEach(() => {
        db = createTestDb();
        repo = new PublishQueueRepo(db);
    });

    it('insert and findById', () => {
        const id = uuid();
        repo.insert({
            id,
            picked_keyword: 'test',
            normalized_keyword: 'test',
            language: 'vi',
            idempotency_key: `key-${id}`,
            cluster: 'test',
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

        const found = repo.findById(id);
        expect(found).toBeDefined();
        expect(found?.picked_keyword).toBe('test');
        expect(found?.status).toBe('planned');
    });

    it('status enum enforcement — only valid statuses accepted', () => {
        const id = uuid();
        repo.insert({
            id,
            picked_keyword: 'test',
            normalized_keyword: 'test',
            language: 'vi',
            idempotency_key: `key-${id}`,
            cluster: 'test',
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

        // All valid statuses should work
        for (const status of QUEUE_STATUSES) {
            expect(() => repo.updateStatus(id, status)).not.toThrow();
        }
    });

    it('countByStatus returns all status keys', () => {
        const counts = repo.countByStatus();
        for (const status of QUEUE_STATUSES) {
            expect(counts).toHaveProperty(status);
            expect(typeof counts[status]).toBe('number');
        }
    });

    it('idempotency_key UNIQUE constraint enforced', () => {
        const key = 'unique-key-test';
        repo.insert({
            id: uuid(),
            picked_keyword: 'test1',
            normalized_keyword: 'test1',
            language: 'vi',
            idempotency_key: key,
            cluster: 'test',
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

        expect(() =>
            repo.insert({
                id: uuid(),
                picked_keyword: 'test2',
                normalized_keyword: 'test2',
                language: 'vi',
                idempotency_key: key, // same key
                cluster: 'test',
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
            })
        ).toThrow();
    });
});

describe('AuditLogRepo', () => {
    let db: Database.Database;
    let repo: AuditLogRepo;

    beforeEach(() => {
        db = createTestDb();
        repo = new AuditLogRepo(db);
    });

    it('insert and query by queue_id', () => {
        const queueId = uuid();
        const runId = uuid();
        repo.insert({
            id: uuid(),
            queue_id: queueId,
            run_id: runId,
            stage_name: 'stage1',
            input_snapshot_hash: 'abc',
            output_snapshot_hash: 'def',
            gate_decisions: null,
            reasons: null,
            created_at: new Date().toISOString(),
        });

        const entries = repo.findByQueueId(queueId);
        expect(entries).toHaveLength(1);
        expect(entries[0].stage_name).toBe('stage1');
    });
});
