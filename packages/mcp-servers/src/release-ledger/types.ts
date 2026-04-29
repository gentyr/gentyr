/**
 * Types for the Release Ledger MCP Server
 *
 * Tracks production releases with PRs, sessions, reports, and tasks.
 * Provides an evidence chain from staging lock through sign-off.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const RELEASE_STATUS = ['in_progress', 'signed_off', 'cancelled'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUS)[number];

export const PR_REVIEW_STATUS = ['pending', 'in_review', 'passed', 'failed'] as const;
export type PrReviewStatus = (typeof PR_REVIEW_STATUS)[number];

export const SESSION_STATUS = ['running', 'completed', 'failed'] as const;
export type SessionStatus = (typeof SESSION_STATUS)[number];

export const TASK_STATUS = ['pending', 'in_progress', 'completed', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

// ============================================================================
// Tool Schemas
// ============================================================================

// Release Lifecycle
export const CreateReleaseArgsSchema = z.object({
  version: z.string().optional().describe('Semantic version string (e.g., "1.2.0")'),
  metadata: z.record(z.unknown()).optional().describe('Arbitrary JSON metadata for the release'),
});

export const GetReleaseArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID (e.g., "rel-abc123")'),
});

export const ListReleasesArgsSchema = z.object({
  status: z.enum(RELEASE_STATUS).optional().describe('Filter by release status'),
  limit: z.coerce.number().optional().default(20).describe('Maximum releases to return'),
});

export const UpdateReleaseArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  plan_id: z.string().optional().describe('Link to a plan-orchestrator plan'),
  persistent_task_id: z.string().optional().describe('Link to a persistent task'),
  staging_lock_at: z.string().optional().describe('ISO timestamp when staging was locked'),
  staging_unlock_at: z.string().optional().describe('ISO timestamp when staging was unlocked'),
  status: z.enum(RELEASE_STATUS).optional().describe('New release status'),
  report_path: z.string().optional().describe('Path to the generated release report'),
  artifact_dir: z.string().optional().describe('Path to the release artifact directory'),
  version: z.string().optional().describe('Update the version string'),
});

export const SignOffReleaseArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  signed_off_by: z.string().min(1).describe('Identity of the signer (e.g., "cto", agent ID)'),
});

export const CancelReleaseArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  reason: z.string().optional().describe('Reason for cancellation'),
});

// Release PRs
export const AddReleasePrArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  pr_number: z.coerce.number().describe('GitHub PR number'),
  pr_title: z.string().optional().describe('PR title'),
  pr_url: z.string().optional().describe('Full PR URL'),
  author: z.string().optional().describe('PR author'),
  merged_at: z.string().optional().describe('ISO timestamp when the PR was merged'),
});

export const UpdateReleasePrStatusArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  pr_number: z.coerce.number().describe('GitHub PR number'),
  review_status: z.enum(PR_REVIEW_STATUS).describe('New review status'),
  review_plan_task_id: z.string().optional().describe('Plan task ID for the review'),
});

// Release Sessions
export const AddReleaseSessionArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  queue_id: z.string().optional().describe('Session queue ID'),
  session_type: z.string().min(1).describe('Session type (e.g., "code-reviewer", "antipattern-hunter")'),
  phase: z.string().min(1).describe('Release phase (e.g., "per_pr_review", "triage", "meta_review")'),
  target_pr: z.coerce.number().optional().describe('Target PR number if session is PR-specific'),
  status: z.enum(SESSION_STATUS).optional().default('running').describe('Session status'),
});

// Release Reports
export const AddReleaseReportArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  report_id: z.string().optional().describe('External report ID (e.g., deputy-cto report ID)'),
  report_type: z.string().min(1).describe('Report type (e.g., "agent_report", "triage_action", "cto_decision")'),
  tier: z.string().optional().describe('Tier for the report (e.g., "preview", "staging")'),
  title: z.string().min(1).describe('Report title'),
  outcome: z.string().optional().describe('Report outcome or decision'),
});

// Release Tasks
export const AddReleaseTaskArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  task_id: z.string().optional().describe('External task ID (e.g., todo-db task ID)'),
  task_type: z.string().min(1).describe('Task type (e.g., "fix", "demo_creation", "test_fix")'),
  phase: z.string().min(1).describe('Release phase this task belongs to'),
  status: z.enum(TASK_STATUS).optional().default('pending').describe('Task status'),
});

// Evidence & Report
export const GetReleaseEvidenceArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
});

export const GenerateReleaseReportArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
});

export const OpenReleaseReportArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
});

export const GetReleaseReportSectionArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  section: z.coerce.number().min(1).max(9).describe('Section number (1-9) to extract from the report'),
});

// CTO Approval Gate
export const PresentReleaseSummaryArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
});

export const RecordCtoApprovalArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  approval_text: z.string().min(10).describe('Verbatim CTO approval quote from the interactive session (e.g., "Approved for production")'),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type CreateReleaseArgs = z.infer<typeof CreateReleaseArgsSchema>;
export type GetReleaseArgs = z.infer<typeof GetReleaseArgsSchema>;
export type ListReleasesArgs = z.infer<typeof ListReleasesArgsSchema>;
export type UpdateReleaseArgs = z.infer<typeof UpdateReleaseArgsSchema>;
export type SignOffReleaseArgs = z.infer<typeof SignOffReleaseArgsSchema>;
export type CancelReleaseArgs = z.infer<typeof CancelReleaseArgsSchema>;
export type AddReleasePrArgs = z.infer<typeof AddReleasePrArgsSchema>;
export type UpdateReleasePrStatusArgs = z.infer<typeof UpdateReleasePrStatusArgsSchema>;
export type AddReleaseSessionArgs = z.infer<typeof AddReleaseSessionArgsSchema>;
export type AddReleaseReportArgs = z.infer<typeof AddReleaseReportArgsSchema>;
export type AddReleaseTaskArgs = z.infer<typeof AddReleaseTaskArgsSchema>;
export type GetReleaseEvidenceArgs = z.infer<typeof GetReleaseEvidenceArgsSchema>;
export type GenerateReleaseReportArgs = z.infer<typeof GenerateReleaseReportArgsSchema>;
export type OpenReleaseReportArgs = z.infer<typeof OpenReleaseReportArgsSchema>;
export type GetReleaseReportSectionArgs = z.infer<typeof GetReleaseReportSectionArgsSchema>;
export type PresentReleaseSummaryArgs = z.infer<typeof PresentReleaseSummaryArgsSchema>;
export type RecordCtoApprovalArgs = z.infer<typeof RecordCtoApprovalArgsSchema>;

// ============================================================================
// Record Types (SQLite rows)
// ============================================================================

export interface ReleaseRecord {
  id: string;
  version: string | null;
  status: string;
  plan_id: string | null;
  persistent_task_id: string | null;
  staging_lock_at: string | null;
  staging_unlock_at: string | null;
  signed_off_at: string | null;
  signed_off_by: string | null;
  report_path: string | null;
  artifact_dir: string | null;
  created_at: string;
  metadata: string | null;
}

export interface ReleasePrRecord {
  id: string;
  release_id: string;
  pr_number: number;
  pr_title: string | null;
  pr_url: string | null;
  author: string | null;
  merged_at: string | null;
  review_status: string;
  review_plan_task_id: string | null;
  created_at: string;
}

export interface ReleaseSessionRecord {
  id: string;
  release_id: string;
  queue_id: string | null;
  session_type: string | null;
  phase: string | null;
  target_pr: number | null;
  status: string;
  summary: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface ReleaseReportRecord {
  id: string;
  release_id: string;
  report_id: string | null;
  report_type: string | null;
  tier: string | null;
  title: string | null;
  outcome: string | null;
  created_at: string;
}

export interface ReleaseTaskRecord {
  id: string;
  release_id: string;
  task_id: string | null;
  task_type: string | null;
  phase: string | null;
  status: string;
  created_at: string;
}

export interface ErrorResult {
  error: string;
}
