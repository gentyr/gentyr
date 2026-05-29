#!/usr/bin/env node
/**
 * SessionStart Hook: Warning Triage + Autonomous Remediation (Fix 8)
 *
 * Replaces the wall-of-warnings UX (the CTO had to mentally process 8+
 * independent systemMessage lines like "Run /setup-gentyr", "Run
 * npx gentyr protect", "Run /demo to auto-repair", "9 paused tasks") with
 * ONE coalesced summary that:
 *
 *   1. Independently detects every known condition (non-root critical
 *      hooks, Playwright auth staleness, OP_SERVICE_ACCOUNT_TOKEN shell
 *      vs .mcp.json mismatch, pending bypass requests, paused tasks).
 *   2. Attempts autonomous remediation for the conditions GENTYR can fix
 *      without CTO action.
 *   3. Emits a SINGLE systemMessage formatted as:
 *
 *        === SESSION START — GENTYR AUTONOMOUS REMEDIATION ===
 *        [fixed]   <past-tense what GENTYR did>
 *        [info]    <FYI lines the CTO does not need to act on>
 *        [pending] <items waiting on CTO action — should be rare>
 *
 * Per the CTO's "never ask the operator to run a command" constraint
 * (toasty-skipping-penguin Fix 8), every CTO-visible line is either past-
 * tense or informational. No "Action: run X" lines.
 *
 * Designed to be a NET-NEW emitter (not a refactor of the existing
 * emitters) — the existing emitters keep running. This hook reads the
 * same source-of-truth state files they read and produces the summary.
 * Eventually the existing emitters can be silenced via a settings flag
 * once this is proven; for now this is additive.
 *
 * Runs at SessionStart. Never writes to stderr (per CLAUDE.md). Fast-
 * exits cleanly on any unexpected error.
 *
 * SECURITY: Should be root-owned via `npx gentyr protect`.
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const REMEDIATION_LEDGER = path.join(STATE_DIR, 'session-warning-triage-log.jsonl');

function emit(systemMessage) {
  process.stdout.write(JSON.stringify({
    continue: true,
    suppressOutput: false,
    systemMessage,
  }));
  process.exit(0);
}

function silent() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Detection 1: protected hooks not root-owned.
 * Reads .claude/state/protection-state.json (criticalHooks list) and
 * checks each file's owner. Returns count + list of bad ones (up to 5).
 */
function detectNonRootCriticalHooks() {
  try {
    const state = readJSON(path.join(STATE_DIR, 'protection-state.json'));
    if (!state || !state.protected) return { count: 0, names: [] };
    const list = Array.isArray(state.criticalHooks) ? state.criticalHooks : [];
    const bad = [];
    for (const name of list) {
      const p = path.join(PROJECT_DIR, '.claude', 'hooks', name);
      try {
        const s = fs.statSync(p);
        if (s.uid !== 0) bad.push(name);
      } catch { /* file missing — ignore */ }
      if (bad.length >= 50) break;
    }
    return { count: bad.length, names: bad.slice(0, 5) };
  } catch { return { count: 0, names: [] }; }
}

/**
 * Detection 2: Playwright auth staleness.
 * Reads .claude/state/playwright-auth.json (set by playwright-health-check.js).
 */
function detectPlaywrightAuthStale() {
  try {
    const state = readJSON(path.join(STATE_DIR, 'playwright-auth.json'));
    if (state && state.stale) {
      return { stale: true, reason: state.reason || 'cookies expired' };
    }
  } catch { /* */ }
  return { stale: false };
}

/**
 * Detection 3: OP_SERVICE_ACCOUNT_TOKEN mismatch shell vs .mcp.json.
 * Compares env var to the value in .mcp.json (when readable).
 */
function detectOpTokenMismatch() {
  try {
    const envTok = process.env.OP_SERVICE_ACCOUNT_TOKEN || '';
    const mcpPath = path.join(PROJECT_DIR, '.mcp.json');
    if (!fs.existsSync(mcpPath)) return { mismatch: false };
    const mcp = readJSON(mcpPath);
    if (!mcp || !mcp.mcpServers) return { mismatch: false };
    // The token lives on the onepassword server entry.
    let mcpTok = '';
    for (const server of Object.values(mcp.mcpServers)) {
      if (server && server.env && typeof server.env.OP_SERVICE_ACCOUNT_TOKEN === 'string') {
        mcpTok = server.env.OP_SERVICE_ACCOUNT_TOKEN;
        break;
      }
    }
    if (!mcpTok || !envTok) return { mismatch: false };
    return { mismatch: mcpTok !== envTok };
  } catch { return { mismatch: false }; }
}

/**
 * Detection 4: pending bypass requests (real, non-timed).
 * Read-only sqlite via execFileSync (no native dep).
 */
function detectPendingBypassRequests() {
  try {
    const db = path.join(STATE_DIR, 'bypass-requests.db');
    if (!fs.existsSync(db)) return { count: 0, oldestAgeMin: 0 };
    const out = execFileSync('sqlite3', [
      db,
      "SELECT COUNT(*), CAST((strftime('%s','now') - strftime('%s', MIN(created_at))) / 60 AS INTEGER) FROM bypass_requests WHERE status='pending' AND auto_resume_at IS NULL;",
    ], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' }).trim();
    const [countStr, ageStr] = out.split('|');
    const count = parseInt(countStr || '0', 10) || 0;
    const oldestAgeMin = parseInt(ageStr || '0', 10) || 0;
    return { count, oldestAgeMin };
  } catch { return { count: 0, oldestAgeMin: 0 }; }
}

/**
 * Detection 5: paused persistent tasks (informational only).
 */
function detectPausedTasks() {
  try {
    const db = path.join(STATE_DIR, 'persistent-tasks.db');
    if (!fs.existsSync(db)) return { count: 0 };
    const out = execFileSync('sqlite3', [
      db,
      "SELECT COUNT(*) FROM tasks WHERE status='paused';",
    ], { encoding: 'utf8', timeout: 3000, stdio: 'pipe' }).trim();
    const count = parseInt(out || '0', 10) || 0;
    return { count };
  } catch { return { count: 0 }; }
}

/**
 * Detection 6: stale legacy ctoWorktreePath (Fix 1 leftover).
 */
function detectLegacyCtoWorktreePath() {
  try {
    const cfg = readJSON(path.join(STATE_DIR, 'automation-config.json'));
    if (!cfg) return { present: false };
    return { present: 'ctoWorktreePath' in cfg };
  } catch { return { present: false }; }
}

/**
 * Autonomous remediation 1: strip legacy ctoWorktreePath (Fix 1 migration
 * also does this, but in case that hook ran before Fix 1 deployment, we
 * do it here too — idempotent).
 */
function stripLegacyCtoWorktreePath() {
  try {
    const p = path.join(STATE_DIR, 'automation-config.json');
    const cfg = readJSON(p);
    if (!cfg || !('ctoWorktreePath' in cfg)) return false;
    delete cfg.ctoWorktreePath;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

/**
 * Append a ledger entry so we can debug what triage saw and did.
 */
function ledger(record) {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(REMEDIATION_LEDGER, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch { /* non-fatal */ }
}

function main() {
  // Quick guard: only run for interactive (root) SessionStart events. Sub-
  // agent or spawned SessionStarts pass through silently.
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') return silent();

  const fixed = []; // past-tense remediations
  const info = [];  // FYI lines
  const pending = []; // CTO-action items (rare)

  // --- detections ---
  const nonRoot = detectNonRootCriticalHooks();
  const pwAuth = detectPlaywrightAuthStale();
  const opTok = detectOpTokenMismatch();
  const bypass = detectPendingBypassRequests();
  const paused = detectPausedTasks();
  const legacy = detectLegacyCtoWorktreePath();

  // --- autonomous remediations ---
  if (legacy.present) {
    if (stripLegacyCtoWorktreePath()) {
      fixed.push('Stripped stale legacy `ctoWorktreePath` from automation-config.json (Fix 1 cleanup).');
    }
  }

  // --- informational / pending lines ---
  if (nonRoot.count > 0) {
    // We cannot chown without sudo + an askpass binary. Surface as pending
    // rather than [fixed]. The current protect.js setup means this is rare.
    const names = nonRoot.names.length ? ` (${nonRoot.names.slice(0, 3).join(', ')}${nonRoot.count > 3 ? ', …' : ''})` : '';
    pending.push(`${nonRoot.count} critical hook(s) not root-owned${names} — protect status drifted; \`npx gentyr protect\` will restore.`);
  }
  if (pwAuth.stale) {
    pending.push(`Playwright auth stale (${pwAuth.reason}) — \`/demo\` auto-repairs on next demo run.`);
  }
  if (opTok.mismatch) {
    pending.push('OP_SERVICE_ACCOUNT_TOKEN differs between shell and .mcp.json — `/setup-gentyr` re-aligns.');
  }
  if (paused.count > 0) {
    info.push(`${paused.count} paused persistent task(s) — review in /persistent-tasks if any need action.`);
  }
  if (bypass.count > 0) {
    info.push(`${bypass.count} pending bypass request(s) (oldest ${bypass.oldestAgeMin}m) — already surfaced separately by cto-notification-hook.`);
  }

  // If we have absolutely nothing to say, exit silent.
  if (!fixed.length && !info.length && !pending.length) {
    ledger({ summary: 'no_findings' });
    return silent();
  }

  const blockLines = ['=== SESSION START — GENTYR AUTONOMOUS REMEDIATION ==='];
  for (const f of fixed) blockLines.push(`[fixed]   ${f}`);
  for (const i of info) blockLines.push(`[info]    ${i}`);
  for (const p of pending) blockLines.push(`[pending] ${p}`);

  ledger({
    summary: 'emitted',
    fixed: fixed.length,
    info: info.length,
    pending: pending.length,
    detections: {
      nonRootCount: nonRoot.count,
      pwAuthStale: !!pwAuth.stale,
      opTokMismatch: !!opTok.mismatch,
      bypassCount: bypass.count,
      pausedCount: paused.count,
      legacyPresent: !!legacy.present,
    },
  });

  emit(blockLines.join('\n'));
}

try { main(); } catch { silent(); }
