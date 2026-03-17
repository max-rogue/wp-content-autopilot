# Taxonomy & Categories Setup Guide

> **Goal**: Configure your site's **categories, tags, and content taxonomy** so the pipeline publishes articles under the correct WordPress categories and applies the right tags.

---

## Overview

The pipeline uses `src/config/taxonomy_config.yaml` as the single source of truth for your site's taxonomy. When a new article is generated, the pipeline:

1. Assigns it a **category** based on the keyword's `cluster` → `cluster_to_category` mapping
2. Filters **tags** through the tag whitelist (only whitelisted tags are attached in WordPress)
3. Falls back to the **default category** when no mapping matches

> [!IMPORTANT]
> You **must** edit `taxonomy_config.yaml` to match your niche. The pipeline ships with a single `general` category as default — this is a placeholder.

---

## File Location

```
src/config/taxonomy_config.yaml
```

You can also override the path via environment variable:

```ini
TAXONOMY_CONFIG_PATH=/custom/path/to/taxonomy_config.yaml
```

---

## Configuration Reference

### Categories

Define your WordPress categories. Each needs a `slug` (URL-safe) and `name` (display name).

```yaml
categories:
  - slug: guides
    name: Guides
  - slug: reviews
    name: Reviews
  - slug: news
    name: News
  - slug: glossary
    name: Glossary
```

> [!TIP]
> Slugs must be lowercase with hyphens. These are synced to WordPress when you run `npx wcap sync-taxonomies`.

---

### Cluster → Category Mapping

Maps the `cluster` column from `keyword.csv` to one of your category slugs:

```yaml
cluster_to_category:
  buying-guides: reviews
  product-comparisons: reviews
  how-to: guides
  industry-news: news
  definitions: glossary
```

**How it works**: When the pipeline processes a keyword with `cluster: buying-guides`, it assigns the article to the `reviews` category.

---

### Default Fallback Category

When a keyword's cluster doesn't match any mapping:

```yaml
default_fallback_category: guides
```

Must be one of the slugs defined in `categories`.

---

### Tag Whitelist

Tags organized by group. Only whitelisted tags are auto-created and attached in WordPress:

```yaml
tag_whitelist:
  brand:
    - brand-a
    - brand-b
  category:
    - guides
    - reviews
    - comparisons
  topic:
    - beginner
    - advanced
    - tips
```

The AI may suggest any tag, but Stage 5 (QA Gates) filters out tags not on this list. Filtered tags are logged in `dropped_tags` for review.

---

### News Configuration

If you use RSS news ingestion (`POST /ingest-news`):

```yaml
# Cluster name for ingested news articles
news_default_cluster: news

# Keywords to filter relevant news from feeds
# Empty = accept all articles (no filter)
news_relevance_keywords:
  - your-niche-keyword
  - another-keyword
```

---

### Image Style

Controls the style hint in AI-generated image prompts:

```yaml
image_style_hint: vibrant professional photography
```

Examples by niche:
- **Food blog**: `warm food photography with natural lighting`
- **Tech site**: `modern minimalist tech illustration`
- **Real estate**: `professional architectural photography`
- **Travel**: `cinematic landscape photography`

---

### Tag Limits & Policies

```yaml
max_tags_per_post: 8           # Max tags attached per article
tag_archive_policy:
  default: noindex_follow       # Default robots directive for tag archives
  graduated: []                 # Tag slugs promoted to index_follow
approved_additions: []          # Tags approved for creation even if not in whitelist
```

---

## Full Example: Golf Niche

Here's what a complete configuration looks like for a golf content site:

```yaml
version: "2.3"

categories:
  - slug: hoc-golf
    name: Học Golf
  - slug: gay-golf
    name: Gậy Golf
  - slug: san-golf
    name: Sân Golf
  - slug: golf-cong-nghe
    name: Golf Công Nghệ
  - slug: tin-tuc
    name: Tin Tức

cluster_to_category:
  golf basics: hoc-golf
  swing mechanics: hoc-golf
  golf clubs: gay-golf
  shaft & specs: gay-golf
  golf courses: san-golf
  golf technology: golf-cong-nghe
  news: tin-tuc

default_fallback_category: hoc-golf

tag_whitelist:
  brand:
    - titleist
    - callaway
    - taylormade
    - ping
  category:
    - guides
    - reviews
    - comparisons
  topic:
    - beginner
    - advanced
    - equipment

tag_archive_policy:
  default: noindex_follow
  graduated: [titleist, callaway]

max_tags_per_post: 8

news_default_cluster: news
image_style_hint: vibrant golf course photography with lush green tones
news_relevance_keywords:
  - golf
  - golfer
  - pga
  - lpga
  - masters
  - ryder cup
```

---

## Full Example: Tech Review Niche

```yaml
version: "2.3"

categories:
  - slug: reviews
    name: Reviews
  - slug: guides
    name: Guides
  - slug: versus
    name: Comparisons
  - slug: news
    name: Tech News
  - slug: deals
    name: Deals & Prices

cluster_to_category:
  smartphones: reviews
  laptops: reviews
  buying guides: guides
  how to: guides
  product comparisons: versus
  industry news: news
  pricing: deals

default_fallback_category: reviews

tag_whitelist:
  brand:
    - apple
    - samsung
    - google
    - sony
    - asus
  category:
    - reviews
    - buying-guide
    - comparison
    - benchmark
  topic:
    - budget
    - flagship
    - gaming

news_default_cluster: industry news
image_style_hint: clean minimalist product photography on white background
news_relevance_keywords:
  - smartphone
  - laptop
  - tablet
  - processor
  - GPU
```

---

## Sync to WordPress

After editing `taxonomy_config.yaml`, sync categories and tags to your WordPress site:

```bash
npx wcap sync-taxonomies
```

This will:
1. Create missing categories in WordPress
2. Create approved tags
3. Apply Rank Math robots directives to tag archives

---

## Validation

The pipeline validates your config on startup. Common errors:

| Error | Cause | Fix |
|-------|-------|-----|
| `taxonomy_config_missing` | File not found | Check path or set `TAXONOMY_CONFIG_PATH` |
| `taxonomy_config_invalid` | Missing `version` or `tag_whitelist` | Ensure both fields exist |
| Category HOLD at Stage 6 | Article category not in `categories` list | Add the category slug to `categories` |

> [!TIP]
> Run `npx wcap sync-taxonomies` after any config change to verify everything resolves correctly.
