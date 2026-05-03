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
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import { openReadonlyDb } from '../shared/readonly-db.js';
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
  CreateScenarioArgsSchema,
  UpdateScenarioArgsSchema,
  DeleteScenarioArgsSchema,
  ListScenariosArgsSchema,
  GetScenarioArgsSchema,
  ListRecordingsArgsSchema,
  GetRecordingArgsSchema,
  PlayRecordingArgsSchema,
  GetLatestFeatureFeedbackArgsSchema,
  PlayFeatureFeedbackArgsSchema,
  RegisterPrerequisiteArgsSchema,
  UpdatePrerequisiteArgsSchema,
  DeletePrerequisiteArgsSchema,
  ListPrerequisitesArgsSchema,
  CreatePersonaProfileArgsSchema,
  ArchivePersonaProfileArgsSchema,
  SwitchPersonaProfileArgsSchema,
  ListPersonaProfilesArgsSchema,
  GetPersonaProfileArgsSchema,
  DeletePersonaProfileArgsSchema,
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
  type CreateScenarioArgs,
  type UpdateScenarioArgs,
  type DeleteScenarioArgs,
  type ListScenariosArgs,
  type GetScenarioArgs,
  type ListRecordingsArgs,
  type GetRecordingArgs,
  type PlayRecordingArgs,
  type GetLatestFeatureFeedbackArgs,
  type PlayFeatureFeedbackArgs,
  type LatestFeatureFeedbackEntry,
  type LatestFeatureFeedbackResult,
  type RegisterPrerequisiteArgs,
  type UpdatePrerequisiteArgs,
  type DeletePrerequisiteArgs,
  type ListPrerequisitesArgs,
  type CreatePersonaProfileArgs,
  type ArchivePersonaProfileArgs,
  type SwitchPersonaProfileArgs,
  type GetPersonaProfileArgs,
  type DeletePersonaProfileArgs,
  type PersonaRecord,
  type FeatureRecord,
  type PersonaFeatureRecord,
  type FeedbackRunRecord,
  type FeedbackSessionRecord,
  type ScenarioRecord,
  type PrerequisiteRecord,
  type ErrorResult,
  type PersonaResult,
  type FeatureResult,
  type ScenarioResult,
  type PrerequisiteResult,
  type PersonaForChangeResult,
  type FeedbackRunResult,
  type FeedbackRunSummaryResult,
  type GetSessionAuditResult,
  type McpAuditAction,
  type ConsumptionMode,
  type FeedbackRunStatus,
  type ListRecordingsResult,
  type GetRecordingResult,
  type DemoRecordingEntry,
  type FeedbackRecordingEntry,
  VerifyDemoCompletenessArgsSchema,
  type VerifyDemoCompletenessArgs,
  type DemoCompletenessScenarioStatus,
  type VerifyDemoCompletenessResult,
  DisableScenariosArgsSchema,
  type DisableScenariosArgs,
  type DisableScenariosResult,
  type BulkScenarioResult,
  EnableScenariosArgsSchema,
  type EnableScenariosArgs,
  type EnableScenariosResult,
} from './types.js';

// ============================================================================
// Configuration Interface
// ============================================================================

export interface UserFeedbackConfig {
  projectDir: string;
  // Testing override: provide a pre-created DB instance
  db?: Database.Database;
}

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    consumption_modes TEXT NOT NULL DEFAULT '["gui"]',
    behavior_traits TEXT NOT NULL DEFAULT '[]',
    endpoints TEXT NOT NULL DEFAULT '[]',
    credentials_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personas_enabled ON personas(enabled);

CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    file_patterns TEXT NOT NULL DEFAULT '[]',
    url_patterns TEXT NOT NULL DEFAULT '[]',
    category TEXT,
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL
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
    satisfaction_level TEXT,
    CONSTRAINT valid_status CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'timeout')),
    CONSTRAINT valid_satisfaction CHECK (satisfaction_level IS NULL OR satisfaction_level IN ('very_satisfied', 'satisfied', 'neutral', 'dissatisfied', 'very_dissatisfied')),
    FOREIGN KEY (run_id) REFERENCES feedback_runs(id),
    FOREIGN KEY (persona_id) REFERENCES personas(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_run ON feedback_sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON feedback_sessions(status);

CREATE TABLE IF NOT EXISTS demo_scenarios (
    id TEXT PRIMARY KEY,
    persona_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT,
    playwright_project TEXT NOT NULL,
    test_file TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_scenarios_persona ON demo_scenarios(persona_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_enabled ON demo_scenarios(enabled);

CREATE TABLE IF NOT EXISTS demo_prerequisites (
    id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    description TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    health_check TEXT,
    health_check_timeout_ms INTEGER NOT NULL DEFAULT 5000,
    scope TEXT NOT NULL DEFAULT 'global',
    persona_id TEXT,
    scenario_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    run_as_background INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    created_timestamp TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT valid_scope CHECK (scope IN ('global', 'persona', 'scenario')),
    CONSTRAINT scope_persona_check CHECK (scope != 'persona' OR persona_id IS NOT NULL),
    CONSTRAINT scope_scenario_check CHECK (scope != 'scenario' OR scenario_id IS NOT NULL),
    FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
    FOREIGN KEY (scenario_id) REFERENCES demo_scenarios(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prerequisites_scope ON demo_prerequisites(scope);
CREATE INDEX IF NOT EXISTS idx_prerequisites_enabled ON demo_prerequisites(enabled);
CREATE INDEX IF NOT EXISTS idx_prerequisites_persona ON demo_prerequisites(persona_id);
CREATE INDEX IF NOT EXISTS idx_prerequisites_scenario ON demo_prerequisites(scenario_id);
`;

// ============================================================================
// Glob Matching Utility (Pure Function - stays at module level)
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
// Server Factory Function
// ============================================================================

export function createUserFeedbackServer(config: UserFeedbackConfig): McpServer {
  // ============================================================================
  // Database Management
  // ============================================================================

  function initializeDatabase(projectDir: string): Database.Database {
    const dbPath = path.join(projectDir, '.claude', 'user-feedback.db');
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);

    // Auto-migration: add cto_protected column if missing
    try {
      db.prepare("SELECT cto_protected FROM personas LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE personas ADD COLUMN cto_protected INTEGER NOT NULL DEFAULT 0");
    }

    // Auto-migration: migrate consumption_mode → consumption_modes (JSON array)
    try {
      db.prepare("SELECT consumption_modes FROM personas LIMIT 0").run();
    } catch {
      // Old schema has consumption_mode (single value) — rebuild with consumption_modes (JSON array)
      db.exec(`
        CREATE TABLE personas_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL,
          consumption_modes TEXT NOT NULL DEFAULT '["gui"]',
          behavior_traits TEXT NOT NULL DEFAULT '[]',
          endpoints TEXT NOT NULL DEFAULT '[]',
          credentials_ref TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          created_timestamp TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          cto_protected INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO personas_new (id, name, description, consumption_modes, behavior_traits, endpoints, credentials_ref, enabled, created_at, created_timestamp, updated_at, cto_protected)
          SELECT id, name, description, json_array(consumption_mode), behavior_traits, endpoints, credentials_ref, enabled, created_at, created_timestamp, updated_at, cto_protected FROM personas;
        DROP TABLE personas;
        ALTER TABLE personas_new RENAME TO personas;
        CREATE INDEX IF NOT EXISTS idx_personas_enabled ON personas(enabled);
      `);
    }

    // Auto-migration: add scenario_id column to feedback_sessions if missing
    try {
      db.prepare("SELECT scenario_id FROM feedback_sessions LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE feedback_sessions ADD COLUMN scenario_id TEXT");
    }

    // Auto-migration: add recording_path column to feedback_sessions if missing
    try {
      db.prepare("SELECT recording_path FROM feedback_sessions LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE feedback_sessions ADD COLUMN recording_path TEXT");
    }

    // Auto-migration: add feature_id column to feedback_sessions if missing
    try {
      db.prepare("SELECT feature_id FROM feedback_sessions LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE feedback_sessions ADD COLUMN feature_id TEXT REFERENCES features(id)");
    }

    // Create latest_feature_feedback tracking table
    db.exec(`
      CREATE TABLE IF NOT EXISTS latest_feature_feedback (
        feature_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        recording_path TEXT,
        completed_at TEXT,
        satisfaction_level TEXT,
        PRIMARY KEY (feature_id, persona_id),
        FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE,
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES feedback_sessions(id)
      );
    `);

    // Auto-migration: add last_recorded_at and recording_path columns to demo_scenarios if missing
    try {
      db.prepare("SELECT last_recorded_at FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN last_recorded_at TEXT");
    }
    try {
      db.prepare("SELECT recording_path FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN recording_path TEXT");
    }
    try {
      db.prepare("SELECT env_vars FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN env_vars TEXT");
    }
    try {
      db.prepare("SELECT headed FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN headed INTEGER NOT NULL DEFAULT 0");
    }
    try {
      db.prepare("SELECT remote_eligible FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN remote_eligible INTEGER NOT NULL DEFAULT 1");
      // One-time seed: mark chrome-bridge and headed scenarios as not remote-eligible
      db.exec(`
        UPDATE demo_scenarios SET remote_eligible = 0
        WHERE headed = 1
           OR test_file LIKE '%ext-%'
           OR test_file LIKE '%platform%'
           OR test_file LIKE '%/extension/%'
           OR test_file LIKE '%/platform-fixtures%'
      `);
    }

    // Auto-migration: add stealth_required column to demo_scenarios if missing
    try {
      db.prepare("SELECT stealth_required FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN stealth_required INTEGER NOT NULL DEFAULT 0");
    }
    // Auto-migration: add dual_instance column to demo_scenarios if missing
    try {
      db.prepare("SELECT dual_instance FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN dual_instance INTEGER NOT NULL DEFAULT 0");
    }
    // Auto-migration: add telemetry column to demo_scenarios if missing
    try {
      db.prepare("SELECT telemetry FROM demo_scenarios LIMIT 0").run();
    } catch {
      db.exec("ALTER TABLE demo_scenarios ADD COLUMN telemetry INTEGER NOT NULL DEFAULT 0");
    }

    // Auto-migration: create demo_prerequisites table if missing
    try {
      db.prepare("SELECT id FROM demo_prerequisites LIMIT 0").run();
    } catch {
      db.exec(`
        CREATE TABLE IF NOT EXISTS demo_prerequisites (
            id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            description TEXT NOT NULL,
            timeout_ms INTEGER NOT NULL DEFAULT 30000,
            health_check TEXT,
            health_check_timeout_ms INTEGER NOT NULL DEFAULT 5000,
            scope TEXT NOT NULL DEFAULT 'global',
            persona_id TEXT,
            scenario_id TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            run_as_background INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            created_timestamp TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            CONSTRAINT valid_scope CHECK (scope IN ('global', 'persona', 'scenario')),
            CONSTRAINT scope_persona_check CHECK (scope != 'persona' OR persona_id IS NOT NULL),
            CONSTRAINT scope_scenario_check CHECK (scope != 'scenario' OR scenario_id IS NOT NULL),
            FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
            FOREIGN KEY (scenario_id) REFERENCES demo_scenarios(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_prerequisites_scope ON demo_prerequisites(scope);
        CREATE INDEX IF NOT EXISTS idx_prerequisites_enabled ON demo_prerequisites(enabled);
        CREATE INDEX IF NOT EXISTS idx_prerequisites_persona ON demo_prerequisites(persona_id);
        CREATE INDEX IF NOT EXISTS idx_prerequisites_scenario ON demo_prerequisites(scenario_id);
      `);
    }

    // Auto-migration: create demo_results table if missing (tracks per-scenario pass/fail history)
    try {
      db.prepare("SELECT id FROM demo_results LIMIT 0").run();
    } catch {
      db.exec(`
        CREATE TABLE IF NOT EXISTS demo_results (
            id TEXT PRIMARY KEY,
            scenario_id TEXT NOT NULL,
            execution_mode TEXT NOT NULL DEFAULT 'local',
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            fly_machine_id TEXT,
            output_file TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            CONSTRAINT valid_mode CHECK (execution_mode IN ('local', 'remote')),
            CONSTRAINT valid_status CHECK (status IN ('passed', 'failed')),
            FOREIGN KEY (scenario_id) REFERENCES demo_scenarios(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_demo_results_scenario ON demo_results(scenario_id);
        CREATE INDEX IF NOT EXISTS idx_demo_results_completed ON demo_results(completed_at);
      `);
    }

    // Auto-migration: add run_id column to demo_results if missing
    try {
      db.prepare("SELECT run_id FROM demo_results LIMIT 0").run();
    } catch {
      try { db.exec("ALTER TABLE demo_results ADD COLUMN run_id TEXT"); } catch { /* table may not exist yet */ }
    }

    // Migration: Convert any existing INTEGER timestamps to ISO 8601 TEXT (G005)
    db.exec(`UPDATE personas SET created_timestamp = datetime(created_timestamp, 'unixepoch') || 'Z' WHERE typeof(created_timestamp) = 'integer'`);
    db.exec(`UPDATE features SET created_timestamp = datetime(created_timestamp, 'unixepoch') || 'Z' WHERE typeof(created_timestamp) = 'integer'`);
    db.exec(`UPDATE demo_scenarios SET created_timestamp = datetime(created_timestamp, 'unixepoch') || 'Z' WHERE typeof(created_timestamp) = 'integer'`);

    return db;
  }

  // DB path constant for profile system
  const DB_PATH = path.join(config.projectDir, '.claude', 'user-feedback.db');

  // Use provided DB or initialize new one
  let db = config.db ?? initializeDatabase(config.projectDir);

  // Close DB we created (not test-provided) on process exit
  if (!config.db) {
    process.on('exit', () => {
      try { db.close(); } catch { /* ignore */ }
    });
  }

  // ============================================================================
  // Helper: env_vars validation (must match playwright/helpers.ts EXTRA_ENV_BLOCKED_PREFIXES)
  // ============================================================================

  const ENV_VARS_BLOCKED_PREFIXES = [
    'PATH', 'HOME', 'USER', 'SHELL',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN',
    'GITHUB_TOKEN', 'CLOUDFLARE_', 'CODECOV_', 'RESEND_',
    'OP_SERVICE_ACCOUNT_TOKEN', 'GENTYR_',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
    'DEMO_SLOW_MO', 'DEMO_PAUSE_AT_END', 'DEMO_HEADLESS',
    'DEMO_SHOW_CURSOR', 'DEMO_PROGRESS_FILE', 'DEMO_RECORD_VIDEO', 'DEMO_MAXIMIZE',
    'PLAYWRIGHT_BASE_URL', 'CLAUDE_',
  ];

  function validateScenarioEnvVars(envVars: Record<string, string>): string | null {
    const keys = Object.keys(envVars);
    if (keys.length > 25) return 'env_vars: max 25 keys allowed';
    const blocked = keys.filter(k =>
      ENV_VARS_BLOCKED_PREFIXES.some(prefix => k === prefix || k.startsWith(prefix)),
    );
    if (blocked.length > 0) return `env_vars: blocked keys: ${blocked.join(', ')}`;
    return null;
  }

  // ============================================================================
  // Helper: Record to Result Conversion
  // ============================================================================

  function personaToResult(record: PersonaRecord): PersonaResult {
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      consumption_modes: JSON.parse(record.consumption_modes) as ConsumptionMode[],
      behavior_traits: JSON.parse(record.behavior_traits) as string[],
      endpoints: JSON.parse(record.endpoints) as string[],
      credentials_ref: record.credentials_ref,
      enabled: record.enabled === 1,
      cto_protected: record.cto_protected === 1,
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

  function scenarioToResult(record: ScenarioRecord, personaName?: string): ScenarioResult {
    let envVars: Record<string, string> | null = null;
    if (record.env_vars) {
      try { envVars = JSON.parse(record.env_vars); } catch { /* invalid JSON, treat as null */ }
    }
    return {
      id: record.id,
      persona_id: record.persona_id,
      title: record.title,
      description: record.description,
      category: record.category,
      playwright_project: record.playwright_project,
      test_file: record.test_file,
      sort_order: record.sort_order,
      enabled: record.enabled === 1,
      headed: record.headed === 1,
      remote_eligible: record.remote_eligible === 1,
      stealth_required: record.stealth_required === 1,
      dual_instance: record.dual_instance === 1,
      telemetry: record.telemetry === 1,
      created_at: record.created_at,
      updated_at: record.updated_at,
      persona_name: personaName,
      last_recorded_at: record.last_recorded_at ?? null,
      recording_path: record.recording_path ?? null,
      env_vars: envVars,
    };
  }

  function prerequisiteToResult(record: PrerequisiteRecord, personaName?: string, scenarioTitle?: string): PrerequisiteResult {
    return {
      id: record.id,
      command: record.command,
      description: record.description,
      timeout_ms: record.timeout_ms,
      health_check: record.health_check,
      health_check_timeout_ms: record.health_check_timeout_ms,
      scope: record.scope,
      persona_id: record.persona_id,
      scenario_id: record.scenario_id,
      sort_order: record.sort_order,
      enabled: record.enabled === 1,
      run_as_background: record.run_as_background === 1,
      created_at: record.created_at,
      updated_at: record.updated_at,
      persona_name: personaName,
      scenario_title: scenarioTitle,
    };
  }

  // ============================================================================
  // Persona CRUD
  // ============================================================================

  function createPersona(args: CreatePersonaArgs): PersonaResult | ErrorResult {
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = now.toISOString();

    try {
      db.prepare(`
        INSERT INTO personas (id, name, description, consumption_modes, behavior_traits, endpoints, credentials_ref, cto_protected, created_at, created_timestamp, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        args.name,
        args.description,
        JSON.stringify(args.consumption_modes),
        JSON.stringify(args.behavior_traits ?? []),
        JSON.stringify(args.endpoints ?? []),
        args.credentials_ref ?? null,
        args.cto_protected ? 1 : 0,
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
    const record = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.id) as PersonaRecord | undefined;

    if (!record) {
      return { error: `Persona not found: ${args.id}` };
    }

    // CTO-protected access control
    if (record.cto_protected === 1 && args.caller === 'product-manager') {
      return { error: 'This persona is CTO-protected. Request CTO approval via deputy-CTO queue.' };
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (args.name !== undefined) { updates.push('name = ?'); params.push(args.name); }
    if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
    if (args.consumption_modes !== undefined) { updates.push('consumption_modes = ?'); params.push(JSON.stringify(args.consumption_modes)); }
    if (args.behavior_traits !== undefined) { updates.push('behavior_traits = ?'); params.push(JSON.stringify(args.behavior_traits)); }
    if (args.endpoints !== undefined) { updates.push('endpoints = ?'); params.push(JSON.stringify(args.endpoints)); }
    if (args.credentials_ref !== undefined) { updates.push('credentials_ref = ?'); params.push(args.credentials_ref); }
    if (args.enabled !== undefined) { updates.push('enabled = ?'); params.push(args.enabled ? 1 : 0); }
    if (args.cto_protected !== undefined) { updates.push('cto_protected = ?'); params.push(args.cto_protected ? 1 : 0); }

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
    const record = db.prepare('SELECT * FROM personas WHERE id = ?').get(args.id) as PersonaRecord | undefined;

    if (!record) {
      return { error: `Persona not found: ${args.id}` };
    }

    if (record.cto_protected === 1 && args.caller === 'product-manager') {
      return { error: 'This persona is CTO-protected. Request CTO approval via deputy-CTO queue.' };
    }

    // Cascade deletes persona_features entries via FK constraint
    db.prepare('DELETE FROM personas WHERE id = ?').run(args.id);

    return { deleted: true, message: `Persona "${record.name}" deleted` };
  }

  function getPersona(args: GetPersonaArgs): PersonaResult | ErrorResult {
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
    let sql = 'SELECT * FROM personas';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.enabled_only) {
      conditions.push('enabled = 1');
    }
    if (args.consumption_mode) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(consumption_modes) WHERE value = ?)');
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
    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = now.toISOString();

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
             p.consumption_modes as p_modes, p.behavior_traits as p_traits,
             p.endpoints as p_endpoints, p.credentials_ref as p_creds,
             p.enabled as p_enabled, p.cto_protected as p_cto_protected,
             p.created_at as p_created,
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
      p_id: string; p_name: string; p_description: string; p_modes: string;
      p_traits: string; p_endpoints: string; p_creds: string | null;
      p_enabled: number; p_cto_protected: number; p_created: string; p_updated: string; p_ts: number;
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
            consumption_modes: JSON.parse(row.p_modes) as ConsumptionMode[],
            behavior_traits: JSON.parse(row.p_traits) as string[],
            endpoints: JSON.parse(row.p_endpoints) as string[],
            credentials_ref: row.p_creds,
            enabled: row.p_enabled === 1,
            cto_protected: row.p_cto_protected === 1,
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
    const session = db.prepare('SELECT * FROM feedback_sessions WHERE id = ?').get(args.session_id) as FeedbackSessionRecord | undefined;

    if (!session) {
      return { error: `Feedback session not found: ${args.session_id}` };
    }

    const now = new Date().toISOString();

    // Write feature_id if provided (enables per-feature tracking)
    if (args.feature_id) {
      db.prepare('UPDATE feedback_sessions SET feature_id = ? WHERE id = ?')
        .run(args.feature_id, args.session_id);
    }

    db.prepare(`
      UPDATE feedback_sessions
      SET status = ?, completed_at = ?, findings_count = ?, report_ids = ?, satisfaction_level = ?
      WHERE id = ?
    `).run(
      args.status,
      now,
      args.findings_count ?? 0,
      JSON.stringify(args.report_ids ?? []),
      args.satisfaction_level ?? null,
      args.session_id,
    );

    // Upsert into latest_feature_feedback if this session has a feature_id
    const sessionRow = db.prepare(
      'SELECT feature_id, persona_id, recording_path FROM feedback_sessions WHERE id = ?'
    ).get(args.session_id) as { feature_id: string | null; persona_id: string; recording_path: string | null } | undefined;

    if (sessionRow?.feature_id) {
      db.prepare(`
        INSERT INTO latest_feature_feedback (feature_id, persona_id, session_id, recording_path, completed_at, satisfaction_level)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(feature_id, persona_id) DO UPDATE SET
          session_id = excluded.session_id,
          recording_path = excluded.recording_path,
          completed_at = excluded.completed_at,
          satisfaction_level = excluded.satisfaction_level
      `).run(
        sessionRow.feature_id,
        sessionRow.persona_id,
        args.session_id,
        sessionRow.recording_path,
        new Date().toISOString(),
        args.satisfaction_level ?? null,
      );
    }

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
    const sessionEventsDbPath = path.join(config.projectDir, '.claude', 'session-events.db');

    if (!fs.existsSync(sessionEventsDbPath)) {
      throw new Error(`session-events.db not found at ${sessionEventsDbPath}`);
    }

    // Query session events
    let eventsDb: Database.Database | null = null;
    try {
      eventsDb = openReadonlyDb(sessionEventsDbPath);

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
        let inputData: Record<string, unknown> = {};
        let outputData: unknown = null;
        let errorData: unknown = null;
        let metadataData: Record<string, unknown> = {};

        try {
          if (event.input) {
            inputData = JSON.parse(event.input) as Record<string, unknown>;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[user-feedback] Failed to parse audit input JSON: ${msg}\n`);
          inputData = {};
        }

        try {
          if (event.output) {
            outputData = JSON.parse(event.output) as unknown;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[user-feedback] Failed to parse audit output JSON: ${msg}\n`);
          outputData = null;
        }

        try {
          if (event.error) {
            errorData = JSON.parse(event.error) as unknown;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[user-feedback] Failed to parse audit error JSON: ${msg}\n`);
          errorData = null;
        }

        try {
          if (event.metadata) {
            metadataData = JSON.parse(event.metadata) as Record<string, unknown>;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[user-feedback] Failed to parse audit metadata JSON: ${msg}\n`);
          metadataData = {};
        }

        mcpActions.push({
          timestamp: event.timestamp,
          tool: (inputData.tool as string) || (inputData.name as string) || 'unknown',
          args: inputData.args || inputData.arguments || null,
          result: outputData,
          error: errorData,
          duration_ms: event.duration_ms,
          mcp_server: (metadataData.mcp_server as string) || null,
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
  // Demo Scenario CRUD
  // ============================================================================

  function resolveMainProjectDir(projectDir: string): string {
    // If projectDir is inside a git worktree, resolve the main repo root.
    // Worktrees have a .git *file* (not dir) containing: gitdir: /path/to/main/.git/worktrees/<name>
    try {
      const gitPath = path.join(projectDir, '.git');
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, 'utf-8');
        const match = content.match(/gitdir:\s*(.+)/);
        if (match) {
          const gitDir = path.resolve(projectDir, match[1].trim());
          // gitDir is like /repo/.git/worktrees/<name>, main repo is 3 levels up
          return path.resolve(gitDir, '..', '..', '..');
        }
      }
    } catch { /* not a worktree or unreadable */ }
    // Also detect GENTYR-style .claude/worktrees/ path pattern
    const worktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
    const idx = projectDir.indexOf(worktreeMarker);
    if (idx !== -1) {
      return projectDir.substring(0, idx);
    }
    return projectDir;
  }

  type DiscoverResult =
    | { status: 'discovered'; names: string[] }
    | { status: 'no-config' }
    | { status: 'error'; message: string };

  function discoverProjectNames(projectDir: string): DiscoverResult {
    try {
      const resolvedDir = resolveMainProjectDir(projectDir);
      const configPath = path.join(resolvedDir, 'playwright.config.ts');
      const content = fs.readFileSync(configPath, 'utf-8');
      const names: string[] = [];
      const re = /name:\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        names.push(match[1]);
      }
      return { status: 'discovered', names };
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'no-config' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'error', message: `Failed to read playwright.config.ts: ${msg}` };
    }
  }

  function createScenario(args: CreateScenarioArgs): ScenarioResult | ErrorResult {
    // Validate persona exists and includes 'gui' or 'adk' in consumption_modes
    const persona = db.prepare('SELECT id, name, consumption_modes FROM personas WHERE id = ?').get(args.persona_id) as { id: string; name: string; consumption_modes: string } | undefined;
    if (!persona) {
      return { error: `Persona not found: ${args.persona_id}` };
    }
    const personaModes = JSON.parse(persona.consumption_modes) as string[];
    if (!personaModes.includes('gui') && !personaModes.includes('adk')) {
      return { error: `Demo scenarios require a GUI or ADK persona. Persona "${persona.name}" has consumption_modes ${JSON.stringify(personaModes)}. Only personas that include "gui" or "adk" in consumption_modes can have demo scenarios.` };
    }

    // Enforce .demo.ts suffix
    if (!args.test_file.endsWith('.demo.ts')) {
      return { error: `test_file must end with ".demo.ts" — got "${args.test_file}"` };
    }

    // Validate playwright_project against actual config (G001: fail-closed)
    const discovered = discoverProjectNames(config.projectDir);
    if (discovered.status === 'error') {
      return { error: discovered.message };
    }
    if (discovered.status === 'discovered' && !discovered.names.includes(args.playwright_project)) {
      return { error: `Invalid playwright_project "${args.playwright_project}". Valid projects: ${discovered.names.join(', ')}` };
    }

    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = now.toISOString();

    // Validate env_vars if provided
    if (args.env_vars) {
      const envError = validateScenarioEnvVars(args.env_vars);
      if (envError) return { error: envError };
    }

    try {
      db.prepare(`
        INSERT INTO demo_scenarios (id, persona_id, title, description, category, playwright_project, test_file, sort_order, enabled, headed, remote_eligible, stealth_required, dual_instance, telemetry, created_at, created_timestamp, updated_at, env_vars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        args.persona_id,
        args.title,
        args.description,
        args.category ?? null,
        args.playwright_project,
        args.test_file,
        args.sort_order ?? 0,
        args.headed ? 1 : 0,
        args.remote_eligible ? 1 : 0,
        args.stealth_required ? 1 : 0,
        args.dual_instance ? 1 : 0,
        args.telemetry ? 1 : 0,
        created_at,
        created_timestamp,
        created_at,
        args.env_vars ? JSON.stringify(args.env_vars) : null,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint')) {
        return { error: `A scenario with test_file "${args.test_file}" already exists` };
      }
      return { error: `Failed to create scenario: ${message}` };
    }

    const record = db.prepare('SELECT * FROM demo_scenarios WHERE id = ?').get(id) as ScenarioRecord;
    return scenarioToResult(record, persona.name);
  }

  function updateScenario(args: UpdateScenarioArgs): ScenarioResult | ErrorResult {
    const record = db.prepare('SELECT * FROM demo_scenarios WHERE id = ?').get(args.id) as ScenarioRecord | undefined;
    if (!record) {
      return { error: `Scenario not found: ${args.id}` };
    }

    // Enforce .demo.ts suffix on test_file if changed
    if (args.test_file !== undefined && !args.test_file.endsWith('.demo.ts')) {
      return { error: `test_file must end with ".demo.ts" — got "${args.test_file}"` };
    }

    // Validate playwright_project against actual config (G001: fail-closed)
    if (args.playwright_project !== undefined) {
      const discovered = discoverProjectNames(config.projectDir);
      if (discovered.status === 'error') {
        return { error: discovered.message };
      }
      if (discovered.status === 'discovered' && !discovered.names.includes(args.playwright_project)) {
        return { error: `Invalid playwright_project "${args.playwright_project}". Valid projects: ${discovered.names.join(', ')}` };
      }
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (args.title !== undefined) { updates.push('title = ?'); params.push(args.title); }
    if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
    if (args.category !== undefined) { updates.push('category = ?'); params.push(args.category); }
    if (args.playwright_project !== undefined) { updates.push('playwright_project = ?'); params.push(args.playwright_project); }
    if (args.test_file !== undefined) { updates.push('test_file = ?'); params.push(args.test_file); }
    if (args.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(args.sort_order); }
    if (args.enabled !== undefined) { updates.push('enabled = ?'); params.push(args.enabled ? 1 : 0); }
    if (args.headed !== undefined) { updates.push('headed = ?'); params.push(args.headed ? 1 : 0); }
    if (args.remote_eligible !== undefined) { updates.push('remote_eligible = ?'); params.push(args.remote_eligible ? 1 : 0); }
    if (args.stealth_required !== undefined) { updates.push('stealth_required = ?'); params.push(args.stealth_required ? 1 : 0); }
    if (args.dual_instance !== undefined) { updates.push('dual_instance = ?'); params.push(args.dual_instance ? 1 : 0); }
    if (args.telemetry !== undefined) { updates.push('telemetry = ?'); params.push(args.telemetry ? 1 : 0); }
    if (args.env_vars !== undefined) {
      if (args.env_vars === null) {
        updates.push('env_vars = ?'); params.push(null);
      } else {
        const envError = validateScenarioEnvVars(args.env_vars);
        if (envError) return { error: envError };
        updates.push('env_vars = ?'); params.push(JSON.stringify(args.env_vars));
      }
    }

    if (updates.length === 0) {
      return { error: 'No fields to update' };
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(args.id);

    try {
      db.prepare(`UPDATE demo_scenarios SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint')) {
        return { error: `A scenario with test_file "${args.test_file}" already exists` };
      }
      return { error: `Failed to update scenario: ${message}` };
    }

    const updated = db.prepare('SELECT * FROM demo_scenarios WHERE id = ?').get(args.id) as ScenarioRecord;
    const persona = db.prepare('SELECT name FROM personas WHERE id = ?').get(updated.persona_id) as { name: string } | undefined;
    return scenarioToResult(updated, persona?.name);
  }

  function deleteScenario(args: DeleteScenarioArgs): { deleted: boolean; message: string } | ErrorResult {
    const record = db.prepare('SELECT * FROM demo_scenarios WHERE id = ?').get(args.id) as ScenarioRecord | undefined;
    if (!record) {
      return { error: `Scenario not found: ${args.id}` };
    }

    db.prepare('DELETE FROM demo_scenarios WHERE id = ?').run(args.id);
    return { deleted: true, message: `Scenario "${record.title}" deleted` };
  }

  function disableScenarios(args: DisableScenariosArgs): DisableScenariosResult | ErrorResult {
    const results: BulkScenarioResult[] = [];
    const stmt = db.prepare('UPDATE demo_scenarios SET enabled = 0, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();

    for (const id of args.scenario_ids) {
      const existing = db.prepare('SELECT id, title FROM demo_scenarios WHERE id = ?').get(id) as { id: string; title: string } | undefined;
      if (!existing) {
        results.push({ id, title: '', success: false, error: 'Scenario not found' });
        continue;
      }
      stmt.run(now, id);
      results.push({ id, title: existing.title, success: true });
    }

    const disabledCount = results.filter(r => r.success).length;
    return {
      disabled: disabledCount,
      total: args.scenario_ids.length,
      reason: args.reason,
      results,
    };
  }

  function enableScenarios(args: EnableScenariosArgs): EnableScenariosResult | ErrorResult {
    const results: BulkScenarioResult[] = [];
    const stmt = db.prepare('UPDATE demo_scenarios SET enabled = 1, updated_at = ? WHERE id = ?');
    const now = new Date().toISOString();

    for (const id of args.scenario_ids) {
      const existing = db.prepare('SELECT id, title FROM demo_scenarios WHERE id = ?').get(id) as { id: string; title: string } | undefined;
      if (!existing) {
        results.push({ id, title: '', success: false, error: 'Scenario not found' });
        continue;
      }
      stmt.run(now, id);
      results.push({ id, title: existing.title, success: true });
    }

    const enabledCount = results.filter(r => r.success).length;
    return {
      enabled: enabledCount,
      total: args.scenario_ids.length,
      results,
    };
  }

  function listScenarios(args: ListScenariosArgs): { scenarios: ScenarioResult[]; total: number } {
    let sql = `
      SELECT ds.*, p.name as persona_name
      FROM demo_scenarios ds
      JOIN personas p ON p.id = ds.persona_id
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.persona_id) {
      conditions.push('ds.persona_id = ?');
      params.push(args.persona_id);
    }
    if (args.enabled_only) {
      conditions.push('ds.enabled = 1');
    }
    if (args.category) {
      conditions.push('ds.category = ?');
      params.push(args.category);
    }
    if (args.remote_eligible !== undefined) {
      conditions.push('ds.remote_eligible = ?');
      params.push(args.remote_eligible ? 1 : 0);
    }
    if (args.stealth_required !== undefined) {
      conditions.push('ds.stealth_required = ?');
      params.push(args.stealth_required ? 1 : 0);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' ORDER BY p.name, ds.sort_order LIMIT ?';
    params.push(args.limit ?? 50);

    const records = db.prepare(sql).all(...params) as (ScenarioRecord & { persona_name: string })[];

    return {
      scenarios: records.map(r => scenarioToResult(r, r.persona_name)),
      total: records.length,
    };
  }

  function getScenario(args: GetScenarioArgs): ScenarioResult | ErrorResult {
    const record = db.prepare(`
      SELECT ds.*, p.name as persona_name
      FROM demo_scenarios ds
      JOIN personas p ON p.id = ds.persona_id
      WHERE ds.id = ?
    `).get(args.id) as (ScenarioRecord & { persona_name: string }) | undefined;

    if (!record) {
      return { error: `Scenario not found: ${args.id}` };
    }

    return scenarioToResult(record, record.persona_name);
  }

  // ============================================================================
  // Demo Completeness Verification
  // ============================================================================

  function verifyDemoCompleteness(args: VerifyDemoCompletenessArgs): VerifyDemoCompletenessResult {
    // Query all enabled scenarios with persona names
    const scenarios = db.prepare(`
      SELECT ds.id, ds.title, ds.persona_id, ds.last_recorded_at, ds.recording_path,
             p.name as persona_name
      FROM demo_scenarios ds
      LEFT JOIN personas p ON p.id = ds.persona_id
      WHERE ds.enabled = 1
      ORDER BY ds.sort_order, ds.title
    `).all() as Array<{
      id: string; title: string; persona_id: string;
      last_recorded_at: string | null; recording_path: string | null;
      persona_name: string;
    }>;

    // Check if demo_results table has the branch column (auto-migrated)
    let hasBranchColumn = true;
    try { db.prepare('SELECT branch FROM demo_results LIMIT 0').run(); } catch { hasBranchColumn = false; }

    const results: DemoCompletenessScenarioStatus[] = scenarios.map(s => {
      // Find the latest result since the given timestamp (pass or fail)
      let query = `
        SELECT status, completed_at
        FROM demo_results
        WHERE scenario_id = ? AND completed_at >= ?
      `;
      const params: unknown[] = [s.id, args.since];

      if (args.branch && hasBranchColumn) {
        query += ' AND branch = ?';
        params.push(args.branch);
      }

      query += ' ORDER BY completed_at DESC LIMIT 1';

      const latestResult = db.prepare(query).get(...params) as {
        status: string; completed_at: string;
      } | undefined;

      const hasFreshRecording = !!(
        s.last_recorded_at && s.last_recorded_at >= args.since
      );

      return {
        scenario_id: s.id,
        title: s.title,
        persona_name: s.persona_name ?? 'unknown',
        latest_result_status: (latestResult?.status as 'passed' | 'failed') ?? 'none',
        latest_result_at: latestResult?.completed_at ?? null,
        has_fresh_recording: hasFreshRecording,
        recording_path: s.recording_path,
        last_recorded_at: s.last_recorded_at,
      };
    });

    const scenariosWithPass = results.filter(r => r.latest_result_status === 'passed');
    const scenariosWithRecording = results.filter(r => r.has_fresh_recording);
    const missingPass = results.filter(r => r.latest_result_status !== 'passed');
    const missingRecording = args.require_recording !== false
      ? results.filter(r => !r.has_fresh_recording)
      : [];

    const complete = missingPass.length === 0 &&
      (args.require_recording !== false ? missingRecording.length === 0 : true);

    return {
      complete,
      total_enabled_scenarios: scenarios.length,
      scenarios_with_passing_result: scenariosWithPass.length,
      scenarios_with_fresh_recording: scenariosWithRecording.length,
      scenarios_missing_pass: missingPass,
      scenarios_missing_recording: missingRecording,
      all_scenarios: results,
      since: args.since,
      branch: args.branch ?? null,
      checked_at: new Date().toISOString(),
    };
  }

  // ============================================================================
  // Demo Prerequisite CRUD
  // ============================================================================

  function registerPrerequisite(args: RegisterPrerequisiteArgs): PrerequisiteResult | ErrorResult {
    // Validate scope constraints
    if (args.scope === 'persona') {
      if (!args.persona_id) {
        return { error: 'persona_id is required when scope is "persona"' };
      }
      const persona = db.prepare('SELECT id, name FROM personas WHERE id = ?').get(args.persona_id) as { id: string; name: string } | undefined;
      if (!persona) {
        return { error: `Persona not found: ${args.persona_id}` };
      }
    } else if (args.scope === 'scenario') {
      if (!args.scenario_id) {
        return { error: 'scenario_id is required when scope is "scenario"' };
      }
      const scenario = db.prepare('SELECT id, title FROM demo_scenarios WHERE id = ?').get(args.scenario_id) as { id: string; title: string } | undefined;
      if (!scenario) {
        return { error: `Scenario not found: ${args.scenario_id}` };
      }
    } else {
      // scope === 'global' — persona_id and scenario_id must not be set
      if (args.persona_id) {
        return { error: 'persona_id must not be set when scope is "global"' };
      }
      if (args.scenario_id) {
        return { error: 'scenario_id must not be set when scope is "global"' };
      }
    }

    const id = randomUUID();
    const now = new Date();
    const created_at = now.toISOString();
    const created_timestamp = now.toISOString();

    try {
      db.prepare(`
        INSERT INTO demo_prerequisites (id, command, description, timeout_ms, health_check, health_check_timeout_ms, scope, persona_id, scenario_id, sort_order, enabled, run_as_background, created_at, created_timestamp, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        id,
        args.command,
        args.description,
        args.timeout_ms ?? 30000,
        args.health_check ?? null,
        args.health_check_timeout_ms ?? 5000,
        args.scope ?? 'global',
        args.persona_id ?? null,
        args.scenario_id ?? null,
        args.sort_order ?? 0,
        args.run_as_background ? 1 : 0,
        created_at,
        created_timestamp,
        created_at,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to register prerequisite: ${message}` };
    }

    const record = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(id) as PrerequisiteRecord;

    let personaName: string | undefined;
    if (record.persona_id) {
      const p = db.prepare('SELECT name FROM personas WHERE id = ?').get(record.persona_id) as { name: string } | undefined;
      personaName = p?.name;
    }
    let scenarioTitle: string | undefined;
    if (record.scenario_id) {
      const s = db.prepare('SELECT title FROM demo_scenarios WHERE id = ?').get(record.scenario_id) as { title: string } | undefined;
      scenarioTitle = s?.title;
    }

    return prerequisiteToResult(record, personaName, scenarioTitle);
  }

  function updatePrerequisite(args: UpdatePrerequisiteArgs): PrerequisiteResult | ErrorResult {
    const record = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(args.id) as PrerequisiteRecord | undefined;
    if (!record) {
      return { error: `Prerequisite not found: ${args.id}` };
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (args.command !== undefined) { updates.push('command = ?'); params.push(args.command); }
    if (args.description !== undefined) { updates.push('description = ?'); params.push(args.description); }
    if (args.timeout_ms !== undefined) { updates.push('timeout_ms = ?'); params.push(args.timeout_ms); }
    if (args.health_check !== undefined) { updates.push('health_check = ?'); params.push(args.health_check); }
    if (args.health_check_timeout_ms !== undefined) { updates.push('health_check_timeout_ms = ?'); params.push(args.health_check_timeout_ms); }
    if (args.sort_order !== undefined) { updates.push('sort_order = ?'); params.push(args.sort_order); }
    if (args.enabled !== undefined) { updates.push('enabled = ?'); params.push(args.enabled ? 1 : 0); }
    if (args.run_as_background !== undefined) { updates.push('run_as_background = ?'); params.push(args.run_as_background ? 1 : 0); }

    if (updates.length === 0) {
      return { error: 'No fields to update' };
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(args.id);

    try {
      db.prepare(`UPDATE demo_prerequisites SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Failed to update prerequisite: ${message}` };
    }

    const updated = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(args.id) as PrerequisiteRecord;

    let personaName: string | undefined;
    if (updated.persona_id) {
      const p = db.prepare('SELECT name FROM personas WHERE id = ?').get(updated.persona_id) as { name: string } | undefined;
      personaName = p?.name;
    }
    let scenarioTitle: string | undefined;
    if (updated.scenario_id) {
      const s = db.prepare('SELECT title FROM demo_scenarios WHERE id = ?').get(updated.scenario_id) as { title: string } | undefined;
      scenarioTitle = s?.title;
    }

    return prerequisiteToResult(updated, personaName, scenarioTitle);
  }

  function deletePrerequisite(args: DeletePrerequisiteArgs): { deleted: boolean; message: string } | ErrorResult {
    const record = db.prepare('SELECT * FROM demo_prerequisites WHERE id = ?').get(args.id) as PrerequisiteRecord | undefined;
    if (!record) {
      return { error: `Prerequisite not found: ${args.id}` };
    }

    db.prepare('DELETE FROM demo_prerequisites WHERE id = ?').run(args.id);
    return { deleted: true, message: `Prerequisite "${record.description}" deleted` };
  }

  function listPrerequisites(args: ListPrerequisitesArgs): { prerequisites: PrerequisiteResult[]; total: number } {
    let sql = `
      SELECT dp.*,
             p.name as persona_name,
             ds.title as scenario_title
      FROM demo_prerequisites dp
      LEFT JOIN personas p ON p.id = dp.persona_id
      LEFT JOIN demo_scenarios ds ON ds.id = dp.scenario_id
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (args.scope) {
      conditions.push('dp.scope = ?');
      params.push(args.scope);
    }
    if (args.persona_id) {
      conditions.push('dp.persona_id = ?');
      params.push(args.persona_id);
    }
    if (args.scenario_id) {
      conditions.push('dp.scenario_id = ?');
      params.push(args.scenario_id);
    }
    if (args.enabled_only) {
      conditions.push('dp.enabled = 1');
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    // global first (scope DESC: 's' > 'p' > 'g' — use CASE for explicit ordering), then sort_order ASC
    sql += ` ORDER BY CASE dp.scope WHEN 'global' THEN 1 WHEN 'persona' THEN 2 WHEN 'scenario' THEN 3 END, dp.sort_order ASC`;

    const records = db.prepare(sql).all(...params) as (PrerequisiteRecord & { persona_name: string | null; scenario_title: string | null })[];

    return {
      prerequisites: records.map(r => prerequisiteToResult(r, r.persona_name ?? undefined, r.scenario_title ?? undefined)),
      total: records.length,
    };
  }

  // ============================================================================
  // Recording Tools
  // ============================================================================

  const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

  function listRecordings(args: ListRecordingsArgs): ListRecordingsResult {
    const now = Date.now();

    const demos: DemoRecordingEntry[] = [];
    const feedbackEntries: FeedbackRecordingEntry[] = [];

    if (args.type === 'demo' || args.type === 'all') {
      let sql = `
        SELECT ds.id as scenario_id, ds.title, ds.test_file, ds.persona_id,
               ds.recording_path, ds.last_recorded_at,
               p.name as persona_name
        FROM demo_scenarios ds
        JOIN personas p ON p.id = ds.persona_id
        WHERE ds.recording_path IS NOT NULL
      `;
      const params: unknown[] = [];

      if (args.persona_id) {
        sql += ' AND ds.persona_id = ?';
        params.push(args.persona_id);
      }

      sql += ' ORDER BY ds.last_recorded_at DESC';

      const rows = db.prepare(sql).all(...params) as {
        scenario_id: string;
        title: string;
        test_file: string;
        persona_id: string;
        recording_path: string;
        last_recorded_at: string | null;
        persona_name: string;
      }[];

      for (const row of rows) {
        const recordedAt = row.last_recorded_at ?? '';
        const recordedMs = recordedAt ? new Date(recordedAt).getTime() : 0;
        demos.push({
          scenario_id: row.scenario_id,
          title: row.title,
          persona_id: row.persona_id,
          persona_name: row.persona_name,
          test_file: row.test_file,
          recording_path: row.recording_path,
          recorded_at: recordedAt,
          stale: recordedMs > 0 ? now - recordedMs > STALE_THRESHOLD_MS : true,
        });
      }
    }

    if (args.type === 'feedback' || args.type === 'all') {
      let sql = `
        SELECT fs.id as session_id, fs.persona_id, fs.recording_path, fs.completed_at,
               fs.feature_id, f.name as feature_name,
               p.name as persona_name
        FROM feedback_sessions fs
        JOIN personas p ON p.id = fs.persona_id
        LEFT JOIN features f ON f.id = fs.feature_id
        WHERE fs.recording_path IS NOT NULL
      `;
      const params: unknown[] = [];

      if (args.persona_id) {
        sql += ' AND fs.persona_id = ?';
        params.push(args.persona_id);
      }

      sql += ' ORDER BY fs.completed_at DESC';

      const rows = db.prepare(sql).all(...params) as {
        session_id: string;
        persona_id: string;
        recording_path: string;
        completed_at: string | null;
        feature_id: string | null;
        feature_name: string | null;
        persona_name: string;
      }[];

      for (const row of rows) {
        const recordedAt = row.completed_at ?? '';
        const recordedMs = recordedAt ? new Date(recordedAt).getTime() : 0;
        const entry: FeedbackRecordingEntry = {
          session_id: row.session_id,
          persona_id: row.persona_id,
          persona_name: row.persona_name,
          recording_path: row.recording_path,
          recorded_at: recordedAt,
          stale: recordedMs > 0 ? now - recordedMs > STALE_THRESHOLD_MS : true,
        };
        if (row.feature_id !== null) {
          entry.feature_id = row.feature_id;
        }
        if (row.feature_name !== null) {
          entry.feature_name = row.feature_name;
        }
        feedbackEntries.push(entry);
      }
    }

    return {
      demos,
      feedback: feedbackEntries,
      total: demos.length + feedbackEntries.length,
    };
  }

  function getRecording(args: GetRecordingArgs): GetRecordingResult | ErrorResult {
    if (args.scenario_id !== undefined) {
      const row = db.prepare(`
        SELECT ds.id, ds.title, ds.persona_id, ds.recording_path, ds.last_recorded_at,
               p.name as persona_name
        FROM demo_scenarios ds
        JOIN personas p ON p.id = ds.persona_id
        WHERE ds.id = ?
      `).get(args.scenario_id) as {
        id: string;
        title: string;
        persona_id: string;
        recording_path: string | null;
        last_recorded_at: string | null;
        persona_name: string;
      } | undefined;

      if (!row) {
        return { error: `Scenario not found: ${args.scenario_id}` };
      }

      if (!row.recording_path) {
        return {
          exists: false,
          path: null,
          size_mb: null,
          recorded_at: null,
          details: null,
        };
      }

      let size_mb: number | null = null;
      const fileExists = fs.existsSync(row.recording_path);
      if (fileExists) {
        try {
          const stat = fs.statSync(row.recording_path);
          size_mb = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
        } catch {
          // File stat failed — treat as missing
        }
      }

      return {
        exists: fileExists,
        path: row.recording_path,
        size_mb,
        recorded_at: row.last_recorded_at,
        details: {
          type: 'demo',
          scenario_id: row.id,
          title: row.title,
          persona_id: row.persona_id,
          persona_name: row.persona_name,
        },
      };
    }

    if (args.session_id !== undefined) {
      const row = db.prepare(`
        SELECT fs.id, fs.persona_id, fs.recording_path, fs.completed_at,
               p.name as persona_name
        FROM feedback_sessions fs
        JOIN personas p ON p.id = fs.persona_id
        WHERE fs.id = ?
      `).get(args.session_id) as {
        id: string;
        persona_id: string;
        recording_path: string | null;
        completed_at: string | null;
        persona_name: string;
      } | undefined;

      if (!row) {
        return { error: `Feedback session not found: ${args.session_id}` };
      }

      if (!row.recording_path) {
        return {
          exists: false,
          path: null,
          size_mb: null,
          recorded_at: null,
          details: null,
        };
      }

      let size_mb: number | null = null;
      const fileExists = fs.existsSync(row.recording_path);
      if (fileExists) {
        try {
          const stat = fs.statSync(row.recording_path);
          size_mb = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
        } catch {
          // File stat failed — treat as missing
        }
      }

      return {
        exists: fileExists,
        path: row.recording_path,
        size_mb,
        recorded_at: row.completed_at,
        details: {
          type: 'feedback',
          session_id: row.id,
          persona_id: row.persona_id,
          persona_name: row.persona_name,
        },
      };
    }

    return { error: 'Either scenario_id or session_id must be provided' };
  }

  function playRecording(args: PlayRecordingArgs): Promise<{ success: boolean; message: string } | ErrorResult> {
    return new Promise((resolve) => {
      let recordingPath: string | null = null;
      let label = '';

      if (args.scenario_id !== undefined) {
        const row = db.prepare(
          'SELECT recording_path, title FROM demo_scenarios WHERE id = ?'
        ).get(args.scenario_id) as { recording_path: string | null; title: string } | undefined;

        if (!row) {
          resolve({ error: `Scenario not found: ${args.scenario_id}` });
          return;
        }

        recordingPath = row.recording_path;
        label = `demo scenario "${row.title}"`;
      } else if (args.session_id !== undefined) {
        const row = db.prepare(
          'SELECT recording_path FROM feedback_sessions WHERE id = ?'
        ).get(args.session_id) as { recording_path: string | null } | undefined;

        if (!row) {
          resolve({ error: `Feedback session not found: ${args.session_id}` });
          return;
        }

        recordingPath = row.recording_path;
        label = `feedback session ${args.session_id}`;
      } else {
        resolve({ error: 'Either scenario_id or session_id must be provided' });
        return;
      }

      if (!recordingPath) {
        resolve({ error: `No recording found for ${label}` });
        return;
      }

      if (!fs.existsSync(recordingPath)) {
        resolve({ error: `Recording file not found on disk: ${recordingPath}` });
        return;
      }

      execFile('open', [recordingPath], (err) => {
        if (err) {
          resolve({ error: `Failed to open recording: ${err.message}` });
          return;
        }
        resolve({ success: true, message: `Opened recording for ${label}: ${recordingPath}` });
      });
    });
  }

  // ============================================================================
  // Feature Feedback Tools
  // ============================================================================

  function getLatestFeatureFeedback(args: GetLatestFeatureFeedbackArgs): LatestFeatureFeedbackResult {
    let sql = `
      SELECT lff.feature_id, f.name as feature_name, lff.persona_id, p.name as persona_name,
             lff.session_id, lff.recording_path, lff.completed_at, lff.satisfaction_level
      FROM latest_feature_feedback lff
      JOIN features f ON f.id = lff.feature_id
      JOIN personas p ON p.id = lff.persona_id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (args.feature_id) {
      sql += ' AND lff.feature_id = ?';
      params.push(args.feature_id);
    }
    if (args.feature_name) {
      sql += ' AND f.name = ?';
      params.push(args.feature_name);
    }
    if (args.persona_id) {
      sql += ' AND lff.persona_id = ?';
      params.push(args.persona_id);
    }

    sql += ' ORDER BY lff.completed_at DESC';

    const rows = db.prepare(sql).all(...params) as {
      feature_id: string;
      feature_name: string;
      persona_id: string;
      persona_name: string;
      session_id: string;
      recording_path: string | null;
      completed_at: string | null;
      satisfaction_level: string | null;
    }[];

    const entries: LatestFeatureFeedbackEntry[] = rows.map(row => ({
      ...row,
      exists_on_disk: row.recording_path ? fs.existsSync(row.recording_path) : false,
    }));

    return { entries, total: entries.length };
  }

  function playFeatureFeedback(args: PlayFeatureFeedbackArgs): Promise<{ success: boolean; message: string } | ErrorResult> {
    return new Promise((resolve) => {
      let sql = `
        SELECT lff.recording_path, f.name as feature_name, p.name as persona_name
        FROM latest_feature_feedback lff
        JOIN features f ON f.id = lff.feature_id
        JOIN personas p ON p.id = lff.persona_id
        WHERE f.name = ?
      `;
      const params: unknown[] = [args.feature_name];

      if (args.persona_name) {
        sql += ' AND p.name = ?';
        params.push(args.persona_name);
      }

      sql += ' ORDER BY lff.completed_at DESC LIMIT 1';

      const row = db.prepare(sql).get(...params) as {
        recording_path: string | null;
        feature_name: string;
        persona_name: string;
      } | undefined;

      if (!row) {
        resolve({ error: `No feedback recording found for feature "${args.feature_name}"${args.persona_name ? ` by persona "${args.persona_name}"` : ''}` });
        return;
      }
      if (!row.recording_path) {
        resolve({ error: `No recording file for latest feedback on "${args.feature_name}" by ${row.persona_name}` });
        return;
      }
      if (!fs.existsSync(row.recording_path)) {
        resolve({ error: `Recording file not found on disk: ${row.recording_path}` });
        return;
      }

      execFile('open', [row.recording_path], (err) => {
        if (err) {
          resolve({ error: `Failed to open recording: ${err.message}` });
          return;
        }
        resolve({
          success: true,
          message: `Opened latest feedback recording for "${row.feature_name}" by ${row.persona_name}: ${row.recording_path}`,
        });
      });
    });
  }

  // ============================================================================
  // Persona Profile System
  // ============================================================================

  const PROFILES_DIR = path.join(config.projectDir, '.claude', 'state', 'persona-profiles');
  const ACTIVE_PROFILE_PATH = path.join(PROFILES_DIR, 'active-profile.json');
  const PM_DB_PATH = path.join(config.projectDir, '.claude', 'state', 'product-manager.db');

  function ensureProfilesDir(): void {
    if (!fs.existsSync(PROFILES_DIR)) {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
    }
  }

  function getProfileDir(name: string): string {
    return path.join(PROFILES_DIR, name);
  }

  function readActiveProfile(): { name: string; activated_at: string } | null {
    try {
      return JSON.parse(fs.readFileSync(ACTIVE_PROFILE_PATH, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeActiveProfile(name: string): void {
    ensureProfilesDir();
    fs.writeFileSync(ACTIVE_PROFILE_PATH, JSON.stringify({
      name,
      activated_at: new Date().toISOString(),
    }, null, 2) + '\n');
  }

  function readProfileMeta(name: string): Record<string, unknown> | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(getProfileDir(name), 'profile.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  function snapshotDb(targetDir: string): void {
    // Checkpoint WAL to ensure all data is in the main DB file
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    fs.copyFileSync(DB_PATH, path.join(targetDir, 'user-feedback.db'));

    // Best-effort snapshot of product-manager DB
    try {
      if (fs.existsSync(PM_DB_PATH) && fs.statSync(PM_DB_PATH).size > 0) {
        const pmDb = new Database(PM_DB_PATH, { readonly: false });
        try {
          pmDb.pragma('wal_checkpoint(TRUNCATE)');
        } finally {
          pmDb.close();
        }
        fs.copyFileSync(PM_DB_PATH, path.join(targetDir, 'product-manager.db'));
      }
    } catch { /* PM DB snapshot is best-effort */ }
  }

  function restoreDb(sourceDir: string): void {
    const sourceUfDb = path.join(sourceDir, 'user-feedback.db');
    if (!fs.existsSync(sourceUfDb)) {
      throw new Error(`Profile DB not found at ${sourceUfDb}`);
    }

    // Close current DB, copy profile DB over active, reopen
    db.close();
    fs.copyFileSync(sourceUfDb, DB_PATH);
    // Remove WAL/SHM from the active path (they belong to the old DB)
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch { /* ignore */ }
    db = initializeDatabase(config.projectDir);

    // Best-effort restore of product-manager DB
    const sourcePmDb = path.join(sourceDir, 'product-manager.db');
    try {
      if (fs.existsSync(sourcePmDb)) {
        fs.copyFileSync(sourcePmDb, PM_DB_PATH);
        // Remove WAL/SHM for PM DB too
        try { fs.unlinkSync(PM_DB_PATH + '-wal'); } catch { /* ignore */ }
        try { fs.unlinkSync(PM_DB_PATH + '-shm'); } catch { /* ignore */ }
      }
    } catch { /* PM DB restore is best-effort */ }
  }

  function getDbCounts(dbPath: string): { personas: number; features: number; scenarios: number } {
    try {
      const tmpDb = new Database(dbPath, { readonly: true });
      try {
        const personas = (tmpDb.prepare('SELECT COUNT(*) as c FROM personas').get() as { c: number })?.c ?? 0;
        const features = (tmpDb.prepare('SELECT COUNT(*) as c FROM features').get() as { c: number })?.c ?? 0;
        let scenarios = 0;
        try {
          scenarios = (tmpDb.prepare('SELECT COUNT(*) as c FROM demo_scenarios').get() as { c: number })?.c ?? 0;
        } catch { /* table may not exist in older snapshots */ }
        return { personas, features, scenarios };
      } finally {
        tmpDb.close();
      }
    } catch {
      return { personas: 0, features: 0, scenarios: 0 };
    }
  }

  function hasPmContent(pmDbPath: string): boolean {
    try {
      if (!fs.existsSync(pmDbPath) || fs.statSync(pmDbPath).size === 0) return false;
      const tmpDb = new Database(pmDbPath, { readonly: true });
      try {
        const row = tmpDb.prepare("SELECT content FROM sections WHERE section_number = 1").get() as { content: string | null } | undefined;
        return !!row?.content;
      } finally {
        tmpDb.close();
      }
    } catch {
      return false;
    }
  }

  function currentDbHasData(): boolean {
    try {
      const count = (db.prepare('SELECT COUNT(*) as c FROM personas').get() as { c: number })?.c ?? 0;
      return count > 0;
    } catch {
      return false;
    }
  }

  // --- Profile Tool Handlers ---

  function checkSpawnedSessionGuard(): object | null {
    if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
      return { error: 'Spawned sessions cannot modify persona profiles. Only interactive CTO sessions can archive, create, switch, or delete profiles.' };
    }
    return null;
  }

  function archivePersonaProfile(args: ArchivePersonaProfileArgs): object {
    const guard = checkSpawnedSessionGuard();
    if (guard) return guard;
    ensureProfilesDir();
    const profileDir = getProfileDir(args.name);

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }

    // Snapshot both DBs
    snapshotDb(profileDir);

    // Write profile metadata
    const existingMeta = readProfileMeta(args.name);
    const meta = {
      name: args.name,
      description: args.description ?? existingMeta?.description ?? null,
      guiding_prompt: args.guiding_prompt ?? existingMeta?.guiding_prompt ?? null,
      created_at: (existingMeta?.created_at as string) ?? new Date().toISOString(),
      archived_at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(meta, null, 2) + '\n');

    const counts = getDbCounts(path.join(profileDir, 'user-feedback.db'));
    const hasPm = hasPmContent(path.join(profileDir, 'product-manager.db'));

    return {
      success: true,
      profile: args.name,
      archived_at: meta.archived_at,
      persona_count: counts.personas,
      feature_count: counts.features,
      scenario_count: counts.scenarios,
      has_market_research: hasPm,
      message: `Profile "${args.name}" archived with ${counts.personas} personas, ${counts.features} features, ${counts.scenarios} scenarios.`,
    };
  }

  function createPersonaProfile(args: CreatePersonaProfileArgs): object {
    const guard = checkSpawnedSessionGuard();
    if (guard) return guard;
    ensureProfilesDir();
    const profileDir = getProfileDir(args.name);

    if (fs.existsSync(profileDir)) {
      return { error: `Profile "${args.name}" already exists. Use archive_persona_profile to overwrite or delete_persona_profile first.` };
    }

    // Auto-archive current state if there's data
    const activeProfile = readActiveProfile();
    if (activeProfile && currentDbHasData()) {
      snapshotDb(getProfileDir(activeProfile.name));
      const existingMeta = readProfileMeta(activeProfile.name);
      if (existingMeta) {
        (existingMeta as Record<string, unknown>).archived_at = new Date().toISOString();
        fs.writeFileSync(path.join(getProfileDir(activeProfile.name), 'profile.json'), JSON.stringify(existingMeta, null, 2) + '\n');
      }
    } else if (!activeProfile && currentDbHasData()) {
      // No active profile but DB has data — archive as "default"
      const defaultDir = getProfileDir('default');
      if (!fs.existsSync(defaultDir)) {
        fs.mkdirSync(defaultDir, { recursive: true });
      }
      snapshotDb(defaultDir);
      fs.writeFileSync(path.join(defaultDir, 'profile.json'), JSON.stringify({
        name: 'default',
        description: 'Auto-archived from pre-profile state',
        guiding_prompt: null,
        created_at: new Date().toISOString(),
        archived_at: new Date().toISOString(),
      }, null, 2) + '\n');
    }

    // Create new profile directory with metadata
    fs.mkdirSync(profileDir, { recursive: true });
    const meta = {
      name: args.name,
      description: args.description ?? null,
      guiding_prompt: args.guiding_prompt ?? null,
      created_at: new Date().toISOString(),
      archived_at: null,
    };
    fs.writeFileSync(path.join(profileDir, 'profile.json'), JSON.stringify(meta, null, 2) + '\n');

    // Close current DB, delete it, reinitialize empty
    db.close();
    try { fs.unlinkSync(DB_PATH); } catch { /* ignore */ }
    try { fs.unlinkSync(DB_PATH + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(DB_PATH + '-shm'); } catch { /* ignore */ }
    db = initializeDatabase(config.projectDir);

    // Best-effort clear product-manager DB
    try {
      if (fs.existsSync(PM_DB_PATH)) {
        fs.unlinkSync(PM_DB_PATH);
        try { fs.unlinkSync(PM_DB_PATH + '-wal'); } catch { /* ignore */ }
        try { fs.unlinkSync(PM_DB_PATH + '-shm'); } catch { /* ignore */ }
      }
    } catch { /* PM DB clear is best-effort */ }

    // Snapshot the fresh empty state to the new profile
    snapshotDb(profileDir);

    // Set as active
    writeActiveProfile(args.name);

    return {
      success: true,
      profile: args.name,
      guiding_prompt: args.guiding_prompt ?? null,
      auto_archived: activeProfile?.name ?? (currentDbHasData() ? 'default' : null),
      restart_recommended: true,
      message: `Created empty profile "${args.name}" and switched to it.`
        + (args.guiding_prompt ? ` Guiding prompt set for market research.` : '')
        + ` Product-manager MCP server restart recommended to pick up the cleared DB.`,
    };
  }

  function switchPersonaProfile(args: SwitchPersonaProfileArgs): object {
    const guard = checkSpawnedSessionGuard();
    if (guard) return guard;
    const profileDir = getProfileDir(args.name);
    if (!fs.existsSync(profileDir) || !readProfileMeta(args.name)) {
      return { error: `Profile "${args.name}" not found.` };
    }

    const activeProfile = readActiveProfile();
    if (activeProfile?.name === args.name) {
      return { error: `Profile "${args.name}" is already active.` };
    }

    // Auto-save current state back to active profile
    if (activeProfile) {
      const activeDir = getProfileDir(activeProfile.name);
      if (fs.existsSync(activeDir)) {
        snapshotDb(activeDir);
        const existingMeta = readProfileMeta(activeProfile.name);
        if (existingMeta) {
          (existingMeta as Record<string, unknown>).archived_at = new Date().toISOString();
          fs.writeFileSync(path.join(activeDir, 'profile.json'), JSON.stringify(existingMeta, null, 2) + '\n');
        }
      }
    }

    // Restore target profile
    restoreDb(profileDir);
    writeActiveProfile(args.name);

    const counts = getDbCounts(DB_PATH);
    const meta = readProfileMeta(args.name);

    return {
      success: true,
      profile: args.name,
      guiding_prompt: (meta?.guiding_prompt as string) ?? null,
      persona_count: counts.personas,
      feature_count: counts.features,
      scenario_count: counts.scenarios,
      auto_saved: activeProfile?.name ?? null,
      restart_recommended: true,
      message: `Switched to profile "${args.name}" (${counts.personas} personas, ${counts.features} features).`
        + (activeProfile ? ` Previous profile "${activeProfile.name}" auto-saved.` : '')
        + ` Product-manager MCP server restart recommended.`,
    };
  }

  function listPersonaProfiles(): object {
    ensureProfilesDir();
    const activeProfile = readActiveProfile();

    let entries: string[];
    try {
      entries = fs.readdirSync(PROFILES_DIR).filter(e => {
        try {
          return fs.statSync(path.join(PROFILES_DIR, e)).isDirectory();
        } catch { return false; }
      });
    } catch {
      entries = [];
    }

    const profiles = entries.map(name => {
      const meta = readProfileMeta(name);
      const profileDir = getProfileDir(name);
      const ufDbPath = path.join(profileDir, 'user-feedback.db');
      const pmDbPath = path.join(profileDir, 'product-manager.db');

      const counts = fs.existsSync(ufDbPath) ? getDbCounts(ufDbPath) : { personas: 0, features: 0, scenarios: 0 };
      const hasPm = hasPmContent(pmDbPath);

      return {
        name,
        description: (meta?.description as string) ?? null,
        guiding_prompt: meta?.guiding_prompt ? (meta.guiding_prompt as string).substring(0, 100) + ((meta.guiding_prompt as string).length > 100 ? '...' : '') : null,
        persona_count: counts.personas,
        feature_count: counts.features,
        scenario_count: counts.scenarios,
        has_market_research: hasPm,
        is_active: activeProfile?.name === name,
        created_at: (meta?.created_at as string) ?? null,
        archived_at: (meta?.archived_at as string) ?? null,
      };
    });

    return {
      profiles,
      active_profile: activeProfile?.name ?? null,
      count: profiles.length,
    };
  }

  function getPersonaProfile(args: GetPersonaProfileArgs): object {
    const profileDir = getProfileDir(args.name);
    const meta = readProfileMeta(args.name);
    if (!meta) {
      return { error: `Profile "${args.name}" not found.` };
    }

    const ufDbPath = path.join(profileDir, 'user-feedback.db');
    const pmDbPath = path.join(profileDir, 'product-manager.db');
    const counts = fs.existsSync(ufDbPath) ? getDbCounts(ufDbPath) : { personas: 0, features: 0, scenarios: 0 };
    const hasPm = hasPmContent(pmDbPath);

    // Get persona and feature names from the snapshot
    let personaNames: string[] = [];
    let featureNames: string[] = [];
    try {
      if (fs.existsSync(ufDbPath)) {
        const tmpDb = new Database(ufDbPath, { readonly: true });
        try {
          personaNames = (tmpDb.prepare('SELECT name FROM personas ORDER BY name').all() as { name: string }[]).map(r => r.name);
          featureNames = (tmpDb.prepare('SELECT name FROM features ORDER BY name').all() as { name: string }[]).map(r => r.name);
        } finally {
          tmpDb.close();
        }
      }
    } catch { /* ignore */ }

    const activeProfile = readActiveProfile();

    return {
      name: args.name,
      description: meta.description ?? null,
      guiding_prompt: meta.guiding_prompt ?? null,
      persona_count: counts.personas,
      feature_count: counts.features,
      scenario_count: counts.scenarios,
      has_market_research: hasPm,
      is_active: activeProfile?.name === args.name,
      created_at: meta.created_at ?? null,
      archived_at: meta.archived_at ?? null,
      persona_names: personaNames,
      feature_names: featureNames,
    };
  }

  function deletePersonaProfile(args: DeletePersonaProfileArgs): object {
    const guard = checkSpawnedSessionGuard();
    if (guard) return guard;
    const activeProfile = readActiveProfile();
    if (activeProfile?.name === args.name) {
      return { error: `Cannot delete the active profile "${args.name}". Switch to another profile first.` };
    }

    const profileDir = getProfileDir(args.name);
    if (!fs.existsSync(profileDir)) {
      return { error: `Profile "${args.name}" not found.` };
    }

    // Remove directory recursively
    fs.rmSync(profileDir, { recursive: true, force: true });

    return {
      success: true,
      deleted: args.name,
      message: `Profile "${args.name}" deleted.`,
    };
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
    // Demo Scenario CRUD
    {
      name: 'create_scenario',
      description: 'Create a curated demo scenario for a GUI or ADK persona. GUI scenarios are product walkthroughs mapped to *.demo.ts Playwright files. ADK scenarios use session-replay-runner.demo.ts for replay. Only personas that include "gui" or "adk" in consumption_modes can have demo scenarios.',
      schema: CreateScenarioArgsSchema,
      handler: createScenario,
    },
    {
      name: 'update_scenario',
      description: 'Update an existing demo scenario. Only specified fields are changed.',
      schema: UpdateScenarioArgsSchema,
      handler: updateScenario,
    },
    {
      name: 'delete_scenario',
      description: 'Delete a demo scenario.',
      schema: DeleteScenarioArgsSchema,
      handler: deleteScenario,
    },
    {
      name: 'list_scenarios',
      description: 'List demo scenarios with optional filters (persona_id, enabled_only, category). Includes persona name enrichment.',
      schema: ListScenariosArgsSchema,
      handler: listScenarios,
    },
    {
      name: 'get_scenario',
      description: 'Get full details of a demo scenario including its persona name.',
      schema: GetScenarioArgsSchema,
      handler: getScenario,
    },
    // Bulk Scenario Disable/Enable (CTO-gated via protected-actions.json)
    {
      name: 'disable_scenarios',
      description: 'Bulk-disable demo scenarios. REQUIRES CTO APPROVAL — protected action. Use when scenarios are irrelevant to the current vertical slice and should be excluded from promotion gates. Disabled scenarios are skipped by verify_demo_completeness.',
      schema: DisableScenariosArgsSchema,
      handler: disableScenarios,
    },
    {
      name: 'enable_scenarios',
      description: 'Bulk-enable demo scenarios. No approval required — re-enabling is always safe. Use to restore previously disabled scenarios.',
      schema: EnableScenariosArgsSchema,
      handler: enableScenarios,
    },
    // Demo Completeness Verification
    {
      name: 'verify_demo_completeness',
      description: 'Verify that ALL enabled demo scenarios have a passing result (and optionally a fresh recording) since a given timestamp. Returns structured completeness data. Use to gate release pipelines — the auditor checks complete:true before allowing the phase to pass.',
      schema: VerifyDemoCompletenessArgsSchema,
      handler: (args: VerifyDemoCompletenessArgs) => JSON.stringify(verifyDemoCompleteness(args)),
    },
    // Demo Prerequisites CRUD
    {
      name: 'register_prerequisite',
      description: 'Register a setup command that must run before demos. Commands are idempotent: if a health_check is provided and passes, the setup command is skipped. Scopes: "global" (all demos), "persona" (demos for a persona), "scenario" (single scenario).',
      schema: RegisterPrerequisiteArgsSchema,
      handler: registerPrerequisite,
    },
    {
      name: 'update_prerequisite',
      description: 'Update an existing demo prerequisite. Only specified fields are changed.',
      schema: UpdatePrerequisiteArgsSchema,
      handler: updatePrerequisite,
    },
    {
      name: 'delete_prerequisite',
      description: 'Delete a demo prerequisite.',
      schema: DeletePrerequisiteArgsSchema,
      handler: deletePrerequisite,
    },
    {
      name: 'list_prerequisites',
      description: 'List demo prerequisites with optional filters (scope, persona_id, scenario_id, enabled_only). Includes enrichment with persona name and scenario title.',
      schema: ListPrerequisitesArgsSchema,
      handler: listPrerequisites,
    },
    // Recording Tools
    {
      name: 'list_recordings',
      description: 'List available demo and feedback session recordings with paths and freshness. Returns recordings grouped by type with stale flag for recordings older than 24h.',
      schema: ListRecordingsArgsSchema,
      handler: listRecordings,
    },
    {
      name: 'get_recording',
      description: 'Get recording file path and metadata for a specific demo scenario or feedback session. Verifies the file exists on disk and returns size.',
      schema: GetRecordingArgsSchema,
      handler: getRecording,
    },
    {
      name: 'play_recording',
      description: 'Open a recording in the system default video player. Resolves the recording path from scenario_id or session_id and launches it with the system open command.',
      schema: PlayRecordingArgsSchema,
      handler: playRecording,
    },
    // Feature Feedback
    {
      name: 'get_latest_feature_feedback',
      description: 'Get the latest feedback session and recording for each feature-persona combination. Filter by feature name, feature ID, or persona.',
      schema: GetLatestFeatureFeedbackArgsSchema,
      handler: getLatestFeatureFeedback,
    },
    {
      name: 'play_feature_feedback',
      description: 'Play the latest feedback recording for a specific feature. Optionally filter by persona name.',
      schema: PlayFeatureFeedbackArgsSchema,
      handler: playFeatureFeedback,
    },
    // Persona Profile Tools
    {
      name: 'create_persona_profile',
      description: 'Create a new empty persona profile and switch to it. Auto-archives current state first. The guiding_prompt is stored and surfaced to the product-manager agent during market research.',
      schema: CreatePersonaProfileArgsSchema,
      handler: createPersonaProfile,
    },
    {
      name: 'archive_persona_profile',
      description: 'Save current persona/feature/scenario/market-research state as a named profile without switching. Snapshots both user-feedback.db and product-manager.db. Overwrites if profile already exists.',
      schema: ArchivePersonaProfileArgsSchema,
      handler: archivePersonaProfile,
    },
    {
      name: 'switch_persona_profile',
      description: 'Switch to an existing persona profile. Auto-saves current state back to the active profile before switching. Restores both databases. Returns restart_recommended: true for the product-manager MCP server.',
      schema: SwitchPersonaProfileArgsSchema,
      handler: switchPersonaProfile,
    },
    {
      name: 'list_persona_profiles',
      description: 'List all persona profiles with metadata, persona/feature/scenario counts, and active status.',
      schema: ListPersonaProfilesArgsSchema,
      handler: listPersonaProfiles,
    },
    {
      name: 'get_persona_profile',
      description: 'Get detailed information about a specific persona profile including persona names, feature names, and market research status.',
      schema: GetPersonaProfileArgsSchema,
      handler: getPersonaProfile,
    },
    {
      name: 'delete_persona_profile',
      description: 'Delete a persona profile. Cannot delete the currently active profile.',
      schema: DeletePersonaProfileArgsSchema,
      handler: deletePersonaProfile,
    },
  ];

  return new McpServer({
    name: 'user-feedback',
    version: '2.0.0',
    tools,
  });
}

// ============================================================================
// Auto-start when run directly
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const projectDir = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
  const server = createUserFeedbackServer({ projectDir });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  server.start();
}
