#!/usr/bin/env node
/**
 * Product Manager MCP Server
 *
 * Manages product-market-fit analysis with:
 * - 6 sequential sections (market space, buyer personas, competitor
 *   differentiation, pricing models, niche strengths, user sentiment)
 * - CTO approval gate
 * - Pain-point-to-persona mapping and compliance reporting
 * - Auto-generated markdown summary
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
  LIST_SECTIONS,
  GetAnalysisStatusArgsSchema,
  InitiateAnalysisArgsSchema,
  ApproveAnalysisArgsSchema,
  ReadSectionArgsSchema,
  WriteSectionArgsSchema,
  AddEntryArgsSchema,
  UpdateEntryArgsSchema,
  DeleteEntryArgsSchema,
  ListPainPointsArgsSchema,
  MapPainPointPersonaArgsSchema,
  GetComplianceReportArgsSchema,
  ClearAndRespawnArgsSchema,
  RegenerateMdArgsSchema,
  type GetAnalysisStatusArgs,
  type InitiateAnalysisArgs,
  type ApproveAnalysisArgs,
  type ReadSectionArgs,
  type WriteSectionArgs,
  type AddEntryArgs,
  type UpdateEntryArgs,
  type DeleteEntryArgs,
  type ListPainPointsArgs,
  type MapPainPointPersonaArgs,
  type GetComplianceReportArgs,
  type ClearAndRespawnArgs,
  type RegenerateMdArgs,
  type AnalysisMetaRecord,
  type SectionRecord,
  type SectionEntryRecord,
  type PainPointPersonaRecord,
  type ErrorResult,
  type AnalysisStatusResult,
  type InitiateResult,
  type ApproveResult,
  type ReadSectionResult,
  type WriteSectionResult,
  type AddEntryResult,
  type UpdateEntryResult,
  type DeleteEntryResult,
  type ListPainPointsResult,
  type MapPainPointResult,
  type ComplianceReportResult,
  type ClearAndRespawnResult,
  type RegenerateMdResult,
  type SectionKey,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'product-manager.db');
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const USER_FEEDBACK_DB_PATH = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_meta (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'not_started',
    initiated_at TEXT,
    initiated_by TEXT,
    approved_at TEXT,
    approved_by TEXT,
    last_updated_at TEXT,
    md_path TEXT NOT NULL DEFAULT '.claude/product-market-fit.md',
    CONSTRAINT valid_status CHECK (status IN (
      'not_started','pending_approval','approved','in_progress','completed'
    ))
);

CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    section_number INTEGER NOT NULL UNIQUE,
    section_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT,
    populated_at TEXT,
    populated_by TEXT,
    updated_at TEXT,
    CONSTRAINT valid_section CHECK (section_number BETWEEN 1 AND 6)
);

CREATE TABLE IF NOT EXISTS section_entries (
    id TEXT PRIMARY KEY,
    section_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT valid_entry_section CHECK (section_number IN (2, 6))
);

CREATE INDEX IF NOT EXISTS idx_entries_section ON section_entries(section_number);

CREATE TABLE IF NOT EXISTS pain_point_personas (
    pain_point_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (pain_point_id, persona_id)
);

CREATE INDEX IF NOT EXISTS idx_ppp_pain_point ON pain_point_personas(pain_point_id);
`;

// ============================================================================
// Section seed data
// ============================================================================

const SECTION_SEEDS: Array<{ number: number; key: SectionKey; title: string }> = [
  { number: 1, key: 'market_space', title: 'Market Space & Players' },
  { number: 2, key: 'buyer_personas', title: 'Buyer Personas' },
  { number: 3, key: 'competitor_differentiation', title: 'Competitor Differentiation' },
  { number: 4, key: 'pricing_models', title: 'Pricing Models' },
  { number: 5, key: 'niche_strengths', title: 'Niche Strengths & Weaknesses' },
  { number: 6, key: 'user_sentiment', title: 'User Sentiment' },
];

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

function initializeDatabase(): Database.Database {
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // Seed sections if empty
  const sectionCount = (db.prepare('SELECT COUNT(*) as c FROM sections').get() as { c: number }).c;
  if (sectionCount === 0) {
    const insertSection = db.prepare(
      'INSERT INTO sections (id, section_number, section_key, title) VALUES (?, ?, ?, ?)'
    );
    for (const seed of SECTION_SEEDS) {
      insertSection.run(randomUUID(), seed.number, seed.key, seed.title);
    }
  }

  // Seed analysis_meta if empty
  const metaCount = (db.prepare('SELECT COUNT(*) as c FROM analysis_meta').get() as { c: number }).c;
  if (metaCount === 0) {
    db.prepare(
      'INSERT INTO analysis_meta (id, status, md_path) VALUES (?, ?, ?)'
    ).run('default', 'not_started', '.claude/product-market-fit.md');
  }

  return db;
}

function getDb(): Database.Database {
  if (!_db) {
    _db = initializeDatabase();
  }
  return _db;
}

function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function isListSection(sectionNumber: number): boolean {
  return (LIST_SECTIONS as readonly number[]).includes(sectionNumber);
}

function isSectionPopulated(db: Database.Database, sectionNumber: number): boolean {
  if (isListSection(sectionNumber)) {
    const count = (db.prepare(
      'SELECT COUNT(*) as c FROM section_entries WHERE section_number = ?'
    ).get(sectionNumber) as { c: number }).c;
    return count > 0;
  }
  const sec = db.prepare(
    'SELECT content FROM sections WHERE section_number = ?'
  ).get(sectionNumber) as { content: string | null } | undefined;
  return !!sec?.content;
}

function assertPreviousSectionsPopulated(db: Database.Database, targetNumber: number): string | null {
  for (let n = 1; n < targetNumber; n++) {
    if (!isSectionPopulated(db, n)) {
      return `Section ${n} must be populated first`;
    }
  }
  return null;
}

function updateLastUpdated(db: Database.Database): void {
  db.prepare(
    "UPDATE analysis_meta SET last_updated_at = ? WHERE id = 'default'"
  ).run(new Date().toISOString());
}

function getPopulatedCount(db: Database.Database): number {
  let count = 0;
  for (let n = 1; n <= 6; n++) {
    if (isSectionPopulated(db, n)) count++;
  }
  return count;
}

function getComplianceStats(db: Database.Database): { total_pain_points: number; mapped: number; unmapped: number; pct: number } | null {
  const total = (db.prepare(
    "SELECT COUNT(*) as c FROM section_entries WHERE section_number = 6"
  ).get() as { c: number }).c;

  if (total === 0) return null;

  const mapped = (db.prepare(
    "SELECT COUNT(DISTINCT pain_point_id) as c FROM pain_point_personas"
  ).get() as { c: number }).c;

  return {
    total_pain_points: total,
    mapped,
    unmapped: total - mapped,
    pct: Math.round((mapped / total) * 100),
  };
}

// ============================================================================
// Markdown Generation
// ============================================================================

function regenerateMarkdown(db: Database.Database): string {
  const meta = db.prepare("SELECT * FROM analysis_meta WHERE id = 'default'").get() as AnalysisMetaRecord;
  const mdPath = path.join(PROJECT_DIR, meta.md_path);

  const sections = db.prepare('SELECT * FROM sections ORDER BY section_number').all() as SectionRecord[];
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let md = `# Product-Market-Fit Analysis\n\n*Last updated: ${timestamp}*\n\n`;

  for (const section of sections) {
    md += `## Section ${section.section_number}: ${section.title}\n\n`;

    if (isListSection(section.section_number)) {
      const entries = db.prepare(
        'SELECT * FROM section_entries WHERE section_number = ? ORDER BY created_timestamp ASC'
      ).all(section.section_number) as SectionEntryRecord[];

      if (entries.length === 0) {
        md += '*Not yet populated*\n\n';
      } else {
        for (const entry of entries) {
          md += `### ${entry.title}\n\n${entry.content}\n\n`;
        }
      }
    } else {
      if (section.content) {
        md += `${section.content}\n\n`;
      } else {
        md += '*Not yet populated*\n\n';
      }
    }
  }

  // Write markdown file
  const mdDir = path.dirname(mdPath);
  if (!fs.existsSync(mdDir)) {
    fs.mkdirSync(mdDir, { recursive: true });
  }
  fs.writeFileSync(mdPath, md, 'utf8');

  return mdPath;
}

// ============================================================================
// Tool Implementations
// ============================================================================

function getAnalysisStatus(_args: GetAnalysisStatusArgs): AnalysisStatusResult | ErrorResult {
  const db = getDb();
  const meta = db.prepare("SELECT * FROM analysis_meta WHERE id = 'default'").get() as AnalysisMetaRecord | undefined;

  if (!meta) {
    return { error: 'Analysis metadata not found' };
  }

  const sections = db.prepare('SELECT * FROM sections ORDER BY section_number').all() as SectionRecord[];
  const sectionResults = sections.map(s => {
    const populated = isSectionPopulated(db, s.section_number);
    const result: AnalysisStatusResult['sections'][number] = {
      number: s.section_number,
      key: s.section_key,
      title: s.title,
      populated,
    };
    if (isListSection(s.section_number)) {
      result.entry_count = (db.prepare(
        'SELECT COUNT(*) as c FROM section_entries WHERE section_number = ?'
      ).get(s.section_number) as { c: number }).c;
    }
    return result;
  });

  return {
    status: meta.status as AnalysisStatusResult['status'],
    initiated_at: meta.initiated_at,
    initiated_by: meta.initiated_by,
    approved_at: meta.approved_at,
    approved_by: meta.approved_by,
    last_updated_at: meta.last_updated_at,
    sections_populated: getPopulatedCount(db),
    total_sections: 6,
    sections: sectionResults,
    compliance: getComplianceStats(db),
  };
}

function initiateAnalysis(args: InitiateAnalysisArgs): InitiateResult | ErrorResult {
  const db = getDb();
  const meta = db.prepare("SELECT * FROM analysis_meta WHERE id = 'default'").get() as AnalysisMetaRecord;

  if (meta.status !== 'not_started') {
    return { error: `Analysis already initiated (status: ${meta.status}). Use clear_and_respawn to restart.` };
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE analysis_meta SET status = 'pending_approval', initiated_at = ?, initiated_by = ?, last_updated_at = ? WHERE id = 'default'"
  ).run(now, args.initiated_by, now);

  return {
    status: 'pending_approval',
    initiated_at: now,
    initiated_by: args.initiated_by,
  };
}

function approveAnalysis(args: ApproveAnalysisArgs): ApproveResult | ErrorResult {
  const db = getDb();
  const meta = db.prepare("SELECT * FROM analysis_meta WHERE id = 'default'").get() as AnalysisMetaRecord;

  if (meta.status !== 'pending_approval') {
    return { error: `Cannot approve: current status is '${meta.status}', expected 'pending_approval'` };
  }

  const now = new Date().toISOString();
  db.prepare(
    "UPDATE analysis_meta SET status = 'approved', approved_at = ?, approved_by = ?, last_updated_at = ? WHERE id = 'default'"
  ).run(now, args.approved_by, now);

  return {
    status: 'approved',
    approved_at: now,
    approved_by: args.approved_by,
  };
}

function readSection(args: ReadSectionArgs): ReadSectionResult | ErrorResult {
  const db = getDb();
  const sectionNumber = args.section;

  if (sectionNumber < 1 || sectionNumber > 6) {
    return { error: `Invalid section number: ${sectionNumber}. Must be 1-6.` };
  }

  // Build context cascade: all sections 1..N-1
  const previousContext: ReadSectionResult['previous_context'] = [];
  for (let n = 1; n < sectionNumber; n++) {
    const sec = db.prepare('SELECT * FROM sections WHERE section_number = ?').get(n) as SectionRecord;
    const ctx: ReadSectionResult['previous_context'][number] = {
      number: sec.section_number,
      title: sec.title,
      content: sec.content,
    };
    if (isListSection(n)) {
      ctx.entries = (db.prepare(
        'SELECT title, content FROM section_entries WHERE section_number = ? ORDER BY created_timestamp ASC'
      ).all(n) as Array<{ title: string; content: string }>);
    }
    previousContext.push(ctx);
  }

  // Requested section
  const sec = db.prepare('SELECT * FROM sections WHERE section_number = ?').get(sectionNumber) as SectionRecord;
  const requested: ReadSectionResult['requested_section'] = {
    number: sec.section_number,
    key: sec.section_key,
    title: sec.title,
    content: sec.content,
  };
  if (isListSection(sectionNumber)) {
    requested.entries = (db.prepare(
      'SELECT id, title, content, metadata FROM section_entries WHERE section_number = ? ORDER BY created_timestamp ASC'
    ).all(sectionNumber) as Array<{ id: string; title: string; content: string; metadata: string }>);
  }

  return {
    previous_context: previousContext,
    requested_section: requested,
  };
}

function writeSection(args: WriteSectionArgs): WriteSectionResult | ErrorResult {
  const db = getDb();
  const sectionNumber = args.section;

  if (isListSection(sectionNumber)) {
    return { error: `Section ${sectionNumber} is a list section. Use add_entry instead.` };
  }

  // Check meta status
  const meta = db.prepare("SELECT status FROM analysis_meta WHERE id = 'default'").get() as { status: string };
  if (meta.status !== 'approved' && meta.status !== 'in_progress') {
    return { error: `Analysis must be approved or in-progress to write sections. Current status: ${meta.status}` };
  }

  // Sequential lock
  const lockError = assertPreviousSectionsPopulated(db, sectionNumber);
  if (lockError) {
    return { error: lockError };
  }

  const now = new Date().toISOString();
  db.prepare(
    'UPDATE sections SET content = ?, populated_at = ?, populated_by = ?, updated_at = ? WHERE section_number = ?'
  ).run(args.content, now, args.populated_by ?? null, now, sectionNumber);

  // Update meta status to in_progress if it was approved
  if (meta.status === 'approved') {
    db.prepare("UPDATE analysis_meta SET status = 'in_progress', last_updated_at = ? WHERE id = 'default'").run(now);
  } else {
    updateLastUpdated(db);
  }

  // Check if all sections populated -> mark completed
  if (getPopulatedCount(db) === 6) {
    db.prepare("UPDATE analysis_meta SET status = 'completed', last_updated_at = ? WHERE id = 'default'").run(now);
  }

  regenerateMarkdown(db);

  const sec = db.prepare('SELECT title FROM sections WHERE section_number = ?').get(sectionNumber) as { title: string };
  return {
    section_number: sectionNumber,
    title: sec.title,
    populated_at: now,
  };
}

function addEntry(args: AddEntryArgs): AddEntryResult | ErrorResult {
  const db = getDb();
  const sectionNumber = args.section;

  if (!isListSection(sectionNumber)) {
    return { error: `Section ${sectionNumber} is not a list section. Use write_section instead.` };
  }

  // Check meta status
  const meta = db.prepare("SELECT status FROM analysis_meta WHERE id = 'default'").get() as { status: string };
  if (meta.status !== 'approved' && meta.status !== 'in_progress') {
    return { error: `Analysis must be approved or in-progress to add entries. Current status: ${meta.status}` };
  }

  // Sequential lock
  const lockError = assertPreviousSectionsPopulated(db, sectionNumber);
  if (lockError) {
    return { error: lockError };
  }

  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  db.prepare(
    'INSERT INTO section_entries (id, section_number, title, content, metadata, created_at, created_timestamp, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, sectionNumber, args.title, args.content, args.metadata ?? '{}', created_at, created_timestamp, created_at);

  // Update meta status
  if (meta.status === 'approved') {
    db.prepare("UPDATE analysis_meta SET status = 'in_progress', last_updated_at = ? WHERE id = 'default'").run(created_at);
  } else {
    updateLastUpdated(db);
  }

  // Check completion
  if (getPopulatedCount(db) === 6) {
    db.prepare("UPDATE analysis_meta SET status = 'completed', last_updated_at = ? WHERE id = 'default'").run(created_at);
  }

  regenerateMarkdown(db);

  return {
    id,
    section_number: sectionNumber,
    title: args.title,
    created_at,
  };
}

function updateEntry(args: UpdateEntryArgs): UpdateEntryResult | ErrorResult {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM section_entries WHERE id = ?').get(args.id) as SectionEntryRecord | undefined;

  if (!entry) {
    return { error: `Entry not found: ${args.id}` };
  }

  const now = new Date().toISOString();
  const title = args.title ?? entry.title;
  const content = args.content ?? entry.content;
  const metadata = args.metadata ?? entry.metadata;

  db.prepare(
    'UPDATE section_entries SET title = ?, content = ?, metadata = ?, updated_at = ? WHERE id = ?'
  ).run(title, content, metadata, now, args.id);

  updateLastUpdated(db);
  regenerateMarkdown(db);

  return {
    id: args.id,
    updated_at: now,
  };
}

function deleteEntry(args: DeleteEntryArgs): DeleteEntryResult | ErrorResult {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM section_entries WHERE id = ?').get(args.id) as SectionEntryRecord | undefined;

  if (!entry) {
    return { error: `Entry not found: ${args.id}` };
  }

  // Also clean up any pain_point_persona mappings for this entry
  db.prepare('DELETE FROM pain_point_personas WHERE pain_point_id = ?').run(args.id);
  db.prepare('DELETE FROM section_entries WHERE id = ?').run(args.id);

  updateLastUpdated(db);
  regenerateMarkdown(db);

  return {
    deleted: true,
    id: args.id,
  };
}

function listPainPoints(args: ListPainPointsArgs): ListPainPointsResult | ErrorResult {
  const db = getDb();

  const entries = db.prepare(
    'SELECT * FROM section_entries WHERE section_number = 6 ORDER BY created_timestamp ASC'
  ).all() as SectionEntryRecord[];

  const mappings = db.prepare(
    'SELECT * FROM pain_point_personas'
  ).all() as PainPointPersonaRecord[];

  // Build mapping lookup
  const mappingsByPainPoint = new Map<string, string[]>();
  for (const m of mappings) {
    const list = mappingsByPainPoint.get(m.pain_point_id) ?? [];
    list.push(m.persona_id);
    mappingsByPainPoint.set(m.pain_point_id, list);
  }

  let painPoints = entries.map(e => ({
    id: e.id,
    title: e.title,
    content: e.content,
    metadata: e.metadata,
    created_at: e.created_at,
    mapped_personas: mappingsByPainPoint.get(e.id) ?? [],
  }));

  const unmappedCount = painPoints.filter(p => p.mapped_personas.length === 0).length;

  if (args.unmapped_only) {
    painPoints = painPoints.filter(p => p.mapped_personas.length === 0);
  }

  return {
    pain_points: painPoints,
    total: entries.length,
    unmapped_count: unmappedCount,
  };
}

function mapPainPointPersona(args: MapPainPointPersonaArgs): MapPainPointResult | ErrorResult {
  const db = getDb();

  // Verify pain point exists
  const entry = db.prepare(
    'SELECT id FROM section_entries WHERE id = ? AND section_number = 6'
  ).get(args.pain_point_id) as { id: string } | undefined;

  if (!entry) {
    return { error: `Pain point not found: ${args.pain_point_id}` };
  }

  // Verify persona exists via readonly read of user-feedback.db
  if (fs.existsSync(USER_FEEDBACK_DB_PATH)) {
    try {
      const feedbackDb = new Database(USER_FEEDBACK_DB_PATH, { readonly: true });
      const persona = feedbackDb.prepare('SELECT id FROM personas WHERE id = ?').get(args.persona_id) as { id: string } | undefined;
      feedbackDb.close();

      if (!persona) {
        return { error: `Persona not found in user-feedback.db: ${args.persona_id}` };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Could not verify persona in user-feedback.db: ${message}` };
    }
  }

  // Check if mapping already exists
  const existing = db.prepare(
    'SELECT pain_point_id FROM pain_point_personas WHERE pain_point_id = ? AND persona_id = ?'
  ).get(args.pain_point_id, args.persona_id);

  if (existing) {
    return { error: `Mapping already exists: pain_point=${args.pain_point_id}, persona=${args.persona_id}` };
  }

  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO pain_point_personas (pain_point_id, persona_id, created_at, created_by) VALUES (?, ?, ?, ?)'
  ).run(args.pain_point_id, args.persona_id, now, args.created_by);

  updateLastUpdated(db);

  return {
    pain_point_id: args.pain_point_id,
    persona_id: args.persona_id,
    created_at: now,
  };
}

function getComplianceReport(_args: GetComplianceReportArgs): ComplianceReportResult | ErrorResult {
  const db = getDb();

  const entries = db.prepare(
    'SELECT * FROM section_entries WHERE section_number = 6 ORDER BY created_timestamp ASC'
  ).all() as SectionEntryRecord[];

  if (entries.length === 0) {
    return {
      total_pain_points: 0,
      mapped: 0,
      unmapped: 0,
      compliance_pct: 100,
      pain_points: [],
    };
  }

  const mappings = db.prepare('SELECT * FROM pain_point_personas').all() as PainPointPersonaRecord[];
  const mappingsByPainPoint = new Map<string, string[]>();
  for (const m of mappings) {
    const list = mappingsByPainPoint.get(m.pain_point_id) ?? [];
    list.push(m.persona_id);
    mappingsByPainPoint.set(m.pain_point_id, list);
  }

  const painPoints = entries.map(e => ({
    id: e.id,
    title: e.title,
    mapped_personas: mappingsByPainPoint.get(e.id) ?? [],
  }));

  const mapped = painPoints.filter(p => p.mapped_personas.length > 0).length;
  const unmapped = entries.length - mapped;

  return {
    total_pain_points: entries.length,
    mapped,
    unmapped,
    compliance_pct: Math.round((mapped / entries.length) * 100),
    pain_points: painPoints,
  };
}

function clearAndRespawn(args: ClearAndRespawnArgs): ClearAndRespawnResult | ErrorResult {
  const db = getDb();

  // Clear all section content
  db.prepare('UPDATE sections SET content = NULL, populated_at = NULL, populated_by = NULL, updated_at = NULL').run();
  db.prepare('DELETE FROM section_entries').run();
  db.prepare('DELETE FROM pain_point_personas').run();

  // Update meta
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE analysis_meta SET status = 'in_progress', last_updated_at = ? WHERE id = 'default'"
  ).run(now);

  regenerateMarkdown(db);

  // Create first task in PRODUCT-MANAGER section via todo.db
  let taskId = 'no-todo-db';
  if (fs.existsSync(TODO_DB_PATH)) {
    try {
      const todoDb = new Database(TODO_DB_PATH);
      todoDb.pragma('journal_mode = WAL');
      taskId = randomUUID();
      const created_timestamp = Math.floor(Date.now() / 1000);

      const followupPrompt = `Section 1 (Market Space & Players) has been assigned to you. Research and populate it using web search and codebase analysis.

Steps:
1. Call mcp__product-manager__read_section({section: 1}) to see the current state
2. Research the market space via WebSearch
3. Call mcp__product-manager__write_section({section: 1, content: "..."}) with your findings
4. Mark this task complete

After completion, the follow-up chain will create Section 2's task.`;

      const section2Prompt = `Section 2 (Buyer Personas) is ready. Populate it using add_entry for each buyer persona.

Steps:
1. Call mcp__product-manager__read_section({section: 2}) to see context from Section 1
2. For each buyer persona, call mcp__product-manager__add_entry({section: 2, title: "...", content: "..."})
3. Mark this task complete

After completion, the follow-up chain will create Section 3's task.`;

      // Create Section 1 task with follow-up chain
      // Section 1 -> follow-up creates Section 2 -> ... -> Section 6 -> persona eval
      // We only create Section 1 now; the rest chain via followup_prompt
      todoDb.prepare(`
        INSERT INTO tasks (id, section, status, title, description, assigned_by, created_at, created_timestamp, followup_enabled, followup_section, followup_prompt)
        VALUES (?, 'PRODUCT-MANAGER', 'pending', ?, ?, ?, ?, ?, 1, 'PRODUCT-MANAGER', ?)
      `).run(
        taskId,
        '[PMF] Populate Section 1: Market Space & Players',
        followupPrompt,
        args.initiated_by,
        now,
        created_timestamp,
        section2Prompt
      );

      todoDb.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[product-manager] Warning: Could not create todo task: ${message}\n`);
    }
  }

  return {
    cleared: true,
    task_id: taskId,
    message: 'All section data cleared. Section 1 task created in PRODUCT-MANAGER queue.',
  };
}

function regenerateMd(_args: RegenerateMdArgs): RegenerateMdResult | ErrorResult {
  const db = getDb();
  const mdPath = regenerateMarkdown(db);

  return {
    path: mdPath,
    regenerated_at: new Date().toISOString(),
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'get_analysis_status',
    description: 'Get current PMF analysis status, section progress, and compliance stats.',
    schema: GetAnalysisStatusArgsSchema,
    handler: getAnalysisStatus,
  },
  {
    name: 'initiate_analysis',
    description: 'Initiate a new PMF analysis. Sets status to pending_approval. Agent should then report to deputy-CTO for approval.',
    schema: InitiateAnalysisArgsSchema,
    handler: initiateAnalysis,
  },
  {
    name: 'approve_analysis',
    description: 'Approve a pending PMF analysis. Called by deputy-CTO during triage.',
    schema: ApproveAnalysisArgsSchema,
    handler: approveAnalysis,
  },
  {
    name: 'read_section',
    description: 'Read a section with context cascade. Returns all prior sections (1..N-1) as context plus the requested section N.',
    schema: ReadSectionArgsSchema,
    handler: readSection,
  },
  {
    name: 'write_section',
    description: 'Write content to a single-content section (1, 3, 4, 5). Enforces sequential lock: all prior sections must be populated.',
    schema: WriteSectionArgsSchema,
    handler: writeSection,
  },
  {
    name: 'add_entry',
    description: 'Add an entry to a list section (2 or 6). Enforces sequential lock.',
    schema: AddEntryArgsSchema,
    handler: addEntry,
  },
  {
    name: 'update_entry',
    description: 'Update an existing entry in a list section.',
    schema: UpdateEntryArgsSchema,
    handler: updateEntry,
  },
  {
    name: 'delete_entry',
    description: 'Delete an entry from a list section. Also removes any pain-point-persona mappings.',
    schema: DeleteEntryArgsSchema,
    handler: deleteEntry,
  },
  {
    name: 'list_pain_points',
    description: 'List Section 6 (User Sentiment) entries with their persona mappings. Optionally filter to unmapped only.',
    schema: ListPainPointsArgsSchema,
    handler: listPainPoints,
  },
  {
    name: 'map_pain_point_persona',
    description: 'Map a Section 6 pain point to a persona. Validates persona exists in user-feedback.db.',
    schema: MapPainPointPersonaArgsSchema,
    handler: mapPainPointPersona,
  },
  {
    name: 'get_compliance_report',
    description: 'Get per-pain-point mapping status, unmapped count, and compliance percentage.',
    schema: GetComplianceReportArgsSchema,
    handler: getComplianceReport,
  },
  {
    name: 'clear_and_respawn',
    description: 'Clear all section data and create a follow-up task chain for sequential population of all 6 sections.',
    schema: ClearAndRespawnArgsSchema,
    handler: clearAndRespawn,
  },
  {
    name: 'regenerate_md',
    description: 'Force-regenerate the .claude/product-market-fit.md file from current database state.',
    schema: RegenerateMdArgsSchema,
    handler: regenerateMd,
  },
];

const server = new McpServer({
  name: 'product-manager',
  version: '1.0.0',
  tools,
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

server.start();
