/**
 * Regression guard for Fix 5 of the toasty-skipping-penguin plan.
 *
 * The `gh pr checks` CLI does NOT have a `--fail-on-fail` flag — only
 * `--fail-fast`. Past gentyr docs (CLAUDE.md, agent definitions) used the
 * wrong flag in 11 places, which propagated into every PM / preview-promoter /
 * concierge prompt and caused those agents to issue commands that errored
 * with `unknown flag`. The fix replaced all occurrences with `--fail-fast`.
 *
 * This test fails if `fail-on-fail` reappears anywhere under CLAUDE.md,
 * `agents/`, or `docs/`. It does not look at `.claude/hooks/__tests__/`
 * (this file itself contains the string).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function scanForFlag(roots) {
  const hits = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      // Skip THIS test file (it legitimately mentions the string).
      if (file === __filename) continue;
      // Skip non-text files
      if (!/\.(md|mdx|txt|js|ts|json|yml|yaml)$/.test(file)) continue;
      let body;
      try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (body.includes('fail-on-fail')) {
        hits.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return hits;
}

describe('docs-no-fail-on-fail (Fix 5 regression guard)', () => {
  it('CLAUDE.md, agents/, docs/ must not mention --fail-on-fail (use --fail-fast)', () => {
    const claudeMd = path.join(REPO_ROOT, 'CLAUDE.md');
    const agentsDir = path.join(REPO_ROOT, 'agents');
    const docsDir = path.join(REPO_ROOT, 'docs');

    const claudeMdHits = fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf8').includes('fail-on-fail')
      ? ['CLAUDE.md']
      : [];
    const agentHits = scanForFlag([agentsDir]);
    const docHits = scanForFlag([docsDir]);

    const allHits = [...claudeMdHits, ...agentHits, ...docHits];
    assert.deepEqual(
      allHits,
      [],
      `Found --fail-on-fail in: ${allHits.join(', ')}. The gh CLI flag is --fail-fast; --fail-on-fail does not exist.`
    );
  });
});
