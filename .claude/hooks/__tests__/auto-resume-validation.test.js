/**
 * Tests for auto-resume validation and session reaper spawn grace period changes.
 *
 * Validates:
 * 1. OP connectivity check gates auto-resume only when token IS configured
 * 2. The `continue` that skips resume is INSIDE the OP token check block (not after it)
 * 3. Crash-loop cooldown default is 15 minutes
 * 4. Crash-loop cooldown checks `pauseDetails.reason === 'crash_loop_circuit_breaker'`
 * 5. Session reaper SPAWN_GRACE_MS is 60 seconds (not 120)
 * 6. Revival events cleanup uses correct 24-hour DELETE query
 *
 * Run with: node --test .claude/hooks/__tests__/auto-resume-validation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();
const HOURLY_AUTOMATION_PATH = path.join(PROJECT_DIR, '.claude/hooks/hourly-automation.js');
const SESSION_REAPER_PATH = path.join(PROJECT_DIR, '.claude/hooks/lib/session-reaper.js');

describe('auto-resume-validation: OP connectivity check', () => {
  it('should call execFileSync with op whoami in stale-pause-resume section', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /execFileSync\(['"]op['"],\s*\[['"]whoami['"]\]/,
      'Must call execFileSync("op", ["whoami"]) for 1Password connectivity check'
    );
  });

  it('should guard the op whoami call with OP_SERVICE_ACCOUNT_TOKEN check', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /if\s*\(process\.env\.OP_SERVICE_ACCOUNT_TOKEN\)[\s\S]*?execFileSync\(['"]op['"],\s*\[['"]whoami['"]\]/,
      'execFileSync("op", ["whoami"]) must be inside if (process.env.OP_SERVICE_ACCOUNT_TOKEN) block'
    );
  });

  it('should have the continue inside the OP token check block, not after it', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    const opTokenBlockMatch = code.match(
      /if\s*\(process\.env\.OP_SERVICE_ACCOUNT_TOKEN\)\s*\{([\s\S]*?)(?=\n\s{8}\/\/|\n\s{8}const pauseDetails)/
    );
    assert.ok(opTokenBlockMatch, 'Must find the if (process.env.OP_SERVICE_ACCOUNT_TOKEN) block');
    const opTokenBlock = opTokenBlockMatch[1];
    assert.match(
      opTokenBlock,
      /if\s*\(!opReachable\)\s*\{[\s\S]*?continue/,
      'continue must be inside the OP token block when opReachable is false'
    );
  });

  it('should set a timeout on the op whoami call', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    const opWhoamiMatch = code.match(
      /execFileSync\(['"]op['"],\s*\[['"]whoami['"]\][\s\S]*?\)/
    );
    assert.ok(opWhoamiMatch, 'Must find execFileSync op whoami call');
    assert.match(opWhoamiMatch[0], /timeout:\s*\d+/, 'op whoami call must specify a timeout');
  });

  it('should include a descriptive log message when 1Password is unreachable', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(code, /1Password unreachable.*skipping resume/i, 'Must log when 1Password is unreachable');
  });
});

describe('auto-resume-validation: crash-loop cooldown', () => {
  it('should default crash-loop cooldown to 15 minutes', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /getCooldown\(['"]crash_loop_auto_resume_minutes['"],\s*15\)/,
      'Crash-loop cooldown default must be 15 minutes'
    );
  });

  it('should check pauseDetails.reason for crash_loop_circuit_breaker', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /pauseDetails\.reason\s*===\s*['"]crash_loop_circuit_breaker['"]/,
      'Must check pauseDetails.reason === "crash_loop_circuit_breaker"'
    );
  });

  it('should apply crash-loop cooldown only when reason matches', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /if\s*\(pauseDetails\.reason\s*===\s*['"]crash_loop_circuit_breaker['"]\)[\s\S]*?getCooldown\(['"]crash_loop_auto_resume_minutes['"],\s*15\)/,
      'getCooldown must be inside the crash_loop_circuit_breaker check'
    );
  });

  it('should skip resume when within crash-loop cooldown period', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /if\s*\(pauseAge\s*<\s*crashLoopCooldownMs\)[\s\S]*?continue/,
      'Must skip resume when pauseAge is below crash-loop cooldown'
    );
  });

  it('should derive crashLoopCooldownMs from minutes', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(code, /crashLoopCooldownMinutes\s*\*\s*60\s*\*\s*1000/, 'Must convert minutes to ms');
  });
});

describe('auto-resume-validation: session reaper spawn grace period', () => {
  it('should define SPAWN_GRACE_MS as 60 seconds', () => {
    const code = fs.readFileSync(SESSION_REAPER_PATH, 'utf8');
    assert.match(code, /const SPAWN_GRACE_MS\s*=\s*60_000/, 'SPAWN_GRACE_MS must be 60_000');
  });

  it('should NOT use 120 seconds for SPAWN_GRACE_MS', () => {
    const code = fs.readFileSync(SESSION_REAPER_PATH, 'utf8');
    assert.doesNotMatch(code, /const SPAWN_GRACE_MS\s*=\s*120_000/, 'Must not be 120_000');
  });

  it('should use SPAWN_GRACE_MS in the heartbeat stale check', () => {
    const code = fs.readFileSync(SESSION_REAPER_PATH, 'utf8');
    assert.match(
      code,
      /heartbeatAge\s*>\s*STALE_HEARTBEAT_MS\s*&&\s*spawnedMs\s*>\s*SPAWN_GRACE_MS/,
      'Heartbeat stale check must gate on spawnedMs > SPAWN_GRACE_MS'
    );
  });
});

describe('auto-resume-validation: revival events cleanup', () => {
  it('should delete revival events older than 24 hours', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    assert.match(
      code,
      /DELETE FROM revival_events WHERE created_at < datetime\('now',\s*['"]-24 hours['"]\)/,
      'Must clean up revival_events older than 24 hours'
    );
  });

  it('should run revival events cleanup inside a try-catch', () => {
    const code = fs.readFileSync(HOURLY_AUTOMATION_PATH, 'utf8');
    const deletionRegion = code.match(/try\s*\{[\s\S]*?DELETE FROM revival_events[\s\S]*?\}\s*catch/);
    assert.ok(deletionRegion, 'revival_events cleanup must be in try-catch');
  });
});
