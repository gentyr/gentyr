/**
 * Vault-mappings backup/restore utility.
 *
 * Provides durable storage for vault-mappings.json by backing up known-good
 * state to .claude/state/vault-mappings.backup.json and restoring from it
 * when the primary file is missing or empty.
 *
 * @module lib/vault-mappings
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Back up vault-mappings.json if it has non-empty mappings.
 * @param {string} projectDir
 */
export function backupVaultMappings(projectDir) {
  const src = path.join(projectDir, '.claude', 'vault-mappings.json');
  const dst = path.join(projectDir, '.claude', 'state', 'vault-mappings.backup.json');
  try {
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (data.mappings && Object.keys(data.mappings).length > 0) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch {
    // Source missing or unparseable — no-op
  }
}

/**
 * Restore vault-mappings.json from backup if primary is missing or empty.
 * @param {string} projectDir
 * @returns {boolean} true if restored from backup
 */
export function restoreVaultMappings(projectDir) {
  const src = path.join(projectDir, '.claude', 'vault-mappings.json');
  const backup = path.join(projectDir, '.claude', 'state', 'vault-mappings.backup.json');

  // Check if primary is present with non-empty mappings
  try {
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    if (data.mappings && Object.keys(data.mappings).length > 0) {
      return false; // Primary is fine, nothing to restore
    }
  } catch {
    // Missing or unparseable — proceed to restore
  }

  // Attempt restore from backup
  try {
    const backupData = JSON.parse(fs.readFileSync(backup, 'utf8'));
    if (backupData.mappings && Object.keys(backupData.mappings).length > 0) {
      fs.mkdirSync(path.dirname(src), { recursive: true });
      fs.writeFileSync(src, JSON.stringify(backupData, null, 2), 'utf8');
      return true;
    }
  } catch {
    // No backup or unparseable — nothing to restore
  }

  return false;
}

/**
 * Check if a vault-mappings.json file has empty mappings.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isEmptyMappings(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return !data.mappings || Object.keys(data.mappings).length === 0;
  } catch {
    return true;
  }
}
