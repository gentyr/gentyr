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
  cleanup: z.boolean().default(true).describe(
    'Perform full cleanup: unlock staging, cancel linked plan, cancel persistent tasks, ' +
    'cancel pending todo-db tasks, and kill running sessions. Set false to only cancel the release record.'
  ),
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

// Staging Lock
export const LockStagingArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID to associate with the staging lock'),
});

export const UnlockStagingArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID that locked staging (must match)'),
});

// CTO Approval Gate
export const PresentReleaseSummaryArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
});

export const RecordCtoApprovalArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  approval_text: z.string().optional().describe(
    'Verbatim CTO approval quote from the interactive session (e.g., "Approved for production"). ' +
    'Required for "cto" and "deputy" approval tiers (must be at least 10 characters). ' +
    'Optional for "automated" tier — defaults to "Automated sign-off: all quality gates passed".'
  ),
});

// ============================================================================
// Phase 4.5 / 4.6 / 8.5 / 8.7 evidence tools
// ============================================================================

export const RecordMigrationStatusArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  environment: z.string().min(1).describe('Environment name (e.g., "production", "staging")'),
  applied: z.array(z.string()).default([]).describe('Migration filenames newly applied this phase'),
  pending: z.array(z.string()).default([]).describe('Migration filenames that remain pending (failure mode)'),
  skipped: z.array(z.string()).default([]).describe('Migration filenames skipped (already present in supabase_migrations.schema_migrations)'),
  failure_reason: z.string().optional().describe('Failure reason if Phase 4.5 halted mid-flight'),
});

export const VerifySchemaDriftArgsSchema = z.object({
  release_id: z.string().optional().describe('Release ID to record results against (omit for ad-hoc / hourly checks)'),
  environment: z.string().min(1).describe('Environment name (e.g., "production"). Must exist in services.json.environments and have supabase.projectRef set.'),
  expected_migrations_dir: z.string().min(1).default('supabase/migrations').describe('Path to the migrations directory relative to project root'),
});

export const RecordDeployArtifactArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  platform: z.enum(['render', 'vercel', 'fly']).describe('Deploy platform'),
  service_id: z.string().min(1).describe('Render service ID (srv-...), Vercel project ID, or Fly app name'),
  deploy_id: z.string().min(1).describe('Platform-specific deploy ID (Render dep-..., Vercel dpl-..., Fly machine ID)'),
  url: z.string().url().optional().describe('Live URL the deploy produced (omit for non-URL targets)'),
  triggered_at: z.string().optional().describe('ISO timestamp of trigger (defaults to now)'),
  status: z.enum(['triggered', 'building', 'live', 'failed', 'rolled_back']).default('triggered').describe('Deploy state at recording time'),
});

export const WaitForHealthProbeArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  environment: z.string().min(1).describe('Environment name. Resolves baseUrl and healthChecks from services.json.'),
  duration_seconds: z.number().int().min(30).max(1800).default(300).describe('Total wall-clock to probe (default 5 min, max 30 min)'),
  min_consecutive_passes: z.number().int().min(1).max(60).default(6).describe('How many consecutive 10-second probes must all pass before signing off (default 6 = 60s solid window)'),
  interval_seconds: z.number().int().min(5).max(60).default(10).describe('Seconds between probes'),
});

export const RecordCanaryOutcomeArgsSchema = z.object({
  release_id: z.string().min(1).describe('Release ID'),
  status: z.enum(['skipped', 'running', 'promoted', 'aborted']).describe(
    'Canary state. "skipped" = canary disabled in services.json; "running" = canary live, watch in progress; ' +
    '"promoted" = canary verified clean and promoted to full traffic; "aborted" = canary degraded and rolled back.'
  ),
  evidence: z.record(z.unknown()).optional().describe(
    'Optional structured evidence: error rate samples, latency p95, deploy IDs, rollback reason. ' +
    'Stored verbatim as JSON in releases.canary_status.'
  ),
});

export type RecordMigrationStatusArgs = z.infer<typeof RecordMigrationStatusArgsSchema>;
export type VerifySchemaDriftArgs = z.infer<typeof VerifySchemaDriftArgsSchema>;
export type RecordDeployArtifactArgs = z.infer<typeof RecordDeployArtifactArgsSchema>;
export type WaitForHealthProbeArgs = z.infer<typeof WaitForHealthProbeArgsSchema>;
export type RecordCanaryOutcomeArgs = z.infer<typeof RecordCanaryOutcomeArgsSchema>;

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
export type LockStagingArgs = z.infer<typeof LockStagingArgsSchema>;
export type UnlockStagingArgs = z.infer<typeof UnlockStagingArgsSchema>;
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
