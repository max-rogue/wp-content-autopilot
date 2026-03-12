/**
 * Stage 3 — Writer (ContentSpec JSON Contract)
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.4
 *
 * Calls LLM draft provider, validates output contract.
 * Status transition: researching → drafting → qa.
 */

import type { Stage2Output, Stage3Output, ContentClass, BlogpostSubtype, SitemapPair } from '../types';
import type { WriterService } from '../services/writer';
import type { PublishQueueRepo } from '../db/repositories';
import { logger } from '../logger';
import { boundedExcerpt } from '../services/json-repair';

export interface Stage3Input {
  queueId: string;
  keyword: string;
  contentType: string;
  classHint: ContentClass;
  blogpostSubtype: BlogpostSubtype | null;
  stage2: Stage2Output;
  writerService: WriterService;
  queueRepo: PublishQueueRepo;
  /** T-10: if present and non-empty, fail-closed href stripping is applied. */
  sitemapSnippet?: SitemapPair[];
  /** News source URL — triggers Vietnamese title rewrite instruction. */
  newsSourceUrl?: string | null;
}

export interface Stage3Result {
  ok: boolean;
  output?: Stage3Output;
  failReason?: string;
}

function validateStage3Output(output: Stage3Output): string[] {
  const issues: string[] = [];
  if (!output.title) issues.push('missing title');
  if (!output.content_markdown) issues.push('missing content_markdown');
  if (!output.excerpt) issues.push('missing excerpt');
  if (!output.category) issues.push('missing category');
  if (!output.focus_keyword) issues.push('missing focus_keyword');
  if (!output.meta_title) issues.push('missing meta_title');
  if (!output.meta_description) issues.push('missing meta_description');
  if (!output.faq || output.faq.length < 3) issues.push('FAQ requires >= 3 items');
  if (!output.featured_image || !output.featured_image.alt_text) {
    issues.push('missing featured_image alt_text');
  }
  return issues;
}

/**
 * Check for AI safety violations.
 * Ref: 14_SECURITY_PRIVACY §6.4
 *
 * Safe for undefined/null input — returns null (no issue) on bad input
 * since the caller should validate fields separately.
 */
function checkAiSafety(content: string | undefined | null): string | null {
  if (!content) return null;

  const lower = content.toLowerCase();
  const bannedPhrases = [
    'as an ai language model',
    'as a language model',
    'i\'m an ai',
    'as an artificial intelligence',
  ];
  for (const phrase of bannedPhrases) {
    if (lower.includes(phrase)) {
      return `unsafe_content_or_injection: detected "${phrase}"`;
    }
  }

  // Prohibited topics check
  const prohibited = ['gambling', 'adult content', 'illegal drugs'];
  for (const topic of prohibited) {
    if (lower.includes(topic)) {
      return `unsafe_content_or_injection: prohibited topic "${topic}"`;
    }
  }

  return null;
}

export async function runStage3(input: Stage3Input): Promise<Stage3Result> {
  const { queueId, keyword, contentType, classHint, blogpostSubtype, stage2, writerService, queueRepo, sitemapSnippet, newsSourceUrl } = input;

  // Transition: researching → drafting
  queueRepo.updateStatus(queueId, 'drafting');

  try {
    const { output, rawText } = await writerService.draft(queueId, stage2, keyword, contentType, classHint, blogpostSubtype, sitemapSnippet, newsSourceUrl);

    // ── Validate required fields exist before using them ────────
    // LLM-parsed output may have missing fields; guard before .toLowerCase() etc.
    const missingFields: string[] = [];
    if (!output.content_markdown) missingFields.push('content_markdown');
    if (!output.title) missingFields.push('title');
    if (!output.suggested_slug) missingFields.push('suggested_slug');
    if (!output.focus_keyword) missingFields.push('focus_keyword');

    if (missingFields.length > 0) {
      const reasons = missingFields.map(f => `missing_required_field:${f}`);
      const excerpt = boundedExcerpt(rawText, 500);
      logger.warn('Stage 3: draft missing required fields', {
        queue_id: queueId,
        missingFields,
        raw_excerpt: excerpt,
      });
      queueRepo.updateStatus(queueId, 'failed', {
        fail_reasons: JSON.stringify([
          'writer_contract_invalid',
          ...reasons,
          `raw_excerpt: ${excerpt}`,
        ]),
      });
      return { ok: false, failReason: `writer_contract_invalid: ${reasons.join(', ')}` };
    }

    // AI safety check (§14 6.4) — safe for undefined via guard above
    const safetyIssue = checkAiSafety(output.content_markdown);
    if (safetyIssue) {
      logger.warn('Stage 3: AI safety violation', { queue_id: queueId, issue: safetyIssue });
      queueRepo.updateStatus(queueId, 'hold', {
        fail_reasons: JSON.stringify([safetyIssue]),
      });
      return { ok: false, failReason: safetyIssue };
    }

    // Validate full contract completeness
    const issues = validateStage3Output(output);
    if (issues.length > 0) {
      logger.warn('Stage 3: contract invalid', { queue_id: queueId, issues });
      queueRepo.updateStatus(queueId, 'failed', {
        fail_reasons: JSON.stringify(['writer_contract_invalid', ...issues]),
      });
      return { ok: false, failReason: 'writer_contract_invalid' };
    }

    // Transition: drafting → qa
    queueRepo.updateStatus(queueId, 'qa');

    // ── Final edit pass (LLM_FINAL_*) ──────────────────────────
    // Graceful degradation: if finalEdit fails, use draft as-is
    let finalOutput = output;
    try {
      finalOutput = await writerService.finalEdit(output);
    } catch (err) {
      const editMsg = err instanceof Error ? err.message : String(err);
      logger.warn('Stage 3: finalEdit failed, using draft as-is', { error: editMsg });
    }

    // ── T-10: Fail-closed href stripping (post-finalEdit) ───────
    // If sitemapSnippet is provided, strip <a> tags whose hrefs
    // are not in the allowed slug set. Preserve anchor text.
    if (sitemapSnippet && sitemapSnippet.length > 0) {
      const allowedSlugs = new Set(sitemapSnippet.map(p => p.slug));
      const usedSlugs = new Set<string>();

      // Match <a href="...">...</a> — non-greedy
      finalOutput.content_markdown = finalOutput.content_markdown.replace(
        /<a\s+href="([^"]*?)"[^>]*>(.*?)<\/a>/gi,
        (_match, href: string, anchorText: string) => {
          // Normalize href to relative path (strip origin if present)
          let slug = href;
          try {
            const parsed = new URL(href, 'https://placeholder.local');
            slug = parsed.pathname;
          } catch { /* use as-is */ }

          if (allowedSlugs.has(slug)) {
            usedSlugs.add(slug);
            return _match; // Keep valid link
          }
          // Strip: return anchor text only
          return anchorText;
        },
      );

      // Build internal_links_used from the slugs that survived
      finalOutput.internal_links_used = sitemapSnippet.filter(p => usedSlugs.has(p.slug));
    } else {
      // No snippet → no stripping, default empty array
      finalOutput.internal_links_used = [];
    }

    logger.info('Stage 3: draft complete', { queue_id: queueId });
    return { ok: true, output: finalOutput };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Stage 3: draft failed', { error: msg });

    if (msg.startsWith('schema_parse_failed')) {
      const excerpt = msg.slice('schema_parse_failed'.length + 2) || 'no excerpt';
      queueRepo.updateStatus(queueId, 'hold', {
        fail_reasons: JSON.stringify([
          'schema_parse_failed',
          `raw_excerpt: ${excerpt}`,
        ]),
      });
      return { ok: false, failReason: 'schema_parse_failed' };
    }

    queueRepo.updateStatus(queueId, 'failed', {
      fail_reasons: JSON.stringify([`writer_error: ${msg}`]),
    });
    return { ok: false, failReason: msg };
  }
}
