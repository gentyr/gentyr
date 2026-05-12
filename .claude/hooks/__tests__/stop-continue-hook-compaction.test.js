/**
 * Tests for the compaction exit bypass in stop-continue-hook.js (Fix 1).
 *
 * The hook reads compact-tracker.json and, when it finds compactRequested: true
 * keyed by either session_id or CLAUDE_AGENT_ID, outputs {"decision":"approve"}
 * and exits immediately — bypassing the normal task-session gates.
 *
 * Corrupt JSON fails open (falls through to normal gates, which also approve
 * for non-task sessions).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'stop-continue-hook.js');

/**
 * Run the stop-continue-hook as a child process.
 *
 * @param {object} hookInput - JSON object sent to the hook via stdin
 * @param {object} opts
 * @param {string} [opts.projectDir] - CLAUDE_PROJECT_DIR for the subprocess
 * @param {string} [opts.agentId]    - CLAUDE_AGENT_ID for the subprocess
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function runHook(hookInput, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // Remove env vars that would trigger task/persistent/spawned-agent gates
    delete env.GENTYR_PLAN_MANAGER;
    delete env.GENTYR_PERSISTENT_MONITOR;
    delete env.CLAUDE_SPAWNED_SESSION;
    delete env.CLAUDE_AGENT_ID;

    if (opts.projectDir) {
      env.CLAUDE_PROJECT_DIR = opts.projectDir;
    }
    if (opts.agentId) {
      env.CLAUDE_AGENT_ID = opts.agentId;
    }

    const proc = spawn('node', [HOOK_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('close', (exitCode) => {
      resolve({ exitCode: exitCode || 0, stdout, stderr });
    });

    proc.stdin.write(JSON.stringify(hookInput));
    proc.stdin.end();
  });
}

/** Minimal hook input that lacks a transcript_path so checkIfTaskSession returns false. */
function buildInput(overrides = {}) {
  return {
    hook_event_name: 'Stop',
    session_id: 'test-session-abc',
    ...overrides,
  };
}

describe('stop-continue-hook.js — compaction exit bypass (Fix 1)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-test-'));
    // Ensure the state directory exists (hook looks for compact-tracker.json there)
    fs.mkdirSync(path.join(tmpDir, '.claude', 'state'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('approves immediately when compactRequested is true keyed by session_id', async () => {
    const sessionId = 'test-session-abc';
    const tracker = {
      [sessionId]: {
        compactRequested: true,
        lastCompactAt: new Date().toISOString(),
        compactCount: 1,
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'state', 'compact-tracker.json'),
      JSON.stringify(tracker),
    );

    const result = await runHook(buildInput({ session_id: sessionId }), { projectDir: tmpDir });

    assert.strictEqual(result.exitCode, 0, 'hook should exit 0');
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.decision, 'approve', 'decision should be approve');
  });

  it('approves immediately when compactRequested is true keyed by CLAUDE_AGENT_ID', async () => {
    const agentId = 'agent-xyz-789';
    const tracker = {
      [agentId]: {
        compactRequested: true,
        lastCompactAt: new Date().toISOString(),
        compactCount: 2,
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'state', 'compact-tracker.json'),
      JSON.stringify(tracker),
    );

    // session_id does NOT match a tracker entry; agentId does
    const result = await runHook(
      buildInput({ session_id: 'different-session-id' }),
      { projectDir: tmpDir, agentId },
    );

    assert.strictEqual(result.exitCode, 0, 'hook should exit 0');
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.decision, 'approve', 'decision should be approve via CLAUDE_AGENT_ID lookup');
  });

  it('falls through (non-task session approve) when tracker file is missing', async () => {
    // No compact-tracker.json written — hook falls through to normal gates.
    // Because this is not a task session (no transcript_path), the normal gate approves.
    const result = await runHook(buildInput(), { projectDir: tmpDir });

    assert.strictEqual(result.exitCode, 0, 'hook should exit 0');
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.decision, 'approve', 'non-task fall-through should still approve');
  });

  it('falls through when compactRequested is false for the session', async () => {
    const sessionId = 'test-session-abc';
    const tracker = {
      [sessionId]: {
        compactRequested: false,
        lastCompactAt: new Date().toISOString(),
        compactCount: 0,
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'state', 'compact-tracker.json'),
      JSON.stringify(tracker),
    );

    const result = await runHook(buildInput({ session_id: sessionId }), { projectDir: tmpDir });

    assert.strictEqual(result.exitCode, 0, 'hook should exit 0');
    const parsed = JSON.parse(result.stdout.trim());
    // Falls through to non-task approval
    assert.strictEqual(parsed.decision, 'approve', 'should fall through and approve as non-task session');
  });

  it('fails open on corrupt JSON — falls through to non-task approval', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'state', 'compact-tracker.json'),
      '{ this is not valid json !!!',
    );

    const result = await runHook(buildInput(), { projectDir: tmpDir });

    assert.strictEqual(result.exitCode, 0, 'hook should exit 0 even with corrupt tracker');
    const parsed = JSON.parse(result.stdout.trim());
    assert.strictEqual(parsed.decision, 'approve', 'corrupt JSON should fail open and approve');
  });
});
