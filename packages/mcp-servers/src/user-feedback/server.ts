#!/usr/bin/env node
/**
 * User Feedback MCP Server
 *
 * Manages personas, features, persona-feature mappings, feedback runs,
 * and feedback sessions for the AI User Feedback System.
 *
 * Flow:
 * 1. Configure personas and features via CRUD tools
 * 2. Map personas to features they test
 * 3. Trigger feedback runs (manual, staging-push, scheduled)
 * 4. Track feedback sessions per persona
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
  CreatePersonaArgsSchema,
  UpdatePersonaArgsSchema,
  DeletePersonaArgsSchema,
  GetPersonaArgsSchema,
  ListPersonasArgsSchema,
  RegisterFeatureArgsSchema,
  ListFeaturesArgsSchema,
  DeleteFeatureArgsSchema,
  MapPersonaFeatureArgsSchema,
  UnmapPersonaFeatureArgsSchema,
  GetPersonasForChangesArgsSchema,
  StartFeedbackRunArgsSchema,
  GetFeedbackRunArgsSchema,
  ListFeedbackRunsArgsSchema,
  CompleteFeedbackSessionArgsSchema,
  GetFeedbackRunSummaryArgsSchema,
  GetSessionAuditArgsSchema,
  type CreatePersonaArgs,
  type UpdatePersonaArgs,
  type DeletePersonaArgs,
  type GetPersonaArgs,
  type ListPersonasArgs,
  type RegisterFeatureArgs,
  type ListFeaturesArgs,
  type DeleteFeatureArgs,
  type MapPersonaFeatureArgs,
  type UnmapPersonaFeatureArgs,
  type GetPersonasForChangesArgs,
  type StartFeedbackRunArgs,
  type GetFeedbackRunArgs,
  type ListFeedbackRunsArgs,
  type CompleteFeedbackSessionArgs,
  type GetFeedbackRunSummaryArgs,
  type GetSessionAuditArgs,
  type PersonaRecord,
  type FeatureRecord,
  type PersonaFeatureRecord,
  type FeedbackRunRecord,
  type FeedbackSessionRecord,
  type ErrorResult,
  type PersonaResult,
  type FeatureResult,
  type PersonaForChangeResult,
  type FeedbackRunResult,
  type FeedbackRunSummaryResult,
  type GetSessionAuditResult,
  type McpAuditAction,
  type ConsumptionMode,
  type FeedbackRunStatus,
} from './types.js';

// ============================================================================
// Configuration (F001 Compliance)
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const DB_PATH = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    consumption_mode TEXT NOT NULL DEFAULT 'gui',
    behavior_traits TEXT NOT NULL DEFAULT '[]',
    endpoints TEXT NOT NULL DEFAULT '[]',
    credentials_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT valid_mode CHECK (consumption_mode IN ('gui', 'cli', 'api', 'sdk'))
);

CREATE INDEX IF NOT EXISTS idx_personas_mode ON personas(consumption_mode);
CREATE INDEX IF NOT EXISTS idx_personas_enabled ON personas(enabled);

CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    file_patterns TEXT NOT NULL DEFAULT '[]',
    url_patterns TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    created_at TEXT NOT NULL,
    created_timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_features_category ON features(category);

CREATE TABLE IF NOT EXISTS persona_features (
    persona_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    test_scenarios TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (persona_id, feature_id),
    FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
    FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE,
    CONSTRAINT valid_priority CHECK (priority IN ('low', 'normal', 'high', 'critical'))
);

CREATE TABLE IF NOT EXISTS feedback_runs (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    trigger_ref TEXT,
    changed_features TEXT NOT NULL DEFAULT '[]',
    personas_triggered TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    max_concurrent INTEGER NOT NULL DEFAULT 3,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    summary TEXT,
    CONSTRAINT valid_status CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON feedback_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started ON feedback_runs(started_at);

CREATE TABLE IF NOT EXISTS feedback_sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    persona_id TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    started_at TEXT,
    completed_at TEXT,
    findings_count INTEGER DEFAULT 0,
    report_ids TEXT DEFAULT '[]',
    CONSTRAINT valid_status CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'timeout')),
    FOREIGN KEY (run_id) REFERENCES feedback_runs(id),
    FOREIGN KEY (persona_id) REFERENCES personas(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_run ON feedback_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON feedback_sessions(status);
`;

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
// Glob Matching Utility
// ============================================================================

/**
 * Simple glob matching for file patterns.
 * Supports * (any chars except /) and ** (any chars including /).
 */
function globMatch(pattern: string, filePath: string): boolean {
  // Normalize separators
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const normalizedPath = filePath.replace(/\\/g, '/');

  // Convert glob to regex
  let regex = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special regex chars (except * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temporary placeholder for **
    .replace(/\*/g, '[^/]*')                 // * matches anything except /
    .replace(/\?/g, '[^/]')                  // ? matches single char except /
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');     // ** matches anything including /

  regex = `^${regex}$`;

  try {
    return new RegExp(regex).test(normalizedPath);
  } catch {
    return false;
  }
}

// ============================================================================
// Helper: Record to Result Conversion
// ============================================================================

function personaToResult(record: PersonaRecord): PersonaResult {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    consumption_mode: record.consumption_mode,
    behavior_traits: JSON.parse(record.behavior_traits) as string[],
    endpoints: JSON.parse(record.endpoints) as string[],
    credentials_ref: record.credentials_ref,
    enabled: record.enabled === 1,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function featureToResult(record: FeatureRecord): FeatureResult {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    file_patterns: JSON.parse(record.file_patterns) as string[],
    url_patterns: JSON.parse(record.url_patterns) as string[],
    category: record.category,
    created_at: record.created_at,
  };
}

// ============================================================================
// Persona CRUD
// ============================================================================

function createPersona(args: CreatePersonaArgs): PersonaResult | ErrorResult {
  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  try {
    db.prepare(`
      INSERT INTO personas (id, name, description, consumption_mode, behavior_traits, endpoints, credentials_ref, created_at, created_timestamp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.name,
      args.description,
      args.consumption_mode,
      JSON.stringify(args.behavior_traits ?? []),
      JSON.stringify(args.endpoints ?? []),
      args.credentials_ref ?? null,
      created_at,
      created_timestamp,
      created_at,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return { error: `Persona with name "${args.name}" already exists` };
    }
    return { error: `Failed to create persona: ${message}` };
  }

  const record = db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as PersonaRecord;
  return personaToResult(record);
}

function updatePersona(args: UpdatePersonaArgs): PersonaResult | ErrorResult {
  const db = getDb();
  const record = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.id) as PersonaRecord | undefined;

  if (!record) {
    return { error: `Persona not found: ${args.id}` };
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (args.name !== undefined) { updates.push('name = ?'); params.push(args.name); }
  if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
  if (args.consumption_mode !== undefined) { updates.push('consumption_mode = ?'); params.push(args.consumption_mode); }
  if (args.behavior_traits !== undefined) { updates.push('behavior_traits = ?'); params.push(JSON.stringify(args.behavior_traits)); }
  if (args.endpoints !== undefined) { updates.push('endpoints = ?'); params.push(JSON.stringify(args.endpoints)); }
  if (args.credentials_ref !== undefined) { updates.push('credentials_ref = ?'); params.push(args.credentials_ref); }
  if (args.enabled !== undefined) { updates.push('enabled = ?'); params.push(args.enabled ? 1 : 0); }

  if (updates.length === 0) {
    return { error: 'No fields to update' };
  }

  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(args.id);

  try {
    db.prepare(`UPDATE personas SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return { error: `Persona with name "${args.name}" already exists` };
    }
    return { error: `Failed to update persona: ${message}` };
  }

  const updated = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.id) as PersonaRecord;
  return personaToResult(updated);
}

function deletePersona(args: DeletePersonaArgs): { deleted: boolean; message: string } | ErrorResult {
  const db = getDb();
  const record = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.id) as PersonaRecord | undefined;

  if (!record) {
    return { error: `Persona not found: ${args.id}` };
  }

  // Cascade deletes persona_features entries via FK constraint
  db.prepare('DELETE FROM personas WHERE id = ?').run(args.id);

  return { deleted: true, message: `Persona "${record.name}" deleted` };
}

function getPersona(args: GetPersonaArgs): PersonaResult | ErrorResult {
  const db = getDb();
  const record = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.id) as PersonaRecord | undefined;

  if (!record) {
    return { error: `Persona not found: ${args.id}` };
  }

  const result = personaToResult(record);

  // Include feature mappings
  const mappings = db.prepare(`
    SELECT pf.feature_id, pf.priority, pf.test_scenarios, f.name as feature_name
    FROM persona_features pf
    JOIN features f ON f.id = pf.feature_id
    WHERE pf.persona_id = ?
  `).all(args.id) as (PersonaFeatureRecord & { feature_name: string })[];

  result.features = mappings.map(m => ({
    feature_id: m.feature_id,
    feature_name: m.feature_name,
    priority: m.priority,
    test_scenarios: JSON.parse(m.test_scenarios) as string[],
  }));

  return result;
}

function listPersonas(args: ListPersonasArgs): { personas: PersonaResult[]; total: number } {
  const db = getDb();

  let sql = 'SELECT * FROM personas';
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (args.enabled_only) {
    conditions.push('enabled = 1');
  }
  if (args.consumption_mode) {
    conditions.push('consumption_mode = ?');
    params.push(args.consumption_mode);
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  sql += ' ORDER BY created_timestamp DESC LIMIT ?';
  params.push(args.limit ?? 50);

  const records = db.prepare(sql).all(...params) as PersonaRecord[];

  return {
    personas: records.map(personaToResult),
    total: records.length,
  };
}

// ============================================================================
// Feature CRUD
// ============================================================================

function registerFeature(args: RegisterFeatureArgs): FeatureResult | ErrorResult {
  const db = getDb();
  const id = randomUUID();
  const now = new Date();
  const created_at = now.toISOString();
  const created_timestamp = Math.floor(now.getTime() / 1000);

  try {
    db.prepare(`
      INSERT INTO features (id, name, description, file_patterns, url_patterns, category, created_at, created_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      args.name,
      args.description ?? null,
      JSON.stringify(args.file_patterns),
      JSON.stringify(args.url_patterns ?? []),
      args.category ?? null,
      created_at,
      created_timestamp,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint')) {
      return { error: `Feature with name "${args.name}" already exists` };
    }
    return { error: `Failed to register feature: ${message}` };
  }

  const record = db.prepare('SELECT * FROM features WHERE id = ?').get(id) as FeatureRecord;
  return featureToResult(record);
}

function listFeatures(args: ListFeaturesArgs): { features: FeatureResult[]; total: number } {
  const db = getDb();

  let sql = 'SELECT * FROM features';
  const params: unknown[] = [];

  if (args.category) {
    sql += ' WHERE category = ?';
    params.push(args.category);
  }

  sql += ' ORDER BY created_timestamp DESC LIMIT ?';
  params.push(args.limit ?? 50);

  const records = db.prepare(sql).all(...params) as FeatureRecord[];

  return {
    features: records.map(featureToResult),
    total: records.length,
  };
}

function deleteFeature(args: DeleteFeatureArgs): { deleted: boolean; message: string } | ErrorResult {
  const db = getDb();
  const record = db.prepare('SELECT * FROM features WHERE id = ?').get(args.id) as FeatureRecord | undefined;

  if (!record) {
    return { error: `Feature not found: ${args.id}` };
  }

  db.prepare('DELETE FROM features WHERE id = ?').run(args.id);

  return { deleted: true, message: `Feature "${record.name}" deleted` };
}

// ============================================================================
// Persona-Feature Mapping
// ============================================================================

function mapPersonaFeature(args: MapPersonaFeatureArgs): { mapped: boolean; message: string } | ErrorResult {
  const db = getDb();

  // Verify persona exists
  const persona = db.prepare('SELECT id, name FROM personas WHERE id = ?').get(args.persona_id) as { id: string; name: string } | undefined;
  if (!persona) {
    return { error: `Persona not found: ${args.persona_id}` };
  }

  // Verify feature exists
  const feature = db.prepare('SELECT id, name FROM features WHERE id = ?').get(args.feature_id) as { id: string; name: string } | undefined;
  if (!feature) {
    return { error: `Feature not found: ${args.feature_id}` };
  }

  try {
    db.prepare(`
      INSERT OR REPLACE INTO persona_features (persona_id, feature_id, priority, test_scenarios)
      VALUES (?, ?, ?, ?)
    `).run(
      args.persona_id,
      args.feature_id,
      args.priority ?? 'normal',
      JSON.stringify(args.test_scenarios ?? []),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to map persona to feature: ${message}` };
  }

  return {
    mapped: true,
    message: `Persona "${persona.name}" mapped to feature "${feature.name}" with priority ${args.priority ?? 'normal'}`,
  };
}

function unmapPersonaFeature(args: UnmapPersonaFeatureArgs): { unmapped: boolean; message: string } | ErrorResult {
  const db = getDb();

  const result = db.prepare('DELETE FROM persona_features WHERE persona_id = ? AND feature_id = ?')
    .run(args.persona_id, args.feature_id);

  if (result.changes === 0) {
    return { error: 'Mapping not found' };
  }

  return { unmapped: true, message: 'Persona-feature mapping removed' };
}

// ============================================================================
// Change Analysis
// ============================================================================

function getPersonasForChanges(args: GetPersonasForChangesArgs): { personas: PersonaForChangeResult[]; matched_features: FeatureResult[] } {
  const db = getDb();
  const changedFiles = args.changed_files ?? [];
  const changedFeatureIds = args.changed_features ?? [];

  // 1. Find features affected by changed files
  const allFeatures = db.prepare('SELECT * FROM features').all() as FeatureRecord[];
  const affectedFeatureIds = new Set<string>(changedFeatureIds);

  for (const feature of allFeatures) {
    const patterns = JSON.parse(feature.file_patterns) as string[];
    for (const pattern of patterns) {
      for (const file of changedFiles) {
        if (globMatch(pattern, file)) {
          affectedFeatureIds.add(feature.id);
          break;
        }
      }
    }
  }

  if (affectedFeatureIds.size === 0) {
    return { personas: [], matched_features: [] };
  }

  // 2. Find personas mapped to affected features
  const featureIdList = Array.from(affectedFeatureIds);
  const placeholders = featureIdList.map(() => '?').join(',');

  const mappings = db.prepare(`
    SELECT pf.persona_id, pf.feature_id, pf.priority, pf.test_scenarios,
           p.id as p_id, p.name as p_name, p.description as p_description,
           p.consumption_mode as p_mode, p.behavior_traits as p_traits,
           p.endpoints as p_endpoints, p.credentials_ref as p_creds,
           p.enabled as p_enabled, p.created_at as p_created,
           p.updated_at as p_updated, p.created_timestamp as p_ts,
           f.name as f_name
    FROM persona_features pf
    JOIN personas p ON p.id = pf.persona_id
    JOIN features f ON f.id = pf.feature_id
    WHERE pf.feature_id IN (${placeholders})
      AND p.enabled = 1
    ORDER BY
      CASE pf.priority
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'normal' THEN 3
        WHEN 'low' THEN 4
      END
  `).all(...featureIdList) as (PersonaFeatureRecord & {
    p_id: string; p_name: string; p_description: string; p_mode: ConsumptionMode;
    p_traits: string; p_endpoints: string; p_creds: string | null;
    p_enabled: number; p_created: string; p_updated: string; p_ts: number;
    f_name: string;
  })[];

  // Group by persona
  const personaMap = new Map<string, PersonaForChangeResult>();

  for (const row of mappings) {
    if (!personaMap.has(row.persona_id)) {
      personaMap.set(row.persona_id, {
        persona: {
          id: row.p_id,
          name: row.p_name,
          description: row.p_description,
          consumption_mode: row.p_mode,
          behavior_traits: JSON.parse(row.p_traits) as string[],
          endpoints: JSON.parse(row.p_endpoints) as string[],
          credentials_ref: row.p_creds,
          enabled: row.p_enabled === 1,
          created_at: row.p_created,
          updated_at: row.p_updated,
        },
        matched_features: [],
      });
    }

    // Find which specific files matched this feature
    const feature = allFeatures.find(f => f.id === row.feature_id);
    const patterns = feature ? JSON.parse(feature.file_patterns) as string[] : [];
    const matchedFiles = changedFiles.filter(file =>
      patterns.some(p => globMatch(p, file))
    );

    personaMap.get(row.persona_id)!.matched_features.push({
      feature_id: row.feature_id,
      feature_name: row.f_name,
      priority: row.priority,
      test_scenarios: JSON.parse(row.test_scenarios) as string[],
      matched_files: matchedFiles,
    });
  }

  // Get matched feature details
  const matchedFeatures = allFeatures
    .filter(f => affectedFeatureIds.has(f.id))
    .map(featureToResult);

  return {
    personas: Array.from(personaMap.values()),
    matched_features: matchedFeatures,
  };
}

// ============================================================================
// Feedback Run Management
// ============================================================================

function startFeedbackRun(args: StartFeedbackRunArgs): FeedbackRunResult | ErrorResult {
  const db = getDb();
  const runId = randomUUID();
  const now = new Date().toISOString();

  // Determine which personas to trigger
  let personaIds: string[];
  let changedFeatureIds: string[] = args.changed_features ?? [];

  if (args.persona_ids && args.persona_ids.length > 0) {
    // Override: use specific personas
    personaIds = args.persona_ids;
  } else {
    // Analyze changes to determine personas
    const analysis = getPersonasForChanges({
      changed_files: args.changed_files,
      changed_features: args.changed_features,
    });
    personaIds = analysis.personas.map(p => p.persona.id);
    changedFeatureIds = analysis.matched_features.map(f => f.id);
  }

  if (personaIds.length === 0) {
    return { error: 'No personas matched the changes. Register features and map personas first.' };
  }

  // Create feedback run
  db.prepare(`
    INSERT INTO feedback_runs (id, trigger_type, trigger_ref, changed_features, personas_triggered, status, max_concurrent, started_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    runId,
    args.trigger_type,
    args.trigger_ref ?? null,
    JSON.stringify(changedFeatureIds),
    JSON.stringify(personaIds),
    args.max_concurrent ?? 3,
    now,
  );

  // Create feedback sessions for each persona
  for (const personaId of personaIds) {
    db.prepare(`
      INSERT INTO feedback_sessions (id, run_id, persona_id, status)
      VALUES (?, ?, ?, 'pending')
    `).run(randomUUID(), runId, personaId);
  }

  return getFeedbackRun({ id: runId }) as FeedbackRunResult;
}

function getFeedbackRun(args: GetFeedbackRunArgs): FeedbackRunResult | ErrorResult {
  const db = getDb();
  const run = db.prepare('SELECT * FROM feedback_runs WHERE id = ?').get(args.id) as FeedbackRunRecord | undefined;

  if (!run) {
    return { error: `Feedback run not found: ${args.id}` };
  }

  const sessions = db.prepare('SELECT id, persona_id, status, findings_count FROM feedback_sessions WHERE run_id = ?')
    .all(args.id) as Pick<FeedbackSessionRecord, 'id' | 'persona_id' | 'status' | 'findings_count'>[];

  return {
    id: run.id,
    trigger_type: run.trigger_type,
    trigger_ref: run.trigger_ref,
    changed_features: JSON.parse(run.changed_features) as string[],
    personas_triggered: JSON.parse(run.personas_triggered) as string[],
    status: run.status,
    max_concurrent: run.max_concurrent,
    started_at: run.started_at,
    completed_at: run.completed_at,
    summary: run.summary,
    sessions: sessions.map(s => ({
      id: s.id,
      persona_id: s.persona_id,
      status: s.status,
      findings_count: s.findings_count,
    })),
  };
}

function listFeedbackRuns(args: ListFeedbackRunsArgs): { runs: FeedbackRunResult[]; total: number } {
  const db = getDb();

  let sql = 'SELECT * FROM feedback_runs';
  const params: unknown[] = [];

  if (args.status && args.status !== 'all') {
    sql += ' WHERE status = ?';
    params.push(args.status);
  }

  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(args.limit ?? 20);

  const runs = db.prepare(sql).all(...params) as FeedbackRunRecord[];

  return {
    runs: runs.map(run => ({
      id: run.id,
      trigger_type: run.trigger_type,
      trigger_ref: run.trigger_ref,
      changed_features: JSON.parse(run.changed_features) as string[],
      personas_triggered: JSON.parse(run.personas_triggered) as string[],
      status: run.status,
      max_concurrent: run.max_concurrent,
      started_at: run.started_at,
      completed_at: run.completed_at,
      summary: run.summary,
    })),
    total: runs.length,
  };
}

function completeFeedbackSession(args: CompleteFeedbackSessionArgs): { completed: boolean; message: string } | ErrorResult {
  const db = getDb();
  const session = db.prepare('SELECT * FROM feedback_sessions WHERE id = ?').get(args.session_id) as FeedbackSessionRecord | undefined;

  if (!session) {
    return { error: `Feedback session not found: ${args.session_id}` };
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE feedback_sessions
    SET status = ?, completed_at = ?, findings_count = ?, report_ids = ?
    WHERE id = ?
  `).run(
    args.status,
    now,
    args.findings_count ?? 0,
    JSON.stringify(args.report_ids ?? []),
    args.session_id,
  );

  // Check if all sessions in the run are done
  interface CountResult { count: number }
  const pendingCount = (db.prepare(`
    SELECT COUNT(*) as count FROM feedback_sessions
    WHERE run_id = ? AND status IN ('pending', 'queued', 'running')
  `).get(session.run_id) as CountResult).count;

  if (pendingCount === 0) {
    // All sessions done, update run status
    const failedCount = (db.prepare(`
      SELECT COUNT(*) as count FROM feedback_sessions
      WHERE run_id = ? AND status IN ('failed', 'timeout')
    `).get(session.run_id) as CountResult).count;

    const totalCount = (db.prepare(`
      SELECT COUNT(*) as count FROM feedback_sessions WHERE run_id = ?
    `).get(session.run_id) as CountResult).count;

    let runStatus: FeedbackRunStatus;
    if (failedCount === 0) {
      runStatus = 'completed';
    } else if (failedCount === totalCount) {
      runStatus = 'failed';
    } else {
      runStatus = 'partial';
    }

    db.prepare('UPDATE feedback_runs SET status = ?, completed_at = ? WHERE id = ?')
      .run(runStatus, now, session.run_id);
  }

  return {
    completed: true,
    message: `Session ${args.session_id} marked as ${args.status}. ${pendingCount} sessions still pending.`,
  };
}

function getFeedbackRunSummary(args: GetFeedbackRunSummaryArgs): FeedbackRunSummaryResult | ErrorResult {
  const db = getDb();
  const run = db.prepare('SELECT * FROM feedback_runs WHERE id = ?').get(args.id) as FeedbackRunRecord | undefined;

  if (!run) {
    return { error: `Feedback run not found: ${args.id}` };
  }

  const sessions = db.prepare('SELECT * FROM feedback_sessions WHERE run_id = ?')
    .all(args.id) as FeedbackSessionRecord[];

  const completedSessions = sessions.filter(s => s.status === 'completed');
  const failedSessions = sessions.filter(s => s.status === 'failed');
  const timeoutSessions = sessions.filter(s => s.status === 'timeout');

  const totalFindings = sessions.reduce((sum, s) => sum + s.findings_count, 0);
  const allReportIds = sessions.flatMap(s => JSON.parse(s.report_ids) as string[]);
  const personasTested = sessions
    .filter(s => s.status === 'completed')
    .map(s => s.persona_id);

  return {
    run_id: run.id,
    status: run.status,
    total_sessions: sessions.length,
    completed_sessions: completedSessions.length,
    failed_sessions: failedSessions.length,
    timeout_sessions: timeoutSessions.length,
    total_findings: totalFindings,
    total_report_ids: allReportIds,
    personas_tested: personasTested,
  };
}

function getSessionAudit(args: GetSessionAuditArgs): GetSessionAuditResult | ErrorResult {
  const db = getDb();

  // Lookup the feedback session to get persona name and agent_id
  const session = db.prepare('SELECT persona_id, agent_id FROM feedback_sessions WHERE id = ?')
    .get(args.feedback_session_id) as Pick<FeedbackSessionRecord, 'persona_id' | 'agent_id'> | undefined;

  if (!session) {
    return { error: `Feedback session not found: ${args.feedback_session_id}` };
  }

  // Get persona name
  const persona = db.prepare('SELECT name FROM personas WHERE id = ?')
    .get(session.persona_id) as { name: string } | undefined;

  // Open session-events.db to query MCP events
  const sessionEventsDbPath = path.join(PROJECT_DIR, '.claude', 'session-events.db');

  // If the database doesn't exist, return empty result
  if (!fs.existsSync(sessionEventsDbPath)) {
    return {
      session_id: args.feedback_session_id,
      persona_name: persona?.name ?? null,
      mcp_actions: [],
      total_actions: 0,
      total_duration_ms: 0,
      ...(args.include_transcript && session.agent_id ? { transcript_session_id: session.agent_id } : {}),
    };
  }

  // Query session events
  let eventsDb: Database.Database | null = null;
  try {
    eventsDb = new Database(sessionEventsDbPath, { readonly: true });

    interface EventRow {
      timestamp: string;
      input: string | null;
      output: string | null;
      error: string | null;
      duration_ms: number | null;
      metadata: string | null;
    }

    const events = eventsDb.prepare(`
      SELECT timestamp, input, output, error, duration_ms, metadata
      FROM session_events
      WHERE session_id = ? AND event_type IN ('mcp_tool_call', 'mcp_tool_error')
      ORDER BY timestamp ASC
    `).all(args.feedback_session_id) as EventRow[];

    // Parse events to extract tool calls
    const mcpActions: McpAuditAction[] = [];
    let totalDuration = 0;

    for (const event of events) {
      let inputData: any = {};
      let outputData: any = null;
      let errorData: any = null;
      let metadataData: any = {};

      try {
        if (event.input) {
          inputData = JSON.parse(event.input);
        }
      } catch {
        inputData = {};
      }

      try {
        if (event.output) {
          outputData = JSON.parse(event.output);
        }
      } catch {
        outputData = null;
      }

      try {
        if (event.error) {
          errorData = JSON.parse(event.error);
        }
      } catch {
        errorData = null;
      }

      try {
        if (event.metadata) {
          metadataData = JSON.parse(event.metadata);
        }
      } catch {
        metadataData = {};
      }

      mcpActions.push({
        timestamp: event.timestamp,
        tool: inputData.tool || inputData.name || 'unknown',
        args: inputData.args || inputData.arguments || null,
        result: outputData,
        error: errorData,
        duration_ms: event.duration_ms,
        mcp_server: metadataData.mcp_server || null,
      });

      if (event.duration_ms) {
        totalDuration += event.duration_ms;
      }
    }

    const result: GetSessionAuditResult = {
      session_id: args.feedback_session_id,
      persona_name: persona?.name ?? null,
      mcp_actions: mcpActions,
      total_actions: mcpActions.length,
      total_duration_ms: totalDuration,
    };

    // Include transcript session ID if requested and available
    if (args.include_transcript && session.agent_id) {
      result.transcript_session_id = session.agent_id;
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to query session events: ${message}` };
  } finally {
    if (eventsDb) {
      eventsDb.close();
    }
  }
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  // Persona CRUD
  {
    name: 'create_persona',
    description: 'Create a new user persona for feedback testing. Personas represent user types that test your application.',
    schema: CreatePersonaArgsSchema,
    handler: createPersona,
  },
  {
    name: 'update_persona',
    description: 'Update an existing persona. Only specified fields are changed.',
    schema: UpdatePersonaArgsSchema,
    handler: updatePersona,
  },
  {
    name: 'delete_persona',
    description: 'Delete a persona and all its feature mappings.',
    schema: DeletePersonaArgsSchema,
    handler: deletePersona,
  },
  {
    name: 'get_persona',
    description: 'Get full details of a persona including its feature mappings and test scenarios.',
    schema: GetPersonaArgsSchema,
    handler: getPersona,
  },
  {
    name: 'list_personas',
    description: 'List personas with optional filters (enabled only, consumption mode).',
    schema: ListPersonasArgsSchema,
    handler: listPersonas,
  },
  // Feature CRUD
  {
    name: 'register_feature',
    description: 'Register a project feature with file glob patterns and URL patterns. Used to map code changes to user-facing features.',
    schema: RegisterFeatureArgsSchema,
    handler: registerFeature,
  },
  {
    name: 'list_features',
    description: 'List registered features with optional category filter.',
    schema: ListFeaturesArgsSchema,
    handler: listFeatures,
  },
  {
    name: 'delete_feature',
    description: 'Delete a feature and all its persona mappings.',
    schema: DeleteFeatureArgsSchema,
    handler: deleteFeature,
  },
  // Mapping
  {
    name: 'map_persona_feature',
    description: 'Associate a persona with a feature. Includes priority and specific test scenarios.',
    schema: MapPersonaFeatureArgsSchema,
    handler: mapPersonaFeature,
  },
  {
    name: 'unmap_persona_feature',
    description: 'Remove a persona-feature association.',
    schema: UnmapPersonaFeatureArgsSchema,
    handler: unmapPersonaFeature,
  },
  // Change Analysis
  {
    name: 'get_personas_for_changes',
    description: 'Given a list of changed files, determine which personas should test. Matches file paths against feature patterns, then finds mapped personas.',
    schema: GetPersonasForChangesArgsSchema,
    handler: getPersonasForChanges,
  },
  // Feedback Run Management
  {
    name: 'start_feedback_run',
    description: 'Initialize a feedback run. Analyzes changes, selects personas, and creates session records. Returns the run with all pending sessions.',
    schema: StartFeedbackRunArgsSchema,
    handler: startFeedbackRun,
  },
  {
    name: 'get_feedback_run',
    description: 'Get the status and session details of a feedback run.',
    schema: GetFeedbackRunArgsSchema,
    handler: getFeedbackRun,
  },
  {
    name: 'list_feedback_runs',
    description: 'List recent feedback runs with optional status filter.',
    schema: ListFeedbackRunsArgsSchema,
    handler: listFeedbackRuns,
  },
  {
    name: 'complete_feedback_session',
    description: 'Mark a feedback session as completed, failed, or timeout. Auto-updates the parent run status when all sessions are done.',
    schema: CompleteFeedbackSessionArgsSchema,
    handler: completeFeedbackSession,
  },
  {
    name: 'get_feedback_run_summary',
    description: 'Get aggregate statistics for a completed feedback run: sessions, findings, report IDs.',
    schema: GetFeedbackRunSummaryArgsSchema,
    handler: getFeedbackRunSummary,
  },
  {
    name: 'get_session_audit',
    description: 'Get MCP tool call audit trail for a feedback session. Shows all MCP tools called during the session with arguments, results, and timing.',
    schema: GetSessionAuditArgsSchema,
    handler: getSessionAudit,
  },
];

const server = new McpServer({
  name: 'user-feedback',
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
