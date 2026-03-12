# QA Audit Report - PIPELINE BLOCKERS FIX (Re-Audit)

## Verdict
SHIP

## Execution Evidence
- `npm test`: PASS (`37/37` files, `782/782` tests)
- `npx tsc --noEmit`: PASS
- Contract spot checks in implementation and tests: PASS

## Diagnostic Hypotheses (Debug Method)
Reviewed likely failure sources:
1) Contract drift in queue insert schema
2) EntityType migration non-idempotency
3) DEFAULT_LANGUAGE propagation gaps
4) Gate contract regressions (G1–G8 / thresholds / precedence)
5) No-video regression in Stage 4
6) Docker/compose path divergence
7) Residual branding/rename side effects

Most likely sources after re-audit:
- (A) Docker path divergence between root and `docker/` configs
- (B) Residual cosmetic branding strings in tests/artifacts

Validation logs added during diagnosis:
- `ROOT_TAXONOMY=missing` (root `taxonomy_config.yaml` absent in workspace)
- Dist-only simulation found `tmpiso/dist/config/taxonomy_config.yaml` missing after `tsc`-only flow
- Core quality gates still green: `npm test` + `tsc` both pass

User confirmed classification policy for this release: treat `docker/` as non-authoritative legacy and keep Docker divergence as non-blocking note for this verdict.

## Re-Audit Findings

### 1) Contract Fidelity — PASS
- `SCHEMA_VERSION = "1.0"`, status enum, and G1–G8 IDs remain locked.
- G2 thresholds remain hardcoded at `0.70/0.80` via `similarityBand`.
- Gate precedence in engine remains `HOLD > DRAFT > PUBLISH`.
- Stage 4 remains no-video with `media_mode: "image_only"`.

### 2) EntityType Migration Safety — PASS
- Runtime migration includes explicit mapping migration (`migrate_local_db_entity_type`) with table rebuild + CASE remap.
- SQL artifact parity is now aligned for `local_db` entity type enum.

### 3) DEFAULT_LANGUAGE Propagation — PASS
- `/run` inserts with `config.defaultLanguage`.
- CSV ingest and news ingest insert paths both use `loadConfig().defaultLanguage`.
- Behavioral test exists for `/run` language propagation.

### 4) Queue Insert Contract (`news_source_*`) — PASS
- `PublishQueueRepo.insert` includes `news_source_url` and `news_source_name` placeholders.
- Previously failing helper/test mismatch is resolved (suite is green).

### 5) Security / Secrets / Hardening — PASS
- No hardcoded API keys detected in repo scan.
- Route allowlist tests include `/ingest-news` and show no unexpected routes.

### 6) Branding / Rename Side Effects — PASS (Minor Cosmetic Note)
- Legacy entity tokens exist only in intentional migration mapping (expected).
- Remaining `golfy` hit observed in test wording (`"golfy hero marker"`) is cosmetic and non-runtime.

### 7) Docker / Compose Compatibility — NON-BLOCKING NOTE
- Root docs now mark root `Dockerfile` + `docker-compose.yml` as canonical.
- `docker/` path exists and remains a legacy/parallel path; treat as non-authoritative for this release per confirmed policy.
- Advisory: keep Dockerfile variants in sync and ensure taxonomy config copy path is unambiguous in future cleanup.

## Risk Summary
- Blocking product/runtime regressions found: **none**
- Non-blocking operational/documentation debt: **Docker path divergence cleanup**

## Final Decision
SHIP
