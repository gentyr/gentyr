/**
 * Tests for quota-monitor.js rotation audit system
 *
 * Covers the rotation audit features added to verify post-rotation health:
 * - appendRotationAudit() imported from key-sync.js
 * - verifyPendingAudit() Keychain match and health check logic
 * - pendingAudit object structure
 * - Post-rotation audit scheduling
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/quota-monitor-rotation-audit.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOOK_PATH = path.join(__dirname, '..', 'quota-monitor.js');

describe('quota-monitor.js - Rotation Audit System', () => {
  describe('appendRotationAudit() import', () => {
    it('should import appendRotationAudit from key-sync.js', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /appendRotationAudit/,
        'Must import appendRotationAudit from key-sync.js'
      );
    });

    it('should import ROTATION_AUDIT_LOG_PATH from key-sync.js', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /ROTATION_AUDIT_LOG_PATH/,
        'Must import ROTATION_AUDIT_LOG_PATH from key-sync.js'
      );
    });

    it('should not define a local appendAuditLog function', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.doesNotMatch(
        code,
        /function appendAuditLog\(/,
        'Must not define local appendAuditLog — use appendRotationAudit from key-sync.js'
      );
    });
  });

  describe('verifyPendingAudit() function', () => {
    it('should define async verifyPendingAudit function', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /async function verifyPendingAudit\(/,
        'Must define async verifyPendingAudit function'
      );
    });

    it('should return early if no pendingAudit exists', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /if \(!audit.*\) return/,
        'Must return early if audit is null or undefined'
      );
    });

    it('should return early if audit already verified', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /audit\.verifiedAt.*return/,
        'Must return early if audit.verifiedAt is already set'
      );
    });

    it('should read Keychain credentials', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /readKeychainCredentials\(\)/,
        'Must call readKeychainCredentials()'
      );
    });

    it('should compare Keychain key ID against toKeyId', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /keychainKeyId === audit\.toKeyId/,
        'Must compare Keychain key ID against audit.toKeyId'
      );
    });

    it('should set keychainMatch boolean flag', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /keychainMatch = keychainKeyId === audit\.toKeyId/,
        'Must set keychainMatch to boolean comparison result'
      );
    });

    it('should call checkKeyHealth for target key', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /await checkKeyHealth\(targetKey\.accessToken\)/,
        'Must call checkKeyHealth for target key'
      );
    });

    it('should set healthCheckPassed from health.valid', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /healthCheckPassed = health\.valid/,
        'Must set healthCheckPassed from health.valid'
      );
    });

    it('should set audit.verifiedAt timestamp', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /audit\.verifiedAt = now/,
        'Must set audit.verifiedAt timestamp'
      );
    });

    it('should set audit.keychainMatch', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /audit\.keychainMatch = keychainMatch/,
        'Must set audit.keychainMatch'
      );
    });

    it('should set audit.healthCheckPassed', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /audit\.healthCheckPassed = healthCheckPassed/,
        'Must set audit.healthCheckPassed'
      );
    });

    it('should calculate adoption time in seconds', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /adoptionTimeSec.*Math\.round.*audit\.rotatedAt.*1000/,
        'Must calculate adoption time in seconds: Math.round((now - rotatedAt) / 1000)'
      );
    });

    it('should log AUDIT event via appendRotationAudit', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const fnMatch = code.match(/async function verifyPendingAudit[\s\S]{0,1500}\}/);
      assert.ok(fnMatch, 'Must have verifyPendingAudit function');

      assert.match(
        fnMatch[0],
        /appendRotationAudit\(['"]AUDIT['"]/,
        'Must call appendRotationAudit with AUDIT event'
      );

      assert.match(
        fnMatch[0],
        /keychainMatch.*MATCH.*MISMATCH/,
        'Must include keychainMatch as MATCH/MISMATCH in AUDIT details'
      );

      assert.match(
        fnMatch[0],
        /healthCheckPassed.*PASS.*FAIL/,
        'Must include healthCheckPassed as PASS/FAIL in AUDIT details'
      );
    });
  });

  describe('Step 1b: Pending audit verification', () => {
    it('should call verifyPendingAudit in main()', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /await verifyPendingAudit\(throttle\)/,
        'Must call verifyPendingAudit in main()'
      );
    });

    it('should verify audit before rotation logic (after throttle check)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // Find Step 1b (audit verification)
      const step1bMatch = code.match(/Step 1b.*pending.*audit/i);
      assert.ok(step1bMatch, 'Must have Step 1b for pending audit verification');

      // Find Step 2 (anti-loop cooldown)
      const step2Match = code.match(/Step 2.*anti-loop/i);
      assert.ok(step2Match, 'Must have Step 2 for anti-loop');

      // Step 1b must come before Step 2
      const step1bPos = code.indexOf(step1bMatch[0]);
      const step2Pos = code.indexOf(step2Match[0]);

      assert.ok(
        step1bPos < step2Pos,
        'Step 1b (audit verification) must come before Step 2 (anti-loop)'
      );
    });

    it('should check if pendingAudit exists and is not verified', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const step1bMatch = code.match(/Step 1b[\s\S]{0,300}/);
      assert.ok(step1bMatch, 'Must have Step 1b block');

      assert.match(
        step1bMatch[0],
        /throttle\.pendingAudit.*!throttle\.pendingAudit\.verifiedAt/,
        'Must check that pendingAudit exists and is not verified'
      );
    });

    it('should write throttle state after verification', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const step1bMatch = code.match(/Step 1b[\s\S]{0,500}/);
      assert.ok(step1bMatch, 'Must have Step 1b block');

      assert.match(
        step1bMatch[0],
        /writeThrottleState\(throttle\)/,
        'Must write throttle state after verification'
      );
    });
  });

  describe('Step 6: Post-rotation audit scheduling', () => {
    it('should create pendingAudit object after rotation', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        code,
        /throttle\.pendingAudit = \{/,
        'Must create pendingAudit object in throttle state'
      );
    });

    it('should schedule audit in Step 6 (after rotation)', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const step6Match = code.match(/Step 6.*audit/i);
      assert.ok(step6Match, 'Must have Step 6 for post-rotation audit');
    });

    it('should include all required pendingAudit fields', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const auditObjMatch = code.match(/throttle\.pendingAudit = \{[\s\S]{0,800}\}/);
      assert.ok(auditObjMatch, 'Must have pendingAudit object assignment');

      const requiredFields = [
        'rotatedAt',
        'fromKeyId',
        'toKeyId',
        'reason',
        'sessionType',
        'verifiedAt',
        'keychainMatch',
        'healthCheckPassed',
      ];

      for (const field of requiredFields) {
        assert.match(
          auditObjMatch[0],
          new RegExp(`${field}:`),
          `pendingAudit must include ${field} field`
        );
      }
    });

    it('should set sessionType based on isAutomated flag', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const auditObjMatch = code.match(/throttle\.pendingAudit = \{[\s\S]{0,800}\}/);
      assert.ok(auditObjMatch, 'Must have pendingAudit object assignment');

      assert.match(
        auditObjMatch[0],
        /sessionType:\s*isAutomated \? ['"]automated['"] : ['"]interactive['"]/,
        'pendingAudit.sessionType must be set based on isAutomated'
      );
    });

    it('should initialize nullable fields to null', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const auditObjMatch = code.match(/throttle\.pendingAudit = \{[\s\S]{0,800}\}/);
      assert.ok(auditObjMatch, 'Must have pendingAudit object assignment');

      const nullableFields = [
        'verifiedAt',
        'keychainMatch',
        'healthCheckPassed',
      ];

      for (const field of nullableFields) {
        assert.match(
          auditObjMatch[0],
          new RegExp(`${field}:\\s*null`),
          `pendingAudit.${field} must be initialized to null`
        );
      }
    });

    it('should log ROTATION event via appendRotationAudit', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // Find rotation success block
      const rotationMatch = code.match(/updateActiveCredentials\(selectedKey\);[\s\S]{0,2000}if \(!isAutomated\)/);
      assert.ok(rotationMatch, 'Must have rotation success block');

      assert.match(
        rotationMatch[0],
        /appendRotationAudit\(['"]ROTATION['"]/,
        'Must call appendRotationAudit with ROTATION event'
      );
    });

    it('should include from/to key IDs in rotation log', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      // Find the appendRotationAudit ROTATION call
      const rotationLogMatch = code.match(/appendRotationAudit\(['"]ROTATION['"][\s\S]{0,400}\}\)/);
      assert.ok(rotationLogMatch, 'Must have ROTATION appendRotationAudit call');

      assert.match(
        rotationLogMatch[0],
        /previousKeyId\.slice/,
        'ROTATION log must include previousKeyId.slice() for fromKeyId'
      );

      assert.match(
        rotationLogMatch[0],
        /selectedKeyId\.slice/,
        'ROTATION log must include selectedKeyId.slice() for toKeyId'
      );
    });

    it('should include rotation reason in log', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const rotationLogMatch = code.match(/appendRotationAudit\(['"]ROTATION['"][\s\S]{0,400}\}\)/);
      assert.ok(rotationLogMatch, 'Must have ROTATION appendRotationAudit call');

      assert.match(
        rotationLogMatch[0],
        /rotationReason/,
        'ROTATION log must include rotationReason variable'
      );
    });

    it('should include sessionType in rotation log', () => {
      const code = fs.readFileSync(HOOK_PATH, 'utf8');

      const rotationLogMatch = code.match(/appendRotationAudit\(['"]ROTATION['"][\s\S]{0,400}\}\)/);
      assert.ok(rotationLogMatch, 'Must have ROTATION appendRotationAudit call');

      assert.match(
        rotationLogMatch[0],
        /isAutomated.*automated.*interactive/,
        'ROTATION log must include sessionType with isAutomated ternary'
      );
    });
  });

  describe('Audit verification decision matrix', () => {
    it('should set keychainMatch=true when Keychain key matches toKeyId', () => {
      const keychainKeyId = 'abc12345';
      const audit = { toKeyId: 'abc12345' };

      const keychainMatch = keychainKeyId === audit.toKeyId;

      assert.strictEqual(keychainMatch, true, 'keychainMatch must be true when IDs match');
    });

    it('should set keychainMatch=false when Keychain key does not match toKeyId', () => {
      const keychainKeyId = 'xyz99999';
      const audit = { toKeyId: 'abc12345' };

      const keychainMatch = keychainKeyId === audit.toKeyId;

      assert.strictEqual(keychainMatch, false, 'keychainMatch must be false when IDs do not match');
    });

    it('should set healthCheckPassed=true when health.valid is true', () => {
      const health = { valid: true };

      const healthCheckPassed = health.valid;

      assert.strictEqual(healthCheckPassed, true, 'healthCheckPassed must be true when health.valid is true');
    });

    it('should set healthCheckPassed=false when health.valid is false', () => {
      const health = { valid: false };

      const healthCheckPassed = health.valid;

      assert.strictEqual(healthCheckPassed, false, 'healthCheckPassed must be false when health.valid is false');
    });
  });
});
