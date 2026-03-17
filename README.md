# WP Content Autopilot

AI-powered WordPress content automation pipeline. From keyword to published, SEO-optimized article — fully automated.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What It Does

```
keyword.csv → AI Research → AI Draft → AI Edit → Image → QA Gates → WordPress Publish
```

You provide keywords. The pipeline:
1. **Researches** each keyword using AI with web grounding
2. **Writes** a full SEO article (1,200–2,000 words)
3. **Edits** for grammar, flow, and SEO optimization
4. **Generates** a featured image prompt
5. **Runs QA gates** (dedup, SEO score, template compliance)
6. **Publishes** to WordPress via REST API + Rank Math SEO meta

## Quick Start

### Prerequisites
- **Node.js 20+** ([download](https://nodejs.org))
- **WordPress site** with [Application Passwords](https://wordpress.org/documentation/article/application-passwords/) enabled
- **AI API key** — [Google Gemini](https://aistudio.google.com/apikey) (recommended) or OpenAI

### Setup (3 commands)

```bash
# 1. Initialize project
npx wp-content-autopilot init

# 2. Configure (edit these files)
#    .env          → API keys + WordPress URL
#    prompts/      → Customize for your niche
#    data/keyword.csv → Your target keywords

# 3. Start the pipeline
npx wp-content-autopilot start
```

### Or install globally

```bash
npm install -g wp-content-autopilot
wcap init
wcap start
```

## Configuration

### `.env` — API Keys & WordPress

```ini
# WordPress (required)
WP_BASE_URL=https://your-site.com
WP_API_USER=automation_user
WP_APPLICATION_PASSWORD=xxxx-xxxx-xxxx-xxxx

# AI Provider — set at least one
GEMINI_API_KEY=your-key-here
# OPENAI_API_KEY=your-key-here

# Publishing mode
PUBLISH_POSTURE=always_draft   # 'always_draft' or 'auto_publish'

# Daily quota
DAILY_JOB_QUOTA=3              # Articles per day
```

See [.env.example](.env.example) for all options.

### `prompts/my_prompts.md` — Customize for Your Niche

This is the most important file. It controls how AI writes your content.

```markdown
## STAGE 2 — Research Agent
### System Prompt
You are a content researcher for [YOUR SITE], a website about [YOUR NICHE]...

## STAGE 3 — Writer Agent (Draft)
### System Prompt
You are a senior content writer for [YOUR SITE]. Write in [YOUR LANGUAGE]...
```

See [prompts/template_prompts.md](prompts/template_prompts.md) for the full template.

### `data/keyword.csv` — Your Keywords

The CSV ships with **headers only** — you add the rows. It supports 19 columns split into two groups:

**Pipeline columns** (used at runtime): `keyword` *(required)*, `content_type`, `blogpost_subtype`, `review_subtype`, `cluster`, `class_hint`, `local_modifier`, `canonical_category`, `row_order`

**Planning columns** (editorial calendar): `funnel_stage`, `priority`, `notes`, `phase`, `planned_month`, `planned_week`, `suggested_tags`, `cannibalization_group`, `local_data_required`, `pass_risk`

The `class_hint` controls AI research depth:

| Class | When to Use | Example |
|-------|------------|---------|
| **A** | Definitions, evergreen facts | "what is VO2 max" |
| **B** | Reviews, comparisons (default) | "best running shoes 2025" |
| **C** | Prices, addresses, local data | "gyms near me" |

```csv
row_order,keyword,content_type,blogpost_subtype,cluster,class_hint,funnel_stage
1,what is VO2 max,Glossary,,fitness,A,TOFU
2,best running shoes 2025,BlogPost,BuyingGuide,fitness,B,MOFU
3,gyms near me,BlogPost,Guide,fitness,C,BOFU
```

📖 **Full guide**: [docs/KEYWORD_SETUP_GUIDE.md](docs/KEYWORD_SETUP_GUIDE.md) — covers SEO research workflow, column reference, and validation checklist.

## Pipeline Stages

| Stage | What It Does |
|-------|-------------|
| **0** | Picks next keyword from queue |
| **1** | Deduplication + similarity check |
| **2** | AI Research with web grounding |
| **3** | AI Article Writing |
| **3.5** | AI Final Edit (polish pass) |
| **4** | AI Image Generation |
| **5** | Quality Gates (G1-G8: SEO, structure, template) |
| **6** | WordPress REST API publish + Rank Math meta |

## API Endpoints

Once running, the server exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/status` | GET | Pipeline status |
| `/queue/summary` | GET | Queue breakdown |
| `/run` | POST | Trigger manual run |
| `/ingest-news` | POST | Ingest RSS feeds |

## Automated Scheduling

Enable the cron scheduler in `.env`:

```ini
CRON_ENABLED=true
CRON_SCHEDULE=0 6 * * *    # Daily at 6 AM
CRON_TIMEZONE=UTC
```

## Docker (Optional)

For production/VPS deployment:

```bash
# From repo root
docker compose up -d
```

The root `Dockerfile` and `docker-compose.yml` are the canonical Docker configs.

## Adapting for Your Niche

The pipeline is **niche-agnostic**. To adapt:

| File | What to Change |
|------|---------------|
| `prompts/my_prompts.md` | Your writing style, tone, language |
| `data/keyword.csv` | Your target keywords |
| `.env` | Your WordPress URL + API keys |
| `taxonomy_config.yaml` | Your categories and tags (optional) |

### Example Niches

- **Real Estate** — prompts for property guides, market analysis
- **Travel** — prompts for destination guides, hotel reviews
- **Tech** — prompts for product comparisons, how-to guides
- **Health** — prompts for wellness articles, nutrition guides
- **E-commerce** — prompts for product descriptions, buying guides

## Development

```bash
# Install dependencies
npm install

# Run in dev mode
npm run dev

# Type check
npm run typecheck

# Run tests
npm test
```

## License

[MIT](LICENSE) — Use freely, modify, distribute. Just keep the copyright notice.
