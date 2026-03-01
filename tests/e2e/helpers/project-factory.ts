/**
 * Project Factory for E2E Tests
 *
 * Creates temporary project directories with seeded SQLite databases
 * that mimic a real GENTYR-enabled project. Used by E2E tests that
 * spawn real Claude agent sessions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// Schema from user-feedback MCP server
const USER_FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL,
  consumption_mode TEXT NOT NULL CHECK (consumption_mode IN ('gui', 'cli', 'api', 'sdk', 'adk')),
  behavior_traits TEXT NOT NULL DEFAULT '[]',
  endpoints TEXT NOT NULL DEFAULT '[]',
  credentials_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  file_patterns TEXT NOT NULL DEFAULT '[]',
  url_patterns TEXT NOT NULL DEFAULT '[]',
  category TEXT,
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_features (
  persona_id TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  test_scenarios TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (persona_id, feature_id),
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE,
  FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  trigger_ref TEXT,
  changed_features TEXT NOT NULL DEFAULT '[]',
  personas_triggered TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  max_concurrent INTEGER NOT NULL DEFAULT 3,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS feedback_sessions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  findings_count INTEGER DEFAULT 0,
  report_ids TEXT DEFAULT '[]',
  FOREIGN KEY (run_id) REFERENCES feedback_runs(id),
  FOREIGN KEY (persona_id) REFERENCES personas(id)
);
`;

// Schema must match feedback-reporter/server.ts REPORTS_SCHEMA exactly
const AGENT_REPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporting_agent TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  read_at TEXT,
  acknowledged_at TEXT,
  triage_status TEXT NOT NULL DEFAULT 'pending',
  triage_started_at TEXT,
  triage_completed_at TEXT,
  triage_session_id TEXT,
  triage_outcome TEXT,
  triage_attempted_at TEXT,
  triaged_at TEXT,
  triage_action TEXT,
  CONSTRAINT valid_category CHECK (category IN ('architecture', 'security', 'performance', 'breaking-change', 'blocker', 'decision', 'user-feedback', 'other')),
  CONSTRAINT valid_priority CHECK (priority IN ('low', 'normal', 'high', 'critical')),
  CONSTRAINT valid_triage_status CHECK (triage_status IN ('pending', 'in_progress', 'self_handled', 'escalated', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_reports_acknowledged ON reports(acknowledged_at);
CREATE INDEX IF NOT EXISTS idx_reports_triage_status ON reports(triage_status);
CREATE INDEX IF NOT EXISTS idx_reports_triage_completed ON reports(triage_completed_at);
`;

export interface PersonaInput {
  name: string;
  description: string;
  consumption_mode: 'gui' | 'cli' | 'api' | 'sdk' | 'adk';
  behavior_traits?: string[];
  endpoints?: string[];
}

export interface FeatureInput {
  name: string;
  description?: string;
  file_patterns: string[];
}

export interface MappingInput {
  persona_name: string;
  feature_name: string;
  priority?: string;
  test_scenarios?: string[];
}

export interface TestProjectOptions {
  personas: PersonaInput[];
  features: FeatureInput[];
  mappings: MappingInput[];
}

export interface TestProject {
  dir: string;
  feedbackDbPath: string;
  reportsDbPath: string;
  sessionsDir: string;
  getPersonaId(name: string): string;
  getFeatureId(name: string): string;
  cleanup(): void;
}

export function createTestProject(options: TestProjectOptions): TestProject {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentyr-e2e-'));
  const claudeDir = path.join(dir, '.claude');
  const sessionsDir = path.join(claudeDir, 'feedback-sessions');

  // Create directory structure
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Create user-feedback.db
  const feedbackDbPath = path.join(claudeDir, 'user-feedback.db');
  const feedbackDb = new Database(feedbackDbPath);
  feedbackDb.pragma('journal_mode = WAL');
  feedbackDb.pragma('foreign_keys = ON');
  feedbackDb.exec(USER_FEEDBACK_SCHEMA);

  // Create cto-reports.db (agent-reports)
  const reportsDbPath = path.join(claudeDir, 'cto-reports.db');
  const reportsDb = new Database(reportsDbPath);
  reportsDb.pragma('journal_mode = WAL');
  reportsDb.exec(AGENT_REPORTS_SCHEMA);

  // Track IDs for lookup
  const personaIds = new Map<string, string>();
  const featureIds = new Map<string, string>();

  // Seed personas
  const now = new Date();
  for (const persona of options.personas) {
    const id = randomUUID();
    personaIds.set(persona.name, id);

    feedbackDb.prepare(`
      INSERT INTO personas (id, name, description, consumption_mode, behavior_traits, endpoints, created_at, created_timestamp, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, persona.name, persona.description, persona.consumption_mode,
      JSON.stringify(persona.behavior_traits ?? []),
      JSON.stringify(persona.endpoints ?? []),
      now.toISOString(), Math.floor(now.getTime() / 1000), now.toISOString()
    );
  }

  // Seed features
  for (const feature of options.features) {
    const id = randomUUID();
    featureIds.set(feature.name, id);

    feedbackDb.prepare(`
      INSERT INTO features (id, name, description, file_patterns, url_patterns, created_at, created_timestamp)
      VALUES (?, ?, ?, ?, '[]', ?, ?)
    `).run(
      id, feature.name, feature.description ?? null,
      JSON.stringify(feature.file_patterns),
      now.toISOString(), Math.floor(now.getTime() / 1000)
    );
  }

  // Seed mappings
  for (const mapping of options.mappings) {
    const personaId = personaIds.get(mapping.persona_name);
    const featureId = featureIds.get(mapping.feature_name);

    if (!personaId || !featureId) {
      throw new Error(
        `Mapping references unknown persona "${mapping.persona_name}" or feature "${mapping.feature_name}"`
      );
    }

    feedbackDb.prepare(`
      INSERT INTO persona_features (persona_id, feature_id, priority, test_scenarios)
      VALUES (?, ?, ?, ?)
    `).run(
      personaId, featureId,
      mapping.priority ?? 'normal',
      JSON.stringify(mapping.test_scenarios ?? [])
    );
  }

  feedbackDb.close();
  reportsDb.close();

  return {
    dir,
    feedbackDbPath,
    reportsDbPath,
    sessionsDir,
    getPersonaId(name: string): string {
      const id = personaIds.get(name);
      if (!id) throw new Error(`Persona "${name}" not found`);
      return id;
    },
    getFeatureId(name: string): string {
      const id = featureIds.get(name);
      if (!id) throw new Error(`Feature "${name}" not found`);
      return id;
    },
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Non-fatal cleanup failure
      }
    },
  };
}
