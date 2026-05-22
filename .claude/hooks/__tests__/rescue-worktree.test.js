// Regression tests for the abandoned-worktree rescue safety fix.
//
// Incident 2026-05-22: PRs #3419/#3420 squash-merged stale worktree
// snapshots into preview and overwrote recently-merged work. Root cause:
// the rescue prompt did `git push` + `gh pr merge --squash` with no
// pre-merge base-sync, no divergence check, and no human review gate.
//
// These tests pin the new safety invariants of the rescue prompt builder
// and divergence helper so the unsafe shape cannot regress.

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  buildRescuePrompt,
  computeWorktreeDivergence,
  resolveBaseBranch,
} from '../lib/rescue-worktree.js';

// ---------------------------------------------------------------------------
// buildRescuePrompt — pin the safety invariants of the rendered prompt
// ---------------------------------------------------------------------------

const baseFixture = {
  agentId: 'agent-test123',
  wtPath: '/tmp/example-worktree',
  wtBranch: 'feature/abandoned-thing',
  baseBranch: 'preview',
  stats: {
    baseBranch: 'preview',
    commitsAhead: 1,
    commitsBehind: 42,
    filesChanged: 3,
    linesChanged: 87,
    branchAgeHours: 5.2,
    dirtyFileNewestMtimeMs: Date.now() - 9 * 60 * 60 * 1000,
    dirtyFileOldestMtimeMs: Date.now() - 9 * 60 * 60 * 1000,
    dirtyFileCount: 2,
    probableCase: 'stale_orphan',
  },
};

describe('buildRescuePrompt — Case-B safety invariants', () => {
  it('mandates pre-rescue base-sync before any push/commit', () => {
    const prompt = buildRescuePrompt(baseFixture);
    assert.match(prompt, /git fetch origin preview/);
    assert.match(prompt, /git merge origin\/preview --no-edit/);
    // Sync must be ordered BEFORE stage/commit/push.
    const fetchIdx = prompt.indexOf('git fetch origin preview');
    const addIdx = prompt.indexOf('git add');
    const pushIdx = prompt.indexOf('git push');
    assert.ok(fetchIdx > 0, 'fetch step must appear');
    assert.ok(fetchIdx < addIdx, 'fetch must come before git add');
    assert.ok(fetchIdx < pushIdx, 'fetch must come before git push');
  });

  it('forbids auto-merge — no `gh pr merge --squash` and explicit DO NOT', () => {
    const prompt = buildRescuePrompt(baseFixture);
    assert.doesNotMatch(prompt, /gh pr merge --squash/);
    assert.doesNotMatch(prompt, /gh pr merge --merge/);
    assert.doesNotMatch(prompt, /gh pr merge --rebase/);
    // Must explicitly tell the agent not to merge.
    assert.match(prompt, /DO NOT run `gh pr merge`/);
  });

  it('requires the PR to be opened as a draft', () => {
    const prompt = buildRescuePrompt(baseFixture);
    assert.match(prompt, /gh pr create --draft/);
    assert.match(prompt, /Rescue \(draft\):/);
  });

  it('handles merge conflicts with bypass-request abort, not silent resolve', () => {
    const prompt = buildRescuePrompt(baseFixture);
    assert.match(prompt, /git merge --abort/);
    assert.match(prompt, /submit_bypass_request/);
    // Must explicitly forbid blind conflict resolution.
    assert.match(prompt, /do NOT attempt to resolve them blindly/i);
  });

  it('renders divergence stats into the PR body for human review', () => {
    const prompt = buildRescuePrompt(baseFixture);
    // Numbers from the fixture should appear in the rendered body.
    assert.match(prompt, /Commits ahead of base: 1/);
    assert.match(prompt, /Commits behind base: 42/);
    assert.match(prompt, /Files changed vs base: 3/);
    assert.match(prompt, /Lines changed vs base: 87/);
    assert.match(prompt, /Probable case: \*\*stale_orphan\*\*/);
  });

  it('degrades gracefully when divergence stats are unavailable', () => {
    const prompt = buildRescuePrompt({ ...baseFixture, stats: null });
    // Must still render the safety-critical steps.
    assert.match(prompt, /git fetch origin preview/);
    assert.match(prompt, /gh pr create --draft/);
    assert.match(prompt, /divergence stats unavailable/);
  });

  it('falls back to "preview" in the prompt when base branch is unknown', () => {
    const prompt = buildRescuePrompt({
      ...baseFixture,
      baseBranch: null,
      stats: null,
    });
    assert.match(prompt, /origin\/preview/);
  });
});

// ---------------------------------------------------------------------------
// computeWorktreeDivergence — verify it detects the 2026-05-22 Case-B shape
// ---------------------------------------------------------------------------

describe('computeWorktreeDivergence — Case-B detection on a real git repo', () => {
  let tmpRoot;
  let originRepo;
  let workRepo;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rescue-divergence-'));
    originRepo = path.join(tmpRoot, 'origin.git');
    workRepo = path.join(tmpRoot, 'work');

    // Bare origin with a 'preview' branch.
    execFileSync('git', ['init', '--bare', '-b', 'preview', originRepo]);

    // Seed: clone, make initial commit on preview, push.
    execFileSync('git', ['clone', originRepo, workRepo]);
    execFileSync('git', ['-C', workRepo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', workRepo, 'config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(workRepo, 'seed.txt'), 'v1\n');
    execFileSync('git', ['-C', workRepo, 'add', 'seed.txt']);
    execFileSync('git', ['-C', workRepo, 'commit', '-m', 'seed']);
    execFileSync('git', ['-C', workRepo, 'push', 'origin', 'preview']);

    // Branch off preview into a feature branch (the "abandoned" worktree).
    execFileSync('git', ['-C', workRepo, 'checkout', '-b', 'feature/stale-orphan']);
    fs.writeFileSync(path.join(workRepo, 'feature.txt'), 'feature work\n');
    execFileSync('git', ['-C', workRepo, 'add', 'feature.txt']);
    execFileSync('git', ['-C', workRepo, 'commit', '-m', 'feature commit']);

    // Now simulate preview moving forward AFTER the feature branched off —
    // this is the Case-B scenario where rescuing would overwrite work.
    execFileSync('git', ['-C', workRepo, 'checkout', 'preview']);
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(workRepo, `preview${i}.txt`), `preview update ${i}\n`);
      execFileSync('git', ['-C', workRepo, 'add', `preview${i}.txt`]);
      execFileSync('git', ['-C', workRepo, 'commit', '-m', `preview update ${i}`]);
    }
    execFileSync('git', ['-C', workRepo, 'push', 'origin', 'preview']);

    // Switch back to the stale feature branch and dirty it (the "uncommitted
    // abandoned changes" the rescue path detects).
    execFileSync('git', ['-C', workRepo, 'checkout', 'feature/stale-orphan']);
    fs.writeFileSync(path.join(workRepo, 'feature.txt'), 'feature work\nmore edits\n');
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('resolves origin/preview as base branch', () => {
    const base = resolveBaseBranch(workRepo);
    assert.equal(base, 'preview');
  });

  it('detects Case-B: branch is behind origin/preview by ~5 commits', () => {
    const stats = computeWorktreeDivergence(workRepo, 'preview');
    assert.equal(stats.commitsBehind, 5);
    assert.equal(stats.commitsAhead, 1);
    // We dirtied feature.txt above.
    assert.ok(stats.dirtyFileCount >= 1);
  });
});
