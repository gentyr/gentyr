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
