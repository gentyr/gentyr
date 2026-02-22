/**
 * Sync state management for GENTYR.
 *
 * Manages the .claude/gentyr-state.json file that tracks what version/config
 * was last synced, enabling fast-path detection in the SessionStart hook.
 *
 * @module state
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_FILE = 'gentyr-state.json';

/**
 * @typedef {Object} GentyrState
 * @property {string} version - Framework version at last sync
 * @property {string} configHash - SHA-256 of settings.json.template + .mcp.json.template
 * @property {string} claudeMdHash - SHA-256 of CLAUDE.md.gentyr-section
 * @property {string[]} agentList - List of framework agent filenames
 * @property {number} stateFilesVersion - Schema version for pre-created state files
 * @property {string} lastSync - ISO timestamp of last sync
 * @property {string} installModel - 'npm' or 'legacy'
 */

/**
 * Read the current sync state from a project.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @returns {GentyrState|null} The current state, or null if not found
 */
export function readState(projectDir) {
  const statePath = path.join(projectDir, '.claude', STATE_FILE);
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write sync state to a project.
 *
 * @param {string} projectDir - Absolute path to the target project
 * @param {GentyrState} state - The state to write
 */
export function writeState(projectDir, state) {
  const statePath = path.join(projectDir, '.claude', STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

/**
 * Compute a hash of template files for change detection.
 *
 * @param {string} frameworkDir - Absolute path to the framework directory
 * @returns {string} SHA-256 hex hash of concatenated template contents
 */
export function computeConfigHash(frameworkDir) {
  const files = [
    path.join(frameworkDir, '.claude', 'settings.json.template'),
    path.join(frameworkDir, '.mcp.json.template'),
  ];
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    try {
      hash.update(fs.readFileSync(file, 'utf8'));
    } catch {
      hash.update('');
    }
  }
  return hash.digest('hex');
}

/**
 * Compute a hash of the CLAUDE.md gentyr section template.
 *
 * @param {string} frameworkDir - Absolute path to the framework directory
 * @returns {string} SHA-256 hex hash
 */
export function computeClaudeMdHash(frameworkDir) {
  const sectionPath = path.join(frameworkDir, 'CLAUDE.md.gentyr-section');
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(sectionPath, 'utf8')).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Read the framework version from version.json.
 *
 * @param {string} frameworkDir - Absolute path to the framework directory
 * @returns {string} The version string, or '0.0.0' if not found
 */
export function readFrameworkVersion(frameworkDir) {
  try {
    const vj = JSON.parse(fs.readFileSync(path.join(frameworkDir, 'version.json'), 'utf8'));
    return vj.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Get the list of framework agent filenames.
 *
 * @param {string} frameworkDir - Absolute path to the framework directory
 * @returns {string[]} Array of agent markdown filenames
 */
export function getFrameworkAgents(frameworkDir) {
  const agentsDir = path.join(frameworkDir, '.claude', 'agents');
  try {
    return fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/** Current state files schema version */
export const STATE_FILES_VERSION = 1;

/**
 * Build a complete state object for the current framework.
 *
 * @param {string} frameworkDir - Absolute path to the framework directory
 * @param {string} installModel - 'npm' or 'legacy'
 * @returns {GentyrState}
 */
export function buildState(frameworkDir, installModel) {
  return {
    version: readFrameworkVersion(frameworkDir),
    configHash: computeConfigHash(frameworkDir),
    claudeMdHash: computeClaudeMdHash(frameworkDir),
    agentList: getFrameworkAgents(frameworkDir),
    stateFilesVersion: STATE_FILES_VERSION,
    lastSync: new Date().toISOString(),
    installModel,
  };
}
