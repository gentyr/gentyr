#!/usr/bin/env node
/**
 * Shared MCP Server Daemon
 *
 * Hosts Tier 1 (stateless/read-only) MCP servers in a single process
 * with HTTP transport, eliminating per-session process overhead.
 *
 * A single daemon process replaces ~15 per-session stdio processes,
 * saving ~750MB RAM per concurrent agent.
 *
 * Two-phase startup: HTTP server binds immediately (health endpoint
 * responds with status:'starting'), then credentials resolve in
 * parallel and server modules load (status:'ok').
 *
 * Usage: node scripts/mcp-server-daemon.js
 *
 * Environment:
 *   CLAUDE_PROJECT_DIR       - Project directory (required)
 *   MCP_DAEMON_PORT          - Port to listen on (default: 18090)
 *   OP_SERVICE_ACCOUNT_TOKEN - 1Password token (optional)
 *   GENTYR_LAUNCHD_SERVICE   - Set to 'true' in headless launchd context
 *
 * @version 2.0.0
 */

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.MCP_DAEMON_PORT || '18090', 10);
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

if (!PROJECT_DIR) {
  process.stderr.write('[mcp-daemon] FATAL: CLAUDE_PROJECT_DIR is required\n');
  process.exit(1);
}

// Enforce CWD — launchd WorkingDirectory is unreliable
try { process.chdir(PROJECT_DIR); } catch (err) {
  process.stderr.write(`[mcp-daemon] FATAL: Cannot chdir to ${PROJECT_DIR}: ${err.message}\n`);
  process.exit(1);
}

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'mcp-daemon.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* non-fatal */ }
}

// Set flag before importing any server modules so they skip stdio transport
process.env.MCP_SHARED_DAEMON = '1';

import { TIER1_SERVERS } from '../lib/shared-mcp-config.js';

const DIST_DIR = path.join(__dirname, '..', 'packages', 'mcp-servers', 'dist');
const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
const stateFile = path.join(stateDir, 'shared-mcp-daemon.json');

// ---------------------------------------------------------------------------
// Phase 1: Start HTTP Server immediately (responds with status:'starting')
// ---------------------------------------------------------------------------

const servers = new Map();
let daemonReady = false;

const { startSharedHttpServer } = await import(
  path.join(DIST_DIR, 'shared', 'http-transport.js')
);

// ---------------------------------------------------------------------------
// Shared Secrets Cache + Audit Logging
// ---------------------------------------------------------------------------

const secretsCache = new Map(); // ref → { value, resolvedAt, hits }
const SECRETS_CACHE_TTL_MS = 5 * 60 * 1000;
const NO_CACHE_PATTERNS = [/one-time.password/i, /\/otp$/i, /\/totp$/i, /\/mfa/i];
const inflightRequests = new Map();

function isSecretCacheable(ref) {
  return !NO_CACHE_PATTERNS.some(p => p.test(ref));
}

const auditStats = {
  hits: 0, misses: 0, errors: 0,
  uniqueRefs: new Set(),
  lastFlush: Date.now(),
};

const AUDIT_FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const AUDIT_FILE = path.join(stateDir, 'op-cache-audit.jsonl');

function flushAuditStats() {
  const now = Date.now();
  const total = auditStats.hits + auditStats.misses;
  const hitRate = total > 0 ? ((auditStats.hits / total) * 100).toFixed(1) + '%' : 'n/a';
  const entry = {
    ts: new Date().toISOString(),
    hits: auditStats.hits,
    misses: auditStats.misses,
    errors: auditStats.errors,
    uniqueRefs: auditStats.uniqueRefs.size,
    hitRate,
    period: Math.round((now - auditStats.lastFlush) / 1000) + 's',
  };
  if (total > 0) {
    log(`[op-cache] ${entry.period} stats: ${entry.hits} hits, ${entry.misses} misses, ${entry.errors} errors (${hitRate} hit rate, ${entry.uniqueRefs} unique refs)`);
    try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n'); } catch { /* non-fatal */ }
  }
  auditStats.hits = 0;
  auditStats.misses = 0;
  auditStats.errors = 0;
  auditStats.uniqueRefs.clear();
  auditStats.lastFlush = now;
}

const auditFlushTimer = setInterval(flushAuditStats, AUDIT_FLUSH_INTERVAL_MS);
auditFlushTimer.unref();

async function resolveSecretRef(ref) {
  auditStats.uniqueRefs.add(ref);

  if (isSecretCacheable(ref)) {
    const cached = secretsCache.get(ref);
    if (cached && Date.now() - cached.resolvedAt < SECRETS_CACHE_TTL_MS) {
      cached.hits++;
      auditStats.hits++;
      return { value: cached.value, fromCache: true };
    }
  }

  const inflight = inflightRequests.get(ref);
  if (inflight) {
    auditStats.hits++;
    return inflight;
  }

  auditStats.misses++;
  const promise = (async () => {
    try {
      const { stdout } = await execFileAsync('op', ['read', ref], {
        encoding: 'utf-8',
        timeout: 15000,
        env: process.env,
      });
      const value = stdout.trim();
      if (isSecretCacheable(ref)) {
        secretsCache.set(ref, { value, resolvedAt: Date.now(), hits: 0 });
      }
      return { value, fromCache: false };
    } catch (err) {
      auditStats.errors++;
      return { error: err.message || String(err) };
    } finally {
      inflightRequests.delete(ref);
    }
  })();

  inflightRequests.set(ref, promise);
  return promise;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function writeJsonDaemon(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function handleSecretsRequest(req, res) {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // GET /secrets/stats — audit stats
  if (url === '/secrets/stats' && method === 'GET') {
    const total = auditStats.hits + auditStats.misses;
    const hitRate = total > 0 ? ((auditStats.hits / total) * 100).toFixed(1) + '%' : 'n/a';
    const topRefs = [...secretsCache.entries()]
      .map(([ref, entry]) => ({ ref: ref.replace(/op:\/\/[^/]+\//, 'op://****/'), hits: entry.hits, lastAccess: new Date(entry.resolvedAt).toISOString() }))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 10);
    writeJsonDaemon(res, 200, {
      entries: secretsCache.size,
      inflight: inflightRequests.size,
      hits: auditStats.hits,
      misses: auditStats.misses,
      errors: auditStats.errors,
      hitRate,
      topRefs,
      periodStart: new Date(auditStats.lastFlush).toISOString(),
    });
    return true;
  }

  // POST /secrets/flush — clear the secrets cache
  if (url === '/secrets/flush' && method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const expectedToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    if (!expectedToken || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== expectedToken) {
      writeJsonDaemon(res, 401, { error: 'Unauthorized' });
      return true;
    }
    const flushed = secretsCache.size;
    secretsCache.clear();
    log(`[op-cache] Cache flushed: ${flushed} entries cleared`);
    writeJsonDaemon(res, 200, { flushed });
    return true;
  }

  // POST /secrets/resolve — resolve op:// refs via shared cache
  if (url === '/secrets/resolve' && method === 'POST') {
    // Auth check: require OP_SERVICE_ACCOUNT_TOKEN as bearer
    const authHeader = req.headers['authorization'] || '';
    const expectedToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    if (!expectedToken || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== expectedToken) {
      writeJsonDaemon(res, 401, { error: 'Unauthorized' });
      return true;
    }

    readJsonBody(req).then(async (body) => {
      const refs = body.refs;
      if (!Array.isArray(refs) || refs.length === 0) {
        writeJsonDaemon(res, 400, { error: 'refs must be a non-empty array' });
        return;
      }
      if (refs.length > 50) {
        writeJsonDaemon(res, 400, { error: 'Max 50 refs per request' });
        return;
      }

      const resolved = {};
      const failed = [];
      let cacheHits = 0;
      let cacheMisses = 0;

      // Resolve all refs (parallel for cache misses)
      const results = await Promise.allSettled(refs.map(ref => resolveSecretRef(ref)));

      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const result = results[i];
        if (result.status === 'fulfilled' && result.value.value !== undefined) {
          resolved[ref] = result.value.value;
          if (result.value.fromCache) cacheHits++;
          else cacheMisses++;
        } else {
          const errMsg = result.status === 'rejected' ? result.reason?.message : result.value?.error;
          failed.push(ref);
          log(`[op-cache] Failed to resolve ${ref}: ${errMsg || 'unknown'}`);
        }
      }

      writeJsonDaemon(res, 200, { resolved, failed, cache_hits: cacheHits, cache_misses: cacheMisses });
    }).catch(err => {
      writeJsonDaemon(res, 400, { error: 'Invalid JSON body: ' + (err.message || '') });
    });

    return true;
  }

  return false;
}

const { httpServer, close } = startSharedHttpServer({
  port: PORT,
  servers,
  isReady: () => daemonReady,
  onRequest: handleSecretsRequest,
});

log(`HTTP server listening on port ${PORT} (status: starting)`);

// ---------------------------------------------------------------------------
// Phase 2: Resolve credentials in parallel, then load server modules
// ---------------------------------------------------------------------------

async function resolveAllCredentials() {
  const mappingsPath = path.join(PROJECT_DIR, '.claude', 'vault-mappings.json');
  const actionsPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');

  let mappings = {};
  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    mappings = data.mappings || {};
  } catch (err) {
    log(`No vault mappings (${err.message || 'file not found'}) — starting without credentials`);
  }

  let actions = {};
  try {
    actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
  } catch (err) {
    log(`No protected-actions config (${err.message || 'file not found'}) — no credential keys known`);
  }

  // Collect all unique credential keys needed by Tier 1 servers
  const allKeys = new Set();
  for (const serverName of TIER1_SERVERS) {
    const keys = actions.servers?.[serverName]?.credentialKeys || [];
    for (const k of keys) { allKeys.add(k); }
  }

  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  // Separate direct values (sync) from op:// refs (async parallel)
  const opReads = [];

  for (const key of allKeys) {
    if (process.env[key]) {
      skipped++;
      continue;
    }

    const ref = mappings[key];
    if (!ref) { continue; }

    if (ref.startsWith('op://')) {
      if (process.env.GENTYR_LAUNCHD_SERVICE === 'true' && !process.env.OP_SERVICE_ACCOUNT_TOKEN) {
        log(`Skipping ${key}: headless automation, no OP_SERVICE_ACCOUNT_TOKEN`);
        continue;
      }
      opReads.push({ key, ref });
    } else {
      // Direct value (non-secret identifier like URL, zone ID)
      process.env[key] = ref;
      resolved++;
    }
  }

  // Resolve all op:// references in parallel
  const failedRefs = [];
  if (opReads.length > 0) {
    const startTime = Date.now();
    const results = await Promise.allSettled(
      opReads.map(({ key, ref }) =>
        execFileAsync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          env: process.env,
        }).then(({ stdout }) => ({ key, value: stdout.trim() }))
      )
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value.value) {
        process.env[result.value.key] = result.value.value;
        resolved++;
      } else {
        const reason = result.status === 'rejected' ? result.reason?.message : 'empty value';
        log(`Failed to resolve ${opReads[i].key}: ${reason || 'unknown error'}`);
        failedRefs.push(opReads[i]);
        failed++;
      }
    }

    log(`Parallel op:// resolution: ${opReads.length} refs in ${Date.now() - startTime}ms`);
  }

  log(`Credentials: resolved=${resolved} skipped(from-env)=${skipped} failed=${failed} total=${allKeys.size}`);
  return failedRefs;
}

const failedStartupRefs = await resolveAllCredentials();

// ---------------------------------------------------------------------------
// Phase 2b: Retry failed credentials with exponential backoff
// ---------------------------------------------------------------------------

if (failedStartupRefs.length > 0) {
  const MAX_RETRIES = 5;
  const BACKOFF_DELAYS = [30_000, 60_000, 120_000, 240_000, 300_000]; // 30s, 1m, 2m, 4m, 5m
  let pending = [...failedStartupRefs];

  (async () => {
    for (let attempt = 1; attempt <= MAX_RETRIES && pending.length > 0; attempt++) {
      const delay = BACKOFF_DELAYS[attempt - 1];
      log(`[op-retry] ${pending.length} failed ref(s) — retry ${attempt}/${MAX_RETRIES} in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));

      const results = await Promise.allSettled(
        pending.map(({ key, ref }) =>
          execFileAsync('op', ['read', ref], {
            encoding: 'utf-8',
            timeout: 15000,
            env: process.env,
          }).then(({ stdout }) => ({ key, value: stdout.trim() }))
        )
      );

      const stillFailed = [];
      for (let i = 0; i < pending.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value.value) {
          process.env[result.value.key] = result.value.value;
          // Also populate the shared secrets cache so Tier 2 servers benefit
          const ref = pending[i].ref;
          if (isSecretCacheable(ref)) {
            secretsCache.set(ref, { value: result.value.value, resolvedAt: Date.now(), hits: 0 });
          }
          log(`[op-retry] Resolved ${pending[i].key} on attempt ${attempt}`);
        } else {
          const reason = result.status === 'rejected' ? result.reason?.message : 'empty value';
          log(`[op-retry] Still failed ${pending[i].key} (attempt ${attempt}): ${reason || 'unknown'}`);
          stillFailed.push(pending[i]);
        }
      }

      pending = stillFailed;
      if (pending.length === 0) {
        log(`[op-retry] All startup failures resolved after ${attempt} retries`);
      }
    }

    if (pending.length > 0) {
      log(`[op-retry] GAVE UP on ${pending.length} ref(s) after ${MAX_RETRIES} retries: ${pending.map(r => r.key).join(', ')}`);
    }
  })();
  // Fire-and-forget — don't block server loading on retries
}

// ---------------------------------------------------------------------------
// Load Tier 1 Server Modules
// ---------------------------------------------------------------------------

for (const name of TIER1_SERVERS) {
  const serverPath = path.join(DIST_DIR, name, 'server.js');
  try {
    if (name === 'feedback-explorer') {
      // Uses a factory function pattern
      const mod = await import(serverPath);
      if (typeof mod.createFeedbackExplorerServer !== 'function') {
        throw new Error('createFeedbackExplorerServer is not exported');
      }
      const projectDir = path.resolve(PROJECT_DIR);
      const instance = mod.createFeedbackExplorerServer({ projectDir });
      servers.set(name, instance);
    } else {
      const mod = await import(serverPath);
      if (!mod.server) {
        throw new Error(`server is not exported from ${name}/server.js`);
      }
      servers.set(name, mod.server);
    }
    log(`Loaded: ${name}`);
  } catch (err) {
    log(`Failed to load ${name}: ${err.message}`);
    // Non-fatal: continue loading remaining servers
  }
}

if (servers.size === 0) {
  log('FATAL: No servers loaded — exiting');
  process.exit(1);
}

// Mark as ready — health endpoint now returns status:'ok'
daemonReady = true;

// ---------------------------------------------------------------------------
// Write State File (for config-gen detection)
// ---------------------------------------------------------------------------

try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: PORT,
    servers: [...servers.keys()],
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');
} catch (err) {
  log(`Warning: could not write state file: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Cleanup on Exit
// ---------------------------------------------------------------------------

function cleanup() {
  try { fs.unlinkSync(stateFile); } catch { /* non-fatal */ }
}

process.on('SIGINT', async () => {
  flushAuditStats();
  clearInterval(auditFlushTimer);
  cleanup();
  try {
    await Promise.race([close(), new Promise(r => setTimeout(r, 5000))]);
  } catch { /* non-fatal */ }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  flushAuditStats();
  clearInterval(auditFlushTimer);
  cleanup();
  try {
    await Promise.race([close(), new Promise(r => setTimeout(r, 5000))]);
  } catch { /* non-fatal */ }
  process.exit(0);
});

process.on('exit', cleanup);

log(`Shared MCP daemon ready: ${servers.size}/${TIER1_SERVERS.length} servers on port ${PORT}`);
