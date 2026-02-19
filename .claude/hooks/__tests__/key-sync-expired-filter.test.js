/**
 * Tests for key-sync.js - expired token filter and refresh behavior
 *
 * Covers the change at line ~409 where the expired-key refresh filter
 * was changed from `keyData.status !== 'expired'` to `keyData.status !== 'invalid'`.
 *
 * Previously: only keys NOT already marked 'expired' were attempted for refresh
 * Now: keys with ANY status except 'invalid' are attempted if their expiresAt < now
 *
 * This means a key already in 'expired' status IS now a candidate for token refresh.
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/key-sync-expired-filter.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY_SYNC_PATH = path.join(__dirname, '..', 'key-sync.js');

describe('key-sync.js - Expired Token Refresh Filter (line ~409)', () => {
  describe('Code Structure: syncKeys() expired key filter condition', () => {
    it('should include expired-status keys in refresh candidates (not exclude them)', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      // Extract the syncKeys function body
      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must be exported and defined');
      const syncBody = syncMatch[0];

      // The filter for token refresh candidates must NOT exclude status === 'expired'.
      // The correct guard is: status !== 'invalid'
      assert.match(
        syncBody,
        /keyData\.status !== ['"]invalid['"]/,
        'Refresh candidate filter must exclude only "invalid" status, not "expired"'
      );
    });

    it('should NOT use status !== "expired" as the refresh gate condition in syncKeys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      // The old (wrong) filter would have been `keyData.status !== 'expired'` or
      // `keyData.status === 'active'` alone. Neither should gate the refresh loop.
      // We verify the expired-token loop does NOT have !== 'expired' as its only guard.
      //
      // A key's status check in the refresh section should NOT be:
      //   keyData.expiresAt && keyData.expiresAt < now && keyData.status !== 'expired'
      assert.doesNotMatch(
        syncBody,
        /expiresAt < now && keyData\.status !== ['"]expired['"]/,
        'Must NOT gate token refresh on status !== "expired" (that would prevent re-refreshing expired keys)'
      );
    });

    it('should attempt token refresh when expiresAt < now regardless of current "expired" status', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      // The full condition must be: expiresAt && expiresAt < now && status !== 'invalid'
      assert.match(
        syncBody,
        /keyData\.expiresAt && keyData\.expiresAt < now && keyData\.status !== ['"]invalid['"]/,
        'syncKeys refresh loop must trigger for expired keys when status is not "invalid"'
      );
    });

    it('should still exclude "invalid" keys from refresh attempts in syncKeys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      // Invalid keys (bad credentials) must not be refreshed
      assert.match(
        syncBody,
        /status !== ['"]invalid['"]/,
        'syncKeys must guard against refreshing "invalid" status keys'
      );
    });

    it('should mark successfully refreshed keys as "active" in syncKeys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      assert.match(
        syncBody,
        /keyData\.status = ['"]active['"]/,
        'syncKeys must set status to "active" after successful token refresh'
      );
    });

    it('should mark failed refresh keys as "expired" in syncKeys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      assert.match(
        syncBody,
        /keyData\.status = ['"]expired['"]/,
        'syncKeys must set status to "expired" when token refresh fails'
      );
    });

    it('should log token_expired_refresh_failed event on failed refresh in syncKeys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      assert.match(
        syncBody,
        /token_expired_refresh_failed/,
        'syncKeys must log token_expired_refresh_failed event on failed refresh'
      );
    });

    it('should log key_added with reason token_refreshed on successful refresh in syncKeys', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const syncMatch = code.match(/export async function syncKeys[\s\S]*?\n\}/);
      assert.ok(syncMatch, 'syncKeys must exist');
      const syncBody = syncMatch[0];

      assert.match(
        syncBody,
        /reason:\s*['"]token_refreshed['"]/,
        'syncKeys must log key_added event with reason "token_refreshed" on success'
      );
    });
  });

  describe('Code Structure: refreshExpiredToken() function', () => {
    it('should be exported from key-sync.js', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      assert.match(
        code,
        /export async function refreshExpiredToken\(/,
        'refreshExpiredToken must be exported from key-sync.js'
      );
    });

    it('should return null when refreshToken is absent', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'refreshExpiredToken must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /!keyData\.refreshToken[\s\S]*?return null/,
        'Must return null when refreshToken is missing'
      );
    });

    it('should return null when key status is "invalid"', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'refreshExpiredToken must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /keyData\.status === ['"]invalid['"]/,
        'Must guard against refreshing keys with "invalid" status'
      );

      assert.match(
        fnBody,
        /status === ['"]invalid['"][\s\S]*?return null/,
        'Must return null for "invalid" status keys'
      );
    });

    it('should POST to the OAuth token endpoint with refresh_token grant', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'refreshExpiredToken must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /method:\s*['"]POST['"]/,
        'refreshExpiredToken must use POST method'
      );

      assert.match(
        fnBody,
        /grant_type.*refresh_token/s,
        'refreshExpiredToken must send grant_type: refresh_token'
      );
    });

    it('should return accessToken, refreshToken, and expiresAt on success', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'refreshExpiredToken must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /accessToken:\s*data\.access_token/,
        'refreshExpiredToken must return accessToken from response'
      );

      assert.match(
        fnBody,
        /refreshToken:/,
        'refreshExpiredToken must return refreshToken'
      );

      assert.match(
        fnBody,
        /expiresAt:/,
        'refreshExpiredToken must return expiresAt'
      );
    });

    it('should return null on non-OK HTTP response', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'refreshExpiredToken must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /!response\.ok[\s\S]*?return null/,
        'refreshExpiredToken must return null when response is not OK'
      );
    });

    it('should return null on fetch error', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      const fnMatch = code.match(/export async function refreshExpiredToken\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'refreshExpiredToken must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /catch[\s\S]*?return null/,
        'refreshExpiredToken must return null on fetch exception'
      );
    });
  });

  describe('Behavioral logic: expired-key refresh filter semantics', () => {
    it('should allow status "active" keys with past expiresAt to be refresh candidates', () => {
      // Simulate the filter logic extracted from syncKeys
      const now = Date.now();
      const keys = {
        'active-expired': {
          status: 'active',
          expiresAt: now - 1000,  // expired timestamp
          refreshToken: 'refresh-abc',
        },
        'active-valid': {
          status: 'active',
          expiresAt: now + 60000,  // not yet expired
          refreshToken: 'refresh-def',
        },
      };

      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.expiresAt && kd.expiresAt < now && kd.status !== 'invalid'
      );

      assert.strictEqual(candidates.length, 1, 'Only the key with past expiresAt should be a candidate');
      assert.strictEqual(candidates[0][0], 'active-expired');
    });

    it('should allow status "expired" keys to be refresh candidates under new filter', () => {
      const now = Date.now();
      const keys = {
        'already-expired-key': {
          status: 'expired',
          expiresAt: now - 5000,
          refreshToken: 'refresh-xyz',
        },
      };

      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.expiresAt && kd.expiresAt < now && kd.status !== 'invalid'
      );

      assert.strictEqual(
        candidates.length,
        1,
        'A key with status "expired" and past expiresAt must be a refresh candidate under the new filter'
      );
    });

    it('should reject status "invalid" keys from refresh candidates', () => {
      const now = Date.now();
      const keys = {
        'invalid-key': {
          status: 'invalid',
          expiresAt: now - 5000,
          refreshToken: 'refresh-abc',
        },
      };

      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.expiresAt && kd.expiresAt < now && kd.status !== 'invalid'
      );

      assert.strictEqual(candidates.length, 0, 'Invalid keys must never be refresh candidates');
    });

    it('should reject keys with no expiresAt from refresh candidates', () => {
      const now = Date.now();
      const keys = {
        'no-expiry-key': {
          status: 'expired',
          expiresAt: null,
          refreshToken: 'refresh-abc',
        },
      };

      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.expiresAt && kd.expiresAt < now && kd.status !== 'invalid'
      );

      assert.strictEqual(candidates.length, 0, 'Keys without expiresAt must not be refresh candidates');
    });

    it('should reject keys with future expiresAt from refresh candidates', () => {
      const now = Date.now();
      const keys = {
        'future-expiry': {
          status: 'active',
          expiresAt: now + 3600000,
          refreshToken: 'refresh-abc',
        },
      };

      const candidates = Object.entries(keys).filter(
        ([, kd]) => kd.expiresAt && kd.expiresAt < now && kd.status !== 'invalid'
      );

      assert.strictEqual(candidates.length, 0, 'Keys with future expiresAt must not be refresh candidates');
    });

    it('old filter (status !== expired) would have blocked already-expired keys from refresh', () => {
      // This test documents the old (broken) behavior to clarify the fix.
      // The old filter was: expiresAt < now && status !== 'expired'
      // An 'expired' key with a past expiresAt would have been silently skipped.
      const now = Date.now();
      const key = { status: 'expired', expiresAt: now - 5000, refreshToken: 'tok' };

      const oldFilterResult = key.expiresAt && key.expiresAt < now && key.status !== 'expired';
      assert.strictEqual(
        oldFilterResult,
        false,
        'Old filter blocked refresh for already-expired keys (documents the bug)'
      );

      const newFilterResult = key.expiresAt && key.expiresAt < now && key.status !== 'invalid';
      assert.strictEqual(
        newFilterResult,
        true,
        'New filter allows refresh for already-expired keys (documents the fix)'
      );
    });
  });
});
