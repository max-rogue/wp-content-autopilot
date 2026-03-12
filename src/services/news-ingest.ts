/**
 * News RSS/Atom Ingestion Service.
 * Fetches golf news from configured RSS feeds and inserts into publish_queue
 * as BlogPost items with news_source_url metadata.
 *
 * Pattern mirrors csv-ingest.ts:
 *   - Idempotency key: SHA-256("news|" + articleUrl)
 *   - Duplicates silently skipped
 *   - content_type: 'BlogPost' (preserves existing CHECK constraint)
 *   - Fail-open: errors logged, never block keyword pipeline
 *
 * Ref: 13_CONTENT_OPS_PIPELINE §6.2, §6.4
 * Ref: 32_IDEMPOTENCY_AND_RETRY
 */

import * as crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { PublishQueueRepo } from '../db/repositories';
import { logger } from '../logger';
import { loadConfig } from '../config';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export interface NewsIngestOptions {
    /** RSS/Atom feed URLs to fetch */
    feedUrls: string[];
    /** Only ingest items published within this many hours. Default: 24 */
    lookbackHours: number;
    /** Maximum items to insert this tick. Default: 3 */
    maxItems: number;
    /** HTTP timeout per feed in ms. Default: 5000 */
    httpTimeoutMs: number;
}

export interface NewsIngestResult {
    schema_version: '1.0';
    feeds_attempted: number;
    feeds_succeeded: number;
    feeds_failed: number;
    items_found: number;
    inserted: number;
    skipped: number;
    errors: string[];
}

export interface NewsCandidate {
    title: string;
    url: string;
    publishedAt: Date;
    summary: string;
    sourceName: string;
    feedUrl: string;
}

// ═══════════════════════════════════════════════════════════════════
// RSS/Atom XML Parser (lightweight, zero external deps)
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract text content from an XML element by tag name.
 * Returns first match or empty string. Handles CDATA.
 */
function xmlText(xml: string, tag: string): string {
    // Match <tag ...>content</tag> or <tag ...><![CDATA[content]]></tag>
    const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i');
    const m = xml.match(re);
    if (!m) return '';
    return (m[1] ?? m[2] ?? '').trim();
}

/**
 * Extract an attribute value from an XML element.
 */
function xmlAttr(xml: string, tag: string, attr: string): string {
    const tagRe = new RegExp(`<${tag}\\s[^>]*${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
    const m = xml.match(tagRe);
    return m ? m[1] : '';
}

/**
 * Split XML into individual item/entry elements.
 */
function xmlItems(xml: string): string[] {
    // RSS uses <item>, Atom uses <entry>
    const items: string[] = [];
    const re = /<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
        items.push(m[0]);
    }
    return items;
}

/**
 * Derive source name from a feed's XML (channel title or feed title).
 */
function extractFeedTitle(xml: string): string {
    // RSS: <channel><title>...</title>
    // Atom: <feed><title>...</title>
    // Try to get the channel/feed level title (not item level)
    const channelMatch = xml.match(/<channel[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    if (channelMatch) return channelMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const feedMatch = xml.match(/<feed[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    if (feedMatch) return feedMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    return '';
}

/**
 * Parse a single RSS <item> or Atom <entry> into a NewsCandidate.
 */
function parseItem(itemXml: string, feedTitle: string, feedUrl: string): NewsCandidate | null {
    const title = xmlText(itemXml, 'title');
    if (!title) return null;

    // URL: RSS uses <link>, Atom uses <link href="..."/>
    let url = xmlText(itemXml, 'link');
    if (!url) {
        url = xmlAttr(itemXml, 'link', 'href');
    }
    if (!url) return null;

    // Published date: RSS uses <pubDate>, Atom uses <published> or <updated>
    const dateStr = xmlText(itemXml, 'pubDate')
        || xmlText(itemXml, 'published')
        || xmlText(itemXml, 'updated')
        || xmlText(itemXml, 'dc:date');

    const publishedAt = dateStr ? new Date(dateStr) : new Date(0);

    // Summary: RSS uses <description>, Atom uses <summary> or <content>
    const summary = xmlText(itemXml, 'description')
        || xmlText(itemXml, 'summary')
        || xmlText(itemXml, 'content');

    // Strip HTML tags from summary for clean text
    const cleanSummary = summary.replace(/<[^>]+>/g, '').trim().slice(0, 500);

    return {
        title: title.replace(/<[^>]+>/g, '').trim(),
        url: url.trim(),
        publishedAt,
        summary: cleanSummary,
        sourceName: feedTitle || new URL(feedUrl).hostname,
        feedUrl,
    };
}

// ═══════════════════════════════════════════════════════════════════
// Feed Fetcher
// ═══════════════════════════════════════════════════════════════════

/**
 * Fetch a single RSS/Atom feed and parse candidates.
 * Returns empty array on any error (fail-open).
 */
async function fetchFeed(
    feedUrl: string,
    timeoutMs: number,
): Promise<{ candidates: NewsCandidate[]; error?: string }> {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(feedUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'WPContentAutopilot/1.0 (RSS Ingest)',
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
            },
        });

        clearTimeout(timer);

        if (!response.ok) {
            return { candidates: [], error: `HTTP ${response.status}` };
        }

        const xml = await response.text();
        const feedTitle = extractFeedTitle(xml);
        const items = xmlItems(xml);

        const candidates: NewsCandidate[] = [];
        for (const itemXml of items) {
            const c = parseItem(itemXml, feedTitle, feedUrl);
            if (c) candidates.push(c);
        }

        return { candidates };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { candidates: [], error: msg };
    }
}

// ═══════════════════════════════════════════════════════════════════
// Idempotency
// ═══════════════════════════════════════════════════════════════════

/**
 * Compute idempotency key for a news article URL.
 * Uses SHA-256 with "news|" prefix domain to avoid collisions with CSV keys.
 */
export function computeNewsIdempotencyKey(articleUrl: string): string {
    return crypto.createHash('sha256').update(`news|${articleUrl}`, 'utf8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// Ingest Engine
// ═══════════════════════════════════════════════════════════════════

/**
 * Ingest news from RSS/Atom feeds into publish_queue.
 *
 * - Fetches each feed (with timeout + fail-open per feed).
 * - Filters by lookback window.
 * - Deduplicates via idempotency_key.
 * - Inserts as content_type='BlogPost', status='planned'.
 * - Hard cap: maxItems total insertions per tick.
 * - Returns summary JSON.
 */
export async function ingestNews(
    db: Database.Database,
    options: NewsIngestOptions,
): Promise<NewsIngestResult> {
    const { feedUrls, lookbackHours, maxItems, httpTimeoutMs } = options;

    const errors: string[] = [];
    let feedsSucceeded = 0;
    let feedsFailed = 0;
    const allCandidates: NewsCandidate[] = [];

    // Fetch all feeds (concurrency=3 via Promise.allSettled batches)
    const CONCURRENCY = 3;
    for (let i = 0; i < feedUrls.length; i += CONCURRENCY) {
        const batch = feedUrls.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(url => fetchFeed(url, httpTimeoutMs)),
        );

        for (let j = 0; j < results.length; j++) {
            const result = results[j];
            if (result.status === 'fulfilled') {
                if (result.value.error) {
                    feedsFailed++;
                    errors.push(`${batch[j]}: ${result.value.error}`);
                } else {
                    feedsSucceeded++;
                }
                allCandidates.push(...result.value.candidates);
            } else {
                feedsFailed++;
                errors.push(`${batch[j]}: ${result.reason}`);
            }
        }
    }

    // Filter by lookback window
    const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const recent = allCandidates.filter(c => c.publishedAt >= cutoff);

    // ── Golf relevance filter ────────────────────────────────────
    // Only keep articles that mention golf-related terms in title or summary.
    // This prevents non-golf sports articles from general feeds (e.g. VnExpress Thể Thao).
    const GOLF_KEYWORDS = [
        'golf', 'golfer', 'gôn', 'gậy golf', 'sân golf',
        'pga', 'lpga', 'masters', 'ryder cup', 'us open golf',
        'the open', 'british open',
        'swing', 'handicap', 'birdie', 'bogey', 'eagle', 'par',
        'fairway', 'green', 'bunker', 'caddie', 'caddy',
        'iron', 'driver', 'putter', 'wedge', 'shaft',
        'tee time', 'tee-time', 'scorecard',
        'tiger woods', 'rory mcilroy', 'scottie scheffler', 'jon rahm',
        'bryson dechambeau', 'jordan spieth', 'xander schauffele',
        'arnold palmer', 'jack nicklaus',
        'liv golf', 'dp world tour', 'korn ferry',
    ];
    const golfRelevant = recent.filter(c => {
        const text = `${c.title} ${c.summary}`.toLowerCase();
        return GOLF_KEYWORDS.some(kw => text.includes(kw));
    });

    logger.info('news-ingest: golf filter', {
        before: recent.length,
        after: golfRelevant.length,
        filtered_out: recent.length - golfRelevant.length,
    });

    // ── Relevance scoring ─────────────────────────────────────────
    // Rank articles by "golf-relevance score": more golf keyword matches = higher score.
    // Title matches count 2x (title relevance is a stronger signal).
    // This ensures the single daily news pick (maxItems=1) is the most noteworthy.
    function scoreCandidate(c: NewsCandidate): number {
        const titleLower = c.title.toLowerCase();
        const summaryLower = c.summary.toLowerCase();
        let score = 0;
        for (const kw of GOLF_KEYWORDS) {
            if (titleLower.includes(kw)) score += 2;  // title match = 2x weight
            if (summaryLower.includes(kw)) score += 1;
        }
        return score;
    }

    // Sort by relevance score DESC, then by publishedAt DESC (tiebreaker: newest)
    golfRelevant.sort((a, b) => {
        const scoreDiff = scoreCandidate(b) - scoreCandidate(a);
        if (scoreDiff !== 0) return scoreDiff;
        return b.publishedAt.getTime() - a.publishedAt.getTime();
    });

    if (golfRelevant.length > 0) {
        const top = golfRelevant[0];
        logger.info('news-ingest: top pick', {
            title: top.title.slice(0, 80),
            score: scoreCandidate(top),
            source: top.sourceName,
        });
    }

    // Cap to maxItems (default 1 = single best article per day)
    const toProcess = golfRelevant.slice(0, maxItems);

    const queueRepo = new PublishQueueRepo(db);
    let inserted = 0;
    let skipped = 0;

    for (const candidate of toProcess) {
        const idempotencyKey = computeNewsIdempotencyKey(candidate.url);

        // Dedup check
        const existing = queueRepo.findByIdempotencyKey(idempotencyKey);
        if (existing) {
            skipped++;
            continue;
        }

        // Build keyword from news title (used as picked_keyword)
        const keyword = candidate.title.slice(0, 200);

        const config = loadConfig();

        const id = uuid();
        queueRepo.insert({
            id,
            picked_keyword: keyword,
            normalized_keyword: keyword.toLowerCase().trim(),
            language: config.defaultLanguage,
            idempotency_key: idempotencyKey,
            cluster: 'news',
            content_type: 'BlogPost',
            class_hint: 'B',
            blogpost_subtype: null,
            status: 'planned',
            scheduled_for: null,
            published_url: null,
            published_wp_id: null,
            fail_reasons: null,
            model_trace: null,
            similarity_score: null,
            similarity_band: null,
            robots_decision: null,
            gate_results: null,
            dropped_tags: null,
            wp_tag_not_found: null,
            canonical_category: null,
            news_source_url: candidate.url,
            news_source_name: candidate.sourceName,
        });

        inserted++;
        logger.info('news-ingest: item inserted', {
            title_len: keyword.length,
            source: candidate.sourceName,
        });
    }

    logger.info('news-ingest: complete', {
        feeds_attempted: feedUrls.length,
        feeds_succeeded: feedsSucceeded,
        feeds_failed: feedsFailed,
        items_found: allCandidates.length,
        recent_count: recent.length,
        inserted,
        skipped,
    });

    return {
        schema_version: '1.0',
        feeds_attempted: feedUrls.length,
        feeds_succeeded: feedsSucceeded,
        feeds_failed: feedsFailed,
        items_found: allCandidates.length,
        inserted,
        skipped,
        errors,
    };
}
