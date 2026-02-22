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
 *   - mcp-proxy.anthropic.com
 *
 * Passes through (transparent CONNECT tunnel):
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_PORT = parseInt(process.env.GENTYR_PROXY_PORT || '18080', 10);
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CERT_DIR = path.join(os.homedir(), '.claude', 'proxy-certs');
const PROXY_LOG_PATH = path.join(os.homedir(), '.claude', 'rotation-proxy.log');
const MAX_LOG_BYTES = 1_048_576; // 1 MB

/** Domains we MITM to swap Authorization headers */
const MITM_DOMAINS = ['api.anthropic.com', 'mcp-proxy.anthropic.com'];

/** Max retries on 429 before giving up */
const MAX_429_RETRIES = 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let requestCount = 0;
const startTime = Date.now();

// key-sync functions — loaded at startup
let readRotationState;
let writeRotationState;
let selectActiveKey;
let updateActiveCredentials;
let logRotationEvent;
let appendRotationAudit;

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

  // Mark exhausted
  if (state.keys[exhaustedKeyId]) {
    state.keys[exhaustedKeyId].status = 'exhausted';
    logRotationEvent(state, {
      timestamp: Date.now(),
      event: 'key_removed',
      key_id: exhaustedKeyId,
      reason: 'proxy_429_exhausted',
    });
  }

  // Select next
  const nextKeyId = selectActiveKey(state);
  if (!nextKeyId || !state.keys[nextKeyId]) {
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

  for (const [name, value] of parsed.rawHeaders) {
    if (name.toLowerCase() === 'authorization') continue; // strip old auth
    headerLines.push(`${name}: ${value}`);
  }
  headerLines.push(`Authorization: Bearer ${newToken}`);
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
 */
function forwardRequest(host, rawRequest, clientSocket, opts = {}) {
  const { retryCount = 0, fromKeyId } = opts;
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

  // Parse and rebuild with swapped token
  const parsed = parseHttpRequest(rawRequest);
  if (!parsed) {
    proxyLog('parse_error', { host });
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.end();
    return;
  }

  // Log the swap (key IDs only, never tokens)
  if (retryCount === 0) {
    const existingAuth = parsed.headers['authorization'];
    const hadAuth = Boolean(existingAuth);
    proxyLog('request_intercepted', {
      host,
      method: parsed.method,
      path: parsed.path.slice(0, 100),
      had_auth: hadAuth,
      active_key_id: activeKeyId.slice(0, 8),
    });
  } else {
    proxyLog('retry_attempt', {
      host,
      method: parsed.method,
      path: parsed.path.slice(0, 100),
      retry: retryCount,
      from_key_id: fromKeyId ? fromKeyId.slice(0, 8) : null,
      to_key_id: activeKeyId.slice(0, 8),
    });
  }

  const modifiedRequest = rebuildRequest(parsed, rawRequest, activeToken);

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

    if (responseStatusCode === 429 && retryCount < MAX_429_RETRIES) {
      // Rotate key and retry
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

      const upstreamSocket = net.connect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });

      upstreamSocket.on('error', (err) => {
        proxyLog('tunnel_error', { host: hostname, port, error: err.message });
        clientSocket.destroy();
      });

      clientSocket.on('error', () => {
        upstreamSocket.destroy();
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
// Startup
// ---------------------------------------------------------------------------

async function main() {
  // Load key-sync module
  const keySyncPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'key-sync.js');
  if (!fs.existsSync(keySyncPath)) {
    throw new Error(
      `key-sync.js not found at ${keySyncPath}. ` +
      'Set CLAUDE_PROJECT_DIR to your GENTYR project directory.'
    );
  }

  const keySync = await import(keySyncPath);
  readRotationState = keySync.readRotationState;
  writeRotationState = keySync.writeRotationState;
  selectActiveKey = keySync.selectActiveKey;
  updateActiveCredentials = keySync.updateActiveCredentials;
  logRotationEvent = keySync.logRotationEvent;
  appendRotationAudit = keySync.appendRotationAudit;

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
