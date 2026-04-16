/**
 * Unit tests for .claude/hooks/lib/bypass-approval-token.js
 *
 * Tests the HMAC-verified bypass approval token verification module.
 *
 * Run with: node --test .claude/hooks/__tests__/bypass-approval-token.test.js
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Resolve the module path relative to this test file
const MODULE_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'bypass-approval-token.js');
const { verifyAndConsumeApprovalToken } = await import(MODULE_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh tmp dir for a test project layout. */
function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bypass-token-test-'));
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  return dir;
}

/** Write a random base64 key to .claude/protection-key and return both dir and key. */
function writeProtectionKey(projectDir) {
  const key = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(path.join(projectDir, '.claude', 'protection-key'), key + '\n');
  return key;
}

/** Compute the HMAC the way the server does. */
function computeHmac(keyBase64, code, requestId, expiresTimestamp) {
  const keyBuffer = Buffer.from(keyBase64, 'base64');
  return crypto
    .createHmac('sha256', keyBuffer)
    .update([code, requestId, String(expiresTimestamp), 'bypass-approved'].join('|'))
    .digest('hex');
}

/** Write a valid token file. Returns the token object written. */
function writeValidToken(projectDir, key, overrides = {}) {
  const code = overrides.code ?? 'K7N9M3';
  const requestId = overrides.request_id ?? 'req-' + crypto.randomUUID().slice(0, 8);
  const expiresTimestamp = overrides.expires_timestamp ?? (Date.now() + 5 * 60 * 1000);
  const hmac = overrides.hmac ?? computeHmac(key, code, requestId, expiresTimestamp);
  const token = { code, request_id: requestId, expires_timestamp: expiresTimestamp, hmac };
  fs.writeFileSync(
    path.join(projectDir, '.claude', 'bypass-approval-token.json'),
    JSON.stringify(token),
  );
  return token;
}

/** Read the token file content (for checking it was consumed). */
function readTokenFile(projectDir) {
  const p = path.join(projectDir, '.claude', 'bypass-approval-token.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyAndConsumeApprovalToken', () => {
  describe('invalid cases — no token', () => {
    it('returns invalid when token file is missing', () => {
      const dir = makeTmpProject();
      writeProtectionKey(dir);
      // Do NOT write a token file

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, false);
      assert.ok(result.reason, 'Should have a reason string');
      assert.match(result.reason, /No bypass approval token found/);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns invalid when token file contains empty object {}', () => {
      const dir = makeTmpProject();
      writeProtectionKey(dir);
      fs.writeFileSync(path.join(dir, '.claude', 'bypass-approval-token.json'), '{}');

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /already consumed|not yet written/);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('invalid cases — expired token', () => {
    it('returns invalid when token is expired (expires_timestamp in the past)', () => {
      const dir = makeTmpProject();
      const key = writeProtectionKey(dir);
      // Write a token that expired 10 seconds ago
      writeValidToken(dir, key, { expires_timestamp: Date.now() - 10_000 });

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /expired/i);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('invalid cases — HMAC mismatch', () => {
    it('returns invalid when HMAC does not match (forgery attempt)', () => {
      const dir = makeTmpProject();
      const key = writeProtectionKey(dir);
      // Write token with a tampered HMAC
      writeValidToken(dir, key, { hmac: 'deadbeef00000000000000000000000000000000000000000000000000000000' });

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /HMAC verification failed|forgery/i);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('clears the token file after HMAC mismatch', () => {
      const dir = makeTmpProject();
      const key = writeProtectionKey(dir);
      writeValidToken(dir, key, { hmac: 'badhmac00000000000000000000000000000000000000000000000000000000' });

      verifyAndConsumeApprovalToken(dir);

      const tokenContent = readTokenFile(dir);
      assert.deepStrictEqual(tokenContent, {}, 'Token should be cleared after forgery attempt');

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns invalid when HMAC field is missing (partial forgery)', () => {
      const dir = makeTmpProject();
      writeProtectionKey(dir);
      const token = {
        code: 'K7N9M3',
        request_id: 'req-abc123',
        expires_timestamp: Date.now() + 5 * 60 * 1000,
        // no hmac field
      };
      fs.writeFileSync(path.join(dir, '.claude', 'bypass-approval-token.json'), JSON.stringify(token));

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /missing HMAC|forgery/i);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('invalid cases — missing protection key (G001 fail-closed)', () => {
    it('returns invalid when protection-key file is missing', () => {
      const dir = makeTmpProject();
      // Intentionally do NOT write a protection key
      // Write what would otherwise be a valid-looking token
      const code = 'K7N9M3';
      const requestId = 'req-test';
      const expiresTimestamp = Date.now() + 5 * 60 * 1000;
      const token = { code, request_id: requestId, expires_timestamp: expiresTimestamp, hmac: 'anything' };
      fs.writeFileSync(path.join(dir, '.claude', 'bypass-approval-token.json'), JSON.stringify(token));

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, false);
      assert.match(result.reason, /Protection key missing|G001/i);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('valid token — success path', () => {
    it('returns valid:true with code and request_id when HMAC matches and not expired', () => {
      const dir = makeTmpProject();
      const key = writeProtectionKey(dir);
      const token = writeValidToken(dir, key);

      const result = verifyAndConsumeApprovalToken(dir);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.code, token.code);
      assert.strictEqual(result.request_id, token.request_id);

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('consumes the token (overwrites with {}) after successful verification', () => {
      const dir = makeTmpProject();
      const key = writeProtectionKey(dir);
      writeValidToken(dir, key);

      verifyAndConsumeApprovalToken(dir);

      const tokenContent = readTokenFile(dir);
      assert.deepStrictEqual(tokenContent, {}, 'Token should be consumed (empty object) after use');

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('second call returns invalid after token was consumed (one-time use)', () => {
      const dir = makeTmpProject();
      const key = writeProtectionKey(dir);
      writeValidToken(dir, key);

      const first = verifyAndConsumeApprovalToken(dir);
      assert.strictEqual(first.valid, true, 'First call should succeed');

      const second = verifyAndConsumeApprovalToken(dir);
      assert.strictEqual(second.valid, false, 'Second call should fail — token consumed');
      assert.match(second.reason, /consumed|not yet written/);

      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
