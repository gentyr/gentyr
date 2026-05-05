/**
 * Fly.io Image Freshness — Shared Module
 *
 * Computes SHA-256 hashes of Fly.io infrastructure files (Dockerfile,
 * remote-runner.sh, fly.toml.template) and compares them against the
 * hashes recorded at deploy time to detect stale images.
 *
 * Consumed by:
 * - session-briefing.js (SessionStart health line)
 * - hourly-automation.js (periodic staleness check)
 * - packages/mcp-servers/src/playwright/server.ts (inlines the logic
 *   because TS cannot easily import this ESM JS module at runtime)
 *
 * @version 1.0.0
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
