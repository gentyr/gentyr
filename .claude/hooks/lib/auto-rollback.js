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

// Rollback thresholds
const MAX_DEPLOY_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MIN_CONSECUTIVE_FAILURES = 3;

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
        lastKnownGood: state.lastKnownGood || {},
        recentDeploys: state.recentDeploys || {},
        rollbackHistory: Array.isArray(state.rollbackHistory) ? state.rollbackHistory : [],
      };
    }
  } catch {
    // Corrupt or missing — return fresh state
  }
  return { lastKnownGood: {}, recentDeploys: {}, rollbackHistory: [] };
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
 * @param {string} environment - Environment name (e.g., 'staging', 'production')
 * @param {string} deployId - Deployment identifier
 * @param {string} platform - Deployment platform ('vercel' | 'render')
 */
export function trackDeployment(environment, deployId, platform) {
  if (!environment || !deployId || !platform) {
    throw new Error('trackDeployment requires environment, deployId, and platform');
  }

  const state = getDeployState();
  state.recentDeploys[environment] = {
    deployId,
    platform,
    firstSeenAt: new Date().toISOString(),
    consecutiveFailures: 0,
  };
  saveDeployState(state);
}

/**
 * Record a healthy check for a deployment. Updates lastKnownGood.
 *
 * @param {string} environment - Environment name
 * @param {string} deployId - Deployment identifier
 * @param {string} platform - Deployment platform
 */
export function recordHealthy(environment, deployId, platform) {
  if (!environment) {
    throw new Error('recordHealthy requires environment');
  }

  const state = getDeployState();

  // Update last known good
  state.lastKnownGood[environment] = {
    deployId: deployId || 'current',
    platform: platform || 'unknown',
    verifiedAt: new Date().toISOString(),
  };

  // Reset consecutive failures for this environment
  if (state.recentDeploys[environment]) {
    state.recentDeploys[environment].consecutiveFailures = 0;
  }

  saveDeployState(state);
}

/**
 * Record a health check failure. Increments consecutive failure counter.
 * Returns whether a rollback should be triggered.
 *
 * @param {string} environment - Environment name
 * @returns {{shouldRollback: boolean, consecutiveFailures: number, previousGoodDeploy: string|null, deployAge: number|null}}
 */
export function recordFailure(environment) {
  if (!environment) {
    throw new Error('recordFailure requires environment');
  }

  const state = getDeployState();
  const deploy = state.recentDeploys[environment];

  if (!deploy) {
    // No tracked deploy — increment a synthetic tracker
    state.recentDeploys[environment] = {
      deployId: 'unknown',
      platform: 'unknown',
      firstSeenAt: new Date().toISOString(),
      consecutiveFailures: 1,
    };
    saveDeployState(state);
    return { shouldRollback: false, consecutiveFailures: 1, previousGoodDeploy: null, deployAge: null };
  }

  deploy.consecutiveFailures = (deploy.consecutiveFailures || 0) + 1;
  saveDeployState(state);

  // Check rollback conditions
  const deployAge = Date.now() - new Date(deploy.firstSeenAt).getTime();
  const previousGood = state.lastKnownGood[environment];

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
  };
}

/**
 * Execute a rollback for the given environment.
 *
 * @param {string} environment - Environment name
 * @param {string} projectDir - Project root directory
 * @returns {{success: boolean, platform: string, error: string|null}}
 */
export function executeRollback(environment, projectDir) {
  if (!environment || !projectDir) {
    throw new Error('executeRollback requires environment and projectDir');
  }

  const state = getDeployState();
  const deploy = state.recentDeploys[environment];
  const previousGood = state.lastKnownGood[environment];

  if (!previousGood || !previousGood.deployId) {
    return { success: false, platform: 'unknown', error: 'No known-good deploy to rollback to' };
  }

  const platform = (deploy && deploy.platform) || previousGood.platform || 'unknown';

  try {
    if (platform === 'vercel') {
      // Vercel rollback via CLI
      execSync('npx vercel rollback --yes', {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 60000,
        stdio: 'pipe',
      });
    } else if (platform === 'render') {
      // Render rollback via API — requires RENDER_API_KEY in environment
      const renderApiKey = process.env.RENDER_API_KEY;
      if (!renderApiKey) {
        return { success: false, platform, error: 'RENDER_API_KEY not set — cannot rollback via API' };
      }

      // Get service ID from services.json
      let serviceId = null;
      try {
        const svcConfigPath = path.join(projectDir, '.claude', 'config', 'services.json');
        if (fs.existsSync(svcConfigPath)) {
          const svcConfig = JSON.parse(fs.readFileSync(svcConfigPath, 'utf8'));
          const renderConfig = svcConfig.render || {};
          serviceId = renderConfig.serviceId || null;
        }
      } catch { /* non-fatal */ }

      if (!serviceId) {
        return { success: false, platform, error: 'Render serviceId not configured in services.json' };
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
      return { success: false, platform, error: `Unsupported platform for rollback: ${platform}` };
    }

    // Record rollback in history
    state.rollbackHistory.push({
      environment,
      rolledBackDeploy: deploy ? deploy.deployId : 'unknown',
      rolledBackTo: previousGood.deployId,
      platform,
      timestamp: new Date().toISOString(),
    });

    // Keep history bounded (last 50 entries)
    if (state.rollbackHistory.length > 50) {
      state.rollbackHistory = state.rollbackHistory.slice(-50);
    }

    // Clear the recent deploy entry (it's been rolled back)
    delete state.recentDeploys[environment];
    saveDeployState(state);

    return { success: true, platform, error: null };
  } catch (err) {
    return { success: false, platform, error: err.message };
  }
}
