/**
 * Tests for the TOCTOU hardening on revival-daemon's task-status reset.
 *
 * Background: the daemon previously SELECT'd a task in 'in_progress', then
 * UPDATE'd it to 'pending' without a status guard. A race could occur where a
 * concurrent auditor verdict (task_audit_pass → 'completed' or task_audit_fail
 * → 'in_progress') flipped the row between SELECT and UPDATE, silently
 * demoting a just-completed task back to 'pending'.
 *
 * Fix: add `AND status = 'in_progress'` to the UPDATE so the row-flip is
 * detected and the demote becomes a no-op. The audit event is only emitted
 * when `changes > 0` so successful-no-op runs don't pollute the log.
 *
 * Note: PR #722 already added an auditor-skip block earlier in the daemon, so
 * dead auditors never reach this code path at all. This TOCTOU fix is
 * defense-in-depth for the small remaining race between a normal task-runner's
 * death and a concurrent auditor verdict on its task.
 *
 * Run with: node --test .claude/hooks/__tests__/revival-daemon-toctou-reset.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DAEMON_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'revival-daemon.js');

let source;

before(() => {
  source = fs.readFileSync(DAEMON_PATH, 'utf8');
});

describe('revival-daemon.js — TOCTOU-safe task reset', () => {
  it('UPDATE includes AND status = in_progress guard', () => {
    // The pre-revival reset UPDATE must scope to in_progress to avoid racing
    // with concurrent auditor verdicts.
    assert.match(
      source,
      /UPDATE tasks SET status = 'pending'[^"]*WHERE id = \? AND status = 'in_progress'/
    );
  });

  it('UPDATE result is captured in a variable (so we can check changes)', () => {
    assert.match(source, /const updateResult = writeDb\.prepare/);
  });

  it('audit event only fires when changes > 0', () => {
    assert.match(source, /updateResult\.changes > 0/);
    // Event should be inside the truthy branch
    const block = source.slice(
      source.indexOf('const updateResult = writeDb.prepare'),
      source.indexOf('writeDb.close();', source.indexOf('const updateResult')) + 200
    );
    assert.match(block, /if \(auditEvent && updateResult\.changes > 0\)/);
  });

  it('legacy guard-free UPDATE is gone', () => {
    // Make sure the old `UPDATE tasks SET status='pending' ... WHERE id = ?` line
    // (no status guard) is no longer present in the daemon.
    assert.doesNotMatch(
      source,
      /UPDATE tasks SET status = 'pending'[^"]*WHERE id = \?\)\.run\(taskId\)/
    );
  });
});
