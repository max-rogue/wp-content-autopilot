/**
 * Stage 2 — Research Pack with Citations
 * Ref: 13_CONTENT_OPS_PIPELINE §6.3.3
 *
 * Calls LLM research provider, builds citation pack.
 * Status: remains 'researching' until writer starts.
 */

import type { Stage1Output, Stage2Output } from '../types';
import type { WriterService } from '../services/writer';
import type { PublishQueueRepo } from '../db/repositories';
import { logger } from '../logger';

export interface Stage2Input {
  stage1: Stage1Output;
  writerService: WriterService;
  queueRepo: PublishQueueRepo;
  /** Optional: news article URL to fetch and use as research source */
  newsSourceUrl?: string;
}

export interface Stage2Result {
  ok: boolean;
  output?: Stage2Output;
  failReason?: string;
}

export async function runStage2(input: Stage2Input): Promise<Stage2Result> {
  const { stage1, writerService, queueRepo, newsSourceUrl } = input;

  // If this is a news item, fetch the source article text
  let newsContext: string | undefined;
  if (newsSourceUrl) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const resp = await fetch(newsSourceUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'WPContentAutopilot/1.0' },
      });
      clearTimeout(timer);
      if (resp.ok) {
        const html = await resp.text();
        // Strip HTML tags, scripts, styles — keep text only
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 15_000); // Cap at 15K chars for LLM context
        newsContext = text;
        logger.info('Stage 2: news source fetched', {
          queue_id: stage1.queue_id,
          url_len: newsSourceUrl.length,
          text_len: text.length,
        });
      } else {
        logger.warn('Stage 2: news source HTTP error — using normal research', {
          queue_id: stage1.queue_id,
          status: resp.status,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Stage 2: news source fetch failed — using normal research', {
        queue_id: stage1.queue_id,
        error: msg,
      });
    }
  }

  try {
    const output = await writerService.research(
      stage1.queue_id,
      stage1.picked_keyword,
      stage1.content_type,
      stage1.required_data_flags,
      stage1.class_hint,
      stage1.blogpost_subtype,
      newsContext,
    );

    // Hard gate: missing required citations (§6.3.3)
    if (output.citations_required && !output.citations_present) {
      queueRepo.updateStatus(stage1.queue_id, 'hold', {
        fail_reasons: JSON.stringify(['missing_citations']),
      });
      return { ok: false, failReason: 'missing_citations' };
    }

    // Hard gate: no usable outline
    if (!output.outline_points || output.outline_points.length === 0) {
      queueRepo.updateStatus(stage1.queue_id, 'failed', {
        fail_reasons: JSON.stringify(['research_failed']),
      });
      return { ok: false, failReason: 'research_failed' };
    }

    logger.info('Stage 2: research complete', { queue_id: stage1.queue_id });
    return { ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Stage 2: research failed', { error: msg });

    if (msg.startsWith('schema_parse_failed')) {
      // Extract bounded excerpt from error: 'schema_parse_failed: <excerpt>'
      const excerpt = msg.slice('schema_parse_failed'.length + 2) || 'no excerpt';
      queueRepo.updateStatus(stage1.queue_id, 'hold', {
        fail_reasons: JSON.stringify([
          'schema_parse_failed',
          `raw_excerpt: ${excerpt}`,
        ]),
      });
      return { ok: false, failReason: 'schema_parse_failed' };
    }

    queueRepo.updateStatus(stage1.queue_id, 'failed', {
      fail_reasons: JSON.stringify([`research_error: ${msg}`]),
    });
    return { ok: false, failReason: msg };
  }
}
