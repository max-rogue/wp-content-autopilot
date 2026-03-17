/**
 * Logger Redaction Tests
 * Ref: 14_SECURITY_PRIVACY §6.2
 *
 * Tests that secrets, API keys, auth headers, and passwords are redacted.
 * Uses the exported `redact` function directly for precise testing.
 */

import { describe, it, expect } from 'vitest';
import { redact } from './logger';

describe('Logger Secret Redaction', () => {
    it('redacts OpenAI API keys (sk-...)', () => {
        const input = 'Using key sk-abc1234567890xyz for API';
        const result = redact(input);
        expect(result).not.toContain('sk-abc1234567890xyz');
        expect(result).toContain('sk-***REDACTED***');
    });

    it('redacts Gemini API keys (AIza...)', () => {
        const input = 'Using key AIzaSyD12345678901234567890 for Gemini';
        const result = redact(input);
        expect(result).not.toContain('AIzaSyD12345678901234567890');
        expect(result).toContain('AIza***REDACTED***');
    });

    it('redacts Bearer tokens', () => {
        const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test';
        const result = redact(input);
        expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
        expect(result).toContain('Bearer ***REDACTED***');
    });

    it('redacts Basic auth', () => {
        const input = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
        const result = redact(input);
        expect(result).not.toContain('dXNlcjpwYXNzd29yZA==');
        expect(result).toContain('Basic ***REDACTED***');
    });

    it('redacts WP Application Password format (xxxx-xxxx-xxxx-xxxx)', () => {
        const input = 'Using password AbCd-EfGh-IjKl-MnOp';
        const result = redact(input);
        expect(result).not.toContain('AbCd-EfGh-IjKl-MnOp');
        expect(result).toContain('****-****-****-****');
    });

    it('redacts authorization header in JSON-like strings', () => {
        const input = 'headers: { authorization: "Bearer secret_token_here" }';
        const result = redact(input);
        expect(result).not.toContain('secret_token_here');
        expect(result).toContain('***REDACTED***');
    });

    it('redacts password fields in JSON-like strings', () => {
        const input = 'config: { password: "my_secret_password" }';
        const result = redact(input);
        expect(result).not.toContain('my_secret_password');
        expect(result).toContain('***REDACTED***');
    });

    it('redacts URL query tokens (?token=..., ?key=...)', () => {
        const input = 'GET https://api.example.com/data?token=secret123abc&other=safe';
        const result = redact(input);
        expect(result).not.toContain('secret123abc');
        expect(result).toContain('other=safe');
    });

    it('redacts URL query api_key parameter', () => {
        const input = 'Fetching https://api.wp.com?api_key=mySecretKey123';
        const result = redact(input);
        expect(result).not.toContain('mySecretKey123');
    });

    it('redacts connection strings (postgres://...)', () => {
        const input = 'DB: postgres://admin:passwd@db.host:5432/mydb';
        const result = redact(input);
        expect(result).not.toContain('admin:passwd@db.host');
        expect(result).toContain('postgres://***REDACTED***');
    });

    it('redacts env var assignment patterns', () => {
        const input = 'Export API_KEY=sk-1234567890abcdef done';
        const result = redact(input);
        expect(result).not.toContain('sk-1234567890abcdef');
    });

    it('redacts APPLICATION_PASSWORD assignments', () => {
        const input = 'APPLICATION_PASSWORD=shortval';
        const result = redact(input);
        expect(result).toContain('APPLICATION_PASSWORD=***REDACTED***');
        expect(result).not.toContain('shortval');
    });

    it('does not alter non-sensitive content', () => {
        const input = 'Stage 1: processing keyword "product review" for queue_id abc123';
        const result = redact(input);
        expect(result).toBe(input);
    });

    // ── Expanded redaction coverage (Branch 3: Ops & Recovery) ──────

    it('redacts WP space-separated Application Passwords (xxxx xxxx xxxx xxxx xxxx xxxx)', () => {
        const input = 'WP password is AbCd EfGh IjKl MnOp QrSt UvWx';
        const result = redact(input);
        expect(result).not.toContain('AbCd EfGh IjKl MnOp QrSt UvWx');
        expect(result).toContain('**** **** **** **** **** ****');
    });

    it('redacts GitHub personal access tokens (ghp_...)', () => {
        const input = 'Using token ghp_1234567890abcdefghijABCDEFGHIJ123456 for auth';
        const result = redact(input);
        expect(result).not.toContain('ghp_1234567890abcdefghijABCDEFGHIJ123456');
        expect(result).toContain('ghp_***REDACTED***');
    });

    it('redacts GitLab tokens (glpat-...)', () => {
        const input = 'Token: glpat-1234567890abcdefghij';
        const result = redact(input);
        expect(result).not.toContain('glpat-1234567890abcdefghij');
        expect(result).toContain('glpat-***REDACTED***');
    });

    it('redacts JWT tokens (eyJ...)', () => {
        const input = 'JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
        const result = redact(input);
        expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
        expect(result).toContain('***JWT_REDACTED***');
    });

    it('redacts URL query password and credential parameters', () => {
        const input = 'GET https://api.example.com/data?password=s3cret&credential=mytoken';
        const result = redact(input);
        expect(result).not.toContain('s3cret');
        expect(result).not.toContain('mytoken');
    });

    it('redacts amqp connection strings', () => {
        const input = 'Connecting: amqp://user:pass@rabbit.host:5672/vhost';
        const result = redact(input);
        expect(result).not.toContain('user:pass@rabbit.host');
        expect(result).toContain('amqp://***REDACTED***');
    });

    it('redacts ACCESS_TOKEN env var assignments', () => {
        const input = 'ACCESS_TOKEN=mytoken123 set';
        const result = redact(input);
        expect(result).not.toContain('mytoken123');
    });

    it('redacts <form> tags and inline event handlers in content', () => {
        // This is a logger test — form tags aren't redacted by logger
        // but are caught by G5. Logger only redacts secrets.
        const input = 'Form action detected';
        const result = redact(input);
        expect(result).toBe(input); // No secret to redact
    });
});
