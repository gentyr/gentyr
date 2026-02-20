/**
 * Unit tests for rotation-stress-monitor.mjs pure functions
 *
 * Tests only the pure utility functions extracted from the monitoring script.
 * Does NOT test I/O operations (file reads, Keychain access, process polling).
 *
 * Run with: node --test scripts/__tests__/rotation-stress-monitor.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

// ============================================================================
// Pure Functions Extracted from rotation-stress-monitor.mjs
// ============================================================================

function generateKeyId(accessToken) {
  const clean = accessToken.replace(/^sk-ant-oat01-/, '').replace(/^sk-ant-/, '');
  return crypto.createHash('sha256').update(clean).digest('hex').substring(0, 16);
}

function fmtDuration(ms) {
  if (ms < 0) return '-' + fmtDuration(-ms);
  const mins = Math.round(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
  return `${mins}m`;
}

function fmtTimestamp(ts) {
  return new Date(ts).toISOString().replace('T', ' ').slice(11, 19);
}

function redactToken(token) {
  if (!token || typeof token !== 'string') return null;
  return token.substring(0, 20) + '...[REDACTED]';
}

function buildAccountSummary(rotState) {
  if (!rotState || !rotState.keys) return {};
  const now = Date.now();
  const byEmail = {};

  for (const [id, k] of Object.entries(rotState.keys)) {
    const email = k.account_email || 'unknown';
    if (!byEmail[email]) byEmail[email] = { keys: [], totalKeys: 0, validKeys: 0, maxUsage: 0, nearestExpiry: Infinity };
    byEmail[email].totalKeys++;
    if (k.status === 'invalid') {
      byEmail[email].keys.push({ id, status: k.status, tier: k.rateLimitTier, expiresIn: null, usage: null });
      continue; // skip for stats
    }
    byEmail[email].validKeys++;

    const expiresIn = k.expiresAt ? k.expiresAt - now : null;
    if (expiresIn !== null && expiresIn < byEmail[email].nearestExpiry) {
      byEmail[email].nearestExpiry = expiresIn;
    }

    const usage = k.last_usage;
    if (usage) {
      const max = Math.max(usage.five_hour || 0, usage.seven_day || 0, usage.seven_day_sonnet || 0);
      if (max > byEmail[email].maxUsage) byEmail[email].maxUsage = max;
    }

    byEmail[email].keys.push({
      id,
      status: k.status,
      tier: k.rateLimitTier || '?',
      expiresIn,
      usage,
      isActive: id === rotState.active_key_id,
    });
  }

  return byEmail;
}

function computeSessionDeltas(currentAgents, previousAgents) {
  if (!previousAgents) return { spawned: [], died: [] };
  const prevIds = new Set(previousAgents.map(a => a.id));
  const currIds = new Set(currentAgents.map(a => a.id));

  const spawned = currentAgents.filter(a => !prevIds.has(a.id));
  const died = previousAgents.filter(a => !currIds.has(a.id));
  return { spawned, died };
}

// ============================================================================
// Tests
// ============================================================================

describe('rotation-stress-monitor pure functions', () => {
  describe('generateKeyId()', () => {
    it('should generate consistent 16-char hash for same token', () => {
      const token = 'sk-ant-oat01-abc123xyz';
      const id1 = generateKeyId(token);
      const id2 = generateKeyId(token);
      assert.strictEqual(id1, id2);
      assert.strictEqual(id1.length, 16);
    });

    it('should strip sk-ant-oat01- prefix before hashing', () => {
      const withPrefix = 'sk-ant-oat01-abc123';
      const withoutPrefix = 'abc123';
      const id1 = generateKeyId(withPrefix);
      const id2 = generateKeyId(withoutPrefix);
      assert.strictEqual(id1, id2);
    });

    it('should strip sk-ant- prefix before hashing', () => {
      const withPrefix = 'sk-ant-abc123';
      const withoutPrefix = 'abc123';
      const id1 = generateKeyId(withPrefix);
      const id2 = generateKeyId(withoutPrefix);
      assert.strictEqual(id1, id2);
    });

    it('should produce different hashes for different tokens', () => {
      const token1 = 'sk-ant-oat01-abc123';
      const token2 = 'sk-ant-oat01-xyz789';
      const id1 = generateKeyId(token1);
      const id2 = generateKeyId(token2);
      assert.notStrictEqual(id1, id2);
    });
  });

  describe('fmtDuration()', () => {
    it('should format minutes correctly', () => {
      assert.strictEqual(fmtDuration(60_000), '1m');
      assert.strictEqual(fmtDuration(120_000), '2m');
      assert.strictEqual(fmtDuration(59_999), '1m'); // rounds
    });

    it('should format hours and minutes correctly', () => {
      assert.strictEqual(fmtDuration(3_600_000), '1h00m');
      assert.strictEqual(fmtDuration(3_660_000), '1h01m');
      assert.strictEqual(fmtDuration(7_260_000), '2h01m');
    });

    it('should handle negative durations', () => {
      assert.strictEqual(fmtDuration(-60_000), '-1m');
      assert.strictEqual(fmtDuration(-3_600_000), '-1h00m');
    });

    it('should round to nearest minute', () => {
      assert.strictEqual(fmtDuration(30_000), '1m'); // 30s rounds to 1m
      assert.strictEqual(fmtDuration(29_999), '0m'); // 29.999s rounds to 0m
    });
  });

  describe('fmtTimestamp()', () => {
    it('should format timestamp as HH:MM:SS', () => {
      const ts = new Date('2026-02-20T15:30:45.123Z').getTime();
      const formatted = fmtTimestamp(ts);
      assert.match(formatted, /^\d{2}:\d{2}:\d{2}$/);
      assert.strictEqual(formatted, '15:30:45');
    });

    it('should handle midnight correctly', () => {
      const ts = new Date('2026-02-20T00:00:00.000Z').getTime();
      const formatted = fmtTimestamp(ts);
      assert.strictEqual(formatted, '00:00:00');
    });
  });

  describe('redactToken()', () => {
    it('should redact token after first 20 chars', () => {
      const token = 'sk-ant-oat01-abc123456789xyz';
      const redacted = redactToken(token);
      // Token is 29 chars total, first 20 chars: "sk-ant-oat01-abc1234"
      assert.strictEqual(redacted, 'sk-ant-oat01-abc1234...[REDACTED]');
    });

    it('should handle null input', () => {
      assert.strictEqual(redactToken(null), null);
    });

    it('should handle undefined input', () => {
      assert.strictEqual(redactToken(undefined), null);
    });

    it('should handle non-string input', () => {
      assert.strictEqual(redactToken(123), null);
    });

    it('should handle short tokens', () => {
      const token = 'short';
      const redacted = redactToken(token);
      assert.strictEqual(redacted, 'short...[REDACTED]');
    });
  });

  describe('buildAccountSummary()', () => {
    it('should return empty object for null rotState', () => {
      assert.deepStrictEqual(buildAccountSummary(null), {});
    });

    it('should return empty object for rotState without keys', () => {
      assert.deepStrictEqual(buildAccountSummary({}), {});
    });

    it('should group keys by account email', () => {
      const rotState = {
        keys: {
          'key1': { account_email: 'alice@example.com', status: 'active', rateLimitTier: 'tier1' },
          'key2': { account_email: 'alice@example.com', status: 'active', rateLimitTier: 'tier1' },
          'key3': { account_email: 'bob@example.com', status: 'active', rateLimitTier: 'tier2' },
        },
        active_key_id: 'key1',
      };

      const summary = buildAccountSummary(rotState);
      assert.ok(summary.hasOwnProperty('alice@example.com'));
      assert.ok(summary.hasOwnProperty('bob@example.com'));
      assert.strictEqual(summary['alice@example.com'].totalKeys, 2);
      assert.strictEqual(summary['alice@example.com'].validKeys, 2);
      assert.strictEqual(summary['bob@example.com'].totalKeys, 1);
    });

    it('should mark active key correctly', () => {
      const rotState = {
        keys: {
          'key1': { account_email: 'alice@example.com', status: 'active', rateLimitTier: 'tier1' },
          'key2': { account_email: 'alice@example.com', status: 'active', rateLimitTier: 'tier1' },
        },
        active_key_id: 'key2',
      };

      const summary = buildAccountSummary(rotState);
      const aliceKeys = summary['alice@example.com'].keys;
      const key1 = aliceKeys.find(k => k.id === 'key1');
      const key2 = aliceKeys.find(k => k.id === 'key2');
      // isActive is set to false (not undefined) for non-active keys
      assert.strictEqual(key1.isActive, false);
      assert.strictEqual(key2.isActive, true);
    });

    it('should track max usage across metrics', () => {
      const rotState = {
        keys: {
          'key1': {
            account_email: 'alice@example.com',
            status: 'active',
            last_usage: { five_hour: 50, seven_day: 75, seven_day_sonnet: 60 },
          },
        },
        active_key_id: 'key1',
      };

      const summary = buildAccountSummary(rotState);
      assert.strictEqual(summary['alice@example.com'].maxUsage, 75);
    });

    it('should handle invalid keys correctly', () => {
      const rotState = {
        keys: {
          'key1': { account_email: 'alice@example.com', status: 'invalid', rateLimitTier: 'tier1' },
          'key2': { account_email: 'alice@example.com', status: 'active', rateLimitTier: 'tier1' },
        },
        active_key_id: 'key2',
      };

      const summary = buildAccountSummary(rotState);
      assert.strictEqual(summary['alice@example.com'].totalKeys, 2);
      assert.strictEqual(summary['alice@example.com'].validKeys, 1);
      const invalidKey = summary['alice@example.com'].keys.find(k => k.id === 'key1');
      assert.strictEqual(invalidKey.expiresIn, null);
      assert.strictEqual(invalidKey.usage, null);
    });

    it('should calculate expiresIn relative to current time', () => {
      const futureTime = Date.now() + 600_000; // 10 min from now
      const rotState = {
        keys: {
          'key1': { account_email: 'alice@example.com', status: 'active', expiresAt: futureTime },
        },
        active_key_id: 'key1',
      };

      const summary = buildAccountSummary(rotState);
      const key = summary['alice@example.com'].keys[0];
      assert.ok(key.expiresIn > 550_000); // ~9m or more
      assert.ok(key.expiresIn < 650_000); // ~11m or less
    });

    it('should use "unknown" for missing account_email', () => {
      const rotState = {
        keys: {
          'key1': { status: 'active', rateLimitTier: 'tier1' },
        },
      };

      const summary = buildAccountSummary(rotState);
      assert.ok(summary.hasOwnProperty('unknown'));
      assert.strictEqual(summary['unknown'].totalKeys, 1);
    });
  });

  describe('computeSessionDeltas()', () => {
    it('should return empty arrays when previousAgents is null', () => {
      const current = [{ id: 'agent1' }, { id: 'agent2' }];
      const deltas = computeSessionDeltas(current, null);
      assert.deepStrictEqual(deltas, { spawned: [], died: [] });
    });

    it('should detect new spawned agents', () => {
      const previous = [{ id: 'agent1' }];
      const current = [{ id: 'agent1' }, { id: 'agent2' }];
      const deltas = computeSessionDeltas(current, previous);
      assert.strictEqual(deltas.spawned.length, 1);
      assert.strictEqual(deltas.spawned[0].id, 'agent2');
      assert.strictEqual(deltas.died.length, 0);
    });

    it('should detect died agents', () => {
      const previous = [{ id: 'agent1' }, { id: 'agent2' }];
      const current = [{ id: 'agent1' }];
      const deltas = computeSessionDeltas(current, previous);
      assert.strictEqual(deltas.spawned.length, 0);
      assert.strictEqual(deltas.died.length, 1);
      assert.strictEqual(deltas.died[0].id, 'agent2');
    });

    it('should detect both spawned and died agents', () => {
      const previous = [{ id: 'agent1' }, { id: 'agent2' }];
      const current = [{ id: 'agent2' }, { id: 'agent3' }];
      const deltas = computeSessionDeltas(current, previous);
      assert.strictEqual(deltas.spawned.length, 1);
      assert.strictEqual(deltas.spawned[0].id, 'agent3');
      assert.strictEqual(deltas.died.length, 1);
      assert.strictEqual(deltas.died[0].id, 'agent1');
    });

    it('should handle empty previous agents', () => {
      const previous = [];
      const current = [{ id: 'agent1' }];
      const deltas = computeSessionDeltas(current, previous);
      assert.strictEqual(deltas.spawned.length, 1);
      assert.strictEqual(deltas.died.length, 0);
    });

    it('should handle empty current agents', () => {
      const previous = [{ id: 'agent1' }];
      const current = [];
      const deltas = computeSessionDeltas(current, previous);
      assert.strictEqual(deltas.spawned.length, 0);
      assert.strictEqual(deltas.died.length, 1);
    });

    it('should handle no changes', () => {
      const previous = [{ id: 'agent1' }, { id: 'agent2' }];
      const current = [{ id: 'agent1' }, { id: 'agent2' }];
      const deltas = computeSessionDeltas(current, previous);
      assert.strictEqual(deltas.spawned.length, 0);
      assert.strictEqual(deltas.died.length, 0);
    });

    it('should preserve full agent objects in deltas', () => {
      const previous = [{ id: 'agent1', type: 'worker', extra: 'data' }];
      const current = [{ id: 'agent1', type: 'worker', extra: 'data' }, { id: 'agent2', type: 'monitor', foo: 'bar' }];
      const deltas = computeSessionDeltas(current, previous);
      assert.deepStrictEqual(deltas.spawned[0], { id: 'agent2', type: 'monitor', foo: 'bar' });
    });
  });
});
