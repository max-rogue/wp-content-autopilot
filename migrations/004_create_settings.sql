-- Migration 004: Create settings table with singleton row
-- Ref: 13_CONTENT_OPS_PIPELINE §6.2.4

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  daily_quota INTEGER NOT NULL DEFAULT 1,
  ramp_state TEXT NOT NULL DEFAULT 'ramp_1' CHECK(ramp_state IN ('ramp_1','ramp_2','ramp_3','steady')),
  throttle_state TEXT NOT NULL DEFAULT 'active' CHECK(throttle_state IN ('active','reduced','paused')),
  last_run_at TEXT
);

INSERT OR IGNORE INTO settings (id, daily_quota, ramp_state, throttle_state) VALUES (1, 1, 'ramp_1', 'active');
