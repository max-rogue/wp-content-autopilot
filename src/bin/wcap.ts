#!/usr/bin/env node
/**
 * wcap CLI — WP Content Autopilot command-line interface.
 *
 * Commands:
 *   init   — Scaffold a new project directory with template files
 *   start  — Start the pipeline server + cron scheduler
 *   run    — Manually trigger a single pipeline run
 *   status — Show pipeline queue status
 */

import fs from 'fs';
import path from 'path';

const COMMANDS = ['init', 'start', 'run', 'status', 'help'] as const;
type Command = typeof COMMANDS[number];

const VERSION = '1.0.0';

// ─── Init scaffolding ───────────────────────────────────────────

const ENV_TEMPLATE = `# WP Content Autopilot — .env
# Fill in your API keys and WordPress credentials

# WordPress
WP_BASE_URL=https://your-site.com
WP_API_USER=automation_user
WP_APPLICATION_PASSWORD=xxxx-xxxx-xxxx-xxxx

# AI Provider (set at least one)
GEMINI_API_KEY=your-gemini-api-key-here
# OPENAI_API_KEY=your-openai-key-here

# Pipeline
LLM_RESEARCH_PROVIDER=gemini
LLM_RESEARCH_MODEL=gemini-2.0-flash
LLM_RESEARCH_GROUNDING=google_search
LLM_DRAFT_PROVIDER=gemini
LLM_DRAFT_MODEL=gemini-2.0-flash
LLM_FINAL_PROVIDER=gemini
LLM_FINAL_MODEL=gemini-2.0-flash
LLM_IMAGE_PROVIDER=gemini
LLM_IMAGE_MODEL=gemini-2.0-flash-preview-image-generation

# Server
SERVICE_PORT=3100
LOG_LEVEL=info
DAILY_JOB_QUOTA=1
PUBLISH_POSTURE=always_draft

# Prompts (default: ./prompts/my_prompts.md)
PROMPTS_FILE_PATH=./prompts/my_prompts.md

# Database
DB_PATH=./data/pipeline.db
KEYWORD_CSV_PATH=./data/keyword.csv

# Scheduler (disabled by default)
CRON_ENABLED=false
CRON_SCHEDULE=0 6 * * *
CRON_TIMEZONE=UTC
`;

const KEYWORD_CSV_TEMPLATE = `keyword,cluster,content_type,class_hint,blogpost_subtype,local_modifier
your first keyword,your-cluster,BlogPost,B,Guide,
your second keyword,your-cluster,BlogPost,A,HowTo,
`;

const GITIGNORE_TEMPLATE = `node_modules/
dist/
.env
.env.*
!.env.example
data/*.db
data/*.db-journal
*.log
.DS_Store
*.tgz
coverage/
.vscode/
`;

function runInit(targetDir: string): void {
    console.log(`\n🚀 WP Content Autopilot — Project Setup\n`);
    console.log(`   Directory: ${targetDir}\n`);

    const dirs = ['prompts', 'data'];
    for (const dir of dirs) {
        const fullPath = path.join(targetDir, dir);
        if (!fs.existsSync(fullPath)) {
            fs.mkdirSync(fullPath, { recursive: true });
            console.log(`   ✅ Created ${dir}/`);
        }
    }

    // Write .env
    const envPath = path.join(targetDir, '.env');
    if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, ENV_TEMPLATE, 'utf-8');
        console.log(`   ✅ Created .env (edit your API keys + WP credentials)`);
    } else {
        console.log(`   ⏭️  .env already exists — skipping`);
    }

    // Copy prompt template
    const promptPath = path.join(targetDir, 'prompts', 'my_prompts.md');
    if (!fs.existsSync(promptPath)) {
        // Try to copy from package, fall back to simple template
        const packageTemplate = path.join(__dirname, '..', 'prompts', 'template_prompts.md');
        if (fs.existsSync(packageTemplate)) {
            fs.copyFileSync(packageTemplate, promptPath);
        } else {
            fs.writeFileSync(promptPath, '# Your prompts here\n# See docs/PROMPT_GUIDE.md for format\n', 'utf-8');
        }
        console.log(`   ✅ Created prompts/my_prompts.md (customize for your niche)`);
    } else {
        console.log(`   ⏭️  prompts/my_prompts.md already exists — skipping`);
    }

    // Write keyword CSV
    const csvPath = path.join(targetDir, 'data', 'keyword.csv');
    if (!fs.existsSync(csvPath)) {
        fs.writeFileSync(csvPath, KEYWORD_CSV_TEMPLATE, 'utf-8');
        console.log(`   ✅ Created data/keyword.csv (add your keywords)`);
    } else {
        console.log(`   ⏭️  data/keyword.csv already exists — skipping`);
    }

    // Write .gitignore
    const gitignorePath = path.join(targetDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, GITIGNORE_TEMPLATE, 'utf-8');
        console.log(`   ✅ Created .gitignore`);
    }

    console.log(`\n📋 Next steps:`);
    console.log(`   1. Edit .env — fill in your WordPress URL + API keys`);
    console.log(`   2. Edit prompts/my_prompts.md — customize for your niche`);
    console.log(`   3. Edit data/keyword.csv — add your target keywords`);
    console.log(`   4. Run: npx wp-content-autopilot start`);
    console.log();
}

// ─── CLI Entry ──────────────────────────────────────────────────

function printHelp(): void {
    console.log(`
WP Content Autopilot v${VERSION}
AI-powered WordPress content automation pipeline

USAGE:
  wcap <command> [options]

COMMANDS:
  init     Scaffold a new project with template files
  start    Start the pipeline server + cron scheduler
  run      Manually trigger a single pipeline run
  status   Show current queue status
  help     Show this help message

EXAMPLES:
  wcap init                  # Create project files in current directory
  wcap start                 # Start server on port 3100
  wcap run                   # Run pipeline for one keyword
  wcap status                # Check queue summary
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = (args[0] || 'help') as Command;

    switch (command) {
        case 'init':
            runInit(process.cwd());
            break;

        case 'start': {
            // Load env vars, then import and start the server.
            // server.ts self-starts via require.main === module when loaded directly,
            // but when imported as a module it only exports createApp().
            // So we set up dotenv then require the server module directly.
            require('dotenv').config();
            console.log('Starting WP Content Autopilot server...');
            // Dynamic require triggers the server.ts `require.main === module` block
            // when this CLI is the entry point. For safety, we also construct the app
            // and start it explicitly.
            const { loadConfig } = await import('../config');
            const { startScheduler } = await import('../scheduler');
            const { createApp } = await import('../server');

            const config = loadConfig();
            const app = createApp();
            const port = config.servicePort || 3100;
            app.listen(port, () => {
                console.log(`✅ Server running on http://localhost:${port}`);
                console.log(`   Health: http://localhost:${port}/health`);
                console.log(`   Status: http://localhost:${port}/status`);
                console.log(`   Queue:  http://localhost:${port}/queue/summary`);
                startScheduler(config);
            });
            break;
        }

        case 'run': {
            require('dotenv').config();
            const { loadConfig } = await import('../config');
            const config = loadConfig();
            const port = config.servicePort || 3100;
            try {
                const resp = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST' });
                const data = await resp.json();
                console.log('Pipeline run result:', JSON.stringify(data, null, 2));
            } catch (err) {
                console.error(`❌ Cannot connect to server at port ${port}. Is the server running?`);
                console.error('   Start with: wcap start');
                process.exit(1);
            }
            break;
        }

        case 'status': {
            require('dotenv').config();
            const { loadConfig } = await import('../config');
            const config = loadConfig();
            const port = config.servicePort || 3100;
            try {
                const resp = await fetch(`http://127.0.0.1:${port}/queue/summary`);
                const data = await resp.json();
                console.log('Queue status:', JSON.stringify(data, null, 2));
            } catch (err) {
                console.error(`❌ Cannot connect to server at port ${port}. Is the server running?`);
                console.error('   Start with: wcap start');
                process.exit(1);
            }
            break;
        }

        case 'help':
        default:
            printHelp();
            break;
    }
}

main().catch((err) => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
