/**
 * CLI entry point for the WP Content Autopilot pipeline.
 * Commands: run, status, queue-summary, sync-taxonomies, ingest-keywords
 *
 * Usage:
 *   npx ts-node src/cli.ts run
 *   npx ts-node src/cli.ts status
 *   npx ts-node src/cli.ts queue-summary
 *   npx ts-node src/cli.ts sync-taxonomies
 */

// Bootstrap: auto-load .env + resolve env var aliases (must be first import)
import './env-bootstrap';

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { getDb, runMigrations } from './db/migrate';
import { PublishQueueRepo, SettingsRepo } from './db/repositories';
import { runPipeline } from './runner';
import { SCHEMA_VERSION } from './types';
import { WpClient } from './services/wp-client';
import { parseKeywordCsv, executeTaxonomySync } from './services/taxonomy-sync';
import { generateDroppedTagReport } from './services/dropped-tag-report';
import { generateWeeklyOpsReport } from './services/weekly-ops-report';
import { ingestKeywords } from './services/csv-ingest';
import {
    loadTaxonomyConfig,
    _resetTaxonomyConfigCache,
} from './config/taxonomy-config-loader';
import {
    CANONICAL_CATEGORIES,
    TAG_WHITELIST,
    CLUSTER_TO_CATEGORY,
    DEFAULT_FALLBACK_CATEGORY,
} from './services/taxonomy';

async function main(): Promise<void> {
    const command = process.argv[2];

    if (!command) {
        console.log('Usage: cli <command>');
        console.log('Commands:');
        console.log('  run                 Run pipeline');
        console.log('  status              Show pipeline status');
        console.log('  queue-summary       Show queue counts by status');
        console.log('  sync-taxonomies     Sync WP categories/tags per ContentSpec §2');
        console.log('  dropped-tag-report  Generate weekly dropped-tag report');
        console.log('  weekly-ops-report   Generate weekly ops report (§6.6)');
        console.log('  ingest-keywords     Ingest keyword.csv into queue (status=planned)');
        console.log('    --limit N         Ingest only first N rows');
        console.log('    --dry-run         Preview without DB writes');
        process.exit(1);
    }

    const config = loadConfig();

    switch (command) {
        case 'run': {
            console.log('Starting pipeline run...');
            const result = await runPipeline();
            console.log(JSON.stringify(result, null, 2));
            break;
        }

        case 'status': {
            const db = getDb(config.dbPath);
            runMigrations(db);
            const settingsRepo = new SettingsRepo(db);
            const settings = settingsRepo.get();
            db.close();

            console.log(
                JSON.stringify(
                    {
                        schema_version: SCHEMA_VERSION,
                        throttle_state: settings.throttle_state,
                        ramp_state: settings.ramp_state,
                        daily_quota: settings.daily_quota,
                        last_run_at: settings.last_run_at,
                    },
                    null,
                    2
                )
            );
            break;
        }

        case 'queue-summary': {
            const db = getDb(config.dbPath);
            runMigrations(db);
            const queueRepo = new PublishQueueRepo(db);
            const counts = queueRepo.countByStatus();
            db.close();

            console.log(
                JSON.stringify(
                    {
                        schema_version: SCHEMA_VERSION,
                        ...counts,
                    },
                    null,
                    2
                )
            );
            break;
        }

        case 'sync-taxonomies': {
            await runSyncTaxonomies(config);
            break;
        }

        case 'dropped-tag-report': {
            await runDroppedTagReport(config);
            break;
        }

        case 'weekly-ops-report': {
            runWeeklyOpsReport(config);
            break;
        }

        case 'ingest-keywords': {
            runIngestKeywords(config);
            break;
        }

        default:
            console.error(`Unknown command: ${command}`);
            process.exit(1);
    }
}

/**
 * sync-taxonomies command implementation.
 * Ref: 01_ContentSpec §2 (taxonomy spec) — SOURCE OF TRUTH.
 *
 * Required env vars:
 *   WP_BASE_URL, WP_API_USER, WP_APPLICATION_PASSWORD
 *   KEYWORD_CSV_PATH (optional, defaults to ./data/keyword.csv)
 */
async function runSyncTaxonomies(config: ReturnType<typeof loadConfig>): Promise<void> {
    console.log('═══════════════════════════════════════════════');
    console.log('  Taxonomy Sync (canonical categories + tag whitelist)');
    console.log('═══════════════════════════════════════════════');
    console.log();

    // Validate required config
    if (!config.wpBaseUrl || !config.wpApiUser || !config.wpApplicationPassword) {
        console.error('ERROR: Missing required env vars: WP_BASE_URL, WP_API_USER, WP_APPLICATION_PASSWORD');
        process.exit(1);
    }

    // Print plan: categories
    console.log('▶ CANONICAL CATEGORIES (10):');
    for (const cat of CANONICAL_CATEGORIES) {
        console.log(`  • ${cat.slug}  →  "${cat.name}"`);
    }
    console.log();

    // Print plan: tags
    console.log(`▶ WHITELISTED TAGS (${TAG_WHITELIST.size}):`);
    console.log(`  Slugs: ${[...TAG_WHITELIST].join(', ')}`);
    console.log();

    // Load keyword.csv
    const csvPath = path.resolve(config.keywordCsvPath);
    let csvRows: ReturnType<typeof parseKeywordCsv> = [];
    if (fs.existsSync(csvPath)) {
        const csvContent = fs.readFileSync(csvPath, 'utf-8');
        csvRows = parseKeywordCsv(csvContent);
        console.log(`▶ KEYWORD CSV: loaded ${csvRows.length} rows from ${csvPath}`);
    } else {
        console.log(`▶ KEYWORD CSV: not found at ${csvPath}, skipping gated tag evaluation`);
    }
    console.log();

    // Print cluster → category mapping
    console.log('▶ CLUSTER → CATEGORY MAPPING:');
    const uniqueEntries = Object.entries(CLUSTER_TO_CATEGORY);
    for (const [cluster, cat] of uniqueEntries) {
        console.log(`  "${cluster}" → ${cat}`);
    }
    console.log(`  [unmapped] → ${DEFAULT_FALLBACK_CATEGORY} (fallback)`);
    console.log();

    // City tags — always skipped
    console.log('▶ CITY TAGS: SKIPPED (no verified local-value system in repo)');
    console.log();

    // Execute sync — pass approved additions and Rank Math robots key
    console.log('═══════════════════════════════════════════════');
    console.log('  Executing sync...');
    console.log('═══════════════════════════════════════════════');
    console.log();

    // Load taxonomy config for approved additions
    _resetTaxonomyConfigCache();
    const taxConfig = loadTaxonomyConfig();
    const rankMathRobotsKey = config.rankmath.keyRobots || '';

    const wpClient = new WpClient(config);
    const { plan, result } = await executeTaxonomySync(
        wpClient,
        csvRows,
        [],
        taxConfig.approvedAdditions,
        rankMathRobotsKey
    );

    // Print results
    console.log('═══════════════════════════════════════════════');
    console.log('  SYNC RESULTS');
    console.log('═══════════════════════════════════════════════');
    console.log();
    console.log(`  Categories created:  ${result.categoriesCreated}`);
    console.log(`  Categories existing: ${result.categoriesExisting}`);
    if (result.categoriesFailed.length > 0) {
        console.log(`  Categories failed:   ${result.categoriesFailed.length}`);
        for (const f of result.categoriesFailed) {
            console.log(`    ✗ ${f.slug}: ${f.error}`);
        }
    }
    console.log();
    console.log(`  Tags created:        ${result.tagsCreated}`);
    console.log(`  Tags existing:       ${result.tagsExisting}`);
    if (result.tagsFailed.length > 0) {
        console.log(`  Tags failed:         ${result.tagsFailed.length}`);
        for (const f of result.tagsFailed) {
            console.log(`    ✗ ${f.slug}: ${f.error}`);
        }
    }
    console.log();
    console.log(`  Gated tags created:  ${result.gatedTagsCreated}`);
    console.log(`  Gated tags skipped:  ${result.gatedTagsSkipped}`);
    console.log(`  City tags skipped:   ${result.cityTagsSkipped}`);
    console.log();

    // Gated tag details
    if (plan.gatedTags.length > 0) {
        console.log('  Gated tag details:');
        for (const gt of plan.gatedTags) {
            console.log(`    ${gt.action === 'create' ? '✓' : '✗'} ${gt.slug} (${gt.count} articles) — ${gt.reason}`);
        }
        console.log();
    }

    // Approved addition details
    if (result.approvedCreated > 0 || result.approvedExisting > 0 || result.approvedFailed.length > 0) {
        console.log(`  Approved created:    ${result.approvedCreated}`);
        console.log(`  Approved existing:   ${result.approvedExisting}`);
        if (result.approvedFailed.length > 0) {
            console.log(`  Approved failed:     ${result.approvedFailed.length}`);
            for (const f of result.approvedFailed) {
                console.log(`    ✗ ${f.slug}: ${f.error}`);
            }
        }
        console.log();
        console.log(`  Robots updated:      ${result.robotsUpdateSucceeded}/${result.robotsUpdateAttempted}`);
        if (result.robotsUpdateFailed > 0) {
            console.log(`  Robots failed:       ${result.robotsUpdateFailed}`);
        }
        console.log();
    }

    console.log('Done.');
}

/**
 * dropped-tag-report command implementation.
 * Ref: 03_PublishingOps §6 — Weekly Dropped-Tag Review Process
 */
async function runDroppedTagReport(config: ReturnType<typeof loadConfig>): Promise<void> {
    console.log('═══════════════════════════════════════════════');
    console.log('  Weekly Dropped-Tag Report');
    console.log('═══════════════════════════════════════════════');
    console.log();

    const db = getDb(config.dbPath);
    runMigrations(db);

    try {
        const { report, artifactPath } = generateDroppedTagReport({ db });

        console.log(`Window: ${report.window_start.slice(0, 10)} → ${report.window_end.slice(0, 10)}`);
        console.log(`Queue rows scanned: ${report.total_queue_rows_scanned}`);
        console.log();

        console.log('▶ DROPPED TAGS (non-whitelisted LLM suggestions):');
        console.log(`  Unique: ${report.dropped_tags.total_unique}`);
        console.log(`  Total occurrences: ${report.dropped_tags.total_occurrences}`);
        if (report.dropped_tags.top.length > 0) {
            console.log('  Top:');
            for (const t of report.dropped_tags.top) {
                console.log(`    • ${t.slug} (${t.count})`);
            }
        }
        console.log();

        console.log('▶ WP TAG NOT FOUND (whitelisted but missing from WP):');
        console.log(`  Unique: ${report.wp_tag_not_found.total_unique}`);
        console.log(`  Total occurrences: ${report.wp_tag_not_found.total_occurrences}`);
        if (report.wp_tag_not_found.top.length > 0) {
            console.log('  Top:');
            for (const t of report.wp_tag_not_found.top) {
                console.log(`    • ${t.slug} (${t.count})`);
            }
        }
        console.log();

        console.log(`Artifact written to: ${artifactPath}`);
    } finally {
        db.close();
    }

    console.log('Done.');
}

/**
 * weekly-ops-report command implementation.
 * Ref: Deployment §6.6 — Weekly Operational Report
 */
function runWeeklyOpsReport(config: ReturnType<typeof loadConfig>): void {
    console.log('═══════════════════════════════════════════════');
    console.log('  Weekly Ops Report (§6.6)');
    console.log('═══════════════════════════════════════════════');
    console.log();

    const db = getDb(config.dbPath);
    runMigrations(db);

    try {
        const { report, artifactPath } = generateWeeklyOpsReport({ db });

        console.log(`Period: ${report.week_start} → ${report.week_end}`);
        console.log();

        console.log('▶ STATUS TOTALS:');
        for (const [status, count] of Object.entries(report.totals)) {
            console.log(`  ${status}: ${count}`);
        }
        console.log();

        console.log('▶ TAXONOMY:');
        console.log(`  Dropped tags: ${report.taxonomy.dropped_tags_total} occurrences, ${report.taxonomy.dropped_tags.length} unique`);
        if (report.taxonomy.dropped_tags.length > 0) {
            for (const t of report.taxonomy.dropped_tags.slice(0, 10)) {
                console.log(`    • ${t.slug} (${t.count})`);
            }
        }
        console.log(`  WP tag not found: ${report.taxonomy.wp_tag_not_found_total} occurrences, ${report.taxonomy.wp_tag_not_found.length} unique`);
        if (report.taxonomy.wp_tag_not_found.length > 0) {
            for (const t of report.taxonomy.wp_tag_not_found.slice(0, 10)) {
                console.log(`    • ${t.slug} (${t.count})`);
            }
        }
        console.log();

        console.log(`Artifact written to: ${artifactPath}`);
    } finally {
        db.close();
    }

    console.log('Done.');
}

/**
 * ingest-keywords command implementation.
 * Reads keyword.csv and inserts planned rows into publish_queue (idempotent).
 *
 * Options parsed from process.argv:
 *   --limit N    Ingest only first N rows
 *   --dry-run    Preview inserts/skips without DB writes
 */
function runIngestKeywords(config: ReturnType<typeof loadConfig>): void {
    const args = process.argv.slice(3);

    let limit: number | undefined;
    let dryRun = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--limit' && i + 1 < args.length) {
            limit = parseInt(args[i + 1], 10);
            if (isNaN(limit) || limit < 1) {
                console.error('ERROR: --limit must be a positive integer');
                process.exit(1);
            }
            i++; // skip next arg
        } else if (args[i] === '--dry-run') {
            dryRun = true;
        }
    }

    const db = getDb(config.dbPath);
    runMigrations(db);

    try {
        const result = ingestKeywords(db, {
            csvPath: config.keywordCsvPath,
            limit,
            dryRun,
        });

        console.log(JSON.stringify(result, null, 2));
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error('CLI error:', err);
    process.exit(1);
});
