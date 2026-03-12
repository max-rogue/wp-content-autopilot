/**
 * Type Contract Tests
 * Ref: 13_CONTENT_OPS_PIPELINE §6.2, §6.3.8
 *
 * Validates that type contracts match spec:
 * - schema_version is "1.0"
 * - Status enum has exactly the required values
 * - Gate IDs are exactly G1-G8
 */

import { describe, it, expect } from 'vitest';
import {
    SCHEMA_VERSION,
    QUEUE_STATUSES,
    GATE_IDS,
    similarityBand,
} from './types';

describe('Type Contracts', () => {
    it('SCHEMA_VERSION is exactly "1.0"', () => {
        expect(SCHEMA_VERSION).toBe('1.0');
    });

    it('QUEUE_STATUSES contains exactly the required values', () => {
        expect(QUEUE_STATUSES).toEqual([
            'planned',
            'researching',
            'drafting',
            'qa',
            'draft_wp',
            'published',
            'hold',
            'failed',
        ]);
    });

    it('QUEUE_STATUSES has exactly 8 entries', () => {
        expect(QUEUE_STATUSES).toHaveLength(8);
    });

    it('GATE_IDS contains exactly G1-G8', () => {
        expect(GATE_IDS).toEqual([
            'G1_KEYWORD_DEDUP',
            'G2_SIMILARITY',
            'G3_LOCAL_DOORWAY',
            'G4_FACT_CLASS',
            'G5_TEMPLATE',
            'G6_TONE',
            'G7_IMAGE',
            'G8_SEO_META',
        ]);
    });

    it('GATE_IDS has exactly 8 entries', () => {
        expect(GATE_IDS).toHaveLength(8);
    });

    it('similarityBand uses hardcoded thresholds (not from env)', () => {
        // These thresholds are hardcoded per PIPELINE-CONTRACTS
        // Test boundary values
        expect(similarityBand(0.80)).toBe('HOLD');
        expect(similarityBand(0.799999)).toBe('DRAFT');
        expect(similarityBand(0.70)).toBe('DRAFT');
        expect(similarityBand(0.699999)).toBe('PASS');
        expect(similarityBand(0.0)).toBe('PASS');
        expect(similarityBand(1.0)).toBe('HOLD');
    });
});
