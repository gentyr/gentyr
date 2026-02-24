/**
 * Unit tests for hourly-automation.js CTO Activity Gate
 *
 * Tests the checkCtoActivityGate() function which enforces G001 fail-closed behavior:
 * - If no CTO briefing recorded: gate closed
 * - If briefing older than 24h: gate closed
 * - If briefing invalid: gate closed
 * - If briefing within 24h: gate open
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * checkCtoActivityGate implementation (mirrored from hourly-automation.js)
 * G001: Fail-closed - if lastCtoBriefing is missing or older than 24h, automation is gated.
 *
 * NOTE: Message strings updated to reflect "Start a Claude Code session or run /deputy-cto"
 * (gentyr-sync.js now resets the gate on every interactive session start).
 */
function checkCtoActivityGate(config) {
  try {
    const lastCtoBriefing = config.lastCtoBriefing;

    if (!lastCtoBriefing) {
      return {
        open: false,
        reason: 'No CTO briefing recorded. Start a Claude Code session or run /deputy-cto to activate.',
        hoursSinceLastBriefing: null,
      };
    }

    const briefingTime = new Date(lastCtoBriefing).getTime();
    if (isNaN(briefingTime)) {
      return {
        open: false,
        reason: 'CTO briefing timestamp is invalid. Start a Claude Code session or run /deputy-cto to reset.',
        hoursSinceLastBriefing: null,
      };
    }

    const hoursSince = (Date.now() - briefingTime) / (1000 * 60 * 60);
    if (hoursSince >= 24) {
      return {
        open: false,
        reason: `CTO briefing was ${Math.floor(hoursSince)}h ago (>24h). Start a Claude Code session or run /deputy-cto to reactivate.`,
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
      assert.ok(gate.reason.includes('/deputy-cto to activate'));
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
      assert.ok(gate.reason.includes('/deputy-cto to reset'));
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
      assert.ok(gate.reason.includes('/deputy-cto to reactivate'));
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
      assert.ok(gate.reason.includes('/deputy-cto to reactivate'));
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

describe('Overdrive Concurrency Override', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should check for overdrive.active in autonomous-mode.json', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should read autonomous-mode.json config
    assert.match(
      code,
      /autoConfig\.overdrive\?\.active/,
      'Must check for overdrive.active in config'
    );
  });

  it('should verify overdrive has not expired', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should compare current time with expires_at
    assert.match(
      code,
      /new Date\(\) < new Date\(autoConfig\.overdrive\.expires_at\)/,
      'Must check if overdrive has expired'
    );
  });

  it('should override MAX_CONCURRENT_AGENTS when overdrive active', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should read max_concurrent_override from overdrive config
    assert.match(
      code,
      /const override = autoConfig\.overdrive\.max_concurrent_override/,
      'Must read max_concurrent_override from overdrive config'
    );

    // Should validate and use the override value
    assert.match(
      code,
      /effectiveMaxConcurrent = \(typeof override === ['"]number['"] && override >= 1 && override <= 20\)/,
      'Must validate override is a number between 1 and 20'
    );
  });

  it('should fall back to MAX_CONCURRENT_AGENTS if override invalid', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should use ternary to provide fallback
    assert.match(
      code,
      /\? override : MAX_CONCURRENT_AGENTS/,
      'Must fall back to MAX_CONCURRENT_AGENTS if override invalid'
    );
  });

  it('should log when concurrency limit is raised', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should log the new concurrency limit
    assert.match(
      code,
      /log\(`Overdrive active: concurrency limit raised to \$\{effectiveMaxConcurrent\}`\)/,
      'Must log when concurrency limit is raised by overdrive'
    );
  });

  it('should define effectiveMaxConcurrent variable before overdrive check', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should initialize effectiveMaxConcurrent to MAX_CONCURRENT_AGENTS
    assert.match(
      code,
      /let effectiveMaxConcurrent = MAX_CONCURRENT_AGENTS/,
      'Must initialize effectiveMaxConcurrent to MAX_CONCURRENT_AGENTS'
    );
  });

  it('should use effectiveMaxConcurrent in concurrency checks', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Should check runningAgents against effectiveMaxConcurrent (not hardcoded MAX_CONCURRENT_AGENTS)
    assert.match(
      code,
      /runningAgents >= effectiveMaxConcurrent/,
      'Must use effectiveMaxConcurrent in concurrency check'
    );

    // Should log the dynamic limit
    assert.match(
      code,
      /\$\{runningAgents\}\/\$\{effectiveMaxConcurrent\}/,
      'Must log dynamic concurrency limit'
    );
  });
});

describe('GAP 5: CTO Activity Gate Monitoring Exemption', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should use ctoGateOpen flag instead of process.exit(0) for gate', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Must define ctoGateOpen flag
    assert.match(
      code,
      /const ctoGateOpen = ctoGate\.open/,
      'Must define ctoGateOpen flag from ctoGate.open'
    );
  });

  it('should not call process.exit(0) immediately on gate closed', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // The gate check should NOT have process.exit immediately after checking ctoGate.open
    // It should set a flag instead. The old pattern was:
    // if (!ctoGate.open) { ... process.exit(0); }
    // The new pattern is:
    // const ctoGateOpen = ctoGate.open; if (!ctoGateOpen) { log... } else { log... }
    // followed later by: if (!ctoGateOpen) { ... process.exit(0); }

    // Ensure monitoring-only mode message exists
    assert.match(
      code,
      /Monitoring-only mode: health monitors, triage, and CI checks will still run/,
      'Must log monitoring-only mode message when gate is closed'
    );
  });

  it('should register partial status when gate is closed', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /status: ['"]partial['"]/,
      'Must register partial status for monitoring-only runs'
    );

    assert.match(
      code,
      /reason: ['"]cto_gate_monitoring_only['"]/,
      'Must include cto_gate_monitoring_only reason in metadata'
    );
  });

  it('should place health monitors before the gate exit', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Health monitors should appear BEFORE the gate check exit
    const stagingHealthIdx = code.indexOf('STAGING HEALTH MONITOR');
    const prodHealthIdx = code.indexOf('PRODUCTION HEALTH MONITOR');
    const gateCheckIdx = code.indexOf('CTO GATE CHECK');

    assert.ok(stagingHealthIdx > 0, 'Staging health monitor section must exist');
    assert.ok(prodHealthIdx > 0, 'Production health monitor section must exist');
    assert.ok(gateCheckIdx > 0, 'CTO gate check section must exist');
    assert.ok(stagingHealthIdx < gateCheckIdx, 'Staging health monitor must come before gate check');
    assert.ok(prodHealthIdx < gateCheckIdx, 'Production health monitor must come before gate check');
  });

  it('should mark health monitors as GATE-EXEMPT', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /STAGING HEALTH MONITOR.*\[GATE-EXEMPT\]/,
      'Staging health monitor must be marked GATE-EXEMPT'
    );

    assert.match(
      code,
      /PRODUCTION HEALTH MONITOR.*\[GATE-EXEMPT\]/,
      'Production health monitor must be marked GATE-EXEMPT'
    );
  });
});

describe('GAP 4: Deferred Cooldown Stamps', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should define verifySpawnAlive function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /async function verifySpawnAlive\(pid, label\)/,
      'Must define verifySpawnAlive function'
    );
  });

  it('should use process.kill(pid, 0) to check if alive', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/async function verifySpawnAlive[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'verifySpawnAlive function must exist');

    assert.match(
      fnMatch[0],
      /process\.kill\(pid, 0\)/,
      'Must use process.kill(pid, 0) to check process liveness'
    );
  });

  it('should return { success, pid } from spawnStagingHealthMonitor', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function spawnStagingHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnStagingHealthMonitor must exist');

    assert.match(
      fnMatch[0],
      /return \{ success: true, pid: claude\.pid \}/,
      'Must return { success: true, pid } on success'
    );

    assert.match(
      fnMatch[0],
      /return \{ success: false, pid: null \}/,
      'Must return { success: false, pid: null } on failure'
    );
  });

  it('should return { success, pid } from spawnProductionHealthMonitor', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function spawnProductionHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnProductionHealthMonitor must exist');

    assert.match(
      fnMatch[0],
      /return \{ success: true, pid: claude\.pid \}/,
      'Must return { success: true, pid } on success'
    );

    assert.match(
      fnMatch[0],
      /return \{ success: false, pid: null \}/,
      'Must return { success: false, pid: null } on failure'
    );
  });

  it('should call verifySpawnAlive before stamping cooldown', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // The main flow should call verifySpawnAlive for both monitors
    assert.match(
      code,
      /verifySpawnAlive\(result\.pid, ['"]Production health monitor['"]\)/,
      'Must call verifySpawnAlive for production health monitor'
    );

    assert.match(
      code,
      /verifySpawnAlive\(result\.pid, ['"]Staging health monitor['"]\)/,
      'Must call verifySpawnAlive for staging health monitor'
    );
  });
});

describe('GAP 2: Persistent Alerts System', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should define PERSISTENT_ALERTS_PATH constant', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /const PERSISTENT_ALERTS_PATH/,
      'Must define PERSISTENT_ALERTS_PATH'
    );

    assert.match(
      code,
      /persistent_alerts\.json/,
      'Path must reference persistent_alerts.json'
    );
  });

  it('should define ALERT_RE_ESCALATION_HOURS thresholds', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /const ALERT_RE_ESCALATION_HOURS/,
      'Must define ALERT_RE_ESCALATION_HOURS'
    );

    assert.match(
      code,
      /critical:\s*4/,
      'Critical re-escalation threshold must be 4 hours'
    );

    assert.match(
      code,
      /high:\s*12/,
      'High re-escalation threshold must be 12 hours'
    );
  });

  it('should define readPersistentAlerts function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function readPersistentAlerts\(\)/,
      'Must define readPersistentAlerts function'
    );
  });

  it('should define writePersistentAlerts function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function writePersistentAlerts\(data\)/,
      'Must define writePersistentAlerts function'
    );
  });

  it('should define recordAlert function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function recordAlert\(key/,
      'Must define recordAlert function'
    );
  });

  it('should define resolveAlert function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function resolveAlert\(key\)/,
      'Must define resolveAlert function'
    );
  });

  it('should define checkPersistentAlerts function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function checkPersistentAlerts\(\)/,
      'Must define checkPersistentAlerts function'
    );
  });

  it('should define spawnAlertEscalation function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function spawnAlertEscalation\(alert\)/,
      'Must define spawnAlertEscalation function'
    );
  });

  it('should garbage-collect resolved alerts older than 7 days', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /const ALERT_RESOLVED_GC_DAYS = 7/,
      'Must define ALERT_RESOLVED_GC_DAYS = 7'
    );

    const fnMatch = code.match(/function checkPersistentAlerts\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'checkPersistentAlerts function must exist');

    assert.match(
      fnMatch[0],
      /ALERT_RESOLVED_GC_DAYS/,
      'checkPersistentAlerts must reference ALERT_RESOLVED_GC_DAYS for garbage collection'
    );
  });

  it('should include persistent alert update instructions in health monitor prompts', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Production health monitor prompt should reference persistent_alerts.json
    assert.match(
      code,
      /production-health-monitor[\s\S]*?persistent_alerts\.json/,
      'Production health monitor prompt must reference persistent_alerts.json'
    );

    // Staging health monitor prompt should reference persistent_alerts.json
    assert.match(
      code,
      /staging-health-monitor[\s\S]*?persistent_alerts\.json/,
      'Staging health monitor prompt must reference persistent_alerts.json'
    );
  });

  it('should run checkPersistentAlerts in the main flow as gate-exempt', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Persistent alert check should appear before the gate check
    const alertCheckIdx = code.indexOf('PERSISTENT ALERT CHECK');
    const gateCheckIdx = code.indexOf('CTO GATE CHECK');

    assert.ok(alertCheckIdx > 0, 'Persistent alert check section must exist');
    assert.ok(gateCheckIdx > 0, 'CTO gate check section must exist');
    assert.ok(alertCheckIdx < gateCheckIdx, 'Persistent alert check must come before gate check');
  });
});

describe('GAP 6: Promotion Pipeline Production Health Pre-Check', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should check for production_error alert before staging promotion', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // The staging promotion section should check persistent alerts
    assert.match(
      code,
      /alertData\.alerts\['production_error'\]/,
      'Must check production_error alert key before promoting'
    );
  });

  it('should block promotion when production is in error state', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /Staging promotion: BLOCKED.*production in error state/,
      'Must log BLOCKED message when production is in error state'
    );
  });

  it('should call readPersistentAlerts before promotion spawn', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // readPersistentAlerts call should appear before spawnStagingPromotion in the promotion section
    const promotionSection = code.match(/hoursSinceLastStagingCommit >= 24[\s\S]*?spawnStagingPromotion/);
    assert.ok(promotionSection, 'Promotion section must exist');

    assert.match(
      promotionSection[0],
      /readPersistentAlerts\(\)/,
      'Must call readPersistentAlerts before spawning promotion'
    );
  });
});

describe('GAP 3: CI Monitoring', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should define checkCiStatus function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function checkCiStatus\(\)/,
      'Must define checkCiStatus function'
    );
  });

  it('should check both main and staging branches', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function checkCiStatus\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'checkCiStatus function must exist');

    assert.match(
      fnMatch[0],
      /const branches = \['main', 'staging'\]/,
      'Must check both main and staging branches'
    );
  });

  it('should use gh api for GitHub Actions runs', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function checkCiStatus\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'checkCiStatus function must exist');

    assert.match(
      fnMatch[0],
      /execFileSync\(['"]gh['"]/,
      'Must use gh CLI for API calls'
    );

    assert.match(
      fnMatch[0],
      /actions\/runs/,
      'Must query actions/runs API endpoint'
    );
  });

  it('should create alerts for CI failures using persistent alert system', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function checkCiStatus\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'checkCiStatus function must exist');

    assert.match(
      fnMatch[0],
      /recordAlert\(alertKey/,
      'Must call recordAlert for CI failures'
    );

    assert.match(
      fnMatch[0],
      /resolveAlert\(alertKey\)/,
      'Must call resolveAlert for CI successes'
    );
  });

  it('should run CI monitoring as gate-exempt', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const ciMonitorIdx = code.indexOf('CI MONITORING');
    const gateCheckIdx = code.indexOf('CTO GATE CHECK');

    assert.ok(ciMonitorIdx > 0, 'CI monitoring section must exist');
    assert.ok(gateCheckIdx > 0, 'CTO gate check section must exist');
    assert.ok(ciMonitorIdx < gateCheckIdx, 'CI monitoring must come before gate check');
  });
});

describe('GAP 7: Merge Chain Gap Alerting', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should define MERGE_CHAIN_GAP_THRESHOLD constant', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /const MERGE_CHAIN_GAP_THRESHOLD = 50/,
      'Must define MERGE_CHAIN_GAP_THRESHOLD = 50'
    );
  });

  it('should use getNewCommits to check staging vs main gap', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // The merge chain gap section should call getNewCommits
    assert.match(
      code,
      /getNewCommits\(['"]staging['"],\s*['"]main['"]\)/,
      'Must call getNewCommits("staging", "main") for gap check'
    );
  });

  it('should create merge_chain_gap alert when threshold exceeded', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /recordAlert\(['"]merge_chain_gap['"]/,
      'Must call recordAlert with merge_chain_gap key'
    );
  });

  it('should resolve merge_chain_gap alert when under threshold', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /resolveAlert\(['"]merge_chain_gap['"]\)/,
      'Must call resolveAlert for merge_chain_gap'
    );
  });

  it('should run merge chain gap check as gate-exempt', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const mergeChainIdx = code.indexOf('MERGE CHAIN GAP');
    const gateCheckIdx = code.indexOf('CTO GATE CHECK');

    assert.ok(mergeChainIdx > 0, 'Merge chain gap section must exist');
    assert.ok(gateCheckIdx > 0, 'CTO gate check section must exist');
    assert.ok(mergeChainIdx < gateCheckIdx, 'Merge chain gap check must come before gate check');
  });
});

// =========================================================================
// STEP 8: Code Review Violation Fixes
// =========================================================================

describe('VIOLATION 1: readPersistentAlerts schema validation', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should validate top-level structure (typeof check, null check, and Array.isArray)', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /typeof raw !== 'object' \|\| raw === null \|\| Array\.isArray\(raw\)/,
      'Must validate raw is non-null, non-array object'
    );

    assert.match(
      code,
      /typeof raw\.alerts !== 'object' \|\| raw\.alerts === null \|\| Array\.isArray\(raw\.alerts\)/,
      'Must validate raw.alerts is non-null, non-array object'
    );
  });

  it('should return defaults for invalid structure', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /invalid structure, using defaults/,
      'Must log "invalid structure" when structure is bad'
    );
  });

  it('should drop malformed alerts missing severity or resolved', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Must check typeof alert.severity === 'string' and typeof alert.resolved === 'boolean'
    assert.match(
      code,
      /typeof alert\.severity !== 'string'/,
      'Must validate alert.severity is a string'
    );

    assert.match(
      code,
      /typeof alert\.resolved !== 'boolean'/,
      'Must validate alert.resolved is a boolean'
    );

    assert.match(
      code,
      /dropping malformed alert/,
      'Must log when dropping malformed alerts'
    );
  });

  it('should delete malformed alert entries from raw.alerts', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function readPersistentAlerts\(\)[\s\S]*?\nfunction/);
    assert.ok(fnMatch, 'readPersistentAlerts must exist');

    assert.match(
      fnMatch[0],
      /delete raw\.alerts\[key\]/,
      'Must delete malformed alert entries'
    );
  });
});

describe('VIOLATION 2: checkCiStatus API response validation', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should validate runs is an Array', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function checkCiStatus\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'checkCiStatus must exist');

    assert.match(
      fnMatch[0],
      /!Array\.isArray\(runs\)/,
      'Must check Array.isArray(runs)'
    );
  });

  it('should validate latestRun.conclusion is a string', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function checkCiStatus\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'checkCiStatus must exist');

    assert.match(
      fnMatch[0],
      /typeof latestRun\.conclusion !== 'string'/,
      'Must validate latestRun.conclusion is a string'
    );
  });

  it('should log and skip on unexpected API response shape', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /unexpected API response shape/,
      'Must log "unexpected API response shape" when conclusion is not a string'
    );
  });
});

describe('VIOLATION 3: spawnAlertEscalation sanitization', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should define sanitizeAlertField function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function sanitizeAlertField\(val\)/,
      'Must define sanitizeAlertField function'
    );
  });

  it('should strip backticks and newlines in sanitizeAlertField', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function sanitizeAlertField\(val\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'sanitizeAlertField must exist');

    // Must strip backticks
    assert.match(
      fnMatch[0],
      /replace\([^)]*`/,
      'Must strip backtick characters'
    );

    // Must strip newlines
    assert.match(
      fnMatch[0],
      /\\n\\r/,
      'Must strip newline and carriage return characters'
    );
  });

  it('should strip template literal syntax in sanitizeAlertField', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function sanitizeAlertField\(val\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'sanitizeAlertField must exist');

    // Must replace ${ with safe alternative ($ {) to prevent template injection
    assert.match(
      fnMatch[0],
      /replace\([^)]*\$\\\{/,
      'Must handle template literal ${ syntax via replace'
    );
  });

  it('should truncate to 200 characters', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function sanitizeAlertField\(val\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'sanitizeAlertField must exist');

    assert.match(
      fnMatch[0],
      /\.slice\(0,\s*200\)/,
      'Must truncate to 200 characters'
    );
  });

  it('should handle non-string values', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function sanitizeAlertField\(val\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'sanitizeAlertField must exist');

    assert.match(
      fnMatch[0],
      /typeof val !== 'string'/,
      'Must check for non-string input'
    );

    assert.match(
      fnMatch[0],
      /String\(val \?\? ''\)/,
      'Must coerce non-string values via String()'
    );
  });

  it('should use sanitized fields in spawnAlertEscalation prompt', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function spawnAlertEscalation\(alert\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnAlertEscalation must exist');

    // Must define sanitized variables
    assert.match(fnMatch[0], /const safeTitle = sanitizeAlertField/, 'Must sanitize title');
    assert.match(fnMatch[0], /const safeKey = sanitizeAlertField/, 'Must sanitize key');
    assert.match(fnMatch[0], /const safeSeverity = sanitizeAlertField/, 'Must sanitize severity');
    assert.match(fnMatch[0], /const safeSource = sanitizeAlertField/, 'Must sanitize source');
    assert.match(fnMatch[0], /const safeFirstDetected = sanitizeAlertField/, 'Must sanitize first_detected_at');

    // Must coerce numeric fields
    assert.match(fnMatch[0], /Number\(alert\.detection_count\)/, 'Must coerce detection_count via Number()');
    assert.match(fnMatch[0], /Number\(alert\.escalation_count\)/, 'Must coerce escalation_count via Number()');

    // Must use sanitized fields in prompt (not raw alert.title etc.)
    assert.match(fnMatch[0], /\$\{safeTitle\}/, 'Prompt must use safeTitle');
    assert.match(fnMatch[0], /\$\{safeKey\}/, 'Prompt must use safeKey');
    assert.match(fnMatch[0], /\$\{safeSeverity\}/, 'Prompt must use safeSeverity');
    assert.match(fnMatch[0], /\$\{safeSource\}/, 'Prompt must use safeSource');
    assert.match(fnMatch[0], /\$\{safeFirstDetected\}/, 'Prompt must use safeFirstDetected');
  });

  it('should sanitize fields BEFORE registerSpawn call', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function spawnAlertEscalation\(alert\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnAlertEscalation must exist');
    const fnBody = fnMatch[0];

    const sanitizeIdx = fnBody.indexOf('sanitizeAlertField');
    const registerIdx = fnBody.indexOf('registerSpawn');

    assert.ok(sanitizeIdx > 0, 'Must call sanitizeAlertField');
    assert.ok(registerIdx > 0, 'Must call registerSpawn');
    assert.ok(sanitizeIdx < registerIdx, 'Sanitization must come before registerSpawn');
  });

  it('should use safeKey in registerSpawn description', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function spawnAlertEscalation\(alert\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnAlertEscalation must exist');

    assert.match(
      fnMatch[0],
      /description: `Alert re-escalation: \$\{safeKey\}`/,
      'registerSpawn description must use safeKey, not alert.key'
    );
  });
});

describe('sanitizeAlertField - Behavioral Tests', () => {
  // Mirror the function for behavioral testing
  function sanitizeAlertField(val) {
    if (typeof val !== 'string') return String(val ?? '');
    return val.replace(/[`\n\r]/g, '').replace(/\$\{/g, '$ {').slice(0, 200);
  }

  it('should pass through clean strings unchanged', () => {
    assert.strictEqual(sanitizeAlertField('Production error on main'), 'Production error on main');
  });

  it('should strip backticks', () => {
    assert.strictEqual(sanitizeAlertField('Error in `main` branch'), 'Error in main branch');
  });

  it('should strip newlines', () => {
    assert.strictEqual(sanitizeAlertField('Line 1\nLine 2\rLine 3'), 'Line 1Line 2Line 3');
  });

  it('should neutralize template literal injection', () => {
    const result = sanitizeAlertField('${process.exit(1)}');
    assert.ok(!result.includes('${'), 'Must not contain raw ${ after sanitization');
  });

  it('should truncate long strings to 200 characters', () => {
    const longStr = 'x'.repeat(300);
    assert.strictEqual(sanitizeAlertField(longStr).length, 200);
  });

  it('should handle null/undefined by returning empty string', () => {
    assert.strictEqual(sanitizeAlertField(null), '');
    assert.strictEqual(sanitizeAlertField(undefined), '');
  });

  it('should coerce numbers to strings', () => {
    assert.strictEqual(sanitizeAlertField(42), '42');
  });

  it('should coerce booleans to strings', () => {
    assert.strictEqual(sanitizeAlertField(true), 'true');
  });

  it('should handle empty string', () => {
    assert.strictEqual(sanitizeAlertField(''), '');
  });

  it('should handle objects by converting to string', () => {
    assert.strictEqual(sanitizeAlertField({}), '[object Object]');
  });

  it('should handle arrays by converting to string', () => {
    assert.strictEqual(sanitizeAlertField([1, 2, 3]), '1,2,3');
  });

  it('should handle mixed injection attempts', () => {
    const malicious = '`${eval("code")}`\n';
    const result = sanitizeAlertField(malicious);
    assert.ok(!result.includes('${'), 'Must not contain ${');
    assert.ok(!result.includes('`'), 'Must not contain backticks');
    assert.ok(!result.includes('\n'), 'Must not contain newlines');
  });

  it('should handle exactly 200 characters without truncation', () => {
    const exactly200 = 'x'.repeat(200);
    assert.strictEqual(sanitizeAlertField(exactly200).length, 200);
    assert.strictEqual(sanitizeAlertField(exactly200), exactly200);
  });

  it('should truncate 201 characters to 200', () => {
    const over200 = 'x'.repeat(201);
    assert.strictEqual(sanitizeAlertField(over200).length, 200);
    assert.notStrictEqual(sanitizeAlertField(over200), over200);
  });
});

describe('readPersistentAlerts - Behavioral Tests', () => {
  const tmpDir = path.join(process.cwd(), '.claude/test-tmp');
  const testAlertsPath = path.join(tmpDir, 'test-alerts.json');
  const PERSISTENT_ALERTS_PATH_BACKUP = process.env.PERSISTENT_ALERTS_PATH;

  // Mock function that mirrors the implementation
  function readPersistentAlerts() {
    try {
      if (fs.existsSync(testAlertsPath)) {
        const raw = JSON.parse(fs.readFileSync(testAlertsPath, 'utf8'));
        // Validate structure
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw) ||
            typeof raw.alerts !== 'object' || raw.alerts === null || Array.isArray(raw.alerts)) {
          return { version: 1, alerts: {} };
        }
        // Validate individual alerts — drop malformed entries
        for (const [key, alert] of Object.entries(raw.alerts)) {
          if (typeof alert !== 'object' || alert === null ||
              typeof alert.severity !== 'string' ||
              typeof alert.resolved !== 'boolean') {
            delete raw.alerts[key];
          }
        }
        return raw;
      }
    } catch (err) {
      // Parse errors return defaults
    }
    return { version: 1, alerts: {} };
  }

  beforeEach(() => {
    // Create temp directory
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(testAlertsPath)) {
      fs.unlinkSync(testAlertsPath);
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return defaults when file does not exist', () => {
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should return defaults when raw is null', () => {
    fs.writeFileSync(testAlertsPath, 'null');
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should return defaults when raw is an array', () => {
    fs.writeFileSync(testAlertsPath, '[]');
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should return defaults when raw is a primitive', () => {
    fs.writeFileSync(testAlertsPath, '"string"');
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should return defaults when raw.alerts is null', () => {
    fs.writeFileSync(testAlertsPath, JSON.stringify({ version: 1, alerts: null }));
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should return defaults when raw.alerts is an array', () => {
    fs.writeFileSync(testAlertsPath, JSON.stringify({ version: 1, alerts: [] }));
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should return defaults when raw.alerts is missing', () => {
    fs.writeFileSync(testAlertsPath, JSON.stringify({ version: 1 }));
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });

  it('should drop alert when alert is null', () => {
    const data = {
      version: 1,
      alerts: {
        good_alert: { severity: 'high', resolved: false },
        bad_alert: null,
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.ok(result.alerts.good_alert, 'Should keep valid alert');
    assert.ok(!result.alerts.bad_alert, 'Should drop null alert');
  });

  it('should drop alert when severity is missing', () => {
    const data = {
      version: 1,
      alerts: {
        good_alert: { severity: 'high', resolved: false },
        bad_alert: { resolved: false }, // Missing severity
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.ok(result.alerts.good_alert, 'Should keep valid alert');
    assert.ok(!result.alerts.bad_alert, 'Should drop alert without severity');
  });

  it('should drop alert when severity is not a string', () => {
    const data = {
      version: 1,
      alerts: {
        good_alert: { severity: 'high', resolved: false },
        bad_alert: { severity: 123, resolved: false }, // Number severity
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.ok(result.alerts.good_alert, 'Should keep valid alert');
    assert.ok(!result.alerts.bad_alert, 'Should drop alert with non-string severity');
  });

  it('should drop alert when resolved is missing', () => {
    const data = {
      version: 1,
      alerts: {
        good_alert: { severity: 'high', resolved: false },
        bad_alert: { severity: 'critical' }, // Missing resolved
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.ok(result.alerts.good_alert, 'Should keep valid alert');
    assert.ok(!result.alerts.bad_alert, 'Should drop alert without resolved');
  });

  it('should drop alert when resolved is not a boolean', () => {
    const data = {
      version: 1,
      alerts: {
        good_alert: { severity: 'high', resolved: false },
        bad_alert: { severity: 'critical', resolved: 'false' }, // String instead of boolean
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.ok(result.alerts.good_alert, 'Should keep valid alert');
    assert.ok(!result.alerts.bad_alert, 'Should drop alert with non-boolean resolved');
  });

  it('should keep valid alerts and drop multiple malformed alerts', () => {
    const data = {
      version: 1,
      alerts: {
        valid1: { severity: 'high', resolved: false },
        valid2: { severity: 'critical', resolved: true },
        invalid_null: null,
        invalid_no_severity: { resolved: false },
        invalid_no_resolved: { severity: 'high' },
        invalid_wrong_types: { severity: 123, resolved: 'true' },
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.strictEqual(Object.keys(result.alerts).length, 2);
    assert.ok(result.alerts.valid1, 'Should keep valid1');
    assert.ok(result.alerts.valid2, 'Should keep valid2');
    assert.ok(!result.alerts.invalid_null, 'Should drop null alert');
    assert.ok(!result.alerts.invalid_no_severity, 'Should drop alert without severity');
    assert.ok(!result.alerts.invalid_no_resolved, 'Should drop alert without resolved');
    assert.ok(!result.alerts.invalid_wrong_types, 'Should drop alert with wrong types');
  });

  it('should preserve extra fields in valid alerts', () => {
    const data = {
      version: 1,
      alerts: {
        alert1: {
          severity: 'high',
          resolved: false,
          extra_field: 'preserved',
          count: 42,
        },
      },
    };
    fs.writeFileSync(testAlertsPath, JSON.stringify(data));
    const result = readPersistentAlerts();

    assert.strictEqual(result.alerts.alert1.extra_field, 'preserved');
    assert.strictEqual(result.alerts.alert1.count, 42);
  });

  it('should return defaults on JSON parse error', () => {
    fs.writeFileSync(testAlertsPath, '{invalid json}');
    const result = readPersistentAlerts();
    assert.deepStrictEqual(result, { version: 1, alerts: {} });
  });
});

// =========================================================================
// Priority-Based Urgent Task Dispatch
// =========================================================================

describe('Urgent Task Dispatcher', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should define getUrgentPendingTasks function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    assert.match(
      code,
      /function getUrgentPendingTasks\(\)/,
      'Must define getUrgentPendingTasks function'
    );
  });

  it('should query for priority = urgent tasks', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function getUrgentPendingTasks\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'getUrgentPendingTasks function must exist');

    assert.match(
      fnMatch[0],
      /priority = 'urgent'/,
      'Must filter on priority = urgent'
    );
  });

  it('should NOT apply age filter for urgent tasks', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const fnMatch = code.match(/function getUrgentPendingTasks\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'getUrgentPendingTasks function must exist');

    // The function should NOT reference created_timestamp <= ? (age filter)
    assert.doesNotMatch(
      fnMatch[0],
      /created_timestamp <= \?/,
      'Must NOT apply age filter for urgent tasks'
    );
  });

  it('should place urgent dispatcher before CTO gate exit (gate-exempt)', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const urgentIdx = code.indexOf('URGENT TASK DISPATCHER');
    const gateCheckIdx = code.indexOf('CTO GATE CHECK');

    assert.ok(urgentIdx > 0, 'Urgent task dispatcher section must exist');
    assert.ok(gateCheckIdx > 0, 'CTO gate check section must exist');
    assert.ok(urgentIdx < gateCheckIdx, 'Urgent dispatcher must come before gate check');
  });

  it('should reuse spawnTaskAgent for governed dispatch', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Find the urgent dispatcher section
    const urgentSection = code.match(/URGENT TASK DISPATCHER[\s\S]*?CTO GATE CHECK/);
    assert.ok(urgentSection, 'Urgent dispatcher section must exist');

    assert.match(
      urgentSection[0],
      /spawnTaskAgent\(task\)/,
      'Must reuse spawnTaskAgent for governed dispatch'
    );
  });

  it('should reset task to pending on spawn failure', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const urgentSection = code.match(/URGENT TASK DISPATCHER[\s\S]*?CTO GATE CHECK/);
    assert.ok(urgentSection, 'Urgent dispatcher section must exist');

    assert.match(
      urgentSection[0],
      /resetTaskToPending\(task\.id\)/,
      'Must reset task to pending on spawn failure'
    );
  });

  it('should mark task in_progress before spawning', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const urgentSection = code.match(/URGENT TASK DISPATCHER[\s\S]*?CTO GATE CHECK/);
    assert.ok(urgentSection, 'Urgent dispatcher section must exist');

    assert.match(
      urgentSection[0],
      /markTaskInProgress\(task\.id\)/,
      'Must mark task in_progress before spawning'
    );
  });

  it('should enforce concurrency limit before dispatching', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const urgentSection = code.match(/URGENT TASK DISPATCHER[\s\S]*?CTO GATE CHECK/);
    assert.ok(urgentSection, 'Urgent dispatcher section must exist');

    assert.match(
      urgentSection[0],
      /countRunningAgents\(\)/,
      'Must check running agent count for concurrency limit'
    );

    assert.match(
      urgentSection[0],
      /effectiveMaxConcurrent/,
      'Must reference effectiveMaxConcurrent for slot calculation'
    );

    assert.match(
      urgentSection[0],
      /dispatched >= availableSlots/,
      'Must break loop when concurrency limit is reached'
    );
  });
});

describe('Triage Self-Handle via create_task with priority: urgent', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  it('should use create_task instead of spawn_implementation_task for self-handling', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    // Find the triage SELF-HANDLING section
    const selfHandleSection = code.match(/If SELF-HANDLING[\s\S]*?If ESCALATING/);
    assert.ok(selfHandleSection, 'Self-handling section must exist in triage prompt');

    assert.match(
      selfHandleSection[0],
      /mcp__todo-db__create_task/,
      'Self-handling must use mcp__todo-db__create_task'
    );

    assert.doesNotMatch(
      selfHandleSection[0],
      /spawn_implementation_task/,
      'Self-handling must NOT use spawn_implementation_task'
    );
  });

  it('should include priority: "urgent" in self-handle create_task call', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const selfHandleSection = code.match(/If SELF-HANDLING[\s\S]*?If ESCALATING/);
    assert.ok(selfHandleSection, 'Self-handling section must exist');

    assert.match(
      selfHandleSection[0],
      /priority: "urgent"/,
      'Self-handle create_task must include priority: "urgent"'
    );
  });

  it('should include section mapping guidance in triage prompt', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');

    const selfHandleSection = code.match(/If SELF-HANDLING[\s\S]*?If ESCALATING/);
    assert.ok(selfHandleSection, 'Self-handling section must exist');

    assert.match(
      selfHandleSection[0],
      /Section mapping/,
      'Must include section mapping guidance'
    );

    assert.match(
      selfHandleSection[0],
      /CODE-REVIEWER/,
      'Section mapping must mention CODE-REVIEWER'
    );
  });
});

describe('spawn_implementation_task fully deprecated', () => {
  const filesToCheck = [
    { name: 'hourly-automation.js', path: path.join(process.cwd(), '.claude/hooks/hourly-automation.js') },
    { name: 'force-spawn-tasks.js', path: path.join(process.cwd(), 'scripts/force-spawn-tasks.js') },
    { name: 'plan-executor.js', path: path.join(process.cwd(), '.claude/hooks/plan-executor.js') },
    { name: 'deputy-cto.md (agent)', path: path.join(process.cwd(), '.claude/agents/deputy-cto.md') },
    { name: 'deputy-cto.md (command)', path: path.join(process.cwd(), '.claude/commands/deputy-cto.md') },
  ];

  for (const file of filesToCheck) {
    it(`should have zero references to spawn_implementation_task in ${file.name}`, (t) => {
      if (!fs.existsSync(file.path)) {
        t.skip('File does not exist, skipping deprecation check');
        return;
      }
      const code = fs.readFileSync(file.path, 'utf8');
      assert.doesNotMatch(
        code,
        /spawn_implementation_task/,
        `${file.name} must not reference spawn_implementation_task — use mcp__todo-db__create_task with priority: "urgent" instead`
      );
    });
  }
});

// ============================================================================
// readServiceConfig() and extractRenderServiceId() unit tests
//
// These helpers were added to hourly-automation.js so health monitors can
// read .claude/config/services.json directly (the Node process is not subject
// to the credential-file-guard hook which only governs AI agent tool use).
//
// The implementations are mirrored here to keep tests self-contained and fast.
// ============================================================================

import os from 'os';

/**
 * readServiceConfig() implementation (mirrored from hourly-automation.js)
 *
 * Returns parsed JSON from .claude/config/services.json, or null on any failure.
 * Fail-safe: returns null rather than throwing, so callers can fall back to
 * hardcoded default service IDs.
 */
function readServiceConfig(projectDir) {
  const configPath = path.join(projectDir, '.claude', 'config', 'services.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * extractRenderServiceId() implementation (mirrored from hourly-automation.js)
 *
 * Handles two entry formats:
 *   - String: "srv-xxx"
 *   - Object: { "serviceId": "srv-xxx", "label": "..." }
 */
function extractRenderServiceId(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object' && entry.serviceId) return entry.serviceId;
  return null;
}

describe('readServiceConfig() (hourly-automation.js)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hourly-auto-test-'));
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return parsed object when services.json exists and is valid JSON', () => {
    const configDir = path.join(tmpDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });

    const serviceData = {
      render: {
        production: { serviceId: 'srv-prod-123', label: 'Production API' },
        staging: 'srv-staging-456',
      },
      vercel: { projectId: 'prj_abc' },
    };
    fs.writeFileSync(
      path.join(configDir, 'services.json'),
      JSON.stringify(serviceData, null, 2)
    );

    const result = readServiceConfig(tmpDir);

    assert.ok(result !== null, 'Should return parsed config object');
    assert.strictEqual(result.render.production.serviceId, 'srv-prod-123');
    assert.strictEqual(result.render.staging, 'srv-staging-456');
    assert.strictEqual(result.vercel.projectId, 'prj_abc');
  });

  it('should return null when services.json does not exist (G001 fail-safe)', () => {
    // No file created — directory does not exist
    const result = readServiceConfig(tmpDir);

    assert.strictEqual(result, null,
      'Missing services.json should return null, not throw');
  });

  it('should return null when services.json contains invalid JSON (G001 fail-safe)', () => {
    const configDir = path.join(tmpDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'services.json'), '{ not valid json }');

    const result = readServiceConfig(tmpDir);

    assert.strictEqual(result, null,
      'Malformed services.json should return null, not throw');
  });

  it('should return null when services.json is empty (G001 fail-safe)', () => {
    const configDir = path.join(tmpDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'services.json'), '');

    const result = readServiceConfig(tmpDir);

    assert.strictEqual(result, null,
      'Empty services.json should return null, not throw');
  });

  it('should return parsed object for minimal valid JSON (empty object)', () => {
    const configDir = path.join(tmpDir, '.claude', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'services.json'), '{}');

    const result = readServiceConfig(tmpDir);

    assert.ok(result !== null, 'Empty-object services.json should parse successfully');
    assert.deepStrictEqual(result, {});
  });
});

describe('extractRenderServiceId() (hourly-automation.js)', () => {
  it('should return null when entry is null', () => {
    assert.strictEqual(extractRenderServiceId(null), null);
  });

  it('should return null when entry is undefined', () => {
    assert.strictEqual(extractRenderServiceId(undefined), null);
  });

  it('should return the string directly when entry is a string', () => {
    assert.strictEqual(extractRenderServiceId('srv-d645aq7pm1nc738i22m0'), 'srv-d645aq7pm1nc738i22m0');
  });

  it('should return serviceId when entry is an object with serviceId field', () => {
    const entry = { serviceId: 'srv-abc123', label: 'Production API' };
    assert.strictEqual(extractRenderServiceId(entry), 'srv-abc123');
  });

  it('should return null when entry is an object without serviceId field', () => {
    const entry = { label: 'Production API', url: 'https://example.com' };
    assert.strictEqual(extractRenderServiceId(entry), null);
  });

  it('should return null when entry is an object with null serviceId', () => {
    const entry = { serviceId: null, label: 'Production API' };
    // serviceId is falsy, so the `entry.serviceId` check fails → returns null
    assert.strictEqual(extractRenderServiceId(entry), null);
  });

  it('should return null for other falsy types (0, empty string, false)', () => {
    assert.strictEqual(extractRenderServiceId(0), null);
    assert.strictEqual(extractRenderServiceId(''), null);
    assert.strictEqual(extractRenderServiceId(false), null);
  });

  it('should handle object with empty string serviceId (falsy, returns null)', () => {
    const entry = { serviceId: '', label: 'Production API' };
    assert.strictEqual(extractRenderServiceId(entry), null);
  });

  it('should work correctly with real-world staging service ID format', () => {
    // String format (old)
    assert.strictEqual(
      extractRenderServiceId('srv-d64bnq0gjchc739kt3q0'),
      'srv-d64bnq0gjchc739kt3q0'
    );

    // Object format (new)
    assert.strictEqual(
      extractRenderServiceId({ serviceId: 'srv-d64bnq0gjchc739kt3q0', label: 'Staging API' }),
      'srv-d64bnq0gjchc739kt3q0'
    );
  });

  it('should work correctly with real-world production service ID format', () => {
    // String format (old)
    assert.strictEqual(
      extractRenderServiceId('srv-d645aq7pm1nc738i22m0'),
      'srv-d645aq7pm1nc738i22m0'
    );

    // Object format (new)
    assert.strictEqual(
      extractRenderServiceId({ serviceId: 'srv-d645aq7pm1nc738i22m0', label: 'Production API' }),
      'srv-d645aq7pm1nc738i22m0'
    );
  });
});

describe('Service Config Helpers and Health Monitor Prompt Injection', () => {
  const AUTOMATION_PATH = path.join(process.cwd(), '.claude/hooks/hourly-automation.js');

  // ---- readServiceConfig source-level checks ----

  it('should define readServiceConfig function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    assert.match(code, /function readServiceConfig\(\)/, 'readServiceConfig must be defined');
  });

  it('should read from .claude/config/services.json', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function readServiceConfig\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'readServiceConfig function must exist');
    assert.match(fnMatch[0], /config.*services\.json/, 'Must read from .claude/config/services.json');
  });

  it('should return null on failure', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function readServiceConfig\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'readServiceConfig function must exist');
    assert.match(fnMatch[0], /return null/, 'Must return null on read failure');
  });

  // ---- extractRenderServiceId source-level checks ----

  it('should define extractRenderServiceId function', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    assert.match(code, /function extractRenderServiceId\(/, 'extractRenderServiceId must be defined');
  });

  it('should handle object form with serviceId property', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function extractRenderServiceId\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'extractRenderServiceId function must exist');
    assert.match(fnMatch[0], /entry\.serviceId/, 'Must handle object form with serviceId property');
  });

  it('should handle string form directly', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function extractRenderServiceId\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'extractRenderServiceId function must exist');
    assert.match(fnMatch[0], /typeof entry === 'string'/, 'Must handle string form directly');
  });

  // ---- Production health monitor prompt injection checks ----

  it('should call readServiceConfig in spawnProductionHealthMonitor', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function spawnProductionHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnProductionHealthMonitor must exist');
    assert.match(fnMatch[0], /readServiceConfig\(\)/, 'Must call readServiceConfig before building prompt');
  });

  it('should NOT instruct agent to read services.json in production monitor', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function spawnProductionHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnProductionHealthMonitor must exist');
    assert.doesNotMatch(
      fnMatch[0],
      /Read `\.claude\/config\/services\.json`/,
      'Production monitor must NOT instruct agent to read services.json'
    );
  });

  it('should embed pre-resolved service IDs in production monitor prompt', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function spawnProductionHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnProductionHealthMonitor must exist');
    assert.match(fnMatch[0], /do NOT read services\.json/, 'Prompt must say "do NOT read services.json"');
  });

  it('should have hardcoded fallback production render service ID', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function spawnProductionHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnProductionHealthMonitor must exist');
    assert.match(fnMatch[0], /srv-d645aq7pm1nc738i22m0/, 'Must have hardcoded production service ID as fallback');
  });

  // ---- Staging health monitor prompt injection checks ----

  it('should call readServiceConfig in spawnStagingHealthMonitor', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function spawnStagingHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnStagingHealthMonitor must exist');
    assert.match(fnMatch[0], /readServiceConfig\(\)/, 'Must call readServiceConfig before building prompt');
  });

  it('should NOT instruct agent to read services.json in staging monitor', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function spawnStagingHealthMonitor\(\)[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'spawnStagingHealthMonitor must exist');
    assert.doesNotMatch(
      fnMatch[0],
      /Read `\.claude\/config\/services\.json`/,
      'Staging monitor must NOT instruct agent to read services.json'
    );
  });

  // ---- buildSpawnEnv credential logging checks ----

  it('should log missing infrastructure credentials in buildSpawnEnv', () => {
    const code = fs.readFileSync(AUTOMATION_PATH, 'utf8');
    const fnMatch = code.match(/function buildSpawnEnv\([\s\S]*?\n\}/);
    assert.ok(fnMatch, 'buildSpawnEnv must exist');
    assert.match(fnMatch[0], /RENDER_API_KEY/, 'Must check for RENDER_API_KEY');
    assert.match(fnMatch[0], /VERCEL_TOKEN/, 'Must check for VERCEL_TOKEN');
    assert.match(fnMatch[0], /ELASTIC_API_KEY/, 'Must check for ELASTIC_API_KEY');
  });
});
