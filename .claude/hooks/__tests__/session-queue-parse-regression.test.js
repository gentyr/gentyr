/**
 * Static regression test — locks the fix for commit 22bd8af which added
 * `await import()` inside the synchronous `drainQueue()` function in
 * lib/session-queue.js and broke every spawn path with `Fatal error:
 * Unexpected reserved word`. The bug was a parse-time SyntaxError so
 * `node --check` against the file reproduces it in <100ms.
 *
 * This test runs `node --check` against the critical-hook hot path so any
 * future regression that introduces an `await` outside an async function
 * (or any other parse error) is caught by CI before merge.
 *
 * Run with: node --test .claude/hooks/__tests__/session-queue-parse-regression.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const HOT_PATH = [
  '.claude/hooks/lib/session-queue.js',
  '.claude/hooks/lib/session-reaper.js',
  '.claude/hooks/lib/auditor-prompt.js',
  '.claude/hooks/lib/persistent-monitor-revival-prompt.js',
  '.claude/hooks/lib/audit-escalation.js',
  '.claude/hooks/lib/bypass-guard.js',
  '.claude/hooks/lib/resource-lock.js',
  '.claude/hooks/lib/cross-dep-satisfier.js',
  '.claude/hooks/persistent-task-spawner.js',
  '.claude/hooks/universal-audit-spawner.js',
  '.claude/hooks/authorization-audit-spawner.js',
  '.claude/hooks/deferred-action-audit-executor.js',
  '.claude/hooks/main-tree-commit-guard.js',
  '.claude/hooks/staging-lock-guard.js',
  '.claude/hooks/interactive-lockdown-guard.js',
  'cli/commands/sync.js',
  'cli/commands/protect.js',
];

function parseCheck(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return { ok: true, skipped: true };
  try {
    execFileSync('node', ['--check', abs], { stdio: 'pipe', timeout: 10000 });
    return { ok: true };
  } catch (err) {
    const stderr = err?.stderr ? err.stderr.toString() : '';
    return { ok: false, err: stderr || err?.message || 'unknown' };
  }
}

describe('Critical-hook parse regression', () => {
  for (const rel of HOT_PATH) {
    it(`${rel} parses cleanly`, () => {
      const r = parseCheck(rel);
      if (r.skipped) return;
      assert.equal(r.ok, true, `Parse error in ${rel}:\n${r.err}`);
    });
  }

  it('session-queue.js drainQueue is async or audit-escalation is hoisted', () => {
    // Defense in depth: assert no `await` appears inside a sync function
    // body near drainQueue. Simple grep heuristic — catches the exact 22bd8af
    // shape (`export function drainQueue(...)` + `await import(...)` later in
    // the function body).
    const src = fs.readFileSync(
      path.join(REPO_ROOT, '.claude/hooks/lib/session-queue.js'),
      'utf8'
    );
    // Match the drainQueue declaration line.
    const declMatch = src.match(/^export (async )?function drainQueue\(/m);
    assert.ok(declMatch, 'drainQueue export declaration not found');
    const isAsync = !!declMatch[1];
    if (!isAsync) {
      // If drainQueue is sync, the audit-escalation import MUST be hoisted
      // (top-level await) — not inside the function body.
      const drainStart = src.indexOf('export function drainQueue(');
      assert.ok(drainStart >= 0);
      // Find the matching closing brace of the function. Cheap heuristic:
      // grab everything up to the next `^}` line after drainStart.
      const after = src.slice(drainStart);
      const closeIdx = after.indexOf('\n}\n');
      const body = closeIdx >= 0 ? after.slice(0, closeIdx) : after;
      assert.ok(
        !body.includes('await import('),
        'drainQueue() is synchronous but body contains `await import(...)` — that is a parse-time SyntaxError. Either mark drainQueue async or hoist the import to module top.'
      );
    }
  });
});
