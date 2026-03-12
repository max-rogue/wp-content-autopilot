/**
 * Core types for the WP Content Autopilot pipeline.
 * All types trace to spec/code/13_CONTENT_OPS_PIPELINE.md.
 */

// ─── Status Enum (§6.2) ────────────────────────────────────────
export const QUEUE_STATUSES = [
  'planned',
  'researching',
  'drafting',
  'qa',
  'draft_wp',
  'published',
  'hold',
  'failed',
] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

// ─── Gate IDs (§6.3.8) ─────────────────────────────────────────
export const GATE_IDS = [
  'G1_KEYWORD_DEDUP',
  'G2_SIMILARITY',
  'G3_LOCAL_DOORWAY',
  'G4_FACT_CLASS',
  'G5_TEMPLATE',
  'G6_TONE',
  'G7_IMAGE',
  'G8_SEO_META',
] as const;

export type GateId = (typeof GATE_IDS)[number];

export type GateOutcome = 'PASS' | 'DRAFT' | 'HOLD';

export interface GateResult {
  gate_id: GateId;
  status: GateOutcome;
  reasons: string[];
}

// ─── Similarity Bands (§6.4) ────────────────────────────────────
export type SimilarityBand = 'PASS' | 'DRAFT' | 'HOLD';

export function similarityBand(score: number): SimilarityBand {
  if (score >= 0.80) return 'HOLD';
  if (score >= 0.70) return 'DRAFT';
  return 'PASS';
}

// ─── Content Types ──────────────────────────────────────────────
export type ContentType = 'BlogPost' | 'Glossary' | 'CategoryPage' | 'LandingSection';

// ─── Blogpost Subtype (locked enum from CSV) ────────────────────
export type BlogpostSubtype = 'HowTo' | 'BuyingGuide' | 'Comparison' | 'Guide';

export const BLOGPOST_SUBTYPES: readonly BlogpostSubtype[] = [
  'HowTo',
  'BuyingGuide',
  'Comparison',
  'Guide',
] as const;

// ─── Content Class (§6.3.6 Gate 4) ─────────────────────────────
export type ContentClass = 'A' | 'B' | 'C';

// ─── Sitemap Pair (T-10 internal links) ─────────────────────────
export interface SitemapPair {
  slug: string;
  title: string;
}

// ─── Publish Recommendation ─────────────────────────────────────
export type PublishRecommendation = 'PUBLISH' | 'DRAFT' | 'HOLD';

// ─── Publish Posture (runtime-configurable) ─────────────────────
export type PublishPosture = 'always_draft' | 'auto_publish';

// ─── Publish Posture Source (diagnostics) ───────────────────────
export type PublishPostureSource = 'env' | 'default' | 'invalid_fallback';

// ─── Robots Decision ────────────────────────────────────────────
export type RobotsDecision = 'index,follow' | 'noindex,follow';

// ─── Throttle State ─────────────────────────────────────────────
export type ThrottleState = 'active' | 'reduced' | 'paused';

// ─── Ramp State ─────────────────────────────────────────────────
export type RampState = 'ramp_1' | 'ramp_2' | 'ramp_3' | 'steady';

// ─── Entity Types (§6.2.3 local_db) ────────────────────────────
export type EntityType =
  | 'business'
  | 'service_center'
  | 'retail_store'
  | 'professional'
  | 'venue';

export type VerificationTier = 1 | 2;

// ─── Schema Version ─────────────────────────────────────────────
export const SCHEMA_VERSION = '1.0' as const;

// ─── publish_queue Row (§6.2.1) ─────────────────────────────────
export interface PublishQueueRow {
  id: string;
  picked_keyword: string;
  normalized_keyword: string;
  language: string;
  idempotency_key: string;
  cluster: string;
  content_type: ContentType;
  class_hint: ContentClass;
  blogpost_subtype: BlogpostSubtype | null;
  status: QueueStatus;
  scheduled_for: string | null;
  published_url: string | null;
  published_wp_id: number | null;
  fail_reasons: string | null; // JSON
  model_trace: string | null; // JSON
  similarity_score: number | null;
  similarity_band: SimilarityBand | null;
  robots_decision: RobotsDecision | null;
  gate_results: string | null; // JSON
  dropped_tags: string | null; // JSON — LLM tags that failed whitelist (§2.2)
  wp_tag_not_found: string | null; // JSON — whitelisted tags not in WP (§Stage 6)
  canonical_category: string | null; // CSV canonical_category slug (§2.1)
  news_source_url: string | null; // Source article URL for news-type items
  news_source_name: string | null; // Source feed/publication name
  created_at: string;
  updated_at: string;
}

// ─── content_index Row (§6.2.2) ─────────────────────────────────
export interface ContentIndexRow {
  wp_post_id: number;
  title: string;
  focus_keyword: string;
  slug: string;
  url: string;
  category: string;
  tags: string; // JSON array
  published_at: string;
  content_hash: string;
  embedding: string | null;
  updated_at: string;
  similarity_score: number | null;
  similarity_band: SimilarityBand | null;
  gate_results: string | null; // JSON
}

// ─── local_db Row (§6.2.3) ──────────────────────────────────────
export interface LocalDbRow {
  entity_id: string;
  entity_type: EntityType;
  name: string;
  city_province: string;
  address: string;
  verified_source_url: string;
  last_verified_at: string;
  verification_tier: VerificationTier;
}

// ─── settings Row (§6.2.4) ──────────────────────────────────────
export interface SettingsRow {
  daily_quota: number;
  ramp_state: RampState;
  throttle_state: ThrottleState;
  last_run_at: string | null;
}

// ─── Stage Output Contracts ─────────────────────────────────────

/** Stage 0 Output (§6.3.1) */
export interface Stage0Output {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  target_posts_count: number;
  quota_reason: string;
  selected_queue_ids: string[];
}

/** Stage 1 Output (§6.3.2) */
export interface Stage1Output {
  schema_version: typeof SCHEMA_VERSION;
  queue_id: string;
  picked_keyword: string;
  normalized_keyword: string;
  cluster: string;
  content_type: ContentType;
  class_hint: ContentClass;
  blogpost_subtype: BlogpostSubtype | null;
  angle: string;
  required_data_flags: string[];
  planner_notes: string[];
}

/** Stage 2 Output (§6.3.3) */
export interface Stage2Output {
  schema_version: typeof SCHEMA_VERSION;
  queue_id: string;
  outline_points: string[];
  facts: Array<{ claim: string; source_url: string }>;
  definitions: string[];
  unknowns: string[];
  citations_required: boolean;
  citations_present: boolean;
}

/** Stage 3 Output (§6.3.4) */
export interface Stage3Output {
  schema_version: typeof SCHEMA_VERSION;
  title: string;
  content_markdown: string;
  excerpt: string;
  suggested_slug: string;
  category: string;
  tags: string[];
  focus_keyword: string;
  additional_keywords: string[];
  meta_title: string;
  meta_description: string;
  faq: Array<{ question: string; answer: string }>;
  featured_image: { prompt: string; alt_text: string };
  citations: Array<{ claim: string; source_url: string }>;
  publish_recommendation: PublishRecommendation;
  reasons: string[];
  missing_data_fields: string[];
  /** T-10: sitemap slugs actually linked in content_markdown (post-stripping). */
  internal_links_used?: SitemapPair[];
}

/** Stage 3.5 Output — Final HTML Composer (non-blocking) */
export interface Stage3_5Output {
  schema_version: typeof SCHEMA_VERSION;
  html_artifact: {
    /** Rendered HTML from content_markdown. Empty string on fallback. */
    content_html: string;
    /** Extracted headings with ids for TOC / anchor links. */
    headings: Array<{ level: number; text: string; id: string }>;
    /** Whether heading ids were injected by the composer. */
    heading_ids_injected: boolean;
  };
  /** SHA-256 prefix (16 chars) of the source content_markdown. */
  source_markdown_hash: string;
  /** Warnings or notes from the composer (e.g. fallback reason). */
  qa_notes: string[];
}

/** A generated image asset with full metadata. */
export interface ImageAsset {
  /** The prompt used to generate this image. */
  prompt_used: string;
  /** Base64-encoded image bytes. */
  image_base64: string;
  /** MIME type (image/png, image/jpeg, image/webp). */
  mime: string;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Alt text for accessibility. */
  alt_text: string;
}

/** Stage 4 Output (§6.3.5) */
export interface Stage4Output {
  schema_version: typeof SCHEMA_VERSION;
  featured_image: { prompt: string; alt_text: string };
  inline_image: {
    prompt: string;
    alt_text: string;
    target_section_h2: string;
  } | null;
  media_mode: 'image_only';
  /** Backward-compat: single image result (mirrors images.featured). Null if skipped/failed. */
  image_result?: {
    image_base64: string;
    mime_type: string;
    alt_text: string;
    caption?: string;
  } | null;
  /** Dual image assets: featured (for WP featured_media) + hero (for in-content hero block). */
  images: {
    featured: ImageAsset | null;
    hero: ImageAsset | null;
  };
}

/** Stage 5 Output (§6.3.6) */
export interface Stage5Output {
  schema_version: typeof SCHEMA_VERSION;
  publish_recommendation: PublishRecommendation;
  slug_final: string;
  rankmath: {
    focus_keyword: string;
    meta_title: string;
    meta_description: string;
    canonical: string;
    robots: RobotsDecision;
    schema_type: string;
  };
  /** Taxonomy output per 03_PublishingOps Stage 5 */
  taxonomy: {
    category: string;
    tags: string[];        // whitelist-filtered, max 8, ASCII slugs
    dropped_tags: string[]; // LLM suggestions that failed whitelist
  };
  gate_results: Record<string, unknown>;
  reasons: string[];
}

/** Stage 6 Output (§6.3.7) */
export interface Stage6Output {
  schema_version: typeof SCHEMA_VERSION;
  queue_id: string;
  wp_post_id: number;
  published_url: string;
  final_status: 'published' | 'draft_wp' | 'hold' | 'failed';
  rankmath_write_result: 'ok' | 'failed';
  verification_result: 'pass' | 'fail';
  content_index_upsert: 'ok' | 'failed';
  /** Featured image upload result: ok, failed, or skipped (no image bytes). */
  featured_media_result?: 'ok' | 'failed' | 'skipped';
  /** WP media attachment ID if featured image was uploaded successfully. */
  wp_media_id?: number;
  /** Hero image upload result: ok, failed, or skipped (no hero image bytes). */
  hero_media_result?: 'ok' | 'failed' | 'skipped';
  /** WP media attachment ID if hero image was uploaded successfully. */
  wp_hero_media_id?: number;
  /** Whether hero image was injected into post content (inline). */
  hero_injected?: boolean;
  /** Whether TOC was injected into post content. */
  toc_injected?: boolean;
  /** Diagnostic: which content format was used for WP body ('html' or 'markdown'). */
  content_source?: 'html' | 'markdown';
  reasons: string[];
}

// ─── Audit Entry (§6.6) ─────────────────────────────────────────
export interface AuditEntry {
  id: string;
  queue_id: string;
  run_id: string;
  stage_name: string;
  input_snapshot_hash: string;
  output_snapshot_hash: string;
  gate_decisions: string | null; // JSON
  reasons: string | null; // JSON
  created_at: string;
}

// ─── API Response Wrappers ──────────────────────────────────────
export interface HealthResponse {
  status: 'ok' | 'error';
  time: string;
  version: string;
  startup_at?: string;
  uptime_seconds?: number;
}

export interface StatusResponse {
  schema_version: typeof SCHEMA_VERSION;
  throttle_state: ThrottleState;
  ramp_state: RampState;
  daily_quota: number;
  last_run_at: string | null;
}

export interface QueueSummaryResponse {
  schema_version: typeof SCHEMA_VERSION;
  planned: number;
  researching: number;
  drafting: number;
  qa: number;
  draft_wp: number;
  published: number;
  hold: number;
  failed: number;
}

export interface RunResponse {
  schema_version: typeof SCHEMA_VERSION;
  run_id: string;
  status: 'started' | 'rejected';
  reason?: string;
}
