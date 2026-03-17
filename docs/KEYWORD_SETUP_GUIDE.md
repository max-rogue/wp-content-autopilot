# Keyword CSV Setup Guide

> **Goal**: Build a production-ready `data/keyword.csv` that feeds the WP Content Autopilot pipeline.
> This guide walks you through SEO technical research and completing the CSV structure.

---

## Quick Start

```bash
# 1. Open the CSV file
data/keyword.csv

# 2. The header row is already in place — add your keyword rows below it

# 3. Ingest into the pipeline
npm run start          # auto-ingest on boot
# — or trigger manually via POST /run
```

---

## CSV Column Reference

The table below describes every column. **Bold** columns are used by the pipeline engine at runtime;
the rest are for your content planning and editorial calendar.

### Pipeline Columns (used at runtime)

| Column | Required | Type | Description |
|--------|----------|------|-------------|
| **`keyword`** | ✅ Yes | string | The target keyword / topic. Must be non-empty. |
| **`content_type`** | Recommended | enum | `BlogPost` · `Glossary` · `Review` · `Landing`. Default: `BlogPost` |
| **`blogpost_subtype`** | Optional | enum | `HowTo` · `BuyingGuide` · `Comparison` · `Guide` · `ProblemSolution`. Refines BlogPost structure. |
| **`review_subtype`** | Optional | enum | `SingleReview` · `BestOf`. Only relevant when `content_type = Review`. |
| **`cluster`** | Recommended | string | Topic cluster name (e.g. `golf fitting`, `shaft & specs`). Used for internal linking and CTA selection. |
| **`class_hint`** | Recommended | `A` · `B` · `C` | Research depth class. Default: `B`. See [Class System](#class-system) below. |
| **`local_modifier`** | Optional | slug | City/region slug (e.g. `tp-hcm`, `ha-noi`). Triggers local SEO gates. |
| **`canonical_category`** | Optional | slug | WordPress category slug override (e.g. `gay-golf`, `hoc-golf`). |
| **`row_order`** | Optional | integer | Explicit processing order. If present, pipeline sorts by this before ingestion. |

### Planning Columns (editorial calendar)

| Column | Type | Description |
|--------|------|-------------|
| `funnel_stage` | `TOFU` · `MOFU` · `BOFU` | Marketing funnel position. Helps prioritize content sequence. |
| `priority` | `1` – `3` | Editorial priority within a phase. `1` = publish first. |
| `notes` | string | Free-text notes for editors (e.g. "beginner; easy win", "cite R&A/USGA"). |
| `phase` | integer | Content rollout phase number. |
| `planned_month` | integer | Target publication month. |
| `planned_week` | `W01` – `W52` | Target publication week. |
| `suggested_tags` | comma-list | Pre-planned WP tags (e.g. `"buying-guide,titleist,review"`). Quoted if contains commas. |
| `cannibalization_group` | string | Group ID to detect keyword cannibalization (e.g. `brand_titleist`, `học_golf`). |
| `local_data_required` | `YES` · `NO` | Whether the article requires verified local data (addresses, prices). |
| `pass_risk` | `LOW` · `MED` · `HIGH` | Risk level indicating how likely the QA gates are to block publication. |

---

## Class System

The `class_hint` controls how deep the AI research stage digs:

| Class | Label | Research Depth | Citation Requirement | Example Keywords |
|-------|-------|---------------|---------------------|-----------------|
| **A** | Definitional / Evergreen | Light (1–2 searches) | Optional | "golf là gì", "handicap golf là gì" |
| **B** | Review / Comparison | Medium (2–4 searches) | Required (min 2 sources) | "gậy driver Titleist có tốt không", "shaft graphite hay steel" |
| **C** | Price / Address / Specs | Deep (verify every claim) | Mandatory per claim | "sân golf TP HCM", "Long Thành Golf bảng giá" |

> [!IMPORTANT]
> Class **C** keywords with `local_modifier` require verified local data. The pipeline's G3 gate will force articles to DRAFT + noindex if local data cannot be verified.

---

## Step-by-Step: SEO Research Workflow

### Step 1 — Seed Keyword Discovery

Use these free/paid tools to build your initial keyword list:

| Tool | Best For | Free? |
|------|----------|-------|
| Google Search Console | Existing impressions & clicks | ✅ |
| Google Keyword Planner | Volume estimates | ✅ (with Ads account) |
| Ahrefs / SEMrush | Competitor gap analysis | 💰 |
| AnswerThePublic | Question-based keywords | ✅ (limited) |
| Google autocomplete | Long-tail discovery | ✅ |

**Action**: Export 50–200 seed keywords related to your niche.

### Step 2 — Classify & Cluster

For each keyword, determine:

1. **`content_type`**: Is this a definition (Glossary), a how-to (BlogPost/HowTo), a product review (Review), or a landing page (Landing)?
2. **`cluster`**: Group related keywords together (e.g., all shaft-related keywords → `shaft & specs`).
3. **`class_hint`**: Does this need light research (A), comparison data (B), or verified facts (C)?
4. **`funnel_stage`**: Is the reader just learning (TOFU), comparing options (MOFU), or ready to buy (BOFU)?

### Step 3 — Prioritize & Schedule

Assign each keyword:

- **`priority`** (1–3): Start with priority 1 keywords — these are your quick wins.
- **`phase`** (1–6): Group into rollout phases. Phase 1 = foundation content (definitions, guides).
- **`planned_week`**: Assign a target week (W01–W52) based on your publishing cadence.

**Recommended Phase Order**:

| Phase | Focus | Content Types | Class |
|-------|-------|--------------|-------|
| 1 | Foundation (definitions, beginner guides) | Glossary, BlogPost/Guide | A |
| 2 | Quick-win educational content | BlogPost/HowTo, BlogPost/BuyingGuide | A–B |
| 3 | Reviews, comparisons, brand content | Review, BlogPost/Comparison | B |
| 4 | Price/cost content, commercial intent | BlogPost/BuyingGuide, Landing | B–C |
| 5 | Local directories | BlogPost/Guide (with local_modifier) | C |
| 6 | High-conversion local landing pages | Landing (with local_modifier) | C |

### Step 4 — SEO Meta Planning

For each keyword, pre-plan:

- **`canonical_category`**: Map to an existing WordPress category slug.
- **`suggested_tags`**: List relevant WP tag slugs. Use quotes if the list contains commas: `"buying-guide,titleist,review"`.
- **`cannibalization_group`**: Assign the same group ID to keywords that might compete with each other in search results.

### Step 5 — Risk Assessment

Set `pass_risk` for each keyword:

- **LOW**: Standard content, no special data needed.
- **MED**: Needs specific facts/data that may be hard to verify.
- **HIGH**: Commercial intent, pricing, or local data required — higher chance of QA gate blocks.

---

## Example Rows

```csv
row_order,keyword,content_type,blogpost_subtype,review_subtype,cluster,funnel_stage,local_modifier,class_hint,priority,notes,phase,planned_month,planned_week,canonical_category,suggested_tags,cannibalization_group,local_data_required,pass_risk
1,what is golf fitting,Glossary,,,golf fitting,TOFU,,A,1,definition; internal anchor,1,1,W01,golf-fitting,"buying-guide,glossary",golf_fitting,NO,LOW
2,best golf drivers 2025,Review,,BestOf,golf clubs,MOFU,,B,2,ranking; update yearly,3,3,W10,golf-clubs,"buying-guide,review",golf_clubs,NO,LOW
3,golf courses near me,BlogPost,Guide,,golf courses,MOFU,new-york,C,1,local directory,5,5,W20,golf-courses,"buying-guide,review",golf_courses_ny,YES,MED
```

---

## Validation Checklist

Before running the pipeline, verify:

- [ ] `keyword` column is non-empty for every row
- [ ] `content_type` values match: `BlogPost`, `Glossary`, `Review`, or `Landing`
- [ ] `blogpost_subtype` values match: `HowTo`, `BuyingGuide`, `Comparison`, `Guide`, or `ProblemSolution`
- [ ] `class_hint` is `A`, `B`, or `C`
- [ ] Keywords with `local_modifier` have `local_data_required = YES`
- [ ] No duplicate keywords in the same `cannibalization_group`
- [ ] `row_order` values are unique integers (if used)
- [ ] Quoted fields use double-quotes for values containing commas

---

## Pipeline Behavior

When the pipeline ingests `keyword.csv`:

1. **Reads** all rows, sorted by `row_order` (if present)
2. **Computes** a deterministic idempotency key per row (`SHA-256(row_order|keyword)`)
3. **Skips** rows that already exist in the database (idempotent re-runs are safe)
4. **Inserts** new rows with `status = planned`
5. The scheduler then picks up planned rows and runs the content generation pipeline

> [!TIP]
> You can safely re-run ingestion after adding new rows to the CSV. Existing rows are automatically skipped.
