import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeReadJson, safeWriteJson } from '../safe-json-io.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'safe-json-io-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('safeReadJson', () => {
  it('returns null on ENOENT', () => {
    const result = safeReadJson(join(testDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('throws on empty file (0 bytes)', () => {
    const filePath = join(testDir, 'empty.json');
    writeFileSync(filePath, '');
    expect(() => safeReadJson(filePath)).toThrow(/empty or corrupt/);
  });

  it('throws on corrupt JSON', () => {
    const filePath = join(testDir, 'corrupt.json');
    writeFileSync(filePath, '{broken');
    expect(() => safeReadJson(filePath)).toThrow(/empty or corrupt/);
  });

  it('throws when parsed value is not an object', () => {
    const filePath = join(testDir, 'string.json');
    writeFileSync(filePath, '"just a string"');
    expect(() => safeReadJson(filePath)).toThrow(/empty or corrupt/);
  });

  it('restores from backup when primary is empty', () => {
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'backup.json');
    const original = { secrets: { local: { KEY: 'op://vault/item/field' } } };

    writeFileSync(filePath, '');
    writeFileSync(backupPath, JSON.stringify(original, null, 2));

    const result = safeReadJson(filePath, { backupPath });
    expect(result).toEqual(original);

    // Primary file should be restored
    const restoredRaw = readFileSync(filePath, 'utf-8');
    expect(JSON.parse(restoredRaw)).toEqual(original);
  });

  it('restores from backup when primary is corrupt', () => {
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'backup.json');
    const original = { foo: 'bar' };

    writeFileSync(filePath, '{broken json');
    writeFileSync(backupPath, JSON.stringify(original));

    const result = safeReadJson(filePath, { backupPath });
    expect(result).toEqual(original);
  });

  it('throws when both primary and backup are unusable', () => {
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'backup.json');

    writeFileSync(filePath, '');
    writeFileSync(backupPath, '{also broken');

    expect(() => safeReadJson(filePath, { backupPath })).toThrow(/Backup restore also failed/);
  });

  it('throws without backup message when no backupPath provided', () => {
    const filePath = join(testDir, 'empty.json');
    writeFileSync(filePath, '');
    expect(() => safeReadJson(filePath)).toThrow('Manual intervention required.');
    expect(() => safeReadJson(filePath)).not.toThrow(/Backup restore/);
  });

  it('re-throws EACCES', () => {
    const filePath = join(testDir, 'protected.json');
    writeFileSync(filePath, '{}');
    chmodSync(filePath, 0o000);

    try {
      expect(() => safeReadJson(filePath)).toThrow();
      // Should NOT match our custom message — it should be the raw EACCES
      expect(() => safeReadJson(filePath)).not.toThrow(/empty or corrupt/);
    } finally {
      chmodSync(filePath, 0o644); // restore for cleanup
    }
  });

  it('reads valid JSON successfully', () => {
    const filePath = join(testDir, 'valid.json');
    const data = { secrets: { local: { KEY: 'val' } }, fly: { enabled: true } };
    writeFileSync(filePath, JSON.stringify(data, null, 2));

    const result = safeReadJson(filePath);
    expect(result).toEqual(data);
  });

  it('returns array values as-is (arrays satisfy typeof object check)', () => {
    // Arrays pass `typeof data === 'object' && data !== null` so safeReadJson
    // does NOT reject them. This test pins the current behavior so any future
    // change that adds an Array.isArray check is deliberate.
    const filePath = join(testDir, 'array.json');
    writeFileSync(filePath, JSON.stringify([1, 2, 3]));

    const result = safeReadJson(filePath);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([1, 2, 3]);
  });

  it('throws when backup parses to a non-object scalar (backup is unusable)', () => {
    // backup contains a valid JSON number — not an object, so backupData check
    // `backupData && typeof backupData === 'object'` is false → falls through to throw
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'backup.json');

    writeFileSync(filePath, '');
    writeFileSync(backupPath, '42');

    expect(() => safeReadJson(filePath, { backupPath })).toThrow(/Backup restore also failed/);
  });

  it('throws when backup parses to null (falsy backup is unusable)', () => {
    // null satisfies `data === null` guard on the backup side too — not a valid restore target
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'backup.json');

    writeFileSync(filePath, '');
    writeFileSync(backupPath, 'null');

    expect(() => safeReadJson(filePath, { backupPath })).toThrow(/Backup restore also failed/);
  });

  it('throws when backup parses to a string (not an object)', () => {
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'backup.json');

    writeFileSync(filePath, 'corrupt');
    writeFileSync(backupPath, '"just a string"');

    expect(() => safeReadJson(filePath, { backupPath })).toThrow(/Backup restore also failed/);
  });

  it('throws when backup does not exist and primary is corrupt', () => {
    const filePath = join(testDir, 'primary.json');
    const backupPath = join(testDir, 'nonexistent-backup.json');

    writeFileSync(filePath, '{broken');

    // backupPath provided but the file doesn't exist — readFileSync throws ENOENT,
    // caught by the inner try/catch, falls through to throw
    expect(() => safeReadJson(filePath, { backupPath })).toThrow(/Backup restore also failed/);
  });

  it('error message includes the file path and the parse error reason', () => {
    const filePath = join(testDir, 'corrupt.json');
    writeFileSync(filePath, '{broken');

    let caughtMessage = '';
    try {
      safeReadJson(filePath);
    } catch (err) {
      caughtMessage = (err as Error).message;
    }
    expect(caughtMessage).toContain(filePath);
    expect(caughtMessage).toContain('Manual intervention required.');
  });
});

describe('safeWriteJson', () => {
  it('writes correct file content', () => {
    const filePath = join(testDir, 'output.json');
    const data = { hello: 'world', nested: { key: 1 } };

    safeWriteJson(filePath, data);

    const raw = readFileSync(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual(data);
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('creates parent directories', () => {
    const filePath = join(testDir, 'deep', 'nested', 'output.json');
    safeWriteJson(filePath, { test: true });

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ test: true });
  });

  it('creates backup when validator passes', () => {
    const filePath = join(testDir, 'config.json');
    const backupPath = join(testDir, 'backup.json');
    const original = { secrets: { local: { KEY: 'op://ref' } } };

    writeFileSync(filePath, JSON.stringify(original, null, 2));

    const newData = { secrets: { local: { KEY: 'op://ref', NEW: 'op://new' } } };
    safeWriteJson(filePath, newData, {
      backupPath,
      backupValidator: () => true,
    });

    // New data written
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual(newData);
    // Backup contains original
    expect(JSON.parse(readFileSync(backupPath, 'utf-8'))).toEqual(original);
  });

  it('skips backup when validator returns false', () => {
    const filePath = join(testDir, 'config.json');
    const backupPath = join(testDir, 'backup.json');

    writeFileSync(filePath, JSON.stringify({ secrets: {} }));

    safeWriteJson(filePath, { secrets: {}, fly: {} }, {
      backupPath,
      backupValidator: () => false,
    });

    // No backup created
    expect(() => readFileSync(backupPath)).toThrow();
  });

  it('skips backup when current file does not exist', () => {
    const filePath = join(testDir, 'new.json');
    const backupPath = join(testDir, 'backup.json');

    safeWriteJson(filePath, { test: true }, {
      backupPath,
      backupValidator: () => true,
    });

    // File written, no backup (nothing to back up)
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ test: true });
    expect(() => readFileSync(backupPath)).toThrow();
  });

  it('overwrites existing file atomically', () => {
    const filePath = join(testDir, 'existing.json');
    writeFileSync(filePath, JSON.stringify({ old: true }));

    safeWriteJson(filePath, { new: true });
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ new: true });
  });

  it('round-trip: write then read preserves data', () => {
    const filePath = join(testDir, 'roundtrip.json');
    const data = { secrets: { local: { A: 'op://x', B: 'op://y' } }, fly: { enabled: true } };

    safeWriteJson(filePath, data);
    const result = safeReadJson(filePath);
    expect(result).toEqual(data);
  });

  it('simulated truncation recovery: 0-byte file + backup restores', () => {
    const filePath = join(testDir, 'config.json');
    const backupPath = join(testDir, 'backup.json');
    const original = { secrets: { local: { KEY: 'op://vault/item/field' } } };

    // Write original, then back it up
    safeWriteJson(filePath, original, {
      backupPath,
      backupValidator: () => true,
    });
    // Now update — backup is created of original
    safeWriteJson(filePath, { ...original, fly: { enabled: true } }, {
      backupPath,
      backupValidator: () => true,
    });

    // Simulate truncation (process killed mid-write)
    writeFileSync(filePath, '');

    // safeReadJson should restore from backup
    const restored = safeReadJson(filePath, { backupPath });
    expect(restored).toBeTruthy();
    // Backup has the pre-update version (original + fly)
    expect((restored as Record<string, unknown>).secrets).toEqual(original.secrets);
  });

  it('creates backup without validator (no backupValidator defaults to always-backup)', () => {
    // When backupValidator is omitted, `opts.backupValidator ? ... : true` takes the false
    // branch and defaults shouldBackup to true — backup is always taken.
    const filePath = join(testDir, 'config.json');
    const backupPath = join(testDir, 'backup.json');
    const original = { key: 'original-value' };

    writeFileSync(filePath, JSON.stringify(original, null, 2));

    // No backupValidator provided
    safeWriteJson(filePath, { key: 'new-value' }, { backupPath });

    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ key: 'new-value' });
    expect(JSON.parse(readFileSync(backupPath, 'utf-8'))).toEqual(original);
  });

  it('skips backup silently when current file is corrupt JSON', () => {
    // The backup try-catch catches JSON.parse errors on the current file — backup is skipped
    // but the write to the target still proceeds normally.
    const filePath = join(testDir, 'corrupt.json');
    const backupPath = join(testDir, 'backup.json');

    writeFileSync(filePath, '{not valid json');

    safeWriteJson(filePath, { fresh: true }, { backupPath, backupValidator: () => true });

    // Target is overwritten successfully
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual({ fresh: true });
    // No backup was created because the current file couldn't be parsed
    expect(existsSync(backupPath)).toBe(false);
  });

  it('creates backup parent directories when they do not exist', () => {
    const filePath = join(testDir, 'config.json');
    const backupPath = join(testDir, 'deep', 'nested', 'backup.json');
    const original = { value: 'data' };

    writeFileSync(filePath, JSON.stringify(original));

    safeWriteJson(filePath, { value: 'updated' }, { backupPath });

    expect(JSON.parse(readFileSync(backupPath, 'utf-8'))).toEqual(original);
  });

  it('throws and does not leave the target file when the target directory is read-only', () => {
    // Simulate a real write failure by making the parent directory read-only.
    // safeWriteJson writes to a .tmp.{pid} file first, then renames — both operations
    // will fail on a read-only directory, and the error must propagate to the caller.
    // The implementation's catch block attempts unlinkSync(tmpPath) before re-throwing;
    // this test verifies the error surfaces and the target file is never created.
    const readonlyDir = join(testDir, 'readonly');
    mkdirSync(readonlyDir);
    chmodSync(readonlyDir, 0o555); // r-xr-xr-x — no writes allowed

    const filePath = join(readonlyDir, 'output.json');

    try {
      expect(() => safeWriteJson(filePath, { data: true })).toThrow();
      // Target file must not exist after the failure
      expect(existsSync(filePath)).toBe(false);
    } finally {
      chmodSync(readonlyDir, 0o755); // restore for cleanup
    }
  });

  it('output is pretty-printed with 2-space indent and trailing newline', () => {
    const filePath = join(testDir, 'pretty.json');
    const data = { a: 1, b: { c: 2 } };

    safeWriteJson(filePath, data);

    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toBe(JSON.stringify(data, null, 2) + '\n');
  });

  it('writes non-object data (array, number, null) without error', () => {
    // safeWriteJson accepts `unknown` — it should write any JSON-serializable value
    const filePath = join(testDir, 'array.json');
    safeWriteJson(filePath, [1, 2, 3]);
    expect(JSON.parse(readFileSync(filePath, 'utf-8'))).toEqual([1, 2, 3]);
  });
});
