/**
 * Fly.io Configuration Helper
 *
 * Shared module for reading and toggling the Fly.io remote Playwright
 * execution configuration stored in services.json.
 *
 * Secret values (apiToken op:// references) are never resolved here —
 * resolution happens in the MCP server context only.
 *
 * @module lib/fly-config
 */

import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Resolve the path to services.json for a given project directory.
 *
 * @param {string} projectDir
 * @returns {string}
 */
function servicesConfigPath(projectDir) {
  return path.join(projectDir, '.claude', 'config', 'services.json');
}

/**
 * Read and parse services.json. Returns null on any error.
 *
 * @param {string} projectDir
 * @returns {object|null}
 */
function readServicesConfig(projectDir) {
  const configPath = servicesConfigPath(projectDir);
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Read Fly.io config from services.json.
 *
 * Returns the `fly` section as a plain object, or null if the file is
 * missing, the `fly` section is absent, or any parse error occurs.
 *
 * @param {string} [projectDir] - Project directory path (defaults to CLAUDE_PROJECT_DIR or cwd)
 * @returns {object|null} Fly config section or null if not configured
 */
export function getFlyConfig(projectDir = PROJECT_DIR) {
  const config = readServicesConfig(projectDir);
  if (!config || typeof config !== 'object') return null;
  if (!config.fly || typeof config.fly !== 'object') return null;
  return config.fly;
}

/**
 * Quick check if Fly.io is configured and enabled.
 *
 * Returns true only when a `fly` section is present in services.json
 * and `fly.enabled` is not explicitly set to false.
 *
 * @param {string} [projectDir]
 * @returns {boolean}
 */
export function isFlyConfigured(projectDir = PROJECT_DIR) {
  const config = getFlyConfig(projectDir);
  return config !== null && config.enabled !== false;
}

/**
 * Toggle the `enabled` flag on the fly config section.
 *
 * Writes directly to services.json when the file is writable. Falls back to
 * staging at `.claude/state/fly-config-pending.json` (read by npx gentyr sync)
 * when the file is root-owned (EACCES). Throws loudly on unexpected errors.
 *
 * @param {string} projectDir
 * @param {boolean} enabled
 * @throws {Error} When services.json cannot be read or fly section is absent
 */
export function setFlyEnabled(projectDir = PROJECT_DIR, enabled) {
  const configPath = servicesConfigPath(projectDir);

  // Read current config — fail loudly if file is missing or unparseable
  let config;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`fly-config: cannot read services.json at ${configPath}: ${err.message}`);
  }

  if (!config.fly || typeof config.fly !== 'object') {
    throw new Error('fly-config: services.json has no fly section — configure it first via update_services_config');
  }

  // Build updated config
  const updated = {
    ...config,
    fly: {
      ...config.fly,
      enabled: Boolean(enabled),
    },
  };

  // Attempt direct write
  try {
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    return;
  } catch (err) {
    if (err.code !== 'EACCES') {
      throw new Error(`fly-config: failed to write services.json: ${err.message}`);
    }
  }

  // Root-owned file — stage the fly.enabled change
  const pendingPath = path.join(projectDir, '.claude', 'state', 'fly-config-pending.json');

  // Merge with any existing staged changes to avoid clobbering unrelated pending updates
  let pending = {};
  try {
    pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  } catch (_) {
    // No existing pending file — start fresh
  }

  const mergedPending = {
    ...pending,
    fly: {
      ...(pending.fly || {}),
      enabled: Boolean(enabled),
    },
  };

  try {
    fs.writeFileSync(pendingPath, JSON.stringify(mergedPending, null, 2) + '\n', 'utf8');
  } catch (writeErr) {
    throw new Error(`fly-config: cannot write staging file at ${pendingPath}: ${writeErr.message}`);
  }
}
