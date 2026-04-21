#!/usr/bin/env node
/**
 * Investigation Log MCP Server
 *
 * Tracks hypotheses tested and solutions proven across agent sessions.
 * Prevents redundant re-investigation by providing searchable records
 * of what was tried, what worked, and what was eliminated.
 *
 * Designed to address the "knowledge persistence" gap identified in the
 * AWS demo automation case study, where agents re-investigated the same
 * root causes 6-12+ times across 23 days because no durable record existed.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  LogHypothesisArgsSchema,
  SearchHypothesesArgsSchema,
  LogSolutionArgsSchema,
  SearchSolutionsArgsSchema,
  GetInvestigationContextArgsSchema,
  type LogHypothesisArgs,
  type SearchHypothesesArgs,
  type LogSolutionArgs,
  type SearchSolutionsArgs,
  type GetInvestigationContextArgs,
  type HypothesisRecord,
  type SolutionRecord,
  type InvestigationContext,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'investigation-log.db');
const AGENT_ID = process.env.CLAUDE_AGENT_ID || '';
const SESSION_ID = process.env.CLAUDE_SESSION_ID || '';

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  persistent_task_id TEXT,
  symptom TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  test_performed TEXT,
  result TEXT,
  conclusion TEXT NOT NULL DEFAULT 'inconclusive',
  root_cause_tag TEXT,
  created_at TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT,
  CONSTRAINT valid_conclusion CHECK (conclusion IN ('confirmed', 'eliminated', 'inconclusive'))
);

CREATE TABLE IF NOT EXISTS solutions (
  id TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  files TEXT,
  pr_number INTEGER,
  root_cause_tag TEXT,
  verified_count INTEGER NOT NULL DEFAULT 1,
  promoted_to_tool TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_tag ON hypotheses(root_cause_tag);
CREATE INDEX IF NOT EXISTS idx_hypotheses_conclusion ON hypotheses(conclusion);
CREATE INDEX IF NOT EXISTS idx_hypotheses_task ON hypotheses(persistent_task_id);
CREATE INDEX IF NOT EXISTS idx_solutions_tag ON solutions(root_cause_tag);
CREATE INDEX IF NOT EXISTS idx_solutions_promoted ON solutions(promoted_to_tool);
`;

// FTS5 tables for full-text search
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS hypotheses_fts USING fts5(
  symptom, hypothesis, result,
  content=hypotheses,
  content_rowid=rowid
);

CREATE VIRTUAL TABLE IF NOT EXISTS solutions_fts USING fts5(
  problem, solution,
  content=solutions,
  content_rowid=rowid
);
`;

// Triggers to keep FTS in sync
const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS hypotheses_ai AFTER INSERT ON hypotheses BEGIN
  INSERT INTO hypotheses_fts(rowid, symptom, hypothesis, result)
  VALUES (new.rowid, new.symptom, new.hypothesis, new.result);
END;

CREATE TRIGGER IF NOT EXISTS hypotheses_ad AFTER DELETE ON hypotheses BEGIN
  INSERT INTO hypotheses_fts(hypotheses_fts, rowid, symptom, hypothesis, result)
  VALUES ('delete', old.rowid, old.symptom, old.hypothesis, old.result);
END;

CREATE TRIGGER IF NOT EXISTS solutions_ai AFTER INSERT ON solutions BEGIN
  INSERT INTO solutions_fts(rowid, problem, solution)
  VALUES (new.rowid, new.problem, new.solution);
END;

CREATE TRIGGER IF NOT EXISTS solutions_ad AFTER DELETE ON solutions BEGIN
  INSERT INTO solutions_fts(solutions_fts, rowid, problem, solution)
  VALUES ('delete', old.rowid, old.problem, old.solution);
END;
`;

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');

  _db.exec(SCHEMA);

  // FTS5 setup — wrapped in try/catch since FTS5 may not be available
  try {
    _db.exec(FTS_SCHEMA);
    _db.exec(FTS_TRIGGERS);
  } catch {
    // FTS5 not available — fall back to LIKE queries
  }

  return _db;
}

function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function hasFts(db: Database.Database): boolean {
  try {
    db.prepare("SELECT * FROM hypotheses_fts LIMIT 0").run();
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

function logHypothesis(args: LogHypothesisArgs): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO hypotheses (id, persistent_task_id, symptom, hypothesis, test_performed, result, conclusion, root_cause_tag, created_at, agent_id, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    args.persistent_task_id || null,
    args.symptom,
    args.hypothesis,
    args.test_performed || null,
    args.result || null,
    args.conclusion,
    args.root_cause_tag || null,
    now,
    AGENT_ID || null,
    SESSION_ID || null,
  );

  return JSON.stringify({
    id,
    conclusion: args.conclusion,
    message: `Hypothesis logged as ${args.conclusion}. ${args.root_cause_tag ? `Tag: ${args.root_cause_tag}` : 'No tag set — consider adding a root_cause_tag for grouping.'}`,
  });
}

function searchHypotheses(args: SearchHypothesesArgs): string {
  const db = getDb();
  const useFts = hasFts(db);
  let rows: HypothesisRecord[];

  if (useFts && args.query) {
    // FTS5 ranked search
    const conditions: string[] = [];
    const params: unknown[] = [];

    conditions.push('h.rowid IN (SELECT rowid FROM hypotheses_fts WHERE hypotheses_fts MATCH ?)');
    // Escape FTS5 special characters
    const safeQuery = args.query.replace(/['"*(){}[\]^~\\]/g, ' ').trim();
    params.push(safeQuery);

    if (args.root_cause_tag) {
      conditions.push('h.root_cause_tag = ?');
      params.push(args.root_cause_tag);
    }
    if (args.conclusion) {
      conditions.push('h.conclusion = ?');
      params.push(args.conclusion);
    }

    params.push(args.limit);

    rows = db.prepare(`
      SELECT h.* FROM hypotheses h
      WHERE ${conditions.join(' AND ')}
      ORDER BY h.created_at DESC
      LIMIT ?
    `).all(...params) as HypothesisRecord[];
  } else {
    // LIKE fallback
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.query) {
      conditions.push('(h.symptom LIKE ? OR h.hypothesis LIKE ? OR h.result LIKE ?)');
      const pattern = `%${args.query}%`;
      params.push(pattern, pattern, pattern);
    }
    if (args.root_cause_tag) {
      conditions.push('h.root_cause_tag = ?');
      params.push(args.root_cause_tag);
    }
    if (args.conclusion) {
      conditions.push('h.conclusion = ?');
      params.push(args.conclusion);
    }

    params.push(args.limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT h.* FROM hypotheses h
      ${where}
      ORDER BY h.created_at DESC
      LIMIT ?
    `).all(...params) as HypothesisRecord[];
  }

  return JSON.stringify({
    count: rows.length,
    hypotheses: rows.map(r => ({
      id: r.id,
      symptom: r.symptom,
      hypothesis: r.hypothesis,
      conclusion: r.conclusion,
      test_performed: r.test_performed,
      result: r.result,
      root_cause_tag: r.root_cause_tag,
      created_at: r.created_at,
    })),
  });
}

function logSolution(args: LogSolutionArgs): string {
  const db = getDb();

  // Check for existing solution with similar problem description + same tag
  if (args.root_cause_tag) {
    const existing = db.prepare(
      "SELECT id, verified_count FROM solutions WHERE root_cause_tag = ? AND problem LIKE ? LIMIT 1"
    ).get(args.root_cause_tag, `%${args.problem.slice(0, 50)}%`) as { id: string; verified_count: number } | undefined;

    if (existing) {
      // Increment verified_count instead of creating a duplicate
      db.prepare("UPDATE solutions SET verified_count = verified_count + 1 WHERE id = ?").run(existing.id);
      return JSON.stringify({
        id: existing.id,
        verified_count: existing.verified_count + 1,
        message: `Existing solution found and verified_count incremented to ${existing.verified_count + 1}. Solution reuse prevents knowledge fragmentation.`,
      });
    }
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO solutions (id, problem, solution, files, pr_number, root_cause_tag, verified_count, promoted_to_tool, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    args.problem,
    args.solution,
    args.files ? JSON.stringify(args.files) : null,
    args.pr_number || null,
    args.root_cause_tag || null,
    args.promoted_to_tool || null,
    now,
  );

  return JSON.stringify({
    id,
    verified_count: 1,
    message: 'Solution logged. Future agents searching for this problem will find your solution.',
  });
}

function searchSolutions(args: SearchSolutionsArgs): string {
  const db = getDb();
  const useFts = hasFts(db);
  let rows: SolutionRecord[];

  if (useFts && args.query) {
    const conditions: string[] = [];
    const params: unknown[] = [];

    conditions.push('s.rowid IN (SELECT rowid FROM solutions_fts WHERE solutions_fts MATCH ?)');
    const safeQuery = args.query.replace(/['"*(){}[\]^~\\]/g, ' ').trim();
    params.push(safeQuery);

    if (args.root_cause_tag) {
      conditions.push('s.root_cause_tag = ?');
      params.push(args.root_cause_tag);
    }

    params.push(args.limit);

    rows = db.prepare(`
      SELECT s.* FROM solutions s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.verified_count DESC, s.created_at DESC
      LIMIT ?
    `).all(...params) as SolutionRecord[];
  } else {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.query) {
      conditions.push('(s.problem LIKE ? OR s.solution LIKE ?)');
      const pattern = `%${args.query}%`;
      params.push(pattern, pattern);
    }
    if (args.root_cause_tag) {
      conditions.push('s.root_cause_tag = ?');
      params.push(args.root_cause_tag);
    }

    params.push(args.limit);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    rows = db.prepare(`
      SELECT s.* FROM solutions s
      ${where}
      ORDER BY s.verified_count DESC, s.created_at DESC
      LIMIT ?
    `).all(...params) as SolutionRecord[];
  }

  return JSON.stringify({
    count: rows.length,
    solutions: rows.map(r => ({
      id: r.id,
      problem: r.problem,
      solution: r.solution,
      files: r.files ? JSON.parse(r.files) : null,
      pr_number: r.pr_number,
      root_cause_tag: r.root_cause_tag,
      verified_count: r.verified_count,
      promoted_to_tool: r.promoted_to_tool,
      created_at: r.created_at,
    })),
  });
}

function getInvestigationContext(args: GetInvestigationContextArgs): string {
  const db = getDb();
  const useFts = hasFts(db);
  const safeQuery = args.symptom.replace(/['"*(){}[\]^~\\]/g, ' ').trim();

  let hypotheses: HypothesisRecord[];
  let solutions: SolutionRecord[];

  if (useFts) {
    hypotheses = db.prepare(`
      SELECT h.* FROM hypotheses h
      WHERE h.rowid IN (SELECT rowid FROM hypotheses_fts WHERE hypotheses_fts MATCH ?)
      ORDER BY CASE h.conclusion WHEN 'confirmed' THEN 0 WHEN 'eliminated' THEN 1 ELSE 2 END, h.created_at DESC
      LIMIT ?
    `).all(safeQuery, args.limit) as HypothesisRecord[];

    solutions = db.prepare(`
      SELECT s.* FROM solutions s
      WHERE s.rowid IN (SELECT rowid FROM solutions_fts WHERE solutions_fts MATCH ?)
      ORDER BY s.verified_count DESC, s.created_at DESC
      LIMIT ?
    `).all(safeQuery, args.limit) as SolutionRecord[];
  } else {
    const pattern = `%${args.symptom}%`;
    hypotheses = db.prepare(`
      SELECT * FROM hypotheses
      WHERE symptom LIKE ? OR hypothesis LIKE ?
      ORDER BY CASE conclusion WHEN 'confirmed' THEN 0 WHEN 'eliminated' THEN 1 ELSE 2 END, created_at DESC
      LIMIT ?
    `).all(pattern, pattern, args.limit) as HypothesisRecord[];

    solutions = db.prepare(`
      SELECT * FROM solutions
      WHERE problem LIKE ? OR solution LIKE ?
      ORDER BY verified_count DESC, created_at DESC
      LIMIT ?
    `).all(pattern, pattern, args.limit) as SolutionRecord[];
  }

  // Build human-readable summary
  const summaryParts: string[] = [];

  const confirmed = hypotheses.filter(h => h.conclusion === 'confirmed');
  const eliminated = hypotheses.filter(h => h.conclusion === 'eliminated');

  if (confirmed.length > 0) {
    summaryParts.push(`CONFIRMED root causes: ${confirmed.map(h => h.hypothesis).join('; ')}`);
  }
  if (eliminated.length > 0) {
    summaryParts.push(`ELIMINATED hypotheses (do not re-investigate): ${eliminated.map(h => h.hypothesis).join('; ')}`);
  }
  if (solutions.length > 0) {
    const topSolution = solutions[0];
    const toolNote = topSolution.promoted_to_tool ? ` (available as MCP tool: ${topSolution.promoted_to_tool})` : '';
    summaryParts.push(`PROVEN solution (verified ${topSolution.verified_count}x): ${topSolution.solution}${toolNote}`);
  }
  if (hypotheses.length === 0 && solutions.length === 0) {
    summaryParts.push('No prior investigation data found for this symptom. After diagnosing, call log_hypothesis to record your findings for future agents.');
  }

  const result: InvestigationContext = {
    hypotheses: hypotheses.map(h => ({
      id: h.id,
      persistent_task_id: h.persistent_task_id,
      symptom: h.symptom,
      hypothesis: h.hypothesis,
      test_performed: h.test_performed,
      result: h.result,
      conclusion: h.conclusion,
      root_cause_tag: h.root_cause_tag,
      created_at: h.created_at,
      agent_id: h.agent_id,
      session_id: h.session_id,
    })),
    solutions: solutions.map(s => ({
      id: s.id,
      problem: s.problem,
      solution: s.solution,
      files: s.files,
      pr_number: s.pr_number,
      root_cause_tag: s.root_cause_tag,
      verified_count: s.verified_count,
      promoted_to_tool: s.promoted_to_tool,
      created_at: s.created_at,
    })),
    summary: summaryParts.join('\n'),
  };

  return JSON.stringify(result);
}

// ============================================================================
// Tool Definitions
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'log_hypothesis',
    description: 'Record a hypothesis that was tested during an investigation. Captures symptom, hypothesis, test, result, and conclusion (confirmed/eliminated/inconclusive). This prevents future agents from re-investigating hypotheses that have already been tested.',
    schema: LogHypothesisArgsSchema,
    handler: logHypothesis,
  },
  {
    name: 'search_hypotheses',
    description: 'Search for prior hypotheses by symptom text, root cause tag, or conclusion. Use this BEFORE starting an investigation to check what has already been tried. Returns hypotheses ranked by recency.',
    schema: SearchHypothesesArgsSchema,
    handler: searchHypotheses,
  },
  {
    name: 'log_solution',
    description: 'Record a proven solution for a problem. If a solution with the same root_cause_tag and similar problem already exists, increments its verified_count instead of creating a duplicate. Solutions with higher verified_count are ranked first in search results.',
    schema: LogSolutionArgsSchema,
    handler: logSolution,
  },
  {
    name: 'search_solutions',
    description: 'Search for proven solutions by problem description or root cause tag. Returns solutions ranked by verified_count (most-proven first). Check promoted_to_tool to see if a solution has been promoted to a framework-level MCP tool.',
    schema: SearchSolutionsArgsSchema,
    handler: searchSolutions,
  },
  {
    name: 'get_investigation_context',
    description: 'Get a comprehensive context block for a symptom: all related hypotheses (confirmed, eliminated, inconclusive) and proven solutions. Returns a human-readable summary suitable for injecting into agent prompts. Use this at the start of any investigation or when creating sub-tasks.',
    schema: GetInvestigationContextArgsSchema,
    handler: getInvestigationContext,
  },
];

// ============================================================================
// Server Setup
// ============================================================================

const server = new McpServer({
  name: 'investigation-log',
  version: '1.0.0',
  tools,
});

process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

// Conditional stdio start — suppressed when running inside the shared daemon
if (!process.env.MCP_SHARED_DAEMON) {
  server.start();
}
