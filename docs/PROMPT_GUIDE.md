# Prompt Writing Guide

This guide explains how to write effective prompts for your content pipeline.

## File Format

Your prompts file uses markdown with specific `##` and `###` headings that the pipeline parser recognizes. There are exactly **5 stage sections**, each with a **System Prompt** and **User Prompt** subsection.

```
## STAGE 2 — Research Agent      ← Parser reads this heading
### System Prompt                 ← Parser reads this heading
(your system prompt content)
### User Prompt                   ← Parser reads this heading
(your user prompt content)
```

> **Important**: Only 5 `##` headings are recognized by the parser. All other `##` and `###` headings inside your prompt content are treated as body text.

## Stage-by-Stage Guide

### Stage 2 — Research Agent

**Purpose**: Gather facts, sources, and outline for the article.

**Tips**:
- Tell the AI what niche your site is in
- Specify citation requirements by content class (A/B/C)
- Define the JSON output schema clearly

**Must include**: `outline_points`, `facts`, `definitions`, `unknowns`, `citations_required`, `citations_present`

---

### Stage 3 — Writer Agent (Draft)

**Purpose**: Write the full article from research.

**Tips**:
- Specify your writing language explicitly
- Define your brand voice and tone
- Include word count targets per section
- List all JSON field names (the LLM sometimes uses wrong names without explicit instruction)

**Key fields**: `title`, `content_markdown`, `excerpt`, `suggested_slug`, `meta_title`, `meta_description`, `faq`, `category`, `tags`

---

### Stage 3 — finalEdit

**Purpose**: Polish pass — grammar, flow, SEO.

**Tips**:
- Emphasize IMMUTABILITY — fields like `suggested_slug`, `category`, `tags` must not change
- Focus on readability improvements only
- Keep it short — this is a patch pass, not a rewrite

---

### Stage FINAL — HTML Composer

**Purpose**: Convert markdown to WordPress-safe HTML.

**Tips**:
- Specify allowed HTML tags
- Forbid `<script>`, `<style>`, `<iframe>` explicitly
- Request heading IDs for TOC anchors

---

### Stage 4 — Image Generation

**Purpose**: Create a featured image prompt.

**Tips**:
- Always forbid text/words/logos in the image
- Specify style preference (photorealistic vs illustrative)
- Keep the prompt descriptive but focused

## Variables Available

The pipeline automatically injects these variables into prompts:

| Variable | Available in | Description |
|----------|-------------|-------------|
| `${keyword}` | All stages | The target keyword |
| `${contentType}` | All stages | BlogPost, Glossary, etc. |
| `${contextPayload}` | Stage 2, 3 | Full JSON context |
| `${draft}` | Stage 3 finalEdit | The draft to polish |
| `${title}` | Stage 4 | The article title |
| `${focusKeyword}` | Stage FINAL | The focus SEO keyword |

## Example Prompts by Niche

### Fitness Blog (English)
```
You are a certified fitness content writer for FitLife.com.
Write in clear, motivational English. Include actionable tips.
Cite reputable sources: ACE, NASM, NSCA, peer-reviewed journals.
```

### Real Estate (Vietnamese)
```
Bạn là chuyên gia nội dung bất động sản cho BatDongSan.vn.
Viết bằng tiếng Việt, giọng chuyên nghiệp, dữ liệu chính xác.
Trích dẫn nguồn: Bộ Xây dựng, Savills Vietnam, CBRE.
```

### Tech Reviews (English)
```
You are a senior tech reviewer for TechInsider.io.
Write objective, data-driven reviews. Always include benchmark numbers.
Compare with at least 2 competing products.
```
