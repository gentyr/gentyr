/**
 * Shared spawn environment builder for GENTYR agent processes.
 *
 * Extracts the common `buildSpawnEnv()` pattern used by:
 *   - urgent-task-spawner.js
 *   - session-reviver.js
 *   - stop-continue-hook.js
 *   - revival-daemon.js
 *
 * The hourly-automation.js version wraps this with `ensureCredentials()`
 * via `options.extraEnv` for 1Password-resolved credentials.
 *
 * @module lib/spawn-env
 */

import fs from 'fs';
import path from 'path';

/**
 * Build the environment object for spawning a detached Claude agent.
 *
 * @param {string} agentId - Agent ID for CLAUDE_AGENT_ID env var
 * @param {object} [options]
 * @param {string} [options.projectDir] - Project directory (defaults to CLAUDE_PROJECT_DIR or cwd)
 * @param {object} [options.extraEnv] - Additional env vars to merge (e.g., resolved credentials)
 * @returns {object} Environment object for child_process.spawn
 */
export function buildSpawnEnv(agentId, options = {}) {
  const projectDir = options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Resolve git-wrappers directory (follows symlinks for npm link model)
  const hooksDir = path.join(projectDir, '.claude', 'hooks');
  let guardedPath = process.env.PATH || '/usr/bin:/bin';
  try {
    const realHooks = fs.realpathSync(hooksDir);
    const wrappersDir = path.join(realHooks, 'git-wrappers');
    if (fs.existsSync(path.join(wrappersDir, 'git'))) {
      guardedPath = `${wrappersDir}:${guardedPath}`;
    }
  } catch (err) {
    console.error('[spawn-env] Warning:', err.message);
  }

  const env = {
    ...process.env,
    ...(options.extraEnv || {}),
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_SPAWNED_SESSION: 'true',
    CLAUDE_AGENT_ID: agentId,
    PATH: guardedPath,
  };

  return env;
}
