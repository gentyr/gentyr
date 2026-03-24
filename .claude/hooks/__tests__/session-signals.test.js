/**
 * Unit tests for session-signals.js (shared module).
 *
 * Tests signal creation, reading, acknowledgment, cleanup, and log queries.
 *
 * Run with: node --test .claude/hooks/__tests__/session-signals.test.js
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SIGNALS_MODULE_PATH = path.join(__dirname, '..', 'lib', 'session-signals.js');

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary project directory with the required state structure.
 */
function createTempProject(prefix = 'signals-test') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tmpDir, '.claude', 'state', 'session-signals'), { recursive: true });
  return {
    path: tmpDir,
    signalDir: path.join(tmpDir, '.claude', 'state', 'session-signals'),
    commsLog: path.join(tmpDir, '.claude', 'state', 'session-comms.log'),
    cleanup: () => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

// ============================================================================
// Module Import
// ============================================================================

let sendSignal, readPendingSignals, acknowledgeSignal, getSignalLog, getUnreadCount, cleanupOldSignals;

before(async () => {
  const mod = await import(SIGNALS_MODULE_PATH);
  sendSignal = mod.sendSignal;
  readPendingSignals = mod.readPendingSignals;
  acknowledgeSignal = mod.acknowledgeSignal;
  getSignalLog = mod.getSignalLog;
  getUnreadCount = mod.getUnreadCount;
  cleanupOldSignals = mod.cleanupOldSignals;
});

// ============================================================================
// Tests
// ============================================================================

describe('session-signals.js', () => {
  let project;

  beforeEach(() => {
    project = createTempProject();
  });

  afterEach(() => {
    project.cleanup();
  });

  // --------------------------------------------------------------------------
  // sendSignal
  // --------------------------------------------------------------------------

  describe('sendSignal', () => {
    it('creates a signal file in the signals directory', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Fix auth module',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Hey, I updated the auth interface',
        projectDir: project.path,
      });

      const files = fs.readdirSync(project.signalDir);
      assert.strictEqual(files.length, 1);
      assert.ok(files[0].startsWith('agent-bbb-'), 'Signal file should start with target agent ID');
      assert.ok(files[0].endsWith('.json'), 'Signal file should end with .json');
    });

    it('creates a signal with the correct JSON format', () => {
      const signal = sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Fix auth module',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Hey, I updated the auth interface',
        projectDir: project.path,
      });

      assert.ok(signal.id.startsWith('sig-'), 'Signal ID should start with sig-');
      assert.strictEqual(signal.from_agent_id, 'agent-aaa');
      assert.strictEqual(signal.from_agent_type, 'code-writer');
      assert.strictEqual(signal.from_task_title, 'Fix auth module');
      assert.strictEqual(signal.to_agent_id, 'agent-bbb');
      assert.strictEqual(signal.to_agent_type, 'test-writer');
      assert.strictEqual(signal.tier, 'note');
      assert.strictEqual(signal.message, 'Hey, I updated the auth interface');
      assert.ok(signal.created_at, 'Signal should have created_at');
      assert.strictEqual(signal.read_at, null, 'Signal read_at should be null');
      assert.strictEqual(signal.acknowledged_at, null, 'Signal acknowledged_at should be null');
    });

    it('reads back the correct JSON from the signal file', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Fix auth',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'instruction',
        message: 'Stop and review',
        projectDir: project.path,
      });

      const files = fs.readdirSync(project.signalDir);
      const filePath = path.join(project.signalDir, files[0]);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      assert.strictEqual(parsed.tier, 'instruction');
      assert.strictEqual(parsed.message, 'Stop and review');
      assert.strictEqual(parsed.read_at, null);
    });

    it('appends an entry to session-comms.log', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Fix auth',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Test message',
        projectDir: project.path,
      });

      assert.ok(fs.existsSync(project.commsLog), 'comms log should be created');
      const logContent = fs.readFileSync(project.commsLog, 'utf8').trim();
      const entry = JSON.parse(logContent);
      assert.strictEqual(entry.message, 'Test message');
      assert.strictEqual(entry.tier, 'note');
    });

    it('throws if fromAgentId is missing', () => {
      assert.throws(() => {
        sendSignal({
          fromAgentType: 'code-writer',
          toAgentId: 'agent-bbb',
          tier: 'note',
          message: 'test',
          projectDir: project.path,
        });
      }, /fromAgentId is required/);
    });

    it('throws if tier is invalid', () => {
      assert.throws(() => {
        sendSignal({
          fromAgentId: 'agent-aaa',
          fromAgentType: 'code-writer',
          toAgentId: 'agent-bbb',
          tier: 'invalid',
          message: 'test',
          projectDir: project.path,
        });
      }, /invalid tier/);
    });
  });

  // --------------------------------------------------------------------------
  // readPendingSignals
  // --------------------------------------------------------------------------

  describe('readPendingSignals', () => {
    it('returns signals targeting the specified agent', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Task A',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Signal for bbb',
        projectDir: project.path,
      });

      // Signal for a different agent should not be returned
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Task A',
        toAgentId: 'agent-ccc',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Signal for ccc',
        projectDir: project.path,
      });

      const pending = readPendingSignals('agent-bbb', project.path);
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].message, 'Signal for bbb');
    });

    it('marks signals as read', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Task A',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Signal to be read',
        projectDir: project.path,
      });

      const before = readPendingSignals('agent-bbb', project.path);
      assert.strictEqual(before.length, 1);
      // After readPendingSignals, the returned signal has read_at set (was just marked)
      assert.ok(before[0].read_at, 'Signal should have read_at set after being read');

      // Read again — should be empty now (already marked as read)
      const after = readPendingSignals('agent-bbb', project.path);
      assert.strictEqual(after.length, 0, 'Signal should be marked as read');

      // Verify file was updated
      const files = fs.readdirSync(project.signalDir).filter(f => f.startsWith('agent-bbb-'));
      assert.strictEqual(files.length, 1);
      const signal = JSON.parse(fs.readFileSync(path.join(project.signalDir, files[0]), 'utf8'));
      assert.ok(signal.read_at, 'Signal file read_at should be set');
    });

    it('returns empty array when no signals exist', () => {
      const pending = readPendingSignals('agent-nobody', project.path);
      assert.deepStrictEqual(pending, []);
    });

    it('returns signals sorted by created_at ascending', async () => {
      // Send multiple signals with small delays
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Task A',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'First signal',
        projectDir: project.path,
      });

      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));

      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'Task A',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'instruction',
        message: 'Second signal',
        projectDir: project.path,
      });

      const pending = readPendingSignals('agent-bbb', project.path);
      assert.strictEqual(pending.length, 2);
      assert.strictEqual(pending[0].message, 'First signal');
      assert.strictEqual(pending[1].message, 'Second signal');
    });
  });

  // --------------------------------------------------------------------------
  // getUnreadCount
  // --------------------------------------------------------------------------

  describe('getUnreadCount', () => {
    it('returns 0 when no signals exist', () => {
      assert.strictEqual(getUnreadCount('agent-nobody', project.path), 0);
    });

    it('returns the correct unread count', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'msg1',
        projectDir: project.path,
      });

      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'msg2',
        projectDir: project.path,
      });

      assert.strictEqual(getUnreadCount('agent-bbb', project.path), 2);
    });

    it('returns 0 after signals are read', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'msg1',
        projectDir: project.path,
      });

      // Read the signals
      readPendingSignals('agent-bbb', project.path);

      // Count should now be 0
      assert.strictEqual(getUnreadCount('agent-bbb', project.path), 0);
    });

    it('only counts signals for the requested agent', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'for bbb',
        projectDir: project.path,
      });

      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-ccc',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'for ccc',
        projectDir: project.path,
      });

      assert.strictEqual(getUnreadCount('agent-bbb', project.path), 1);
      assert.strictEqual(getUnreadCount('agent-ccc', project.path), 1);
    });
  });

  // --------------------------------------------------------------------------
  // acknowledgeSignal
  // --------------------------------------------------------------------------

  describe('acknowledgeSignal', () => {
    it('sets acknowledged_at on the signal file', () => {
      const signal = sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'instruction',
        message: 'Do this now',
        projectDir: project.path,
      });

      const result = acknowledgeSignal(signal.id, project.path);
      assert.strictEqual(result, true, 'acknowledgeSignal should return true');

      // Verify the file was updated
      const files = fs.readdirSync(project.signalDir).filter(f => f.startsWith('agent-bbb-'));
      assert.strictEqual(files.length, 1);
      const updated = JSON.parse(fs.readFileSync(path.join(project.signalDir, files[0]), 'utf8'));
      assert.ok(updated.acknowledged_at, 'Signal should have acknowledged_at set');
    });

    it('returns false when signal ID is not found', () => {
      const result = acknowledgeSignal('sig-nonexistent', project.path);
      assert.strictEqual(result, false);
    });
  });

  // --------------------------------------------------------------------------
  // cleanupOldSignals
  // --------------------------------------------------------------------------

  describe('cleanupOldSignals', () => {
    it('deletes signal files older than maxAgeHours', () => {
      // Create a signal file
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Old signal',
        projectDir: project.path,
      });

      const files = fs.readdirSync(project.signalDir);
      assert.strictEqual(files.length, 1);

      // Backdate the file's mtime to 25 hours ago
      const filePath = path.join(project.signalDir, files[0]);
      const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(filePath, oldTime, oldTime);

      const result = cleanupOldSignals(24, project.path);
      assert.strictEqual(result.deletedFiles, 1);

      const remaining = fs.readdirSync(project.signalDir);
      assert.strictEqual(remaining.length, 0, 'Old signal file should be deleted');
    });

    it('keeps signal files newer than maxAgeHours', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'Recent signal',
        projectDir: project.path,
      });

      const result = cleanupOldSignals(24, project.path);
      assert.strictEqual(result.deletedFiles, 0);

      const remaining = fs.readdirSync(project.signalDir);
      assert.strictEqual(remaining.length, 1, 'Recent signal file should be kept');
    });

    it('trims old log entries from session-comms.log', () => {
      // Write an old entry directly to the log
      const oldEntry = JSON.stringify({
        ts: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        id: 'sig-old',
        message: 'Old entry',
        tier: 'note',
      });
      const newEntry = JSON.stringify({
        ts: new Date().toISOString(),
        id: 'sig-new',
        message: 'New entry',
        tier: 'note',
      });
      fs.mkdirSync(path.dirname(project.commsLog), { recursive: true });
      fs.writeFileSync(project.commsLog, oldEntry + '\n' + newEntry + '\n');

      const result = cleanupOldSignals(24, project.path);
      assert.strictEqual(result.trimmedLog, true);

      const content = fs.readFileSync(project.commsLog, 'utf8').trim();
      const lines = content.split('\n').filter(l => l.trim());
      assert.strictEqual(lines.length, 1);
      const remaining = JSON.parse(lines[0]);
      assert.strictEqual(remaining.id, 'sig-new');
    });
  });

  // --------------------------------------------------------------------------
  // getSignalLog
  // --------------------------------------------------------------------------

  describe('getSignalLog', () => {
    it('returns empty array when log does not exist', () => {
      const result = getSignalLog({ projectDir: project.path });
      assert.deepStrictEqual(result, []);
    });

    it('returns all log entries when no filters are specified', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'msg1',
        projectDir: project.path,
      });

      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'instruction',
        message: 'msg2',
        projectDir: project.path,
      });

      const result = getSignalLog({ projectDir: project.path });
      assert.strictEqual(result.length, 2);
    });

    it('filters by tier', () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'note msg',
        projectDir: project.path,
      });

      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'instruction',
        message: 'instruction msg',
        projectDir: project.path,
      });

      const notes = getSignalLog({ tier: 'note', projectDir: project.path });
      assert.strictEqual(notes.length, 1);
      assert.strictEqual(notes[0].message, 'note msg');

      const instructions = getSignalLog({ tier: 'instruction', projectDir: project.path });
      assert.strictEqual(instructions.length, 1);
      assert.strictEqual(instructions[0].message, 'instruction msg');
    });

    it('filters by since timestamp', async () => {
      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'old msg',
        projectDir: project.path,
      });

      const midpoint = new Date().toISOString();
      await new Promise(r => setTimeout(r, 10));

      sendSignal({
        fromAgentId: 'agent-aaa',
        fromAgentType: 'code-writer',
        fromTaskTitle: 'T',
        toAgentId: 'agent-bbb',
        toAgentType: 'test-writer',
        tier: 'note',
        message: 'new msg',
        projectDir: project.path,
      });

      const result = getSignalLog({ since: midpoint, projectDir: project.path });
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].message, 'new msg');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        sendSignal({
          fromAgentId: 'agent-aaa',
          fromAgentType: 'code-writer',
          fromTaskTitle: 'T',
          toAgentId: 'agent-bbb',
          toAgentType: 'test-writer',
          tier: 'note',
          message: `msg ${i}`,
          projectDir: project.path,
        });
      }

      const result = getSignalLog({ limit: 3, projectDir: project.path });
      assert.strictEqual(result.length, 3);
    });
  });
});
