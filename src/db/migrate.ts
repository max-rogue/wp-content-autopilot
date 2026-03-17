/**
 * SQLite migrations for the WP Content Autopilot pipeline.
 * Schema traces to 13_CONTENT_OPS_PIPELINE §6.2.
 * Structured for future migration to PostgreSQL.
 */

// Bootstrap: auto-load .env + resolve env var aliases (must be first import)
import '../env-bootstrap';

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'create_publish_queue',
    sql: `
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    name: 'create_content_index',
    sql: `
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
        similarity_band TEXT CHECK(similarity_band IS NULL OR similarity_band IN ('PASS','DRAFT','HOLD')),
        gate_results TEXT
      );
    `,
  },
  {
    version: 3,
    name: 'create_local_db',
    sql: `
      CREATE TABLE IF NOT EXISTS local_db (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('business','service_center','retail_store','professional','venue')),
        name TEXT NOT NULL,
        city_province TEXT NOT NULL,
        address TEXT NOT NULL,
        verified_source_url TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        verification_tier INTEGER NOT NULL CHECK(verification_tier IN (1, 2))
      );
    `,
  },
  {
    version: 4,
    name: 'create_settings',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        daily_quota INTEGER NOT NULL DEFAULT 1,
        ramp_state TEXT NOT NULL DEFAULT 'ramp_1' CHECK(ramp_state IN ('ramp_1','ramp_2','ramp_3','steady')),
        throttle_state TEXT NOT NULL DEFAULT 'active' CHECK(throttle_state IN ('active','reduced','paused')),
        last_run_at TEXT
      );
      INSERT OR IGNORE INTO settings (id, daily_quota, ramp_state, throttle_state) VALUES (1, 1, 'ramp_1', 'active');
    `,
  },
  {
    version: 5,
    name: 'create_audit_log',
    sql: `
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
      CREATE INDEX IF NOT EXISTS idx_audit_queue ON audit_log(queue_id);
      CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);
    `,
  },
  {
    version: 6,
    name: 'create_migration_tracking',
    sql: `
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 7,
    name: 'create_cron_locks',
    sql: `
      CREATE TABLE IF NOT EXISTS cron_locks (
        lock_key TEXT PRIMARY KEY,
        acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
        run_id TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: 'add_tag_tracking_columns',
    sql: `
      ALTER TABLE publish_queue ADD COLUMN dropped_tags TEXT;
      ALTER TABLE publish_queue ADD COLUMN wp_tag_not_found TEXT;
    `,
  },
  {
    version: 9,
    name: 'add_canonical_category_column',
    sql: `
      ALTER TABLE publish_queue ADD COLUMN canonical_category TEXT;
    `,
  },
  {
    version: 10,
    name: 'add_class_hint_and_blogpost_subtype',
    sql: `
      ALTER TABLE publish_queue ADD COLUMN class_hint TEXT NOT NULL DEFAULT 'B' CHECK(class_hint IN ('A','B','C'));
      ALTER TABLE publish_queue ADD COLUMN blogpost_subtype TEXT CHECK(blogpost_subtype IS NULL OR blogpost_subtype IN ('HowTo','BuyingGuide','Comparison','Guide'));
    `,
  },
  {
    version: 11,
    name: 'add_news_source_columns',
    sql: `
      ALTER TABLE publish_queue ADD COLUMN news_source_url TEXT;
      ALTER TABLE publish_queue ADD COLUMN news_source_name TEXT;
    `,
  },
  {
    version: 12,
    name: 'migrate_local_db_entity_type',
    sql: `
      PRAGMA foreign_keys=off;
      CREATE TABLE new_local_db (
        entity_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('business','service_center','retail_store','professional','venue')),
        name TEXT NOT NULL,
        city_province TEXT NOT NULL,
        address TEXT NOT NULL,
        verified_source_url TEXT NOT NULL,
        last_verified_at TEXT NOT NULL,
        verification_tier INTEGER NOT NULL CHECK(verification_tier IN (1, 2))
      );
      -- Legacy migration: maps original golf-niche entity types to generic types.
      -- For non-golf niches these WHEN clauses are no-ops; ELSE 'business' covers all.
      INSERT INTO new_local_db
      SELECT
        entity_id,
        CASE entity_type
          WHEN 'golf_course' THEN 'venue'
          WHEN 'fitting_center' THEN 'service_center'
          WHEN 'golf_shop' THEN 'retail_store'
          WHEN 'coach' THEN 'professional'
          WHEN 'simulator_center' THEN 'venue'
          ELSE 'business'
        END AS entity_type,
        name,
        city_province,
        address,
        verified_source_url,
        last_verified_at,
        verification_tier
      FROM local_db;
      DROP TABLE local_db;
      ALTER TABLE new_local_db RENAME TO local_db;
      PRAGMA foreign_keys=on;
    `,
  },
];

export function getDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): void {
  // Ensure _migrations table exists first
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM _migrations')
      .all()
      .map((r: any) => r.version as number)
  );

  for (const migration of MIGRATIONS) {
    if (migration.name === 'create_migration_tracking') continue; // already created above
    if (applied.has(migration.version)) continue;

    db.exec(migration.sql);
    db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(
      migration.version,
      migration.name
    );
  }
}

// CLI entry for `npm run migrate`
if (require.main === module) {
  const dbPath = process.env.DB_PATH || './data/pipeline.db';
  const db = getDb(dbPath);
  runMigrations(db);
  console.log('Migrations complete.');
  db.close();
}
