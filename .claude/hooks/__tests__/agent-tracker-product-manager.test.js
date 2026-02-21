/**
 * Tests for PRODUCT-MANAGER agent type in agent-tracker.js
 *
 * Validates:
 * 1. AGENT_TYPES includes TASK_RUNNER_PRODUCT_MANAGER
 * 2. Value follows consistent naming pattern
 * 3. Integration with existing agent types
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/agent-tracker-product-manager.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();
const AGENT_TRACKER_HOOK = path.join(PROJECT_DIR, '.claude/hooks/agent-tracker.js');

describe('Agent Tracker - PRODUCT-MANAGER Agent Type', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(AGENT_TRACKER_HOOK, 'utf8');
  });

  // ============================================================================
  // AGENT_TYPES Enum
  // ============================================================================

  describe('AGENT_TYPES enum', () => {
    it('should include TASK_RUNNER_PRODUCT_MANAGER', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      assert.ok(agentTypesMatch, 'AGENT_TYPES constant must exist');

      const agentTypesObject = agentTypesMatch[0];
      assert.match(agentTypesObject, /TASK_RUNNER_PRODUCT_MANAGER:/);
    });

    it('should set TASK_RUNNER_PRODUCT_MANAGER to correct value', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Value should be 'task-runner-product-manager'
      assert.match(agentTypesObject, /TASK_RUNNER_PRODUCT_MANAGER:\s*'task-runner-product-manager'/);
    });

    it('should export AGENT_TYPES in default export', () => {
      // Should export AGENT_TYPES
      assert.match(hookCode, /export default \{[\s\S]*?AGENT_TYPES/);
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('Integration with existing agent types', () => {
    it('should not conflict with existing AGENT_TYPES keys', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Extract all keys
      const keys = agentTypesObject.match(/\w+:/g);
      const uniqueKeys = new Set(keys);

      // All keys should be unique
      assert.strictEqual(keys.length, uniqueKeys.size, 'All AGENT_TYPES keys must be unique');
    });

    it('should not conflict with existing agent type values', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Extract all string values
      const values = agentTypesObject.match(/'[^']+'/g);
      const uniqueValues = new Set(values);

      // All values should be unique
      assert.strictEqual(values.length, uniqueValues.size, 'All AGENT_TYPES values must be unique');
    });

    it('should be in same AGENT_TYPES object as other task runners', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // All task runner types should be in the same object
      const otherTaskRunners = [
        'TASK_RUNNER_CODE_REVIEWER',
        'TASK_RUNNER_INVESTIGATOR',
        'TASK_RUNNER_TEST_WRITER',
        'TASK_RUNNER_PROJECT_MANAGER',
        'TASK_RUNNER_DEPUTY_CTO',
        'TASK_RUNNER_PRODUCT_MANAGER'
      ];

      for (const runner of otherTaskRunners) {
        assert.match(agentTypesObject, new RegExp(runner),
          `${runner} should be in AGENT_TYPES object`);
      }
    });
  });

  // ============================================================================
  // Value Consistency Tests
  // ============================================================================

  describe('Value consistency', () => {
    it('should use kebab-case for agent type value', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      const valueMatch = agentTypesObject.match(/TASK_RUNNER_PRODUCT_MANAGER:\s*'([^']+)'/);
      assert.ok(valueMatch, 'TASK_RUNNER_PRODUCT_MANAGER value must exist');

      const value = valueMatch[1];
      assert.strictEqual(value, 'task-runner-product-manager', 'Value must be in kebab-case');
    });

    it('should follow naming pattern of other task runners', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Should follow pattern: task-runner-*
      const valueMatch = agentTypesObject.match(/TASK_RUNNER_PRODUCT_MANAGER:\s*'([^']+)'/);
      const value = valueMatch[1];

      assert.ok(value.startsWith('task-runner-'), 'Value must follow task-runner-* pattern');
    });

    it('should use SCREAMING_SNAKE_CASE for constant name', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Key should be SCREAMING_SNAKE_CASE
      assert.match(agentTypesObject, /TASK_RUNNER_PRODUCT_MANAGER:/);

      // Extract the key name
      const keyMatch = agentTypesObject.match(/(TASK_RUNNER_PRODUCT_MANAGER):/);
      const key = keyMatch[1];

      // Should be all uppercase with underscores
      assert.match(key, /^[A-Z_]+$/, 'Constant name must be SCREAMING_SNAKE_CASE');
    });
  });

  // ============================================================================
  // Count Validation
  // ============================================================================

  describe('Total agent types count', () => {
    it('should have expected number of total agent types', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Count all type definitions
      const typeCount = (agentTypesObject.match(/\w+:\s*'[^']+'/g) || []).length;

      // Should have at least 20 types (can grow over time)
      assert.ok(typeCount >= 20, `Should have at least 20 agent types, found ${typeCount}`);
    });

    it('should have 6 task runner types', () => {
      const agentTypesMatch = hookCode.match(/export const AGENT_TYPES = \{[\s\S]*?\};/);
      const agentTypesObject = agentTypesMatch[0];

      // Count TASK_RUNNER_* types
      const taskRunnerCount = (agentTypesObject.match(/TASK_RUNNER_\w+:/g) || []).length;

      assert.strictEqual(taskRunnerCount, 6, 'Should have 6 task runner types including PRODUCT_MANAGER');
    });
  });
});
