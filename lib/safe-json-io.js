/**
 * Safe JSON I/O utilities for services.json.
 *
 * Provides atomic writes (tmp+rename) and backup/restore to prevent
 * data loss from interrupted writes or corrupt reads.
 *
 * @module lib/safe-json-io
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Read and parse a JSON file safely.
 * - Returns null on ENOENT (file does not exist)
 * - On empty/corrupt file: attempts restore from backup, throws if restore fails
 * - On other errors (EACCES, etc.): throws as-is
 *
 * @param {string} filePath - Path to the JSON file
 * @param {object} [opts]
 * @param {string} [opts.backupPath] - Path to backup file for restore attempt
 * @returns {object|null} Parsed data, or null if file does not exist
 */
export function safeReadJson(filePath, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  try {
    const data = JSON.parse(raw);
    if (data === null || typeof data !== 'object') {
      throw new SyntaxError('Parsed value is not an object');
    }
    return data;
  } catch (parseErr) {
    // File exists but is empty or corrupt — attempt backup restore
    if (opts.backupPath) {
      try {
        const backupRaw = fs.readFileSync(opts.backupPath, 'utf-8');
        const backupData = JSON.parse(backupRaw);
        if (backupData && typeof backupData === 'object') {
          // Restore backup to primary (atomic)
          const tmpPath = filePath + '.tmp.' + process.pid;
          fs.writeFileSync(tmpPath, JSON.stringify(backupData, null, 2) + '\n');
          fs.renameSync(tmpPath, filePath);
          return backupData;
        }
      } catch {
        // Backup also unusable — fall through to throw
      }
    }
    throw new Error(
      `${filePath} is empty or corrupt (${parseErr.message}). ` +
      (opts.backupPath ? 'Backup restore also failed. ' : '') +
      'Manual intervention required.',
    );
  }
}

/**
 * Write a JSON file atomically with optional backup.
 *
 * 1. If backupPath provided and current file passes backupValidator, save backup
 * 2. Write to .tmp.{pid} file
 * 3. renameSync to target (atomic on POSIX)
 *
 * @param {string} filePath - Target file path
 * @param {object} data - Data to serialize
 * @param {object} [opts]
 * @param {string} [opts.backupPath] - Path for backup file
 * @param {function} [opts.backupValidator] - Returns true if current data is worth backing up
 */
export function safeWriteJson(filePath, data, opts = {}) {
  // Step 1: backup current file if it has valuable content
  if (opts.backupPath) {
    try {
      const currentRaw = fs.readFileSync(filePath, 'utf-8');
      const currentData = JSON.parse(currentRaw);
      const shouldBackup = opts.backupValidator ? opts.backupValidator(currentData) : true;
      if (shouldBackup) {
        fs.mkdirSync(path.dirname(opts.backupPath), { recursive: true });
        const backupTmp = opts.backupPath + '.tmp.' + process.pid;
        fs.writeFileSync(backupTmp, currentRaw);
        fs.renameSync(backupTmp, opts.backupPath);
      }
    } catch {
      // Current file missing or unparseable — skip backup
    }
  }

  // Step 2: atomic write (tmp+rename), falling back to direct write if directory is read-only
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = JSON.stringify(data, null, 2) + '\n';
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // If tmp file creation fails (e.g. root-owned directory), fall back to direct overwrite.
    // Direct write is not atomic but works when the file itself is writable.
    if (err.code === 'EACCES') {
      try { fs.unlinkSync(tmpPath); } catch { /* may not exist */ }
      fs.writeFileSync(filePath, content);
    } else {
      try { fs.unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
      throw err;
    }
  }
}
