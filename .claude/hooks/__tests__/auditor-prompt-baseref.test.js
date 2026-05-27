/**
 * Tests for the baseRef threading in lib/auditor-prompt.js.
 *
 * PR 3 (Fix 2) — buildAuditorSessionSpec must:
 *   - accept baseRef, headRef, mergeCommitSha, prNumber
 *   - store all four in spec.metadata so audit-lane-guard sees them
 *   - inject the "CRITICAL — Read from origin" prompt section when baseRef set
 *   - inject a fallback "NOTE — Working tree may not match" section when unset
 *
 * Run with: node --test .claude/hooks/__tests__/auditor-prompt-baseref.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { buildAuditorSessionSpec } = await import(
  path.resolve(__dirname, '..', 'lib', 'auditor-prompt.js')
);

const BASE_ARGS = {
  taskId: 'pt-test',
  taskType: 'persistent',
  taskTitle: 'Test task',
  criteria: 'must X',
  method: 'check Y',
};

describe('buildAuditorSessionSpec — metadata threading', () => {
  it('stores baseRef, headRef, mergeCommitSha, prNumber in metadata when all provided', () => {
    const spec = buildAuditorSessionSpec(
      { ...BASE_ARGS, baseRef: 'preview', headRef: 'feature/x', mergeCommitSha: 'abc123', prNumber: '42' },
      '/tmp/project',
    );
    assert.equal(spec.metadata.baseRef, 'preview');
    assert.equal(spec.metadata.headRef, 'feature/x');
    assert.equal(spec.metadata.mergeCommitSha, 'abc123');
    assert.equal(spec.metadata.prNumber, '42');
  });

  it('stores null in metadata when merge context unknown', () => {
    const spec = buildAuditorSessionSpec(BASE_ARGS, '/tmp/project');
    assert.equal(spec.metadata.baseRef, null);
    assert.equal(spec.metadata.headRef, null);
    assert.equal(spec.metadata.mergeCommitSha, null);
    assert.equal(spec.metadata.prNumber, null);
  });

  it('preserves existing metadata fields (taskId, taskType)', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'main' }, '/tmp/project');
    assert.equal(spec.metadata.taskId, 'pt-test');
    assert.equal(spec.metadata.taskType, 'persistent');
  });
});

describe('buildAuditorSessionSpec — prompt content with baseRef', () => {
  it('injects "CRITICAL — Read from origin" section when baseRef set', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /## CRITICAL — Read from origin, not your local tree/);
    assert.match(prompt, /git show origin\/preview:<path>/);
  });

  it('uses headRef in diff command when provided', () => {
    const spec = buildAuditorSessionSpec(
      { ...BASE_ARGS, baseRef: 'preview', headRef: 'feature/x' },
      '/tmp/project',
    );
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /git diff origin\/preview\.\.\.origin\/feature\/x/);
  });

  it('includes mergeCommitSha in show command when provided', () => {
    const spec = buildAuditorSessionSpec(
      { ...BASE_ARGS, baseRef: 'preview', mergeCommitSha: 'a1b2c3d' },
      '/tmp/project',
    );
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /git show a1b2c3d/);
  });

  it('includes PR number in gh pr view example when provided', () => {
    const spec = buildAuditorSessionSpec(
      { ...BASE_ARGS, baseRef: 'preview', prNumber: '767' },
      '/tmp/project',
    );
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /gh pr view 767/);
  });

  it('mentions the audit-lane-guard PreToolUse enforcement', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /audit-lane-guard\.js PreToolUse hook denies/);
  });

  it('lists fetch command as the first thing to run', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /git fetch --no-tags origin preview/);
  });
});

describe('buildAuditorSessionSpec — prompt content without baseRef', () => {
  it('injects a warning section instead of CRITICAL when baseRef is unset', () => {
    const spec = buildAuditorSessionSpec(BASE_ARGS, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    assert.doesNotMatch(prompt, /## CRITICAL — Read from origin/);
    assert.match(prompt, /## NOTE — Working tree may not match the merged artifact/);
    assert.match(prompt, /git status/);
  });

  it('omits the baseRef-aware verification hint from the Process section', () => {
    const spec = buildAuditorSessionSpec(BASE_ARGS, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    // The Process section should NOT mention git show when baseRef is missing
    const processSection = prompt.match(/## Process[\s\S]+?## Verdict/);
    assert.ok(processSection);
    assert.doesNotMatch(processSection[0], /git show origin/);
  });
});

describe('buildAuditorSessionSpec — pre-existing prompt structure unchanged', () => {
  it('still includes HARD RULES section', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /## HARD RULES \(you cannot violate these\)/);
  });

  it('still includes the appropriate pass/fail verdict tools for persistent tasks', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /mcp__persistent-task__pt_audit_pass/);
    assert.match(prompt, /mcp__persistent-task__pt_audit_fail/);
  });

  it('routes plan tasks to the plan-orchestrator verdict tools', () => {
    const spec = buildAuditorSessionSpec(
      { ...BASE_ARGS, taskType: 'plan', baseRef: 'main' },
      '/tmp/project',
    );
    const prompt = spec.buildPrompt('agent-1');
    assert.match(prompt, /mcp__plan-orchestrator__verification_audit_pass/);
  });

  it('preserves the 8-minute TTL', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    assert.equal(spec.ttlMs, 8 * 60 * 1000);
  });

  it('preserves the audit lane assignment', () => {
    const spec = buildAuditorSessionSpec({ ...BASE_ARGS, baseRef: 'preview' }, '/tmp/project');
    assert.equal(spec.lane, 'audit');
  });
});
