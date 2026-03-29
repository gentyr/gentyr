#!/usr/bin/env node
/**
 * Rotation Proxy — local MITM proxy for transparent credential rotation.
 * Replaces binary patching by intercepting API requests and swapping
 * the Authorization header with the current active key.
 *
 * Architecture:
 *   Claude Code --HTTPS_PROXY--> localhost:18080 --TLS--> api.anthropic.com
 *
 * Intercepts (TLS MITM + header swap):
 *   - api.anthropic.com
 *
 * Passes through (transparent CONNECT tunnel):
 *   - mcp-proxy.anthropic.com (MCP proxy validates session-bound OAuth tokens;
 *     swapping them causes 401 → revocation cascade. Must not be MITMed.)
 *   - platform.claude.com (OAuth refresh)
 *   - Everything else
 *
 * Usage:
 *   CLAUDE_PROJECT_DIR=/path/to/project node scripts/rotation-proxy.js
 *   GENTYR_PROXY_PORT=18080 node scripts/rotation-proxy.js
 */

import http from 'http';
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env.GENTYR_PROXY_PORT || '18080', 10);
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(os.homedir(), '.claude', 'proxy-certs');
const PROXY_LOG_PATH = path.join(os.homedir(), '.claude', 'rotation-proxy.log');
const MAX_LOG_BYTES = 10_485_760; // 10 MB safety cap
const LOG_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Domains we MITM to swap Authorization headers */
const MITM_DOMAINS = ['api.anthropic.com'];

/** Max retries on 429 before giving up */
const MAX_429_RETRIES = 2;
const MAX_401_RETRIES = 2;

/** Same-key backoff retry before rotating on 401.
 *  Transient server-side 401 bursts are retried with the same key first so a
 *  brief Anthropic auth hiccup doesn't cause unnecessary key rotation or the
 *  "Please run /login" prompt when no fallback key exists.
 */
const MAX_401_SAME_KEY_RETRIES = 2;
const MAX_GATEWAY_RETRIES = 2;        // 502/503/504 retries (same key, backoff)
const TRANSIENT_401_BACKOFF_MS = 1000; // 1s base, doubles each retry (1s, 2s)
const GATEWAY_BACKOFF_MS = 2000;       // 2s base, doubles each retry (2s, 4s)

/** How many rotation-level 401s (after same-key retries are exhausted) before
 *  we permanently mark a key expired.  Transient server-side bursts typically
 *  clear in < 60s; we give the key a chance to recover via auth_failing state.
 */
const KEY_EXPIRED_THRESHOLD = 3;     // consecutive rotation-level 401s within window
const KEY_EXPIRED_WINDOW_MS = 60_000; // 60s window

/** API path prefixes eligible for token swap. All other paths pass through
 *  with the session's original token (e.g., OAuth endpoints). Allowlist is
 *  safer than denylist — new Claude Code endpoints default to passthrough. */
const SWAP_PATH_PREFIXES = [
  '/v1/messages',          // LLM API calls (primary use case)
  '/v1/organizations',     // Org-level API
  '/api/event_logging/',   // Telemetry batching
  '/api/eval/',            // SDK evaluation
  '/api/web/',             // Domain info lookups
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let requestCount = 0;
const startTime = Date.now();

// 401 rotation debounce: track the last key rotated on 401 to avoid concurrent
// connections triggering multiple rotations for the same exhausted key.
let _last401Rotation = { keyId: null, ts: 0 };
const ROTATION_DEBOUNCE_MS = 5000;

// Track consecutive rotation-level 401 failures per key so we can use a
// threshold before permanently marking a key expired.  Transient server-side
// auth errors clear on their own; we set auth_failing first and only expire
// the key after KEY_EXPIRED_THRESHOLD failures within KEY_EXPIRED_WINDOW_MS.
// Map<keyId, { count: number, firstFailure: number }>
const _key401FailureCounts = new Map();

// key-sync functions — loaded at startup
let readRotationState;
let writeRotationState;
let selectActiveKey;
let updateActiveCredentials;
let logRotationEvent;
let appendRotationAudit;
let generateKeyId;
let syncKeys;
let refreshExpiredToken;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Write a structured JSON log line to the proxy log file.
 * Rotates the file (truncates oldest half) when it exceeds MAX_LOG_BYTES.
 * Never logs actual token values.
 */
function proxyLog(event, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    // Rotate if file is too large
    try {
      const stat = fs.statSync(PROXY_LOG_PATH);
      if (stat.size > MAX_LOG_BYTES) {
        const content = fs.readFileSync(PROXY_LOG_PATH, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        const half = Math.ceil(lines.length / 2);
        fs.writeFileSync(PROXY_LOG_PATH, lines.slice(half).join('\n') + '\n', 'utf8');
      }
    } catch {
      // File doesn't exist yet, that's fine
    }
    fs.appendFileSync(PROXY_LOG_PATH, line, 'utf8');
  } catch (err) {
    // Must not throw — log to stderr as fallback
    process.stderr.write(`[rotation-proxy] log write failed: ${err.message}\n`);
  }
}

/**
 * Remove log entries older than LOG_RETENTION_MS.
 * Called at startup and hourly. Non-fatal on any error.
 */
function cleanupOldLogEntries() {
  try {
    if (!fs.existsSync(PROXY_LOG_PATH)) return;
    const content = fs.readFileSync(PROXY_LOG_PATH, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const recent = lines.filter(line => {
      try {
        return new Date(JSON.parse(line).ts).getTime() >= cutoff;
      } catch { return false; }
    });
    if (recent.length < lines.length) {
      fs.writeFileSync(PROXY_LOG_PATH, recent.join('\n') + '\n', 'utf8');
    }
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Cert loading
// ---------------------------------------------------------------------------

/**
 * Load CA and server certs from CERT_DIR.
 * Throws loudly if certs are missing — caller must generate them first.
 */
function loadCerts() {
  const caPath = path.join(CERT_DIR, 'ca.pem');
  const keyPath = path.join(CERT_DIR, 'server-key.pem');
  const certPath = path.join(CERT_DIR, 'server.pem');

  if (!fs.existsSync(caPath) || !fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    throw new Error(
      `Proxy certs not found in ${CERT_DIR}. ` +
      'Run: scripts/generate-proxy-certs.sh'
    );
  }

  return {
    ca: fs.readFileSync(caPath),
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

// ---------------------------------------------------------------------------
// Active token resolution
// ---------------------------------------------------------------------------

/**
 * Get the current active access token from rotation state.
 * Returns { token, keyId } or throws if none available.
 */
function getActiveToken() {
  const state = readRotationState();
  const keyId = state.active_key_id;
  if (!keyId || !state.keys[keyId]) {
    throw new Error('No active key in rotation state');
  }
  const keyData = state.keys[keyId];
  if (!keyData.accessToken) {
    throw new Error(`Active key ${keyId.slice(0, 8)} has no accessToken`);
  }
  return { token: keyData.accessToken, keyId };
}

/**
 * Mark the current active key as exhausted and rotate to the next.
 * Returns { token, keyId } of new active key, or null if all exhausted.
 */
function rotateOnExhaustion(exhaustedKeyId) {
  const state = readRotationState();

  // Mark exhausted with authoritative usage data.
  // A 429 from the API is definitive proof of exhaustion — stamp fresh usage
  // so selectActiveKey's freshness gate doesn't null it out and re-select it.
  if (state.keys[exhaustedKeyId]) {
    state.keys[exhaustedKeyId].status = 'exhausted';
    state.keys[exhaustedKeyId].last_usage = {
      five_hour: 100,
      seven_day: 100,
      seven_day_sonnet: 100,
      checked_at: Date.now(),
    };
    state.keys[exhaustedKeyId].last_health_check = Date.now();
    logRotationEvent(state, {
      timestamp: Date.now(),
      event: 'key_removed',
      key_id: exhaustedKeyId,
      reason: 'proxy_429_exhausted',
    });
  }

  // Select next — reject self-rotation (same key we just marked exhausted)
  const nextKeyId = selectActiveKey(state);
  if (!nextKeyId || !state.keys[nextKeyId] || nextKeyId === exhaustedKeyId) {
    writeRotationState(state);
    return null;
  }

  state.active_key_id = nextKeyId;
  state.keys[nextKeyId].last_used_at = Date.now();

  logRotationEvent(state, {
    timestamp: Date.now(),
    event: 'key_switched',
    key_id: nextKeyId,
    reason: 'proxy_429_rotation',
    previous_key: exhaustedKeyId,
  });

  writeRotationState(state);

  // Update stored credentials so other components see the new active key
  try {
    updateActiveCredentials(state.keys[nextKeyId]);
  } catch (err) {
    proxyLog('credential_update_failed', { error: err.message });
  }

  if (appendRotationAudit) {
    appendRotationAudit('proxy_rotation', {
      from: exhaustedKeyId.slice(0, 8),
      to: nextKeyId.slice(0, 8),
      reason: 'proxy_429',
    });
  }

  return { token: state.keys[nextKeyId].accessToken, keyId: nextKeyId };
}

/**
 * Handle 401 auth failure: use a threshold before permanently marking a key
 * expired.  Below KEY_EXPIRED_THRESHOLD consecutive rotation-level 401s within
 * KEY_EXPIRED_WINDOW_MS we set status to 'auth_failing' (a transient state that
 * selectActiveKey still treats as viable but with lower priority).  Only after
 * reaching the threshold do we set 'expired' and fire background refresh.
 */
function rotateOnAuth401Sync(failedKeyId) {
  const state = readRotationState();

  if (state.keys[failedKeyId]) {
    const now = Date.now();
    const existing = _key401FailureCounts.get(failedKeyId);

    let failureCount;
    if (existing && now - existing.firstFailure < KEY_EXPIRED_WINDOW_MS) {
      // Still within the window — increment counter
      failureCount = existing.count + 1;
      _key401FailureCounts.set(failedKeyId, { count: failureCount, firstFailure: existing.firstFailure });
    } else {
      // First failure or window expired — start fresh
      failureCount = 1;
      _key401FailureCounts.set(failedKeyId, { count: 1, firstFailure: now });
    }

    if (failureCount < KEY_EXPIRED_THRESHOLD) {
      // Transient failure: mark as auth_failing (still viable for selection)
      state.keys[failedKeyId].status = 'auth_failing';
      logRotationEvent(state, {
        timestamp: now,
        event: 'key_auth_failing',
        key_id: failedKeyId,
        reason: 'proxy_401_transient',
        failure_count: failureCount,
        threshold: KEY_EXPIRED_THRESHOLD,
      });
    } else {
      // Threshold reached: permanently mark as expired
      state.keys[failedKeyId].status = 'expired';
      _key401FailureCounts.delete(failedKeyId); // clear counter — key is gone
      logRotationEvent(state, {
        timestamp: now,
        event: 'key_expired',
        key_id: failedKeyId,
        reason: 'proxy_401_auth_failure',
        failure_count: failureCount,
      });
    }
  }

  const nextKeyId = selectActiveKey(state);
  if (!nextKeyId || !state.keys[nextKeyId] || nextKeyId === failedKeyId) {
    writeRotationState(state);
    return null;
  }

  state.active_key_id = nextKeyId;
  state.keys[nextKeyId].last_used_at = Date.now();
  logRotationEvent(state, {
    timestamp: Date.now(),
    event: 'key_switched',
    key_id: nextKeyId,
    reason: 'proxy_401_rotation',
    previous_key: failedKeyId,
  });
  writeRotationState(state);

  try { updateActiveCredentials(state.keys[nextKeyId]); }
  catch (err) { proxyLog('credential_update_failed', { error: err.message }); }

  if (appendRotationAudit) {
    appendRotationAudit('proxy_401_rotation', {
      from: failedKeyId.slice(0, 8),
      to: nextKeyId.slice(0, 8),
      reason: 'auth_401',
    });
  }

  // Fire-and-forget: attempt refresh of the failed key in background
  if (refreshExpiredToken && state.keys[failedKeyId]?.refreshToken) {
    refreshExpiredToken(state.keys[failedKeyId]).then(refreshed => {
      if (refreshed && refreshed !== 'invalid_grant') {
        const freshState = readRotationState();
        if (freshState.keys[failedKeyId]) {
          freshState.keys[failedKeyId].accessToken = refreshed.accessToken;
          freshState.keys[failedKeyId].refreshToken = refreshed.refreshToken;
          freshState.keys[failedKeyId].expiresAt = refreshed.expiresAt;
          freshState.keys[failedKeyId].status = 'active';
          writeRotationState(freshState);
          proxyLog('background_refresh_success', { key_id: failedKeyId.slice(0, 8) });
        }
      }
    }).catch(() => {});
  }

  return { token: state.keys[nextKeyId].accessToken, keyId: nextKeyId };
}

// ---------------------------------------------------------------------------
// HTTP request forwarding (used after MITM TLS termination)
// ---------------------------------------------------------------------------

/**
 * Parse raw HTTP request bytes into { method, path, httpVersion, headers, rawHeaders, bodyStart }.
 * headers: lowercased keys for lookup. rawHeaders: original [name, value] pairs for rebuilding.
 */
function parseHttpRequest(buffer) {
  const str = buffer.toString('binary');
  const headerEnd = str.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;

  const headerSection = str.slice(0, headerEnd);
  const lines = headerSection.split('\r\n');
  const [method, reqPath, httpVersion] = lines[0].split(' ');

  const headers = {};      // lowercased for lookup
  const rawHeaders = [];   // original casing for rebuild
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon === -1) continue;
    const originalName = lines[i].slice(0, colon).trim();
    const value = lines[i].slice(colon + 1).trim();
    headers[originalName.toLowerCase()] = value;
    rawHeaders.push([originalName, value]);
  }

  return {
    method,
    path: reqPath,
    httpVersion,
    headers,
    rawHeaders,
    bodyStart: headerEnd + 4,
  };
}

/**
 * Reassemble a modified HTTP request buffer with swapped Authorization header.
 * Preserves original header casing. Returns a Buffer.
 */
function rebuildRequest(parsed, originalBuffer, newToken) {
  const headerLines = [
    `${parsed.method} ${parsed.path} ${parsed.httpVersion}`,
  ];

  let hadAuth = false;
  for (const [name, value] of parsed.rawHeaders) {
    if (name.toLowerCase() === 'authorization') {
      hadAuth = true;
      continue; // strip old auth
    }
    headerLines.push(`${name}: ${value}`);
  }
  if (hadAuth) {
    headerLines.push(`Authorization: Bearer ${newToken}`);
  }
  headerLines.push(''); // blank line before body
  headerLines.push('');

  const headerBuf = Buffer.from(headerLines.join('\r\n'), 'binary');
  const bodyBuf = originalBuffer.slice(parsed.bodyStart);
  return Buffer.concat([headerBuf, bodyBuf]);
}

/**
 * Forward a raw HTTP request buffer to the real upstream host over TLS.
 * Handles SSE streaming via pipe. Handles 429 with up to MAX_429_RETRIES retries.
 *
 * @param {string} host - Target hostname (e.g., api.anthropic.com)
 * @param {Buffer} rawRequest - Raw HTTP/1.1 request bytes
 * @param {net.Socket | tls.TLSSocket} clientSocket - Client socket to write response to
 * @param {object} [opts]
 * @param {number} [opts.retryCount=0]
 * @param {string} [opts.fromKeyId] - Key ID that was swapped FROM (for logging)
 * @param {number} [opts.sameKeyRetryCount=0] - How many same-key 401 backoff retries have been attempted
 * @param {number} [opts.gatewayRetryCount=0] - How many 502/503/504 backoff retries have been attempted
 */
function forwardRequest(host, rawRequest, clientSocket, opts = {}) {
  const { retryCount = 0, fromKeyId, sameKeyRetryCount = 0, gatewayRetryCount = 0 } = opts;
  requestCount++;

  // Get current active token
  let activeToken, activeKeyId;
  try {
    ({ token: activeToken, keyId: activeKeyId } = getActiveToken());
  } catch (err) {
    proxyLog('token_resolution_failed', { host, error: err.message });
    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.end();
    return;
  }

  // Parse the incoming request
  const parsed = parseHttpRequest(rawRequest);
  if (!parsed) {
    proxyLog('parse_error', { host });
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.end();
    return;
  }

  // Check if the incoming token is unknown to rotation state.
  // If so, pass it through unmodified — the user likely just logged in with
  // a fresh account that hasn't been registered yet.
  const existingAuth = parsed.headers['authorization'];
  let usePassthrough = false;
  let forceSwap = false;
  let incomingKeyId = null;

  if (retryCount === 0 && existingAuth) {
    const bearerMatch = existingAuth.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && generateKeyId) {
      incomingKeyId = generateKeyId(bearerMatch[1]);
      const state = readRotationState();
      const keyEntry = state.keys[incomingKeyId];

      if (keyEntry && keyEntry.status === 'tombstone') {
        // Pruned dead token — swap with active key (prevents Bug B)
        proxyLog('tombstone_token_swap', {
          host,
          method: parsed.method,
          path: parsed.path.slice(0, 100),
          incoming_key_id: incomingKeyId.slice(0, 8),
          active_key_id: activeKeyId.slice(0, 8),
        });
        // usePassthrough stays false — request gets active key's token
        forceSwap = true;
      } else if (keyEntry && keyEntry.status === 'merged') {
        // Deduplicated token — swap with active key (same as tombstone)
        proxyLog('merged_token_swap', {
          host,
          method: parsed.method,
          path: parsed.path.slice(0, 100),
          incoming_key_id: incomingKeyId.slice(0, 8),
          merged_into: (keyEntry.merged_into || '').slice(0, 8),
          active_key_id: activeKeyId.slice(0, 8),
        });
        // usePassthrough stays false — request gets active key's token
        forceSwap = true;
      } else if (!keyEntry) {
        // Unknown token — likely fresh login, pass through unchanged (Bug A fix)
        usePassthrough = true;
        proxyLog('unknown_token_passthrough', {
          host,
          method: parsed.method,
          path: parsed.path.slice(0, 100),
          incoming_key_id: incomingKeyId.slice(0, 8),
          active_key_id: activeKeyId.slice(0, 8),
        });
        if (syncKeys) {
          syncKeys().catch(err => {
            proxyLog('async_sync_failed', { error: err.message });
          });
        }
      }
      // Dead active key check: if the incoming token is known but the active key
      // is dead (expired/invalid/missing), don't swap — the incoming token might
      // be fresher. Let it through and trigger sync to discover new credentials.
      if (!usePassthrough && !forceSwap) {
        const activeEntry = state.keys[state.active_key_id];
        if (!activeEntry || !['active', 'exhausted', 'auth_failing'].includes(activeEntry.status)) {
          if (incomingKeyId !== state.active_key_id) {
            // Different token is likely fresher — let it through
            usePassthrough = true;
            proxyLog('dead_active_key_passthrough', {
              host,
              method: parsed.method,
              path: parsed.path.slice(0, 100),
              incoming_key_id: incomingKeyId ? incomingKeyId.slice(0, 8) : null,
              active_key_id: activeKeyId.slice(0, 8),
              active_status: activeEntry ? activeEntry.status : 'missing',
            });
          } else {
            // Same dead token — don't passthrough, let 401 rotation handle it
            proxyLog('dead_active_key_self_hit', {
              host,
              method: parsed.method,
              path: parsed.path.slice(0, 100),
              incoming_key_id: incomingKeyId ? incomingKeyId.slice(0, 8) : null,
              active_key_id: activeKeyId.slice(0, 8),
              active_status: activeEntry ? activeEntry.status : 'missing',
            });
          }
          // Trigger sync either way to discover fresh credentials from /login
          if (syncKeys) {
            syncKeys().catch(err => {
              proxyLog('async_sync_failed', { error: err.message });
            });
          }
        }
      }
    }
  }

  // Path-level passthrough: OAuth and session-bound endpoints must keep the
  // session's own token. Only explicitly listed API paths get rotation swap.
  // This check ALWAYS applies regardless of forceSwap — merged/tombstone tokens
  // on non-SWAP paths must still passthrough to prevent OAuth revocation.
  if (!usePassthrough && retryCount === 0) {
    const isSwapPath = SWAP_PATH_PREFIXES.some(prefix => parsed.path.startsWith(prefix));
    if (!isSwapPath) {
      usePassthrough = true;
      proxyLog('session_path_passthrough', {
        host,
        method: parsed.method,
        path: parsed.path.slice(0, 100),
        incoming_key_id: incomingKeyId ? incomingKeyId.slice(0, 8) : null,
        active_key_id: activeKeyId.slice(0, 8),
      });
    }
  }

  // Log the swap (key IDs only, never tokens)
  if (retryCount === 0 && !usePassthrough) {
    const hadAuth = Boolean(existingAuth);
    // Determine incoming token status and swap reason for audit trail
    let keyStatus = 'unknown';
    let swapReason = 'normal';
    if (incomingKeyId) {
      const state = readRotationState();
      const keyEntry = state.keys[incomingKeyId];
      keyStatus = keyEntry ? keyEntry.status : 'unknown';
      if (forceSwap) {
        swapReason = keyStatus === 'tombstone' ? 'tombstone_recovery' : 'merged_recovery';
      }
    }
    proxyLog('request_intercepted', {
      host,
      method: parsed.method,
      path: parsed.path.slice(0, 100),
      had_auth: hadAuth,
      active_key_id: activeKeyId.slice(0, 8),
      key_status: keyStatus,
      swap_reason: swapReason,
    });
  } else if (retryCount > 0) {
    proxyLog('retry_attempt', {
      host,
      method: parsed.method,
      path: parsed.path.slice(0, 100),
      retry: retryCount,
      from_key_id: fromKeyId ? fromKeyId.slice(0, 8) : null,
      to_key_id: activeKeyId.slice(0, 8),
    });
  }

  // If the incoming token is unknown, forward the original request as-is
  const modifiedRequest = usePassthrough
    ? rawRequest
    : rebuildRequest(parsed, rawRequest, activeToken);

  // Connect to upstream
  const upstream = tls.connect({ host, port: 443, servername: host }, () => {
    upstream.write(modifiedRequest);
  });

  upstream.on('error', (err) => {
    proxyLog('upstream_error', { host, error: err.message });
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    }
  });

  // Accumulate response headers to detect 429 and SSE
  let responseHeaderBuf = Buffer.alloc(0);
  let headersParsed = false;
  let responseStatusCode = 0;
  let isSSE = false;
  let headerEndIndex = -1;

  const onData = (chunk) => {
    if (headersParsed) {
      // Already streaming — pass through (non-SSE only; SSE uses pipe)
      if (!clientSocket.destroyed) clientSocket.write(chunk);
      return;
    }

    responseHeaderBuf = Buffer.concat([responseHeaderBuf, chunk]);
    const str = responseHeaderBuf.toString('binary');
    headerEndIndex = str.indexOf('\r\n\r\n');

    if (headerEndIndex === -1) {
      // Haven't seen end of headers yet — keep buffering
      return;
    }

    // Parse response status
    const firstLine = str.slice(0, str.indexOf('\r\n'));
    const statusMatch = firstLine.match(/^HTTP\/[\d.]+ (\d+)/);
    responseStatusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    const headerSection = str.slice(0, headerEndIndex).toLowerCase();
    isSSE = headerSection.includes('content-type: text/event-stream');

    headersParsed = true;

    proxyLog('response_received', {
      host,
      method: parsed.method,
      path: parsed.path.slice(0, 100),
      status: responseStatusCode,
      is_sse: isSSE,
      active_key_id: activeKeyId.slice(0, 8),
    });

    if (responseStatusCode === 429 && retryCount < MAX_429_RETRIES && !usePassthrough) {
      // Rotate key and retry (skip for passthrough — proxy didn't inject that token)
      upstream.destroy();
      proxyLog('rotating_on_429', {
        host,
        method: parsed.method,
        path: parsed.path.slice(0, 100),
        exhausted_key_id: activeKeyId.slice(0, 8),
        retry: retryCount,
      });

      const next = rotateOnExhaustion(activeKeyId);
      if (!next) {
        proxyLog('all_keys_exhausted', { host });
        // Return original 429 to client
        if (!clientSocket.destroyed) {
          clientSocket.write(responseHeaderBuf);
        }
        return;
      }

      // Retry with new key
      forwardRequest(host, rawRequest, clientSocket, {
        retryCount: retryCount + 1,
        fromKeyId: activeKeyId,
      });
      return;
    }

    // Clear transient 401 failure tracking on a successful 200 response.
    // When Anthropic's auth hiccup clears, the key is healthy again.
    if (responseStatusCode === 200 && _key401FailureCounts.has(activeKeyId)) {
      _key401FailureCounts.delete(activeKeyId);
      try {
        const freshState = readRotationState();
        if (freshState.keys[activeKeyId]?.status === 'auth_failing') {
          freshState.keys[activeKeyId].status = 'active';
          writeRotationState(freshState);
          proxyLog('transient_401_recovered', { key_id: activeKeyId.slice(0, 8) });
        }
      } catch { /* non-fatal: best-effort recovery */ }
    }

    // 401: before rotating to a different key, retry with the SAME key after a
    // short backoff.  Evidence from proxy logs shows Anthropic returns transient
    // 401 bursts interspersed with 200s on the same token — true token expiry
    // causes persistent 401s, not alternating ones.  Retrying with the same key
    // first avoids "Please run /login" errors when there is no fallback key.
    //
    // Defense-in-depth: never rotate on 401 from mcp-proxy.anthropic.com — that
    // host validates session-bound OAuth tokens and a 401 there indicates token
    // mismatch (not key expiration). Rotating would trigger a destructive cascade.
    const isMcpProxy = host === 'mcp-proxy.anthropic.com';
    if (responseStatusCode === 401 && retryCount < MAX_401_RETRIES && !usePassthrough && !isMcpProxy) {
      // Phase 1: same-key backoff retry.
      // Both the normal path AND the debounced path use same-key retry if
      // retries remain — only forward 401 to the client once all retries are
      // exhausted.
      if (sameKeyRetryCount < MAX_401_SAME_KEY_RETRIES) {
        const backoffMs = TRANSIENT_401_BACKOFF_MS * (sameKeyRetryCount + 1);
        upstream.destroy();
        proxyLog('transient_401_retry', {
          host,
          method: parsed.method,
          path: parsed.path.slice(0, 100),
          key_id: activeKeyId.slice(0, 8),
          same_key_retry: sameKeyRetryCount + 1,
          backoff_ms: backoffMs,
        });
        setTimeout(() => {
          forwardRequest(host, rawRequest, clientSocket, {
            retryCount,
            fromKeyId: activeKeyId,
            sameKeyRetryCount: sameKeyRetryCount + 1,
          });
        }, backoffMs);
        return;
      }

      // Phase 2: same-key retries exhausted — try to rotate to a different key.
      // Debounce: if another connection already rotated this key within 5s, skip
      // another rotation attempt.
      const now401 = Date.now();
      if (_last401Rotation.keyId === activeKeyId && now401 - _last401Rotation.ts < ROTATION_DEBOUNCE_MS) {
        proxyLog('rotation_debounced', {
          host,
          method: parsed.method,
          path: parsed.path.slice(0, 100),
          key_id: activeKeyId.slice(0, 8),
        });
        // Forward the 401 response to client as-is — same-key retries already
        // exhausted and another connection is already handling rotation.
        upstream.removeListener('data', onData);
        if (!clientSocket.destroyed) {
          clientSocket.write(responseHeaderBuf);
        }
        upstream.pipe(clientSocket, { end: true });
        return;
      }
      _last401Rotation = { keyId: activeKeyId, ts: now401 };
      upstream.destroy();
      proxyLog('rotating_on_401', {
        host,
        method: parsed.method,
        path: parsed.path.slice(0, 100),
        failed_key_id: activeKeyId.slice(0, 8),
        retry: retryCount,
        same_key_retries_exhausted: sameKeyRetryCount,
      });
      const next = rotateOnAuth401Sync(activeKeyId);
      if (!next) {
        proxyLog('all_keys_failed_auth', {
          host,
          method: parsed.method,
          path: parsed.path.slice(0, 100),
          failed_key_id: activeKeyId.slice(0, 8),
          same_key_retries: sameKeyRetryCount,
          rotation_retries: retryCount,
        });
        if (!clientSocket.destroyed) {
          clientSocket.write(responseHeaderBuf);
        }
        return;
      }
      forwardRequest(host, rawRequest, clientSocket, {
        retryCount: retryCount + 1,
        fromKeyId: activeKeyId,
      });
      return;
    }

    // 502/503/504: Cloudflare or upstream gateway error — the API server is
    // temporarily unreachable.  Token is fine, no rotation needed.  Retry with
    // the same key after exponential backoff (2s, 4s).
    const isGatewayError = responseStatusCode >= 502 && responseStatusCode <= 504;
    if (isGatewayError && gatewayRetryCount >= MAX_GATEWAY_RETRIES) {
      proxyLog('gateway_error_exhausted', {
        host,
        method: parsed.method,
        path: parsed.path.slice(0, 100),
        status: responseStatusCode,
        key_id: activeKeyId.slice(0, 8),
        gateway_retries: gatewayRetryCount,
      });
    }
    if (isGatewayError && gatewayRetryCount < MAX_GATEWAY_RETRIES && !usePassthrough) {
      const backoffMs = GATEWAY_BACKOFF_MS * (gatewayRetryCount + 1);
      upstream.destroy();
      proxyLog('gateway_error_retry', {
        host,
        method: parsed.method,
        path: parsed.path.slice(0, 100),
        status: responseStatusCode,
        key_id: activeKeyId.slice(0, 8),
        gateway_retry: gatewayRetryCount + 1,
        backoff_ms: backoffMs,
      });
      setTimeout(() => {
        forwardRequest(host, rawRequest, clientSocket, {
          retryCount,
          fromKeyId,
          sameKeyRetryCount,
          gatewayRetryCount: gatewayRetryCount + 1,
        });
      }, backoffMs);
      return;
    }

    if (isSSE) {
      // SSE: remove this data listener BEFORE writing buffered data or
      // setting up pipe, so incoming chunks are only handled by pipe.
      upstream.removeListener('data', onData);

      // Write buffered headers + any partial body that arrived with them
      if (!clientSocket.destroyed) {
        clientSocket.write(responseHeaderBuf);
      }

      // Pipe all subsequent upstream data to client zero-copy.
      // Since we removed the 'data' listener above, only pipe writes to
      // clientSocket — no double-write.
      upstream.pipe(clientSocket, { end: true });
    } else {
      // Non-SSE: write buffered data, subsequent chunks handled by the
      // headersParsed early-return at the top of this handler.
      if (!clientSocket.destroyed) {
        clientSocket.write(responseHeaderBuf);
      }
    }
  };

  upstream.on('data', onData);

  upstream.on('end', () => {
    if (!isSSE && !clientSocket.destroyed) {
      clientSocket.end();
    }
  });

  clientSocket.on('error', () => {
    upstream.destroy();
  });

  clientSocket.on('close', () => {
    upstream.destroy();
  });
}

// ---------------------------------------------------------------------------
// Health endpoint handler
// ---------------------------------------------------------------------------

/**
 * Respond to GET /__health with JSON status.
 */
function handleHealthCheck(req, res) {
  let activeKeyId = null;
  try {
    const state = readRotationState();
    activeKeyId = state.active_key_id ? state.active_key_id.slice(0, 8) + '...' : null;
  } catch {
    // State unreadable
  }

  const body = JSON.stringify({
    status: 'ok',
    activeKeyId,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    requestCount,
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

/**
 * Create the proxy server. Each incoming connection is handled as HTTP/1.1.
 * CONNECT method triggers tunnel (MITM or transparent).
 */
function createProxyServer(certs) {
  const server = http.createServer((req, res) => {
    // Direct HTTP requests (not CONNECT tunnels) — health check only
    if (req.url === '/__health' || req.url === 'http://localhost:' + PROXY_PORT + '/__health') {
      handleHealthCheck(req, res);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Proxy only accepts CONNECT tunnels\n');
  });

  server.on('connect', (req, clientSocket, head) => {
    const [hostname, portStr] = req.url.split(':');
    const port = parseInt(portStr || '443', 10);
    const isMITMTarget = MITM_DOMAINS.includes(hostname);

    if (!isMITMTarget) {
      // Transparent CONNECT tunnel — pass through
      proxyLog('tunnel_passthrough', { host: hostname, port });

      const tunnelStart = Date.now();
      const upstreamSocket = net.connect(port, hostname, () => {
        proxyLog('tunnel_established', { host: hostname, port, head_bytes: head?.length || 0 });
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });

      upstreamSocket.on('error', (err) => {
        proxyLog('tunnel_error', { host: hostname, port, error: err.message,
          duration_ms: Date.now() - tunnelStart });
        clientSocket.destroy();
      });

      upstreamSocket.on('close', () => {
        if (!clientSocket.destroyed) {
          proxyLog('tunnel_closed', { host: hostname, port,
            duration_ms: Date.now() - tunnelStart,
            bytes_from_server: upstreamSocket.bytesRead,
            bytes_from_client: upstreamSocket.bytesWritten,
            closed_by: 'upstream' });
        }
      });

      clientSocket.on('error', (err) => {
        proxyLog('tunnel_client_error', { host: hostname, port, error: err.message,
          duration_ms: Date.now() - tunnelStart });
        upstreamSocket.destroy();
      });

      clientSocket.on('close', () => {
        if (!upstreamSocket.destroyed) {
          proxyLog('tunnel_closed', { host: hostname, port,
            duration_ms: Date.now() - tunnelStart,
            bytes_from_server: upstreamSocket.bytesRead,
            bytes_from_client: upstreamSocket.bytesWritten,
            closed_by: 'client' });
          upstreamSocket.destroy();
        }
      });

      return;
    }

    // MITM: respond 200, then wrap in TLS server
    proxyLog('mitm_intercept', { host: hostname, port });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Push any early data (TLS ClientHello sent before 200 response) back
    // into the socket's readable stream so TLSSocket sees it during handshake
    if (head && head.length > 0) {
      clientSocket.unshift(head);
    }

    const tlsServer = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: certs.key,
      cert: certs.cert,
      ca: [certs.ca],
      requestCert: false,
    });

    tlsServer.on('error', (err) => {
      proxyLog('tls_error', { host: hostname, error: err.message });
      clientSocket.destroy();
    });

    // Accumulate request data until we have a complete HTTP request
    let requestBuf = Buffer.alloc(0);
    let requestDispatched = false;

    tlsServer.on('data', (chunk) => {
      // Intentional: one request per CONNECT tunnel. forwardRequest() closes the
      // client socket on upstream end, forcing the client to open a new tunnel
      // for the next request. This sacrifices keep-alive reuse but simplifies
      // the proxy and ensures every request gets a fresh token lookup.
      if (requestDispatched) return;

      requestBuf = Buffer.concat([requestBuf, chunk]);

      // Check if we have a complete HTTP request (headers ended)
      const str = requestBuf.toString('binary');
      const headerEnd = str.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // Still buffering headers

      // Check content-length to see if body is complete
      const headerSection = str.slice(0, headerEnd).toLowerCase();
      const clMatch = headerSection.match(/content-length:\s*(\d+)/);
      if (clMatch) {
        const expectedBodyLen = parseInt(clMatch[1], 10);
        const actualBodyLen = requestBuf.length - (headerEnd + 4);
        if (actualBodyLen < expectedBodyLen) return; // Still buffering body
      }

      requestDispatched = true;
      forwardRequest(hostname, requestBuf, tlsServer);
    });
  });

  return server;
}

// ---------------------------------------------------------------------------
// Credential file watcher — detect /login in any session
// ---------------------------------------------------------------------------

let _credWatchTimer = null;
const CRED_WATCH_DEBOUNCE_MS = 1000;

/**
 * Watch ~/.claude/.credentials.json for changes.
 * When a user runs /login in any session, Claude Code writes fresh tokens here.
 * We trigger an immediate syncKeys() so the proxy starts using the new token
 * for ALL sessions — other sessions don't need to re-auth.
 *
 * syncKeys() also calls updateActiveCredentials() during pre-expiry swap,
 * which writes the new token back to Keychain. Claude Code's internal
 * credential re-read (SRA/r6T) picks it up from Keychain, so existing
 * sessions resume without /login.
 */
function watchCredentials() {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credPath)) {
    proxyLog('credential_watch_skipped', { reason: 'file_not_found', path: credPath });
    return;
  }

  try {
    const watcher = fs.watch(credPath, { persistent: false }, (eventType) => {
      // On macOS (kqueue), 'rename' means the inode changed — the watcher is now
      // dead and will never fire again. Close it and re-create after sync completes.
      const needsRewatch = eventType === 'rename';

      if (_credWatchTimer) return; // debounce
      _credWatchTimer = setTimeout(async () => {
        _credWatchTimer = null;
        try {
          proxyLog('credential_file_changed', { event_type: eventType });
          const result = await syncKeys();
          if (result.keysAdded > 0 || result.keysUpdated > 0 || result.tokensRefreshed > 0) {
            proxyLog('credential_watch_synced', {
              keys_added: result.keysAdded,
              keys_updated: result.keysUpdated,
              tokens_refreshed: result.tokensRefreshed,
            });
          }
        } catch (err) {
          proxyLog('credential_watch_sync_failed', { error: err.message });
        }
        // Re-establish watcher after atomic rename (old inode is gone)
        if (needsRewatch) {
          try { watcher.close(); } catch {}
          proxyLog('credential_watch_restarting', { reason: 'rename_rewatch' });
          setTimeout(() => watchCredentials(), 1000);
        }
      }, CRED_WATCH_DEBOUNCE_MS);
    });

    watcher.on('error', () => {
      try { watcher.close(); } catch {}
      proxyLog('credential_watch_restarting', { reason: 'watcher_error' });
      setTimeout(() => watchCredentials(), 2000);
    });

    proxyLog('credential_watch_started', { path: credPath });
  } catch (err) {
    proxyLog('credential_watch_failed', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  // Load key-sync module — resolve relative to this script (gentyr repo) first,
  // then fall back to CLAUDE_PROJECT_DIR for backwards compatibility
  const scriptRelativePath = path.join(SCRIPT_DIR, '..', '.claude', 'hooks', 'key-sync.js');
  const projectDirPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'key-sync.js');
  const keySyncPath = fs.existsSync(scriptRelativePath) ? scriptRelativePath : projectDirPath;
  if (!fs.existsSync(keySyncPath)) {
    throw new Error(
      `key-sync.js not found at ${scriptRelativePath} or ${projectDirPath}. ` +
      'Ensure the proxy is run from the GENTYR repo or set CLAUDE_PROJECT_DIR.'
    );
  }

  const keySync = await import(keySyncPath);
  readRotationState = keySync.readRotationState;
  writeRotationState = keySync.writeRotationState;
  selectActiveKey = keySync.selectActiveKey;
  updateActiveCredentials = keySync.updateActiveCredentials;
  logRotationEvent = keySync.logRotationEvent;
  appendRotationAudit = keySync.appendRotationAudit;
  generateKeyId = keySync.generateKeyId;
  syncKeys = keySync.syncKeys;
  refreshExpiredToken = keySync.refreshExpiredToken;

  // Load TLS certs
  const certs = loadCerts();

  // Validate rotation state is accessible
  const initialState = readRotationState();
  const activeKeyId = initialState.active_key_id;
  if (!activeKeyId || !initialState.keys[activeKeyId]) {
    throw new Error(
      'No active key in rotation state. ' +
      'Ensure key-sync has run at least once (start a Claude Code session first).'
    );
  }

  proxyLog('startup', {
    port: PROXY_PORT,
    project_dir: PROJECT_DIR,
    active_key_id: activeKeyId.slice(0, 8),
    key_count: Object.keys(initialState.keys).length,
    mitm_domains: MITM_DOMAINS,
  });

  // Clean old log entries at startup and hourly
  cleanupOldLogEntries();
  setInterval(cleanupOldLogEntries, 60 * 60 * 1000).unref();

  // Watch credential file for /login events — enables cross-session token sharing
  watchCredentials();

  const server = createProxyServer(certs);

  server.on('error', (err) => {
    proxyLog('server_error', { error: err.message, code: err.code });
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `[rotation-proxy] Port ${PROXY_PORT} already in use. ` +
        `Set GENTYR_PROXY_PORT to use a different port.\n`
      );
      process.exit(1);
    }
    throw err;
  });

  server.listen(PROXY_PORT, '127.0.0.1', () => {
    process.stdout.write(
      `[rotation-proxy] Listening on 127.0.0.1:${PROXY_PORT}\n` +
      `[rotation-proxy] Active key: ${activeKeyId.slice(0, 8)}...\n` +
      `[rotation-proxy] MITM domains: ${MITM_DOMAINS.join(', ')}\n` +
      `[rotation-proxy] Log: ${PROXY_LOG_PATH}\n` +
      `[rotation-proxy] Health: http://localhost:${PROXY_PORT}/__health\n`
    );
  });

  // Graceful shutdown
  function shutdown(signal) {
    proxyLog('shutdown', { signal, requestCount, uptime: Math.floor((Date.now() - startTime) / 1000) });
    process.stdout.write(`\n[rotation-proxy] Shutting down (${signal})\n`);
    server.close(() => {
      process.exit(0);
    });
    // Force exit after 5s if close hangs
    setTimeout(() => process.exit(0), 5000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`[rotation-proxy] Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
