-- Migration 002: Create content_index table
-- Ref: 13_CONTENT_OPS_PIPELINE §6.2.2

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
