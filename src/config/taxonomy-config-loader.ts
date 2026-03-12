/**
 * Taxonomy Config Loader — reads taxonomy_config.yaml at startup.
 * Ref: docs/spec/marketing/05_AgentPrompts.md §8
 * Ref: docs/spec/marketing/01_ContentSpec.md §2.2
 *
 * Loaded once per process restart. No hot-reload. No hardcoding whitelist in prompts.
 * The pipeline reads this config; it never writes to it.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

// ─── YAML parsing (inline, no external dependency) ──────────────
// We use a simple YAML parser for this well-known structure.
// For production robustness, this handles the specific structure of taxonomy_config.yaml.

function parseSimpleYaml(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    let currentTopKey = '';
    let currentGroupKey = '';
    let currentList: string[] | null = null;
    let currentNestedKey = '';
    let inGraduated = false;
    let currentApprovedAddition: { slug: string; group: string } | null = null;
    const approvedAdditions: Array<{ slug: string; group: string }> = [];

    const cleanScalar = (v: string): string => v.trim().replace(/^['"]|['"]$/g, '');

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');

        // Skip comments and empty lines
        if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

        // Top-level key: "version:", "tag_whitelist:", "tag_archive_policy:", "max_tags_per_post:"
        const topMatch = line.match(/^([a-z_]+):\s*(.*)?$/);
        if (topMatch) {
            // Save previous list
            if (currentList && currentGroupKey && currentTopKey === 'tag_whitelist') {
                const wl = result['tag_whitelist'] as Record<string, string[]> || {};
                wl[currentGroupKey] = currentList;
                result['tag_whitelist'] = wl;
                currentList = null;
                currentGroupKey = '';
            }
            if (currentList && inGraduated) {
                const tap = result['tag_archive_policy'] as Record<string, unknown> || {};
                tap['graduated'] = currentList;
                result['tag_archive_policy'] = tap;
                currentList = null;
                inGraduated = false;
            }
            if (currentTopKey === 'approved_additions' && currentApprovedAddition) {
                approvedAdditions.push(currentApprovedAddition);
                currentApprovedAddition = null;
            }

            currentTopKey = topMatch[1];
            const value = topMatch[2]?.trim();

            if (value && !value.startsWith('#')) {
                // Inline value
                if (value.startsWith('"') || value.startsWith("'")) {
                    result[currentTopKey] = value.replace(/^["']|["']$/g, '');
                } else if (/^\d+$/.test(value)) {
                    result[currentTopKey] = parseInt(value, 10);
                } else if (value === '[]') {
                    result[currentTopKey] = [];
                } else {
                    result[currentTopKey] = value;
                }
                currentTopKey = '';
            } else if (!value) {
                // Block value — handled by nested parsing below
                if (currentTopKey === 'tag_whitelist') {
                    result['tag_whitelist'] = result['tag_whitelist'] || {};
                } else if (currentTopKey === 'tag_archive_policy') {
                    result['tag_archive_policy'] = result['tag_archive_policy'] || {};
                } else if (currentTopKey === 'approved_additions') {
                    result['approved_additions'] = [];
                }
            }
            continue;
        }

        // approved_additions item start: "  - slug: my-tag"
        const approvedSlugMatch = line.match(/^\s{2}-\s+slug:\s*(.+)\s*$/);
        if (approvedSlugMatch && currentTopKey === 'approved_additions') {
            if (currentApprovedAddition) {
                approvedAdditions.push(currentApprovedAddition);
            }
            currentApprovedAddition = {
                slug: cleanScalar(approvedSlugMatch[1]),
                group: '',
            };
            continue;
        }

        // approved_additions item group: "    group: brand"
        const approvedGroupMatch = line.match(/^\s{4}group:\s*(.+)\s*$/);
        if (approvedGroupMatch && currentTopKey === 'approved_additions' && currentApprovedAddition) {
            currentApprovedAddition.group = cleanScalar(approvedGroupMatch[1]);
            continue;
        }

        // Second-level key under tag_whitelist: "  brand:" or under tag_archive_policy: "  default:"
        const secondMatch = line.match(/^  ([a-z_]+):\s*(.*)?$/);
        if (secondMatch) {
            // Save previous list
            if (currentList && currentGroupKey && currentTopKey === 'tag_whitelist') {
                const wl = result['tag_whitelist'] as Record<string, string[]>;
                wl[currentGroupKey] = currentList;
                currentList = null;
            }
            if (currentList && inGraduated) {
                const tap = result['tag_archive_policy'] as Record<string, unknown>;
                tap['graduated'] = currentList;
                currentList = null;
                inGraduated = false;
            }

            currentNestedKey = secondMatch[1];
            const value = secondMatch[2]?.trim();

            if (currentTopKey === 'tag_whitelist') {
                currentGroupKey = currentNestedKey;
                if (value === '[]') {
                    const wl = result['tag_whitelist'] as Record<string, string[]>;
                    wl[currentGroupKey] = [];
                    currentGroupKey = '';
                } else if (!value) {
                    currentList = [];
                }
            } else if (currentTopKey === 'tag_archive_policy') {
                if (currentNestedKey === 'graduated') {
                    if (value === '[]') {
                        const tap = result['tag_archive_policy'] as Record<string, unknown>;
                        tap['graduated'] = [];
                    } else if (!value) {
                        currentList = [];
                        inGraduated = true;
                    }
                } else {
                    const tap = result['tag_archive_policy'] as Record<string, unknown>;
                    tap[currentNestedKey] = value?.replace(/^["']|["']$/g, '') || '';
                }
            }
            continue;
        }

        // List item: "    - slug-value"
        const listMatch = line.match(/^\s+-\s+(.+)$/);
        if (listMatch && currentList !== null) {
            currentList.push(listMatch[1].trim());
            continue;
        }
    }

    // Save final list
    if (currentList && currentGroupKey && currentTopKey === 'tag_whitelist') {
        const wl = result['tag_whitelist'] as Record<string, string[]>;
        wl[currentGroupKey] = currentList;
    }
    if (currentList && inGraduated) {
        const tap = result['tag_archive_policy'] as Record<string, unknown>;
        tap['graduated'] = currentList;
    }
    if (currentTopKey === 'approved_additions' && currentApprovedAddition) {
        approvedAdditions.push(currentApprovedAddition);
    }
    if (approvedAdditions.length > 0) {
        result['approved_additions'] = approvedAdditions;
    }

    return result;
}

// ─── Types ──────────────────────────────────────────────────────

/** Tag group names matching the YAML keys */
export type TagGroupName =
    | 'brand'
    | 'category'
    | 'topic'
    | 'city'
    | 'skill'
    | 'technology'
    | 'format';

/** Priority order for tag cap (01_ContentSpec §2.2.4) */
export const TAG_GROUP_PRIORITY: readonly TagGroupName[] = [
    'brand',
    'category',
    'topic',
    'skill',
    'technology',
    'city',
    'format',
];

export interface TaxonomyConfig {
    version: string;
    tagWhitelist: Map<TagGroupName, Set<string>>;
    flatWhitelist: Set<string>;
    cityTags: Set<string>;
    maxTagsPerPost: number;
    tagArchivePolicy: {
        default: string;
        graduated: string[];
    };
    /** Approved additions: tags to be created via taxonomy_sync_tool. */
    approvedAdditions: ApprovedAddition[];
}

export interface ApprovedAddition {
    slug: string;
    group: string;
}

// ─── Path Resolution ────────────────────────────────────────────

/**
 * Deterministic resolution chain for taxonomy_config.yaml.
 * Works in both dev (ts-node src/) and prod (node dist/) modes.
 *
 * 1. Explicit env var: TAXONOMY_CONFIG_PATH (absolute or repo-relative)
 * 2. Sibling to __dirname (works if yaml is copied into dist/config/)
 * 3. Repo-root fallback: walk up to find package.json, then src/config/
 */
export function resolveTaxonomyConfigPath(): string {
    // 1. Explicit env var
    const envPath = process.env.TAXONOMY_CONFIG_PATH;
    if (envPath) {
        const resolved = path.isAbsolute(envPath)
            ? envPath
            : path.resolve(process.cwd(), envPath);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
        // Env var set but file not found — log and fall through
        logger.warn('TAXONOMY_CONFIG_PATH set but file not found, trying fallbacks', {
            env_path: envPath,
            resolved,
        });
    }

    // 2. Sibling to __dirname (e.g. src/config/ in dev, dist/config/ after copy)
    const siblingPath = path.resolve(__dirname, 'taxonomy_config.yaml');
    if (fs.existsSync(siblingPath)) {
        return siblingPath;
    }

    // 3. Repo-root fallback: walk up from __dirname to find package.json
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
        const candidate = path.join(dir, 'package.json');
        if (fs.existsSync(candidate)) {
            const rootFallback = path.join(dir, 'src', 'config', 'taxonomy_config.yaml');
            if (fs.existsSync(rootFallback)) {
                return rootFallback;
            }
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;  // filesystem root
        dir = parent;
    }

    // Return the sibling path as the canonical "expected" path for the error message
    return siblingPath;
}

let _cached: TaxonomyConfig | null = null;

/**
 * Load and validate taxonomy_config.yaml.
 * Called once per process start; result is cached.
 * @param configPath Optional override for the YAML path.
 */
export function loadTaxonomyConfig(configPath?: string): TaxonomyConfig {
    if (_cached) return _cached;

    const filePath = configPath || resolveTaxonomyConfigPath();
    const exists = fs.existsSync(filePath);

    // ── Startup smoke assertion (no secrets) ──
    logger.info('Taxonomy config resolution', {
        resolved_path: filePath,
        exists,
        source: configPath ? 'explicit_arg' : (process.env.TAXONOMY_CONFIG_PATH ? 'env_var' : 'auto_resolve'),
    });

    if (!exists) {
        throw new Error(
            `taxonomy_config_missing: ${filePath} — pipeline cannot start without tag whitelist. ` +
            `Set TAXONOMY_CONFIG_PATH env var or ensure the file is copied to dist/config/ during build.`
        );
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseSimpleYaml(raw);

    // Validate required fields
    if (!parsed['version']) {
        throw new Error('taxonomy_config_invalid: missing "version" field');
    }
    if (!parsed['tag_whitelist'] || typeof parsed['tag_whitelist'] !== 'object') {
        throw new Error('taxonomy_config_invalid: missing or invalid "tag_whitelist"');
    }
    const maxTags = parsed['max_tags_per_post'];
    if (typeof maxTags !== 'number' || maxTags < 1) {
        throw new Error('taxonomy_config_invalid: missing or invalid "max_tags_per_post"');
    }

    const rawWhitelist = parsed['tag_whitelist'] as Record<string, string[]>;

    // Build typed whitelist
    const tagWhitelist = new Map<TagGroupName, Set<string>>();
    const flatWhitelist = new Set<string>();

    for (const [group, slugs] of Object.entries(rawWhitelist)) {
        if (!Array.isArray(slugs)) {
            throw new Error(`taxonomy_config_invalid: tag_whitelist.${group} must be an array`);
        }
        const normalized = slugs.map((s) => s.trim().toLowerCase());
        tagWhitelist.set(group as TagGroupName, new Set(normalized));
        for (const slug of normalized) {
            flatWhitelist.add(slug);
        }
    }

    // City tags from the config
    const cityTags = tagWhitelist.get('city') || new Set<string>();

    // Archive policy
    const rawArchive = (parsed['tag_archive_policy'] || {}) as Record<string, unknown>;

    // Approved additions
    const rawApproved = parsed['approved_additions'];
    let approvedAdditions: ApprovedAddition[] = [];
    if (Array.isArray(rawApproved)) {
        approvedAdditions = rawApproved
            .filter((item: unknown) => typeof item === 'object' && item !== null)
            .map((item: unknown) => {
                const obj = item as Record<string, string>;
                return {
                    slug: (obj.slug || '').trim().toLowerCase(),
                    group: (obj.group || '').trim().toLowerCase(),
                };
            })
            .filter((a) => a.slug.length > 0 && a.group.length > 0);
    }

    const config: TaxonomyConfig = {
        version: String(parsed['version']),
        tagWhitelist,
        flatWhitelist,
        cityTags,
        maxTagsPerPost: maxTags,
        tagArchivePolicy: {
            default: String(rawArchive['default'] || 'noindex_follow'),
            graduated: Array.isArray(rawArchive['graduated']) ? rawArchive['graduated'] as string[] : [],
        },
        approvedAdditions,
    };

    logger.info('Taxonomy config loaded', {
        version: config.version,
        total_whitelist_tags: config.flatWhitelist.size,
        groups: [...config.tagWhitelist.keys()].join(', '),
        max_tags_per_post: config.maxTagsPerPost,
        approved_additions_count: approvedAdditions.length,
    });

    _cached = config;
    return config;
}

/**
 * Get the tag group a slug belongs to.
 * Used for priority-based cap logic.
 */
export function getTagGroup(slug: string, config: TaxonomyConfig): TagGroupName | null {
    for (const [group, tags] of config.tagWhitelist) {
        if (tags.has(slug)) return group;
    }
    return null;
}

/**
 * Reset cached config (for testing only).
 */
export function _resetTaxonomyConfigCache(): void {
    _cached = null;
}
