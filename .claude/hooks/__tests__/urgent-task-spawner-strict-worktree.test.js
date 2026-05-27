/**
 * Tests for the strict-worktree behavior in `.claude/hooks/urgent-task-spawner.js`.
 *
 * When createWorktree() fails, the spawner must:
 *   - REFUSE to enqueue for code-modifying agents (would pollute main tree).
 *   - Fall back to PROJECT_DIR only for read-only agents (e.g. investigator).
 *
 * Source-code structural check + behavioral verification of the
 * `isCodeModifyingAgent` classifier.
 *
 * Run with: node --test .claude/hooks/__tests__/urgent-task-spawner-strict-worktree.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SPAWNER_PATH = path.resolve(__dirname, '..', 'urgent-task-spawner.js');
const CLASSIFICATION_PATH = path.resolve(__dirname, '..', 'lib', 'agent-classification.js');

const { isCodeModifyingAgent, CODE_MODIFYING_AGENTS } = await import(CLASSIFICATION_PATH);

describe('agent-classification.isCodeModifyingAgent', () => {
  it('returns true for code-writer / test-writer / code-reviewer / project-manager', () => {
    assert.equal(isCodeModifyingAgent('code-writer'), true);
    assert.equal(isCodeModifyingAgent('test-writer'), true);
    assert.equal(isCodeModifyingAgent('code-reviewer'), true);
    assert.equal(isCodeModifyingAgent('project-manager'), true);
  });

  it('returns true for promotion + fixer agents', () => {
    assert.equal(isCodeModifyingAgent('preview-promoter'), true);
    assert.equal(isCodeModifyingAgent('hotfix-promotion'), true);
    assert.equal(isCodeModifyingAgent('lint-fixer'), true);
    assert.equal(isCodeModifyingAgent('test-fixer'), true);
  });

  it('returns false for read-only / orchestration agents', () => {
    assert.equal(isCodeModifyingAgent('investigator'), false);
    assert.equal(isCodeModifyingAgent('deputy-cto'), false);
    assert.equal(isCodeModifyingAgent('user-alignment'), false);
    assert.equal(isCodeModifyingAgent('plan-manager'), false);
    assert.equal(isCodeModifyingAgent('persistent-monitor'), false);
    assert.equal(isCodeModifyingAgent('product-manager'), false);
    assert.equal(isCodeModifyingAgent('gate-agent'), false);
  });

  it('returns false for read-only auditors', () => {
    assert.equal(isCodeModifyingAgent('plan-auditor'), false);
    assert.equal(isCodeModifyingAgent('universal-auditor'), false);
    assert.equal(isCodeModifyingAgent('authorization-auditor'), false);
  });

  it('FAILS CLOSED (returns true) for unknown agent names', () => {
    assert.equal(isCodeModifyingAgent('some-new-agent-not-yet-classified'), true);
    assert.equal(isCodeModifyingAgent(''), true);
    assert.equal(isCodeModifyingAgent(null), true);
    assert.equal(isCodeModifyingAgent(undefined), true);
  });

  it('CODE_MODIFYING_AGENTS set includes the canonical writers', () => {
    assert.ok(CODE_MODIFYING_AGENTS.has('code-writer'));
    assert.ok(CODE_MODIFYING_AGENTS.has('test-writer'));
    assert.ok(CODE_MODIFYING_AGENTS.has('demo-manager'));
  });
});

describe('urgent-task-spawner — strict mode source-code checks', () => {
  const source = fs.readFileSync(SPAWNER_PATH, 'utf8');

  it('imports isCodeModifyingAgent from lib/agent-classification.js', () => {
    assert.match(source, /isCodeModifyingAgent/);
    assert.match(source, /from '\.\/lib\/agent-classification\.js'/);
  });

  it('uses isCodeModifyingAgent() in the createWorktree catch block', () => {
    // The pattern must be: in the catch block after createWorktree failure,
    // check isCodeModifyingAgent(mapping.agent) before deciding to fall back.
    assert.match(source, /isCodeModifyingAgent\(mapping\.agent\)/);
  });

  it('refuses to enqueue when worktree creation fails for code-modifying agent', () => {
    assert.match(source, /REFUSING to enqueue in main tree/);
  });

  it('resets task back to pending on refusal so it can retry', () => {
    // The refusal path must include a task reset
    const idx = source.indexOf('REFUSING to enqueue in main tree');
    assert.ok(idx >= 0);
    const block = source.slice(idx, idx + 1500);
    assert.match(block, /UPDATE tasks SET status = 'pending'/);
    assert.match(block, /status = 'in_progress'/);
  });

  it("preserves the read-only fallback path (still allows PROJECT_DIR for non-writers)", () => {
    assert.match(source, /agent '\$\{mapping\.agent\}' is read-only/);
  });
});
