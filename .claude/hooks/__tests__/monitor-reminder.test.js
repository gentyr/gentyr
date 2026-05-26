/**
 * Tests for monitor-reminder.js staleness guard.
 *
 * Specifically covers the file-mtime fallback when state.lastRoundAt is absent
 * (the session died before update_monitor_state was ever called).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK = path.join(__dirname, '..', 'monitor-reminder.js');

const STALE_MS = 20 * 60 * 1000;

function runHook(projectDir) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  const result = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Read', session_id: 'sess-test' }),
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout || '{}');
}

function writeStateFile(projectDir, contents, mtimeMs) {
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'monitor-active.json');
  fs.writeFileSync(stateFile, JSON.stringify(contents));
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    fs.utimesSync(stateFile, date, date);
  }
  return stateFile;
}

describe('monitor-reminder.js staleness guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-reminder-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lastRoundAt absent + stale mtime → cleans up state file (file-mtime fallback)', () => {
    const oldMtime = Date.now() - (STALE_MS + 60_000);
    const stateFile = writeStateFile(tmpDir, { roundNumber: 0 }, oldMtime);

    runHook(tmpDir);

    assert.equal(fs.existsSync(stateFile), false, 'state file should be deleted');
  });

  it('lastRoundAt absent + fresh mtime → keeps state file', () => {
    const stateFile = writeStateFile(tmpDir, { roundNumber: 0 });

    runHook(tmpDir);

    assert.equal(fs.existsSync(stateFile), true, 'state file should be preserved when fresh');
  });

  it('lastRoundAt present + stale → cleans up (existing behavior preserved)', () => {
    const stateFile = writeStateFile(tmpDir, {
      roundNumber: 5,
      lastRoundAt: new Date(Date.now() - (STALE_MS + 60_000)).toISOString(),
    });

    runHook(tmpDir);

    assert.equal(fs.existsSync(stateFile), false, 'stale lastRoundAt should trigger cleanup');
  });

  it('lastRoundAt present + fresh → keeps state file (existing behavior preserved)', () => {
    const stateFile = writeStateFile(tmpDir, {
      roundNumber: 5,
      lastRoundAt: new Date().toISOString(),
    });

    runHook(tmpDir);

    assert.equal(fs.existsSync(stateFile), true, 'fresh lastRoundAt should not trigger cleanup');
  });

  it('no state file → fast-exits silently (no errors)', () => {
    const out = runHook(tmpDir);
    assert.deepEqual(out, {}, 'should emit empty JSON when no state file');
  });
});
