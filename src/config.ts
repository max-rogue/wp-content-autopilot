/**
 * Configuration loader — reads from environment variables only.
 * Secrets must NEVER be hardcoded. Ref: 14_SECURITY_PRIVACY §6.1
 */

import type { ThrottleState, RampState, PublishPosture, PublishPostureSource } from './types';

export interface PipelineConfig {
  // App
  appEnv: string;
  siteBaseUrl: string;
  serviceBaseUrl: string;
  servicePort: number;

  // WordPress
  wpBaseUrl: string;
  wpApiUser: string;
  wpApplicationPassword: string;

  // AI — per-provider keys (canonical wins, AI_API_KEY is legacy fallback)
  aiProvider: string;
  aiApiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  llmResearchProvider: string;
  llmResearchModel: string;
  llmDraftProvider: string;
  llmDraftModel: string;
  llmFinalProvider: string;
  llmFinalModel: string;
  llmImageProvider: string;
  llmImageModel: string;
  llmResearchGrounding: string;
  llmImageRequired: boolean;
  /** 'genai_sdk' (default, recommended) or 'raw_http' */
  geminiApiMode: string;

  // Media
  mediaProvider: string;
  mediaApiKey: string;

  // Pipeline
  publishPosture: PublishPosture;
  publishPostureSource: PublishPostureSource;
  dailyJobQuota: number;
  requireHumanApproval: boolean;
  logLevel: string;

  // Throttle
  stopOnCoverageSpike: boolean;
  stopOnIndexDrop: boolean;
  stopOnFailRate: boolean;

  // Thresholds
  indexingLagThreshold: number;
  coverageErrorWowThreshold: number;
  impressionsDropThreshold: number;

  // Embedding
  embeddingProvider: string;
  embeddingEndpoint: string;
  embeddingApiKey: string;

  // Local DB
  localDbEnabled: boolean;
  dbPath: string;

  // Keyword CSV
  keywordCsvPath: string;

  // Cron / Scheduler
  cronEnabled: boolean;
  cronSchedule: string;
  cronTimezone: string;

  // ── Throughput & Cost Control (INTERNAL CONFIG — no API exposure) ────
  maxConcurrentRuns: number;
  maxJobsPerTick: number;
  dailyCostCapUsd: number;
  perJobCostCapUsd: number;
  maxRetryAttempts: number;
  retryBackoffMs: number;
  jitterMs: number;

  /**
   * PIPELINE_DAILY_QUOTA — optional env-level override for daily quota.
   * When set (valid int >= 0), overrides settings.daily_quota from DB.
   * When undefined (env var unset/invalid), Stage 0 uses DB value.
   */
  pipelineDailyQuota: number | undefined;

  // ── Recovery (INTERNAL CONFIG) ──────────────────────────────────────
  recoveryReplayLimit: number;
  recoveryLookbackMinutes: number;

  // Rank Math keys (discovered per environment — §12 6.6)
  rankmath: {
    keyTitle: string;
    keyDescription: string;
    keyFocusKeyword: string;
    keyRobots: string;
    keyCanonical: string;
    keySchemaType: string;
  };

  // ── Feature Flags ─────────────────────────────────────────────────
  /** INTERNAL_LINKS_ENABLED — default OFF. Runtime gate: flag && sitemap_pairs_count >= 20 */
  internalLinksEnabled: boolean;

  // ── Gemini Thinking ───────────────────────────────────────────────
  /** Thinking level for Gemini models: 'HIGH' | 'MEDIUM' | 'LOW' | 'MINIMAL' | '' (off) */
  geminiThinkingLevel: string;

  // ── Per-stage output token budgets ────────────────────────────────
  maxOutputTokensResearch: number;
  maxOutputTokensDraft: number;
  maxOutputTokensFinal: number;
  maxOutputTokensHtml: number;

  // ── Sitemap Snippet Caps ──────────────────────────────────────────
  /** Max URLs to include in the sitemap snippet passed to Stage 3. Default: 20 */
  sitemapSnippetMaxUrls: number;
  /** Max total characters for the sitemap snippet string. Default: 4000 */
  sitemapSnippetMaxChars: number;

  // ── News Ingest (optional, disabled by default) ───────────────────
  /** NEWS_ENABLED — default false. When true, scheduler runs RSS ingest before pipeline. */
  newsEnabled: boolean;
  /** NEWS_FEEDS — comma-separated list of RSS/Atom feed URLs */
  newsFeeds: string[];
  /** NEWS_LOOKBACK_HOURS — only ingest items published within this window. Default: 24 */
  newsLookbackHours: number;
  /** NEWS_MAX_ITEMS_PER_TICK — hard cap on news items ingested per cron tick. Default: 3 */
  newsMaxItemsPerTick: number;
  /** NEWS_HTTP_TIMEOUT_MS — timeout for fetching individual RSS feeds. Default: 5000 */
  newsHttpTimeoutMs: number;

  // ── Content Defaults ──────────────────────────────────────────────
  /** DEFAULT_LANGUAGE — ISO code for content language. Default: 'en' */
  defaultLanguage: string;

  // ── Security ──────────────────────────────────────────────────────
  /** PIPELINE_API_KEY — Bearer token for authenticating API requests. */
  pipelineApiKey: string;
}

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  return '';
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  // G8 FIX: Clamp to non-negative to prevent disabling guardrails.
  return isNaN(n) ? fallback : Math.max(0, n);
}

/**
 * Read an optional integer env var. Returns undefined if the var is unset,
 * empty, or not a valid integer. Returns the parsed int when valid and >= 0.
 */
function envOptionalInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Resolve PUBLISH_POSTURE with source tracking.
 * Returns both the resolved posture and where it came from.
 */
export function resolvePublishPosture(rawValue?: string): {
  posture: PublishPosture;
  source: PublishPostureSource;
} {
  const raw = rawValue !== undefined ? rawValue : env('PUBLISH_POSTURE', '');
  if (raw === '') {
    return { posture: 'auto_publish', source: 'default' };
  }
  if (raw === 'auto_publish' || raw === 'always_draft') {
    return { posture: raw, source: 'env' };
  }
  // Unrecognised value → fail-safe to always_draft
  return { posture: 'always_draft', source: 'invalid_fallback' };
}

export function loadConfig(): PipelineConfig {
  const { posture, source } = resolvePublishPosture();

  return {
    appEnv: env('APP_ENV', 'local'),
    siteBaseUrl: env('SITE_BASE_URL', 'http://localhost:8080'),
    serviceBaseUrl: env('SERVICE_BASE_URL', 'http://127.0.0.1:3100'),
    servicePort: envNum('SERVICE_PORT', 3100),

    wpBaseUrl: env('WP_BASE_URL', 'http://localhost:8080'),
    wpApiUser: env('WP_API_USER', ''),
    wpApplicationPassword: env('WP_APPLICATION_PASSWORD', ''),

    aiProvider: env('AI_PROVIDER', 'openai'),
    aiApiKey: env('AI_API_KEY', ''),
    // Per-provider keys: canonical wins, AI_API_KEY is legacy fallback
    openaiApiKey: env('OPENAI_API_KEY', '') || env('AI_API_KEY', ''),
    geminiApiKey: env('GEMINI_API_KEY', '') || env('AI_API_KEY', ''),
    llmResearchProvider: env('LLM_RESEARCH_PROVIDER', 'openai'),
    llmResearchModel: env('LLM_RESEARCH_MODEL', 'gpt-4o'),
    llmDraftProvider: env('LLM_DRAFT_PROVIDER', 'openai'),
    llmDraftModel: env('LLM_DRAFT_MODEL', 'gpt-4o'),
    llmFinalProvider: env('LLM_FINAL_PROVIDER', 'openai'),
    llmFinalModel: env('LLM_FINAL_MODEL', 'gpt-4o'),
    llmImageProvider: env('LLM_IMAGE_PROVIDER', 'gemini'),
    llmImageModel: env('LLM_IMAGE_MODEL', 'gemini-2.0-flash'),
    llmResearchGrounding: env('LLM_RESEARCH_GROUNDING', ''),
    llmImageRequired: envBool('LLM_IMAGE_REQUIRED', true),
    geminiApiMode: env('GEMINI_API_MODE', 'genai_sdk'),

    mediaProvider: env('MEDIA_PROVIDER', 'dalle'),
    mediaApiKey: env('MEDIA_API_KEY', ''),

    // PUBLISH_POSTURE: 'auto_publish' (DEFAULT) | 'always_draft' (operator override)
    // auto_publish: Stage 6 publishes when recommendation=PUBLISH and WP confirms
    // always_draft: Stage 6 creates WP drafts only → final_status=draft_wp
    // Unrecognised values fail-safe to 'always_draft'.
    publishPosture: posture,
    publishPostureSource: source,
    dailyJobQuota: envNum('DAILY_JOB_QUOTA', 1),
    requireHumanApproval: envBool('REQUIRE_HUMAN_APPROVAL', true),
    logLevel: env('LOG_LEVEL', 'info'),

    stopOnCoverageSpike: envBool('STOP_PUBLISH_ON_COVERAGE_ERROR_SPIKE', true),
    stopOnIndexDrop: envBool('STOP_PUBLISH_ON_INDEX_DROP', true),
    stopOnFailRate: envBool('STOP_PUBLISH_ON_FAIL_RATE', true),

    indexingLagThreshold: envNum('INDEXING_LAG_THRESHOLD', 0.40),
    coverageErrorWowThreshold: envNum('COVERAGE_ERROR_WOW_THRESHOLD', 0.20),
    impressionsDropThreshold: envNum('IMPRESSIONS_DROP_THRESHOLD', 0.25),

    embeddingProvider: env('EMBEDDING_PROVIDER', 'disabled'),
    embeddingEndpoint: env('EMBEDDING_ENDPOINT', ''),
    embeddingApiKey: env('EMBEDDING_API_KEY', ''),

    localDbEnabled: envBool('LOCAL_DB_ENABLED', true),
    dbPath: env('DB_PATH', './data/pipeline.db'),

    keywordCsvPath: env('KEYWORD_CSV_PATH', './data/keyword.csv'),

    cronEnabled: envBool('CRON_ENABLED', false),
    cronSchedule: env('CRON_SCHEDULE', '0 6 * * *'),
    cronTimezone: env('CRON_TIMEZONE', 'Asia/Ho_Chi_Minh'),

    // Throughput & Cost Control — INTERNAL CONFIG only (no API exposure)
    maxConcurrentRuns: envNum('PIPELINE_MAX_CONCURRENT_RUNS', 1),
    maxJobsPerTick: envNum('PIPELINE_MAX_JOBS_PER_TICK', 1),
    dailyCostCapUsd: envNum('PIPELINE_DAILY_COST_CAP_USD', 5),
    perJobCostCapUsd: envNum('PIPELINE_PER_JOB_COST_CAP_USD', 1),
    maxRetryAttempts: envNum('PIPELINE_MAX_RETRY_ATTEMPTS', 3),
    retryBackoffMs: envNum('PIPELINE_RETRY_BACKOFF_MS', 2000),
    jitterMs: envNum('PIPELINE_JITTER_MS', 250),

    // PIPELINE_DAILY_QUOTA: optional env override for settings.daily_quota
    pipelineDailyQuota: envOptionalInt('PIPELINE_DAILY_QUOTA'),

    // Recovery — INTERNAL CONFIG
    recoveryReplayLimit: envNum('PIPELINE_RECOVERY_REPLAY_LIMIT', 20),
    recoveryLookbackMinutes: envNum('PIPELINE_RECOVERY_LOOKBACK_MINUTES', 60),

    // Rank Math keys — discovered per environment, never hardcoded (§12 6.6)
    rankmath: {
      keyTitle: env('RANKMATH_KEY_TITLE', ''),
      keyDescription: env('RANKMATH_KEY_DESCRIPTION', ''),
      keyFocusKeyword: env('RANKMATH_KEY_FOCUS_KEYWORD', ''),
      keyRobots: env('RANKMATH_KEY_ROBOTS', ''),
      keyCanonical: env('RANKMATH_KEY_CANONICAL', ''),
      keySchemaType: env('RANKMATH_KEY_SCHEMA_TYPE', ''),
    },

    // Feature Flags
    internalLinksEnabled: envBool('INTERNAL_LINKS_ENABLED', false),

    // Gemini Thinking — controls extended reasoning for Gemini 3.x models
    geminiThinkingLevel: env('GEMINI_THINKING_LEVEL', 'HIGH'),

    // Per-stage output token budgets (env-configurable, safe defaults)
    maxOutputTokensResearch: envNum('LLM_MAX_OUTPUT_TOKENS_RESEARCH', 8192),
    maxOutputTokensDraft: envNum('LLM_MAX_OUTPUT_TOKENS_DRAFT', 8192),
    maxOutputTokensFinal: envNum('LLM_MAX_OUTPUT_TOKENS_FINAL', 8192),
    maxOutputTokensHtml: envNum('LLM_MAX_OUTPUT_TOKENS_HTML', 8192),

    // Sitemap snippet caps (prompt context for Stage 3)
    sitemapSnippetMaxUrls: envNum('SITEMAP_SNIPPET_MAX_URLS', 20),
    sitemapSnippetMaxChars: envNum('SITEMAP_SNIPPET_MAX_CHARS', 4000),

    // News Ingest — disabled by default
    newsEnabled: envBool('NEWS_ENABLED', false),
    newsFeeds: env('NEWS_FEEDS', '').split(',').map(s => s.trim()).filter(Boolean),
    newsLookbackHours: envNum('NEWS_LOOKBACK_HOURS', 24),
    newsMaxItemsPerTick: envNum('NEWS_MAX_ITEMS_PER_TICK', 3),
    newsHttpTimeoutMs: envNum('NEWS_HTTP_TIMEOUT_MS', 5000),

    // Content Defaults
    defaultLanguage: env('DEFAULT_LANGUAGE', 'en'),

    // Security
    pipelineApiKey: env('PIPELINE_API_KEY', ''),
  };
}

/**
 * Resolve the API key for a given provider.
 * Per-provider key wins; AI_API_KEY is legacy fallback (already baked into openaiApiKey/geminiApiKey).
 */
export function resolveProviderKey(config: PipelineConfig, provider: string): string {
  if (provider === 'gemini') return config.geminiApiKey;
  if (provider === 'openai') return config.openaiApiKey;
  // Unknown provider — try openai key as default
  return config.openaiApiKey;
}

/**
 * Fail-fast validation: ensure every configured stage has a usable API key.
 * Call at startup or before first pipeline run.
 * Throws with a clear message if any required key is missing.
 */
export function validateProviderKeys(config: PipelineConfig): void {
  const PLACEHOLDER = 'sk-REPLACE_ME';
  const isEmpty = (k: string) => !k || k === PLACEHOLDER || k === 'AIza-REPLACE_ME';

  const checks: Array<{ stage: string; provider: string; key: string }> = [
    { stage: 'research', provider: config.llmResearchProvider, key: resolveProviderKey(config, config.llmResearchProvider) },
    { stage: 'draft', provider: config.llmDraftProvider, key: resolveProviderKey(config, config.llmDraftProvider) },
    { stage: 'final', provider: config.llmFinalProvider, key: resolveProviderKey(config, config.llmFinalProvider) },
  ];

  if (config.llmImageRequired) {
    checks.push({ stage: 'image', provider: config.llmImageProvider, key: resolveProviderKey(config, config.llmImageProvider) });
  }

  if (config.llmResearchGrounding === 'google_search') {
    // Grounding requires gemini key specifically
    const gk = config.geminiApiKey;
    if (isEmpty(gk)) {
      throw new Error(
        'provider_key_missing: grounding=google_search requires GEMINI_API_KEY (or AI_API_KEY with a Gemini key)'
      );
    }
  }

  for (const { stage, provider, key } of checks) {
    if (isEmpty(key)) {
      const envHint = provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
      throw new Error(
        `provider_key_missing: stage=${stage} provider=${provider} requires ${envHint} (or AI_API_KEY as fallback)`
      );
    }
  }
}

/**
 * Check if internal links feature is enabled at runtime.
 * LOCKED: enabled only if INTERNAL_LINKS_ENABLED=true AND sitemap_pairs_count >= 20.
 * Default OFF if env missing.
 */
export function isInternalLinksEnabled(
  config: PipelineConfig,
  sitemapPairsCount: number,
): boolean {
  return config.internalLinksEnabled && sitemapPairsCount >= 20;
}

/**
 * Resolve the effective daily quota for Stage 0 selection logic.
 * Option A: pure runtime override with no DB writes.
 *
 * @param envOverride - PIPELINE_DAILY_QUOTA from config (undefined if env unset)
 * @param dbQuota - settings.daily_quota from SQLite
 * @returns { effectiveQuota, source } — source tracks where the value came from
 */
export function resolveEffectiveQuota(
  envOverride: number | undefined,
  dbQuota: number,
): { effectiveQuota: number; source: 'env' | 'db' } {
  if (envOverride !== undefined) {
    return { effectiveQuota: envOverride, source: 'env' };
  }
  return { effectiveQuota: dbQuota, source: 'db' };
}
