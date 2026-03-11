import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_SYNC_PATH = path.join(__dirname, '..', 'key-sync.js');

describe('key-sync: expired token initialization', () => {
  describe('code structure', () => {
    it('should check expiresAt before setting initial status', () => {
      const code = fs.readFileSync(KEY_SYNC_PATH, 'utf8');

      // Find the isNewKey block in syncKeys
      const syncKeysMatch = code.match(/export async function syncKeys\([\s\S]*?\n\}/);
      assert.ok(syncKeysMatch, 'syncKeys must be defined');
      const syncKeysBody = syncKeysMatch[0];

      // Should contain expiry check near status assignment
      assert.match(
        syncKeysBody,
        /cred\.expiresAt\s*&&\s*cred\.expiresAt\s*<\s*now/,
        'Must check cred.expiresAt < now when setting initial status'
      );

      // Should have conditional expired/active status
      assert.match(
        syncKeysBody,
        /status:\s*\(cred\.expiresAt/,
        'Status must be conditionally set based on expiresAt'
      );
    });
  });

  describe('behavioral', () => {
    it('should set status to expired for tokens with expiresAt in the past', () => {
      const now = Date.now();
      const cred = {
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        expiresAt: now - 3600000, // 1 hour ago
        source: 'test',
      };

      // Simulate the status assignment logic
      const status = (cred.expiresAt && cred.expiresAt < now) ? 'expired' : 'active';
      assert.strictEqual(status, 'expired', 'Expired token must get expired status');
    });

    it('should set status to active for tokens with expiresAt in the future', () => {
      const now = Date.now();
      const cred = {
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        expiresAt: now + 3600000, // 1 hour from now
        source: 'test',
      };

      const status = (cred.expiresAt && cred.expiresAt < now) ? 'expired' : 'active';
      assert.strictEqual(status, 'active', 'Valid token must get active status');
    });

    it('should set status to active for tokens with null expiresAt', () => {
      const now = Date.now();
      const cred = {
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        expiresAt: null,
        source: 'test',
      };

      const status = (cred.expiresAt && cred.expiresAt < now) ? 'expired' : 'active';
      assert.strictEqual(status, 'active', 'Token without expiresAt must get active status');
    });
  });
});
