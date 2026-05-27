/**
 * Tests for the categorized status-line output in cto-notification-hook.js.
 *
 * PR 1 (Fix 5) — the status line must distinguish:
 *   - real (agent-authored) bypass requests       → "N BYPASS"
 *   - synthesized (quota-recovery) rows           → "M QUOTA-AUTO"
 * and collapse to a compact "TOTAL BYPASS (NR/MQ)" format when the verbose
 * form would overflow the terminal status bar.
 *
 * These tests assert on the SOURCE STRUCTURE of the hook (static analysis)
 * rather than spawning the hook end-to-end — the hook has heavy async I/O
 * dependencies (DBs, API calls) that make end-to-end execution flaky. The
 * structural assertions catch regressions in the categorization logic.
 *
 * Run with: node --test .claude/hooks/__tests__/cto-notification-categorization.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_PATH = path.resolve(__dirname, '..', 'cto-notification-hook.js');
const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

describe('cto-notification-hook categorization', () => {
  it('builds realCount from non-synthesized rows', () => {
    // The new categorization path computes realCount = pendingBypassRequests.length
    // after the DB query has already excluded synthesized rows. Just verify the
    // variable is declared.
    assert.match(hookCode, /const\s+realCount\s*=\s*pendingBypassRequests\.length/);
  });

  it('reads synthesizedCount from the array attribute', () => {
    assert.match(hookCode, /const\s+synthesizedCount\s*=\s*pendingBypassRequests\.synthesizedCount\s*\|\|\s*0/);
  });

  it('pushes "N BYPASS" segment when realCount > 0', () => {
    assert.match(hookCode, /statusParts\.push\(`\$\{realCount\}\s+BYPASS`\)/);
  });

  it('pushes "M QUOTA-AUTO" segment when synthesizedCount > 0', () => {
    assert.match(hookCode, /statusParts\.push\(`\$\{synthesizedCount\}\s+QUOTA-AUTO`\)/);
  });

  it('collapses to compact format when verbose line exceeds 60 chars', () => {
    assert.match(hookCode, /verbose\.length\s*<=?\s*60/);
    assert.match(hookCode, /\$\{realCount\}R\/\$\{synthesizedCount\}Q/);
  });

  it('emits "AWAITING DECISION" suffix when any parts present', () => {
    assert.match(hookCode, /AWAITING DECISION\s*\|\s*`/);
  });

  it('excludes synthesized rows from the urgent bypass block (model context)', () => {
    // The bypass block — which tells the model "use AskUserQuestion NOW" — must
    // only fire on realCount > 0, not on (realCount + synthesizedCount) > 0.
    // Otherwise the model gets a "URGENT" instruction for rows that the
    // framework will auto-resolve.
    const blockGuard = hookCode.match(/let bypassBlock = ''[\s\S]{0,200}?if\s*\(([^)]+)\)/);
    assert.ok(blockGuard, 'bypassBlock guard should exist');
    assert.match(blockGuard[1], /realCount\s*>\s*0/,
      'urgent bypass block must be gated on realCount, NOT total pending count');
  });

  it('appends FYI note about synthesized rows only inside the urgent block', () => {
    assert.match(hookCode,
      /FYI:.*quota-recovery row.*auto-resolve when quota clears/,
      'urgent block should include FYI footnote when synthesized rows exist');
  });
});

describe('cto-notification-hook bypass DB query', () => {
  it('queries synthesized=0 for the urgent list and counts synthesized=1 separately', () => {
    // The DB query inside getPendingBypassRequests() must:
    //   - return only rows where synthesized=0 (or column-missing fallback)
    //   - separately count rows where synthesized=1
    // Verify both clauses exist literally so regressions are caught.
    assert.match(hookCode, /COALESCE\(synthesized,\s*0\)\s*=\s*0/,
      'urgent query must filter synthesized=0 (with COALESCE for legacy rows)');
    assert.match(hookCode, /synthesized\s*=\s*1/,
      'separate count query must filter synthesized=1');
  });

  it('attaches synthesizedCount as a property on the rows array', () => {
    assert.match(hookCode, /rows\.synthesizedCount\s*=\s*synthesizedCount/);
  });

  it('falls through to legacy schema when synthesized column is missing', () => {
    // The try/catch chain must contain a fallback that omits the synthesized
    // column entirely, so old DBs still work until agent-tracker migrates.
    const queryBlock = hookCode.match(/let rows;[\s\S]*?_bypassRequestsCache = rows;/);
    assert.ok(queryBlock);
    assert.match(queryBlock[0], /catch \(_\)/, 'must have a catch fallback');
  });
});
