/**
 * Idempotency Tests
 * Ref: 13_CONTENT_OPS_PIPELINE §6.4, §6.6
 * Ref: 32_IDEMPOTENCY_AND_RETRY
 *
 * Key requirements:
 * - Same queue_idempotency_key MUST NOT create duplicate posts
 * - Published conflict → HOLD
 * - Draft exists → UPDATE
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate';
import { PublishQueueRepo, ContentIndexRepo } from '../db/repositories';
import { runStage1 } from '../stages/stage1';
import { v4 as uuid } from 'uuid';
import type { PublishQueueRow } from '../types';

function createTestDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    return db;
}

function makeQueueItem(overrides?: Partial<PublishQueueRow>): Omit<PublishQueueRow, 'created_at' | 'updated_at'> {
    const id = uuid();
    return {
        id,
        picked_keyword: 'cách đánh golf',
        normalized_keyword: 'cách đánh golf',
        language: 'vi',
        idempotency_key: 'cach-danh-golf__BlogPost__vi',
        cluster: 'golf-basics',
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
        ...overrides,
    };
}

describe('Idempotency', () => {
    let db: Database.Database;
    let queueRepo: PublishQueueRepo;
    let contentIndexRepo: ContentIndexRepo;

    beforeEach(() => {
        db = createTestDb();
        queueRepo = new PublishQueueRepo(db);
        contentIndexRepo = new ContentIndexRepo(db);
    });

    it('duplicate idempotency_key is rejected by DB UNIQUE constraint', () => {
        const item1 = makeQueueItem({ id: uuid() });
        queueRepo.insert(item1);

        const item2 = makeQueueItem({ id: uuid() });
        // Same idempotency_key → should throw
        expect(() => queueRepo.insert(item2)).toThrow();
    });

    it('published keyword → HOLD (stage1 dedup)', () => {
        const queueId = uuid();
        const item = makeQueueItem({ id: queueId });
        queueRepo.insert(item);

        // Insert published version in content_index
        contentIndexRepo.upsert({
            wp_post_id: 42,
            title: 'Cách đánh golf',
            focus_keyword: 'cách đánh golf',
            slug: 'cach-danh-golf',
            url: 'https://example.com/blog/cach-danh-golf',
            category: 'hoc-golf',
            tags: '[]',
            published_at: new Date().toISOString(),
            content_hash: 'abc123',
            embedding: null,
            updated_at: new Date().toISOString(),
            similarity_score: null,
            similarity_band: null,
            gate_results: null,
        });

        const result = runStage1({
            queueItem: queueRepo.findById(queueId)!,
            queueRepo,
            contentIndexRepo,
        });

        expect(result.ok).toBe(false);
        expect(result.failReason).toBe('keyword_dedup');

        // Queue should be HOLD
        const updated = queueRepo.findById(queueId);
        expect(updated?.status).toBe('hold');
    });

    it('unique key → different keywords process independently', () => {
        const id1 = uuid();
        const id2 = uuid();
        queueRepo.insert(makeQueueItem({
            id: id1,
            picked_keyword: 'cách đánh golf',
            idempotency_key: 'cach-danh-golf__BlogPost__vi',
        }));
        queueRepo.insert(makeQueueItem({
            id: id2,
            picked_keyword: 'grip golf',
            normalized_keyword: 'grip golf',
            idempotency_key: 'grip-golf__BlogPost__vi',
        }));

        const r1 = runStage1({
            queueItem: queueRepo.findById(id1)!,
            queueRepo,
            contentIndexRepo,
        });
        const r2 = runStage1({
            queueItem: queueRepo.findById(id2)!,
            queueRepo,
            contentIndexRepo,
        });

        expect(r1.ok).toBe(true);
        expect(r2.ok).toBe(true);
    });

    it('recently published keyword within cooldown → HOLD', () => {
        const id1 = uuid();
        const id2 = uuid();

        // First item: published
        queueRepo.insert(makeQueueItem({
            id: id1,
            status: 'published',
            idempotency_key: `key-${id1}`,
        }));

        // Second item: same keyword, different key
        queueRepo.insert(makeQueueItem({
            id: id2,
            idempotency_key: `key-${id2}`,
        }));

        // First item should have recent publish
        const hasRecent = queueRepo.hasRecentPublish('cách đánh golf', 14);
        expect(hasRecent).toBe(true);
    });
});
