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

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/max-rogue/wp-content-autopilot.git
cd wp-content-autopilot

# 2. Install dependencies
npm install

# 3. Configure — copy and edit these files:
cp .env.example .env              # → Add your API keys + WordPress URL
cp prompts/template_prompts.md prompts/my_prompts.md  # → Customize for your niche

# 4. Edit taxonomy config for your niche (categories, tags, clusters)
#    src/config/taxonomy_config.yaml

# 5. Add your keywords
#    data/keyword.csv

# 6. Start the pipeline
npm run dev
```

> [!TIP]
> See [Adapting for Your Niche](#adapting-for-your-niche) below for detailed setup of each config file.

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

The pipeline is **niche-agnostic**. After cloning, follow these 4 steps to configure for your niche:

### Step 1 — `.env` (API Keys & WordPress)

Set your WordPress URL, credentials, and AI API keys. See [.env.example](.env.example).

### Step 2 — `src/config/taxonomy_config.yaml` (Categories & Tags)

This is the **most important config file**. Define your:
- **Categories** — WordPress categories for your niche
- **Cluster → Category mapping** — how keyword clusters map to categories
- **Tag whitelist** — which tags the pipeline is allowed to create
- **News keywords** — filter RSS feeds for your niche (if using news)

📖 **Full guide**: [docs/TAXONOMY_SETUP_GUIDE.md](docs/TAXONOMY_SETUP_GUIDE.md) — includes complete Golf and Tech niche examples.

### Step 3 — `prompts/my_prompts.md` (AI Writing Style)

Copy `prompts/template_prompts.md` and customize the writing voice, language, and citation requirements for your niche. See [docs/PROMPT_GUIDE.md](docs/PROMPT_GUIDE.md).

### Step 4 — `data/keyword.csv` (Your Keywords)

Add your target keywords with clusters, content types, and class hints. See [docs/KEYWORD_SETUP_GUIDE.md](docs/KEYWORD_SETUP_GUIDE.md).

### Example Niches

| Niche | Categories | News Keywords | Image Style |
|-------|-----------|---------------|-------------|
| **Golf** | Học Golf, Gậy Golf, Sân Golf | golf, pga, masters | golf course photography |
| **Tech Reviews** | Reviews, Guides, Comparisons | smartphone, laptop, GPU | minimalist product photography |
| **Real Estate** | For Sale, Rentals, Market Analysis | real estate, housing, mortgage | architectural photography |
| **Travel** | Destinations, Hotels, Food | travel, tourism, airline | cinematic landscape photography |
| **Health** | Nutrition, Fitness, Wellness | health, nutrition, FDA | clean wellness photography |

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
