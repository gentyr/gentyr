/**
 * Unit tests for lib/interactive-liveness.js
 *
 * Run with: node --test .claude/hooks/__tests__/interactive-liveness.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  recordInteractiveLiveness,
  updateSessionWorktreePath,
  getActiveInteractiveSessions,
  getActiveCtoWorktreePaths,
  purgeDeadSessions,
  getInteractiveSession,
  removeInteractiveSession,
  __testing,
} from '../lib/interactive-liveness.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-liveness-'));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('interactive-liveness', () => {
  describe('recordInteractiveLiveness', () => {
    it('writes a new session entry', () => {
      const ok = recordInteractiveLiveness('session-abc', '/tmp/wt-abc', { projectDir: tmpDir, pid: process.pid });
      assert.strictEqual(ok, true);
      const entry = getInteractiveSession('session-abc', { projectDir: tmpDir });
      assert.ok(entry);
      assert.strictEqual(entry.ctoWorktreePath, '/tmp/wt-abc');
      assert.strictEqual(entry.pid, process.pid);
      assert.ok(entry.lastHeartbeat);
      assert.ok(entry.startedAt);
    });

    it('preserves startedAt on subsequent calls (refresh)', async () => {
      recordInteractiveLiveness('s1', '/tmp/a', { projectDir: tmpDir, pid: process.pid });
      const first = getInteractiveSession('s1', { projectDir: tmpDir });
      await new Promise(r => setTimeout(r, 10));
      recordInteractiveLiveness('s1', '/tmp/a', { projectDir: tmpDir, pid: process.pid });
      const second = getInteractiveSession('s1', { projectDir: tmpDir });
      assert.strictEqual(first.startedAt, second.startedAt);
      assert.notStrictEqual(first.lastHeartbeat, second.lastHeartbeat);
    });

    it('returns false when sessionId is empty', () => {
      assert.strictEqual(recordInteractiveLiveness('', '/tmp/a', { projectDir: tmpDir }), false);
    });
  });

  describe('updateSessionWorktreePath', () => {
    it('creates an entry if missing', () => {
      const ok = updateSessionWorktreePath('s-new', '/tmp/new', { projectDir: tmpDir, pid: process.pid });
      assert.strictEqual(ok, true);
      const entry = getInteractiveSession('s-new', { projectDir: tmpDir });
      assert.strictEqual(entry.ctoWorktreePath, '/tmp/new');
    });

    it('updates an existing entry without disturbing startedAt', async () => {
      recordInteractiveLiveness('s-up', '/tmp/old', { projectDir: tmpDir, pid: process.pid });
      const before = getInteractiveSession('s-up', { projectDir: tmpDir });
      await new Promise(r => setTimeout(r, 10));
      updateSessionWorktreePath('s-up', '/tmp/new', { projectDir: tmpDir });
      const after = getInteractiveSession('s-up', { projectDir: tmpDir });
      assert.strictEqual(after.ctoWorktreePath, '/tmp/new');
      assert.strictEqual(before.startedAt, after.startedAt);
    });
  });

  describe('getActiveInteractiveSessions', () => {
    it('returns alive entries only', () => {
      recordInteractiveLiveness('alive', '/tmp/a', { projectDir: tmpDir, pid: process.pid });
      const active = getActiveInteractiveSessions({ projectDir: tmpDir });
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].sessionId, 'alive');
    });

    it('filters out stale entries with dead PIDs', () => {
      // Manually write a stale entry with a fake-dead PID + old heartbeat
      const statePath = path.join(tmpDir, '.claude', 'state', 'interactive-sessions.json');
      const oldHeartbeat = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(statePath, JSON.stringify({
        dead: { pid: 999999999, ctoWorktreePath: '/tmp/dead', lastHeartbeat: oldHeartbeat, startedAt: oldHeartbeat },
        alive: { pid: process.pid, ctoWorktreePath: '/tmp/alive', lastHeartbeat: new Date().toISOString(), startedAt: new Date().toISOString() },
      }));
      const active = getActiveInteractiveSessions({ projectDir: tmpDir });
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].sessionId, 'alive');
    });

    it('returns empty when state file is missing', () => {
      const active = getActiveInteractiveSessions({ projectDir: tmpDir });
      assert.deepStrictEqual(active, []);
    });
  });

  describe('getActiveCtoWorktreePaths', () => {
    it('returns paths claimed by alive sessions', () => {
      recordInteractiveLiveness('s1', '/tmp/wt1', { projectDir: tmpDir, pid: process.pid });
      recordInteractiveLiveness('s2', '/tmp/wt2', { projectDir: tmpDir, pid: process.pid });
      const paths = getActiveCtoWorktreePaths({ projectDir: tmpDir });
      assert.strictEqual(paths.size, 2);
      assert.ok(paths.has('/tmp/wt1'));
      assert.ok(paths.has('/tmp/wt2'));
    });

    it('omits sessions with no worktree', () => {
      recordInteractiveLiveness('s1', null, { projectDir: tmpDir, pid: process.pid });
      const paths = getActiveCtoWorktreePaths({ projectDir: tmpDir });
      assert.strictEqual(paths.size, 0);
    });
  });

  describe('purgeDeadSessions', () => {
    it('removes stale entries and returns them', () => {
      const statePath = path.join(tmpDir, '.claude', 'state', 'interactive-sessions.json');
      const oldHeartbeat = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(statePath, JSON.stringify({
        dead1: { pid: 999999999, ctoWorktreePath: '/tmp/d1', lastHeartbeat: oldHeartbeat, startedAt: oldHeartbeat },
        dead2: { pid: 999999998, ctoWorktreePath: '/tmp/d2', lastHeartbeat: oldHeartbeat, startedAt: oldHeartbeat },
        alive: { pid: process.pid, ctoWorktreePath: '/tmp/alive', lastHeartbeat: new Date().toISOString(), startedAt: new Date().toISOString() },
      }));
      const removed = purgeDeadSessions({ projectDir: tmpDir });
      assert.strictEqual(removed.length, 2);
      const remaining = getInteractiveSession('alive', { projectDir: tmpDir });
      assert.ok(remaining);
      assert.strictEqual(getInteractiveSession('dead1', { projectDir: tmpDir }), null);
      assert.strictEqual(getInteractiveSession('dead2', { projectDir: tmpDir }), null);
    });

    it('returns empty array when nothing stale', () => {
      recordInteractiveLiveness('s1', '/tmp/a', { projectDir: tmpDir, pid: process.pid });
      const removed = purgeDeadSessions({ projectDir: tmpDir });
      assert.deepStrictEqual(removed, []);
    });
  });

  describe('removeInteractiveSession', () => {
    it('removes a specific session', () => {
      recordInteractiveLiveness('s1', '/tmp/a', { projectDir: tmpDir, pid: process.pid });
      recordInteractiveLiveness('s2', '/tmp/b', { projectDir: tmpDir, pid: process.pid });
      const ok = removeInteractiveSession('s1', { projectDir: tmpDir });
      assert.strictEqual(ok, true);
      assert.strictEqual(getInteractiveSession('s1', { projectDir: tmpDir }), null);
      assert.ok(getInteractiveSession('s2', { projectDir: tmpDir }));
    });

    it('returns false when session not found', () => {
      const ok = removeInteractiveSession('missing', { projectDir: tmpDir });
      assert.strictEqual(ok, false);
    });
  });

  describe('isEntryStale (internal)', () => {
    it('treats missing heartbeat as stale', () => {
      assert.strictEqual(__testing.isEntryStale({ pid: process.pid }), true);
    });
    it('treats fresh heartbeat as not stale regardless of PID', () => {
      assert.strictEqual(__testing.isEntryStale({ pid: 999999999, lastHeartbeat: new Date().toISOString() }), false);
    });
    it('treats old heartbeat + dead PID as stale', () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      assert.strictEqual(__testing.isEntryStale({ pid: 999999999, lastHeartbeat: old }), true);
    });
    it('treats old heartbeat + live PID as not stale', () => {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      assert.strictEqual(__testing.isEntryStale({ pid: process.pid, lastHeartbeat: old }), false);
    });
  });
});
