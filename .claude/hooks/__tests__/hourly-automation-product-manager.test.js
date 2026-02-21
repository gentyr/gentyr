/**
 * Tests for PRODUCT-MANAGER section in hourly-automation.js
 *
 * Validates:
 * 1. SECTION_AGENT_MAP includes PRODUCT-MANAGER
 * 2. PRODUCT-MANAGER maps to correct agent and agent type
 * 3. Integration with existing sections
 *
 * Uses Node.js built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/hourly-automation-product-manager.test.js
 *
 * @version 1.0.0
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

const PROJECT_DIR = process.cwd();
const HOURLY_AUTOMATION_HOOK = path.join(PROJECT_DIR, '.claude/hooks/hourly-automation.js');

describe('Hourly Automation - PRODUCT-MANAGER Section', () => {
  let hookCode;

  beforeEach(() => {
    hookCode = fs.readFileSync(HOURLY_AUTOMATION_HOOK, 'utf8');
  });

  // ============================================================================
  // SECTION_AGENT_MAP Tests
  // ============================================================================

  describe('SECTION_AGENT_MAP', () => {
    it('should include PRODUCT-MANAGER section', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      assert.ok(sectionMapMatch, 'SECTION_AGENT_MAP constant must exist');

      const sectionMapObject = sectionMapMatch[0];
      assert.match(sectionMapObject, /'PRODUCT-MANAGER':/);
    });

    it('should map PRODUCT-MANAGER to correct agent name', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // Extract the mapping for PRODUCT-MANAGER
      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{\s*agent:\s*'([^']+)'/
      );

      assert.ok(productManagerMatch, 'PRODUCT-MANAGER must have agent mapping');

      const agentName = productManagerMatch[1];
      assert.strictEqual(agentName, 'product-manager', 'Agent name must be product-manager');
    });

    it('should map PRODUCT-MANAGER to correct agent type', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // Extract the agentType for PRODUCT-MANAGER
      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{[\s\S]*?agentType:\s*AGENT_TYPES\.([A-Z_]+)/
      );

      assert.ok(productManagerMatch, 'PRODUCT-MANAGER must have agentType mapping');

      const agentType = productManagerMatch[1];
      assert.strictEqual(agentType, 'TASK_RUNNER_PRODUCT_MANAGER',
        'Agent type must be AGENT_TYPES.TASK_RUNNER_PRODUCT_MANAGER');
    });

    it('should reference AGENT_TYPES enum for agentType', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // PRODUCT-MANAGER should use AGENT_TYPES.TASK_RUNNER_PRODUCT_MANAGER
      assert.match(sectionMapObject, /AGENT_TYPES\.TASK_RUNNER_PRODUCT_MANAGER/);
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('Integration with existing sections', () => {
    it('should include all expected sections', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      const expectedSections = [
        'TEST-WRITER',
        'INVESTIGATOR & PLANNER',
        'CODE-REVIEWER',
        'PROJECT-MANAGER',
        'DEPUTY-CTO',
        'PRODUCT-MANAGER'
      ];

      for (const section of expectedSections) {
        assert.match(sectionMapObject, new RegExp(`'${section}':`),
          `Section ${section} must be defined`);
      }
    });

    it('should not have duplicate section keys', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // Extract all section keys
      const sectionKeys = sectionMapObject.match(/'[A-Z& -]+':/g);
      const uniqueKeys = new Set(sectionKeys);

      assert.strictEqual(sectionKeys.length, uniqueKeys.size,
        'All section keys must be unique');
    });

    it('should have consistent object structure with other sections', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // Extract PRODUCT-MANAGER mapping
      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{[\s\S]*?agent:\s*'[^']+',[\s\S]*?agentType:\s*AGENT_TYPES\.[A-Z_]+[\s\S]*?\}/
      );

      assert.ok(productManagerMatch, 'PRODUCT-MANAGER must have agent and agentType fields');

      // Extract another section for comparison (e.g., PROJECT-MANAGER)
      const projectManagerMatch = sectionMapObject.match(
        /'PROJECT-MANAGER':\s*\{[\s\S]*?agent:\s*'[^']+',[\s\S]*?agentType:\s*AGENT_TYPES\.[A-Z_]+[\s\S]*?\}/
      );

      assert.ok(projectManagerMatch, 'PROJECT-MANAGER must exist for comparison');

      // Both should have same field structure
      const productFields = productManagerMatch[0].match(/(agent|agentType):/g);
      const projectFields = projectManagerMatch[0].match(/(agent|agentType):/g);

      assert.deepStrictEqual(productFields, projectFields,
        'PRODUCT-MANAGER should have same field structure as other sections');
    });
  });

  // ============================================================================
  // Naming Convention Tests
  // ============================================================================

  describe('Naming conventions', () => {
    it('should use UPPERCASE for section key', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // Section key must be 'PRODUCT-MANAGER' not 'product-manager'
      assert.match(sectionMapObject, /'PRODUCT-MANAGER':/);
      assert.doesNotMatch(sectionMapObject, /'product-manager':/);
    });

    it('should use kebab-case for agent name', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{\s*agent:\s*'([^']+)'/
      );

      const agentName = productManagerMatch[1];
      assert.strictEqual(agentName, 'product-manager',
        'Agent name must be in kebab-case');
    });

    it('should use SCREAMING_SNAKE_CASE for AGENT_TYPES constant', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{[\s\S]*?agentType:\s*AGENT_TYPES\.([A-Z_]+)/
      );

      const agentType = productManagerMatch[1];
      assert.match(agentType, /^[A-Z_]+$/, 'AGENT_TYPES constant must be SCREAMING_SNAKE_CASE');
    });
  });

  // ============================================================================
  // Validation Tests
  // ============================================================================

  describe('Validation', () => {
    it('should import AGENT_TYPES before using it', () => {
      // AGENT_TYPES should be imported from agent-tracker.js
      const importMatch = hookCode.match(/import\s+\{[\s\S]*?AGENT_TYPES[\s\S]*?\}\s+from\s+['"]\.\/agent-tracker\.js['"]/);
      assert.ok(importMatch, 'AGENT_TYPES must be imported from agent-tracker.js');

      // Import should come before SECTION_AGENT_MAP
      const importIndex = hookCode.indexOf(importMatch[0]);
      const sectionMapIndex = hookCode.indexOf('const SECTION_AGENT_MAP');

      assert.ok(sectionMapIndex > 0, 'SECTION_AGENT_MAP must be defined');
      assert.ok(importIndex < sectionMapIndex,
        'AGENT_TYPES import must come before SECTION_AGENT_MAP');
    });

    it('should have agent name matching the section pattern', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{\s*agent:\s*'([^']+)'/
      );

      const agentName = productManagerMatch[1];
      const sectionName = 'PRODUCT-MANAGER';

      // Agent name should be lowercase version of section name with hyphens
      const expectedAgentName = sectionName.toLowerCase();
      assert.strictEqual(agentName, expectedAgentName,
        `Agent name should be lowercase version of section: ${expectedAgentName}`);
    });

    it('should have agentType matching the section pattern', () => {
      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      const productManagerMatch = sectionMapObject.match(
        /'PRODUCT-MANAGER':\s*\{[\s\S]*?agentType:\s*AGENT_TYPES\.([A-Z_]+)/
      );

      const agentType = productManagerMatch[1];
      const sectionName = 'PRODUCT-MANAGER';

      // Agent type should follow pattern: TASK_RUNNER_{SECTION_NAME_WITH_UNDERSCORES}
      const expectedAgentType = 'TASK_RUNNER_' + sectionName.replace(/-/g, '_');
      assert.strictEqual(agentType, expectedAgentType,
        `Agent type should follow pattern: ${expectedAgentType}`);
    });
  });

  // ============================================================================
  // Consistency Tests
  // ============================================================================

  describe('Consistency with TODO database schema', () => {
    it('should match valid_section constraint in todo.db', () => {
      // The PRODUCT-MANAGER section should match the CHECK constraint in todo.db schema
      const validSections = [
        'TEST-WRITER',
        'INVESTIGATOR & PLANNER',
        'CODE-REVIEWER',
        'PROJECT-MANAGER',
        'DEPUTY-CTO',
        'PRODUCT-MANAGER'
      ];

      const sectionMapMatch = hookCode.match(/const SECTION_AGENT_MAP = \{[\s\S]*?\};/);
      const sectionMapObject = sectionMapMatch[0];

      // Extract all section keys from SECTION_AGENT_MAP
      const sectionKeys = Array.from(sectionMapObject.matchAll(/'([A-Z& -]+)':/g))
        .map(match => match[1]);

      // All sections in SECTION_AGENT_MAP should be in validSections
      for (const section of sectionKeys) {
        assert.ok(validSections.includes(section),
          `Section ${section} should be in todo.db valid_section constraint`);
      }
    });
  });
});
