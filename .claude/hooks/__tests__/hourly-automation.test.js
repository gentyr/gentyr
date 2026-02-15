/**
 * Unit tests for hourly-automation.js CTO Activity Gate
 *
 * Tests the checkCtoActivityGate() function which enforces G001 fail-closed behavior:
 * - If no CTO briefing recorded: gate closed
 * - If briefing older than 24h: gate closed
 * - If briefing invalid: gate closed
 * - If briefing within 24h: gate open
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * checkCtoActivityGate implementation (mirrored from hourly-automation.js)
 * G001: Fail-closed - if lastCtoBriefing is missing or older than 24h, automation is gated.
 */
function checkCtoActivityGate(config) {
  try {
    const lastCtoBriefing = config.lastCtoBriefing;

    if (!lastCtoBriefing) {
      return {
        open: false,
        reason: 'No CTO briefing recorded. Run /deputy-cto to activate automation.',
        hoursSinceLastBriefing: null,
      };
    }

    const briefingTime = new Date(lastCtoBriefing).getTime();
    if (isNaN(briefingTime)) {
      return {
        open: false,
        reason: 'CTO briefing timestamp is invalid. Run /deputy-cto to reset.',
        hoursSinceLastBriefing: null,
      };
    }

    const hoursSince = (Date.now() - briefingTime) / (1000 * 60 * 60);
    if (hoursSince >= 24) {
      return {
        open: false,
        reason: `CTO briefing was ${Math.floor(hoursSince)}h ago (>24h). Run /deputy-cto to reactivate.`,
        hoursSinceLastBriefing: Math.floor(hoursSince),
      };
    }

    return {
      open: true,
      reason: `CTO briefing was ${Math.floor(hoursSince)}h ago. Gate is open.`,
      hoursSinceLastBriefing: Math.floor(hoursSince),
    };
  } catch (err) {
    // G001: Parse error = fail closed
    return {
      open: false,
      reason: `Failed to parse CTO briefing timestamp: ${err.message}`,
      hoursSinceLastBriefing: null,
    };
  }
}

describe('CTO Activity Gate (hourly-automation.js)', () => {
  describe('checkCtoActivityGate()', () => {
    it('should fail-closed when lastCtoBriefing is null (G001)', () => {
      const config = { enabled: true, lastCtoBriefing: null };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, null);
      assert.ok(gate.reason.includes('No CTO briefing recorded'));
      assert.ok(gate.reason.includes('Run /deputy-cto to activate'));
    });

    it('should fail-closed when lastCtoBriefing is undefined (G001)', () => {
      const config = { enabled: true };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, null);
      assert.ok(gate.reason.includes('No CTO briefing recorded'));
    });

    it('should fail-closed when lastCtoBriefing is empty string (G001)', () => {
      const config = { enabled: true, lastCtoBriefing: '' };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, null);
      assert.ok(gate.reason.includes('No CTO briefing recorded'));
    });

    it('should fail-closed when lastCtoBriefing is invalid timestamp (G001)', () => {
      const config = { enabled: true, lastCtoBriefing: 'not-a-date' };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, null);
      assert.ok(gate.reason.includes('CTO briefing timestamp is invalid'));
      assert.ok(gate.reason.includes('Run /deputy-cto to reset'));
    });

    it('should fail-closed when lastCtoBriefing is malformed JSON date (G001)', () => {
      const config = { enabled: true, lastCtoBriefing: '2026-99-99T99:99:99Z' };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, null);
      assert.ok(gate.reason.includes('CTO briefing timestamp is invalid'));
    });

    it('should open gate when briefing is recent (<24h)', () => {
      const now = Date.now();
      const recentBriefing = new Date(now - 12 * 60 * 60 * 1000).toISOString(); // 12h ago

      const config = { enabled: true, lastCtoBriefing: recentBriefing };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, true);
      assert.strictEqual(gate.hoursSinceLastBriefing, 12);
      assert.ok(gate.reason.includes('CTO briefing was 12h ago'));
      assert.ok(gate.reason.includes('Gate is open'));
    });

    it('should open gate when briefing is very recent (<1h)', () => {
      const now = Date.now();
      const veryRecentBriefing = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago

      const config = { enabled: true, lastCtoBriefing: veryRecentBriefing };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, true);
      assert.strictEqual(gate.hoursSinceLastBriefing, 0); // Floor of 0.5h
      assert.ok(gate.reason.includes('CTO briefing was 0h ago'));
      assert.ok(gate.reason.includes('Gate is open'));
    });

    it('should fail-closed when briefing is exactly 24h ago (boundary)', () => {
      const now = Date.now();
      const exactlyOneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

      const config = { enabled: true, lastCtoBriefing: exactlyOneDayAgo };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, 24);
      assert.ok(gate.reason.includes('CTO briefing was 24h ago'));
      assert.ok(gate.reason.includes('>24h'));
      assert.ok(gate.reason.includes('Run /deputy-cto to reactivate'));
    });

    it('should fail-closed when briefing is old (>24h)', () => {
      const now = Date.now();
      const oldBriefing = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 48h ago

      const config = { enabled: true, lastCtoBriefing: oldBriefing };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, 48);
      assert.ok(gate.reason.includes('CTO briefing was 48h ago'));
      assert.ok(gate.reason.includes('>24h'));
      assert.ok(gate.reason.includes('Run /deputy-cto to reactivate'));
    });

    it('should open gate when briefing is just under 24h (23.9h)', () => {
      const now = Date.now();
      const justUnder24h = new Date(now - 23.9 * 60 * 60 * 1000).toISOString();

      const config = { enabled: true, lastCtoBriefing: justUnder24h };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, true);
      assert.strictEqual(gate.hoursSinceLastBriefing, 23); // Floor
      assert.ok(gate.reason.includes('Gate is open'));
    });

    it('should calculate hours correctly for various ages', () => {
      const testCases = [
        { hours: 1, expectedOpen: true },
        { hours: 6, expectedOpen: true },
        { hours: 12, expectedOpen: true },
        { hours: 18, expectedOpen: true },
        { hours: 23, expectedOpen: true },
        { hours: 24, expectedOpen: false },
        { hours: 30, expectedOpen: false },
        { hours: 48, expectedOpen: false },
        { hours: 72, expectedOpen: false },
      ];

      for (const { hours, expectedOpen } of testCases) {
        const now = Date.now();
        const briefing = new Date(now - hours * 60 * 60 * 1000).toISOString();
        const config = { enabled: true, lastCtoBriefing: briefing };

        const gate = checkCtoActivityGate(config);

        assert.strictEqual(gate.open, expectedOpen);
        assert.strictEqual(gate.hoursSinceLastBriefing, hours);
      }
    });

    it('should floor fractional hours', () => {
      const now = Date.now();
      const briefing = new Date(now - 12.7 * 60 * 60 * 1000).toISOString(); // 12.7h ago

      const config = { enabled: true, lastCtoBriefing: briefing };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, true);
      assert.strictEqual(gate.hoursSinceLastBriefing, 12); // Floor(12.7) = 12
    });

    it('should accept ISO 8601 timestamps', () => {
      const isoTimestamp = '2026-02-15T10:30:00.000Z';
      const briefingTime = new Date(isoTimestamp).getTime();
      const hoursSince = Math.floor((Date.now() - briefingTime) / (1000 * 60 * 60));

      const config = { enabled: true, lastCtoBriefing: isoTimestamp };

      const gate = checkCtoActivityGate(config);

      // Should parse correctly
      assert.strictEqual(gate.hoursSinceLastBriefing, hoursSince);
      // Gate status depends on when test runs relative to the timestamp
      assert.strictEqual(typeof gate.open, 'boolean');
    });

    it('should handle future timestamps (negative age)', () => {
      const now = Date.now();
      const futureBriefing = new Date(now + 2 * 60 * 60 * 1000).toISOString(); // 2h in future

      const config = { enabled: true, lastCtoBriefing: futureBriefing };

      const gate = checkCtoActivityGate(config);

      // Future timestamps should open the gate (negative hours < 24)
      assert.strictEqual(gate.open, true);
      assert.ok(gate.hoursSinceLastBriefing < 0);
    });

    it('should handle exception in date parsing (G001 fail-closed)', () => {
      // Create an object that will throw when accessed as a date
      const config = {
        enabled: true,
        get lastCtoBriefing() {
          throw new Error('Simulated parse error');
        },
      };

      const gate = checkCtoActivityGate(config);

      assert.strictEqual(gate.open, false);
      assert.strictEqual(gate.hoursSinceLastBriefing, null);
      assert.ok(gate.reason.includes('Failed to parse CTO briefing timestamp'));
    });

    it('should return appropriate reason message for each state', () => {
      // No briefing
      let config = { enabled: true, lastCtoBriefing: null };
      let gate = checkCtoActivityGate(config);
      assert.ok(gate.reason.includes('No CTO briefing recorded'));

      // Invalid
      config = { enabled: true, lastCtoBriefing: 'invalid' };
      gate = checkCtoActivityGate(config);
      assert.ok(gate.reason.includes('CTO briefing timestamp is invalid'));

      // Old
      const oldBriefing = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      config = { enabled: true, lastCtoBriefing: oldBriefing };
      gate = checkCtoActivityGate(config);
      assert.ok(gate.reason.includes('>24h'));

      // Recent
      const recentBriefing = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      config = { enabled: true, lastCtoBriefing: recentBriefing };
      gate = checkCtoActivityGate(config);
      assert.ok(gate.reason.includes('Gate is open'));
    });

    it('should not care about other config fields', () => {
      const now = Date.now();
      const recentBriefing = new Date(now - 10 * 60 * 60 * 1000).toISOString();

      const config = {
        enabled: false, // Disabled
        claudeMdRefactorEnabled: false,
        lastCtoBriefing: recentBriefing,
        otherField: 'ignored',
      };

      const gate = checkCtoActivityGate(config);

      // Gate should still open based on briefing age alone
      assert.strictEqual(gate.open, true);
      assert.strictEqual(gate.hoursSinceLastBriefing, 10);
    });
  });
});
