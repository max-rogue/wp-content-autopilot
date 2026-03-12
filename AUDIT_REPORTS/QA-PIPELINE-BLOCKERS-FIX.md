# QA Audit Report - PIPELINE BLOCKERS FIX

## Verdict
HOLD

## Execution Evidence
- npm test: FAIL (9 files, 41 tests)
- npx tsc --noEmit: PASS
- npm run lint: FAIL (missing script)
- docker compose ps: PASS with warning on obsolete version key

## Issue 1
- Status: FAIL
- Severity: P1
- Spec Reference: docs/spec/test/00_TEST_STRATEGY.md; docs/spec/test/01_GLOBAL_ASSUMPTIONS.md
- Description: Required primary QA authority files and PIPELINE-CONTRACTS.md are missing, blocking full spec-grounded validation.
- Reproduction Steps: read missing files and search for PIPELINE-CONTRACTS.md
- Expected vs Actual: expected files present; actual files absent.

## Issue 2
- Status: FAIL
- Severity: P1
- Spec Reference: .github/workflows/ci.yml build-and-test
- Description: CI readiness broken because test suite is red.
- Reproduction Steps: run npm test
- Expected vs Actual: expected green tests; actual 9 failed files / 41 failed tests.

## Issue 3
- Status: FAIL
- Severity: P1
- Spec Reference: src/db/repositories.ts PublishQueueRepo.insert
- Description: Helper patch incomplete. Multiple tests omit news_source_url/news_source_name and crash with missing named parameter.
- Reproduction Steps: run npm test and inspect failing tests in db.test/idempotency.test/operability.test/hardening.test/internal-links.test
- Expected vs Actual: expected helper parity with schema; actual stale helper inserts.

## Issue 4
- Status: FAIL
- Severity: P2
- Spec Reference: src/types.ts EntityType; src/db/migrate.ts runMigrations
- Description: No migration path for existing local_db rows/constraints after EntityType CHECK change. Existing DBs are not transformed.
- Reproduction Steps: inspect runMigrations skip-by-version behavior and absence of ALTER/rebuild migration for local_db.
- Expected vs Actual: expected explicit idempotent transition; actual no transition path.

## Issue 5
- Status: FAIL
- Severity: P2
- Spec Reference: migrations/003_create_local_db.sql vs src/db/migrate.ts
- Description: SQL migration artifact still uses old entity_type enum while runtime migration uses new generic enum.
- Reproduction Steps: compare both CHECK constraints.
- Expected vs Actual: expected one consistent schema authority; actual mismatch.

## Issue 6
- Status: FAIL
- Severity: P2
- Spec Reference: src/config.ts defaultLanguage; src/server.ts; src/services/csv-ingest.ts; src/services/news-ingest.ts
- Description: defaultLanguage propagation is partial. POST /run uses config.defaultLanguage, but ingest-keywords and ingest-news still force vi.
- Reproduction Steps: inspect language assignment in each insert path.
- Expected vs Actual: expected consistent config-driven language behavior; actual mixed behavior by entrypoint.

## Issue 7
- Status: FAIL
- Severity: P2
- Spec Reference: src/server.test.ts
- Description: No behavioral integration test asserts /run inserts language from config.defaultLanguage; tests only assert route presence.
- Reproduction Steps: inspect src/server.test.ts cases.
- Expected vs Actual: expected behavior assertion; actual route-only checks.

## Issue 8
- Status: FAIL
- Severity: P2
- Spec Reference: src/stages/stage1.test.ts; src/stages/stage2.test.ts; src/stages/stage5.test.ts
- Description: New tests are mock-heavy and can bypass real contracts (e.g., stage5 Stage4 fixture uses non-contract fields with forced cast).
- Reproduction Steps: compare fixture shape in stage5.test.ts with Stage4Output in src/types.ts.
- Expected vs Actual: expected real contract/persistence validation; actual mocks/casts dominate coverage.

## Issue 9
- Status: FAIL
- Severity: P3
- Spec Reference: src/gates/engine.test.ts; migrations/003_create_local_db.sql; src/config/prompt-loader.test.ts
- Description: Branding/entity legacy strings remain (Golfy, golf_course, old enum values).
- Reproduction Steps: search for Golfy and old entity tokens.
- Expected vs Actual: expected clean de-branding sweep; actual residual tokens remain.

## Issue 10
- Status: FAIL
- Severity: P2
- Spec Reference: .gitignore; Dockerfile
- Description: Ephemeral DB sidecar artifacts are present and data/ is copied into image, increasing hygiene risk.
- Reproduction Steps: inspect .gitignore patterns, Dockerfile COPY data/, and existing data/*.db-wal/db-shm files.
- Expected vs Actual: expected sidecar artifacts excluded from VCS/image; actual included/present.

## Issue 11
- Status: FAIL
- Severity: P3
- Spec Reference: docker-compose.yml
- Description: Compose warns top-level version key is obsolete and ignored.
- Reproduction Steps: run docker compose ps.
- Expected vs Actual: expected warning-free compose schema; actual warning emitted.

## Issue 12
- Status: FAIL
- Severity: P3
- Spec Reference: CHANGELOG.md; src/db/migrate.ts
- Description: Changelog claims 5 migration versions while runtime migrations extend beyond that.
- Reproduction Steps: compare CHANGELOG statement vs migration list in code.
- Expected vs Actual: expected accurate changelog; actual stale claim.

## Pass Signals
- schema_version constant and outputs remain 1.0.
- Gate IDs G1-G8 and status enum remain intact.
- G2 thresholds remain 0.70/0.80 contract bands.
- POST /run now reads defaultLanguage from config.
- keyword_example.csv rename side effects: no old-name references found.

## Final Decision
HOLD
