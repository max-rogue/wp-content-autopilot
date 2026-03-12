/**
 * Content Enrichment — Hero Image + Table of Contents injection
 * Ref: Stage 6 enrichment (non-blocking)
 *
 * Hero image: Gutenberg wp:image block injected at top of content.
 * TOC: collapsible <details> block with anchor links to H2/H3 headings.
 *
 * Both enrichments are NON-BLOCKING:
 *   - If injection fails, draft_wp is preserved and reasons[] updated.
 *   - No secrets in logs.
 */

import { logger } from '../logger';

// ─── Types ──────────────────────────────────────────────────────

export interface ParsedHeading {
    level: 2 | 3;
    text: string;
    id: string;
    /** Whether the heading already had an id/anchor */
    existingId: boolean;
}

export interface EnrichmentOptions {
    /** WP media attachment ID (from upload). Omit if no media uploaded. */
    wpMediaId?: number;
    /** WP media source URL (from upload response). */
    sourceUrl?: string;
    /** Alt text for the hero image. */
    altText?: string;
}

export interface EnrichmentResult {
    /** The enriched content (or original if nothing changed). */
    content: string;
    /** Whether hero image was injected. */
    heroInjected: boolean;
    /** Whether TOC was injected. */
    tocInjected: boolean;
    /** Non-blocking failure reasons (empty on success). */
    reasons: string[];
}

interface UnsafePattern {
    name: string;
    regex: RegExp;
}

const ENRICHMENT_BANNED_PATTERNS: UnsafePattern[] = [
    { name: 'script', regex: /<script[\s>]/i },
    { name: 'iframe', regex: /<iframe[\s>]/i },
    { name: 'object', regex: /<object[\s>]/i },
    { name: 'embed', regex: /<embed[\s>]/i },
    { name: 'form', regex: /<form[\s>]/i },
    { name: 'event_handler', regex: /on\w+\s*=/i },
    { name: 'javascript_uri', regex: /javascript\s*:/i },
    { name: 'style_tag', regex: /<style[\s>]/i },
    { name: 'style_attr', regex: /\sstyle\s*=/i },
];

// ─── Anchor Slug Generation ─────────────────────────────────────

/**
 * Convert heading text to a kebab-case anchor slug.
 * Rules: max 75 chars, no double hyphens, ASCII-safe.
 */
export function toSlugAnchor(text: string): string {
    return text
        .toLowerCase()
        .trim()
        // Vietnamese diacritics → ASCII approximation
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        // đ/Đ special handling (NFD doesn't decompose đ)
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd')
        // Replace non-alphanumeric with hyphens
        .replace(/[^a-z0-9]+/g, '-')
        // Remove leading/trailing hyphens
        .replace(/^-+|-+$/g, '')
        // Collapse double hyphens
        .replace(/-{2,}/g, '-')
        // Max 75 chars
        .slice(0, 75)
        // Remove any trailing hyphen from truncation
        .replace(/-+$/, '');
}

// ─── Heading Parser ─────────────────────────────────────────────

/**
 * Parse H2/H3 headings from content.
 * Handles both Gutenberg wp:heading blocks and plain HTML <h2>/<h3>.
 * Ignores H1.
 */
export function parseHeadings(content: string): ParsedHeading[] {
    const headings: ParsedHeading[] = [];
    // Match <h2> and <h3> tags (with optional attributes including id)
    const headingRegex = /<h([23])([^>]*)>(.*?)<\/h\1>/gi;
    let match: RegExpExecArray | null;

    while ((match = headingRegex.exec(content)) !== null) {
        const level = parseInt(match[1], 10) as 2 | 3;
        const attrs = match[2];
        const rawText = match[3];

        // Strip inner HTML tags to get plain text
        const text = rawText.replace(/<[^>]+>/g, '').trim();
        if (!text) continue;

        // Check for existing id attribute
        const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i);
        const existingId = !!idMatch;
        const id = idMatch ? idMatch[1] : toSlugAnchor(text);

        headings.push({ level, text, id, existingId });
    }

    return assignDeterministicHeadingIds(headings);
}

function assignDeterministicHeadingIds(headings: ParsedHeading[]): ParsedHeading[] {
    const usedIds = new Set<string>();

    return headings.map((heading) => {
        if (heading.existingId) {
            usedIds.add(heading.id);
            return heading;
        }

        const base = heading.id || toSlugAnchor(heading.text) || 'section';
        let candidate = base;
        let suffix = 2;

        while (usedIds.has(candidate)) {
            candidate = `${base}-${suffix}`;
            suffix += 1;
        }

        usedIds.add(candidate);
        return { ...heading, id: candidate };
    });
}

// ─── Heading ID Injection ───────────────────────────────────────

/**
 * Inject id attributes into headings that don't already have them.
 * Returns the content with stable anchors on all H2/H3.
 */
export function injectHeadingIds(
    content: string,
    headings: ParsedHeading[]
): string {
    if (headings.filter((h) => !h.existingId).length === 0) return content;

    let headingIdx = 0;

    return content.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (full, levelStr, attrs, inner) => {
        const current = headings[headingIdx++];
        if (!current) return full;

        // Preserve existing IDs as-is.
        if (current.existingId || /\bid\s*=/i.test(attrs)) {
            return full;
        }

        return `<h${levelStr} id="${current.id}"${attrs}>${inner}</h${levelStr}>`;
    });
}

// ─── Hero Image Block ───────────────────────────────────────────

/**
 * Build a Gutenberg wp:image block for the hero image.
 */
export function buildHeroBlock(
    wpMediaId: number,
    sourceUrl: string,
    altText: string
): string {
    if (!isSafeMediaUrl(sourceUrl)) {
        throw new Error('unsafe_media_source_url');
    }

    // Sanitize alt text (escape quotes)
    const safeAlt = altText.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeUrl = sourceUrl.replace(/"/g, '&quot;');

    return (
        `<!-- wp:image {"id":${wpMediaId},"sizeSlug":"large","linkDestination":"none","className":"wcap-hero-image"} -->\n` +
        `<figure class="wp-block-image size-large wcap-hero-image">` +
        `<img src="${safeUrl}" alt="${safeAlt}"/>` +
        `</figure>\n` +
        `<!-- /wp:image -->`
    );
}

function isSafeMediaUrl(url: string): boolean {
    const value = url.trim();
    if (!value) return false;
    if (/javascript\s*:/i.test(value)) return false;
    return /^https?:\/\/[^\s"'<>]+$/i.test(value);
}

// ─── TOC Block ──────────────────────────────────────────────────

/**
 * Build a TOC block from parsed headings.
 * Uses <details><summary> for collapsible UX.
 * Wrapped in wp:html for Gutenberg compatibility.
 */
export function buildTocBlock(headings: ParsedHeading[]): string {
    const listItems = headings.map((h) => {
        const indent = h.level === 3 ? '      ' : '    ';
        const safeText = h.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `${indent}<li><a href="#${h.id}">${safeText}</a></li>`;
    });

    return (
        `<!-- wp:html -->\n` +
        `<details class="wcap-toc is-collapsible" open>\n` +
        `  <summary class="wcap-toc__title">Mục lục</summary>\n` +
        `  <nav class="wcap-toc__nav">\n` +
        `    <ol class="wcap-toc__list">\n` +
        listItems.join('\n') + '\n' +
        `    </ol>\n` +
        `  </nav>\n` +
        `</details>\n` +
        `<!-- /wp:html -->`
    );
}

// ─── Content Has Image Detection ────────────────────────────────

/**
 * Check if content already contains an image tag or wp:image block.
 * Used to prevent duplicate hero image injection.
 */
export function contentHasImage(content: string): boolean {
    // Check for <img ...> tag
    if (/<img[\s>]/i.test(content)) return true;
    // Check for wp:image block comment
    if (/<!--\s*wp:image\b/i.test(content)) return true;
    return false;
}

/**
 * Check if content already has a hero-equivalent image near the top.
 * Product requirement: hero image should appear at the top of content.
 */
export function contentHasTopHeroImage(content: string, topWindowChars = 1200): boolean {
    if (/wcap-hero-image/i.test(content)) return true;

    const wpImagePos = content.search(/<!--\s*wp:image\b/i);
    const imgPos = content.search(/<img[\s>]/i);

    const positions = [wpImagePos, imgPos].filter((pos) => pos >= 0);
    if (positions.length === 0) return false;

    const firstImagePos = Math.min(...positions);
    return firstImagePos <= topWindowChars;
}

export function contentHasTocBlock(content: string): boolean {
    return /class\s*=\s*["'][^"']*\bwcap-toc\b/i.test(content);
}

function findUnsafePatterns(content: string): string[] {
    const matched: string[] = [];
    for (const p of ENRICHMENT_BANNED_PATTERNS) {
        if (p.regex.test(content)) matched.push(p.name);
    }
    return matched;
}

// ─── Main Enrichment Function ───────────────────────────────────

/**
 * Enrich post content with hero image and/or TOC.
 *
 * Both are non-blocking: failures produce reasons[] without throwing.
 * Caller should NOT fail the pipeline run on enrichment failure.
 */
export function enrichContent(
    content: string,
    opts: EnrichmentOptions
): EnrichmentResult {
    const reasons: string[] = [];
    let enriched = content;
    let heroInjected = false;
    let tocInjected = false;

    // ── Hero Image Injection ────────────────────────────────────
    try {
        if (opts.wpMediaId && opts.sourceUrl) {
            if (contentHasTopHeroImage(enriched)) {
                // Content already has hero-equivalent image near top — skip duplicate hero
                logger.info('Content enrichment: top image/hero exists — skipping hero', {
                    hero_skipped: true,
                });
            } else {
                const altText = opts.altText || '';
                const heroBlock = buildHeroBlock(opts.wpMediaId, opts.sourceUrl, altText);
                enriched = heroBlock + '\n\n' + enriched;
                heroInjected = true;
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reasons.push('hero_inject_failed');
        logger.warn('Content enrichment: hero injection failed — non-blocking', {
            error: msg.slice(0, 200),
        });
    }

    // ── TOC Injection ───────────────────────────────────────────
    try {
        if (contentHasTocBlock(enriched)) {
            logger.info('Content enrichment: TOC already exists — skipping TOC', {
                toc_skipped: true,
            });
        } else {
            const headings = parseHeadings(enriched);

            if (headings.length >= 3) {
                // Inject heading IDs first
                enriched = injectHeadingIds(enriched, headings);

                // Re-parse after ID injection to get final IDs
                const finalHeadings = parseHeadings(enriched);
                const tocBlock = buildTocBlock(finalHeadings);

                // Insert TOC after hero block (if present), else at start
                if (heroInjected) {
                    // Find end of hero block and insert after
                    const heroEnd = enriched.indexOf('<!-- /wp:image -->');
                    if (heroEnd !== -1) {
                        const insertPos = heroEnd + '<!-- /wp:image -->'.length;
                        enriched =
                            enriched.slice(0, insertPos) +
                            '\n\n' +
                            tocBlock +
                            '\n\n' +
                            enriched.slice(insertPos).replace(/^\n+/, '');
                    } else {
                        // Fallback: prepend
                        enriched = tocBlock + '\n\n' + enriched;
                    }
                } else {
                    // No hero — put TOC at the very start
                    enriched = tocBlock + '\n\n' + enriched;
                }

                tocInjected = true;
            } else {
                logger.info('Content enrichment: < 3 H2/H3 headings — skipping TOC', {
                    heading_count: headings.length,
                });
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reasons.push('toc_inject_failed');
        logger.warn('Content enrichment: TOC injection failed — non-blocking', {
            error: msg.slice(0, 200),
        });
    }

    // Final enrichment safety check: never return enriched content that violates banned HTML/JS policies.
    if (enriched !== content) {
        const unsafe = findUnsafePatterns(enriched);
        if (unsafe.length > 0) {
            reasons.push('content_enrichment_policy_blocked');
            logger.warn('Content enrichment: unsafe pattern detected — reverting enrichment', {
                unsafe_patterns: unsafe,
            });
            return {
                content,
                heroInjected: false,
                tocInjected: false,
                reasons,
            };
        }
    }

    return { content: enriched, heroInjected, tocInjected, reasons };
}
