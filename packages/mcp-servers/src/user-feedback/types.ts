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
  consumption_mode: z.enum(CONSUMPTION_MODES).describe('How this persona consumes the product'),
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
  consumption_mode: z.enum(CONSUMPTION_MODES).optional(),
  behavior_traits: z.array(z.string().max(200)).max(10).optional(),
  endpoints: z.array(z.string().max(500)).max(20).optional(),
  credentials_ref: z.string().max(200).optional(),
  enabled: z.coerce.boolean().optional(),
  cto_protected: z.coerce.boolean().optional(),
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
  consumption_mode: ConsumptionMode;
  behavior_traits: string; // JSON array
  endpoints: string; // JSON array
  credentials_ref: string | null;
  enabled: number; // SQLite boolean
  cto_protected: number; // SQLite boolean
  created_at: string;
  created_timestamp: number;
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
  created_timestamp: number;
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
  consumption_mode: ConsumptionMode;
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
  persona_id: z.string().describe('Persona UUID this scenario belongs to — persona must have consumption_mode "gui"'),
  title: z.string().min(1).max(200).describe('Human-readable scenario title shown in /demo-interactive and /demo-autonomous menus'),
  description: z.string().min(1).max(2000).describe('What the scenario demonstrates — given to code-writer for implementation and to persona agents for context'),
  category: z.string().max(50).optional().describe('Optional grouping (e.g., "onboarding", "admin", "billing")'),
  playwright_project: z.string().min(1).max(100).describe('Playwright project name for auth state — must match a project in the target app\'s playwright.config.ts'),
  test_file: z.string().min(1).max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'test_file must be a relative path without ".." traversal')
    .describe('Relative path to the .demo.ts file (e.g., e2e/demo/vendor-onboarding.demo.ts)'),
  sort_order: z.coerce.number().int().min(0).max(999).optional().default(0).describe('Display order within persona'),
});

export const UpdateScenarioArgsSchema = z.object({
  id: z.string().describe('Scenario UUID'),
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(2000).optional(),
  category: z.string().max(50).optional(),
  playwright_project: z.string().min(1).max(100).optional(),
  test_file: z.string().min(1).max(500)
    .refine(v => !v.startsWith('/') && !v.includes('..'), 'test_file must be a relative path without ".." traversal')
    .optional(),
  sort_order: z.coerce.number().int().min(0).max(999).optional(),
  enabled: z.coerce.boolean().optional(),
});

export const DeleteScenarioArgsSchema = z.object({
  id: z.string().describe('Scenario UUID'),
});

export const ListScenariosArgsSchema = z.object({
  persona_id: z.string().optional().describe('Filter by persona UUID'),
  enabled_only: z.coerce.boolean().optional().default(true),
  category: z.string().optional(),
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
  created_at: string;
  created_timestamp: number;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
  persona_name?: string;
}
