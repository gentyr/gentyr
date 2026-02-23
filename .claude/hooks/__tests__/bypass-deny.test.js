/**
 * Tests for DENY BYPASS and CLEAR ALL BYPASS patterns in bypass-approval-hook.js
 *
 * Tests pattern matching, database operations for deny/clear,
 * and ensures non-bypass-request questions are untouched.
 *
 * Run: node --test .claude/hooks/__tests__/bypass-deny.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import better-sqlite3 for test database
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch {
  console.error('better-sqlite3 not available, skipping tests');
  process.exit(0);
}

// Schema matching deputy-cto server
const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    context TEXT,
    suggested_options TEXT,
    recommendation TEXT,
    answer TEXT,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    answered_at TEXT,
    decided_by TEXT,
    CONSTRAINT valid_type CHECK (type IN ('decision', 'approval', 'rejection', 'question', 'escalation', 'bypass-request', 'protected-action-request')),
    CONSTRAINT valid_status CHECK (status IN ('pending', 'answered')),
    CONSTRAINT valid_decided_by CHECK (decided_by IS NULL OR decided_by IN ('cto', 'deputy-cto'))
);
`;

// Patterns from bypass-approval-hook.js
const DENY_PATTERN = /DENY\s+BYPASS\s+([A-Z0-9]{6})/i;
const CLEAR_ALL_BYPASS_PATTERN = /CLEAR\s+ALL\s+BYPASS/i;
const APPROVAL_PATTERN = /APPROVE\s+BYPASS\s+([A-Z0-9]{6})/i;

// Helper to insert a question directly
function insertQuestion(db, { type, title, description, status = 'pending', context = null }) {
  const id = randomUUID();
  const now = new Date();
  db.prepare(`
    INSERT INTO questions (id, type, status, title, description, context, created_at, created_timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, type, status, title, description, context, now.toISOString(), Math.floor(now.getTime() / 1000));
  return id;
}

describe('DENY BYPASS pattern matching', () => {
  it('should match "DENY BYPASS ABCDEF"', () => {
    const match = 'DENY BYPASS ABCDEF'.match(DENY_PATTERN);
    assert.ok(match);
    assert.equal(match[1], 'ABCDEF');
  });

  it('should match case-insensitive "deny bypass abc123"', () => {
    const match = 'deny bypass abc123'.match(DENY_PATTERN);
    assert.ok(match);
    assert.equal(match[1], 'abc123');
  });

  it('should match with extra whitespace "DENY  BYPASS  MGXAUR"', () => {
    const match = 'DENY  BYPASS  MGXAUR'.match(DENY_PATTERN);
    assert.ok(match);
    assert.equal(match[1], 'MGXAUR');
  });

  it('should not match "DENY BYPASS" without code', () => {
    const match = 'DENY BYPASS'.match(DENY_PATTERN);
    assert.equal(match, null);
  });

  it('should not match "DENY BYPASS ABC" with short code', () => {
    const match = 'DENY BYPASS ABC'.match(DENY_PATTERN);
    assert.equal(match, null);
  });

  it('should not match "APPROVE BYPASS ABCDEF" (different command)', () => {
    const match = 'APPROVE BYPASS ABCDEF'.match(DENY_PATTERN);
    assert.equal(match, null);
  });

  it('should not collide with APPROVE BYPASS', () => {
    const input = 'APPROVE BYPASS ABC123';
    const approveMatch = input.match(APPROVAL_PATTERN);
    const denyMatch = input.match(DENY_PATTERN);
    assert.ok(approveMatch);
    assert.equal(denyMatch, null);
  });
});

describe('CLEAR ALL BYPASS pattern matching', () => {
  it('should match "CLEAR ALL BYPASS"', () => {
    const match = 'CLEAR ALL BYPASS'.match(CLEAR_ALL_BYPASS_PATTERN);
    assert.ok(match);
  });

  it('should match case-insensitive "clear all bypass"', () => {
    const match = 'clear all bypass'.match(CLEAR_ALL_BYPASS_PATTERN);
    assert.ok(match);
  });

  it('should match with extra whitespace "CLEAR  ALL  BYPASS"', () => {
    const match = 'CLEAR  ALL  BYPASS'.match(CLEAR_ALL_BYPASS_PATTERN);
    assert.ok(match);
  });

  it('should not match "CLEAR BYPASS" (missing ALL)', () => {
    const match = 'CLEAR BYPASS'.match(CLEAR_ALL_BYPASS_PATTERN);
    assert.equal(match, null);
  });

  it('should not match partial "CLEAR ALL"', () => {
    const match = 'CLEAR ALL'.match(CLEAR_ALL_BYPASS_PATTERN);
    assert.equal(match, null);
  });

  it('should not be confused with DENY BYPASS', () => {
    const input = 'CLEAR ALL BYPASS';
    const clearMatch = input.match(CLEAR_ALL_BYPASS_PATTERN);
    const denyMatch = input.match(DENY_PATTERN);
    assert.ok(clearMatch);
    assert.equal(denyMatch, null);
  });
});

describe('denyBypassRequest database operations', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  // Simulate denyBypassRequest using the same logic as bypass-approval-hook.js
  function denyBypassRequest(db, code) {
    const question = db.prepare(`
      SELECT id, title FROM questions
      WHERE type = 'bypass-request'
      AND status = 'pending'
      AND context = ?
    `).get(code);

    if (!question) {
      return { denied: false, reason: 'No pending bypass request with this code' };
    }

    db.prepare('DELETE FROM questions WHERE id = ?').run(question.id);
    return { denied: true, title: question.title, reason: 'Denied by CTO' };
  }

  it('should deny a pending bypass-request with valid code', () => {
    insertQuestion(db, {
      type: 'bypass-request',
      title: 'Bypass: agent stuck',
      description: 'Agent needs bypass',
      context: 'MGXAUR',
    });

    const result = denyBypassRequest(db, 'MGXAUR');

    assert.equal(result.denied, true);
    assert.equal(result.title, 'Bypass: agent stuck');

    // Verify deleted
    const count = db.prepare("SELECT COUNT(*) as count FROM questions").get();
    assert.equal(count.count, 0);
  });

  it('should fail for non-existent code', () => {
    const result = denyBypassRequest(db, 'NOPE01');

    assert.equal(result.denied, false);
    assert.ok(result.reason.includes('No pending bypass request'));
  });

  it('should not deny answered bypass-requests', () => {
    insertQuestion(db, {
      type: 'bypass-request',
      title: 'Answered bypass',
      description: 'Already handled',
      status: 'answered',
      context: 'ANS001',
    });

    const result = denyBypassRequest(db, 'ANS001');

    assert.equal(result.denied, false);

    // Verify the question still exists
    const count = db.prepare("SELECT COUNT(*) as count FROM questions").get();
    assert.equal(count.count, 1);
  });

  it('should not affect non-bypass-request questions', () => {
    const decisionId = insertQuestion(db, {
      type: 'decision',
      title: 'Important decision',
      description: 'Needs CTO input',
    });

    insertQuestion(db, {
      type: 'bypass-request',
      title: 'Bypass to deny',
      description: 'Agent bypass',
      context: 'DENY01',
    });

    const result = denyBypassRequest(db, 'DENY01');
    assert.equal(result.denied, true);

    // Verify decision question still exists
    const decision = db.prepare("SELECT * FROM questions WHERE id = ?").get(decisionId);
    assert.ok(decision);
    assert.equal(decision.type, 'decision');
  });
});

describe('clearAllBypassRequests database operations', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
  });

  // Simulate clearAllBypassRequests using the same logic
  function clearAllBypassRequests(db) {
    const result = db.prepare(`
      DELETE FROM questions
      WHERE type = 'bypass-request' AND status = 'pending'
    `).run();
    return { cleared: true, count: result.changes };
  }

  it('should clear all pending bypass-requests', () => {
    for (let i = 0; i < 3; i++) {
      insertQuestion(db, {
        type: 'bypass-request',
        title: `Bypass ${i}`,
        description: `From agent ${i}`,
        context: `CODE0${i}`,
      });
    }

    const result = clearAllBypassRequests(db);

    assert.equal(result.cleared, true);
    assert.equal(result.count, 3);

    const count = db.prepare("SELECT COUNT(*) as count FROM questions").get();
    assert.equal(count.count, 0);
  });

  it('should return count 0 when no pending bypass-requests exist', () => {
    const result = clearAllBypassRequests(db);

    assert.equal(result.cleared, true);
    assert.equal(result.count, 0);
  });

  it('should not clear answered bypass-requests', () => {
    insertQuestion(db, {
      type: 'bypass-request',
      title: 'Pending bypass',
      description: 'Should be cleared',
      context: 'PEND01',
    });

    insertQuestion(db, {
      type: 'bypass-request',
      title: 'Answered bypass',
      description: 'Should be kept',
      status: 'answered',
      context: 'ANSW01',
    });

    const result = clearAllBypassRequests(db);

    assert.equal(result.count, 1); // Only the pending one

    // Verify the answered one still exists
    const remaining = db.prepare("SELECT * FROM questions").all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].status, 'answered');
  });

  it('should not affect non-bypass-request questions', () => {
    insertQuestion(db, {
      type: 'decision',
      title: 'Important decision',
      description: 'Needs CTO input',
    });

    insertQuestion(db, {
      type: 'rejection',
      title: 'Rejected commit',
      description: 'Fix needed',
    });

    insertQuestion(db, {
      type: 'bypass-request',
      title: 'Bypass to clear',
      description: 'Agent bypass',
      context: 'CLR001',
    });

    const result = clearAllBypassRequests(db);

    assert.equal(result.count, 1); // Only the bypass-request

    // Verify other questions still exist
    const remaining = db.prepare("SELECT * FROM questions").all();
    assert.equal(remaining.length, 2);
    assert.ok(remaining.some(q => q.type === 'decision'));
    assert.ok(remaining.some(q => q.type === 'rejection'));
  });
});
