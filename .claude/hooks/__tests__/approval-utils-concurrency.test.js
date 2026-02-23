/**
 * Concurrency tests for the TOCTOU fix in approval-utils.js
 *
 * Verifies the one-time-use guarantee of approval codes under concurrent
 * consumption and the atomic-write guarantee of saveApprovals().
 *
 * Security invariant (G001 / TOCTOU fix):
 *   Exactly ONE consumer wins when N processes simultaneously try to
 *   consume the same approval code. All others must fail.
 *
 * Test strategy:
 *   - Spawn multiple child processes via child_process.fork()
 *   - Each child attempts to consume the same approval code
 *   - Parent verifies: exactly 1 success, N-1 failures, valid JSON state
 *
 * Run with: node --test .claude/hooks/__tests__/approval-utils-concurrency.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to approval-utils so worker scripts can import it regardless
// of what temp directory they are written to.
const APPROVAL_UTILS_PATH = path.resolve(
  __dirname,
  '..',
  'lib',
  'approval-utils.js'
);

// ============================================================================
// Constants
// ============================================================================

// Number of concurrent processes to race against the same approval code.
// Kept small so the test finishes quickly in CI without becoming a stress test.
const CONCURRENT_CONSUMERS = 5;

// Time to allow child processes to complete (ms). The lock backs off up to
// ~50*(2^10) ≈ 51s worst-case, but with 10 retries and 5 processes in
// practice this finishes well within 10s.
const CHILD_TIMEOUT_MS = 20000;

// Correct argsHash for an empty args object ({}).
// approval-utils computes: sha256(JSON.stringify(args || {}))
const EMPTY_ARGS_HASH = crypto
  .createHash('sha256')
  .update(JSON.stringify({}))
  .digest('hex');

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a temp dir with the minimal .claude/ layout expected by approval-utils.
 */
function createTempProjectDir(prefix = 'approvals-concurrency-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  return {
    path: tmpDir,
    claudeDir,
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Build an approvals fixture with a single valid 'approved' entry.
 * No HMAC fields are included so that approval-utils skips HMAC verification
 * (it only verifies when pending_hmac / approved_hmac fields are present).
 */
function buildSingleApprovedFixture(code, server, tool) {
  const now = Date.now();
  return {
    approvals: {
      [code]: {
        server,
        tool,
        args: {},
        argsHash: EMPTY_ARGS_HASH,
        phrase: 'APPROVE TEST',
        code,
        status: 'approved',
        created_at: new Date(now).toISOString(),
        created_timestamp: now,
        expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
        expires_timestamp: now + 5 * 60 * 1000,
        // No pending_hmac / approved_hmac: skips HMAC verification path,
        // which requires a protection-key file we do not need in these tests.
      },
    },
  };
}

/**
 * Write the approvals fixture to the standard path inside projectDir.
 * Returns the absolute path to the written file.
 */
function writeApprovalsFixture(projectDir, data) {
  const approvalsPath = path.join(projectDir, '.claude', 'protected-action-approvals.json');
  fs.writeFileSync(approvalsPath, JSON.stringify(data, null, 2));
  return approvalsPath;
}

/**
 * Read and parse the approvals file; return null if absent or invalid JSON.
 */
function readApprovalsFile(approvalsPath) {
  try {
    const raw = fs.readFileSync(approvalsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================================================
// Worker script sources
// ============================================================================

/**
 * Returns the source for a worker process that tries to consume an approval.
 *
 * The worker:
 *   1. Reads server/tool/label from process.argv[2]
 *   2. Calls checkApproval(server, tool, {})
 *   3. Sends result via process.send() and exits 0
 *
 * Using an absolute import path for approval-utils avoids relative-path
 * resolution issues when the script is written to a temp directory.
 */
function consumerWorkerSource() {
  return `import { checkApproval } from ${JSON.stringify(APPROVAL_UTILS_PATH)};

const { server, tool, label } = JSON.parse(process.argv[2]);

try {
  const result = checkApproval(server, tool, {});
  process.send({ label, success: result !== null });
} catch (err) {
  process.send({ label, success: false, error: err.message });
}
`;
}

/**
 * Returns the source for a worker that simulates a crash mid-write.
 *
 * It writes a deliberately malformed/incomplete JSON to a .tmp file
 * and exits WITHOUT performing the rename — simulating a crash between
 * write and rename.
 */
function crashWorkerSource() {
  return `import fs from 'fs';

const { approvalsPath } = JSON.parse(process.argv[2]);
const tmpPath = approvalsPath + '.tmp.crashworker';

// Write malformed JSON to tmp file (simulates partial write / crash)
fs.writeFileSync(tmpPath, '{"approvals":{"PARTIAL":{"status":"approved"', 'utf8');

// Exit WITHOUT renaming: the tmp file is an orphan.
// The real approvals file must remain untouched.
process.exit(0);
`;
}

/**
 * Write a worker source to a temp .mjs file and return its path.
 */
function writeTempWorker(dir, filename, source) {
  const workerPath = path.join(dir, filename);
  fs.writeFileSync(workerPath, source, 'utf8');
  return workerPath;
}

/**
 * Spawn `count` worker processes that each call checkApproval for the same
 * server/tool. All processes are started simultaneously. Returns a promise
 * that resolves with an array of result objects received from the workers.
 */
function spawnConcurrentConsumers(workerScript, projectDir, server, tool, count) {
  const promises = Array.from({ length: count }, (_, i) => {
    return new Promise((resolve) => {
      const workerArg = JSON.stringify({
        server,
        tool,
        args: {},
        label: `worker-${i}`,
      });

      const child = fork(workerScript, [workerArg], {
        execArgv: [],
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectDir,
        },
        // Use 'pipe' for stdout/stderr so errors don't spill into test output.
        // Use 'ipc' for process.send().
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });

      let result = null;
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ workerIndex: i, label: `worker-${i}`, success: false, error: 'timeout' });
      }, CHILD_TIMEOUT_MS);

      child.on('message', (msg) => {
        result = { ...msg, workerIndex: i };
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(
          result || {
            workerIndex: i,
            label: `worker-${i}`,
            success: false,
            error: `process exited ${code} without sending a message`,
          }
        );
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ workerIndex: i, label: `worker-${i}`, success: false, error: err.message });
      });
    });
  });

  return Promise.all(promises);
}

// ============================================================================
// Tests
// ============================================================================

describe('approval-utils.js – TOCTOU concurrency', () => {
  let projectDir;
  let workerScript;

  before(() => {
    // Create a shared temp project directory for the entire suite.
    projectDir = createTempProjectDir();

    // Write the worker into a subdirectory.  The worker uses an absolute
    // import path for approval-utils so location does not matter.
    const workerDir = path.join(projectDir.path, 'worker');
    fs.mkdirSync(workerDir, { recursive: true });
    workerScript = writeTempWorker(workerDir, 'consume-approval.mjs', consumerWorkerSource());
  });

  after(() => {
    if (projectDir) {
      projectDir.cleanup();
    }
  });

  // --------------------------------------------------------------------------
  // 1. One-time-use guarantee under concurrent consumption
  // --------------------------------------------------------------------------

  describe('double-consumption prevention', () => {
    it(
      `should allow exactly ONE of ${CONCURRENT_CONSUMERS} concurrent consumers to succeed`,
      async () => {
        const CODE = 'RACE01';
        const SERVER = 'test-server';
        const TOOL = 'test-tool';

        writeApprovalsFixture(projectDir.path, buildSingleApprovedFixture(CODE, SERVER, TOOL));

        const results = await spawnConcurrentConsumers(
          workerScript,
          projectDir.path,
          SERVER,
          TOOL,
          CONCURRENT_CONSUMERS
        );

        const successes = results.filter(r => r.success === true);
        const failures = results.filter(r => r.success === false);

        assert.strictEqual(
          successes.length,
          1,
          `Expected exactly 1 successful consumer, got ${successes.length}.\n` +
          `Results: ${JSON.stringify(results, null, 2)}`
        );

        assert.strictEqual(
          failures.length,
          CONCURRENT_CONSUMERS - 1,
          `Expected ${CONCURRENT_CONSUMERS - 1} failures, got ${failures.length}`
        );
      }
    );

    it('should leave the approvals file in valid JSON state after concurrent consumption', async () => {
      const CODE = 'RACE02';
      const SERVER = 'test-server';
      const TOOL = 'test-tool';

      const approvalsPath = writeApprovalsFixture(
        projectDir.path,
        buildSingleApprovedFixture(CODE, SERVER, TOOL)
      );

      await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        SERVER,
        TOOL,
        CONCURRENT_CONSUMERS
      );

      const contents = readApprovalsFile(approvalsPath);

      assert.notStrictEqual(
        contents,
        null,
        'Approvals file should contain valid JSON after concurrent access'
      );
      assert.strictEqual(
        typeof contents,
        'object',
        'Parsed approvals should be an object'
      );
      assert.strictEqual(
        typeof contents.approvals,
        'object',
        'Approvals file should have an "approvals" key'
      );
    });

    it('should remove the consumed approval code from the file', async () => {
      const CODE = 'RACE03';
      const SERVER = 'test-server';
      const TOOL = 'test-tool';

      const approvalsPath = writeApprovalsFixture(
        projectDir.path,
        buildSingleApprovedFixture(CODE, SERVER, TOOL)
      );

      const results = await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        SERVER,
        TOOL,
        CONCURRENT_CONSUMERS
      );

      const successes = results.filter(r => r.success === true);
      assert.strictEqual(successes.length, 1, 'Prerequisite: exactly one success');

      const contents = readApprovalsFile(approvalsPath);
      assert.notStrictEqual(contents, null, 'Approvals file must be readable after consumption');
      assert.ok(
        !contents.approvals[CODE],
        `Consumed approval code "${CODE}" should be absent from the file`
      );
    });

    it('should not consume unrelated approvals during concurrent access', async () => {
      const TARGET_CODE = 'RACE04';
      const BYSTANDER_CODE = 'STAND5';
      const SERVER = 'race-server';
      const TOOL = 'race-tool';
      const OTHER_SERVER = 'other-server';

      const now = Date.now();
      const fixture = {
        approvals: {
          [TARGET_CODE]: {
            server: SERVER,
            tool: TOOL,
            args: {},
            argsHash: EMPTY_ARGS_HASH,
            phrase: 'APPROVE TEST',
            code: TARGET_CODE,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
          [BYSTANDER_CODE]: {
            server: OTHER_SERVER,
            tool: 'other-tool',
            args: {},
            argsHash: EMPTY_ARGS_HASH,
            phrase: 'APPROVE OTHER',
            code: BYSTANDER_CODE,
            status: 'approved',
            created_timestamp: now,
            expires_timestamp: now + 5 * 60 * 1000,
          },
        },
      };

      const approvalsPath = writeApprovalsFixture(projectDir.path, fixture);

      // Race for TARGET_CODE only (consumers use SERVER/TOOL, not OTHER_SERVER)
      await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        SERVER,
        TOOL,
        CONCURRENT_CONSUMERS
      );

      const contents = readApprovalsFile(approvalsPath);
      assert.notStrictEqual(contents, null, 'Approvals file must be readable');
      assert.ok(
        contents.approvals[BYSTANDER_CODE],
        `Bystander approval "${BYSTANDER_CODE}" should still exist after concurrent consumption of "${TARGET_CODE}"`
      );
    });

    it('should handle a second race on the same code gracefully (all fail)', async () => {
      const CODE = 'RACE05';
      const SERVER = 'test-server';
      const TOOL = 'test-tool';

      writeApprovalsFixture(projectDir.path, buildSingleApprovedFixture(CODE, SERVER, TOOL));

      // First wave: one succeeds, rest fail
      const firstWave = await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        SERVER,
        TOOL,
        3
      );
      const firstSuccesses = firstWave.filter(r => r.success === true);
      assert.strictEqual(firstSuccesses.length, 1, 'First wave should have exactly 1 success');

      // Second wave: approval already consumed, all must fail
      const secondWave = await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        SERVER,
        TOOL,
        3
      );
      const secondSuccesses = secondWave.filter(r => r.success === true);
      assert.strictEqual(
        secondSuccesses.length,
        0,
        'Second wave should have 0 successes (approval already consumed)'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 2. Atomic write integrity: crash before rename leaves file untouched
  // --------------------------------------------------------------------------

  describe('atomic write integrity', () => {
    it('should leave the original approvals file intact if a process crashes before rename', async () => {
      const CODE = 'CRASH1';
      const SERVER = 'crash-server';
      const TOOL = 'crash-tool';

      const fixture = buildSingleApprovedFixture(CODE, SERVER, TOOL);
      const approvalsPath = writeApprovalsFixture(projectDir.path, fixture);

      // Write the crash-worker script
      const workerDir = path.dirname(workerScript);
      const crashScript = writeTempWorker(
        workerDir,
        'crash-mid-write.mjs',
        crashWorkerSource()
      );

      // Spawn a process that writes a tmp file but does NOT rename it
      await new Promise((resolve) => {
        const workerArg = JSON.stringify({ approvalsPath });
        const child = fork(crashScript, [workerArg], {
          execArgv: [],
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });

        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ timedOut: true });
        }, CHILD_TIMEOUT_MS);

        child.on('exit', () => {
          clearTimeout(timer);
          resolve({ ok: true });
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ error: err.message });
        });
      });

      // The real approvals file must still be valid and have the original entry
      const contents = readApprovalsFile(approvalsPath);
      assert.notStrictEqual(
        contents,
        null,
        'Approvals file should remain valid JSON after a crash-mid-write'
      );
      assert.ok(
        contents.approvals[CODE],
        `Original approval "${CODE}" should still exist — crash should not corrupt the file`
      );
      assert.strictEqual(
        contents.approvals[CODE].status,
        'approved',
        'Approval status should be unchanged'
      );

      // Cleanup orphan tmp file left by crash worker
      const orphanTmp = approvalsPath + '.tmp.crashworker';
      try { fs.unlinkSync(orphanTmp); } catch { /* may not exist */ }
    });

    it('should not let an orphaned .tmp file corrupt the real approvals file', async () => {
      // Manually create an orphaned tmp file (simulates crash after write, before rename)
      const approvalsPath = path.join(
        projectDir.path,
        '.claude',
        'protected-action-approvals.json'
      );
      const orphanTmpPath = approvalsPath + '.tmp.99999';
      fs.writeFileSync(orphanTmpPath, '{"approvals":{"ORPHAN":{"status":"approved"}', 'utf8');

      // Write a valid approvals fixture via the helper (which calls saveApprovals internally)
      const fixture = buildSingleApprovedFixture('LIVE01', 'live-server', 'live-tool');
      writeApprovalsFixture(projectDir.path, fixture);

      const contents = readApprovalsFile(approvalsPath);
      assert.notStrictEqual(contents, null, 'Approvals file should be valid JSON');
      assert.ok(
        contents.approvals['LIVE01'],
        'Real approvals file should contain the live entry, not orphan data'
      );
      assert.ok(
        !contents.approvals['ORPHAN'],
        'Orphan entry should not have leaked into the real approvals file'
      );

      // Cleanup
      try { fs.unlinkSync(orphanTmpPath); } catch { /* already gone */ }
    });

    it('should not leave a .tmp file behind when a consumer successfully writes the file', async () => {
      const CODE = 'NOTMP1';
      writeApprovalsFixture(
        projectDir.path,
        buildSingleApprovedFixture(CODE, 'notmp-server', 'notmp-tool')
      );

      const approvalsPath = path.join(
        projectDir.path,
        '.claude',
        'protected-action-approvals.json'
      );
      const approvalsDir = path.dirname(approvalsPath);

      // Spawn a single consumer — when it completes the atomic write
      // (write tmp → rename), no .tmp file should remain
      await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        'notmp-server',
        'notmp-tool',
        1
      );

      const tmpFiles = fs.readdirSync(approvalsDir).filter(f =>
        f.startsWith('protected-action-approvals.json.tmp.')
      );

      assert.strictEqual(
        tmpFiles.length,
        0,
        `No .tmp files should remain after a successful write. Found: ${tmpFiles.join(', ')}`
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Lock file hygiene
  // --------------------------------------------------------------------------

  describe('lock file hygiene', () => {
    it('should not leave a stale lock file after normal concurrent consumption', async () => {
      const CODE = 'LOCK01';
      writeApprovalsFixture(
        projectDir.path,
        buildSingleApprovedFixture(CODE, 'lock-server', 'lock-tool')
      );

      await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        'lock-server',
        'lock-tool',
        CONCURRENT_CONSUMERS
      );

      const lockPath = path.join(
        projectDir.path,
        '.claude',
        'protected-action-approvals.json.lock'
      );

      assert.ok(
        !fs.existsSync(lockPath),
        'Lock file should be removed after all consumers finish'
      );
    });

    it('should recover from a stale lock file older than 10 seconds', async () => {
      const CODE = 'STALE1';
      writeApprovalsFixture(
        projectDir.path,
        buildSingleApprovedFixture(CODE, 'stale-server', 'stale-tool')
      );

      // Create a stale lock file back-dated to 15 seconds ago
      const lockPath = path.join(
        projectDir.path,
        '.claude',
        'protected-action-approvals.json.lock'
      );
      fs.writeFileSync(lockPath, '12345', 'utf8');
      const staleMtime = new Date(Date.now() - 15000);
      fs.utimesSync(lockPath, staleMtime, staleMtime);

      // A fresh consumer should detect the stale lock, remove it, and succeed
      const results = await spawnConcurrentConsumers(
        workerScript,
        projectDir.path,
        'stale-server',
        'stale-tool',
        1
      );

      const successes = results.filter(r => r.success === true);
      assert.strictEqual(
        successes.length,
        1,
        'Consumer should succeed after recovering from a stale lock'
      );

      // Lock file should be gone after the consumer released it
      assert.ok(
        !fs.existsSync(lockPath),
        'Lock file should be cleaned up after stale-lock recovery'
      );
    });

    it('should block when a fresh (non-stale) lock is held by another process', async () => {
      // This test verifies that the lock actually blocks concurrent access.
      // We create a lock file with the CURRENT time (not stale) and verify
      // that a consumer times out or fails to acquire the lock.
      //
      // Because the lock has a 10-second stale threshold and our consumer
      // has an exponential backoff of up to ~25 seconds, we write a lock
      // and immediately spawn a consumer with a very short timeout.

      const CODE = 'BLOCK1';
      writeApprovalsFixture(
        projectDir.path,
        buildSingleApprovedFixture(CODE, 'block-server', 'block-tool')
      );

      const lockPath = path.join(
        projectDir.path,
        '.claude',
        'protected-action-approvals.json.lock'
      );

      // Write a fresh lock file (current mtime) simulating a lock held by PID 99998
      fs.writeFileSync(lockPath, '99998', 'utf8');

      // Spawn a single consumer with a short external timeout.  Since the lock
      // is fresh, acquireLock() will back off and never acquire it within the
      // ~2-second backoff window (10 retries × exponential up to 25s).
      // We give the worker 3 seconds — enough to see it fail to acquire.
      const shortTimeoutMs = 3000;
      const result = await new Promise((resolve) => {
        const workerArg = JSON.stringify({
          server: 'block-server',
          tool: 'block-tool',
          args: {},
          label: 'block-worker',
        });

        const child = fork(workerScript, [workerArg], {
          execArgv: [],
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: projectDir.path,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });

        let msg = null;
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ timedOut: true, success: false });
        }, shortTimeoutMs);

        child.on('message', (m) => { msg = m; });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve(msg || { success: false, error: 'no message' });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ success: false, error: err.message });
        });
      });

      // The worker must NOT have succeeded (lock is held, it cannot consume)
      assert.strictEqual(
        result.success,
        false,
        'Consumer must not succeed while a fresh lock is held'
      );

      // Release the lock so subsequent tests are not affected
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    });
  });
});
