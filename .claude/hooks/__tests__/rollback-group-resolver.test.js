/**
 * Unit tests for resolveRollbackTargets() in auto-rollback.js.
 *
 * Verifies the rollback-cascade resolver introduced by PR 7 (Gap 1):
 *   - A target with no rollbackGroup returns only itself (isolated)
 *   - Targets sharing a group return the full group when any one fails
 *   - Targets in distinct groups stay isolated from each other
 *   - Empty strings and missing groups never match (must be exact string)
 *   - Throws on bad inputs (failingTarget non-object, allTargets non-array)
 *
 * Run with: node --test .claude/hooks/__tests__/rollback-group-resolver.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveRollbackTargets } from '../lib/auto-rollback.js';

const backend = { label: 'backend', rollbackGroup: 'api-contract', platform: 'render', serviceId: 'srv-b' };
const web = { label: 'web', rollbackGroup: 'api-contract', platform: 'vercel', serviceId: 'prj-w' };
const marketing = { label: 'marketing', platform: 'vercel', serviceId: 'prj-m' };
const mobile = { label: 'mobile', rollbackGroup: 'mobile-bundle', platform: 'fly', serviceId: 'app-mob' };

describe('resolveRollbackTargets — isolation', () => {
  it('returns only the failing target when it has no rollbackGroup', () => {
    const result = resolveRollbackTargets(marketing, [backend, web, marketing]);
    assert.deepStrictEqual(result, [marketing]);
  });

  it('returns only the failing target when group is an empty string', () => {
    const t = { label: 'x', rollbackGroup: '', platform: 'render', serviceId: 'srv-x' };
    const result = resolveRollbackTargets(t, [t, backend, web]);
    assert.deepStrictEqual(result, [t]);
  });

  it('treats undefined rollbackGroup as isolated', () => {
    const t = { label: 'y', platform: 'render', serviceId: 'srv-y' };
    assert.deepStrictEqual(resolveRollbackTargets(t, [t, backend]), [t]);
  });
});

describe('resolveRollbackTargets — grouping', () => {
  it('returns all members of a shared group when any one fails', () => {
    const result = resolveRollbackTargets(backend, [backend, web, marketing]);
    // backend + web both in api-contract; marketing isolated
    assert.strictEqual(result.length, 2);
    assert.ok(result.includes(backend));
    assert.ok(result.includes(web));
    assert.ok(!result.includes(marketing));
  });

  it('preserves order from allTargets', () => {
    const result = resolveRollbackTargets(web, [backend, web, marketing]);
    assert.strictEqual(result[0], backend);
    assert.strictEqual(result[1], web);
  });

  it('isolates distinct groups', () => {
    const result = resolveRollbackTargets(mobile, [backend, web, marketing, mobile]);
    // mobile is in mobile-bundle (only one member); backend/web in api-contract (untouched)
    assert.deepStrictEqual(result, [mobile]);
  });

  it('handles a target not strictly present in allTargets (referential copy)', () => {
    const failingCopy = { label: 'backend', rollbackGroup: 'api-contract', platform: 'render', serviceId: 'srv-b' };
    const result = resolveRollbackTargets(failingCopy, [backend, web]);
    // Should still find backend + web by group match, and not double-add the copy
    assert.strictEqual(result.length, 2);
    assert.ok(result.some((t) => t.label === 'backend'));
    assert.ok(result.some((t) => t.label === 'web'));
  });
});

describe('resolveRollbackTargets — input validation', () => {
  it('throws when failingTarget is null', () => {
    assert.throws(() => resolveRollbackTargets(null, []), /failingTarget/);
  });

  it('throws when failingTarget is not an object', () => {
    assert.throws(() => resolveRollbackTargets('backend', []), /failingTarget/);
  });

  it('throws when allTargets is not an array', () => {
    assert.throws(() => resolveRollbackTargets(backend, {}), /allTargets/);
  });
});
