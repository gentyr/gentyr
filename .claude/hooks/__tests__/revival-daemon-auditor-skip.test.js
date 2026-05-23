/**
 * Tests for the auditor-skip block added to scripts/revival-daemon.js.
 *
 * The daemon polls agent-tracker-history.json via fs.watch and revives dead
 * agents that have a linked taskId. Before this fix the daemon happily revived
 * dead auditors (universal-auditor / plan-auditor / authorization-auditor),
 * resetting their linked task to 'pending' and resuming the auditor's JSONL
 * as a generic task-runner — losing audit context and producing mismatched
 * agent_type / prompt / session-file combinations.
 *
 * The fix: when agent.type is one of AUDITOR_AGENT_TYPES, skip revival entirely
 * and let reapSyncPass Step 1b.5 (for pending_audit) or Step 1d's auditor branch
 * (for post-audit-failure in_progress) handle it.
 *
 * Verification is structural (regex against the daemon source). The daemon
 * itself is launchd-managed and has no in-process entry point that can be
 * unit-tested without spinning up a subprocess.
 *
 * Run with: node --test .claude/hooks/__tests__/revival-daemon-auditor-skip.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Daemon lives at scripts/revival-daemon.js (repo root, not under .claude/)
const DAEMON_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'revival-daemon.js');

let source;

before(() => {
  source = fs.readFileSync(DAEMON_PATH, 'utf8');
});

describe('revival-daemon.js — auditor-skip block', () => {
  it('imports AUDITOR_AGENT_TYPES lazily from auditor-prompt.js', () => {
    // Lazy dynamic import is the daemon's pattern — all deps load after PROJECT_DIR.
    assert.match(source, /import\s*\([^)]*['"][^'"]*auditor-prompt\.js['"]\)/);
    assert.match(source, /AUDITOR_AGENT_TYPES\s*=\s*auditorPrompt\.AUDITOR_AGENT_TYPES/);
  });

  it('declares AUDITOR_AGENT_TYPES with a null initial value', () => {
    // Daemon uses `let X = null;` at module scope, populated by loadDependencies()
    assert.match(source, /let\s+AUDITOR_AGENT_TYPES\s*=\s*null/);
  });

  it('checks AUDITOR_AGENT_TYPES before the taskId guard', () => {
    // The skip must run BEFORE `const taskId = agent.metadata?.taskId`.
    const auditorCheckIdx = source.indexOf('AUDITOR_AGENT_TYPES.has(agent.type)');
    const taskIdIdx = source.indexOf("const taskId = agent.metadata?.taskId");
    assert.ok(auditorCheckIdx > 0, 'auditor check must exist');
    assert.ok(taskIdIdx > 0, 'taskId check must exist');
    assert.ok(
      auditorCheckIdx < taskIdIdx,
      'auditor skip must precede taskId guard (otherwise auditor revivals slip through)'
    );
  });

  it('guards the check with a truthy AUDITOR_AGENT_TYPES (loadDependencies failure tolerance)', () => {
    // Daemon loadDependencies has a try/catch for the auditor-prompt import.
    // If that import fails, AUDITOR_AGENT_TYPES stays null and the guard must
    // short-circuit to the legacy path rather than throwing.
    assert.match(source, /AUDITOR_AGENT_TYPES\s*&&\s*AUDITOR_AGENT_TYPES\.has\(agent\.type\)/);
  });

  it('marks the dead auditor as revivalAttempted (prevents poll loop)', () => {
    // Capture the body of the auditor-skip block and confirm it does the same
    // bookkeeping the rest of the daemon does for skipped agents.
    const idx = source.indexOf('AUDITOR_AGENT_TYPES && AUDITOR_AGENT_TYPES.has(agent.type)');
    assert.ok(idx > 0);
    const block = source.slice(idx, idx + 800);
    assert.match(block, /agent\.revivalAttempted\s*=\s*true/);
    assert.match(block, /revivalAttempted\.set\(agent\.id,\s*now\)/);
    assert.match(block, /continue/);
  });

  it('emits a revival_skipped_auditor audit event', () => {
    assert.match(source, /revival_skipped_auditor/);
  });

  it('does NOT call the daemon registerSpawn for auditor candidates', () => {
    // Slightly indirect check: confirm the auditor block hits `continue` before
    // any subsequent registerSpawn() call — captured by the block-bounded match above.
    const idx = source.indexOf('AUDITOR_AGENT_TYPES && AUDITOR_AGENT_TYPES.has(agent.type)');
    const block = source.slice(idx, idx + 800);
    assert.doesNotMatch(block, /registerSpawn/);
  });
});
