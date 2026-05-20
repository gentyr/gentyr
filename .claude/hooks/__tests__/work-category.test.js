/**
 * Tests for `.claude/hooks/lib/work-category.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveWorkCategory,
  isRevivalSource,
  normalizeRevivalSource,
  REVIVAL_SOURCES,
  WORK_CATEGORY_DESCRIPTIONS,
} from '../lib/work-category.js';

describe('isRevivalSource', () => {
  it('returns true for direct revival code paths', () => {
    assert.equal(isRevivalSource('session-queue-reaper'), true);
    assert.equal(isRevivalSource('session-reviver'), true);
    assert.equal(isRevivalSource('revival-utils'), true);
    assert.equal(isRevivalSource('drain-audit-orphan-recovery'), true);
    assert.equal(isRevivalSource('sync-recycle'), true);
    assert.equal(isRevivalSource('preemption'), true);
  });

  it('returns true for hourly-automation revival blocks', () => {
    assert.equal(isRevivalSource('hourly-automation:revive_dead_persistent_monitor'), true);
    assert.equal(isRevivalSource('hourly-automation:persistent_stale_pause_resume'), true);
    assert.equal(isRevivalSource('hourly-automation:plan_orphan_revive'), true);
  });

  it('returns false for original spawn sources', () => {
    assert.equal(isRevivalSource('persistent-task-spawner'), false);
    assert.equal(isRevivalSource('plan-activation-spawner'), false);
    assert.equal(isRevivalSource('urgent-task-spawner'), false);
    assert.equal(isRevivalSource('hourly-automation:task_runner'), false);
    assert.equal(isRevivalSource(null), false);
    assert.equal(isRevivalSource(undefined), false);
    assert.equal(isRevivalSource(''), false);
  });
});

describe('normalizeRevivalSource', () => {
  it('strips the hourly-automation: prefix', () => {
    assert.equal(normalizeRevivalSource('hourly-automation:revive_dead_persistent_monitor'),
      'revive_dead_persistent_monitor');
  });

  it('returns the source unchanged when no prefix', () => {
    assert.equal(normalizeRevivalSource('session-queue-reaper'), 'session-queue-reaper');
  });

  it('handles null/undefined', () => {
    assert.equal(normalizeRevivalSource(null), null);
    assert.equal(normalizeRevivalSource(undefined), null);
  });
});

describe('deriveWorkCategory', () => {
  it('classifies persistent-task-monitor variants', () => {
    assert.equal(deriveWorkCategory({ agentType: 'persistent-task-monitor' }), 'persistent-monitor');
    assert.equal(deriveWorkCategory({ agentType: 'PERSISTENT_TASK_MONITOR' }), 'persistent-monitor');
    assert.equal(deriveWorkCategory({ agentType: 'persistent_task_monitor' }), 'persistent-monitor');
  });

  it('detects plan-manager via metadata.isPlanManager', () => {
    assert.equal(deriveWorkCategory({
      agentType: 'persistent-task-monitor',
      metadata: { isPlanManager: true },
    }), 'plan-manager');
    assert.equal(deriveWorkCategory({
      agentType: 'PERSISTENT_TASK_MONITOR',
      metadata: { taskType: 'plan', planId: 'plan-abc' },
    }), 'plan-manager');
  });

  it('detects global-monitor via metadata.taskType', () => {
    assert.equal(deriveWorkCategory({
      agentType: 'persistent-task-monitor',
      metadata: { taskType: 'global_monitor' },
    }), 'global-monitor');
  });

  it('classifies all three auditor types separately', () => {
    assert.equal(deriveWorkCategory({ agentType: 'universal-auditor' }), 'universal-auditor');
    assert.equal(deriveWorkCategory({ agentType: 'UNIVERSAL_AUDITOR' }), 'universal-auditor');
    assert.equal(deriveWorkCategory({ agentType: 'plan-auditor' }), 'plan-auditor');
    assert.equal(deriveWorkCategory({ agentType: 'PLAN_AUDITOR' }), 'plan-auditor');
    assert.equal(deriveWorkCategory({ agentType: 'authorization-auditor' }), 'authorization-auditor');
    assert.equal(deriveWorkCategory({ agentType: 'AUTHORIZATION_AUDITOR' }), 'authorization-auditor');
  });

  it('routes task-runner family agents into task-runner', () => {
    assert.equal(deriveWorkCategory({ agentType: 'task-runner' }), 'task-runner');
    assert.equal(deriveWorkCategory({ agentType: 'task_runner' }), 'task-runner');
    assert.equal(deriveWorkCategory({ agentType: 'TASK_RUNNER_PROJECT_MANAGER' }), 'task-runner');
    assert.equal(deriveWorkCategory({ agentType: 'TASK_RUNNER_WORKSTREAM_MANAGER' }), 'task-runner');
    assert.equal(deriveWorkCategory({ agentType: 'session-revived' }), 'task-runner');
  });

  it('classifies demo-related agents', () => {
    assert.equal(deriveWorkCategory({ agentType: 'TASK_RUNNER_DEMO_MANAGER' }), 'demo-manager');
    assert.equal(deriveWorkCategory({ agentType: 'demo-manager' }), 'demo-manager');
    assert.equal(deriveWorkCategory({ agentType: 'DEMO_REPAIR' }), 'demo-manager');
    assert.equal(deriveWorkCategory({ agentType: 'DEMO_VALIDATOR' }), 'demo-manager');
  });

  it('classifies promotion agents', () => {
    assert.equal(deriveWorkCategory({ agentType: 'preview-promoter' }), 'preview-promoter');
    assert.equal(deriveWorkCategory({ agentType: 'preview_promoter' }), 'preview-promoter');
    assert.equal(deriveWorkCategory({ agentType: 'HOTFIX_PROMOTION' }), 'hotfix-promotion');
  });

  it('classifies reviewer / auditor / hunter agents', () => {
    assert.equal(deriveWorkCategory({ agentType: 'staging-reactive-reviewer' }), 'staging-reviewer');
    assert.equal(deriveWorkCategory({ agentType: 'security-auditor' }), 'security-auditor');
    assert.equal(deriveWorkCategory({ agentType: 'ANTIPATTERN_HUNTER_COMMIT' }), 'antipattern-hunter');
    assert.equal(deriveWorkCategory({ agentType: 'STANDALONE_COMPLIANCE_CHECKER' }), 'compliance-checker');
    assert.equal(deriveWorkCategory({ agentType: 'AI_PR_REVIEWER' }), 'pr-reviewer');
  });

  it('classifies maintenance and health agents', () => {
    assert.equal(deriveWorkCategory({ agentType: 'LINT_FIXER' }), 'lint-fixer');
    assert.equal(deriveWorkCategory({ agentType: 'TODO_PROCESSING' }), 'todo-maintenance');
    assert.equal(deriveWorkCategory({ agentType: 'CLAUDEMD_REFACTOR' }), 'claudemd-refactor');
    assert.equal(deriveWorkCategory({ agentType: 'PRODUCTION_HEALTH_MONITOR' }), 'health-monitor');
    assert.equal(deriveWorkCategory({ agentType: 'STAGING_HEALTH_MONITOR' }), 'health-monitor');
    assert.equal(deriveWorkCategory({ agentType: 'FEDERATION_MAPPER' }), 'federation-mapper');
  });

  it('classifies deputy-cto and gate agents', () => {
    assert.equal(deriveWorkCategory({ agentType: 'DEPUTY_CTO_REVIEW' }), 'deputy-cto');
    assert.equal(deriveWorkCategory({ agentType: 'deputy-cto-triage' }), 'deputy-cto');
    assert.equal(deriveWorkCategory({ agentType: 'TASK_GATE' }), 'gate-agent');
  });

  it('classifies test-fixers', () => {
    assert.equal(deriveWorkCategory({ agentType: 'TEST_FAILURE_JEST' }), 'test-fixer');
    assert.equal(deriveWorkCategory({ agentType: 'TEST_FAILURE_PLAYWRIGHT' }), 'test-fixer');
    assert.equal(deriveWorkCategory({ agentType: 'TEST_FAILURE_VITEST' }), 'test-fixer');
  });

  it('detects compaction subagent by session id prefix', () => {
    assert.equal(deriveWorkCategory({
      sessionId: 'agent-acompact-deadbeef',
      isSubagent: true,
    }), 'compaction-subagent');
  });

  it('classifies Agent-tool subagents under agent-tool-subagent (granularity in agent_type)', () => {
    // The specific subagent type lives in agent_type, not work_category.
    assert.equal(deriveWorkCategory({
      sessionId: 'agent-a09f0512eddaa396c',
      agentType: 'user-alignment',
      isSubagent: true,
    }), 'agent-tool-subagent');
    assert.equal(deriveWorkCategory({
      sessionId: 'agent-a1070731037649af0',
      agentType: 'investigator',
      isSubagent: true,
    }), 'agent-tool-subagent');
  });

  it('falls back to source-based classification when agent_type is unknown', () => {
    assert.equal(deriveWorkCategory({ source: 'antipattern-hunter-hook' }), 'antipattern-hunter');
    assert.equal(deriveWorkCategory({ source: 'ai-pr-review-hook' }), 'pr-reviewer');
    assert.equal(deriveWorkCategory({ source: 'task-gate-spawner' }), 'gate-agent');
    assert.equal(deriveWorkCategory({ source: 'demo-failure-spawner' }), 'demo-manager');
    assert.equal(deriveWorkCategory({ source: 'subprocess:broadcaster' }), 'subprocess-llm');
  });

  it('returns null for unclassifiable input (caller decides interactive-cto vs other)', () => {
    assert.equal(deriveWorkCategory({}), null);
    assert.equal(deriveWorkCategory({ agentType: 'whatever-weird-thing' }), null);
  });

  it('returns plan-manager when source is plan-activation-spawner (post-revival hint)', () => {
    // A revived plan-manager queue item gets source=session-queue-reaper but
    // agent_type=persistent-task-monitor — work_category should derive from
    // agent_type, not source. The source fallback only kicks in when
    // agent_type is empty.
    assert.equal(deriveWorkCategory({
      agentType: 'persistent-task-monitor',
      source: 'session-queue-reaper',
      metadata: { isPlanManager: true },
    }), 'plan-manager');
  });
});

describe('REVIVAL_SOURCES contents', () => {
  it('includes all 9 direct revival code paths', () => {
    for (const src of [
      'session-queue-reaper', 'session-reviver', 'revival-utils',
      'session-reaper-audit-revival', 'drain-audit-orphan-recovery',
      'preemption', 'sync-recycle',
      'deputy-bypass-resolve-audited', 'bypass-request-resolve',
    ]) {
      assert.ok(REVIVAL_SOURCES.has(src), `REVIVAL_SOURCES missing: ${src}`);
    }
  });
});

describe('WORK_CATEGORY_DESCRIPTIONS', () => {
  it('has a description for every category produced by deriveWorkCategory', () => {
    const expectedCategories = [
      'plan-manager', 'persistent-monitor', 'global-monitor',
      'universal-auditor', 'plan-auditor', 'authorization-auditor',
      'task-runner', 'demo-manager', 'preview-promoter', 'hotfix-promotion',
      'pr-reviewer', 'staging-reviewer', 'security-auditor', 'feedback-agent',
      'gate-agent', 'antipattern-hunter', 'compliance-checker', 'deputy-cto',
      'health-monitor', 'lint-fixer', 'claudemd-refactor', 'federation-mapper',
      'test-fixer', 'todo-maintenance', 'compaction-subagent',
      'agent-tool-subagent', 'interactive-cto', 'subprocess-llm', 'other',
    ];
    for (const cat of expectedCategories) {
      assert.ok(WORK_CATEGORY_DESCRIPTIONS[cat], `missing description for: ${cat}`);
      assert.ok(WORK_CATEGORY_DESCRIPTIONS[cat].length > 0);
    }
  });
});
