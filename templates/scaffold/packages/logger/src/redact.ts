/**
 * Sensitive data redaction for structured logging.
 *
 * Automatically redacts values for keys matching common credential patterns.
 * Operates on shallow object properties — does not recursively walk nested objects
 * (to avoid performance issues with large data payloads).
 */

const SENSITIVE_KEYS = new Set([
  'password', 'secret', 'token', 'key', 'credential',
  'authorization', 'cookie', 'apikey', 'api_key',
  'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
  'privatekey', 'private_key', 'bearer',
]);

const REDACTED = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function looksLikeSecret(value: string): boolean {
  // JWT pattern
  if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/.test(value)) return true;
  // Common API key prefixes
  if (/^(sk-|pk-|ghp_|gho_|ghs_|ghr_|glpat-|xoxb-|xoxp-)/.test(value)) return true;
  // Long base64-like strings (likely tokens)
  if (value.length > 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return true;
  return false;
}

/**
 * Redact sensitive fields from a context object.
 * Returns a new object with sensitive values replaced by [REDACTED].
 */
export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
    } else if (typeof value === 'string' && looksLikeSecret(value)) {
      result[key] = REDACTED;
    } else {
      result[key] = value;
    }
  }
  return result;
}
