-- Migration 005: Create audit_log table
-- Ref: 13_CONTENT_OPS_PIPELINE §6.6

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
