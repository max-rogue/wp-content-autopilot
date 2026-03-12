/**
 * Express HTTP server for WP Content Autopilot.
 * Ref: 15_DEPLOYMENT_AND_RUNBOOK §6.2, 13_CONTENT_OPS_PIPELINE §6.5.1
 *
 * Endpoints:
 *   GET  /health         → HealthResponse
 *   GET  /status         → StatusResponse
 *   GET  /queue/summary  → QueueSummaryResponse
 *   POST /run            → RunResponse (triggers pipeline)
 *   POST /ingest-news    → NewsIngestResult (triggers news RSS fetch)
 */

// Bootstrap: auto-load .env + resolve env var aliases (must be first import)
import './env-bootstrap';

import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { loadConfig } from './config';
import { getDb, runMigrations } from './db/migrate';
import { PublishQueueRepo, SettingsRepo } from './db/repositories';
import { normalizeKeyword } from './gates/engine';
import { logger } from './logger';
import { runPipeline } from './runner';
import { SCHEMA_VERSION } from './types';
import type {
    HealthResponse,
    StatusResponse,
    QueueSummaryResponse,
    RunResponse,
    ContentType,
} from './types';

/** Validate content_type against allowed enum values */
function isValidContentType(v: unknown): v is ContentType {
    return (
        typeof v === 'string' &&
        ['BlogPost', 'Glossary', 'CategoryPage', 'LandingSection'].includes(v)
    );
}

export function createApp() {
    const app = express();
    app.use(helmet());
    app.use(express.json());

    const config = loadConfig();
    const startupAt = new Date().toISOString();
    const startupMs = Date.now();

    /**
     * GET /health
     * Service health check.
     */
    app.get('/health', (_req: Request, res: Response) => {
        const response: HealthResponse = {
            status: 'ok',
            time: new Date().toISOString(),
            version: SCHEMA_VERSION,
            startup_at: startupAt,
            uptime_seconds: Math.floor((Date.now() - startupMs) / 1000),
        };
        res.json(response);
    });

    /**
     * GET /status
     * Pipeline status: throttle, ramp, quota, last run.
     */
    app.get('/status', (_req: Request, res: Response) => {
        try {
            const db = getDb(config.dbPath);
            runMigrations(db);
            const settingsRepo = new SettingsRepo(db);
            const settings = settingsRepo.get();
            db.close();

            const response: StatusResponse = {
                schema_version: SCHEMA_VERSION,
                throttle_state: settings.throttle_state,
                ramp_state: settings.ramp_state,
                daily_quota: settings.daily_quota,
                last_run_at: settings.last_run_at,
            };
            res.json(response);
        } catch (err) {
            logger.error('GET /status error', { error: String(err) });
            res.status(500).json({ error: 'internal_error' });
        }
    });

    /**
     * GET /queue/summary
     * Queue status summary — counts per status value.
     */
    app.get('/queue/summary', (_req: Request, res: Response) => {
        try {
            const db = getDb(config.dbPath);
            runMigrations(db);
            const queueRepo = new PublishQueueRepo(db);
            const counts = queueRepo.countByStatus();
            db.close();

            const response: QueueSummaryResponse = {
                schema_version: SCHEMA_VERSION,
                ...counts,
            };
            res.json(response);
        } catch (err) {
            logger.error('GET /queue/summary error', { error: String(err) });
            res.status(500).json({ error: 'internal_error' });
        }
    });

    /**
     * POST /run
     * Trigger a pipeline run.
     *
     * Optional body (backward-compatible):
     *   { keyword: string, idempotency_key?: string, content_type?: ContentType }
     *
     * If keyword is present:
     *   - Normalizes keyword
     *   - Computes or uses provided idempotency_key
     *   - Inserts a planned row if not already exists (UNIQUE idempotency enforced)
     *   - Then runs the pipeline
     *
     * If body is absent/empty: existing behavior (run next planned queue row).
     * Rejects if throttle_state is 'paused'.
     */
    app.post('/run', async (req: Request, res: Response) => {
        try {
            const db = getDb(config.dbPath);
            runMigrations(db);
            const settingsRepo = new SettingsRepo(db);
            const settings = settingsRepo.get();

            if (settings.throttle_state === 'paused') {
                db.close();
                const response: RunResponse = {
                    schema_version: SCHEMA_VERSION,
                    run_id: '',
                    status: 'rejected',
                    reason: 'throttle_paused',
                };
                res.status(409).json(response);
                return;
            }

            // ── Optional body: enqueue keyword before running ──────
            const body = req.body;
            if (body && typeof body.keyword === 'string' && body.keyword.trim()) {
                const keyword = body.keyword.trim();
                const normalized = normalizeKeyword(keyword);
                const contentType: ContentType = isValidContentType(body.content_type)
                    ? body.content_type
                    : 'BlogPost';

                // Deterministic idempotency_key: use provided or hash(normalized + date)
                const idempotencyKey: string =
                    typeof body.idempotency_key === 'string' && body.idempotency_key.trim()
                        ? body.idempotency_key.trim()
                        : crypto
                            .createHash('sha256')
                            .update(`${normalized}::${new Date().toISOString().slice(0, 10)}`)
                            .digest('hex')
                            .slice(0, 32);

                const queueRepo = new PublishQueueRepo(db);

                // Accept optional canonical_category (CSV slug) from body
                const canonicalCategory: string | null =
                    typeof body.canonical_category === 'string' && body.canonical_category.trim()
                        ? body.canonical_category.trim()
                        : null;

                // Idempotency: same key must not duplicate (§6.6)
                const existing = queueRepo.findByIdempotencyKey(idempotencyKey);
                if (!existing) {
                    queueRepo.insert({
                        id: uuid(),
                        picked_keyword: keyword,
                        normalized_keyword: normalized,
                        language: config.defaultLanguage,
                        idempotency_key: idempotencyKey,
                        cluster: '',
                        content_type: contentType,
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
                        canonical_category: canonicalCategory,
                        news_source_url: null,
                        news_source_name: null,
                    });
                    logger.info('POST /run: enqueued keyword', {
                        normalized_keyword: normalized,
                        idempotency_key: idempotencyKey,
                    });
                } else {
                    logger.info('POST /run: idempotency_key already exists — skipping insert', {
                        idempotency_key: idempotencyKey,
                    });
                }
            }

            db.close();

            // Start pipeline run (picks next planned row)
            const result = await runPipeline();

            const response: RunResponse = {
                schema_version: SCHEMA_VERSION,
                run_id: result.run_id,
                status: 'started',
            };
            res.json(response);
        } catch (err) {
            logger.error('POST /run error', { error: String(err) });
            res.status(500).json({ error: 'internal_error' });
        }
    });

    /**
     * POST /ingest-news
     * Manually trigger news RSS ingestion.
     * Returns the ingest result JSON (inserted, skipped, feeds, errors).
     */
    app.post('/ingest-news', async (_req: Request, res: Response) => {
        try {
            if (!config.newsEnabled) {
                res.status(200).json({
                    schema_version: SCHEMA_VERSION,
                    status: 'skipped',
                    reason: 'NEWS_ENABLED=false',
                });
                return;
            }

            if (!config.newsFeeds || config.newsFeeds.length === 0) {
                res.status(200).json({
                    schema_version: SCHEMA_VERSION,
                    status: 'skipped',
                    reason: 'NEWS_FEEDS is empty',
                });
                return;
            }

            const { ingestNews } = await import('./services/news-ingest');
            const db = getDb(config.dbPath);
            runMigrations(db);

            const result = await ingestNews(db, {
                feedUrls: config.newsFeeds,
                lookbackHours: config.newsLookbackHours,
                maxItems: config.newsMaxItemsPerTick,
                httpTimeoutMs: config.newsHttpTimeoutMs,
            });

            db.close();
            res.json(result);
        } catch (err) {
            logger.error('POST /ingest-news error', { error: String(err) });
            res.status(500).json({ error: 'internal_error' });
        }
    });

    return app;
}

import { startScheduler } from './scheduler';

// Start server if run directly
if (require.main === module) {
    const config = loadConfig();

    // ── Observability: log effective operator-tunable config (NO secrets) ──
    logger.info('EffectiveCronConfig', {
        cron_enabled: config.cronEnabled,
        cron_schedule: config.cronSchedule,
        cron_timezone: config.cronTimezone,
        system_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        publish_posture: config.publishPosture,
        publish_posture_source: config.publishPostureSource,
        max_jobs_per_tick: config.maxJobsPerTick,
    });

    logger.info('EffectiveLlmConfig', {
        gemini_thinking_level: config.geminiThinkingLevel || 'OFF',
        research: {
            provider: config.llmResearchProvider,
            model: config.llmResearchModel,
            maxOutputTokens: config.maxOutputTokensResearch,
            grounding: config.llmResearchGrounding || 'none',
        },
        draft: {
            provider: config.llmDraftProvider,
            model: config.llmDraftModel,
            maxOutputTokens: config.maxOutputTokensDraft,
        },
        final: {
            provider: config.llmFinalProvider,
            model: config.llmFinalModel,
            maxOutputTokens: config.maxOutputTokensFinal,
        },
        html: {
            provider: config.llmFinalProvider,
            model: config.llmFinalModel,
            maxOutputTokens: config.maxOutputTokensHtml,
        },
        image: {
            provider: config.llmImageProvider,
            model: config.llmImageModel,
            required: config.llmImageRequired,
        },
    });

    const app = createApp();
    const port = config.servicePort;

    // Ensure DB is ready
    const db = getDb(config.dbPath);
    runMigrations(db);
    db.close();

    app.listen(port, () => {
        logger.info(`WP Content Autopilot server listening on port ${port}`);
        // Start scheduler after server is ready (uses internal runPipeline, no HTTP)
        startScheduler(config);
    });
}
