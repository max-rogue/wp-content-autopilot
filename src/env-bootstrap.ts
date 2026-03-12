/**
 * Environment bootstrap — dotenv auto-load + env var compatibility aliases.
 * Must be imported at the top of every entry point (server, cli, migrate).
 *
 * Rules:
 * - MUST NOT throw if .env is missing.
 * - MUST NOT log secret values (only presence booleans in diagnostics).
 * - Canonical names win; aliases fill only when canonical is missing.
 *
 * Alias map (operator-friendly):
 *   WP_USERNAME          → WP_API_USER          (alias → canonical)
 *   WP_APP_PASSWORD      → WP_APPLICATION_PASSWORD
 *   DATABASE_URL         → DB_PATH
 *   WP_BASE_URL         <→ SITE_BASE_URL        (bidirectional)
 */

import path from 'path';

// ── Step 1: Auto-load .env (safe) ────────────────────────────────

let dotenvLoaded = false;
try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dotenv = require('dotenv');
    const envPath = path.resolve(__dirname, '..', '.env');
    const result = dotenv.config({ path: envPath });
    dotenvLoaded = !result.error;
} catch {
    // dotenv not installed or .env missing — both safe to ignore
}

// ── Step 2: Apply aliases (canonical wins) ───────────────────────

interface AliasMapping {
    alias: string;
    canonical: string;
}

const ALIAS_MAPPINGS: AliasMapping[] = [
    { alias: 'WP_USERNAME', canonical: 'WP_API_USER' },
    { alias: 'WP_APP_PASSWORD', canonical: 'WP_APPLICATION_PASSWORD' },
    { alias: 'DATABASE_URL', canonical: 'DB_PATH' },
];

// Bidirectional: WP_BASE_URL <-> SITE_BASE_URL
// Code uses both; WP_BASE_URL feeds wpBaseUrl, SITE_BASE_URL feeds siteBaseUrl
const BIDIRECTIONAL_MAPPINGS: Array<[string, string]> = [
    ['WP_BASE_URL', 'SITE_BASE_URL'],
];

function applyAliases(): void {
    // One-directional: alias → canonical (canonical wins)
    for (const { alias, canonical } of ALIAS_MAPPINGS) {
        if (!process.env[canonical] && process.env[alias]) {
            process.env[canonical] = process.env[alias];
        }
    }

    // Bidirectional: fill whichever is missing from the other
    for (const [a, b] of BIDIRECTIONAL_MAPPINGS) {
        if (!process.env[a] && process.env[b]) {
            process.env[a] = process.env[b];
        } else if (!process.env[b] && process.env[a]) {
            process.env[b] = process.env[a];
        }
    }
}

applyAliases();

// ── Step 3: Config preflight (presence booleans only) ────────────

export function printConfigPreflight(): void {
    const keys = [
        'APP_ENV',
        'SITE_BASE_URL',
        'WP_BASE_URL',
        'WP_API_USER',
        'WP_APPLICATION_PASSWORD',
        'AI_API_KEY',
        'OPENAI_API_KEY',
        'GEMINI_API_KEY',
        'DB_PATH',
        'SERVICE_PORT',
        'LOG_LEVEL',
        // Multi-model LLM keys
        'LLM_RESEARCH_PROVIDER',
        'LLM_RESEARCH_MODEL',
        'LLM_DRAFT_PROVIDER',
        'LLM_DRAFT_MODEL',
        'LLM_FINAL_PROVIDER',
        'LLM_FINAL_MODEL',
        'LLM_IMAGE_PROVIDER',
        'LLM_IMAGE_MODEL',
        'LLM_RESEARCH_GROUNDING',
        'LLM_IMAGE_REQUIRED',
        'GEMINI_API_MODE',
        // Cron keys
        'CRON_ENABLED',
        'CRON_SCHEDULE',
        'CRON_TIMEZONE',
    ];

    console.log('=== Config Preflight ===');
    console.log(`dotenv loaded: ${dotenvLoaded}`);
    for (const key of keys) {
        const present = !!process.env[key];
        console.log(`  ${key}: ${present ? 'SET' : 'NOT SET'}`);
    }
    console.log('========================');
}

/**
 * Returns whether dotenv was successfully loaded.
 * Useful for tests and diagnostics.
 */
export function isDotenvLoaded(): boolean {
    return dotenvLoaded;
}

/**
 * Programmatic access to alias resolution.
 * For testing: call after manually setting process.env values.
 */
export { applyAliases };
