/**
 * Types for the Deputy-CTO MCP Server
 *
 * Private toolset for the deputy-cto agent to manage CTO questions,
 * commit approvals, and task spawning.
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const QUESTION_TYPES = [
  'decision',        // Needs CTO to make a decision
  'approval',        // Needs CTO approval
  'rejection',       // Commit was rejected, needs resolution
  'question',        // General question for CTO
  'escalation',      // Escalated from agent report
  'bypass-request',  // Agent requesting emergency bypass (CTO must approve)
  'protected-action-request',  // Protected MCP action awaiting CTO approval
] as const;

export type QuestionType = typeof QUESTION_TYPES[number];

export const QUESTION_STATUS = ['pending', 'answered'] as const;
export type QuestionStatus = typeof QUESTION_STATUS[number];

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const AddQuestionArgsSchema = z.object({
  type: z.enum(QUESTION_TYPES).describe('Type of question/request'),
  title: z.string().min(1).max(200).describe('Brief title (max 200 chars)'),
  description: z.string().min(1).max(4000).describe('Detailed description with context (max 4000 chars)'),
  context: z.string().max(2000).optional().describe('Additional context (file paths, commit info, etc.) - max 2000 chars'),
  suggested_options: z.array(z.string().max(200)).max(10).optional().describe('Suggested options for CTO to choose from (max 10 options, 200 chars each)'),
  recommendation: z.string().min(1).max(500).optional().describe('Agent recommendation for the CTO (required for escalations). Concise statement of what the agent recommends and why.'),
  investigation_task_id: z.string().optional().describe('Task ID of the investigation task spawned alongside this escalation'),
});

export const ListQuestionsArgsSchema = z.object({
  include_answered: z.coerce.boolean().optional().default(false).describe('Include answered questions'),
  limit: z.coerce.number().optional().default(20).describe('Maximum questions to return'),
});

export const ReadQuestionArgsSchema = z.object({
  id: z.string().describe('Question UUID'),
});

export const DECISION_MAKERS = ['cto', 'deputy-cto'] as const;
export type DecisionMaker = typeof DECISION_MAKERS[number];

export const AnswerQuestionArgsSchema = z.object({
  id: z.string().describe('Question UUID'),
  answer: z.string().min(1).describe('CTO answer/decision'),
  decided_by: z.enum(DECISION_MAKERS).optional().default('cto').describe('Who made this decision (cto or deputy-cto)'),
});

export const ClearQuestionArgsSchema = z.object({
  id: z.string().describe('Question UUID'),
});

export const ApproveCommitArgsSchema = z.object({
  rationale: z.string().min(1).max(500).describe('Brief rationale for approval'),
});

export const RejectCommitArgsSchema = z.object({
  title: z.string().min(1).max(200).describe('Title for the rejection entry'),
  description: z.string().min(1).max(2000).describe('Detailed reason for rejection'),
});

export const GetCommitDecisionArgsSchema = z.object({});

export const GetPendingCountArgsSchema = z.object({});

export const ToggleAutonomousModeArgsSchema = z.object({
  enabled: z.preprocess(
    (val) => val === 'true' || val === true,
    z.boolean()
  ).describe('Whether to enable or disable autonomous mode'),
});

export const GetAutonomousModeStatusArgsSchema = z.object({});

export const RecordCtoBriefingArgsSchema = z.object({});

export const SearchClearedItemsArgsSchema = z.object({
  query: z.string().min(1).max(200).describe('Substring to search for in cleared question titles/descriptions'),
  limit: z.coerce.number().optional().default(10).describe('Maximum results to return'),
});

export const UpdateQuestionArgsSchema = z.object({
  id: z.string().describe('Question UUID'),
  append_context: z.string().min(1).max(2000).describe('Investigation findings to append'),
});

export const RESOLUTION_TYPES = [
  'fixed', 'not_reproducible', 'duplicate', 'workaround_applied', 'no_longer_relevant'
] as const;

export type ResolutionType = typeof RESOLUTION_TYPES[number];

export const ResolveQuestionArgsSchema = z.object({
  id: z.string().describe('Question UUID'),
  resolution: z.enum(RESOLUTION_TYPES).describe('Resolution type'),
  resolution_detail: z.string().min(1).max(2000).describe('Evidence of resolution'),
});

export const CleanupOldRecordsArgsSchema = z.object({});

// Automation mode schemas
export const AUTOMATION_MODES = ['load_balanced', 'static'] as const;
export type AutomationMode = typeof AUTOMATION_MODES[number];

export const SetAutomationModeArgsSchema = z.object({
  automation_name: z.string().min(1).describe('Cooldown key of the automation (e.g., "lint_checker", "task_runner")'),
  mode: z.enum(AUTOMATION_MODES).describe('Mode: "load_balanced" (dynamic optimizer) or "static" (fixed interval)'),
  static_minutes: z.coerce.number().min(5).max(10080).optional().describe('Fixed interval in minutes (required when mode is "static", min 5, max 10080)'),
});

export const ListAutomationConfigArgsSchema = z.object({});

// ============================================================================
// Type Definitions
// ============================================================================

export type AddQuestionArgs = z.infer<typeof AddQuestionArgsSchema>;
export type ListQuestionsArgs = z.infer<typeof ListQuestionsArgsSchema>;
export type ReadQuestionArgs = z.infer<typeof ReadQuestionArgsSchema>;
export type AnswerQuestionArgs = z.infer<typeof AnswerQuestionArgsSchema>;
export type ClearQuestionArgs = z.infer<typeof ClearQuestionArgsSchema>;
export type ApproveCommitArgs = z.infer<typeof ApproveCommitArgsSchema>;
export type RejectCommitArgs = z.infer<typeof RejectCommitArgsSchema>;
export type GetCommitDecisionArgs = z.infer<typeof GetCommitDecisionArgsSchema>;
export type GetPendingCountArgs = z.infer<typeof GetPendingCountArgsSchema>;
export type ToggleAutonomousModeArgs = z.infer<typeof ToggleAutonomousModeArgsSchema>;
export type GetAutonomousModeStatusArgs = z.infer<typeof GetAutonomousModeStatusArgsSchema>;
export type RecordCtoBriefingArgs = z.infer<typeof RecordCtoBriefingArgsSchema>;
export type SearchClearedItemsArgs = z.infer<typeof SearchClearedItemsArgsSchema>;
export type UpdateQuestionArgs = z.infer<typeof UpdateQuestionArgsSchema>;
export type ResolveQuestionArgs = z.infer<typeof ResolveQuestionArgsSchema>;
export type CleanupOldRecordsArgs = z.infer<typeof CleanupOldRecordsArgsSchema>;
export type SetAutomationModeArgs = z.infer<typeof SetAutomationModeArgsSchema>;
export type ListAutomationConfigArgs = z.infer<typeof ListAutomationConfigArgsSchema>;

export interface QuestionRecord {
  id: string;
  type: QuestionType;
  status: QuestionStatus;
  title: string;
  description: string;
  context: string | null;
  suggested_options: string | null; // JSON array
  recommendation: string | null;
  answer: string | null;
  created_at: string;
  created_timestamp: string;
  answered_at: string | null;
  decided_by: DecisionMaker | null;
  investigation_task_id: string | null;
}

export interface QuestionListItem {
  id: string;
  type: QuestionType;
  status: QuestionStatus;
  title: string;
  created_at: string;
  is_rejection: boolean;
}

export interface ListQuestionsResult {
  questions: QuestionListItem[];
  total: number;
  pending_count: number;
  rejection_count: number;
  commits_blocked: boolean;
}

export interface AddQuestionResult {
  id: string;
  message: string;
}

export interface ReadQuestionResult {
  id: string;
  type: QuestionType;
  status: QuestionStatus;
  title: string;
  description: string;
  context: string | null;
  suggested_options: string[] | null;
  recommendation: string | null;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
  investigation_task_id: string | null;
}

export interface AnswerQuestionResult {
  id: string;
  answered: boolean;
  message: string;
}

export interface ClearQuestionResult {
  id: string;
  cleared: boolean;
  message: string;
  remaining_count: number;
}

export interface CommitDecisionRecord {
  id: string;
  decision: 'approved' | 'rejected';
  rationale: string;
  created_at: string;
}

export interface ApproveCommitResult {
  approved: boolean;
  decision_id: string;
  message: string;
}

export interface RejectCommitResult {
  rejected: boolean;
  decision_id: string;
  question_id: string;
  message: string;
}

export interface GetCommitDecisionResult {
  has_decision: boolean;
  decision: 'approved' | 'rejected' | null;
  rationale: string | null;
  pending_rejections: number;
  commits_blocked: boolean;
  message: string;
}

export interface GetPendingCountResult {
  pending_count: number;
  rejection_count: number;
  pending_triage_count: number;
  commits_blocked: boolean;
}

export interface ErrorResult {
  error: string;
}

export interface AutonomousModeConfig {
  enabled: boolean;
  claudeMdRefactorEnabled: boolean;
  lastModified: string | null;
  modifiedBy: string | null;
  lastCtoBriefing: string | null;
}

export interface ToggleAutonomousModeResult {
  enabled: boolean;
  message: string;
  nextRunIn: number | null; // minutes until next run, null if disabled
}

export interface GetAutonomousModeStatusResult {
  enabled: boolean;
  claudeMdRefactorEnabled: boolean;
  lastModified: string | null;
  nextRunIn: number | null; // minutes until next run, null if disabled
  lastCtoBriefing: string | null;
  ctoGateOpen: boolean;
  hoursSinceLastBriefing: number | null;
  message: string;
}

export interface RecordCtoBriefingResult {
  recorded: boolean;
  timestamp: string;
  message: string;
}

export interface ClearedQuestionItem {
  id: string;
  type: string;
  title: string;
  answer: string | null;
  answered_at: string | null;
  decided_by: DecisionMaker | null;
}

export interface SearchClearedItemsResult {
  items: ClearedQuestionItem[];
  count: number;
  message: string;
}

export interface UpdateQuestionResult {
  id: string;
  updated: boolean;
  message: string;
}

export interface ResolveQuestionResult {
  id: string;
  resolved: boolean;
  resolution: string;
  remaining_pending_count: number;
  message: string;
}

export interface CleanupOldRecordsResult {
  commit_decisions_deleted: number;
  cleared_questions_deleted: number;
  spawned_tasks_deleted: number;
  bypass_requests_expired: number;
  message: string;
}

export interface AutomationModeEntry {
  mode: AutomationMode;
  static_minutes?: number;
  set_at: string;
}

export interface SetAutomationModeResult {
  automation_name: string;
  mode: AutomationMode;
  effective_minutes: number;
  message: string;
}

export interface AutomationConfigItem {
  name: string;
  mode: AutomationMode;
  default_minutes: number;
  effective_minutes: number;
  static_minutes: number | null;
}

export interface ListAutomationConfigResult {
  automations: AutomationConfigItem[];
  factor: number;
  last_updated: string | null;
  message: string;
}

export const GetMergeChainStatusArgsSchema = z.object({});
export type GetMergeChainStatusArgs = z.infer<typeof GetMergeChainStatusArgsSchema>;

// ============================================================================
// Trigger Preview Promotion
// ============================================================================

export const TriggerPreviewPromotionArgsSchema = z.object({
  promotion_id: z.string().optional().describe('Custom promotion ID. Auto-generated if omitted.'),
});
export type TriggerPreviewPromotionArgs = z.infer<typeof TriggerPreviewPromotionArgsSchema>;
export interface TriggerPreviewPromotionResult {
  queueId: string;
  promotionId: string;
  commitCount: number;
  commits: string[];
  message: string;
}
