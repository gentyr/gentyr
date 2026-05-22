// Tests for the main-tree-rescue module powering `repair_main_tree_drift`.
//
// Pins the safety invariants of the rescue prompt (draft PR, no auto-merge,
// always end on base branch, bypass-request on conflict) and verifies live
// drift detection against a real git repo.

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildMainTreeRescuePrompt,
  detectMainTreeDrift,
} from '../lib/main-tree-rescue.js';

// ---------------------------------------------------------------------------
// buildMainTreeRescuePrompt — safety invariants
// ---------------------------------------------------------------------------

const baseFixture = {
  agentId: 'agent-mtrescue1',
  projectDir: '/tmp/example-project',
  baseBranch: 'preview',
  currentBranch: 'abc1234',
  dirty: true,
  midMerge: false,
  detached: true,
  divergence: {
    baseBranch: 'preview',
    commitsAhead: 0,
    commitsBehind: 7,
    filesChanged: 2,
    linesChanged: 14,
    branchAgeHours: 0.5,
    dirtyFileNewestMtimeMs: Date.now() - 5 * 60 * 1000,
    dirtyFileOldestMtimeMs: Date.now() - 10 * 60 * 1000,
    dirtyFileCount: 2,
    probableCase: 'fresh_crash',
  },
  reason: 'CTO test',
};

describe('buildMainTreeRescuePrompt — safety invariants', () => {
  it('forbids auto-merge — no `gh pr merge` and explicit DO NOT', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.doesNotMatch(prompt, /gh pr merge --squash/);
    assert.doesNotMatch(prompt, /gh pr merge --merge/);
    assert.doesNotMatch(prompt, /gh pr merge --rebase/);
    assert.match(prompt, /DO NOT run `gh pr merge`/);
  });

  it('requires the rescue PR to be opened as a draft', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /gh pr create --draft/);
    assert.match(prompt, /Rescue \(draft\):/);
  });

  it('orders salvage BEFORE restore — checkout -b appears before checkout <base>', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    const salvageIdx = prompt.indexOf('git checkout -b "$RESCUE_BRANCH"');
    const restoreIdx = prompt.indexOf('git checkout preview');
    assert.ok(salvageIdx > 0, 'salvage step must appear');
    assert.ok(restoreIdx > 0, 'restore step must appear');
    assert.ok(salvageIdx < restoreIdx, 'salvage MUST come before restore — never lose work');
  });

  it('uses fast-forward only on the restore pull — never force', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /git pull --ff-only origin preview/);
    assert.doesNotMatch(prompt, /git push --force/);
    assert.doesNotMatch(prompt, /git reset --hard/);
  });

  it('aborts any mid-merge/rebase without manual resolution', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /git merge --abort/);
    assert.match(prompt, /git rebase --abort/);
    assert.match(prompt, /submit_bypass_request/);
    assert.match(prompt, /do not attempt to resolve manually/i);
  });

  it('files a bypass request on non-fast-forward pull instead of forcing', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    // The fail mode for the pull must route through submit_bypass_request.
    assert.match(prompt, /pull --ff-only/);
    assert.match(prompt, /do NOT force/);
    assert.match(prompt, /submit_bypass_request/);
  });

  it('renders divergence stats into the PR body for human review', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /Commits ahead of base: 0/);
    assert.match(prompt, /Commits behind base: 7/);
    assert.match(prompt, /Files changed vs base: 2/);
    assert.match(prompt, /Lines changed vs base: 14/);
    assert.match(prompt, /Probable case: \*\*fresh_crash\*\*/);
  });

  it('flags detached HEAD prominently in the context block', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /detached HEAD/);
  });

  it('passes through the operator-supplied reason verbatim', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /CTO test/);
  });

  it('degrades gracefully when divergence stats are unavailable', () => {
    const prompt = buildMainTreeRescuePrompt({ ...baseFixture, divergence: null });
    assert.match(prompt, /gh pr create --draft/);
    assert.match(prompt, /divergence stats unavailable/);
    // Safety-critical steps must still appear.
    assert.match(prompt, /git pull --ff-only origin preview/);
    assert.match(prompt, /DO NOT run `gh pr merge`/);
  });

  it('falls back to "preview" when baseBranch is null', () => {
    const prompt = buildMainTreeRescuePrompt({
      ...baseFixture,
      baseBranch: null,
      divergence: null,
    });
    assert.match(prompt, /git pull --ff-only origin preview/);
  });

  it('mentions the GENTYR_MAIN_TREE_REPAIR env-var bypass so the agent knows its scope', () => {
    const prompt = buildMainTreeRescuePrompt(baseFixture);
    assert.match(prompt, /GENTYR_MAIN_TREE_REPAIR=true/);
    // The prompt should constrain scope, not just announce the bypass.
    assert.match(prompt, /Use this authority narrowly/);
  });
});

// ---------------------------------------------------------------------------
// detectMainTreeDrift — live detection on a real git repo
// ---------------------------------------------------------------------------

describe('detectMainTreeDrift — live detection', () => {
  let tmpRoot;
  let originRepo;
  let projectRepo;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'main-tree-drift-'));
    originRepo = path.join(tmpRoot, 'origin.git');
    projectRepo = path.join(tmpRoot, 'project');

    execFileSync('git', ['init', '--bare', '-b', 'preview', originRepo]);
    execFileSync('git', ['clone', originRepo, projectRepo]);
    execFileSync('git', ['-C', projectRepo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', projectRepo, 'config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(projectRepo, 'README.md'), '# project\n');
    execFileSync('git', ['-C', projectRepo, 'add', 'README.md']);
    execFileSync('git', ['-C', projectRepo, 'commit', '-m', 'seed']);
    execFileSync('git', ['-C', projectRepo, 'push', 'origin', 'preview']);

    // Add a few commits on origin/preview so we have something to drift behind.
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(projectRepo, `note${i}.txt`), `note ${i}\n`);
      execFileSync('git', ['-C', projectRepo, 'add', `note${i}.txt`]);
      execFileSync('git', ['-C', projectRepo, 'commit', '-m', `note ${i}`]);
    }
    execFileSync('git', ['-C', projectRepo, 'push', 'origin', 'preview']);
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports no drift when tree is clean and on the base branch', () => {
    const drift = detectMainTreeDrift(projectRepo);
    assert.equal(drift.drifted, false);
    assert.equal(drift.currentBranch, 'preview');
    assert.equal(drift.baseBranch, 'preview');
    assert.equal(drift.dirty, false);
    assert.equal(drift.midMerge, false);
    assert.equal(drift.detached, false);
  });

  it('does NOT treat dirty-on-base as drift — the CTO may be actively editing', () => {
    fs.writeFileSync(path.join(projectRepo, 'README.md'), '# project\n\nedit\n');
    try {
      const drift = detectMainTreeDrift(projectRepo);
      assert.equal(drift.dirty, true);
      assert.equal(drift.currentBranch, 'preview');
      // Drift only fires when the watcher would be blocked. On-base + dirty
      // is the watcher's "already on base, no-op" short-circuit path — the
      // CTO is just editing on the base branch.
      assert.equal(drift.drifted, false);
    } finally {
      // Restore for subsequent tests.
      execFileSync('git', ['-C', projectRepo, 'checkout', '--', 'README.md']);
    }
  });

  it('does NOT treat wrong-branch-clean as drift — watcher auto-corrects', () => {
    // Create + checkout a non-base branch, leave clean.
    execFileSync('git', ['-C', projectRepo, 'checkout', '-b', 'tmp-clean-branch']);
    try {
      const drift = detectMainTreeDrift(projectRepo);
      assert.equal(drift.dirty, false);
      assert.equal(drift.currentBranch, 'tmp-clean-branch');
      // Wrong branch + clean: the watcher will checkout + pull on the next
      // tick. No MCP repair needed.
      assert.equal(drift.drifted, false);
    } finally {
      execFileSync('git', ['-C', projectRepo, 'checkout', 'preview']);
      execFileSync('git', ['-C', projectRepo, 'branch', '-D', 'tmp-clean-branch']);
    }
  });

  it('detects drift when on wrong branch AND working tree is dirty', () => {
    execFileSync('git', ['-C', projectRepo, 'checkout', '-b', 'tmp-dirty-branch']);
    fs.writeFileSync(path.join(projectRepo, 'README.md'), '# project\n\nedit\n');
    try {
      const drift = detectMainTreeDrift(projectRepo);
      assert.equal(drift.drifted, true);
      assert.equal(drift.dirty, true);
      assert.equal(drift.currentBranch, 'tmp-dirty-branch');
    } finally {
      execFileSync('git', ['-C', projectRepo, 'checkout', '--', 'README.md']);
      execFileSync('git', ['-C', projectRepo, 'checkout', 'preview']);
      execFileSync('git', ['-C', projectRepo, 'branch', '-D', 'tmp-dirty-branch']);
    }
  });

  it('detects drift when HEAD is detached', () => {
    const head = execFileSync('git', ['-C', projectRepo, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', projectRepo, 'checkout', head]);
    try {
      const drift = detectMainTreeDrift(projectRepo);
      assert.equal(drift.drifted, true);
      assert.equal(drift.detached, true);
      // currentBranch falls back to short SHA when detached.
      assert.ok(drift.currentBranch && drift.currentBranch !== 'preview');
    } finally {
      execFileSync('git', ['-C', projectRepo, 'checkout', 'preview']);
    }
  });

  it('returns null base branch and not drifted for non-git directories', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'non-repo-'));
    try {
      const drift = detectMainTreeDrift(nonRepo);
      assert.equal(drift.drifted, false);
      assert.equal(drift.baseBranch, null);
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
