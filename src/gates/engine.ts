/**
 * Gate Engine — runs G1–G8 in order, writes gate results.
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.6, §6.3.8
 *
 * Gate IDs (authoritative): G1_KEYWORD_DEDUP through G8_SEO_META.
 * Publish recommendation: HOLD > DRAFT > PUBLISH (but publish maps to draft_wp only).
 */

import type { GateResult, GateId, GateOutcome, PublishRecommendation } from '../types';
import type { Stage3Output, Stage4Output, ContentType, RobotsDecision } from '../types';
import { similarityBand } from '../types';
import type { ContentIndexRepo, LocalDbRepo, PublishQueueRepo } from '../db/repositories';
import { logger } from '../logger';

export interface GateContext {
  queueId: string;
  keyword: string;
  normalizedKeyword: string;
  contentType: ContentType;
  stage3: Stage3Output;
  stage4: Stage4Output;
  contentIndexRepo: ContentIndexRepo;
  localDbRepo: LocalDbRepo;
  queueRepo: PublishQueueRepo;
  localModifier?: string; // city/province for local doorway check
}

export interface GateEngineResult {
  results: GateResult[];
  recommendation: PublishRecommendation;
  robotsDecision: RobotsDecision;
  reasons: string[];
}

/**
 * Normalize keyword for dedup: lowercase, trim, remove double-spaces.
 * Also handles Vietnamese patterns per §6.3.2.
 */
export function normalizeKeyword(kw: string): string {
  return kw
    .toLowerCase()
    .trim()
    .replace(/\s{2,}/g, ' ')
    .replace(/\btại\b/g, 'ở') // "tại [City]" == "ở [City]"
    .replace(/\bchuẩn\b/g, 'đúng'); // "cách ... chuẩn" == "cách ... đúng"
}

/**
 * Compute simple content hash for similarity fallback when embeddings disabled.
 * Uses title + meta_description + excerpt + first 500 words.
 * Returns a similarity score between 0.0 and 1.0.
 */
function fallbackSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ─── Individual Gate Implementations ────────────────────────────

/** G1: Keyword Dedup (§6.3.2, §6.4) */
function runG1(ctx: GateContext): GateResult {
  const existing = ctx.contentIndexRepo.findByFocusKeyword(ctx.normalizedKeyword);

  if (existing) {
    return {
      gate_id: 'G1_KEYWORD_DEDUP',
      status: 'HOLD',
      reasons: [`Keyword "${ctx.normalizedKeyword}" already published as wp_post_id=${existing.wp_post_id}`],
    };
  }

  // Check cooldown: 14 days (§6.4)
  const recent = ctx.queueRepo.hasRecentPublish(ctx.normalizedKeyword, 14);
  if (recent) {
    return {
      gate_id: 'G1_KEYWORD_DEDUP',
      status: 'HOLD',
      reasons: [`Keyword "${ctx.normalizedKeyword}" published within 14-day cooldown`],
    };
  }

  return { gate_id: 'G1_KEYWORD_DEDUP', status: 'PASS', reasons: [] };
}

/** G2: Semantic Similarity (§6.3.6 Gate 2) */
function runG2(ctx: GateContext): GateResult {
  const recentPosts = ctx.contentIndexRepo.getRecentPublished(60);
  const fingerprint = [
    ctx.stage3.title,
    ctx.stage3.meta_description,
    ctx.stage3.excerpt,
    ctx.stage3.content_markdown.split(/\s+/).slice(0, 500).join(' '),
  ].join(' ');

  let maxScore = 0;

  for (const post of recentPosts) {
    const postFingerprint = [post.title, post.focus_keyword, post.slug].join(' ');
    const score = fallbackSimilarity(fingerprint, postFingerprint);
    if (score > maxScore) maxScore = score;
  }

  const band = similarityBand(maxScore);

  if (band === 'HOLD') {
    return {
      gate_id: 'G2_SIMILARITY',
      status: 'HOLD',
      reasons: [`Similarity score ${maxScore.toFixed(2)} >= 0.80 — duplicate`],
    };
  }
  if (band === 'DRAFT') {
    return {
      gate_id: 'G2_SIMILARITY',
      status: 'DRAFT',
      reasons: [`Similarity score ${maxScore.toFixed(2)} in 0.70–0.79 — rewrite needed`],
    };
  }

  return { gate_id: 'G2_SIMILARITY', status: 'PASS', reasons: [] };
}

/** G3: Local Doorway (§6.3.6 Gate 3) */
function runG3(ctx: GateContext): GateResult {
  if (!ctx.localModifier) {
    return { gate_id: 'G3_LOCAL_DOORWAY', status: 'PASS', reasons: ['No local modifier'] };
  }

  const verified = ctx.localDbRepo.findVerified(ctx.localModifier);
  if (verified.length > 0) {
    return { gate_id: 'G3_LOCAL_DOORWAY', status: 'PASS', reasons: ['Verified local entry found'] };
  }

  // Fail-closed behavior per content type
  if (ctx.contentType === 'LandingSection') {
    return {
      gate_id: 'G3_LOCAL_DOORWAY',
      status: 'HOLD',
      reasons: [`No verified local entry for "${ctx.localModifier}" — Landing pages require verification`],
    };
  }

  return {
    gate_id: 'G3_LOCAL_DOORWAY',
    status: 'DRAFT',
    reasons: [`No verified local entry for "${ctx.localModifier}" — DRAFT + noindex`],
  };
}

/** G4: Fact/Class C (§6.3.6 Gate 4) — strengthened citation/grounding completeness */
function runG4(ctx: GateContext): GateResult {
  // Determine content class from citations and content
  const hasClassCIndicators = /giá|địa chỉ|giờ|price|address|hour/i.test(
    ctx.stage3.content_markdown
  );

  if (hasClassCIndicators) {
    // Class C requires Tier 1/2 citations
    const hasCitations = ctx.stage3.citations.length > 0;
    if (!hasCitations) {
      return {
        gate_id: 'G4_FACT_CLASS',
        status: 'HOLD',
        reasons: ['Class C content (price/address/time) missing Tier 1/2 citations'],
      };
    }

    // Citation grounding evidence completeness: every citation must have source_url
    const incompleteCitations = ctx.stage3.citations.filter(
      (c) => !c.source_url || c.source_url.trim() === ''
    );
    if (incompleteCitations.length > 0) {
      return {
        gate_id: 'G4_FACT_CLASS',
        status: 'HOLD',
        reasons: [
          `${incompleteCitations.length} citation(s) missing source_url — grounding evidence incomplete`,
        ],
      };
    }
  }

  // General grounding: if citations are required and present, validate completeness
  if (ctx.stage3.citations && ctx.stage3.citations.length > 0) {
    const emptyClaimCitations = ctx.stage3.citations.filter(
      (c) => !c.claim || c.claim.trim() === ''
    );
    if (emptyClaimCitations.length > 0) {
      return {
        gate_id: 'G4_FACT_CLASS',
        status: 'DRAFT',
        reasons: [
          `${emptyClaimCitations.length} citation(s) with empty claim — grounding incomplete`,
        ],
      };
    }
  }

  return { gate_id: 'G4_FACT_CLASS', status: 'PASS', reasons: [] };
}

/** G5: Template Completeness (§6.3.6 Gate 5) — strengthened with banned pattern checks */
function runG5(ctx: GateContext): GateResult {
  const issues: string[] = [];

  if (!ctx.stage3.title) issues.push('Missing title');
  if (!ctx.stage3.content_markdown) issues.push('Missing content');
  if (!ctx.stage3.excerpt) issues.push('Missing excerpt');
  if (!ctx.stage3.faq || ctx.stage3.faq.length < 3) issues.push('FAQ requires >= 3 items');
  if (!ctx.stage3.category) issues.push('Missing category');

  // Pre-WP content QA: banned HTML patterns (no raw scripts/iframes/objects/embeds/forms)
  const htmlContent = ctx.stage3.content_markdown;
  if (/<script[\s>]/i.test(htmlContent)) issues.push('Banned HTML: <script> tag detected');
  if (/<iframe[\s>]/i.test(htmlContent)) issues.push('Banned HTML: <iframe> tag detected');
  if (/<object[\s>]/i.test(htmlContent)) issues.push('Banned HTML: <object> tag detected');
  if (/<embed[\s>]/i.test(htmlContent)) issues.push('Banned HTML: <embed> tag detected');
  if (/<form[\s>]/i.test(htmlContent)) issues.push('Banned HTML: <form> tag detected');
  if (/on\w+\s*=/i.test(htmlContent)) issues.push('Banned HTML: inline event handler detected');
  if (/javascript:/i.test(htmlContent)) issues.push('Banned pattern: javascript: URI detected');

  // Content length minimum (at least 300 words for meaningful content)
  const wordCount = htmlContent.split(/\s+/).filter(Boolean).length;
  if (wordCount < 300) issues.push(`Content too short: ${wordCount} words (min 300)`);

  // Internal link / metadata completeness
  if (!ctx.stage3.suggested_slug) issues.push('Missing suggested_slug');
  if (!ctx.stage3.focus_keyword) issues.push('Missing focus_keyword');

  if (issues.length > 0) {
    return { gate_id: 'G5_TEMPLATE', status: 'DRAFT', reasons: issues };
  }

  return { gate_id: 'G5_TEMPLATE', status: 'PASS', reasons: [] };
}

/** G6: Tone/Brand Voice (§6.3.6 Gate 6) */
function runG6(ctx: GateContext): GateResult {
  const content = ctx.stage3.content_markdown;
  const bannedPhrases = [
    'as an ai language model',
    'as a language model',
    'i cannot',
    'i\'m an ai',
    'as an artificial intelligence',
    'i don\'t have personal',
    'i was trained',
    'my training data',
    'as a chatbot',
  ];

  const found = bannedPhrases.filter((p) => content.toLowerCase().includes(p));
  if (found.length > 0) {
    return {
      gate_id: 'G6_TONE',
      status: 'DRAFT',
      reasons: [`Banned phrases detected: ${found.join(', ')}`],
    };
  }

  return { gate_id: 'G6_TONE', status: 'PASS', reasons: [] };
}

/** G7: Image (§6.3.6 Gate 7) */
function runG7(ctx: GateContext): GateResult {
  if (
    !ctx.stage4.featured_image ||
    !ctx.stage4.featured_image.prompt ||
    !ctx.stage4.featured_image.alt_text
  ) {
    return {
      gate_id: 'G7_IMAGE',
      status: 'HOLD',
      reasons: ['Missing featured image or alt text'],
    };
  }

  return { gate_id: 'G7_IMAGE', status: 'PASS', reasons: [] };
}

/** G8: SEO Meta (§6.3.6 Gate 8) — strengthened with schema_version strict check */
function runG8(ctx: GateContext): GateResult {
  const issues: string[] = [];

  // schema_version="1.0" strict compatibility check
  if (ctx.stage3.schema_version !== '1.0') {
    issues.push(`schema_version mismatch: expected "1.0", got "${ctx.stage3.schema_version}"`);
  }

  if (!ctx.stage3.meta_title) issues.push('Missing meta_title');
  if (!ctx.stage3.meta_description) issues.push('Missing meta_description');
  if (!ctx.stage3.focus_keyword) issues.push('Missing focus_keyword');

  // Title length check (35-70 chars per spec, target 45-60)
  if (ctx.stage3.meta_title && ctx.stage3.meta_title.length > 70) {
    issues.push(`meta_title too long (${ctx.stage3.meta_title.length} chars, max 70)`);
  }
  if (ctx.stage3.meta_title && ctx.stage3.meta_title.length < 35) {
    issues.push(`meta_title too short (${ctx.stage3.meta_title.length} chars, min 35)`);
  }

  // Description length check (120-170 chars per spec, target 140-160)
  if (
    ctx.stage3.meta_description &&
    (ctx.stage3.meta_description.length < 120 || ctx.stage3.meta_description.length > 170)
  ) {
    issues.push(
      `meta_description length ${ctx.stage3.meta_description.length} outside 120-170 range`
    );
  }

  // Slug constraints: kebab-case, max 75 chars, no double hyphens
  if (ctx.stage3.suggested_slug) {
    const slug = ctx.stage3.suggested_slug;
    if (slug.length > 75) {
      issues.push(`suggested_slug too long (${slug.length} chars, max 75)`);
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      issues.push('suggested_slug not valid kebab-case');
    }
    if (slug.includes('--')) {
      issues.push('suggested_slug contains double hyphens');
    }
  }

  // Internal link metadata completeness
  if (!ctx.stage3.additional_keywords || ctx.stage3.additional_keywords.length < 3) {
    issues.push('additional_keywords should have >= 3 items');
  }

  if (issues.length > 0) {
    return { gate_id: 'G8_SEO_META', status: 'DRAFT', reasons: issues };
  }

  return { gate_id: 'G8_SEO_META', status: 'PASS', reasons: [] };
}

// ─── Gate Engine ────────────────────────────────────────────────

const GATE_RUNNERS: Array<(ctx: GateContext) => GateResult> = [
  runG1,
  runG2,
  runG3,
  runG4,
  runG5,
  runG6,
  runG7,
  runG8,
];

/**
 * Run all gates in order (G1–G8).
 * Computes final recommendation: HOLD > DRAFT > PUBLISH.
 * Note: "PUBLISH" maps to draft_wp only (ALWAYS-DRAFT posture).
 */
export function runGates(ctx: GateContext): GateEngineResult {
  const results: GateResult[] = [];
  const allReasons: string[] = [];
  let worstOutcome: GateOutcome = 'PASS';
  let robotsDecision: RobotsDecision = 'index,follow';

  for (const runner of GATE_RUNNERS) {
    const result = runner(ctx);
    results.push(result);
    logger.info(`Gate ${result.gate_id}: ${result.status}`, { reasons: result.reasons });

    if (result.reasons.length > 0) {
      allReasons.push(...result.reasons);
    }

    // HOLD > DRAFT > PASS priority
    if (result.status === 'HOLD') {
      worstOutcome = 'HOLD';
    } else if (result.status === 'DRAFT' && worstOutcome !== 'HOLD') {
      worstOutcome = 'DRAFT';
    }

    // G3 local doorway — force noindex on DRAFT
    if (result.gate_id === 'G3_LOCAL_DOORWAY' && result.status === 'DRAFT') {
      robotsDecision = 'noindex,follow';
    }
  }

  // Map worst outcome to recommendation
  let recommendation: PublishRecommendation;
  if (worstOutcome === 'HOLD') {
    recommendation = 'HOLD';
  } else if (worstOutcome === 'DRAFT') {
    recommendation = 'DRAFT';
  } else {
    recommendation = 'PUBLISH';
  }

  return { results, recommendation, robotsDecision, reasons: allReasons };
}
