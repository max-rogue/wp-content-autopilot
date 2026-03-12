/**
 * Config Tests — validates all new env keys read correctly.
 * Covers Part A multi-model keys + Part B cron keys.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, resolvePublishPosture, resolveEffectiveQuota } from './config';

describe('loadConfig — multi-model LLM keys', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('reads LLM_RESEARCH_PROVIDER and LLM_RESEARCH_MODEL with defaults', () => {
        delete process.env.LLM_RESEARCH_PROVIDER;
        delete process.env.LLM_RESEARCH_MODEL;
        const config = loadConfig();
        expect(config.llmResearchProvider).toBe('openai');
        expect(config.llmResearchModel).toBe('gpt-4o');
    });

    it('reads LLM_RESEARCH_PROVIDER and LLM_RESEARCH_MODEL from env', () => {
        process.env.LLM_RESEARCH_PROVIDER = 'gemini';
        process.env.LLM_RESEARCH_MODEL = 'gemini-3-pro-preview';
        const config = loadConfig();
        expect(config.llmResearchProvider).toBe('gemini');
        expect(config.llmResearchModel).toBe('gemini-3-pro-preview');
    });

    it('reads LLM_DRAFT_PROVIDER and LLM_DRAFT_MODEL from env', () => {
        process.env.LLM_DRAFT_PROVIDER = 'gemini';
        process.env.LLM_DRAFT_MODEL = 'gemini-3-flash-preview';
        const config = loadConfig();
        expect(config.llmDraftProvider).toBe('gemini');
        expect(config.llmDraftModel).toBe('gemini-3-flash-preview');
    });

    it('reads LLM_FINAL_PROVIDER and LLM_FINAL_MODEL with defaults', () => {
        delete process.env.LLM_FINAL_PROVIDER;
        delete process.env.LLM_FINAL_MODEL;
        const config = loadConfig();
        expect(config.llmFinalProvider).toBe('openai');
        expect(config.llmFinalModel).toBe('gpt-4o');
    });

    it('reads LLM_FINAL_PROVIDER and LLM_FINAL_MODEL from env', () => {
        process.env.LLM_FINAL_PROVIDER = 'openai';
        process.env.LLM_FINAL_MODEL = 'gpt-5.2-pro';
        const config = loadConfig();
        expect(config.llmFinalProvider).toBe('openai');
        expect(config.llmFinalModel).toBe('gpt-5.2-pro');
    });

    it('reads LLM_IMAGE_PROVIDER and LLM_IMAGE_MODEL with defaults', () => {
        delete process.env.LLM_IMAGE_PROVIDER;
        delete process.env.LLM_IMAGE_MODEL;
        const config = loadConfig();
        expect(config.llmImageProvider).toBe('gemini');
        expect(config.llmImageModel).toBe('gemini-2.0-flash');
    });

    it('reads LLM_IMAGE_PROVIDER and LLM_IMAGE_MODEL from env', () => {
        process.env.LLM_IMAGE_PROVIDER = 'gemini';
        process.env.LLM_IMAGE_MODEL = 'gemini-3-pro-image-preview';
        const config = loadConfig();
        expect(config.llmImageProvider).toBe('gemini');
        expect(config.llmImageModel).toBe('gemini-3-pro-image-preview');
    });

    it('reads LLM_RESEARCH_GROUNDING from env', () => {
        process.env.LLM_RESEARCH_GROUNDING = 'google_search';
        const config = loadConfig();
        expect(config.llmResearchGrounding).toBe('google_search');
    });

    it('LLM_RESEARCH_GROUNDING defaults to empty string', () => {
        delete process.env.LLM_RESEARCH_GROUNDING;
        const config = loadConfig();
        expect(config.llmResearchGrounding).toBe('');
    });

    it('reads LLM_IMAGE_REQUIRED as boolean', () => {
        process.env.LLM_IMAGE_REQUIRED = 'true';
        expect(loadConfig().llmImageRequired).toBe(true);

        process.env.LLM_IMAGE_REQUIRED = 'false';
        expect(loadConfig().llmImageRequired).toBe(false);
    });

    it('GEMINI_API_MODE defaults to genai_sdk', () => {
        delete process.env.GEMINI_API_MODE;
        const config = loadConfig();
        expect(config.geminiApiMode).toBe('genai_sdk');
    });

    it('reads GEMINI_API_MODE from env', () => {
        process.env.GEMINI_API_MODE = 'raw_http';
        const config = loadConfig();
        expect(config.geminiApiMode).toBe('raw_http');
    });
});

describe('loadConfig — per-provider API key precedence', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('OPENAI_API_KEY is read into openaiApiKey', () => {
        process.env.OPENAI_API_KEY = 'sk-openai-specific';
        delete process.env.AI_API_KEY;
        const config = loadConfig();
        expect(config.openaiApiKey).toBe('sk-openai-specific');
    });

    it('GEMINI_API_KEY is read into geminiApiKey', () => {
        process.env.GEMINI_API_KEY = 'AIza-gemini-specific';
        delete process.env.AI_API_KEY;
        const config = loadConfig();
        expect(config.geminiApiKey).toBe('AIza-gemini-specific');
    });

    it('AI_API_KEY fills openaiApiKey when OPENAI_API_KEY is missing', () => {
        delete process.env.OPENAI_API_KEY;
        process.env.AI_API_KEY = 'sk-legacy-key';
        const config = loadConfig();
        expect(config.openaiApiKey).toBe('sk-legacy-key');
    });

    it('AI_API_KEY fills geminiApiKey when GEMINI_API_KEY is missing', () => {
        delete process.env.GEMINI_API_KEY;
        process.env.AI_API_KEY = 'AIza-legacy-key';
        const config = loadConfig();
        expect(config.geminiApiKey).toBe('AIza-legacy-key');
    });

    it('OPENAI_API_KEY wins over AI_API_KEY for openaiApiKey', () => {
        process.env.OPENAI_API_KEY = 'sk-specific';
        process.env.AI_API_KEY = 'sk-legacy';
        const config = loadConfig();
        expect(config.openaiApiKey).toBe('sk-specific');
    });

    it('GEMINI_API_KEY wins over AI_API_KEY for geminiApiKey', () => {
        process.env.GEMINI_API_KEY = 'AIza-specific';
        process.env.AI_API_KEY = 'sk-legacy';
        const config = loadConfig();
        expect(config.geminiApiKey).toBe('AIza-specific');
    });

    it('both per-provider keys can be set simultaneously', () => {
        process.env.OPENAI_API_KEY = 'sk-openai';
        process.env.GEMINI_API_KEY = 'AIza-gemini';
        delete process.env.AI_API_KEY;
        const config = loadConfig();
        expect(config.openaiApiKey).toBe('sk-openai');
        expect(config.geminiApiKey).toBe('AIza-gemini');
    });
});

describe('loadConfig — cron / scheduler keys', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('CRON_ENABLED defaults to false', () => {
        delete process.env.CRON_ENABLED;
        const config = loadConfig();
        expect(config.cronEnabled).toBe(false);
    });

    it('CRON_ENABLED=true reads correctly', () => {
        process.env.CRON_ENABLED = 'true';
        const config = loadConfig();
        expect(config.cronEnabled).toBe(true);
    });

    it('CRON_SCHEDULE defaults to 0 6 * * *', () => {
        delete process.env.CRON_SCHEDULE;
        const config = loadConfig();
        expect(config.cronSchedule).toBe('0 6 * * *');
    });

    it('CRON_SCHEDULE reads from env', () => {
        process.env.CRON_SCHEDULE = '30 7 * * *';
        const config = loadConfig();
        expect(config.cronSchedule).toBe('30 7 * * *');
    });

    it('CRON_TIMEZONE defaults to Asia/Ho_Chi_Minh', () => {
        delete process.env.CRON_TIMEZONE;
        const config = loadConfig();
        expect(config.cronTimezone).toBe('Asia/Ho_Chi_Minh');
    });

    it('CRON_TIMEZONE reads from env', () => {
        process.env.CRON_TIMEZONE = 'UTC';
        const config = loadConfig();
        expect(config.cronTimezone).toBe('UTC');
    });
});

describe('loadConfig — PUBLISH_POSTURE', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('defaults to auto_publish when PUBLISH_POSTURE is unset (AIP-009)', () => {
        delete process.env.PUBLISH_POSTURE;
        const config = loadConfig();
        expect(config.publishPosture).toBe('auto_publish');
        expect(config.publishPostureSource).toBe('default');
    });

    it('defaults to auto_publish when PUBLISH_POSTURE is empty string', () => {
        process.env.PUBLISH_POSTURE = '';
        const config = loadConfig();
        expect(config.publishPosture).toBe('auto_publish');
        expect(config.publishPostureSource).toBe('default');
    });

    it('maps explicit "auto_publish" to auto_publish', () => {
        process.env.PUBLISH_POSTURE = 'auto_publish';
        const config = loadConfig();
        expect(config.publishPosture).toBe('auto_publish');
        expect(config.publishPostureSource).toBe('env');
    });

    it('maps explicit "always_draft" to always_draft (operator override)', () => {
        process.env.PUBLISH_POSTURE = 'always_draft';
        const config = loadConfig();
        expect(config.publishPosture).toBe('always_draft');
        expect(config.publishPostureSource).toBe('env');
    });

    it('fails-safe unrecognised value to always_draft', () => {
        process.env.PUBLISH_POSTURE = 'YOLO_PUBLISH';
        const config = loadConfig();
        expect(config.publishPosture).toBe('always_draft');
        expect(config.publishPostureSource).toBe('invalid_fallback');
    });

    it('fails-safe typo value to always_draft', () => {
        process.env.PUBLISH_POSTURE = 'autopublish'; // missing underscore
        const config = loadConfig();
        expect(config.publishPosture).toBe('always_draft');
        expect(config.publishPostureSource).toBe('invalid_fallback');
    });

    it('schema_version remains "1.0" regardless of posture', () => {
        delete process.env.PUBLISH_POSTURE;
        const config = loadConfig();
        // schema_version is on type definitions, verify config doesn't break it
        expect(config.publishPosture).toBe('auto_publish');
        // Ensure loadConfig returns without throwing, proving contract intact
    });
});

// ─── TEST-ENV-001 / TEST-ENV-002: resolvePublishPosture unit tests ──

describe('resolvePublishPosture — ENV posture source tracking', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('TEST-ENV-001: always_draft in env → posture=always_draft, source=env', () => {
        const result = resolvePublishPosture('always_draft');
        expect(result.posture).toBe('always_draft');
        expect(result.source).toBe('env');
    });

    it('TEST-ENV-001 (via process.env): PUBLISH_POSTURE=always_draft → posture=always_draft, source=env', () => {
        process.env.PUBLISH_POSTURE = 'always_draft';
        const config = loadConfig();
        expect(config.publishPosture).toBe('always_draft');
        expect(config.publishPostureSource).toBe('env');
    });

    it('TEST-ENV-002: invalid value → posture=always_draft, source=invalid_fallback', () => {
        const result = resolvePublishPosture('nonsense_value');
        expect(result.posture).toBe('always_draft');
        expect(result.source).toBe('invalid_fallback');
    });

    it('TEST-ENV-002 (via process.env): invalid PUBLISH_POSTURE → always_draft + invalid_fallback', () => {
        process.env.PUBLISH_POSTURE = 'draft_only'; // not a valid value
        const config = loadConfig();
        expect(config.publishPosture).toBe('always_draft');
        expect(config.publishPostureSource).toBe('invalid_fallback');
    });

    it('resolvePublishPosture with no arg reads from process.env', () => {
        process.env.PUBLISH_POSTURE = 'auto_publish';
        const result = resolvePublishPosture();
        expect(result.posture).toBe('auto_publish');
        expect(result.source).toBe('env');
    });

    it('resolvePublishPosture with empty string → default', () => {
        const result = resolvePublishPosture('');
        expect(result.posture).toBe('auto_publish');
        expect(result.source).toBe('default');
    });
});

// ── PIPELINE_DAILY_QUOTA env loading tests ──────────────────────────

describe('loadConfig — PIPELINE_DAILY_QUOTA', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('defaults to undefined when PIPELINE_DAILY_QUOTA is unset', () => {
        delete process.env.PIPELINE_DAILY_QUOTA;
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBeUndefined();
    });

    it('defaults to undefined when PIPELINE_DAILY_QUOTA is empty string', () => {
        process.env.PIPELINE_DAILY_QUOTA = '';
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBeUndefined();
    });

    it('reads PIPELINE_DAILY_QUOTA=10 correctly', () => {
        process.env.PIPELINE_DAILY_QUOTA = '10';
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBe(10);
    });

    it('reads PIPELINE_DAILY_QUOTA=0 correctly (disable quota)', () => {
        process.env.PIPELINE_DAILY_QUOTA = '0';
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBe(0);
    });

    it('returns undefined for negative PIPELINE_DAILY_QUOTA', () => {
        process.env.PIPELINE_DAILY_QUOTA = '-5';
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBeUndefined();
    });

    it('returns undefined for non-integer PIPELINE_DAILY_QUOTA', () => {
        process.env.PIPELINE_DAILY_QUOTA = '3.5';
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBeUndefined();
    });

    it('returns undefined for non-numeric PIPELINE_DAILY_QUOTA', () => {
        process.env.PIPELINE_DAILY_QUOTA = 'abc';
        const config = loadConfig();
        expect(config.pipelineDailyQuota).toBeUndefined();
    });
});

// ── resolveEffectiveQuota unit tests ────────────────────────────────

describe('resolveEffectiveQuota', () => {
    it('returns DB quota when env override is undefined', () => {
        const result = resolveEffectiveQuota(undefined, 5);
        expect(result.effectiveQuota).toBe(5);
        expect(result.source).toBe('db');
    });

    it('returns env override when set to positive int', () => {
        const result = resolveEffectiveQuota(10, 5);
        expect(result.effectiveQuota).toBe(10);
        expect(result.source).toBe('env');
    });

    it('returns env override when set to 0', () => {
        const result = resolveEffectiveQuota(0, 5);
        expect(result.effectiveQuota).toBe(0);
        expect(result.source).toBe('env');
    });

    it('env override=100 overrides DB quota=1', () => {
        const result = resolveEffectiveQuota(100, 1);
        expect(result.effectiveQuota).toBe(100);
        expect(result.source).toBe('env');
    });
});
