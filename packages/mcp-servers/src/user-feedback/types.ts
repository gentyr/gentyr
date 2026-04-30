/**
 * Types for the User Feedback MCP Server
 *
 * Manages personas, features, persona-feature mappings, feedback runs,
 * and feedback sessions for the AI User Feedback System.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const CONSUMPTION_MODES = ['gui', 'cli', 'api', 'sdk', 'adk'] as const;
export type ConsumptionMode = (typeof CONSUMPTION_MODES)[number];

export const FEEDBACK_RUN_STATUS = ['pending', 'in_progress', 'completed', 'failed', 'partial'] as const;
export type FeedbackRunStatus = (typeof FEEDBACK_RUN_STATUS)[number];

export const FEEDBACK_SESSION_STATUS = ['pending', 'queued', 'running', 'completed', 'failed', 'timeout'] as const;
export type FeedbackSessionStatus = (typeof FEEDBACK_SESSION_STATUS)[number];

export const FEATURE_PRIORITY = ['low', 'normal', 'high', 'critical'] as const;
export type FeaturePriority = (typeof FEATURE_PRIORITY)[number];

// ============================================================================
// Persona CRUD Schemas (G003 Compliance)
// ============================================================================

export const CreatePersonaArgsSchema = z.object({
  name: z.string().min(1).max(100).describe('Unique persona name (e.g., "power-user", "first-time-visitor")'),
  description: z.string().min(1).max(500).describe('Description of who this persona represents'),
  consumption_modes: z.union([
    z.enum(CONSUMPTION_MODES),
    z.array(z.enum(CONSUMPTION_MODES)).min(1),
  ]).transform(v => Array.isArray(v) ? v : [v])
    .describe('How this persona consumes the product (single mode or array of modes)'),
  behavior_traits: z.array(z.string().max(200)).max(10).optional()
    .describe('Behavioral traits (e.g., "impatient", "explores all menus", "uses keyboard shortcuts")'),
  endpoints: z.array(z.string().max(500)).max(20).optional()
    .describe('URLs or endpoints this persona accesses'),
  credentials_ref: z.string().max(200).optional()
    .describe('Credential reference (op:// vault reference or key name)'),
  cto_protected: z.coerce.boolean().optional().default(false)
    .describe('If true, this persona cannot be modified by non-CTO agents'),
  caller: z.string().optional().describe('Agent identity for access control'),
});

export const UpdatePersonaArgsSchema = z.object({
  id: z.string().describe('Persona UUID'),
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(500).optional(),
  consumption_modes: z.union([
    z.enum(CONSUMPTION_MODES),
    z.array(z.enum(CONSUMPTION_MODES)).min(1),
  ]).transform(v => Array.isArray(v) ? v : [v]).optional()
    .describe('How this persona consumes the product (single mode or array of modes)'),
  behavior_traits: z.array(z.string().max(200)).max(10).optional(),
  endpoints: z.array(z.string().max(500)).max(20).optional(),
  credentials_ref: z.string().max(200).optional(),
  enabled: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional(),
  cto_protected: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional(),
  caller: z.string().optional().describe('Agent identity for access control'),
});

export const DeletePersonaArgsSchema = z.object({
  id: z.string().describe('Persona UUID'),
  caller: z.string().optional().describe('Agent identity for access control'),
});

export const GetPersonaArgsSchema = z.object({
  id: z.string().describe('Persona UUID'),
});

export const ListPersonasArgsSchema = z.object({
  enabled_only: z.coerce.boolean().optional().default(false),
  consumption_mode: z.enum(CONSUMPTION_MODES).optional(),
  limit: z.coerce.number().optional().default(50),
});

// ============================================================================
// Feature CRUD Schemas
// ============================================================================

export const RegisterFeatureArgsSchema = z.object({
  name: z.string().min(1).max(100).describe('Feature name (e.g., "user-authentication", "billing-dashboard")'),
  description: z.string().max(500).optional(),
  file_patterns: z.array(z.string().max(200)).max(20)
    .describe('Glob patterns for files related to this feature (e.g., "src/auth/**", "lib/billing/*.ts")'),
  url_patterns: z.array(z.string().max(200)).max(20).optional()
    .describe('URL/route patterns (e.g., "/login", "/api/v1/billing/*")'),
  category: z.string().max(50).optional(),
});

export const ListFeaturesArgsSchema = z.object({
  category: z.string().optional(),
  limit: z.coerce.number().optional().default(50),
});

export const DeleteFeatureArgsSchema = z.object({
  id: z.string().describe('Feature UUID'),
});

// ============================================================================
// Persona-Feature Mapping Schemas
// ============================================================================

export const MapPersonaFeatureArgsSchema = z.object({
  persona_id: z.string().describe('Persona UUID'),
  feature_id: z.string().describe('Feature UUID'),
  priority: z.enum(FEATURE_PRIORITY).optional().default('normal'),
  test_scenarios: z.array(z.string().max(500)).max(10).optional()
    .describe('Specific test scenarios for this persona on this feature'),
});

export const UnmapPersonaFeatureArgsSchema = z.object({
  persona_id: z.string().describe('Persona UUID'),
  feature_id: z.string().describe('Feature UUID'),
});

// ============================================================================
// Triggering & Query Schemas
// ============================================================================

export const GetPersonasForChangesArgsSchema = z.object({
  changed_files: z.array(z.string()).optional()
    .describe('List of changed file paths (from git diff)'),
  changed_features: z.array(z.string()).optional()
    .describe('List of feature IDs that changed (if known)'),
});

export const StartFeedbackRunArgsSchema = z.object({
  trigger_type: z.enum(['staging-push', 'manual', 'scheduled']),
  trigger_ref: z.string().optional().describe('Git SHA, branch name, or description'),
  changed_files: z.array(z.string()).optional(),
  changed_features: z.array(z.string()).optional(),
  persona_ids: z.array(z.string()).optional()
    .describe('Override: specific personas to trigger (bypasses change analysis)'),
  max_concurrent: z.coerce.number().min(1).max(5).optional().default(3)
    .describe('Maximum concurrent feedback sessions'),
});

export const GetFeedbackRunArgsSchema = z.object({
  id: z.string().describe('Feedback run UUID'),
});

export const ListFeedbackRunsArgsSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().optional().default(20),
});

export const SATISFACTION_LEVEL = ['very_satisfied', 'satisfied', 'neutral', 'dissatisfied', 'very_dissatisfied'] as const;
export type SatisfactionLevel = (typeof SATISFACTION_LEVEL)[number];

export const CompleteFeedbackSessionArgsSchema = z.object({
  session_id: z.string().describe('Feedback session UUID'),
  status: z.enum(['completed', 'failed', 'timeout']),
  findings_count: z.coerce.number().optional(),
  report_ids: z.array(z.string()).optional()
    .describe('IDs of agent-reports submitted during this session'),
  satisfaction_level: z.enum(SATISFACTION_LEVEL).optional()
    .describe('Satisfaction level reported by the persona'),
  feature_id: z.string().optional()
    .describe('Feature ID being reviewed (for per-feature tracking)'),
});

export const GetFeedbackRunSummaryArgsSchema = z.object({
  id: z.string().describe('Feedback run UUID'),
});

export const GetSessionAuditArgsSchema = z.object({
  feedback_session_id: z.string().describe('The feedback session ID to get audit trail for'),
  include_transcript: z.coerce.boolean().optional().default(false).describe('Include Claude session transcript hint'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type CreatePersonaArgs = z.infer<typeof CreatePersonaArgsSchema>;
export type UpdatePersonaArgs = z.infer<typeof UpdatePersonaArgsSchema>;
export type DeletePersonaArgs = z.infer<typeof DeletePersonaArgsSchema>;
export type GetPersonaArgs = z.infer<typeof GetPersonaArgsSchema>;
export type ListPersonasArgs = z.infer<typeof ListPersonasArgsSchema>;
export type RegisterFeatureArgs = z.infer<typeof RegisterFeatureArgsSchema>;
export type ListFeaturesArgs = z.infer<typeof ListFeaturesArgsSchema>;
export type DeleteFeatureArgs = z.infer<typeof DeleteFeatureArgsSchema>;
export type MapPersonaFeatureArgs = z.infer<typeof MapPersonaFeatureArgsSchema>;
export type UnmapPersonaFeatureArgs = z.infer<typeof UnmapPersonaFeatureArgsSchema>;
export type GetPersonasForChangesArgs = z.infer<typeof GetPersonasForChangesArgsSchema>;
export type StartFeedbackRunArgs = z.infer<typeof StartFeedbackRunArgsSchema>;
export type GetFeedbackRunArgs = z.infer<typeof GetFeedbackRunArgsSchema>;
export type ListFeedbackRunsArgs = z.infer<typeof ListFeedbackRunsArgsSchema>;
export type CompleteFeedbackSessionArgs = z.infer<typeof CompleteFeedbackSessionArgsSchema>;
export type GetFeedbackRunSummaryArgs = z.infer<typeof GetFeedbackRunSummaryArgsSchema>;
export type GetSessionAuditArgs = z.infer<typeof GetSessionAuditArgsSchema>;

// ============================================================================
// Record Types
// ============================================================================

export interface PersonaRecord {
  id: string;
  name: string;
  description: string;
  consumption_modes: string; // JSON array of ConsumptionMode
  behavior_traits: string; // JSON array
  endpoints: string; // JSON array
  credentials_ref: string | null;
  enabled: number; // SQLite boolean
  cto_protected: number; // SQLite boolean
  created_at: string;
  created_timestamp: string;
  updated_at: string;
}

export interface FeatureRecord {
  id: string;
  name: string;
  description: string | null;
  file_patterns: string; // JSON array
  url_patterns: string; // JSON array
  category: string | null;
  created_at: string;
  created_timestamp: string;
}

export interface PersonaFeatureRecord {
  persona_id: string;
  feature_id: string;
  priority: FeaturePriority;
  test_scenarios: string; // JSON array
}

export interface FeedbackRunRecord {
  id: string;
  trigger_type: string;
  trigger_ref: string | null;
  changed_features: string; // JSON array
  personas_triggered: string; // JSON array
  status: FeedbackRunStatus;
  max_concurrent: number;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
}

export interface FeedbackSessionRecord {
  id: string;
  run_id: string;
  persona_id: string;
  agent_id: string | null;
  status: FeedbackSessionStatus;
  started_at: string | null;
  completed_at: string | null;
  findings_count: number;
  report_ids: string; // JSON array
  satisfaction_level: string | null;
  scenario_id: string | null;
  recording_path: string | null;
  feature_id: string | null;
}

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}

export interface PersonaResult {
  id: string;
  name: string;
  description: string;
  consumption_modes: ConsumptionMode[];
  behavior_traits: string[];
  endpoints: string[];
  credentials_ref: string | null;
  enabled: boolean;
  cto_protected: boolean;
  created_at: string;
  updated_at: string;
  features?: {
    feature_id: string;
    feature_name: string;
    priority: FeaturePriority;
    test_scenarios: string[];
  }[];
}

export interface FeatureResult {
  id: string;
  name: string;
  description: string | null;
  file_patterns: string[];
  url_patterns: string[];
  category: string | null;
  created_at: string;
}

export interface PersonaForChangeResult {
  persona: PersonaResult;
  matched_features: {
    feature_id: string;
    feature_name: string;
    priority: FeaturePriority;
    test_scenarios: string[];
    matched_files: string[];
  }[];
}

export interface FeedbackRunResult {
  id: string;
  trigger_type: string;
  trigger_ref: string | null;
  changed_features: string[];
  personas_triggered: string[];
  status: FeedbackRunStatus;
  max_concurrent: number;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  sessions?: {
    id: string;
    persona_id: string;
    status: FeedbackSessionStatus;
    findings_count: number;
  }[];
}

export interface FeedbackRunSummaryResult {
  run_id: string;
  status: FeedbackRunStatus;
  total_sessions: number;
  completed_sessions: number;
  failed_sessions: number;
  timeout_sessions: number;
  total_findings: number;
  total_report_ids: string[];
  personas_tested: string[];
}

export interface McpAuditAction {
  timestamp: string;
  tool: string;
  args: unknown;
  result: unknown;
  error: unknown;
  duration_ms: number | null;
  mcp_server: string | null;
}

export interface GetSessionAuditResult {
  session_id: string;
  persona_name: string | null;
  mcp_actions: McpAuditAction[];
  total_actions: number;
  total_duration_ms: number;
  transcript_session_id?: string;
}

// ============================================================================
// Demo Scenario Schemas
// ============================================================================

export const CreateScenarioArgsSchema = z.object({
  persona_id: z.string().describe('Persona UUID this scenario belongs to — persona must include "gui" or "adk" in consumption_modes'),
  title: z.string().min(1).max(200).describe('Human-readable scenario title shown in /demo-interactive and /demo-autonomous menus'),
  description: z.string().min(1).max(2000).describe('What the scenario demonstrates — given to code-writer for implementation and to persona agents for context'),
  category: z.string().max(50).optional().describe('Optional grouping (e.g., "onboarding", "admin", "billing")'),
  playwright_project: z.string().min(1).max(100).describe('Playwright project name — MUST match an existing project in playwright.config.ts. Common projects: "demo" (e2e/demo/ — extension+vendor demos), "vendor-owner" (e2e/vendor/ — vendor dashboard), "extension" (e2e/extension/ — extension-only tests). Run discoverProjectNames() to see available projects.'),
  test_file: z.string().min(1).max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'test_file must be a relative path without ".." traversal')
    .describe('Relative path to the .demo.ts file (e.g., e2e/demo/vendor-onboarding.demo.ts)'),
  sort_order: z.coerce.number().int().min(0).max(999).optional().default(0).describe('Display order within persona'),
  env_vars: z.record(z.string(), z.string()).optional()
    .describe('Environment variables to inject when running this scenario (e.g., {"AZURE_DEMO": "1"}). Max 25 keys.'),
  headed: z.coerce.boolean().optional().default(false)
    .describe('Whether this scenario requires exclusive display access (headed Playwright, real Chrome, etc.). Headed scenarios are serialized through the display queue to prevent window capture conflicts and corrupted recordings.'),
  remote_eligible: z.coerce.boolean().optional().default(true)
    .describe('Whether this scenario can run on remote Fly.io machines. Set false for scenarios requiring local Chrome, extension sockets, or headed display access. Defaults to true.'),
  stealth_required: z.coerce.boolean().optional().default(false)
    .describe('Whether this scenario requires a stealth cloud browser (Steel.dev). Stealth scenarios bypass bot detection via residential proxies and undetectable Chromium. Fail-closed: errors if Steel not configured.'),
  dual_instance: z.coerce.boolean().optional().default(false)
    .describe('Whether this scenario requires dual-instance mode (Fly.io + Steel in parallel). Fly.io runs Playwright; Steel provides the stealth browser connected via bridge.'),
  telemetry: z.coerce.boolean().optional().default(false)
    .describe('Enable maximum telemetry capture for this scenario.'),
});

export const UpdateScenarioArgsSchema = z.object({
  id: z.string().describe('Scenario UUID'),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  category: z.string().max(50).optional(),
  playwright_project: z.string().min(1).max(100).optional()
    .describe('Playwright project name — MUST match an existing project in playwright.config.ts. Common projects: "demo" (e2e/demo/), "vendor-owner" (e2e/vendor/), "extension" (e2e/extension/).'),
  test_file: z.string().min(1).max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'test_file must be a relative path without ".." traversal')
    .optional(),
  sort_order: z.coerce.number().int().min(0).max(999).optional(),
  enabled: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional(),
  env_vars: z.record(z.string(), z.string()).nullable().optional()
    .describe('Environment variables for this scenario. Set to null to clear. Max 25 keys.'),
  headed: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional()
    .describe('Whether this scenario requires exclusive display access. Headed scenarios are serialized through the display queue.'),
  remote_eligible: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional()
    .describe('Whether this scenario can run on remote Fly.io machines.'),
  stealth_required: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional()
    .describe('Whether this scenario requires a stealth cloud browser (Steel.dev).'),
  dual_instance: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional()
    .describe('Whether this scenario requires dual-instance mode (Fly.io + Steel).'),
  telemetry: z.preprocess((val) => val === 'true' || val === true, z.boolean()).optional()
    .describe('Enable/disable maximum telemetry capture for this scenario.'),
});

export const DeleteScenarioArgsSchema = z.object({
  id: z.string().describe('Scenario UUID'),
});

export const ListScenariosArgsSchema = z.object({
  persona_id: z.string().optional().describe('Filter by persona UUID'),
  enabled_only: z.coerce.boolean().optional().default(true),
  category: z.string().optional(),
  remote_eligible: z.coerce.boolean().optional().describe('Filter by remote eligibility'),
  stealth_required: z.coerce.boolean().optional().describe('Filter by stealth requirement (Steel.dev)'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const GetScenarioArgsSchema = z.object({
  id: z.string().describe('Scenario UUID'),
});

export type CreateScenarioArgs = z.infer<typeof CreateScenarioArgsSchema>;
export type UpdateScenarioArgs = z.infer<typeof UpdateScenarioArgsSchema>;
export type DeleteScenarioArgs = z.infer<typeof DeleteScenarioArgsSchema>;
export type ListScenariosArgs = z.infer<typeof ListScenariosArgsSchema>;
export type GetScenarioArgs = z.infer<typeof GetScenarioArgsSchema>;

export interface ScenarioRecord {
  id: string;
  persona_id: string;
  title: string;
  description: string;
  category: string | null;
  playwright_project: string;
  test_file: string;
  sort_order: number;
  enabled: number;
  headed: number; // SQLite boolean (0/1)
  remote_eligible: number; // SQLite boolean (0/1)
  stealth_required: number; // SQLite boolean (0/1)
  dual_instance: number; // SQLite boolean (0/1)
  telemetry: number; // SQLite boolean (0/1)
  created_at: string;
  created_timestamp: string;
  updated_at: string;
  last_recorded_at: string | null;
  recording_path: string | null;
  env_vars: string | null; // JSON object string
}

export interface ScenarioResult {
  id: string;
  persona_id: string;
  title: string;
  description: string;
  category: string | null;
  playwright_project: string;
  test_file: string;
  sort_order: number;
  enabled: boolean;
  headed: boolean;
  remote_eligible: boolean;
  stealth_required: boolean;
  dual_instance: boolean;
  telemetry: boolean;
  created_at: string;
  updated_at: string;
  persona_name?: string;
  last_recorded_at: string | null;
  recording_path: string | null;
  env_vars: Record<string, string> | null;
}

// ============================================================================
// Recording Tool Schemas
// ============================================================================

export const ListRecordingsArgsSchema = z.object({
  type: z.enum(['demo', 'feedback', 'all']).optional().default('all')
    .describe('Filter by recording type: "demo" (scenario recordings), "feedback" (feedback session recordings), or "all"'),
  persona_id: z.string().optional()
    .describe('Filter recordings by persona UUID'),
});

export const GetRecordingArgsSchema = z.object({
  scenario_id: z.string().optional().describe('Demo scenario UUID'),
  session_id: z.string().optional().describe('Feedback session UUID'),
}).refine(data => data.scenario_id !== undefined || data.session_id !== undefined, {
  message: 'Either scenario_id or session_id must be provided',
});

export const PlayRecordingArgsSchema = z.object({
  scenario_id: z.string().optional().describe('Demo scenario UUID'),
  session_id: z.string().optional().describe('Feedback session UUID'),
}).refine(data => data.scenario_id !== undefined || data.session_id !== undefined, {
  message: 'Either scenario_id or session_id must be provided',
});

export type ListRecordingsArgs = z.infer<typeof ListRecordingsArgsSchema>;
export type GetRecordingArgs = z.infer<typeof GetRecordingArgsSchema>;
export type PlayRecordingArgs = z.infer<typeof PlayRecordingArgsSchema>;

// ============================================================================
// Feature Feedback Schemas
// ============================================================================

export const GetLatestFeatureFeedbackArgsSchema = z.object({
  feature_name: z.string().optional().describe('Filter by feature name'),
  feature_id: z.string().optional().describe('Filter by feature ID'),
  persona_id: z.string().optional().describe('Filter by persona'),
});

export const PlayFeatureFeedbackArgsSchema = z.object({
  feature_name: z.string().describe('Feature name to play feedback for'),
  persona_name: z.string().optional().describe('Specific persona (plays latest if omitted)'),
});

export type GetLatestFeatureFeedbackArgs = z.infer<typeof GetLatestFeatureFeedbackArgsSchema>;
export type PlayFeatureFeedbackArgs = z.infer<typeof PlayFeatureFeedbackArgsSchema>;

export interface DemoRecordingEntry {
  scenario_id: string;
  title: string;
  persona_id: string;
  persona_name: string;
  test_file: string;
  recording_path: string;
  recorded_at: string;
  stale: boolean; // true if recorded_at is >24h ago
}

export interface FeedbackRecordingEntry {
  session_id: string;
  persona_id: string;
  persona_name: string;
  recording_path: string;
  recorded_at: string;
  stale: boolean; // true if recorded_at is >24h ago
  feature_id?: string;
  feature_name?: string;
}

export interface ListRecordingsResult {
  demos: DemoRecordingEntry[];
  feedback: FeedbackRecordingEntry[];
  total: number;
}

export interface GetRecordingResult {
  exists: boolean;
  path: string | null;
  size_mb: number | null;
  recorded_at: string | null;
  details: {
    type: 'demo' | 'feedback';
    scenario_id?: string;
    session_id?: string;
    title?: string;
    persona_id: string;
    persona_name: string;
  } | null;
}

export interface LatestFeatureFeedbackEntry {
  feature_id: string;
  feature_name: string;
  persona_id: string;
  persona_name: string;
  session_id: string;
  recording_path: string | null;
  completed_at: string | null;
  satisfaction_level: string | null;
  exists_on_disk: boolean;
}

export interface LatestFeatureFeedbackResult {
  entries: LatestFeatureFeedbackEntry[];
  total: number;
}

// ============================================================================
// Demo Prerequisite Schemas
// ============================================================================

export const PREREQUISITE_SCOPE = ['global', 'persona', 'scenario'] as const;
export type PrerequisiteScope = (typeof PREREQUISITE_SCOPE)[number];

export const RegisterPrerequisiteArgsSchema = z.object({
  command: z.string().min(1).max(2000).describe('Shell command to execute (e.g., "pnpm dev", "npm run build:extension")'),
  description: z.string().min(1).max(500).describe('Human-readable description of what this prerequisite does'),
  timeout_ms: z.coerce.number().int().min(1000).max(300000).optional().default(30000)
    .describe('Max execution time in milliseconds (1s-300s, default: 30s)'),
  health_check: z.string().max(2000).optional()
    .describe('Optional command to verify the prerequisite is satisfied. If exit 0, setup command is skipped.'),
  health_check_timeout_ms: z.coerce.number().int().min(1000).max(30000).optional().default(5000)
    .describe('Timeout for health check command (1s-30s, default: 5s)'),
  scope: z.enum(PREREQUISITE_SCOPE).optional().default('global')
    .describe('Scope: "global" (all demos), "persona" (all demos for a persona), "scenario" (single scenario)'),
  persona_id: z.string().optional().describe('Required when scope is "persona"'),
  scenario_id: z.string().optional().describe('Required when scope is "scenario"'),
  sort_order: z.coerce.number().int().min(0).max(999).optional().default(0)
    .describe('Execution order within scope (lower runs first)'),
  run_as_background: z.coerce.boolean().optional().default(false)
    .describe('If true, command is spawned detached (for long-running processes like dev servers). Health check polls until ready.'),
});

export const UpdatePrerequisiteArgsSchema = z.object({
  id: z.string().describe('Prerequisite UUID'),
  command: z.string().min(1).max(2000).optional(),
  description: z.string().min(1).max(500).optional(),
  timeout_ms: z.coerce.number().int().min(1000).max(300000).optional(),
  health_check: z.string().max(2000).optional(),
  health_check_timeout_ms: z.coerce.number().int().min(1000).max(30000).optional(),
  sort_order: z.coerce.number().int().min(0).max(999).optional(),
  enabled: z.coerce.boolean().optional(),
  run_as_background: z.coerce.boolean().optional(),
});

export const DeletePrerequisiteArgsSchema = z.object({
  id: z.string().describe('Prerequisite UUID'),
});

export const ListPrerequisitesArgsSchema = z.object({
  scope: z.enum(PREREQUISITE_SCOPE).optional(),
  persona_id: z.string().optional(),
  scenario_id: z.string().optional(),
  enabled_only: z.coerce.boolean().optional().default(true),
});

export type RegisterPrerequisiteArgs = z.infer<typeof RegisterPrerequisiteArgsSchema>;
export type UpdatePrerequisiteArgs = z.infer<typeof UpdatePrerequisiteArgsSchema>;
export type DeletePrerequisiteArgs = z.infer<typeof DeletePrerequisiteArgsSchema>;
export type ListPrerequisitesArgs = z.infer<typeof ListPrerequisitesArgsSchema>;

export interface PrerequisiteRecord {
  id: string;
  command: string;
  description: string;
  timeout_ms: number;
  health_check: string | null;
  health_check_timeout_ms: number;
  scope: string;
  persona_id: string | null;
  scenario_id: string | null;
  sort_order: number;
  enabled: number;
  run_as_background: number;
  created_at: string;
  created_timestamp: string;
  updated_at: string;
}

export interface PrerequisiteResult {
  id: string;
  command: string;
  description: string;
  timeout_ms: number;
  health_check: string | null;
  health_check_timeout_ms: number;
  scope: string;
  persona_id: string | null;
  scenario_id: string | null;
  sort_order: number;
  enabled: boolean;
  run_as_background: boolean;
  created_at: string;
  updated_at: string;
  persona_name?: string;
  scenario_title?: string;
}

// ============================================================================
// Persona Profile Schemas
// ============================================================================

const profileNameRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export const CreatePersonaProfileArgsSchema = z.object({
  name: z.string().min(1).max(64).regex(profileNameRegex, 'Profile name must be lowercase alphanumeric with hyphens (e.g., "full-product", "vertical-slice")')
    .describe('Unique profile name'),
  description: z.string().max(500).optional()
    .describe('Description of what this profile covers'),
  guiding_prompt: z.string().max(2000).optional()
    .describe('Optional prompt to guide market research and persona generation for this profile (e.g., "Focus on ALLOW authorization features for mid-market SaaS")'),
});

export const ArchivePersonaProfileArgsSchema = z.object({
  name: z.string().min(1).max(64).regex(profileNameRegex, 'Profile name must be lowercase alphanumeric with hyphens')
    .describe('Profile name to save as'),
  description: z.string().max(500).optional()
    .describe('Description of what this profile covers'),
  guiding_prompt: z.string().max(2000).optional()
    .describe('Optional prompt to guide market research and persona generation'),
});

export const SwitchPersonaProfileArgsSchema = z.object({
  name: z.string().min(1).max(64).regex(profileNameRegex, 'Profile name must be lowercase alphanumeric with hyphens')
    .describe('Name of the profile to switch to'),
});

export const ListPersonaProfilesArgsSchema = z.object({});

export const GetPersonaProfileArgsSchema = z.object({
  name: z.string().min(1).max(64).regex(profileNameRegex, 'Profile name must be lowercase alphanumeric with hyphens')
    .describe('Name of the profile to inspect'),
});

export const DeletePersonaProfileArgsSchema = z.object({
  name: z.string().min(1).max(64).regex(profileNameRegex, 'Profile name must be lowercase alphanumeric with hyphens')
    .describe('Name of the profile to delete'),
});

export type CreatePersonaProfileArgs = z.infer<typeof CreatePersonaProfileArgsSchema>;
export type ArchivePersonaProfileArgs = z.infer<typeof ArchivePersonaProfileArgsSchema>;
export type SwitchPersonaProfileArgs = z.infer<typeof SwitchPersonaProfileArgsSchema>;
export type ListPersonaProfilesArgs = z.infer<typeof ListPersonaProfilesArgsSchema>;
export type GetPersonaProfileArgs = z.infer<typeof GetPersonaProfileArgsSchema>;
export type DeletePersonaProfileArgs = z.infer<typeof DeletePersonaProfileArgsSchema>;

// ============================================================================
// Demo Completeness Verification
// ============================================================================

export const VerifyDemoCompletenessArgsSchema = z.object({
  since: z.string().datetime({ offset: true })
    .describe('ISO 8601 timestamp. Only count demo results completed after this time (e.g. release start time).'),
  branch: z.string().optional()
    .describe('Only count results from this git branch (e.g. "staging"). Omit to count all branches.'),
  require_recording: z.coerce.boolean().optional().default(true)
    .describe('Require fresh recording (last_recorded_at >= since) for each scenario. Default: true.'),
});

export type VerifyDemoCompletenessArgs = z.infer<typeof VerifyDemoCompletenessArgsSchema>;

export interface DemoCompletenessScenarioStatus {
  scenario_id: string;
  title: string;
  persona_name: string;
  latest_result_status: 'passed' | 'failed' | 'none';
  latest_result_at: string | null;
  has_fresh_recording: boolean;
  recording_path: string | null;
  last_recorded_at: string | null;
}

export interface VerifyDemoCompletenessResult {
  complete: boolean;
  total_enabled_scenarios: number;
  scenarios_with_passing_result: number;
  scenarios_with_fresh_recording: number;
  scenarios_missing_pass: DemoCompletenessScenarioStatus[];
  scenarios_missing_recording: DemoCompletenessScenarioStatus[];
  all_scenarios: DemoCompletenessScenarioStatus[];
  since: string;
  branch: string | null;
  checked_at: string;
}
