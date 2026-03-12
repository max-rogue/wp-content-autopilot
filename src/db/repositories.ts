/**
 * Database repositories for publish_queue, content_index, settings, local_db, audit_log.
 * Traces to 13_CONTENT_OPS_PIPELINE §6.2.
 */

import type Database from 'better-sqlite3';
import type {
  PublishQueueRow,
  ContentIndexRow,
  SettingsRow,
  LocalDbRow,
  AuditEntry,
  QueueStatus,
  SimilarityBand,
  RobotsDecision,
} from '../types';

// ─── Publish Queue Repository ───────────────────────────────────

export class PublishQueueRepo {
  constructor(private db: Database.Database) { }

  insert(row: Omit<PublishQueueRow, 'created_at' | 'updated_at'>): void {
    this.db
      .prepare(
        `INSERT INTO publish_queue (
          id, picked_keyword, normalized_keyword, language, idempotency_key,
          cluster, content_type, class_hint, blogpost_subtype,
          status, scheduled_for, published_url,
          published_wp_id, fail_reasons, model_trace, similarity_score,
          similarity_band, robots_decision, gate_results,
          dropped_tags, wp_tag_not_found, canonical_category,
          news_source_url, news_source_name
        ) VALUES (
          @id, @picked_keyword, @normalized_keyword, @language, @idempotency_key,
          @cluster, @content_type, @class_hint, @blogpost_subtype,
          @status, @scheduled_for, @published_url,
          @published_wp_id, @fail_reasons, @model_trace, @similarity_score,
          @similarity_band, @robots_decision, @gate_results,
          @dropped_tags, @wp_tag_not_found, @canonical_category,
          @news_source_url, @news_source_name
        )`
      )
      .run(row);
  }

  findById(id: string): PublishQueueRow | undefined {
    return this.db.prepare('SELECT * FROM publish_queue WHERE id = ?').get(id) as
      | PublishQueueRow
      | undefined;
  }

  findByIdempotencyKey(key: string): PublishQueueRow | undefined {
    return this.db
      .prepare('SELECT * FROM publish_queue WHERE idempotency_key = ?')
      .get(key) as PublishQueueRow | undefined;
  }

  findByStatus(status: QueueStatus): PublishQueueRow[] {
    return this.db
      .prepare('SELECT * FROM publish_queue WHERE status = ?')
      .all(status) as PublishQueueRow[];
  }

  findPlannedForRun(limit: number): PublishQueueRow[] {
    return this.db
      .prepare(
        `SELECT * FROM publish_queue WHERE status = 'planned'
         ORDER BY
           CASE WHEN news_source_url IS NOT NULL THEN 0 ELSE 1 END ASC,
           scheduled_for ASC, created_at ASC, id ASC
         LIMIT ?`
      )
      .all(limit) as PublishQueueRow[];
  }

  updateStatus(
    id: string,
    status: QueueStatus,
    extra?: {
      fail_reasons?: string;
      published_url?: string;
      published_wp_id?: number;
      similarity_score?: number;
      similarity_band?: SimilarityBand;
      robots_decision?: RobotsDecision;
      gate_results?: string;
      dropped_tags?: string | null;
      wp_tag_not_found?: string | null;
    }
  ): void {
    const sets = ["status = @status", "updated_at = datetime('now')"];
    const params: Record<string, unknown> = { id, status };

    if (extra) {
      for (const [key, val] of Object.entries(extra)) {
        if (val !== undefined) {
          sets.push(`${key} = @${key}`);
          params[key] = val;
        }
      }
    }

    this.db
      .prepare(`UPDATE publish_queue SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
  }

  countByStatus(): Record<QueueStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as cnt FROM publish_queue GROUP BY status')
      .all() as Array<{ status: QueueStatus; cnt: number }>;

    const result: Record<string, number> = {
      planned: 0,
      researching: 0,
      drafting: 0,
      qa: 0,
      draft_wp: 0,
      published: 0,
      hold: 0,
      failed: 0,
    };
    for (const r of rows) {
      result[r.status] = r.cnt;
    }
    return result as Record<QueueStatus, number>;
  }

  /** Check if same normalized keyword was published within cooldown days (§6.4) */
  hasRecentPublish(normalizedKeyword: string, cooldownDays: number): boolean {
    const row = this.db
      .prepare(
        `SELECT id FROM publish_queue
         WHERE normalized_keyword = ?
         AND status = 'published'
         AND updated_at >= datetime('now', '-' || ? || ' days')
         LIMIT 1`
      )
      .get(normalizedKeyword, cooldownDays);
    return !!row;
  }

  /**
   * Find items in non-terminal (interrupted) statuses for recovery replay.
   * Bounded by cutoff time and limit.
   */
  findInterrupted(
    statuses: QueueStatus[],
    cutoffIso: string,
    limit: number
  ): PublishQueueRow[] {
    const placeholders = statuses.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM publish_queue
         WHERE status IN (${placeholders})
         AND updated_at >= ?
         ORDER BY updated_at ASC, id ASC
         LIMIT ?`
      )
      .all(...statuses, cutoffIso, limit) as PublishQueueRow[];
  }

  /**
   * Count items completed today (draft_wp or published) for daily cost tracking.
   */
  countCompletedToday(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM publish_queue
         WHERE status IN ('draft_wp', 'published')
         AND updated_at >= datetime('now', 'start of day')`
      )
      .get() as { cnt: number };
    return row?.cnt || 0;
  }
}

// ─── Content Index Repository ───────────────────────────────────

export class ContentIndexRepo {
  constructor(private db: Database.Database) { }

  upsert(row: ContentIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO content_index (
          wp_post_id, title, focus_keyword, slug, url, category, tags,
          published_at, content_hash, embedding, similarity_score, similarity_band, gate_results
        ) VALUES (
          @wp_post_id, @title, @focus_keyword, @slug, @url, @category, @tags,
          @published_at, @content_hash, @embedding, @similarity_score, @similarity_band, @gate_results
        ) ON CONFLICT(wp_post_id) DO UPDATE SET
          title = @title,
          focus_keyword = @focus_keyword,
          slug = @slug,
          url = @url,
          category = @category,
          tags = @tags,
          content_hash = @content_hash,
          embedding = @embedding,
          updated_at = datetime('now'),
          similarity_score = @similarity_score,
          similarity_band = @similarity_band,
          gate_results = @gate_results`
      )
      .run(row);
  }

  findByFocusKeyword(keyword: string): ContentIndexRow | undefined {
    return this.db
      .prepare('SELECT * FROM content_index WHERE focus_keyword = ?')
      .get(keyword) as ContentIndexRow | undefined;
  }

  findBySlug(slug: string): ContentIndexRow | undefined {
    return this.db
      .prepare('SELECT * FROM content_index WHERE slug = ?')
      .get(slug) as ContentIndexRow | undefined;
  }

  getRecentPublished(limit: number): ContentIndexRow[] {
    return this.db
      .prepare('SELECT * FROM content_index ORDER BY published_at DESC LIMIT ?')
      .all(limit) as ContentIndexRow[];
  }

  findAll(): ContentIndexRow[] {
    return this.db.prepare('SELECT * FROM content_index').all() as ContentIndexRow[];
  }
}

// ─── Settings Repository ────────────────────────────────────────

export class SettingsRepo {
  constructor(private db: Database.Database) { }

  get(): SettingsRow {
    const row = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as
      | SettingsRow
      | undefined;
    return (
      row || {
        daily_quota: 1,
        ramp_state: 'ramp_1' as const,
        throttle_state: 'active' as const,
        last_run_at: null,
      }
    );
  }

  update(partial: Partial<SettingsRow>): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: 1 };

    for (const [key, val] of Object.entries(partial)) {
      if (val !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = val;
      }
    }

    if (sets.length === 0) return;

    this.db
      .prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
  }
}

// ─── Local DB Repository ────────────────────────────────────────

export class LocalDbRepo {
  constructor(private db: Database.Database) { }

  findVerified(cityProvince: string): LocalDbRow[] {
    return this.db
      .prepare(
        `SELECT * FROM local_db
         WHERE city_province = ?
         AND verification_tier IN (1, 2)
         ORDER BY last_verified_at DESC`
      )
      .all(cityProvince) as LocalDbRow[];
  }

  findByName(name: string): LocalDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM local_db WHERE name = ?')
      .get(name) as LocalDbRow | undefined;
  }

  insert(row: LocalDbRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO local_db (
          entity_id, entity_type, name, city_province, address,
          verified_source_url, last_verified_at, verification_tier
        ) VALUES (
          @entity_id, @entity_type, @name, @city_province, @address,
          @verified_source_url, @last_verified_at, @verification_tier
        )`
      )
      .run(row);
  }
}

// ─── Audit Log Repository (§6.6) ───────────────────────────────

export class AuditLogRepo {
  constructor(private db: Database.Database) { }

  insert(entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (
          id, queue_id, run_id, stage_name,
          input_snapshot_hash, output_snapshot_hash,
          gate_decisions, reasons
        ) VALUES (
          @id, @queue_id, @run_id, @stage_name,
          @input_snapshot_hash, @output_snapshot_hash,
          @gate_decisions, @reasons
        )`
      )
      .run(entry);
  }

  findByQueueId(queueId: string): AuditEntry[] {
    return this.db
      .prepare('SELECT * FROM audit_log WHERE queue_id = ? ORDER BY created_at ASC')
      .all(queueId) as AuditEntry[];
  }

  findByRunId(runId: string): AuditEntry[] {
    return this.db
      .prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY created_at ASC')
      .all(runId) as AuditEntry[];
  }
}

// ─── Cron Lock Repository (Scheduler single-leader guard) ───────

export class CronLockRepo {
  constructor(private db: Database.Database) { }

  /**
   * Try to acquire a lock for the given key.
   * Returns true if the lock was acquired (INSERT OR IGNORE succeeded with changes).
   */
  tryAcquire(lockKey: string, runId: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO cron_locks (lock_key, run_id) VALUES (?, ?)')
      .run(lockKey, runId);
    return result.changes > 0;
  }

  /**
   * Release a lock by key.
   */
  release(lockKey: string): void {
    this.db.prepare('DELETE FROM cron_locks WHERE lock_key = ?').run(lockKey);
  }

  /**
   * Clean up old locks (older than N days).
   */
  cleanup(olderThanDays: number): void {
    this.db
      .prepare(
        `DELETE FROM cron_locks WHERE acquired_at < datetime('now', '-' || ? || ' days')`
      )
      .run(olderThanDays);
  }
}
