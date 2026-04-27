/**
 * Safe JSON I/O utilities for services.json.
 *
 * Provides atomic writes (tmp+rename) and backup/restore to prevent
 * data loss from interrupted writes or corrupt reads.
 *
 * @module shared/safe-json-io
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface SafeReadOpts {
  backupPath?: string;
}

export interface SafeWriteOpts {
  backupPath?: string;
  backupValidator?: (data: unknown) => boolean;
}

/**
 * Read and parse a JSON file safely.
 * - Returns null on ENOENT (file does not exist)
 * - On empty/corrupt file: attempts restore from backup, throws if restore fails
 * - On other errors (EACCES, etc.): throws as-is
 */
export function safeReadJson<T = Record<string, unknown>>(
  filePath: string,
  opts: SafeReadOpts = {},
): T | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  try {
    const data = JSON.parse(raw);
    if (data === null || typeof data !== 'object') {
      throw new SyntaxError('Parsed value is not an object');
    }
    return data as T;
  } catch (parseErr) {
    // File exists but is empty or corrupt — attempt backup restore
    if (opts.backupPath) {
      try {
        const backupRaw = readFileSync(opts.backupPath, 'utf-8');
        const backupData = JSON.parse(backupRaw);
        if (backupData && typeof backupData === 'object') {
          // Restore backup to primary (atomic)
          const tmpPath = filePath + '.tmp.' + process.pid;
          writeFileSync(tmpPath, JSON.stringify(backupData, null, 2) + '\n');
          renameSync(tmpPath, filePath);
          return backupData as T;
        }
      } catch {
        // Backup also unusable — fall through to throw
      }
    }
    throw new Error(
      `${filePath} is empty or corrupt (${(parseErr as Error).message}). ` +
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
 */
export function safeWriteJson(
  filePath: string,
  data: unknown,
  opts: SafeWriteOpts = {},
): void {
  // Step 1: backup current file if it has valuable content
  if (opts.backupPath) {
    try {
      const currentRaw = readFileSync(filePath, 'utf-8');
      const currentData = JSON.parse(currentRaw);
      const shouldBackup = opts.backupValidator ? opts.backupValidator(currentData) : true;
      if (shouldBackup) {
        mkdirSync(dirname(opts.backupPath), { recursive: true });
        const backupTmp = opts.backupPath + '.tmp.' + process.pid;
        writeFileSync(backupTmp, currentRaw);
        renameSync(backupTmp, opts.backupPath);
      }
    } catch {
      // Current file missing or unparseable — skip backup
    }
  }

  // Step 2: atomic write
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* cleanup best-effort */ }
    throw err;
  }
}
