/**
 * Tests for PR 3 — subprocess tagging.
 *
 * Covers:
 *   - lib/subprocess-call-tracker.js — start/finish DB writes, schema creation,
 *     graceful no-op when DB unavailable
 *   - lib/llm-client.js — tag parameter wiring, env var injection
 *     (CLAUDE_USAGE_TAG, CLAUDE_USAGE_PARENT), untagged warning suppression
 *   - All 7 callers pass a unique tag (static check)
 *
 * Run: node --test .claude/hooks/__tests__/subprocess-tagging.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../../..');

// ============================================================================
// subprocess-call-tracker
// ============================================================================

describe('lib/subprocess-call-tracker.js', () => {
  let tmpDir;
  let prevProjectDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subproc-tracker-'));
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevProjectDir) process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    else delete process.env.CLAUDE_PROJECT_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('start/finish writes a complete row to subprocess_calls', async () => {
    const tracker = await import(`../lib/subprocess-call-tracker.js?t=${Date.now()}`);
    const rowId = tracker.startSubprocessCall({
      caller: 'live-feed-daemon',
      model: 'claude-haiku-4-5',
      parentSessionId: 'parent-abc',
    });
    assert.ok(rowId, 'rowId returned');

    tracker.finishSubprocessCall(rowId, { pid: 12345, exitCode: 0 });

    const db = new Database(path.join(tmpDir, '.claude', 'state', 'token-usage.db'));
    const row = db.prepare('SELECT * FROM subprocess_calls WHERE id = ?').get(rowId);
    db.close();
    tracker.closeSubprocessCallDb();

    assert.strictEqual(row.caller, 'live-feed-daemon');
    assert.strictEqual(row.model, 'claude-haiku-4-5');
    assert.strictEqual(row.parent_session_id, 'parent-abc');
    assert.strictEqual(row.pid, 12345);
    assert.strictEqual(row.exit_code, 0);
    assert.ok(row.started_at > 0);
    assert.ok(row.ended_at > 0);
  });

  it('startSubprocessCall returns null when caller is missing', async () => {
    const tracker = await import(`../lib/subprocess-call-tracker.js?t=${Date.now()}`);
    assert.strictEqual(tracker.startSubprocessCall({}), null);
    assert.strictEqual(tracker.startSubprocessCall({ caller: '' }), null);
    assert.strictEqual(tracker.startSubprocessCall({ caller: 123 }), null);
    tracker.closeSubprocessCallDb();
  });

  it('finishSubprocessCall no-ops on null rowId', async () => {
    const tracker = await import(`../lib/subprocess-call-tracker.js?t=${Date.now()}`);
    // Should not throw
    tracker.finishSubprocessCall(null, { exitCode: 0 });
    tracker.finishSubprocessCall(undefined, { exitCode: 0 });
    tracker.closeSubprocessCallDb();
  });

  it('getCurrentParentSessionId returns env value or null', async () => {
    const tracker = await import(`../lib/subprocess-call-tracker.js?t=${Date.now()}`);
    const prev = process.env.CLAUDE_USAGE_PARENT;
    delete process.env.CLAUDE_USAGE_PARENT;
    assert.strictEqual(tracker.getCurrentParentSessionId(), null);
    process.env.CLAUDE_USAGE_PARENT = 'sess-xyz';
    assert.strictEqual(tracker.getCurrentParentSessionId(), 'sess-xyz');
    if (prev) process.env.CLAUDE_USAGE_PARENT = prev;
    else delete process.env.CLAUDE_USAGE_PARENT;
    tracker.closeSubprocessCallDb();
  });
});

// ============================================================================
// Caller wiring (static check)
// ============================================================================

describe('llm-client caller wiring', () => {
  const fixtures = [
    {
      file: '.claude/hooks/lib/report-auto-resolver.js',
      tags: ['report-auto-resolve', 'report-dedup'],
    },
    {
      file: '.claude/hooks/lib/ai-pr-decomposition.js',
      tags: ['ai-pr-decomposition'],
    },
    {
      file: '.claude/hooks/lib/ai-compatibility-check.js',
      tags: ['ai-compatibility-check'],
    },
    {
      file: '.claude/hooks/lib/ai-changelog.js',
      tags: ['ai-changelog'],
    },
    {
      file: '.claude/hooks/lib/migration-safety.js',
      tags: ['migration-safety:verification', 'migration-safety:analyze'],
    },
    {
      file: 'scripts/session-activity-broadcaster.js',
      tags: [
        'session-activity-broadcaster:per-session',
        'session-activity-broadcaster:super-summary',
        'session-activity-broadcaster:relevance',
      ],
    },
  ];

  for (const { file, tags } of fixtures) {
    it(`${file} passes expected tags`, () => {
      const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const tag of tags) {
        assert.ok(
          content.includes(`tag: '${tag}'`),
          `${file} should pass tag: '${tag}'`,
        );
      }
    });
  }
});

// ============================================================================
// Direct claude callers (env var injection)
// ============================================================================

describe('direct claude callers inject CLAUDE_USAGE_TAG', () => {
  it('compact-session.js injects CLAUDE_USAGE_TAG=compact-session', () => {
    const content = fs.readFileSync(path.join(ROOT, '.claude/hooks/lib/compact-session.js'), 'utf8');
    assert.ok(/CLAUDE_USAGE_TAG:\s*'compact-session'/.test(content),
      'compact-session.js should inject CLAUDE_USAGE_TAG');
    assert.ok(/CLAUDE_USAGE_PARENT:\s*sessionId/.test(content),
      'compact-session.js should inject CLAUDE_USAGE_PARENT');
  });

  it('release-report-generator.js injects CLAUDE_USAGE_TAG=release-report-generator', () => {
    const content = fs.readFileSync(path.join(ROOT, '.claude/hooks/lib/release-report-generator.js'), 'utf8');
    assert.ok(/CLAUDE_USAGE_TAG:\s*'release-report-generator'/.test(content),
      'release-report-generator.js should inject CLAUDE_USAGE_TAG');
  });

  it('live-feed-daemon.js injects CLAUDE_USAGE_TAG=live-feed-daemon', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/live-feed-daemon.js'), 'utf8');
    assert.ok(/CLAUDE_USAGE_TAG:\s*'live-feed-daemon'/.test(content),
      'live-feed-daemon.js should inject CLAUDE_USAGE_TAG');
  });
});

// ============================================================================
// llm-client wiring (env injection in execClaude)
// ============================================================================

describe('lib/llm-client.js', () => {
  const content = fs.readFileSync(path.join(ROOT, '.claude/hooks/lib/llm-client.js'), 'utf8');

  it('imports subprocess-call-tracker helpers', () => {
    assert.ok(/from '\.\/subprocess-call-tracker\.js'/.test(content));
    assert.ok(/startSubprocessCall/.test(content));
    assert.ok(/finishSubprocessCall/.test(content));
    assert.ok(/getCurrentParentSessionId/.test(content));
  });

  it('execClaude injects CLAUDE_USAGE_TAG into spawned env', () => {
    assert.ok(/CLAUDE_USAGE_TAG:\s*callerTag/.test(content),
      'execClaude should inject CLAUDE_USAGE_TAG from callerTag');
  });

  it('execClaude conditionally injects CLAUDE_USAGE_PARENT', () => {
    assert.ok(/if \(parentSessionId\) env\.CLAUDE_USAGE_PARENT = parentSessionId/.test(content),
      'CLAUDE_USAGE_PARENT should be injected only when available');
  });

  it('callLLM and callLLMStructured both resolve a caller tag', () => {
    const callLLMResolve = /callLLM\(prompt, systemPrompt, opts = \{\}\)[\s\S]*?resolveCallerTag\(opts, 'callLLM'\)/;
    const callLLMStructuredResolve = /callLLMStructured\(prompt, systemPrompt, jsonSchema, opts = \{\}\)[\s\S]*?resolveCallerTag\(opts, 'callLLMStructured'\)/;
    assert.ok(callLLMResolve.test(content), 'callLLM should call resolveCallerTag');
    assert.ok(callLLMStructuredResolve.test(content), 'callLLMStructured should call resolveCallerTag');
  });

  it('resolveCallerTag warns once per callsite for untagged usage', () => {
    assert.ok(/_untaggedWarned/.test(content), 'untagged warning Set defined');
    assert.ok(/_untaggedWarned\.has\(callsite\)/.test(content), 'warning check by callsite');
    assert.ok(/_untaggedWarned\.add\(callsite\)/.test(content), 'callsite added to Set on first warning');
  });
});
