-- Migration 003: Create local_db table
-- Ref: 13_CONTENT_OPS_PIPELINE §6.2.3

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
