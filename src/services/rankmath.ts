/**
 * Rank Math SEO adapter.
 * Ref: 12_WORDPRESS_INTEGRATION §6.6, §6.7
 *
 * Key names are DISCOVERED per environment and stored in config.
 * This service NEVER hardcodes key names — they come from PipelineConfig.rankmath.
 * If keys are empty, discovery has not been performed → fail-closed.
 */

import { logger } from '../logger';
import type { PipelineConfig } from '../config';
import type { WpClient } from './wp-client';

export interface RankMathMeta {
  focus_keyword: string;
  meta_title: string;
  meta_description: string;
  canonical: string;
  robots: string;
  schema_type?: string;
}

export interface RankMathWriteResult {
  ok: boolean;
  method: 'direct_postmeta' | 'update_meta_endpoint';
  error?: string;
}

export class RankMathService {
  private keys: PipelineConfig['rankmath'];

  constructor(
    private config: PipelineConfig,
    private wpClient: WpClient
  ) {
    this.keys = config.rankmath;
  }

  /**
   * Check if Rank Math keys have been discovered for this environment.
   * Fail-closed: if keys are empty, we cannot write metadata.
   */
  isDiscovered(): boolean {
    return !!(
      this.keys.keyTitle &&
      this.keys.keyDescription &&
      this.keys.keyFocusKeyword
    );
  }

  /**
   * Return a redacted diagnostic summary of discovery state.
   * Safe for logs — never exposes actual key values.
   */
  discoveryStatus(): {
    discovered: boolean;
    missing_keys: string[];
    present_keys: string[];
  } {
    const fields: Array<{ label: string; value: string }> = [
      { label: 'keyTitle', value: this.keys.keyTitle },
      { label: 'keyDescription', value: this.keys.keyDescription },
      { label: 'keyFocusKeyword', value: this.keys.keyFocusKeyword },
      { label: 'keyRobots', value: this.keys.keyRobots },
      { label: 'keyCanonical', value: this.keys.keyCanonical },
      { label: 'keySchemaType', value: this.keys.keySchemaType },
    ];

    const missing = fields.filter(f => !f.value).map(f => f.label);
    const present = fields.filter(f => !!f.value).map(f => f.label);

    return {
      discovered: this.isDiscovered(),
      missing_keys: missing,
      present_keys: present,
    };
  }

  /**
   * Build the meta object for a WP REST POST/PUT using discovered keys.
   * §6.6.2: write exactly the discovered keys.
   */
  buildMetaObject(meta: RankMathMeta): Record<string, string> {
    if (!this.isDiscovered()) {
      throw new Error(
        'Rank Math keys not discovered. Run the discovery procedure per §6.6.1 ' +
        'and set RANKMATH_KEY_* environment variables.'
      );
    }

    const result: Record<string, string> = {};

    result[this.keys.keyTitle] = meta.meta_title;
    result[this.keys.keyDescription] = meta.meta_description;
    result[this.keys.keyFocusKeyword] = meta.focus_keyword;

    if (this.keys.keyCanonical && meta.canonical) {
      result[this.keys.keyCanonical] = meta.canonical;
    }
    if (this.keys.keyRobots && meta.robots) {
      result[this.keys.keyRobots] = meta.robots;
    }
    if (this.keys.keySchemaType && meta.schema_type) {
      result[this.keys.keySchemaType] = meta.schema_type;
    }

    return result;
  }

  /**
   * Write Rank Math meta to a post.
   * Method A: Direct postmeta write via WP REST meta object.
   * Method B: Rank Math updateMeta endpoint (if available, falls back to A).
   *
   * Ref: 12_WORDPRESS_INTEGRATION §6.7
   */
  async writeMeta(
    postId: number,
    meta: RankMathMeta
  ): Promise<RankMathWriteResult> {
    if (!this.isDiscovered()) {
      const status = this.discoveryStatus();
      logger.error('Rank Math keys not discovered — cannot write meta', {
        missing_keys: status.missing_keys,
        present_keys: status.present_keys,
        error_category: 'discovery_missing',
        action_required: 'Run discovery procedure per §6.6.1 and set RANKMATH_KEY_* env vars',
      });
      return {
        ok: false,
        method: 'direct_postmeta',
        error: `discovery_missing: keys=[${status.missing_keys.join(',')}]`,
      };
    }

    const metaObj = this.buildMetaObject(meta);

    // Method A: Direct postmeta write
    logger.info('RankMath: writing meta via direct postmeta', { postId });
    try {
      const result = await this.wpClient.updatePost(postId, { meta: metaObj });

      if (!result.ok) {
        // Categorize the failure
        let errorCategory = 'wp_error';
        if (result.status === 401 || result.status === 403) {
          errorCategory = 'auth_error';
        } else if (result.status === 0) {
          errorCategory = 'timeout';
        } else if (result.status >= 400 && result.status < 500) {
          errorCategory = 'malformed_payload';
        }

        logger.error('RankMath: direct postmeta write failed', {
          postId,
          error_category: errorCategory,
          http_status: result.status,
        });
        return {
          ok: false,
          method: 'direct_postmeta',
          error: `${errorCategory}: HTTP ${result.status}`,
        };
      }

      return { ok: true, method: 'direct_postmeta' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('econnreset');
      const errorCategory = isTimeout ? 'timeout' : 'wp_error';
      logger.error('RankMath: write threw exception', {
        postId,
        error_category: errorCategory,
      });
      return {
        ok: false,
        method: 'direct_postmeta',
        error: errorCategory,
      };
    }
  }

  /**
   * Verify Rank Math meta was written correctly.
   * Ref: 12_WORDPRESS_INTEGRATION §6.7 verification
   *
   * Returns true if verification passes, false if it fails.
   * On failure: caller adds reasons[] only — non-blocking enrichment (§6.7).
   */
  async verifyMeta(
    postId: number,
    expected: RankMathMeta
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.isDiscovered()) {
      return { ok: false, reason: 'keys_not_discovered' };
    }

    const getResult = await this.wpClient.getPost(postId);
    if (!getResult.ok || !getResult.data) {
      return { ok: false, reason: 'get_post_failed' };
    }

    const postMeta = (getResult.data.meta || {}) as Record<string, unknown>;
    const expectedObj = this.buildMetaObject(expected);

    for (const [key, expectedVal] of Object.entries(expectedObj)) {
      const actual = postMeta[key];
      if (actual !== expectedVal) {
        logger.warn('RankMath: verification mismatch', { key, expected: expectedVal, actual });
        return { ok: false, reason: 'rankmath_verification_failed' };
      }
    }

    return { ok: true };
  }
}
