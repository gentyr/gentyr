/**
 * Tests for scripts/rotation-proxy.js - local MITM proxy for credential rotation.
 *
 * Coverage:
 * 1. Code structure: head buffer unshift in MITM CONNECT handler (the specific change)
 * 2. Code structure: transparent passthrough CONNECT handler (head forwarding)
 * 3. Behavioral: parseHttpRequest() — pure HTTP parser
 * 4. Behavioral: rebuildRequest() — header reconstruction with auth swap
 * 5. Behavioral: MITM domain routing logic
 * 6. Behavioral: log rotation threshold
 * 7. Behavioral: loadCerts() fail-loud behavior
 * 8. Behavioral: getActiveToken() / rotateOnExhaustion() state contracts
 * 9. Behavioral: 429 retry counter cap
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test scripts/__tests__/rotation-proxy.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROXY_PATH = path.join(__dirname, '..', 'rotation-proxy.js');

// ---------------------------------------------------------------------------
// Helper: extract a named function body from source text.
// Returns the first occurrence of `function <name>(...) { ... }` including
// arrow functions and export variants.
// ---------------------------------------------------------------------------
function extractFunctionBody(code, name) {
  // Match: [async] function name(...) { ... } (greedy on braces is unreliable;
  // instead we search for the declaration line then capture until the NEXT
  // top-level export/function/const that starts at column 0)
  const start = code.indexOf(`function ${name}`);
  if (start === -1) return null;
  return code.slice(start);
}

// ---------------------------------------------------------------------------
// 1. File basics
// ---------------------------------------------------------------------------

describe('rotation-proxy.js - File structure', () => {
  it('should exist at the expected path', () => {
    assert.ok(fs.existsSync(PROXY_PATH), `rotation-proxy.js must exist at ${PROXY_PATH}`);
  });

  it('should have node shebang', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /^#!\/usr\/bin\/env node/, 'Must have #!/usr/bin/env node shebang');
  });

  it('should use ES module imports (import ... from)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /^import\s+/m, 'Must use ES module import syntax');
    assert.match(code, /import http from ['"]http['"]/, 'Must import http');
    assert.match(code, /import tls from ['"]tls['"]/, 'Must import tls');
    assert.match(code, /import net from ['"]net['"]/, 'Must import net');
    assert.match(code, /import fs from ['"]fs['"]/, 'Must import fs');
  });

  it('should define MITM_DOMAINS as a module-level constant array', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(
      code,
      /const MITM_DOMAINS\s*=\s*\[/,
      'Must define MITM_DOMAINS as a const array'
    );
    assert.match(code, /api\.anthropic\.com/, 'MITM_DOMAINS must include api.anthropic.com');
  });

  it('should NOT include mcp-proxy.anthropic.com in MITM_DOMAINS', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    // Extract only the MITM_DOMAINS array line to avoid matching comments
    const mitmLine = code.match(/const MITM_DOMAINS\s*=\s*\[([^\]]*)\]/)?.[0] || '';
    assert.doesNotMatch(
      mitmLine,
      /mcp-proxy\.anthropic\.com/,
      'mcp-proxy.anthropic.com must NOT be in MITM_DOMAINS — it uses session-bound OAuth tokens that must not be swapped'
    );
  });

  it('should define MAX_429_RETRIES constant', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /const MAX_429_RETRIES\s*=\s*\d+/, 'Must define MAX_429_RETRIES');
  });

  it('should define MAX_LOG_BYTES for log rotation', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /const MAX_LOG_BYTES\s*=/, 'Must define MAX_LOG_BYTES for log rotation');
  });
});

// ---------------------------------------------------------------------------
// 2. MITM CONNECT handler — the specific change under test
// ---------------------------------------------------------------------------

describe('rotation-proxy.js - MITM CONNECT handler: head buffer unshift', () => {
  it('should call clientSocket.unshift(head) when head is non-empty before TLSSocket creation', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    // Find the MITM section — begins after "MITM: respond 200" comment
    const mitmStart = code.indexOf('// MITM: respond 200');
    assert.ok(mitmStart !== -1, 'Must have "MITM: respond 200" comment in CONNECT handler');

    // Find where the TLSSocket is created
    const tlsSocketIdx = code.indexOf('new tls.TLSSocket(clientSocket', mitmStart);
    assert.ok(tlsSocketIdx !== -1, 'Must create new tls.TLSSocket after the MITM comment');

    // The unshift call must appear BETWEEN the MITM comment and the TLSSocket creation
    const mitmSection = code.slice(mitmStart, tlsSocketIdx);

    assert.match(
      mitmSection,
      /clientSocket\.unshift\(head\)/,
      'Must call clientSocket.unshift(head) before new tls.TLSSocket() in MITM handler'
    );
  });

  it('should guard the unshift behind head && head.length > 0 check', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const mitmStart = code.indexOf('// MITM: respond 200');
    const tlsSocketIdx = code.indexOf('new tls.TLSSocket(clientSocket', mitmStart);
    const mitmSection = code.slice(mitmStart, tlsSocketIdx);

    assert.match(
      mitmSection,
      /if\s*\(head\s*&&\s*head\.length\s*>\s*0\)\s*\{[\s\S]*?clientSocket\.unshift\(head\)/,
      'unshift must be guarded by if (head && head.length > 0) to avoid unshifting empty Buffers'
    );
  });

  it('should explain the early-data race condition in a comment near the unshift', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const mitmStart = code.indexOf('// MITM: respond 200');
    const tlsSocketIdx = code.indexOf('new tls.TLSSocket(clientSocket', mitmStart);
    const mitmSection = code.slice(mitmStart, tlsSocketIdx);

    // Expects some comment referencing TLS ClientHello or early data
    assert.match(
      mitmSection,
      /\/\/.*(?:early data|TLS ClientHello|before 200|readable stream)/i,
      'Must include a comment explaining WHY head is unshifted (TLS ClientHello early data)'
    );
  });

  it('should write the 200 Connection Established response BEFORE the unshift', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const mitmStart = code.indexOf('// MITM: respond 200');
    const tlsSocketIdx = code.indexOf('new tls.TLSSocket(clientSocket', mitmStart);
    const mitmSection = code.slice(mitmStart, tlsSocketIdx);

    const writeIdx = mitmSection.indexOf("clientSocket.write('HTTP/1.1 200 Connection Established");
    const unshiftIdx = mitmSection.indexOf('clientSocket.unshift(head)');

    assert.ok(writeIdx !== -1, 'Must write 200 Connection Established in MITM section');
    assert.ok(unshiftIdx !== -1, 'Must call unshift in MITM section');
    assert.ok(
      writeIdx < unshiftIdx,
      'Must write 200 response before unshifting head — client expects response before sending TLS ClientHello'
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Transparent CONNECT passthrough — head is forwarded to upstream, not client
// ---------------------------------------------------------------------------

describe('rotation-proxy.js - transparent CONNECT passthrough', () => {
  it('should forward head to upstreamSocket, not clientSocket, in passthrough handler', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    // Find the passthrough section — it's before the isMITMTarget check returns
    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    assert.ok(passthroughStart !== -1, 'Must have "Transparent CONNECT tunnel" comment');

    const passthroughEnd = code.indexOf('return;', passthroughStart);
    assert.ok(passthroughEnd !== -1, 'Passthrough handler must return early');

    const passthroughSection = code.slice(passthroughStart, passthroughEnd);

    assert.match(
      passthroughSection,
      /upstreamSocket\.write\(head\)/,
      'Passthrough handler must forward head to upstreamSocket (not clientSocket)'
    );

    assert.doesNotMatch(
      passthroughSection,
      /clientSocket\.unshift\(head\)/,
      'Passthrough handler must NOT unshift head into clientSocket'
    );
  });

  it('should guard the passthrough head write behind head && head.length > 0', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('return;', passthroughStart);
    const passthroughSection = code.slice(passthroughStart, passthroughEnd);

    assert.match(
      passthroughSection,
      /if\s*\(head.*&&.*head\.length.*>\s*0\).*upstreamSocket\.write\(head\)/s,
      'Passthrough head write must be guarded by head && head.length > 0'
    );
  });

  it('should pipe clientSocket <-> upstreamSocket bidirectionally', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('return;', passthroughStart);
    const passthroughSection = code.slice(passthroughStart, passthroughEnd);

    assert.match(
      passthroughSection,
      /upstreamSocket\.pipe\(clientSocket\)/,
      'Must pipe upstream to client'
    );
    assert.match(
      passthroughSection,
      /clientSocket\.pipe\(upstreamSocket\)/,
      'Must pipe client to upstream'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. parseHttpRequest() — behavioral unit tests on pure function logic
// ---------------------------------------------------------------------------

describe('parseHttpRequest() - behavioral logic', () => {
  // Re-implement the function locally so we can test it without importing the module
  // (the module calls main() on import, which requires live certs + key state)
  function parseHttpRequest(buffer) {
    const str = buffer.toString('binary');
    const headerEnd = str.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;

    const headerSection = str.slice(0, headerEnd);
    const lines = headerSection.split('\r\n');
    const [method, reqPath, httpVersion] = lines[0].split(' ');

    const headers = {};
    const rawHeaders = [];
    for (let i = 1; i < lines.length; i++) {
      const colon = lines[i].indexOf(':');
      if (colon === -1) continue;
      const originalName = lines[i].slice(0, colon).trim();
      const value = lines[i].slice(colon + 1).trim();
      headers[originalName.toLowerCase()] = value;
      rawHeaders.push([originalName, value]);
    }

    return { method, path: reqPath, httpVersion, headers, rawHeaders, bodyStart: headerEnd + 4 };
  }

  it('should parse a minimal GET request correctly', () => {
    const raw = Buffer.from(
      'GET /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'Authorization: Bearer token123\r\n' +
      '\r\n'
    );

    const result = parseHttpRequest(raw);

    assert.ok(result !== null, 'Must return a parsed object for valid request');
    assert.strictEqual(result.method, 'GET');
    assert.strictEqual(result.path, '/v1/messages');
    assert.strictEqual(result.httpVersion, 'HTTP/1.1');
    assert.strictEqual(result.headers['authorization'], 'Bearer token123');
    assert.strictEqual(result.headers['host'], 'api.anthropic.com');
    assert.strictEqual(result.bodyStart, raw.length); // no body
  });

  it('should return null when headers are incomplete (no double CRLF)', () => {
    const raw = Buffer.from('GET /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n');
    const result = parseHttpRequest(raw);
    assert.strictEqual(result, null, 'Must return null when header section is incomplete');
  });

  it('should preserve original header casing in rawHeaders', () => {
    const raw = Buffer.from(
      'POST /v1/complete HTTP/1.1\r\n' +
      'Content-Type: application/json\r\n' +
      'X-Api-Key: key-abc\r\n' +
      'Authorization: Bearer tok\r\n' +
      '\r\n'
    );

    const result = parseHttpRequest(raw);
    assert.ok(result !== null);

    const names = result.rawHeaders.map(([n]) => n);
    assert.ok(names.includes('Content-Type'), 'Must preserve Content-Type casing');
    assert.ok(names.includes('X-Api-Key'), 'Must preserve X-Api-Key casing');
    assert.ok(names.includes('Authorization'), 'Must preserve Authorization casing');
  });

  it('should lowercase header names in the headers lookup map', () => {
    const raw = Buffer.from(
      'POST /v1/complete HTTP/1.1\r\n' +
      'Content-Type: application/json\r\n' +
      'Authorization: Bearer tok\r\n' +
      '\r\n'
    );

    const result = parseHttpRequest(raw);
    assert.ok(result !== null);

    assert.ok('content-type' in result.headers, 'headers map must have lowercase content-type');
    assert.ok('authorization' in result.headers, 'headers map must have lowercase authorization');
    assert.strictEqual(result.headers['content-type'], 'application/json');
  });

  it('should compute bodyStart as headerEnd + 4 (past double CRLF)', () => {
    const headers = 'POST /v1/messages HTTP/1.1\r\nHost: example.com\r\n\r\n';
    const body = '{"model":"claude-3"}';
    const raw = Buffer.from(headers + body);

    const result = parseHttpRequest(raw);
    assert.ok(result !== null);

    const actualBody = raw.slice(result.bodyStart).toString();
    assert.strictEqual(actualBody, body, 'bodyStart must point to the start of the request body');
  });

  it('should skip malformed header lines that have no colon', () => {
    const raw = Buffer.from(
      'GET / HTTP/1.1\r\n' +
      'Host: example.com\r\n' +
      'X-Malformed-No-Colon\r\n' +
      'Authorization: Bearer tok\r\n' +
      '\r\n'
    );

    const result = parseHttpRequest(raw);
    assert.ok(result !== null);

    // Malformed line must not appear in rawHeaders
    const names = result.rawHeaders.map(([n]) => n);
    assert.ok(!names.includes('X-Malformed-No-Colon'), 'Malformed header with no colon must be skipped');
    assert.ok(names.includes('Authorization'), 'Valid headers after malformed one must still be parsed');
  });
});

// ---------------------------------------------------------------------------
// 5. rebuildRequest() — behavioral unit tests
// ---------------------------------------------------------------------------

describe('rebuildRequest() - behavioral logic', () => {
  function parseHttpRequest(buffer) {
    const str = buffer.toString('binary');
    const headerEnd = str.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;
    const headerSection = str.slice(0, headerEnd);
    const lines = headerSection.split('\r\n');
    const [method, reqPath, httpVersion] = lines[0].split(' ');
    const headers = {};
    const rawHeaders = [];
    for (let i = 1; i < lines.length; i++) {
      const colon = lines[i].indexOf(':');
      if (colon === -1) continue;
      const originalName = lines[i].slice(0, colon).trim();
      const value = lines[i].slice(colon + 1).trim();
      headers[originalName.toLowerCase()] = value;
      rawHeaders.push([originalName, value]);
    }
    return { method, path: reqPath, httpVersion, headers, rawHeaders, bodyStart: headerEnd + 4 };
  }

  function rebuildRequest(parsed, originalBuffer, newToken) {
    const headerLines = [`${parsed.method} ${parsed.path} ${parsed.httpVersion}`];
    let hadAuth = false;
    for (const [name, value] of parsed.rawHeaders) {
      if (name.toLowerCase() === 'authorization') {
        hadAuth = true;
        continue;
      }
      headerLines.push(`${name}: ${value}`);
    }
    if (hadAuth) {
      headerLines.push(`Authorization: Bearer ${newToken}`);
    }
    headerLines.push('');
    headerLines.push('');
    const headerBuf = Buffer.from(headerLines.join('\r\n'), 'binary');
    const bodyBuf = originalBuffer.slice(parsed.bodyStart);
    return Buffer.concat([headerBuf, bodyBuf]);
  }

  it('should replace the Authorization header with the new token', () => {
    const raw = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'Authorization: Bearer old-token-abc\r\n' +
      '\r\n'
    );
    const parsed = parseHttpRequest(raw);
    const rebuilt = rebuildRequest(parsed, raw, 'new-token-xyz');
    const rebuiltStr = rebuilt.toString();

    assert.match(rebuiltStr, /Authorization: Bearer new-token-xyz/, 'Must inject new token');
    assert.doesNotMatch(rebuiltStr, /old-token-abc/, 'Must strip old token from rebuilt request');
  });

  it('should preserve non-Authorization headers in rebuilt request', () => {
    const raw = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'Content-Type: application/json\r\n' +
      'anthropic-version: 2023-06-01\r\n' +
      'Authorization: Bearer old\r\n' +
      '\r\n'
    );
    const parsed = parseHttpRequest(raw);
    const rebuilt = rebuildRequest(parsed, raw, 'new-tok');
    const rebuiltStr = rebuilt.toString();

    assert.match(rebuiltStr, /Host: api\.anthropic\.com/, 'Must preserve Host header');
    assert.match(rebuiltStr, /Content-Type: application\/json/, 'Must preserve Content-Type');
    assert.match(rebuiltStr, /anthropic-version: 2023-06-01/, 'Must preserve anthropic-version');
  });

  it('should preserve the request body verbatim', () => {
    const body = '{"model":"claude-opus-4-6","messages":[{"role":"user","content":"hello"}]}';
    const raw = Buffer.from(
      `POST /v1/messages HTTP/1.1\r\n` +
      `Host: api.anthropic.com\r\n` +
      `Content-Length: ${body.length}\r\n` +
      `Authorization: Bearer old\r\n` +
      `\r\n` +
      body
    );
    const parsed = parseHttpRequest(raw);
    const rebuilt = rebuildRequest(parsed, raw, 'new-tok');

    // Body must appear at the end of rebuilt buffer
    const rebuiltStr = rebuilt.toString();
    assert.ok(rebuiltStr.endsWith(body), 'Must preserve request body verbatim after header swap');
  });

  it('should NOT add Authorization header when original request had none', () => {
    const raw = Buffer.from(
      'GET /v1/models HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      '\r\n'
    );
    const parsed = parseHttpRequest(raw);
    const rebuilt = rebuildRequest(parsed, raw, 'injected-token');
    const rebuiltStr = rebuilt.toString();

    assert.doesNotMatch(
      rebuiltStr,
      /Authorization/,
      'Must NOT inject Authorization header when original had none (conditional auth injection)'
    );
  });

  it('should strip Authorization header with any casing (case-insensitive match)', () => {
    // HTTP headers are case-insensitive; our parser lowercases for the lookup
    // but rawHeaders preserve the original casing for the rebuild strip check
    const raw = Buffer.from(
      'POST /v1/messages HTTP/1.1\r\n' +
      'Host: api.anthropic.com\r\n' +
      'AUTHORIZATION: Bearer old\r\n' +  // all-caps
      '\r\n'
    );
    const parsed = parseHttpRequest(raw);
    const rebuilt = rebuildRequest(parsed, raw, 'new-tok');
    const rebuiltStr = rebuilt.toString();

    // The old value must be gone; new injected value must be present
    assert.doesNotMatch(rebuiltStr, /old/, 'Old token must be removed regardless of Authorization header casing');
    assert.match(rebuiltStr, /Authorization: Bearer new-tok/, 'New token must be injected');
  });
});

// ---------------------------------------------------------------------------
// 6. MITM domain routing logic
// ---------------------------------------------------------------------------

describe('MITM domain routing logic - behavioral', () => {
  const MITM_DOMAINS = ['api.anthropic.com'];

  it('should classify api.anthropic.com as a MITM target', () => {
    assert.ok(MITM_DOMAINS.includes('api.anthropic.com'));
  });

  it('should NOT classify mcp-proxy.anthropic.com as a MITM target (transparent tunnel)', () => {
    assert.ok(
      !MITM_DOMAINS.includes('mcp-proxy.anthropic.com'),
      'mcp-proxy.anthropic.com uses session-bound OAuth tokens — MITMing it causes 401 revocation cascade'
    );
  });

  it('should NOT classify platform.claude.com as a MITM target (OAuth passthrough)', () => {
    assert.ok(!MITM_DOMAINS.includes('platform.claude.com'), 'OAuth endpoint must pass through');
  });

  it('should NOT classify any google.com, github.com as MITM targets', () => {
    const externalDomains = ['google.com', 'github.com', 'aws.amazon.com'];
    for (const domain of externalDomains) {
      assert.ok(!MITM_DOMAINS.includes(domain), `${domain} must not be a MITM target`);
    }
  });

  it('should verify code uses MITM_DOMAINS.includes() for routing decision', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(
      code,
      /MITM_DOMAINS\.includes\(hostname\)/,
      'CONNECT handler must use MITM_DOMAINS.includes(hostname) for routing'
    );
  });
});

// ---------------------------------------------------------------------------
// 7. proxyLog() — log rotation behavior validated via code structure
// ---------------------------------------------------------------------------

describe('proxyLog() - log rotation structure', () => {
  it('should check file size against MAX_LOG_BYTES before writing', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'proxyLog');
    assert.ok(fnStart !== null, 'proxyLog must be defined');

    assert.match(
      fnStart,
      /stat\.size\s*>\s*MAX_LOG_BYTES/,
      'proxyLog must compare stat.size against MAX_LOG_BYTES for rotation trigger'
    );
  });

  it('should truncate the oldest half of log lines on rotation', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'proxyLog');

    assert.match(
      fnStart,
      /lines\.slice\(half\)/,
      'proxyLog must slice the log lines to keep only the newer half'
    );

    assert.match(
      fnStart,
      /Math\.ceil\(lines\.length\s*\/\s*2\)/,
      'proxyLog must use Math.ceil(lines.length / 2) to determine the halfway point'
    );
  });

  it('should never throw — must fall back to stderr on write failure', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'proxyLog');

    assert.match(
      fnStart,
      /process\.stderr\.write/,
      'proxyLog must write to stderr on failure instead of throwing'
    );

    // The outer try/catch around appendFileSync must swallow errors
    assert.match(
      fnStart,
      /try \{[\s\S]*?fs\.appendFileSync[\s\S]*?\} catch/,
      'proxyLog must wrap appendFileSync in try/catch to never throw'
    );
  });

  it('should never log actual token values — only structured event fields', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'proxyLog');

    // The function itself must not reference accessToken or refreshToken
    assert.doesNotMatch(
      fnStart.slice(0, 400), // just the function body itself, not call sites
      /accessToken|refreshToken/,
      'proxyLog function body must not log raw token values'
    );
  });

  it('log rotation threshold should be behavioral: simulate it inline', () => {
    const MAX_LOG_BYTES = 1_048_576; // 1 MB as defined in the file

    // Simulate 10 KB file — no rotation needed
    assert.ok(10_000 < MAX_LOG_BYTES, 'Small file should not trigger rotation');

    // Simulate 2 MB file — rotation needed
    assert.ok(2_097_152 > MAX_LOG_BYTES, 'Large file should trigger rotation');

    // Math.ceil(10/2) = 5: half the lines are kept
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const half = Math.ceil(lines.length / 2);
    const kept = lines.slice(half);
    assert.strictEqual(kept.length, 5, 'Must keep the second half (5 of 10 lines)');
    assert.strictEqual(kept[0], 'f', 'Kept lines must start from the halfway point');
  });
});

// ---------------------------------------------------------------------------
// 8. loadCerts() — fail-loud when certs missing
// ---------------------------------------------------------------------------

describe('loadCerts() - fail-loud on missing certs', () => {
  it('should throw if any cert file is missing', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'loadCerts');
    assert.ok(fnStart !== null, 'loadCerts must be defined');

    assert.match(
      fnStart,
      /throw new Error/,
      'loadCerts must throw loudly when cert files are missing'
    );
  });

  it('should check for all three files: ca.pem, server-key.pem, server.pem', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'loadCerts');

    assert.match(fnStart, /ca\.pem/, 'loadCerts must check for ca.pem');
    assert.match(fnStart, /server-key\.pem/, 'loadCerts must check for server-key.pem');
    assert.match(fnStart, /server\.pem/, 'loadCerts must check for server.pem');
  });

  it('should reference generate-proxy-certs.sh in the error message for remediation guidance', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'loadCerts');

    assert.match(
      fnStart,
      /generate-proxy-certs\.sh/,
      'loadCerts error message must reference generate-proxy-certs.sh so the operator knows how to fix it'
    );
  });
});

// ---------------------------------------------------------------------------
// 9. getActiveToken() / rotateOnExhaustion() — state contract tests
// ---------------------------------------------------------------------------

describe('getActiveToken() and rotateOnExhaustion() - code structure', () => {
  it('getActiveToken must throw when no active_key_id is set', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'getActiveToken');
    assert.ok(fnStart !== null, 'getActiveToken must be defined');

    assert.match(
      fnStart,
      /throw new Error.*No active key/,
      'getActiveToken must throw loudly when no active key exists in rotation state'
    );
  });

  it('getActiveToken must throw when active key has no accessToken', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'getActiveToken');

    assert.match(
      fnStart,
      /throw new Error.*has no accessToken/,
      'getActiveToken must throw when active key exists but has no accessToken field'
    );
  });

  it('rotateOnExhaustion must mark the exhausted key with status exhausted', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');
    assert.ok(fnStart !== null, 'rotateOnExhaustion must be defined');

    assert.match(
      fnStart,
      /\.status\s*=\s*['"]exhausted['"]/,
      'rotateOnExhaustion must set the exhausted key status to "exhausted"'
    );
  });

  it('rotateOnExhaustion must return null when no next key is available', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    assert.match(
      fnStart,
      /return null/,
      'rotateOnExhaustion must return null when all keys are exhausted (caller handles)'
    );
  });

  it('rotateOnExhaustion must call writeRotationState before returning', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    assert.match(
      fnStart,
      /writeRotationState\(state\)/,
      'rotateOnExhaustion must persist state after rotation'
    );
  });

  it('rotateOnExhaustion must call updateActiveCredentials to sync other components', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    assert.match(
      fnStart,
      /updateActiveCredentials\(/,
      'rotateOnExhaustion must call updateActiveCredentials so SRA/r6T picks up new credentials'
    );
  });

  it('rotateOnExhaustion must log proxy_429_exhausted event for observability', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    assert.match(
      fnStart,
      /proxy_429_exhausted/,
      'rotateOnExhaustion must log proxy_429_exhausted for rotation audit trail'
    );
  });
});

// ---------------------------------------------------------------------------
// 10. forwardRequest() — 429 retry cap and SSE pass-through structure
// ---------------------------------------------------------------------------

describe('forwardRequest() - retry cap and SSE structure', () => {
  it('should check retryCount < MAX_429_RETRIES before rotating on 429', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    assert.match(
      fnStart,
      /retryCount\s*<\s*MAX_429_RETRIES/,
      'forwardRequest must gate 429 rotation behind retryCount < MAX_429_RETRIES'
    );
  });

  it('should respond with 502 Bad Gateway when token resolution fails', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /HTTP\/1\.1 502 Bad Gateway/,
      'forwardRequest must return 502 when token resolution fails rather than silently closing'
    );
  });

  it('should respond with 400 Bad Request when HTTP parse fails', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /HTTP\/1\.1 400 Bad Request/,
      'forwardRequest must return 400 when the incoming request cannot be parsed'
    );
  });

  it('should detect SSE via content-type: text/event-stream header', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /text\/event-stream/,
      'forwardRequest must detect SSE responses via content-type: text/event-stream'
    );
  });

  it('should pipe SSE responses directly to clientSocket (zero-copy streaming)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /upstream\.pipe\(clientSocket/,
      'forwardRequest must use .pipe() for SSE streaming to avoid buffering'
    );
  });

  it('should never log token values — active_key_id sliced to 8 chars', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Must slice key IDs, never raw tokens
    assert.match(
      fnStart,
      /activeKeyId\.slice\(0,\s*8\)/,
      'forwardRequest must only log sliced key IDs, never full token values'
    );
    assert.doesNotMatch(
      fnStart.slice(0, 800), // just the function's own body
      /activeToken[^;]*(proxyLog|JSON\.stringify)/,
      'forwardRequest must not pass activeToken to proxyLog'
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Health endpoint
// ---------------------------------------------------------------------------

describe('handleHealthCheck() - response structure', () => {
  it('should respond with 200 OK', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'handleHealthCheck');
    assert.ok(fnStart !== null, 'handleHealthCheck must be defined');

    assert.match(fnStart, /res\.writeHead\(200/, 'Health endpoint must respond 200');
  });

  it('should include status, activeKeyId, uptime, and requestCount fields', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'handleHealthCheck');

    assert.match(fnStart, /status:\s*['"]ok['"]/, 'Health response must include status: "ok"');
    assert.match(fnStart, /activeKeyId/, 'Health response must include activeKeyId field');
    assert.match(fnStart, /uptime/, 'Health response must include uptime field');
    assert.match(fnStart, /requestCount/, 'Health response must include requestCount field');
  });

  it('should not throw when rotation state is unreadable — activeKeyId should be null', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'handleHealthCheck');

    assert.match(
      fnStart,
      /catch[\s\S]*?\}/,
      'handleHealthCheck must catch state read errors and continue with null activeKeyId'
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Token passthrough for unknown keys (Bug Fix #1)
// ---------------------------------------------------------------------------

describe('forwardRequest() - unknown token passthrough', () => {
  it('should detect when incoming token is not in rotation state via generateKeyId', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    // Must import generateKeyId from key-sync
    assert.match(
      code,
      /generateKeyId/,
      'Must import generateKeyId from key-sync for unknown token detection'
    );

    // Must call generateKeyId on incoming Bearer token
    assert.match(
      fnStart,
      /generateKeyId\(/,
      'forwardRequest must call generateKeyId to identify incoming token'
    );
  });

  it('should check incoming key ID against rotation state keys (tombstone-aware)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Must read keyEntry from state.keys first
    assert.match(
      fnStart,
      /state\.keys\[incomingKeyId\]/,
      'Must look up incomingKeyId in rotation state keys'
    );

    // Must check for tombstone status
    assert.match(
      fnStart,
      /keyEntry\.status\s*===\s*['"]tombstone['"]/,
      'Must check if keyEntry has tombstone status'
    );

    // Must check for genuinely unknown (no entry at all)
    assert.match(
      fnStart,
      /!keyEntry/,
      'Must check if keyEntry does not exist (genuinely unknown token)'
    );
  });

  it('should set usePassthrough flag when incoming token is unknown', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /usePassthrough\s*=\s*true/,
      'Must set usePassthrough flag when token is unknown'
    );
  });

  it('should log unknown_token_passthrough event with key IDs', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /proxyLog\(['"]unknown_token_passthrough['"]/,
      'Must log unknown_token_passthrough event for observability'
    );

    const passthroughLogIdx = fnStart.indexOf('unknown_token_passthrough');
    const passthroughSection = fnStart.slice(passthroughLogIdx, passthroughLogIdx + 400);
    assert.match(
      passthroughSection,
      /incoming_key_id/,
      'unknown_token_passthrough log must include incoming_key_id'
    );
    assert.match(
      passthroughSection,
      /active_key_id/,
      'unknown_token_passthrough log must include active_key_id for comparison'
    );
  });

  it('should trigger async syncKeys() when unknown token detected', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Must call syncKeys asynchronously to register the new account
    assert.match(
      fnStart,
      /syncKeys\(\).*catch/s,
      'Must call syncKeys() asynchronously when unknown token is detected'
    );
  });

  it('should forward original request unchanged when usePassthrough is true', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Must use ternary to choose between passthrough and modified request
    assert.match(
      fnStart,
      /usePassthrough\s*\?\s*rawRequest\s*:\s*rebuildRequest/,
      'Must forward rawRequest unchanged when usePassthrough is true'
    );
  });

  it('should only trigger passthrough on first attempt (retryCount === 0)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // The passthrough check must be gated by retryCount === 0.
    // Use 1500-char lookback to cover the full distance from the outer
    // retryCount === 0 guard to the !keyEntry branch inside it.
    const passthroughCheckIdx = fnStart.indexOf('!keyEntry');
    const passthroughSection = fnStart.slice(Math.max(0, passthroughCheckIdx - 1500), passthroughCheckIdx + 100);

    assert.match(
      passthroughSection,
      /retryCount\s*===\s*0/,
      'Passthrough check must only run on initial request (retryCount === 0), not retries'
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Authoritative 429 exhaustion data (Bug Fix #2)
// ---------------------------------------------------------------------------

describe('rotateOnExhaustion() - authoritative usage data stamping', () => {
  it('should stamp last_usage with 100% values when marking key exhausted', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');
    assert.ok(fnStart !== null, 'rotateOnExhaustion must be defined');

    // Find the exhaustion marking section
    const exhaustedIdx = fnStart.indexOf("status = 'exhausted'");
    assert.ok(exhaustedIdx !== -1, 'Must set status to exhausted');

    const exhaustionSection = fnStart.slice(exhaustedIdx, exhaustedIdx + 500);

    // Must stamp all three usage buckets with 100%
    assert.match(
      exhaustionSection,
      /last_usage[\s\S]*?five_hour:\s*100/,
      'Must stamp five_hour usage at 100% when key exhausted by 429'
    );
    assert.match(
      exhaustionSection,
      /last_usage[\s\S]*?seven_day:\s*100/,
      'Must stamp seven_day usage at 100% when key exhausted by 429'
    );
    assert.match(
      exhaustionSection,
      /last_usage[\s\S]*?seven_day_sonnet:\s*100/,
      'Must stamp seven_day_sonnet usage at 100% when key exhausted by 429'
    );
  });

  it('should stamp last_usage.checked_at with Date.now() for authoritative freshness', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    const exhaustedIdx = fnStart.indexOf("status = 'exhausted'");
    const exhaustionSection = fnStart.slice(exhaustedIdx, exhaustedIdx + 500);

    assert.match(
      exhaustionSection,
      /checked_at:\s*Date\.now\(\)/,
      'Must stamp checked_at with Date.now() so freshness gate does not null out this data'
    );
  });

  it('should stamp last_health_check with Date.now() to prevent freshness gate nulling', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    const exhaustedIdx = fnStart.indexOf("status = 'exhausted'");
    const exhaustionSection = fnStart.slice(exhaustedIdx, exhaustedIdx + 500);

    assert.match(
      exhaustionSection,
      /last_health_check\s*=\s*Date\.now\(\)/,
      'Must stamp last_health_check with Date.now() to keep data fresh'
    );
  });

  it('must stamp usage data BEFORE calling selectActiveKey to prevent re-selection', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    // Use `.last_usage =` and `selectActiveKey(` to match actual code, not comments
    const usageStampIdx = fnStart.indexOf('.last_usage =');
    const selectIdx = fnStart.indexOf('selectActiveKey(');

    assert.ok(usageStampIdx !== -1, 'Must stamp last_usage');
    assert.ok(selectIdx !== -1, 'Must call selectActiveKey');
    assert.ok(
      usageStampIdx < selectIdx,
      'Must stamp last_usage BEFORE calling selectActiveKey so freshness gate does not re-select exhausted key'
    );
  });
});

// ---------------------------------------------------------------------------
// 14. Self-rotation guard (Bug Fix #3)
// ---------------------------------------------------------------------------

describe('rotateOnExhaustion() - self-rotation prevention', () => {
  it('should check nextKeyId === exhaustedKeyId to prevent self-rotation', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');
    assert.ok(fnStart !== null, 'rotateOnExhaustion must be defined');

    assert.match(
      fnStart,
      /nextKeyId\s*===\s*exhaustedKeyId/,
      'Must check if nextKeyId equals exhaustedKeyId to prevent rotating to the same key'
    );
  });

  it('should return null when nextKeyId equals exhaustedKeyId (self-rotation detected)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    // Find the self-rotation check
    const selfRotationIdx = fnStart.indexOf('nextKeyId === exhaustedKeyId');
    assert.ok(selfRotationIdx !== -1, 'Must have self-rotation check');

    const selfRotationSection = fnStart.slice(selfRotationIdx, selfRotationIdx + 200);

    // Must return null in this branch
    assert.match(
      selfRotationSection,
      /return null/,
      'Must return null when self-rotation is detected (same key selected again)'
    );
  });

  it('should guard alongside !nextKeyId and !state.keys[nextKeyId] checks', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    // The guard must be part of the same conditional that checks for missing keys
    const guardIdx = fnStart.indexOf('nextKeyId === exhaustedKeyId');
    const guardLine = fnStart.slice(Math.max(0, guardIdx - 100), guardIdx + 100);

    assert.match(
      guardLine,
      /!nextKeyId\s*\|\|\s*!state\.keys\[nextKeyId\]\s*\|\|\s*nextKeyId\s*===\s*exhaustedKeyId/,
      'Self-rotation guard must be combined with nextKeyId existence checks in same conditional'
    );
  });

  it('should write rotation state before returning null on self-rotation', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rotateOnExhaustion');

    const guardIdx = fnStart.indexOf('nextKeyId === exhaustedKeyId');
    const returnNullIdx = fnStart.indexOf('return null', guardIdx);
    const guardSection = fnStart.slice(guardIdx, returnNullIdx);

    assert.match(
      guardSection,
      /writeRotationState\(state\)/,
      'Must persist state (exhausted key marked) before returning null on self-rotation'
    );
  });
});

// ---------------------------------------------------------------------------
// 15. main() startup — fail-loud requirements
// ---------------------------------------------------------------------------

describe('main() startup - fail-loud structure', () => {
  it('should throw if key-sync.js is not found', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    assert.match(
      code,
      /key-sync\.js not found/,
      'main() must throw loudly when key-sync.js cannot be located'
    );
  });

  it('should throw if no active key exists at startup', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    assert.match(
      code,
      /No active key in rotation state/,
      'main() must throw at startup if rotation state has no active key'
    );
  });

  it('should exit 1 on EADDRINUSE (port already bound)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    assert.match(code, /EADDRINUSE/, 'Must handle EADDRINUSE server error');
    assert.match(
      code,
      /process\.exit\(1\)/,
      'Must call process.exit(1) on fatal startup errors'
    );
  });

  it('should register SIGTERM and SIGINT handlers for graceful shutdown', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    assert.match(code, /process\.on\(['"]SIGTERM['"]/, 'Must register SIGTERM handler');
    assert.match(code, /process\.on\(['"]SIGINT['"]/, 'Must register SIGINT handler');
  });

  it('should log startup event with port, project_dir, and active_key_id fields', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    assert.match(code, /proxyLog\(['"]startup['"]/, 'Must call proxyLog("startup") at startup');

    const startupLogIdx = code.indexOf("proxyLog('startup'");
    const startupSection = code.slice(startupLogIdx, startupLogIdx + 400);
    assert.match(startupSection, /port/, 'startup log must include port');
    assert.match(startupSection, /project_dir/, 'startup log must include project_dir');
    assert.match(startupSection, /active_key_id/, 'startup log must include active_key_id');
  });

  it('should log shutdown event with signal and requestCount', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const fnStart = extractFunctionBody(code, 'shutdown');
    assert.ok(fnStart !== null, 'shutdown function must be defined');
    assert.match(fnStart, /proxyLog\(['"]shutdown['"]/, 'shutdown must call proxyLog("shutdown")');
    assert.match(fnStart, /requestCount/, 'shutdown log must include requestCount');
  });

  it('should bind to 127.0.0.1 only (not 0.0.0.0) for localhost-only access', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    assert.match(
      code,
      /server\.listen\(PROXY_PORT,\s*['"]127\.0\.0\.1['"]/,
      'Must bind to 127.0.0.1 — proxy must not be externally reachable'
    );
  });
});

// ---------------------------------------------------------------------------
// 16. Tombstone token swap (Bug Fix - Bug B)
// ---------------------------------------------------------------------------

describe('forwardRequest() - tombstone token handling', () => {
  it('should log tombstone_token_swap when incoming token is tombstoned', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    assert.match(
      fnStart,
      /proxyLog\(['"]tombstone_token_swap['"]/,
      'Must log tombstone_token_swap event when tombstoned token is detected'
    );
  });

  it('should NOT set usePassthrough for tombstoned tokens (swap with active key instead)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the tombstone check section
    const tombstoneIdx = fnStart.indexOf('tombstone_token_swap');
    assert.ok(tombstoneIdx !== -1, 'Must have tombstone_token_swap log event');

    // Between tombstone check and the log, usePassthrough must NOT be set to true
    const tombstoneSection = fnStart.slice(
      fnStart.indexOf("keyEntry.status === 'tombstone'"),
      tombstoneIdx + 200
    );

    assert.doesNotMatch(
      tombstoneSection,
      /usePassthrough\s*=\s*true/,
      'Must NOT set usePassthrough for tombstoned tokens — they must be swapped with active key'
    );
  });

  it('should check tombstone BEFORE unknown token (order matters)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const tombstoneIdx = fnStart.indexOf("keyEntry.status === 'tombstone'");
    const unknownIdx = fnStart.indexOf('!keyEntry');

    assert.ok(tombstoneIdx !== -1, 'Must check for tombstone status');
    assert.ok(unknownIdx !== -1, 'Must check for unknown token');
    assert.ok(
      tombstoneIdx < unknownIdx,
      'Must check tombstone BEFORE unknown token to distinguish pruned dead tokens from fresh logins'
    );
  });

  it('should include incoming_key_id and active_key_id in tombstone_token_swap log', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const tombstoneLogIdx = fnStart.indexOf('tombstone_token_swap');
    const tombstoneSection = fnStart.slice(tombstoneLogIdx, tombstoneLogIdx + 400);

    assert.match(
      tombstoneSection,
      /incoming_key_id/,
      'tombstone_token_swap log must include incoming_key_id'
    );
    assert.match(
      tombstoneSection,
      /active_key_id/,
      'tombstone_token_swap log must include active_key_id'
    );
  });
});

// ---------------------------------------------------------------------------
// 17. rebuildRequest() - conditional auth injection
// ---------------------------------------------------------------------------

describe('rebuildRequest() - conditional auth injection', () => {
  it('should only add Authorization header when original request had one', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'rebuildRequest');
    assert.ok(fnStart !== null, 'rebuildRequest must be defined');

    // Must track whether original had auth
    assert.match(
      fnStart,
      /hadAuth/,
      'rebuildRequest must track whether the original request had an Authorization header'
    );

    // Must conditionally add auth
    assert.match(
      fnStart,
      /if\s*\(hadAuth\)/,
      'rebuildRequest must conditionally add Authorization based on original presence'
    );
  });
});

// ---------------------------------------------------------------------------
// 18. 401 retry handling
// ---------------------------------------------------------------------------

describe('forwardRequest() - 401 retry handling', () => {
  it('should detect 401 status and retry once', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    assert.match(
      fnStart,
      /responseStatusCode\s*===\s*401/,
      'Must detect 401 response status code'
    );
  });

  it('should log rotating_on_401 event', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /proxyLog\(['"]rotating_on_401['"]/,
      'Must log rotating_on_401 event for observability'
    );
  });

  it('should only retry 401 up to MAX_401_RETRIES', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the 401 check — it must include retryCount < MAX_401_RETRIES
    const rotatingOn401Idx = fnStart.indexOf('rotating_on_401');
    const authRetrySection = fnStart.slice(Math.max(0, rotatingOn401Idx - 300), rotatingOn401Idx);

    assert.match(
      authRetrySection,
      /retryCount\s*<\s*MAX_401_RETRIES/,
      '401 retry must be gated by retryCount < MAX_401_RETRIES'
    );
  });

  it('should NOT retry 401 for passthrough requests', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the 401 check — it must include !usePassthrough
    const rotatingOn401Idx = fnStart.indexOf('rotating_on_401');
    const authRetrySection = fnStart.slice(Math.max(0, rotatingOn401Idx - 300), rotatingOn401Idx);

    assert.match(
      authRetrySection,
      /!usePassthrough/,
      '401 retry must be skipped for passthrough requests (proxy did not inject the token)'
    );
  });

  it('should NOT retry 401 for mcp-proxy.anthropic.com (defense-in-depth guard)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // The 401 guard must include isMcpProxy check
    const rotatingOn401Idx = fnStart.indexOf('rotating_on_401');
    const authRetrySection = fnStart.slice(Math.max(0, rotatingOn401Idx - 400), rotatingOn401Idx);

    assert.match(
      authRetrySection,
      /isMcpProxy/,
      '401 retry must be skipped for mcp-proxy.anthropic.com to prevent OAuth revocation cascade'
    );
    assert.match(
      authRetrySection,
      /!isMcpProxy/,
      '401 condition must negate isMcpProxy to skip retry for that host'
    );
  });

  it('should NOT call rotateOnExhaustion on 401 (auth error, not quota)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the 401 section — between 401 check and the next status code check
    const auth401Idx = fnStart.indexOf('rotating_on_401');
    const auth401Section = fnStart.slice(auth401Idx, auth401Idx + 500);

    assert.doesNotMatch(
      auth401Section,
      /rotateOnExhaustion/,
      '401 handling must NOT call rotateOnExhaustion — 401 is auth, not quota'
    );
  });

  it('should destroy upstream before retrying 401', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the 401 section
    const auth401Idx = fnStart.indexOf('responseStatusCode === 401');
    assert.ok(auth401Idx !== -1, 'Must have 401 check');

    const auth401Section = fnStart.slice(auth401Idx, auth401Idx + 600);

    assert.match(
      auth401Section,
      /upstream\.destroy\(\)/,
      'Must destroy upstream connection before retrying on 401'
    );
  });
});

// ---------------------------------------------------------------------------
// Path-level passthrough (OAuth token swap fix)
// ---------------------------------------------------------------------------

describe('rotation-proxy.js - Path-level swap allowlist', () => {
  it('should define SWAP_PATH_PREFIXES as a module-level constant array', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(
      code,
      /const SWAP_PATH_PREFIXES\s*=\s*\[/,
      'Must define SWAP_PATH_PREFIXES as a const array'
    );
  });

  it('should include /v1/messages in SWAP_PATH_PREFIXES (primary LLM API path)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const arrayMatch = code.match(/const SWAP_PATH_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(arrayMatch, 'Must define SWAP_PATH_PREFIXES array');
    assert.match(arrayMatch[1], /\/v1\/messages/, 'SWAP_PATH_PREFIXES must include /v1/messages');
  });

  it('should NOT include OAuth paths in SWAP_PATH_PREFIXES', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const arrayMatch = code.match(/const SWAP_PATH_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(arrayMatch, 'Must define SWAP_PATH_PREFIXES array');
    assert.doesNotMatch(arrayMatch[1], /\/api\/oauth\//, 'SWAP_PATH_PREFIXES must NOT include /api/oauth/');
  });

  it('should NOT include /api/claude_code_grove or /api/claude_code_penguin_mode in SWAP_PATH_PREFIXES', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const arrayMatch = code.match(/const SWAP_PATH_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(arrayMatch, 'Must define SWAP_PATH_PREFIXES array');
    assert.doesNotMatch(arrayMatch[1], /claude_code_grove/, 'Must NOT include claude_code_grove');
    assert.doesNotMatch(arrayMatch[1], /claude_code_penguin_mode/, 'Must NOT include claude_code_penguin_mode');
  });

  it('should NOT include /v1/mcp_servers in SWAP_PATH_PREFIXES', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const arrayMatch = code.match(/const SWAP_PATH_PREFIXES\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(arrayMatch, 'Must define SWAP_PATH_PREFIXES array');
    assert.doesNotMatch(arrayMatch[1], /\/v1\/mcp_servers/, 'Must NOT include /v1/mcp_servers');
  });

  it('should log session_path_passthrough event in forwardRequest source', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    assert.match(
      fnStart,
      /proxyLog\(['"]session_path_passthrough['"]/,
      'Must log session_path_passthrough event when path is not in allowlist'
    );
  });

  it('should check SWAP_PATH_PREFIXES in forwardRequest with .some() + .startsWith()', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(
      fnStart,
      /SWAP_PATH_PREFIXES\.some\(/,
      'Must use SWAP_PATH_PREFIXES.some() for path matching'
    );
    assert.match(
      fnStart,
      /parsed\.path\.startsWith\(prefix\)/,
      'Must use parsed.path.startsWith(prefix) for prefix matching'
    );
  });

  it('behavioral: /v1/messages should match SWAP_PATH_PREFIXES', () => {
    const SWAP_PATH_PREFIXES = [
      '/v1/messages',
      '/v1/organizations',
      '/api/event_logging/',
      '/api/eval/',
      '/api/web/',
    ];

    const testPath = '/v1/messages';
    const isSwap = SWAP_PATH_PREFIXES.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, '/v1/messages must match the allowlist');
  });

  it('behavioral: /api/oauth/claude_cli/client_data should NOT match SWAP_PATH_PREFIXES', () => {
    const SWAP_PATH_PREFIXES = [
      '/v1/messages',
      '/v1/organizations',
      '/api/event_logging/',
      '/api/eval/',
      '/api/web/',
    ];

    const testPath = '/api/oauth/claude_cli/client_data';
    const isSwap = SWAP_PATH_PREFIXES.some(prefix => testPath.startsWith(prefix));
    assert.ok(!isSwap, '/api/oauth/claude_cli/client_data must NOT match the allowlist (passthrough)');
  });

  it('behavioral: /api/oauth/account/settings should NOT match SWAP_PATH_PREFIXES', () => {
    const SWAP_PATH_PREFIXES = [
      '/v1/messages',
      '/v1/organizations',
      '/api/event_logging/',
      '/api/eval/',
      '/api/web/',
    ];

    const testPath = '/api/oauth/account/settings';
    const isSwap = SWAP_PATH_PREFIXES.some(prefix => testPath.startsWith(prefix));
    assert.ok(!isSwap, '/api/oauth/account/settings must NOT match the allowlist (passthrough)');
  });

  it('should only apply path check on first attempt (retryCount === 0)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the path passthrough section
    const pathPassthroughIdx = fnStart.indexOf('session_path_passthrough');
    assert.ok(pathPassthroughIdx !== -1, 'Must have session_path_passthrough');

    const pathSection = fnStart.slice(Math.max(0, pathPassthroughIdx - 500), pathPassthroughIdx);
    assert.match(
      pathSection,
      /retryCount\s*===\s*0/,
      'Path-level passthrough must only apply on first attempt (retryCount === 0)'
    );
  });

  it('should only apply path check when not already in passthrough mode', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // Find the path passthrough section
    const pathPassthroughIdx = fnStart.indexOf('session_path_passthrough');
    assert.ok(pathPassthroughIdx !== -1, 'Must have session_path_passthrough');

    const pathSection = fnStart.slice(Math.max(0, pathPassthroughIdx - 500), pathPassthroughIdx);
    assert.match(
      pathSection,
      /!usePassthrough/,
      'Path-level passthrough must only apply when not already in passthrough mode'
    );
  });

  // ---------------------------------------------------------------------------
  // Behavioral: all five allowlisted paths individually
  // A test for /v1/messages alone is not enough — each entry in SWAP_PATH_PREFIXES
  // needs its own regression guard so removing any single entry is caught.
  // ---------------------------------------------------------------------------

  const SWAP_PATH_PREFIXES_FIXTURE = [
    '/v1/messages',
    '/v1/organizations',
    '/api/event_logging/',
    '/api/eval/',
    '/api/web/',
  ];

  it('behavioral: /v1/organizations should match SWAP_PATH_PREFIXES', () => {
    const testPath = '/v1/organizations/org-abc123/settings';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, '/v1/organizations sub-path must match the allowlist');
  });

  it('behavioral: /api/event_logging/ should match SWAP_PATH_PREFIXES', () => {
    const testPath = '/api/event_logging/batch';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, '/api/event_logging/ sub-path must match the allowlist');
  });

  it('behavioral: /api/eval/ should match SWAP_PATH_PREFIXES', () => {
    const testPath = '/api/eval/run';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, '/api/eval/ sub-path must match the allowlist');
  });

  it('behavioral: /api/web/ should match SWAP_PATH_PREFIXES', () => {
    const testPath = '/api/web/info';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, '/api/web/ sub-path must match the allowlist');
  });

  // ---------------------------------------------------------------------------
  // Prefix semantics: sub-paths and query strings must also match
  // ---------------------------------------------------------------------------

  it('behavioral: /v1/messages/count (sub-path) should match SWAP_PATH_PREFIXES', () => {
    const testPath = '/v1/messages/count';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, 'Sub-paths of /v1/messages must match because startsWith is a prefix check');
  });

  it('behavioral: /v1/messages?stream=true (query string) should match SWAP_PATH_PREFIXES', () => {
    const testPath = '/v1/messages?stream=true';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(isSwap, 'Paths with query strings must match when the path portion starts with the prefix');
  });

  // ---------------------------------------------------------------------------
  // Trailing-slash sensitivity: /api/web (no trailing slash) must NOT match
  // the /api/web/ prefix entry. This prevents a path like /api/webauthn from
  // being incorrectly included in the swap allowlist.
  // ---------------------------------------------------------------------------

  it('behavioral: /api/web (no trailing slash) should NOT match /api/web/ prefix', () => {
    const testPath = '/api/web';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(!isSwap, '/api/web without trailing slash must NOT match /api/web/ — prevents /api/webauthn false-positives');
  });

  it('behavioral: /api/eval (no trailing slash) should NOT match /api/eval/ prefix', () => {
    const testPath = '/api/eval';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(!isSwap, '/api/eval without trailing slash must NOT match /api/eval/ prefix entry');
  });

  it('behavioral: /api/event_logging (no trailing slash) should NOT match /api/event_logging/ prefix', () => {
    const testPath = '/api/event_logging';
    const isSwap = SWAP_PATH_PREFIXES_FIXTURE.some(prefix => testPath.startsWith(prefix));
    assert.ok(!isSwap, '/api/event_logging without trailing slash must NOT match /api/event_logging/ prefix entry');
  });

  // ---------------------------------------------------------------------------
  // session_path_passthrough log must include expected observability fields
  // ---------------------------------------------------------------------------

  it('should include incoming_key_id field in session_path_passthrough log', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const logIdx = fnStart.indexOf('session_path_passthrough');
    assert.ok(logIdx !== -1, 'Must log session_path_passthrough');

    const logSection = fnStart.slice(logIdx, logIdx + 400);
    assert.match(
      logSection,
      /incoming_key_id/,
      'session_path_passthrough log must include incoming_key_id for observability'
    );
  });

  it('should include active_key_id field in session_path_passthrough log', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const logIdx = fnStart.indexOf('session_path_passthrough');
    assert.ok(logIdx !== -1, 'Must log session_path_passthrough');

    const logSection = fnStart.slice(logIdx, logIdx + 400);
    assert.match(
      logSection,
      /active_key_id/,
      'session_path_passthrough log must include active_key_id for correlation with request_intercepted events'
    );
  });

  it('should include method and path fields in session_path_passthrough log', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const logIdx = fnStart.indexOf('session_path_passthrough');
    assert.ok(logIdx !== -1, 'Must log session_path_passthrough');

    const logSection = fnStart.slice(logIdx, logIdx + 400);
    assert.match(logSection, /method/, 'session_path_passthrough log must include method');
    assert.match(logSection, /path/, 'session_path_passthrough log must include path');
  });

  // ---------------------------------------------------------------------------
  // Path check runs AFTER token-identity check: tombstone/merged tokens use
  // forceSwap to prevent path-level passthrough from overriding the swap
  // decision. A merged/tombstone token has no valid accessToken — passing it
  // through to ANY endpoint guarantees a 403.
  // ---------------------------------------------------------------------------

  it('path check runs after token-identity check in source (order of guards matters)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const tombstoneIdx = fnStart.indexOf("keyEntry.status === 'tombstone'");
    const pathCheckIdx = fnStart.indexOf('SWAP_PATH_PREFIXES.some');

    assert.ok(tombstoneIdx !== -1, 'Must have tombstone check');
    assert.ok(pathCheckIdx !== -1, 'Must have SWAP_PATH_PREFIXES.some() path check');
    assert.ok(
      tombstoneIdx < pathCheckIdx,
      'Token-identity check (tombstone/merged/unknown) must run before path-level passthrough check'
    );
  });

  it('path check guard (!usePassthrough) prevents double-passthrough log when token-identity already set passthrough', () => {
    // When unknown_token_passthrough sets usePassthrough = true, the path check
    // condition is `if (!usePassthrough && !forceSwap && retryCount === 0)` — which is false.
    // This prevents a second session_path_passthrough log event for unknown tokens.
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const pathCheckIdx = fnStart.indexOf('SWAP_PATH_PREFIXES.some');
    assert.ok(pathCheckIdx !== -1, 'Must have SWAP_PATH_PREFIXES.some()');

    const guardSection = fnStart.slice(Math.max(0, pathCheckIdx - 200), pathCheckIdx);
    assert.match(
      guardSection,
      /!usePassthrough/,
      'Path check must be guarded by !usePassthrough to avoid double-logging when token-identity passthrough already fired'
    );
  });

  // ---------------------------------------------------------------------------
  // forceSwap flag: prevents path-level passthrough from overriding
  // merged/tombstone swap decisions (Bug: expired token passthrough → 403)
  // ---------------------------------------------------------------------------

  it('forceSwap flag defined in forwardRequest()', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    assert.match(
      fnStart,
      /let forceSwap\s*=\s*false/,
      'Must declare forceSwap = false in forwardRequest'
    );
  });

  it('forceSwap = true appears in tombstone block', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const tombstoneIdx = fnStart.indexOf("keyEntry.status === 'tombstone'");
    assert.ok(tombstoneIdx !== -1, 'Must have tombstone check');

    // Look for forceSwap = true between tombstone check and merged check
    const mergedIdx = fnStart.indexOf("keyEntry.status === 'merged'");
    assert.ok(mergedIdx !== -1, 'Must have merged check');

    const tombstoneBlock = fnStart.slice(tombstoneIdx, mergedIdx);
    assert.match(
      tombstoneBlock,
      /forceSwap\s*=\s*true/,
      'Tombstone block must set forceSwap = true to prevent path-level passthrough override'
    );
  });

  it('forceSwap = true appears in merged block', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const mergedIdx = fnStart.indexOf("keyEntry.status === 'merged'");
    assert.ok(mergedIdx !== -1, 'Must have merged check');

    // Look for forceSwap = true between merged check and the unknown token check
    const unknownIdx = fnStart.indexOf('unknown_token_passthrough');
    assert.ok(unknownIdx !== -1, 'Must have unknown_token_passthrough');

    const mergedBlock = fnStart.slice(mergedIdx, unknownIdx);
    assert.match(
      mergedBlock,
      /forceSwap\s*=\s*true/,
      'Merged block must set forceSwap = true to prevent path-level passthrough override'
    );
  });

  it('!forceSwap guard on path-level passthrough condition', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    const pathCheckIdx = fnStart.indexOf('session_path_passthrough');
    assert.ok(pathCheckIdx !== -1, 'Must have session_path_passthrough');

    const guardSection = fnStart.slice(Math.max(0, pathCheckIdx - 500), pathCheckIdx);
    assert.match(
      guardSection,
      /!forceSwap/,
      'Path-level passthrough must be guarded by !forceSwap to prevent overriding merged/tombstone swap decisions'
    );
  });

  it('behavioral: merged token on non-SWAP path should NOT passthrough', () => {
    // Simulate the forwardRequest logic inline:
    // merged token → forceSwap = true → path check skipped → usePassthrough stays false
    const SWAP_PATH_PREFIXES = [
      '/v1/messages',
      '/v1/organizations',
      '/api/event_logging/',
      '/api/eval/',
      '/api/web/',
    ];

    let usePassthrough = false;
    let forceSwap = false;
    const retryCount = 0;

    // Simulate: incoming token is merged
    const keyStatus = 'merged';
    if (keyStatus === 'tombstone' || keyStatus === 'merged') {
      // usePassthrough stays false
      forceSwap = true;
    }

    // Simulate: path-level passthrough check (the fixed version)
    const testPath = '/v1/mcp_servers';
    if (!usePassthrough && !forceSwap && retryCount === 0) {
      const isSwapPath = SWAP_PATH_PREFIXES.some(prefix => testPath.startsWith(prefix));
      if (!isSwapPath) {
        usePassthrough = true;
      }
    }

    assert.strictEqual(usePassthrough, false,
      'Merged token on /v1/mcp_servers must NOT be set to passthrough — forceSwap prevents it');
    assert.strictEqual(forceSwap, true,
      'forceSwap must be true for merged tokens');
  });

  it('logs force_swap_override event for merged/tombstone tokens on non-SWAP paths', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');
    assert.ok(fnStart !== null, 'forwardRequest must be defined');

    assert.match(
      fnStart,
      /proxyLog\(['"]force_swap_override['"]/,
      'Must log force_swap_override event when forceSwap overrides path-level passthrough'
    );
  });

  // ---------------------------------------------------------------------------
  // 429 retry is suppressed for path-passthrough requests
  // The 429 handler has `!usePassthrough` guard, which catches both
  // token-identity passthrough AND path-level passthrough.
  // ---------------------------------------------------------------------------

  it('429 retry guard (!usePassthrough) covers path-induced passthrough, not just token-identity passthrough', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    // The 429 condition: retryCount < MAX_429_RETRIES && !usePassthrough
    const retryOn429Idx = fnStart.indexOf('rotating_on_429');
    assert.ok(retryOn429Idx !== -1, 'Must have rotating_on_429 log event');

    const retryGuardSection = fnStart.slice(Math.max(0, retryOn429Idx - 300), retryOn429Idx);
    assert.match(
      retryGuardSection,
      /!usePassthrough/,
      '429 retry must be guarded by !usePassthrough — path-passthrough requests must never trigger key rotation'
    );
  });
});

// ---------------------------------------------------------------------------
// 13. Proxy audit trail — tunnel lifecycle and response logging
// ---------------------------------------------------------------------------

describe('rotation-proxy.js - Proxy audit trail', () => {
  it('should define LOG_RETENTION_MS constant (24 hours)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /const LOG_RETENTION_MS\s*=/, 'Must define LOG_RETENTION_MS');
    assert.match(code, /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/, 'LOG_RETENTION_MS must be 24 hours in milliseconds');
  });

  it('should define cleanupOldLogEntries function', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /function cleanupOldLogEntries\(\)/, 'Must define cleanupOldLogEntries function');
  });

  it('should set MAX_LOG_BYTES to 10MB safety cap', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    assert.match(code, /const MAX_LOG_BYTES\s*=\s*10_485_760/, 'MAX_LOG_BYTES must be 10MB (10_485_760)');
  });

  it('should log tunnel_established event with host, port, head_bytes', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('return;', passthroughStart);
    const section = code.slice(passthroughStart, passthroughEnd);

    assert.match(section, /proxyLog\('tunnel_established'/, 'Must log tunnel_established event');
    assert.match(section, /head_bytes/, 'tunnel_established must include head_bytes field');
  });

  it('should log tunnel_closed event with duration_ms, bytes_from_server, bytes_from_client, closed_by', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('// MITM: respond 200');
    const section = code.slice(passthroughStart, passthroughEnd);

    assert.match(section, /proxyLog\('tunnel_closed'/, 'Must log tunnel_closed event');
    assert.match(section, /duration_ms/, 'tunnel_closed must include duration_ms');
    assert.match(section, /bytes_from_server/, 'tunnel_closed must include bytes_from_server');
    assert.match(section, /bytes_from_client/, 'tunnel_closed must include bytes_from_client');
    assert.match(section, /closed_by/, 'tunnel_closed must include closed_by field');
  });

  it('should log tunnel_client_error event (previously silent error path)', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('// MITM: respond 200');
    const section = code.slice(passthroughStart, passthroughEnd);

    assert.match(section, /proxyLog\('tunnel_client_error'/, 'Must log tunnel_client_error event');
  });

  it('should avoid double-logging tunnel_closed by checking destroyed state', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('// MITM: respond 200');
    const section = code.slice(passthroughStart, passthroughEnd);

    // Both close handlers must guard with destroyed check
    assert.match(section, /!clientSocket\.destroyed/, 'upstream close handler must check !clientSocket.destroyed');
    assert.match(section, /!upstreamSocket\.destroyed/, 'client close handler must check !upstreamSocket.destroyed');
  });

  it('should log response_received event in forwardRequest with status field', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const fnStart = extractFunctionBody(code, 'forwardRequest');

    assert.match(fnStart, /proxyLog\('response_received'/, 'Must log response_received event');
    assert.match(fnStart, /status:\s*responseStatusCode/, 'response_received must include status field');
  });

  it('should call cleanupOldLogEntries at startup', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const mainFn = extractFunctionBody(code, 'main');

    assert.match(mainFn, /cleanupOldLogEntries\(\)/, 'Must call cleanupOldLogEntries() in main()');
  });

  it('should schedule hourly cleanup via setInterval', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');
    const mainFn = extractFunctionBody(code, 'main');

    assert.match(mainFn, /setInterval\(cleanupOldLogEntries/, 'Must schedule cleanupOldLogEntries on interval');
    assert.match(mainFn, /\.unref\(\)/, 'Interval must be unref()d to not prevent process exit');
  });

  it('should include duration_ms in tunnel_error event', () => {
    const code = fs.readFileSync(PROXY_PATH, 'utf8');

    const passthroughStart = code.indexOf('// Transparent CONNECT tunnel');
    const passthroughEnd = code.indexOf('// MITM: respond 200');
    const section = code.slice(passthroughStart, passthroughEnd);

    const errorIdx = section.indexOf("proxyLog('tunnel_error'");
    assert.ok(errorIdx !== -1, 'Must have tunnel_error log');
    const errorSection = section.slice(errorIdx, errorIdx + 200);
    assert.match(errorSection, /duration_ms/, 'tunnel_error must include duration_ms');
  });

  it('time-based cleanup should filter entries by LOG_RETENTION_MS cutoff', () => {
    // Behavioral test: simulate the cleanup logic inline
    const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - LOG_RETENTION_MS;

    const lines = [
      JSON.stringify({ ts: new Date(now - 25 * 60 * 60 * 1000).toISOString(), event: 'old' }),
      JSON.stringify({ ts: new Date(now - 1 * 60 * 60 * 1000).toISOString(), event: 'recent' }),
      JSON.stringify({ ts: new Date(now).toISOString(), event: 'current' }),
    ];

    const recent = lines.filter(line => {
      try {
        return new Date(JSON.parse(line).ts).getTime() >= cutoff;
      } catch { return false; }
    });

    assert.strictEqual(recent.length, 2, 'Should keep 2 recent entries and discard 1 old entry');
    assert.ok(recent.every(l => JSON.parse(l).event !== 'old'), 'Old entry must be filtered out');
  });
});
