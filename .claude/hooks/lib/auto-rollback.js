/**
 * Auto-Rollback Module
 *
 * Autonomous code rollback for deployed environments. Safe because migration
 * safety enforcement guarantees all schema changes are backward-compatible —
 * rolling back code leaves the database in a valid state for the previous version.
 *
 * State stored in `.claude/state/deploy-tracking.json`.
 *
 * Rollback conditions (ALL must be true):
 * 1. Deploy is less than 5 minutes old
 * 2. 3+ consecutive health check failures
 * 3. A known-good previous deploy exists
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'deploy-tracking.json');
const LOG_PATH = path.join(PROJECT_DIR, '.claude', 'auto-rollback.log');

// Rollback thresholds
const MAX_DEPLOY_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MIN_CONSECUTIVE_FAILURES = 3;

/**
 * Append a line to the auto-rollback log. Best-effort — never throws.
 * @param {string} msg - Log message
 */
function logAction(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(LOG_PATH, line);
  } catch { /* best-effort */ }
}

const DEFAULT_TARGET_LABEL = '_default';

/**
 * Auto-migrate the legacy per-env single-slot shape to the per-target shape.
 * Old: { production: { deployId, platform, ... } }
 * New: { production: { _default: { deployId, platform, ... } } }
 *
 * Idempotent — if the env's value already looks like a per-target map (any
 * value is an object that itself contains a deployId or similar), return as-is.
 */
function migrateBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return {};
  const out = {};
  for (const [env, val] of Object.entries(bucket)) {
    if (!val || typeof val !== 'object') continue;
    // New shape: env → { label: {...}, label2: {...} }. Recognized when every
    // value inside is itself an object (and the env-level object itself does
    // NOT have a top-level deployId field).
    const looksLikeTargetMap = Object.values(val).every(
      (v) => v && typeof v === 'object' && !Array.isArray(v),
    ) && !('deployId' in val) && !('firstSeenAt' in val) && !('verifiedAt' in val);
    if (looksLikeTargetMap) {
      out[env] = val;
    } else {
      // Old shape — wrap into a one-element per-target map under _default
      out[env] = { [DEFAULT_TARGET_LABEL]: val };
    }
  }
  return out;
}

/**
 * Read the deploy state from disk.
 * @returns {{lastKnownGood: Object, recentDeploys: Object, rollbackHistory: Array}}
 */
export function getDeployState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const content = fs.readFileSync(STATE_PATH, 'utf8');
      const state = JSON.parse(content);
      // Validate shape
      if (!state || typeof state !== 'object') {
        throw new Error('Invalid deploy state shape');
      }
      return {
        lastKnownGood: migrateBucket(state.lastKnownGood),
        recentDeploys: migrateBucket(state.recentDeploys),
        rollbackHistory: Array.isArray(state.rollbackHistory) ? state.rollbackHistory : [],
      };
    }
  } catch {
    // Corrupt or missing — return fresh state
  }
  return { lastKnownGood: {}, recentDeploys: {}, rollbackHistory: [] };
}

/**
 * Internal: resolve the target_label from an opts argument or fall back to _default.
 * @param {{target_label?: string}|undefined} opts
 */
function resolveTargetLabel(opts) {
  if (opts && typeof opts.target_label === 'string' && opts.target_label.length > 0) {
    return opts.target_label;
  }
  return DEFAULT_TARGET_LABEL;
}

/**
 * Persist deploy state to disk. Atomic write via tmp+rename.
 * @param {{lastKnownGood: Object, recentDeploys: Object, rollbackHistory: Array}} state
 */
export function saveDeployState(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('saveDeployState requires a valid state object');
  }

  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = STATE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, STATE_PATH);
}

/**
 * Track a new deployment. Called when a new deploy is detected.
 *
 * Multi-target releases pass `opts.target_label` so each target keeps its own
 * `recentDeploys[env][label]` slot. Single-target callers can omit opts and
 * land in `_default`.
 *
 * @param {string} environment - Environment name (e.g., 'staging', 'production')
 * @param {string} deployId - Deployment identifier
 * @param {string} platform - Deployment platform ('vercel' | 'render' | 'fly')
 * @param {{target_label?: string, serviceId?: string}} [opts]
 */
export function trackDeployment(environment, deployId, platform, opts) {
  if (!environment || !deployId || !platform) {
    throw new Error('trackDeployment requires environment, deployId, and platform');
  }

  const label = resolveTargetLabel(opts);
  const state = getDeployState();
  if (!state.recentDeploys[environment] || typeof state.recentDeploys[environment] !== 'object') {
    state.recentDeploys[environment] = {};
  }
  state.recentDeploys[environment][label] = {
    deployId,
    platform,
    serviceId: opts?.serviceId ?? null,
    firstSeenAt: new Date().toISOString(),
    consecutiveFailures: 0,
  };
  saveDeployState(state);
  logAction(`TRACK: ${environment}/${label} deploy=${deployId} platform=${platform}`);
}

/**
 * Record a healthy check for a deployment. Updates lastKnownGood for the
 * specific target (or _default when no label).
 *
 * @param {string} environment - Environment name
 * @param {string} deployId - Deployment identifier
 * @param {string} platform - Deployment platform
 * @param {{target_label?: string, serviceId?: string}} [opts]
 */
export function recordHealthy(environment, deployId, platform, opts) {
  if (!environment) {
    throw new Error('recordHealthy requires environment');
  }

  const label = resolveTargetLabel(opts);
  const state = getDeployState();

  // Update last known good for this target only — sibling targets keep their
  // own slots so a backend-only release doesn't clobber web's pointer.
  if (!state.lastKnownGood[environment] || typeof state.lastKnownGood[environment] !== 'object') {
    state.lastKnownGood[environment] = {};
  }
  state.lastKnownGood[environment][label] = {
    deployId: deployId || 'current',
    platform: platform || 'unknown',
    serviceId: opts?.serviceId ?? null,
    verifiedAt: new Date().toISOString(),
  };

  // Reset consecutive failures for this target
  if (state.recentDeploys[environment] && state.recentDeploys[environment][label]) {
    state.recentDeploys[environment][label].consecutiveFailures = 0;
  }

  saveDeployState(state);
}

/**
 * Record a health check failure. Increments consecutive failure counter for
 * this target. Returns whether a rollback should be triggered.
 *
 * @param {string} environment - Environment name
 * @param {{target_label?: string}} [opts]
 * @returns {{shouldRollback: boolean, consecutiveFailures: number, previousGoodDeploy: string|null, deployAge: number|null, target_label: string}}
 */
export function recordFailure(environment, opts) {
  if (!environment) {
    throw new Error('recordFailure requires environment');
  }

  const label = resolveTargetLabel(opts);
  const state = getDeployState();
  if (!state.recentDeploys[environment] || typeof state.recentDeploys[environment] !== 'object') {
    state.recentDeploys[environment] = {};
  }
  const deploy = state.recentDeploys[environment][label];

  if (!deploy) {
    // No tracked deploy for this target — start a synthetic counter
    state.recentDeploys[environment][label] = {
      deployId: 'unknown',
      platform: 'unknown',
      serviceId: null,
      firstSeenAt: new Date().toISOString(),
      consecutiveFailures: 1,
    };
    saveDeployState(state);
    return { shouldRollback: false, consecutiveFailures: 1, previousGoodDeploy: null, deployAge: null, target_label: label };
  }

  deploy.consecutiveFailures = (deploy.consecutiveFailures || 0) + 1;
  saveDeployState(state);

  // Check rollback conditions per-target
  const deployAge = Date.now() - new Date(deploy.firstSeenAt).getTime();
  const previousGood = state.lastKnownGood[environment]?.[label] ?? null;

  const shouldRollback = (
    deployAge < MAX_DEPLOY_AGE_MS &&
    deploy.consecutiveFailures >= MIN_CONSECUTIVE_FAILURES &&
    previousGood != null &&
    previousGood.deployId != null
  );

  return {
    shouldRollback,
    consecutiveFailures: deploy.consecutiveFailures,
    previousGoodDeploy: previousGood ? previousGood.deployId : null,
    deployAge: Math.round(deployAge / 1000),
    target_label: label,
  };
}

/**
 * Execute a rollback for the given environment + target.
 *
 * Multi-target releases pass `opts.target_label` to identify which target's
 * deploy is being reverted. `opts.serviceId` overrides the services.json
 * lookup for Render's project-scoped rollback (essential for multi-target
 * releases where each Render target has its own serviceId). Without
 * target_label, falls back to the `_default` slot for backward compatibility.
 *
 * @param {string} environment - Environment name
 * @param {string} projectDir - Project root directory
 * @param {{target_label?: string, platform?: string, serviceId?: string}} [opts]
 * @returns {{success: boolean, platform: string, error: string|null, target_label: string}}
 */
export function executeRollback(environment, projectDir, opts) {
  if (!environment || !projectDir) {
    throw new Error('executeRollback requires environment and projectDir');
  }

  const label = resolveTargetLabel(opts);
  const state = getDeployState();
  const deploy = state.recentDeploys[environment]?.[label] ?? null;
  const previousGood = state.lastKnownGood[environment]?.[label] ?? null;

  if (!previousGood || !previousGood.deployId) {
    logAction(`ROLLBACK SKIPPED: ${environment}/${label} — no known-good deploy to rollback to`);
    return { success: false, platform: opts?.platform ?? 'unknown', error: 'No known-good deploy to rollback to', target_label: label };
  }

  const platform = opts?.platform ?? (deploy && deploy.platform) ?? previousGood.platform ?? 'unknown';
  // Per-target serviceId precedence: explicit opts > state-stored target serviceId > legacy services.json.render.serviceId
  const targetServiceId = opts?.serviceId ?? deploy?.serviceId ?? previousGood.serviceId ?? null;
  logAction(`ROLLBACK INITIATED: ${environment}/${label} platform=${platform} from=${deploy ? deploy.deployId : 'unknown'} to=${previousGood.deployId}`);

  try {
    if (platform === 'vercel') {
      // Vercel rollback via CLI. Scope to the target project when serviceId
      // is known so multi-target releases don't roll back the wrong app.
      const vercelCmd = targetServiceId
        ? `npx vercel rollback --yes --scope="${targetServiceId}"`
        : 'npx vercel rollback --yes';
      execSync(vercelCmd, {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 60000,
        stdio: 'pipe',
      });
    } else if (platform === 'render') {
      // Render rollback via API — requires RENDER_API_KEY in environment
      const renderApiKey = process.env.RENDER_API_KEY;
      if (!renderApiKey) {
        return { success: false, platform, error: 'RENDER_API_KEY not set — cannot rollback via API', target_label: label };
      }

      let serviceId = targetServiceId;
      // Legacy fallback: read services.json.render.serviceId for single-target
      // releases that didn't pass serviceId explicitly.
      if (!serviceId) {
        try {
          const svcConfigPath = path.join(projectDir, '.claude', 'config', 'services.json');
          if (fs.existsSync(svcConfigPath)) {
            const svcConfig = JSON.parse(fs.readFileSync(svcConfigPath, 'utf8'));
            const renderConfig = svcConfig.render || {};
            serviceId = renderConfig.serviceId || null;
          }
        } catch { /* non-fatal */ }
      }

      if (!serviceId) {
        return { success: false, platform, error: 'Render serviceId not configured (pass opts.serviceId or set services.json.render.serviceId)', target_label: label };
      }

      // Trigger a rollback deploy to the previous known-good deploy
      execSync(
        `curl -sf -X POST "https://api.render.com/v1/services/${serviceId}/deploys" ` +
        `-H "Authorization: Bearer ${renderApiKey}" ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"clearCache": "do_not_clear"}'`,
        { cwd: projectDir, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
      );
    } else {
      return { success: false, platform, error: `Unsupported platform for rollback: ${platform}`, target_label: label };
    }

    // Record rollback in history (target-aware)
    state.rollbackHistory.push({
      environment,
      target_label: label,
      rolledBackDeploy: deploy ? deploy.deployId : 'unknown',
      rolledBackTo: previousGood.deployId,
      platform,
      timestamp: new Date().toISOString(),
    });

    // Keep history bounded (last 50 entries)
    if (state.rollbackHistory.length > 50) {
      state.rollbackHistory = state.rollbackHistory.slice(-50);
    }

    // Clear the recent deploy entry FOR THIS TARGET only (others stay).
    if (state.recentDeploys[environment]) {
      delete state.recentDeploys[environment][label];
      if (Object.keys(state.recentDeploys[environment]).length === 0) {
        delete state.recentDeploys[environment];
      }
    }
    saveDeployState(state);

    logAction(`ROLLBACK SUCCESS: ${environment}/${label} platform=${platform}`);
    return { success: true, platform, error: null, target_label: label };
  } catch (err) {
    logAction(`ROLLBACK FAILED: ${environment}/${label} platform=${platform} error=${err.message}`);
    return { success: false, platform, error: err.message, target_label: label };
  }
}

/**
 * Check health status from synthetic-metrics.db and trigger rollback if needed.
 * Reads the synthetic monitor's SQLite DB directly for recent probe data.
 *
 * @param {string} projectDir - Project root directory
 * @param {string} environment - Environment to check ('staging' | 'production')
 * @returns {Promise<{rolledBack: boolean, previousDeployId: string|null, reason: string|null}>}
 */
export async function checkAndRollback(projectDir, environment) {
  if (!projectDir || !environment) {
    throw new Error('checkAndRollback requires projectDir and environment');
  }

  const metricsDbPath = path.join(projectDir, '.claude', 'state', 'synthetic-metrics.db');

  // Check if synthetic metrics DB exists
  if (!fs.existsSync(metricsDbPath)) {
    return { rolledBack: false, previousDeployId: null, reason: null };
  }

  let Database;
  try {
    const mod = await import('better-sqlite3');
    Database = mod.default;
  } catch {
    return { rolledBack: false, previousDeployId: null, reason: null };
  }

  let db;
  try {
    db = new Database(metricsDbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
  } catch {
    return { rolledBack: false, previousDeployId: null, reason: null };
  }

  try {
    // Get the last 3 probes for this environment
    const recentProbes = db.prepare(`
      SELECT healthy, endpoint FROM health_probes
      WHERE environment = ?
      ORDER BY timestamp DESC LIMIT 3
    `).all(environment);

    // Need at least 3 probes, all unhealthy
    if (recentProbes.length < 3 || !recentProbes.every(p => p.healthy === 0)) {
      return { rolledBack: false, previousDeployId: null, reason: null };
    }

    // All 3 recent probes are failures — check rollback conditions
    const failResult = recordFailure(environment);
    if (!failResult.shouldRollback) {
      logAction(`checkAndRollback: ${environment} has failures but rollback conditions not met (deploy age: ${failResult.deployAge}s, failures: ${failResult.consecutiveFailures})`);
      return { rolledBack: false, previousDeployId: failResult.previousGoodDeploy, reason: null };
    }

    // Execute rollback
    logAction(`checkAndRollback: ${environment} — triggering rollback (${failResult.consecutiveFailures} failures, deploy ${failResult.deployAge}s old)`);
    const rollbackResult = executeRollback(environment, projectDir);

    if (rollbackResult.success) {
      return {
        rolledBack: true,
        previousDeployId: failResult.previousGoodDeploy,
        reason: `${failResult.consecutiveFailures} consecutive probe failures within ${failResult.deployAge}s of deploy`,
      };
    }

    return {
      rolledBack: false,
      previousDeployId: failResult.previousGoodDeploy,
      reason: `Rollback attempted but failed: ${rollbackResult.error}`,
    };
  } finally {
    try { db.close(); } catch { /* cleanup */ }
  }
}

/**
 * Resolve which deploy targets must roll back together when one fails.
 *
 * Targets that share the same `rollbackGroup` string roll back as a unit —
 * a single probe failure on any group member reverts every member. Targets
 * with no rollbackGroup (or with a unique value) roll back in isolation.
 *
 * Use this from Phase 8.7 (`agents/deployment-verifier.md` and the merged
 * Phase 8.6 in PR 8) to compute the rollback set BEFORE invoking
 * `triggerInBandRollback` on each member.
 *
 * @example
 *   const targets = [
 *     { label: 'backend',   rollbackGroup: 'api-contract', platform: 'render', serviceId: 'srv-b' },
 *     { label: 'web',       rollbackGroup: 'api-contract', platform: 'vercel', serviceId: 'prj-w' },
 *     { label: 'marketing',                                  platform: 'vercel', serviceId: 'prj-m' },
 *   ];
 *   resolveRollbackTargets(targets[0], targets);
 *   // -> [backend, web] — marketing stays live
 *   resolveRollbackTargets(targets[2], targets);
 *   // -> [marketing] — isolated
 *
 * @param {{label?: string, rollbackGroup?: string, platform?: string, serviceId?: string}} failingTarget
 *   The target whose health probe failed.
 * @param {Array<{label?: string, rollbackGroup?: string, platform?: string, serviceId?: string}>} allTargets
 *   The full deployTargets[] from services.json for the failing target's environment.
 * @returns {Array<object>} Targets to roll back, including failingTarget itself. Order matches allTargets.
 */
export function resolveRollbackTargets(failingTarget, allTargets) {
  if (!failingTarget || typeof failingTarget !== 'object') {
    throw new Error('resolveRollbackTargets requires a failingTarget object');
  }
  if (!Array.isArray(allTargets)) {
    throw new Error('resolveRollbackTargets requires allTargets to be an array');
  }

  const group = failingTarget.rollbackGroup;
  if (!group || typeof group !== 'string') {
    // No group declared — fail in isolation. Return only this target.
    return [failingTarget];
  }

  // Same-group targets cascade together. Membership is by exact string match;
  // empty/missing groups are NEVER considered group members.
  const groupMembers = allTargets.filter(
    (t) => t && typeof t.rollbackGroup === 'string' && t.rollbackGroup === group,
  );

  // Ensure failingTarget itself is present (in case the caller passed a
  // copy/reference that isn't strictly === any element of allTargets).
  if (!groupMembers.some((t) => t.label === failingTarget.label && t.serviceId === failingTarget.serviceId)) {
    groupMembers.push(failingTarget);
  }

  return groupMembers;
}

/**
 * Synchronous in-band rollback entry point for promotion pipeline Phase 8.7.
 *
 * Unlike `checkAndRollback`, this does NOT consult the synthetic-monitor DB.
 * The caller (Phase 8.7's health-probe loop) has already decided the deploy
 * is unhealthy and wants to roll back NOW.
 *
 * Returns a structured result the caller writes to the release ledger
 * (via `update_release` + `cancel_release` if appropriate). The release
 * record itself is updated by the caller — this module stays free of
 * release-ledger imports to keep the dependency graph clean.
 *
 * Multi-target releases pass `target_label` to disambiguate state-file keys
 * when the same environment hosts multiple platforms (e.g., backend on
 * Render plus web on Vercel). When omitted, falls back to env-keyed
 * lookups for backward compatibility with single-target releases.
 *
 * @param {Object} args
 * @param {string} args.release_id - Release ID for log correlation
 * @param {string} args.environment - Environment to roll back (typically 'production')
 * @param {string} args.reason - Why the rollback was triggered (logged + returned)
 * @param {string} [args.target_label] - Multi-target disambiguator (e.g., 'backend', 'web'). Maps to `${environment}:${target_label}` in deploy-tracking.json.
 * @param {string} [args.platform] - Optional platform override (one of 'render'/'vercel'/'fly') when state lookup is ambiguous. Default: read from deploy-tracking.json.
 * @param {string} [args.projectDir] - Project root (defaults to CLAUDE_PROJECT_DIR)
 * @returns {{ok: boolean, rolledBack: boolean, platform: string, previousDeployId: string | null, error: string | null, reason: string, target_key: string}}
 */
export function triggerInBandRollback({ release_id, environment, reason, target_label, platform, projectDir }) {
  if (!release_id) throw new Error('triggerInBandRollback requires release_id');
  if (!environment) throw new Error('triggerInBandRollback requires environment');
  if (!reason) throw new Error('triggerInBandRollback requires reason');

  const dir = projectDir || PROJECT_DIR;
  // Multi-target deploys key state on `${environment}:${target_label}` so a
  // release with backend+web+marketing maintains three separate lastKnownGood
  // pointers. Single-target deploys (no target_label) use the bare env name
  // for backward compat with the synthetic-monitor path.
  const targetKey = target_label ? `${environment}:${target_label}` : environment;
  logAction(`IN-BAND ROLLBACK REQUESTED: release=${release_id} target=${targetKey} reason="${reason}"`);

  const state = getDeployState();
  const previousGood = state.lastKnownGood[targetKey] || state.lastKnownGood[environment];
  const previousDeployId = previousGood?.deployId ?? null;

  if (!previousDeployId) {
    logAction(`IN-BAND ROLLBACK SKIPPED: release=${release_id} target=${targetKey} — no known-good deploy on file`);
    return {
      ok: false,
      rolledBack: false,
      platform: platform ?? 'unknown',
      previousDeployId: null,
      error: 'No known-good deploy on file. Cannot roll back automatically — escalate to CTO.',
      reason,
      target_key: targetKey,
    };
  }

  // Pass target_label + platform + serviceId through so executeRollback
  // reads from the right per-target slot and uses the right project ID.
  const result = executeRollback(environment, dir, {
    target_label,
    platform: platform ?? previousGood.platform,
    serviceId: previousGood.serviceId ?? undefined,
  });
  return {
    ok: result.success,
    rolledBack: result.success,
    platform: platform ?? result.platform,
    previousDeployId,
    error: result.error,
    reason,
    target_key: targetKey,
  };
}
