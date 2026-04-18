/**
 * Tests for category-based agent routing in hourly-automation.js
 *
 * Phase 1A: SECTION_AGENT_MAP has been removed. Agent mapping now routes
 * exclusively through the task-category module (DB-driven via resolveCategory).
 *
 * Validates:
 * 1. SECTION_AGENT_MAP no longer exists (dead code eliminated)
 * 2. getAgentMapping() uses resolveCategory() exclusively
 * 3. SQL queries filter by category_id IS NOT NULL (not by section IN (...))
 * 4. AGENT_TYPES import still present for TASK_RUNNER constant
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/hourly-automation-product-manager.test.js
 *
 * @version 2.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();
const HOURLY_AUTOMATION_HOOK = path.join(PROJECT_DIR, '.claude/hooks/hourly-automation.js');

describe('Hourly Automation - Category-Based Agent Routing', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOURLY_AUTOMATION_HOOK, 'utf8');
  });

  // ============================================================================
  // Dead Code Elimination Tests
  // ============================================================================

  describe('SECTION_AGENT_MAP removed', () => {
    it('should NOT contain SECTION_AGENT_MAP constant', () => {
      assert.doesNotMatch(hookCode, /const SECTION_AGENT_MAP\s*=/,
        'SECTION_AGENT_MAP must not exist — routing is now category-based');
    });

    it('should NOT reference SECTION_AGENT_MAP anywhere', () => {
      assert.doesNotMatch(hookCode, /SECTION_AGENT_MAP/,
        'All SECTION_AGENT_MAP references must be removed');
    });
  });

  // ============================================================================
  // Category-Based Routing Tests
  // ============================================================================

  describe('getAgentMapping() uses resolveCategory exclusively', () => {
    it('should import resolveCategory from task-category.js', () => {
      assert.match(hookCode, /resolveCategory[\s\S]*?task-category\.js/,
        'resolveCategory must be imported from task-category.js');
    });

    it('should define getAgentMapping function', () => {
      assert.match(hookCode, /function getAgentMapping\(/,
        'getAgentMapping function must be defined');
    });

    it('should call resolveCategory inside getAgentMapping', () => {
      const fnMatch = hookCode.match(/function getAgentMapping\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'getAgentMapping function must be extractable');
      assert.match(fnMatch[0], /resolveCategory\(/,
        'getAgentMapping must call resolveCategory()');
    });

    it('should return null when category is not found', () => {
      const fnMatch = hookCode.match(/function getAgentMapping\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'getAgentMapping function must be extractable');
      assert.match(fnMatch[0], /if \(!category\) return null/,
        'getAgentMapping must return null when resolveCategory returns null');
    });

    it('should return task-runner agent type on success', () => {
      const fnMatch = hookCode.match(/function getAgentMapping\([\s\S]*?\n\}/);
      assert.ok(fnMatch, 'getAgentMapping function must be extractable');
      assert.match(fnMatch[0], /agent: 'task-runner'/,
        'getAgentMapping must return task-runner agent');
      assert.match(fnMatch[0], /AGENT_TYPES\.TASK_RUNNER/,
        'getAgentMapping must use AGENT_TYPES.TASK_RUNNER');
    });
  });

  // ============================================================================
  // SQL Query Tests
  // ============================================================================

  describe('SQL queries use category_id IS NOT NULL', () => {
    it('getPendingTasksForRunner should filter by category_id IS NOT NULL', () => {
      assert.match(hookCode, /category_id IS NOT NULL[\s\S]*?created_timestamp <=|created_timestamp <=[\s\S]*?category_id IS NOT NULL/,
        'getPendingTasksForRunner must filter by category_id IS NOT NULL with age filter');
    });

    it('getUrgentPendingTasks should filter by category_id IS NOT NULL', () => {
      // The urgent tasks query also filters by category_id IS NOT NULL
      const urgentFnMatch = hookCode.match(/function getUrgentPendingTasks[\s\S]*?return candidates;[\s\S]*?\}/);
      assert.ok(urgentFnMatch, 'getUrgentPendingTasks function must be present');
      assert.match(urgentFnMatch[0], /category_id IS NOT NULL/,
        'getUrgentPendingTasks must filter by category_id IS NOT NULL');
    });

    it('should NOT filter by section IN (...) in task runner queries', () => {
      // Ensure old section-based filtering is gone from the runner queries
      assert.doesNotMatch(hookCode, /section IN \(\$\{Object\.keys\(SECTION_AGENT_MAP/,
        'SQL must not use SECTION_AGENT_MAP for filtering');
    });
  });

  // ============================================================================
  // AGENT_TYPES Import Tests
  // ============================================================================

  describe('AGENT_TYPES import still present', () => {
    it('should import AGENT_TYPES from agent-tracker.js', () => {
      assert.match(hookCode, /AGENT_TYPES[\s\S]*?agent-tracker\.js/,
        'AGENT_TYPES must be imported from agent-tracker.js');
    });

    it('should use AGENT_TYPES.TASK_RUNNER (not section-specific types)', () => {
      assert.match(hookCode, /AGENT_TYPES\.TASK_RUNNER[^_]/,
        'Must use AGENT_TYPES.TASK_RUNNER (generic runner type)');
    });
  });
});
