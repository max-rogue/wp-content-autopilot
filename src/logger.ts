/**
 * Logger with secret redaction.
 * Ref: 14_SECURITY_PRIVACY §6.2 — Redact passwords, API keys, auth headers.
 *
 * Fail-safe: if redaction itself throws, suppress the raw message entirely.
 */

import winston from 'winston';

type RedactPattern = {
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: any[]) => string);
};

const REDACT_PATTERNS: RedactPattern[] = [
  // OpenAI API keys (sk-...)
  { pattern: /sk-[A-Za-z0-9_-]{10,}/g, replacement: 'sk-***REDACTED***' },
  // Gemini / Google API keys (AIza...)
  { pattern: /AIza[A-Za-z0-9_-]{20,}/g, replacement: 'AIza***REDACTED***' },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: 'Bearer ***REDACTED***' },
  // Basic auth
  { pattern: /Basic\s+[A-Za-z0-9+/=]+/gi, replacement: 'Basic ***REDACTED***' },
  // Application passwords (xxxx-xxxx-xxxx-xxxx pattern)
  { pattern: /[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/g, replacement: '****-****-****-****' },
  // WP Application Passwords (space-separated: xxxx xxxx xxxx xxxx xxxx xxxx)
  { pattern: /\b[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{4}){5}\b/g, replacement: '**** **** **** **** **** ****' },
  // Authorization header values
  { pattern: /authorization["']?\s*:\s*["'][^"']+["']/gi, replacement: 'authorization: "***REDACTED***"' },
  // password field values
  { pattern: /password["']?\s*:\s*["'][^"']+["']/gi, replacement: 'password: "***REDACTED***"' },
  // URL query parameters containing secrets (?token=..., ?key=..., ?api_key=...)
  {
    pattern: /[?&](token|key|api_key|apikey|secret|access_token|password|credential)=[^&\s"']+/gi,
    replacement: (match: string) => {
      const eqIdx = match.indexOf('=');
      return match.slice(0, eqIdx + 1) + '***REDACTED***';
    },
  },
  // Connection strings (postgres://user:pass@..., mysql://user:pass@..., mongodb, redis)
  { pattern: /(postgres|mysql|mongodb|redis|amqp):\/\/[^\s"']+/gi, replacement: '$1://***REDACTED***' },
  // Env var assignment patterns (API_KEY=value, SECRET=value, TOKEN=value, CREDENTIAL=value)
  // Uses word boundary to avoid matching URL parameters like '?token='
  // Stops at &, whitespace, quotes, semicolons
  {
    pattern: /\b(?:API_KEY|SECRET|PASSWORD|CREDENTIAL|APPLICATION_PASSWORD|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)(?:_[A-Z]+)*\s*=\s*[^\s"';&]+/gi,
    replacement: (match: string) => {
      const eqIdx = match.indexOf('=');
      return match.slice(0, eqIdx + 1) + '***REDACTED***';
    },
  },
  // Long hex strings (potential tokens/hashes > 32 chars in sensitive context)
  {
    pattern: /(?:api_key|secret|token|credential|private_key)["']?\s*[=:]\s*["']?[a-f0-9]{32,}["']?/gi,
    replacement: (match: string) => {
      const colonIdx = match.search(/[=:]/);
      return match.slice(0, colonIdx + 1) + ' ***REDACTED***';
    },
  },
  // PEM private keys
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE KEY-----/g, replacement: '-----BEGIN PRIVATE KEY-----***REDACTED***-----END PRIVATE KEY-----' },
  // GitHub/GitLab tokens (ghp_, ghs_, glpat-)
  { pattern: /ghp_[A-Za-z0-9_]{36,}/g, replacement: 'ghp_***REDACTED***' },
  { pattern: /ghs_[A-Za-z0-9_]{36,}/g, replacement: 'ghs_***REDACTED***' },
  { pattern: /glpat-[A-Za-z0-9_-]{20,}/g, replacement: 'glpat-***REDACTED***' },
  // Generic JWT tokens (eyJ...)
  { pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '***JWT_REDACTED***' },
];

/**
 * Redact sensitive values from a string.
 * Fail-safe: if redaction throws, returns a safe placeholder.
 */
export function redact(msg: string): string {
  try {
    let result = msg;
    for (const { pattern, replacement } of REDACT_PATTERNS) {
      if (typeof replacement === 'function') {
        result = result.replace(pattern, replacement as (substring: string, ...args: any[]) => string);
      } else {
        result = result.replace(pattern, replacement);
      }
    }
    return result;
  } catch {
    // Fail-safe: if redaction itself fails, never leak the raw message
    return '[REDACTION_ERROR — message suppressed for safety]';
  }
}

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = redact(info.message);
  }
  // Also redact structured metadata fields
  if (info.metadata && typeof info.metadata === 'object') {
    for (const [key, val] of Object.entries(info.metadata)) {
      if (typeof val === 'string') {
        (info.metadata as Record<string, unknown>)[key] = redact(val);
      }
    }
  }
  return info;
});

export function createLogger(level: string = 'info'): winston.Logger {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      redactFormat(),
      winston.format.timestamp(),
      winston.format.json()
    ),
    transports: [new winston.transports.Console()],
  });
}

export const logger = createLogger(process.env.LOG_LEVEL || 'info');
