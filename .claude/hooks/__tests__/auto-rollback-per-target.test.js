/**
 * Unit tests for the per-target state refactor in auto-rollback.js.
 *
 * Verifies:
 *   - getDeployState auto-migrates the legacy env-only single-slot shape into
 *     the per-target shape with `_default` as the target label
 *   - Migration is idempotent (re-reading already-migrated state is a no-op)
 *   - trackDeployment / recordHealthy / recordFailure honor opts.target_label
 *     and write to the correct per-target slot
 *   - A release that updates ONE target does NOT clobber sibling targets'
 *     lastKnownGood entries (this is the core correctness bug Gap 2 fixed)
 *   - executeRollback reads from the right per-target slot when opts.target_label
 *     is passed
 *   - Backward compat: calling the helpers WITHOUT opts (legacy 3-arg form)
 *     writes to the `_default` slot
 *
 * Run with: node --test .claude/hooks/__tests__/auto-rollback-per-target.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir;
let savedEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-auto-rollback-'));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  savedEnv = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedEnv;
});

const writeRawState = (state) => {
  const p = path.join(tmpDir, '.claude', 'state', 'deploy-tracking.json');
  fs.writeFileSync(p, JSON.stringify(state));
};

const readRawState = () => {
  const p = path.join(tmpDir, '.claude', 'state', 'deploy-tracking.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};

// Import fresh on every test so the module's internal STATE_PATH resolves
// against the per-test CLAUDE_PROJECT_DIR. The cache-buster query param
// forces Node to re-evaluate the module.
const freshModule = async () =>
  await import(`../lib/auto-rollback.js?cb=${Date.now()}-${Math.random()}`);

describe('getDeployState auto-migration', () => {
  it('wraps legacy env-only shape under _default', async () => {
    writeRawState({
      lastKnownGood: { production: { deployId: 'dep_legacy', platform: 'render', verifiedAt: '2026-05-01T00:00:00Z' } },
      recentDeploys: { production: { deployId: 'dep_legacy', platform: 'render', firstSeenAt: '2026-05-01T00:00:00Z', consecutiveFailures: 0 } },
      rollbackHistory: [],
    });
    const m = await freshModule();
    const state = m.getDeployState();
    assert.deepStrictEqual(state.lastKnownGood.production._default, {
      deployId: 'dep_legacy',
      platform: 'render',
      verifiedAt: '2026-05-01T00:00:00Z',
    });
    assert.strictEqual(state.recentDeploys.production._default.deployId, 'dep_legacy');
  });

  it('passes through already-migrated per-target shape', async () => {
    writeRawState({
      lastKnownGood: { production: { backend: { deployId: 'dep_b', platform: 'render', verifiedAt: 't' }, web: { deployId: 'dep_w', platform: 'vercel', verifiedAt: 't' } } },
      recentDeploys: {},
      rollbackHistory: [],
    });
    const m = await freshModule();
    const state = m.getDeployState();
    assert.strictEqual(state.lastKnownGood.production.backend.deployId, 'dep_b');
    assert.strictEqual(state.lastKnownGood.production.web.deployId, 'dep_w');
  });

  it('returns empty state when no file exists', async () => {
    const m = await freshModule();
    const state = m.getDeployState();
    assert.deepStrictEqual(state.lastKnownGood, {});
    assert.deepStrictEqual(state.recentDeploys, {});
    assert.deepStrictEqual(state.rollbackHistory, []);
  });
});

describe('trackDeployment / recordHealthy with target_label', () => {
  it('writes to the correct per-target slot', async () => {
    const m = await freshModule();
    m.trackDeployment('production', 'dep_backend_v2', 'render', { target_label: 'backend', serviceId: 'srv-abc' });
    m.trackDeployment('production', 'dep_web_v2', 'vercel', { target_label: 'web', serviceId: 'prj_xyz' });

    const state = m.getDeployState();
    assert.strictEqual(state.recentDeploys.production.backend.deployId, 'dep_backend_v2');
    assert.strictEqual(state.recentDeploys.production.backend.serviceId, 'srv-abc');
    assert.strictEqual(state.recentDeploys.production.web.deployId, 'dep_web_v2');
    assert.strictEqual(state.recentDeploys.production.web.serviceId, 'prj_xyz');
  });

  it('legacy 3-arg call writes to _default slot', async () => {
    const m = await freshModule();
    m.trackDeployment('staging', 'dep_legacy_v1', 'render');
    const state = m.getDeployState();
    assert.strictEqual(state.recentDeploys.staging._default.deployId, 'dep_legacy_v1');
  });

  it('updating ONE target does NOT clobber sibling lastKnownGood', async () => {
    const m = await freshModule();
    // Establish three targets all healthy on v1
    m.recordHealthy('production', 'dep_b_v1', 'render', { target_label: 'backend', serviceId: 'srv-b' });
    m.recordHealthy('production', 'dep_w_v1', 'vercel', { target_label: 'web', serviceId: 'prj-w' });
    m.recordHealthy('production', 'dep_m_v1', 'vercel', { target_label: 'marketing', serviceId: 'prj-m' });
    // New release updates only backend
    m.recordHealthy('production', 'dep_b_v2', 'render', { target_label: 'backend', serviceId: 'srv-b' });
    const state = m.getDeployState();
    assert.strictEqual(state.lastKnownGood.production.backend.deployId, 'dep_b_v2', 'backend should be v2');
    assert.strictEqual(state.lastKnownGood.production.web.deployId, 'dep_w_v1', 'web should still be v1');
    assert.strictEqual(state.lastKnownGood.production.marketing.deployId, 'dep_m_v1', 'marketing should still be v1');
  });
});

describe('recordFailure per-target', () => {
  it('increments consecutive failures only for the named target', async () => {
    const m = await freshModule();
    m.trackDeployment('production', 'dep_b', 'render', { target_label: 'backend' });
    m.trackDeployment('production', 'dep_w', 'vercel', { target_label: 'web' });
    m.recordFailure('production', { target_label: 'backend' });
    m.recordFailure('production', { target_label: 'backend' });
    const state = m.getDeployState();
    assert.strictEqual(state.recentDeploys.production.backend.consecutiveFailures, 2);
    assert.strictEqual(state.recentDeploys.production.web.consecutiveFailures, 0);
  });

  it('returns target_label in the result', async () => {
    const m = await freshModule();
    const result = m.recordFailure('production', { target_label: 'web' });
    assert.strictEqual(result.target_label, 'web');
  });
});

describe('executeRollback per-target', () => {
  it('reads from the target-specific lastKnownGood slot', async () => {
    const m = await freshModule();
    // Set up known-good for backend AND web, then a new failing backend deploy
    m.recordHealthy('production', 'dep_b_v1', 'render', { target_label: 'backend', serviceId: 'srv-b' });
    m.recordHealthy('production', 'dep_w_v1', 'vercel', { target_label: 'web', serviceId: 'prj-w' });
    m.trackDeployment('production', 'dep_b_v2_bad', 'render', { target_label: 'backend', serviceId: 'srv-b' });

    // executeRollback with NO RENDER_API_KEY returns a structured error rather
    // than calling the API. We use that to verify the target lookup was correct.
    const savedKey = process.env.RENDER_API_KEY;
    delete process.env.RENDER_API_KEY;
    try {
      const result = m.executeRollback('production', tmpDir, { target_label: 'backend', platform: 'render', serviceId: 'srv-b' });
      assert.strictEqual(result.success, false);
      assert.match(result.error, /RENDER_API_KEY/);
      assert.strictEqual(result.target_label, 'backend');
      // Sibling target's state untouched
      const state = m.getDeployState();
      assert.strictEqual(state.lastKnownGood.production.web.deployId, 'dep_w_v1');
    } finally {
      if (savedKey === undefined) delete process.env.RENDER_API_KEY;
      else process.env.RENDER_API_KEY = savedKey;
    }
  });

  it('returns success:false with structured error when no known-good slot exists', async () => {
    const m = await freshModule();
    const result = m.executeRollback('production', tmpDir, { target_label: 'backend' });
    assert.strictEqual(result.success, false);
    assert.match(result.error, /No known-good deploy/);
    assert.strictEqual(result.target_label, 'backend');
  });
});
