/**
 * Types for the Agent Reports MCP Server
 *
 * Triage queue for agent reports. Agents submit reports here, which are then
 * triaged by the deputy-cto. Only deputy-cto can escalate items to the CTO queue.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const REPORT_CATEGORIES = [
  'architecture',
  'security',
  'performance',
  'breaking-change',
  'blocker',
  'decision',
  'other',
] as const;

export type ReportCategory = typeof REPORT_CATEGORIES[number];

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const SubmitReportArgsSchema = z.object({
  reporting_agent: z.string().describe('Name of the agent reporting (e.g., "code-reviewer", "test-writer")'),
  title: z.string().min(1).max(200).describe('Brief title of the report (max 200 chars)'),
  summary: z.string().min(1).max(2000).describe('Detailed summary (max 2000 chars)'),
  category: z.enum(REPORT_CATEGORIES).optional().default('other').describe('Report category'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional().default('normal').describe('Priority level'),
});
// Backward compatibility alias
export const ReportToCtoArgsSchema = SubmitReportArgsSchema;

export const ListReportsArgsSchema = z.object({
  unread_only: z.boolean().optional().default(false).describe('Only show unread reports'),
  untriaged_only: z.boolean().optional().default(false).describe('Only show reports not yet triaged by deputy-cto'),
  limit: z.number().optional().default(20).describe('Maximum reports to return'),
});

export const GetUntriagedCountArgsSchema = z.object({});

export const ReadReportArgsSchema = z.object({
  id: z.string().describe('Report UUID'),
});

export const AcknowledgeReportArgsSchema = z.object({
  id: z.string().describe('Report UUID'),
});

export const MarkTriagedArgsSchema = z.object({
  id: z.string().describe('Report UUID'),
  action: z.enum(['auto-acknowledged', 'escalated', 'needs-cto-review']).describe('Triage action taken'),
});

// New triage lifecycle schemas
export const StartTriageArgsSchema = z.object({
  id: z.string().describe('Report UUID'),
  session_id: z.string().optional().describe('Session ID of the triage agent (for tracking)'),
});

export const CompleteTriageArgsSchema = z.object({
  id: z.string().describe('Report UUID'),
  status: z.enum(['self_handled', 'escalated', 'dismissed']).describe('Final triage status'),
  outcome: z.string().max(500).describe('Brief description of what was done (max 500 chars)'),
});

export const GetTriageStatsArgsSchema = z.object({
  recent_window_hours: z.number().optional().default(24).describe('Hours to look back for recent stats (default: 24)'),
  extended_window_hours: z.number().optional().default(168).describe('Hours to look back for extended stats (default: 168 = 7 days)'),
});

export const GetReportsForTriageArgsSchema = z.object({
  limit: z.number().optional().default(10).describe('Maximum reports to return'),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type SubmitReportArgs = z.infer<typeof SubmitReportArgsSchema>;
// Backward compatibility alias
export type ReportToCtoArgs = SubmitReportArgs;
export type ListReportsArgs = z.infer<typeof ListReportsArgsSchema>;
export type GetUntriagedCountArgs = z.infer<typeof GetUntriagedCountArgsSchema>;
export type ReadReportArgs = z.infer<typeof ReadReportArgsSchema>;
export type AcknowledgeReportArgs = z.infer<typeof AcknowledgeReportArgsSchema>;
export type MarkTriagedArgs = z.infer<typeof MarkTriagedArgsSchema>;
export type StartTriageArgs = z.infer<typeof StartTriageArgsSchema>;
export type CompleteTriageArgs = z.infer<typeof CompleteTriageArgsSchema>;
export type GetTriageStatsArgs = z.infer<typeof GetTriageStatsArgsSchema>;
export type GetReportsForTriageArgs = z.infer<typeof GetReportsForTriageArgsSchema>;

export const TRIAGE_STATUS = [
  'pending',        // Not yet triaged
  'in_progress',    // Currently being investigated by deputy-cto
  'self_handled',   // Deputy-CTO spawned a task to handle it
  'escalated',      // Raised to CTO queue (can block commits)
  'dismissed',      // Not a real issue or already resolved
] as const;

export type TriageStatus = typeof TRIAGE_STATUS[number];

// Legacy triage actions (for backward compatibility with mark_triaged tool)
export const LEGACY_TRIAGE_ACTIONS = [
  'auto-acknowledged',  // Low priority routine reports auto-cleared
  'escalated',          // Added to CTO question queue
  'needs-cto-review',   // Left for CTO to review in /deputy-cto session
] as const;

export type LegacyTriageAction = typeof LEGACY_TRIAGE_ACTIONS[number];

// Alias for backward compatibility
export const TRIAGE_ACTIONS = LEGACY_TRIAGE_ACTIONS;
export type TriageAction = LegacyTriageAction;

export interface ReportRecord {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: ReportCategory;
  priority: 'low' | 'normal' | 'high' | 'critical';
  created_at: string;
  created_timestamp: number;
  read_at: string | null;
  acknowledged_at: string | null;
  // Triage lifecycle fields
  triage_status: TriageStatus;
  triage_started_at: string | null;
  triage_completed_at: string | null;
  triage_session_id: string | null;  // Session ID handling this report
  triage_outcome: string | null;     // Brief description of outcome
  // Legacy fields (for backward compatibility)
  triaged_at: string | null;
  triage_action: TriageAction | null;
}

export interface ReportListItem {
  id: string;
  reporting_agent: string;
  title: string;
  category: ReportCategory;
  priority: string;
  created_at: string;
  is_read: boolean;
  is_acknowledged: boolean;
  triage_status: TriageStatus;
  triage_outcome: string | null;
  // Legacy
  is_triaged: boolean;
  triage_action: TriageAction | null;
}

export interface ListReportsResult {
  reports: ReportListItem[];
  total: number;
  unread_count: number;
  untriaged_count: number;
}

export interface GetUntriagedCountResult {
  untriaged_count: number;
  by_priority: {
    critical: number;
    high: number;
    normal: number;
    low: number;
  };
}

export interface MarkTriagedResult {
  id: string;
  action: TriageAction;
  message: string;
}

export interface SubmitReportResult {
  id: string;
  message: string;
}
// Backward compatibility alias
export type ReportToCtoResult = SubmitReportResult;

export interface ReadReportResult {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: ReportCategory;
  priority: string;
  created_at: string;
  read_at: string;
}

export interface AcknowledgeReportResult {
  id: string;
  acknowledged: boolean;
  message: string;
}

// New triage lifecycle result types
export interface StartTriageResult {
  id: string;
  started: boolean;
  message: string;
}

export interface CompleteTriageResult {
  id: string;
  status: TriageStatus;
  outcome: string;
  message: string;
}

export interface TriageStats {
  pending: number;
  in_progress: number;
  self_handled_24h: number;
  self_handled_7d: number;
  escalated_24h: number;
  escalated_7d: number;
  dismissed_24h: number;
  dismissed_7d: number;
}

export interface GetTriageStatsResult {
  stats: TriageStats;
  message: string;
}

export interface ReportForTriage {
  id: string;
  reporting_agent: string;
  title: string;
  summary: string;
  category: ReportCategory;
  priority: string;
  created_at: string;
}

export interface GetReportsForTriageResult {
  reports: ReportForTriage[];
  total: number;
  message: string;
}

export interface ErrorResult {
  error: string;
}
