/**
 * Tests for task-gate-spawner.js PostToolUse hook
 *
 * Validates:
 * 1. Hook structure and required exports
 * 2. extractKeyword() keyword extraction logic
 * 3. buildSpawnEnv() environment construction
 * 4. Pending_review detection logic
 * 5. Hook exits 0 in all cases (PostToolUse invariant)
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/task-gate-spawner.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.cwd();
const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/task-gate-spawner.js');
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude/hooks/agent-tracker.js');

describe('task-gate-spawner.js', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOOK_PATH, 'utf8');
  });

  // ============================================================================
  // File structure
  // ============================================================================

  describe('File structure', () => {
    it('should exist at expected path', () => {
      assert.ok(fs.existsSync(HOOK_PATH), `Hook file not found at ${HOOK_PATH}`);
    });

    it('should be a valid ES module (import syntax)', () => {
      assert.match(hookCode, /^import\s/m, 'Should use ES module imports');
    });

    it('should import from agent-tracker.js', () => {
      assert.match(
        hookCode,
        /import\s+\{[^}]*AGENT_TYPES[^}]*\}\s+from\s+['"]\.\/agent-tracker\.js['"]/,
        'Should import AGENT_TYPES from agent-tracker.js'
      );
    });

    it('should import registerSpawn and updateAgent from agent-tracker.js', () => {
      assert.match(
        hookCode,
        /import\s+\{[^}]*registerSpawn[^}]*\}\s+from\s+['"]\.\/agent-tracker\.js['"]/,
        'Should import registerSpawn from agent-tracker.js'
      );
      assert.match(
        hookCode,
        /import\s+\{[^}]*updateAgent[^}]*\}\s+from\s+['"]\.\/agent-tracker\.js['"]/,
        'Should import updateAgent from agent-tracker.js'
      );
    });

    it('should use AGENT_TYPES.TASK_GATE', () => {
      assert.match(hookCode, /AGENT_TYPES\.TASK_GATE/, 'Should reference AGENT_TYPES.TASK_GATE');
    });

    it('should always exit 0 (PostToolUse must never block)', () => {
      // The hook should have process.exit(0) at the end
      assert.match(hookCode, /process\.exit\(0\)/, 'Should always call process.exit(0)');
    });

    it('should read from process.stdin', () => {
      assert.match(hookCode, /process\.stdin\.on/, 'Should listen on stdin');
    });
  });

  // ============================================================================
  // AGENT_TYPES.TASK_GATE integration
  // ============================================================================

  describe('AGENT_TYPES.TASK_GATE', () => {
    it('should be defined in agent-tracker.js', () => {
      const agentTrackerCode = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
      assert.match(
        agentTrackerCode,
        /TASK_GATE:\s*'task-gate'/,
        'AGENT_TYPES.TASK_GATE must be defined as "task-gate" in agent-tracker.js'
      );
    });

    it('should be exported from agent-tracker.js', () => {
      const agentTrackerCode = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
      // Should be in the AGENT_TYPES object which is exported
      assert.match(
        agentTrackerCode,
        /export const AGENT_TYPES = \{[\s\S]*?TASK_GATE/,
        'TASK_GATE should be in exported AGENT_TYPES'
      );
    });

    it('should be in HOOK_TYPES as well', () => {
      const agentTrackerCode = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
      assert.match(
        agentTrackerCode,
        /HOOK_TYPES[\s\S]*?TASK_GATE/,
        'TASK_GATE should also be in HOOK_TYPES'
      );
    });
  });

  // ============================================================================
  // pending_review detection logic
  // ============================================================================

  describe('pending_review detection', () => {
    it('should check for taskStatus === pending_review', () => {
      assert.match(
        hookCode,
        /taskStatus\s*!==\s*['"]pending_review['"]/,
        'Should exit early when status is not pending_review'
      );
    });

    it('should parse tool_response for status field', () => {
      assert.match(hookCode, /tool_response/, 'Should access tool_response from hook input');
      assert.match(hookCode, /response\.status/, 'Should read status from response');
    });

    it('should handle both object and string tool_response formats', () => {
      // Should try JSON.parse for string responses
      assert.match(hookCode, /JSON\.parse/, 'Should handle JSON-stringified responses');
    });

    it('should handle MCP content array format', () => {
      assert.match(hookCode, /content.*Array\.isArray|Array\.isArray.*content/, 'Should handle MCP content array format');
    });
  });

  // ============================================================================
  // extractKeyword function
  // ============================================================================

  describe('extractKeyword function', () => {
    it('should be defined in the hook', () => {
      assert.match(hookCode, /function extractKeyword/, 'extractKeyword function must be defined');
    });

    it('should filter stop words', () => {
      // Should have a stopWords set with common words
      assert.match(hookCode, /stopWords/, 'Should define stop words');
      assert.match(hookCode, /'the'|"the"/, 'Stop words should include "the"');
      assert.match(hookCode, /'a'|"a"/, 'Stop words should include "a"');
    });

    it('should use title as fallback', () => {
      // When no keywords after filtering, should fall back to substring of title
      assert.match(hookCode, /title\.substring/, 'Should fall back to title substring');
    });
  });

  // ============================================================================
  // buildSpawnEnv function
  // ============================================================================

  describe('buildSpawnEnv function', () => {
    it('should be defined in the hook', () => {
      assert.match(hookCode, /function buildSpawnEnv/, 'buildSpawnEnv function must be defined');
    });

    it('should set CLAUDE_SPAWNED_SESSION to true', () => {
      assert.match(hookCode, /CLAUDE_SPAWNED_SESSION:\s*['"]true['"]/, 'Should set CLAUDE_SPAWNED_SESSION=true');
    });

    it('should set HTTPS_PROXY for rotation proxy', () => {
      assert.match(hookCode, /HTTPS_PROXY/, 'Should set HTTPS_PROXY');
    });

    it('should set CLAUDE_PROJECT_DIR', () => {
      assert.match(hookCode, /CLAUDE_PROJECT_DIR/, 'Should set CLAUDE_PROJECT_DIR');
    });

    it('should set CLAUDE_AGENT_ID', () => {
      assert.match(hookCode, /CLAUDE_AGENT_ID/, 'Should set CLAUDE_AGENT_ID');
    });

    it('should inject git-wrappers into PATH', () => {
      assert.match(hookCode, /git-wrappers/, 'Should inject git-wrappers into PATH for branch checkout guard');
    });
  });

  // ============================================================================
  // Gate prompt structure
  // ============================================================================

  describe('Gate prompt structure', () => {
    it('should include all 3 required checks in gate prompt', () => {
      // The gate prompt must reference all 3 checks
      assert.match(hookCode, /DUPLICATES/, 'Gate prompt must include DUPLICATES check');
      assert.match(hookCode, /STABILITY/, 'Gate prompt must include STABILITY check');
      assert.match(hookCode, /CTO INTENT/, 'Gate prompt must include CTO INTENT check');
    });

    it('should include gate tool calls in the prompt', () => {
      assert.match(hookCode, /gate_approve_task/, 'Gate prompt should reference gate_approve_task');
      assert.match(hookCode, /gate_kill_task/, 'Gate prompt should reference gate_kill_task');
      assert.match(hookCode, /gate_escalate_task/, 'Gate prompt should reference gate_escalate_task');
    });

    it('should include check_feature_stability reference', () => {
      assert.match(
        hookCode,
        /check_feature_stability/,
        'Gate prompt must reference check_feature_stability tool'
      );
    });

    it('should include search_cto_sessions reference', () => {
      assert.match(
        hookCode,
        /search_cto_sessions/,
        'Gate prompt must reference search_cto_sessions tool'
      );
    });

    it('should default to APPROVE when no issues found', () => {
      assert.match(
        hookCode,
        /default to APPROVE|Err toward approval/,
        'Gate prompt should default to approving tasks'
      );
    });
  });

  // ============================================================================
  // Spawn configuration
  // ============================================================================

  describe('Spawn configuration', () => {
    it('should spawn using claude CLI', () => {
      assert.match(hookCode, /spawn\('claude'/, 'Should spawn claude CLI');
    });

    it('should use Haiku model for lightweight gate review', () => {
      assert.match(hookCode, /claude-haiku/, 'Should use Haiku model for gate agent');
    });

    it('should use dangerously-skip-permissions flag', () => {
      assert.match(
        hookCode,
        /dangerously-skip-permissions/,
        'Should use --dangerously-skip-permissions flag'
      );
    });

    it('should detach the spawned process', () => {
      assert.match(hookCode, /detached:\s*true/, 'Should detach spawned process');
    });

    it('should call unref() on spawned process', () => {
      assert.match(hookCode, /claude\.unref\(\)/, 'Should call unref() to not block parent');
    });
  });
});
