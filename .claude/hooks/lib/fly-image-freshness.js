/**
 * Fly.io Image Freshness — Shared Module
 *
 * Computes SHA-256 hashes of Fly.io infrastructure files (Dockerfile,
 * remote-runner.sh, fly.toml.template) and compares them against the
 * hashes recorded at deploy time to detect stale images.
 *
 * Also checks project image staleness by comparing the current
 * pnpm-lock.yaml hash against the hash stored at project image deploy
 * time (fly-project-image-metadata.json).
 *
 * Consumed by:
 * - session-briefing.js (SessionStart health line)
 * - hourly-automation.js (periodic staleness check)
 * - packages/mcp-servers/src/playwright/server.ts (inlines the logic
 *   because TS cannot easily import this ESM JS module at runtime)
 *
 * @version 1.1.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Compute SHA-256 hashes of the three Fly.io infrastructure files.
 *
 * @param {string} infraDir - Absolute path to the infra/fly-playwright directory
 * @returns {{ dockerfileHash: string, remoteRunnerHash: string, flyTomlTemplateHash: string }}
 */
export function computeInfraHashes(infraDir) {
  const hashFile = (filePath) => {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  };

  return {
    dockerfileHash: hashFile(path.join(infraDir, 'Dockerfile')),
    remoteRunnerHash: hashFile(path.join(infraDir, 'remote-runner.sh')),
    flyTomlTemplateHash: hashFile(path.join(infraDir, 'fly.toml.template')),
  };
}

/**
 * Resolve the infra/fly-playwright directory.
 * Checks node_modules/gentyr (npm link) first, then local repo.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {string|null} Absolute path to the infra dir, or null if not found
 */
export function resolveInfraDir(projectDir) {
  const candidates = [
    path.join(projectDir, 'node_modules', 'gentyr', 'infra', 'fly-playwright'),
    path.join(projectDir, 'infra', 'fly-playwright'),
  ];
  return candidates.find(d => fs.existsSync(d)) || null;
}

/**
 * Read the image metadata file written by provision-app.sh after deploy.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {object|null} Parsed metadata JSON, or null if not found
 */
export function readImageMetadata(projectDir) {
  const metaPath = path.join(projectDir, '.claude', 'state', 'fly-image-metadata.json');
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
}

/**
 * Full staleness check: reads metadata, computes current hashes, compares.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {{
 *   hasMeta: boolean,
 *   stale: boolean|null,
 *   ageHours: number|undefined,
 *   meta: object|undefined,
 *   changedFiles: { dockerfile: boolean, remoteRunner: boolean, flyTomlTemplate: boolean }|undefined
 * }}
 */
export function checkImageStaleness(projectDir) {
  const meta = readImageMetadata(projectDir);
  if (!meta) return { hasMeta: false, stale: null };

  const infraDir = resolveInfraDir(projectDir);
  if (!infraDir) return { hasMeta: true, stale: null, meta };

  const current = computeInfraHashes(infraDir);
  const changedFiles = {
    dockerfile: current.dockerfileHash !== meta.dockerfileHash,
    remoteRunner: current.remoteRunnerHash !== meta.remoteRunnerHash,
    flyTomlTemplate: current.flyTomlTemplateHash !== meta.flyTomlTemplateHash,
  };
  const stale = changedFiles.dockerfile || changedFiles.remoteRunner;
  const deployedMs = new Date(meta.deployedAt).getTime();
  const ageHours = Math.round((Date.now() - deployedMs) / 3600000);

  return { hasMeta: true, stale, ageHours, meta, changedFiles };
}

/**
 * Read the project image metadata file written by deploy_project_image.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {object|null} Parsed metadata JSON, or null if not found/corrupt
 */
export function readProjectImageMetadata(projectDir) {
  const metaPath = path.join(projectDir, '.claude', 'state', 'fly-project-image-metadata.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Check project image staleness by comparing the current pnpm-lock.yaml
 * hash against the hash stored at project image deploy time.
 *
 * @param {string} projectDir - Absolute path to the project root
 * @returns {{
 *   hasMeta: boolean,
 *   stale: boolean|null,
 *   deploying: boolean,
 *   deployFailed: boolean,
 *   deployPidAlive: boolean|null,
 *   ageHours: number|undefined,
 *   meta: object|undefined,
 *   currentLockfileHash: string|undefined,
 *   storedLockfileHash: string|undefined,
 *   freshnessTier: string,
 * }}
 */
export function checkProjectImageStaleness(projectDir) {
  const meta = readProjectImageMetadata(projectDir);
  if (!meta) {
    return {
      hasMeta: false,
      stale: null,
      deploying: false,
      deployFailed: false,
      deployPidAlive: null,
      freshnessTier: 'missing',
    };
  }

  const deploying = meta.deploying === true;
  const deployFailed = meta.deployFailed === true;

  // Check if deploy PID is alive
  let deployPidAlive = null;
  if (meta.deployPid != null) {
    try {
      process.kill(meta.deployPid, 0);
      deployPidAlive = true;
    } catch {
      deployPidAlive = false;
    }
  }

  // Compute age (independent of lockfile — needed for stuck deploy detection)
  let ageHours;
  if (meta.deployedAt) {
    const deployedMs = new Date(meta.deployedAt).getTime();
    ageHours = Math.round((Date.now() - deployedMs) / 3600000);
  }

  // Compute current lockfile hash
  const lockfilePath = path.join(projectDir, 'pnpm-lock.yaml');
  let currentLockfileHash;
  try {
    const content = fs.readFileSync(lockfilePath);
    currentLockfileHash = crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    // Lockfile missing or unreadable — cannot determine staleness
    let earlyTier = 'fresh';
    if (deployFailed) earlyTier = 'missing';
    else if (deploying) earlyTier = 'deploying';
    return {
      hasMeta: true,
      stale: null,
      deploying,
      deployFailed,
      deployPidAlive,
      ageHours,
      meta,
      currentLockfileHash: undefined,
      storedLockfileHash: meta.lockfileHash,
      freshnessTier: earlyTier,
    };
  }

  const storedLockfileHash = meta.lockfileHash;
  // Project image is always usable when deployed — pnpm handles lockfile delta (~30s)
  const stale = false;

  // Informational tier for logging/briefing — does NOT affect timeouts or fallback behavior
  let freshnessTier = 'fresh';
  if (!meta || deployFailed) freshnessTier = 'missing';
  else if (deploying) freshnessTier = 'deploying';
  else if (storedLockfileHash != null && currentLockfileHash !== storedLockfileHash) {
    freshnessTier = ageHours != null && ageHours < 4 ? 'warm' : 'stale';
  }

  return {
    hasMeta: true,
    stale,
    deploying,
    deployFailed,
    deployPidAlive,
    ageHours,
    meta,
    currentLockfileHash,
    storedLockfileHash,
    freshnessTier,
  };
}
