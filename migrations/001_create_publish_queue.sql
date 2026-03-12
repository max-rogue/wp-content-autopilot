-- Migration 001: Create publish_queue table
-- Ref: 13_CONTENT_OPS_PIPELINE §6.2.1
-- SQLite-compatible, structured for future migration to PostgreSQL

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
