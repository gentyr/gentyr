/**
 * Type definitions for feedback-explorer MCP server
 *
 * Provides Zod schemas and TypeScript interfaces for exploring the feedback system.
 */

import { z } from 'zod';

// ============================================================================
// Tool Arguments Schemas (G003 Compliance)
// ============================================================================

export const ListFeedbackPersonasArgsSchema = z.object({
  enabled_only: z.coerce.boolean().optional().default(false)
    .describe('Only show enabled personas'),
  consumption_mode: z.enum(['gui', 'cli', 'api', 'sdk', 'adk']).optional()
    .describe('Filter by consumption mode'),
});

export const GetPersonaDetailsArgsSchema = z.object({
  persona_id: z.string().describe('Persona UUID'),
});

export const ListPersonaSessionsArgsSchema = z.object({
  persona_id: z.string().describe('Persona UUID'),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
  offset: z.coerce.number().min(0).optional().default(0),
});

export const GetSessionDetailsArgsSchema = z.object({
  session_id: z.string().describe('Feedback session UUID'),
  include_audit: z.coerce.boolean().optional().default(false)
    .describe('Include audit trail summary (tool calls made during session)'),
});

export const ListPersonaReportsArgsSchema = z.object({
  persona_name: z.string().describe('Persona name (matches reporting_agent pattern)'),
  limit: z.coerce.number().min(1).max(100).optional().default(20),
});

export const GetReportDetailsArgsSchema = z.object({
  report_id: z.string().describe('Report UUID from cto-reports.db'),
});

export const GetFeedbackOverviewArgsSchema = z.object({
  hours: z.coerce.number().min(1).max(720).optional().default(168)
    .describe('Time window for recent activity (default: 168 = 7 days)'),
});

// ============================================================================
// TypeScript Types from Schemas
// ============================================================================

export type ListFeedbackPersonasArgs = z.infer<typeof ListFeedbackPersonasArgsSchema>;
export type GetPersonaDetailsArgs = z.infer<typeof GetPersonaDetailsArgsSchema>;
export type ListPersonaSessionsArgs = z.infer<typeof ListPersonaSessionsArgsSchema>;
export type GetSessionDetailsArgs = z.infer<typeof GetSessionDetailsArgsSchema>;
export type ListPersonaReportsArgs = z.infer<typeof ListPersonaReportsArgsSchema>;
export type GetReportDetailsArgs = z.infer<typeof GetReportDetailsArgsSchema>;
export type GetFeedbackOverviewArgs = z.infer<typeof GetFeedbackOverviewArgsSchema>;

// ============================================================================
// Database Record Types
// ============================================================================

export type ConsumptionMode = 'gui' | 'cli' | 'api' | 'sdk' | 'adk';
export type SessionStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'timeout';
export type SatisfactionLevel = 'very_satisfied' | 'satisfied' | 'neutral' | 'dissatisfied' | 'very_dissatisfied';
export type FindingCategory = 'usability' | 'functionality' | 'performance' | 'accessibility' | 'visual' | 'content' | 'security' | 'other';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type OverallImpression = 'positive' | 'neutral' | 'negative' | 'unusable';
export type Confidence = 'high' | 'medium' | 'low';

export interface PersonaRecord {
  id: string;
  name: string;
  description: string;
  consumption_mode: ConsumptionMode;
  behavior_traits: string; // JSON
  endpoints: string; // JSON
  credentials_ref: string | null;
  enabled: number;
  created_at: string;
  created_timestamp: number;
  updated_at: string;
}

export interface FeatureRecord {
  id: string;
  name: string;
  description: string | null;
  file_patterns: string; // JSON
  url_patterns: string; // JSON
  category: string | null;
  created_at: string;
  created_timestamp: number;
}

export interface FeedbackSessionRecord {
  id: string;
  run_id: string;
  persona_id: string;
  agent_id: string | null;
  status: SessionStatus;
  started_at: string | null;
  completed_at: string | null;
  findings_count: number;
  report_ids: string; // JSON
  satisfaction_level: SatisfactionLevel | null;
}

export interface FindingRecord {
  id: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  steps_to_reproduce: string; // JSON
  expected_behavior: string | null;
  actual_behavior: string | null;
  screenshot_ref: string | null;
  url: string | null;
  report_id: string | null;
  created_at: string;
}

export interface SessionSummaryRecord {
  id: string;
  overall_impression: OverallImpression;
  areas_tested: string; // JSON
  areas_not_tested: string; // JSON
  confidence: Confidence;
  summary_notes: string | null;
  satisfaction_level: SatisfactionLevel | null;
  created_at: string;
}

export interface ReportRecord {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  created_at: string;
  created_timestamp: number;
  read_at: string | null;
  acknowledged_at: string | null;
  triage_status: string;
  triage_started_at: string | null;
  triage_completed_at: string | null;
  triage_session_id: string | null;
  triage_outcome: string | null;
  triage_attempted_at: string | null;
  triaged_at: string | null;
  triage_action: string | null;
}

// ============================================================================
// Result Types
// ============================================================================

export interface ErrorResult {
  error: string;
}

// list_feedback_personas
export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
  consumption_mode: ConsumptionMode;
  enabled: boolean;
  session_count: number;
  findings_count: number;
  latest_satisfaction: SatisfactionLevel | null;
  created_at: string;
}

export interface ListFeedbackPersonasResult {
  personas: PersonaSummary[];
  total: number;
}

// get_persona_details
export interface FeatureMapping {
  feature_id: string;
  feature_name: string;
  priority: string;
  test_scenarios: string[];
}

export interface SessionSummary {
  session_id: string;
  status: SessionStatus;
  started_at: string | null;
  completed_at: string | null;
  findings_count: number;
  satisfaction_level: SatisfactionLevel | null;
}

export interface SatisfactionHistory {
  session_id: string;
  satisfaction_level: SatisfactionLevel;
  completed_at: string;
}

export interface PersonaDetails {
  id: string;
  name: string;
  description: string;
  consumption_mode: ConsumptionMode;
  behavior_traits: string[];
  endpoints: string[];
  credentials_ref: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  features: FeatureMapping[];
  recent_sessions: SessionSummary[];
  satisfaction_history: SatisfactionHistory[];
}

// list_persona_sessions
export interface SessionListItem {
  id: string;
  run_id: string;
  status: SessionStatus;
  started_at: string | null;
  completed_at: string | null;
  findings_count: number;
  satisfaction_level: SatisfactionLevel | null;
}

export interface ListPersonaSessionsResult {
  sessions: SessionListItem[];
  total: number;
}

// get_session_details
export interface Finding {
  id: string;
  title: string;
  category: FindingCategory;
  severity: FindingSeverity;
  description: string;
  steps_to_reproduce?: string[];
  expected_behavior?: string;
  actual_behavior?: string;
  screenshot_ref?: string;
  url?: string;
  report_id?: string;
  created_at: string;
}

export interface Summary {
  overall_impression: OverallImpression;
  areas_tested: string[];
  areas_not_tested: string[];
  confidence: Confidence;
  summary_notes?: string;
  satisfaction_level?: SatisfactionLevel;
  created_at: string;
}

export interface AuditEvent {
  timestamp: string;
  tool: string;
  args: unknown;
  result: unknown;
  error: unknown;
  duration_ms: number | null;
  mcp_server: string | null;
}

export interface GetSessionDetailsResult {
  session_id: string;
  persona_id: string;
  persona_name: string | null;
  run_id: string;
  status: SessionStatus;
  started_at: string | null;
  completed_at: string | null;
  findings: Finding[];
  summary: Summary | null;
  audit_trail?: {
    total_actions: number;
    total_duration_ms: number;
    events: AuditEvent[];
  };
}

// list_persona_reports
export interface ReportListItem {
  id: string;
  title: string;
  category: string;
  priority: string;
  created_at: string;
  triage_status: string;
  triage_outcome: string | null;
}

export interface ListPersonaReportsResult {
  persona_name: string;
  reports: ReportListItem[];
  total: number;
}

// get_report_details
export interface ReportDetails {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: string;
  priority: string;
  created_at: string;
  read_at: string | null;
  acknowledged_at: string | null;
  triage_status: string;
  triage_started_at: string | null;
  triage_completed_at: string | null;
  triage_session_id: string | null;
  triage_outcome: string | null;
}

// get_feedback_overview
export interface SatisfactionDistribution {
  very_satisfied: number;
  satisfied: number;
  neutral: number;
  dissatisfied: number;
  very_dissatisfied: number;
}

export interface RecentSession {
  session_id: string;
  persona_name: string;
  status: SessionStatus;
  completed_at: string | null;
  findings_count: number;
  satisfaction_level: SatisfactionLevel | null;
}

export interface GetFeedbackOverviewResult {
  time_window_hours: number;
  persona_count: number;
  total_sessions: number;
  recent_sessions: number;
  total_findings: number;
  satisfaction_distribution: SatisfactionDistribution;
  recent_session_list: RecentSession[];
}
