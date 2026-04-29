/**
 * Shared 1Password secret resolution utilities.
 * Used by secret-sync and playwright MCP servers.
 *
 * Resolution order (four levels):
 *   L1:   Per-process in-memory cache (instant, no I/O)
 *   L1.5: File-based cross-process cache (AES-256-GCM encrypted at rest)
 *   L2:   Shared MCP daemon cache (one op read per unique ref across all processes)
 *   L3:   Direct op CLI call with rate-limit retry (fallback)
 *
 * OTP/TOTP/MFA references are never cached at any level.
 */

import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { ServicesConfigSchema, type ServicesConfig } from '../secret-sync/types.js';

/** Read OP_SERVICE_ACCOUNT_TOKEN at call time, not module load time.
 *  mcp-launcher.js may set it after this module is first imported. */
function getOpToken(): string | undefined {
  return process.env.OP_SERVICE_ACCOUNT_TOKEN;
}

/** Infrastructure credentials that must NOT leak to child processes */
export const INFRA_CRED_KEYS = new Set([
  'OP_SERVICE_ACCOUNT_TOKEN',
  'RENDER_API_KEY',
  'VERCEL_TOKEN',
  'VERCEL_TEAM_ID',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'FLY_API_TOKEN',
]);

// ============================================================================
// Process-scoped credential cache (TTL 5 min, excludes OTP/TOTP/MFA)
// ============================================================================

const opCache = new Map<string, { value: string; resolvedAt: number }>();
export const OP_CACHE_TTL_MS = 5 * 60 * 1000;

const NO_CACHE_PATTERNS = [
  /one-time.password/i,
  /\/otp$/i,
  /\/totp$/i,
  /\/mfa/i,
];

function isCacheable(reference: string): boolean {
  return !NO_CACHE_PATTERNS.some(p => p.test(reference));
}

// ============================================================================
// L1.5: File-based cross-process cache (AES-256-GCM encrypted at rest)
//
// Prevents 1Password "thundering herd" when 10+ concurrent agent sessions
// each call `op read` for the same ~20 secrets simultaneously.
// ============================================================================

/** Shape of a single entry in the file cache JSON */
interface FileCacheEntry {
  /** AES-256-GCM encrypted value, base64-encoded */
  value: string;
  /** Unix timestamp (ms) when the value was resolved */
  resolvedAt: number;
  /** AES-256-GCM initialization vector, hex-encoded */
  iv: string;
  /** AES-256-GCM auth tag, hex-encoded */
  authTag: string;
}

/** Shape of the entire file cache JSON */
interface FileCacheData {
  [reference: string]: FileCacheEntry;
}

/** Derive a 32-byte encryption key from the OP_SERVICE_ACCOUNT_TOKEN via SHA-256.
 *  Exported for testing. */
export function deriveFileCacheKey(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Encrypt a plaintext value with AES-256-GCM.
 *  Returns { ciphertext, iv, authTag } as base64/hex strings.
 *  Exported for testing. */
export function encryptCacheValue(
  plaintext: string,
  key: Buffer,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/** Decrypt an AES-256-GCM encrypted value.
 *  Throws on failure (tampered data or wrong key).
 *  Exported for testing. */
export function decryptCacheValue(
  ciphertext: string,
  ivHex: string,
  authTagHex: string,
  key: Buffer,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf-8');
}

/** Get the file cache path. Uses CLAUDE_PROJECT_DIR if set, otherwise os.tmpdir(). */
function getFileCachePath(): string {
  const baseDir = process.env.CLAUDE_PROJECT_DIR || tmpdir();
  return join(baseDir, '.claude', 'state', 'op-cache.json');
}

/**
 * Read and parse the file cache.
 * Returns null on any error (file missing, corrupt JSON, etc.).
 * Cache read errors are not fatal — they fall through to op read (G001 note:
 * the cache is a performance optimization, not a security boundary; the
 * authoritative source is always 1Password itself).
 */
function readFileCache(): FileCacheData | null {
  try {
    const cachePath = getFileCachePath();
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as FileCacheData;
  } catch {
    return null;
  }
}

/**
 * Write the file cache atomically (write to .tmp, then rename).
 * Sets 0o600 permissions so only the owner can read/write.
 */
function writeFileCache(data: FileCacheData): void {
  const cachePath = getFileCachePath();
  const cacheDir = join(cachePath, '..');
  const tmpPath = cachePath + '.tmp';
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmpPath, cachePath);
    // Ensure permissions on the final file
    chmodSync(cachePath, 0o600);
  } catch {
    // Cache write failure is not fatal — the value was already resolved
    // successfully. Next process will just re-resolve from 1Password.
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort tmp cleanup */
    }
  }
}

/**
 * Try to read a value from the file cache.
 * Returns the decrypted value if found and valid, null otherwise.
 */
function readFromFileCache(reference: string, key: Buffer): string | null {
  const cache = readFileCache();
  if (!cache) return null;

  const entry = cache[reference];
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.resolvedAt >= OP_CACHE_TTL_MS) {
    return null;
  }

  // Decrypt
  try {
    return decryptCacheValue(entry.value, entry.iv, entry.authTag, key);
  } catch {
    // Decryption failed — token changed or data corrupted. Treat as cache miss.
    // Remove the stale entry so it doesn't keep failing.
    try {
      delete cache[reference];
      writeFileCache(cache);
    } catch {
      /* best-effort cleanup */
    }
    return null;
  }
}

/**
 * Write a value to the file cache (encrypted with AES-256-GCM).
 * Also prunes expired entries opportunistically.
 */
function writeToFileCache(
  reference: string,
  value: string,
  key: Buffer,
): void {
  const cache = readFileCache() || {};

  const { ciphertext, iv, authTag } = encryptCacheValue(value, key);
  cache[reference] = {
    value: ciphertext,
    resolvedAt: Date.now(),
    iv,
    authTag,
  };

  // Prune expired entries while we're writing
  const now = Date.now();
  for (const ref of Object.keys(cache)) {
    if (now - cache[ref].resolvedAt >= OP_CACHE_TTL_MS) {
      delete cache[ref];
    }
  }

  writeFileCache(cache);
}

/** Clear the file-based cross-process cache. */
export function clearFileCache(): void {
  try {
    const cachePath = getFileCachePath();
    if (existsSync(cachePath)) {
      unlinkSync(cachePath);
    }
  } catch {
    // Re-check: if the file still exists after a failed unlink, that's a real
    // error we must surface (G001 fail-closed). But if it was already deleted
    // by another process between our check and unlink, that's fine.
    try {
      if (existsSync(getFileCachePath())) {
        throw new Error(
          `Failed to clear file cache at ${getFileCachePath()}`,
        );
      }
    } catch (innerErr) {
      if (
        innerErr instanceof Error &&
        innerErr.message.startsWith('Failed to clear')
      ) {
        throw innerErr;
      }
      // existsSync itself failed — file system issue, but cache is effectively gone
    }
  }
}

/** Clear both in-memory and file-based credential caches. */
export function clearOpCache(): void {
  opCache.clear();
  clearFileCache();
}

/** Get cache statistics for observability and debugging. */
export function getOpCacheStats(): {
  memorySize: number;
  fileCacheExists: boolean;
  fileCacheEntries: number;
} {
  let fileCacheExists = false;
  let fileCacheEntries = 0;
  try {
    const cachePath = getFileCachePath();
    fileCacheExists = existsSync(cachePath);
    if (fileCacheExists) {
      const cache = readFileCache();
      if (cache) {
        fileCacheEntries = Object.keys(cache).length;
      }
    }
  } catch {
    // Stats are best-effort observability — don't throw
  }
  return { memorySize: opCache.size, fileCacheExists, fileCacheEntries };
}

// ============================================================================
// Rate limit detection and synchronous retry helpers
// ============================================================================

/** Detect 1Password CLI rate limit errors from error messages */
function isRateLimitError(errorMessage: string): boolean {
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('too many requests') ||
    lower.includes('429') ||
    lower.includes('rate limit')
  );
}

/** Synchronous sleep using Atomics.wait — the standard pattern for sync delays in Node.js */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Maximum number of retries on rate limit */
const RATE_LIMIT_MAX_RETRIES = 3;
/** Base delay in ms for exponential backoff */
const RATE_LIMIT_BASE_DELAY_MS = 1000;
/** Maximum delay cap in ms */
const RATE_LIMIT_MAX_DELAY_MS = 10000;

// ============================================================================
// L2: Shared daemon cache (cross-process, HTTP)
// ============================================================================

const DAEMON_URL = `http://127.0.0.1:${process.env.MCP_DAEMON_PORT || '18090'}`;

/**
 * Try to resolve a secret via the shared MCP daemon cache.
 * Returns the value on success, null if daemon is unavailable or ref not resolved.
 */
function tryDaemonResolve(reference: string): string | null {
  // Don't call daemon from within the daemon itself
  if (process.env.MCP_SHARED_DAEMON === '1') return null;

  const token = getOpToken();
  if (!token) return null;

  try {
    const body = JSON.stringify({ refs: [reference] });
    const result = execFileSync(
      'curl',
      [
        '-sf',
        '--max-time',
        '2',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-H',
        `Authorization: Bearer ${token}`,
        '-d',
        body,
        `${DAEMON_URL}/secrets/resolve`,
      ],
      { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(result);
    return parsed.resolved?.[reference] ?? null;
  } catch {
    return null;
  }
}

/**
 * Try to resolve multiple secrets in a single daemon request.
 * Returns a map of ref->value for successfully resolved refs, null if daemon unavailable.
 */
function tryDaemonResolveBatch(references: string[]): Record<string, string> | null {
  if (process.env.MCP_SHARED_DAEMON === '1') return null;

  const token = getOpToken();
  if (!token) return null;
  if (references.length === 0) return {};

  try {
    const body = JSON.stringify({ refs: references });
    const result = execFileSync(
      'curl',
      [
        '-sf',
        '--max-time',
        '10',
        '-X',
        'POST',
        '-H',
        'Content-Type: application/json',
        '-H',
        `Authorization: Bearer ${token}`,
        '-d',
        body,
        `${DAEMON_URL}/secrets/resolve`,
      ],
      { encoding: 'utf-8', timeout: 12000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(result);
    return parsed.resolved ?? null;
  } catch {
    return null;
  }
}

/**
 * Read a secret from 1Password (value stays in-process, never returned to agent).
 *
 * Four-level resolution:
 *   L1:   Per-process in-memory cache (instant, no I/O)
 *   L1.5: File-based cross-process cache (AES-256-GCM encrypted at rest)
 *   L2:   Shared MCP daemon cache (one op read per unique ref across all processes)
 *   L3:   Direct op CLI call with rate-limit retry (fallback)
 *
 * OTP/TOTP/MFA references are never cached at any level.
 */
export function opRead(
  reference: string,
  opts?: { skipCache?: boolean },
): string {
  const cacheable = isCacheable(reference);
  const useCache = !opts?.skipCache && cacheable;

  // L1: Per-process in-memory cache
  if (useCache) {
    const cached = opCache.get(reference);
    if (cached && Date.now() - cached.resolvedAt < OP_CACHE_TTL_MS) {
      return cached.value;
    }
  }

  // L1.5: File-based cross-process cache (encrypted at rest, G017)
  if (useCache) {
    const token = getOpToken();
    if (token) {
      const fileCacheKey = deriveFileCacheKey(token);
      const fileCacheValue = readFromFileCache(reference, fileCacheKey);
      if (fileCacheValue !== null) {
        // Populate L1 so subsequent calls in this process are instant
        opCache.set(reference, {
          value: fileCacheValue,
          resolvedAt: Date.now(),
        });
        return fileCacheValue;
      }
    }
  }

  // L2: Shared daemon cache
  if (!opts?.skipCache) {
    const daemonResult = tryDaemonResolve(reference);
    if (daemonResult !== null) {
      if (cacheable) {
        opCache.set(reference, {
          value: daemonResult,
          resolvedAt: Date.now(),
        });
        // Also write to file cache so other processes benefit
        const token = getOpToken();
        if (token) {
          writeToFileCache(reference, daemonResult, deriveFileCacheKey(token));
        }
      }
      return daemonResult;
    }
  }

  // L3: Direct op read with rate-limit retry (fallback)
  const token = getOpToken();
  if (!token) {
    throw new Error('OP_SERVICE_ACCOUNT_TOKEN not set');
  }

  const opEnv = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token };
  const opOpts = { encoding: 'utf-8' as const, timeout: 15000, env: opEnv };

  try {
    const value = execFileSync('op', ['read', reference], opOpts).trim();
    if (cacheable) {
      opCache.set(reference, { value, resolvedAt: Date.now() });
      writeToFileCache(reference, value, deriveFileCacheKey(token));
    }
    return value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Rate limit retry with exponential backoff + jitter
    if (isRateLimitError(message)) {
      for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
        const delay = Math.min(
          RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt) +
            Math.random() * 1000,
          RATE_LIMIT_MAX_DELAY_MS,
        );
        sleepSync(Math.round(delay));
        try {
          const value = execFileSync(
            'op',
            ['read', reference],
            opOpts,
          ).trim();
          // Success on retry — cache it
          if (cacheable) {
            opCache.set(reference, { value, resolvedAt: Date.now() });
            writeToFileCache(reference, value, deriveFileCacheKey(token));
          }
          return value;
        } catch (retryErr) {
          const retryMessage =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          if (
            attempt === RATE_LIMIT_MAX_RETRIES ||
            !isRateLimitError(retryMessage)
          ) {
            throw new Error(
              `Failed to read ${reference} after ${attempt + 1} attempts: ${retryMessage}`,
            );
          }
          // Continue retrying
        }
      }
    }

    throw new Error(`Failed to read ${reference}: ${message}`);
  }
}

/**
 * Load and validate services.json from the project directory.
 */
export function loadServicesConfig(projectDir: string): ServicesConfig {
  const configPath = join(projectDir, '.claude/config/services.json');
  try {
    const configData = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(configData) as unknown;
    const result = ServicesConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new Error(`Invalid services.json: ${result.error.message}`);
    }

    return result.data;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      // ELOOP = circular or excessively deep symlinks in .claude/config path
      let diagnostic = '';
      try {
        const configDir = join(projectDir, '.claude/config');
        const stat = lstatSync(configDir);
        if (stat.isSymbolicLink()) {
          const target = readlinkSync(configDir);
          diagnostic = ` .claude/config is a symlink -> ${target}.`;
          if (target === configDir || target.endsWith('/.claude/config')) {
            diagnostic +=
              ' If running in a worktree, this symlink should point to the MAIN tree config (not itself).';
          }
        }
      } catch {
        /* diagnostic is best-effort */
      }
      throw new Error(
        `Failed to load services.json: ELOOP (too many symbolic links) at ${configPath}.${diagnostic} Verify .claude/config in the main tree is a real directory, not a symlink.`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load services.json: ${message}`);
  }
}

/**
 * Resolve local secrets from 1Password — values stay in MCP server memory.
 * Returns env vars ready to inject into child process, plus any failed keys.
 */
export function resolveLocalSecrets(config: ServicesConfig): {
  resolvedEnv: Record<string, string>;
  failedKeys: string[];
  failureDetails: Record<string, string>;
} {
  const resolvedEnv: Record<string, string> = {};
  const failedKeys: string[] = [];
  const failureDetails: Record<string, string> = {};
  const localSecrets = config.secrets.local || {};
  const entries = Object.entries(localSecrets);

  if (entries.length === 0) {
    return { resolvedEnv, failedKeys, failureDetails };
  }

  const opRefs = entries
    .filter(([, ref]) => ref.startsWith('op://'))
    .map(([, ref]) => ref);

  const batchResult = opRefs.length > 0 ? tryDaemonResolveBatch(opRefs) : null;

  for (const [key, ref] of entries) {
    try {
      if (batchResult && ref in batchResult) {
        resolvedEnv[key] = batchResult[ref];
        if (isCacheable(ref)) {
          opCache.set(ref, { value: batchResult[ref], resolvedAt: Date.now() });
        }
        const token = getOpToken();
        if (token && isCacheable(ref)) {
          writeToFileCache(ref, batchResult[ref], deriveFileCacheKey(token));
        }
        continue;
      }
      resolvedEnv[key] = opRead(ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[op-secrets] resolveLocalSecrets: failed to resolve ${key}: ${message}\n`,
      );
      failedKeys.push(key);
      failureDetails[key] = message;
    }
  }

  return { resolvedEnv, failedKeys, failureDetails };
}

/**
 * Resolve any op:// references in an env var map.
 * Values starting with "op://" are resolved via opRead(); others are left as-is.
 * Failed resolutions are removed from the map and logged to stderr.
 */
export function resolveOpReferences(
  envVars: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string' && value.startsWith('op://')) {
      try {
        resolved[key] = opRead(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[op-secrets] resolveOpReferences: failed to resolve ${key}: ${message}\n`,
        );
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Strict variant of resolveOpReferences — returns failed keys instead of silently dropping them.
 * Callers can decide whether to abort or continue with partial results.
 */
export function resolveOpReferencesStrict(envVars: Record<string, string>): {
  resolved: Record<string, string>;
  failedKeys: string[];
  failureDetails: Record<string, string>;
} {
  const resolved: Record<string, string> = {};
  const failedKeys: string[] = [];
  const failureDetails: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars)) {
    if (typeof value === 'string' && value.startsWith('op://')) {
      try {
        resolved[key] = opRead(value);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[op-secrets] resolveOpReferencesStrict: failed to resolve ${key}: ${message}\n`,
        );
        failedKeys.push(key);
        failureDetails[key] = message;
      }
    } else {
      resolved[key] = value;
    }
  }
  return { resolved, failedKeys, failureDetails };
}

/**
 * Build a clean child environment from process.env:
 * - Strips INFRA_CRED_KEYS
 * - Merges in optional extra secrets
 */
export function buildCleanEnv(
  extraSecrets?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !INFRA_CRED_KEYS.has(k)) env[k] = v;
  }
  if (extraSecrets) {
    Object.assign(env, extraSecrets);
  }
  return env;
}
