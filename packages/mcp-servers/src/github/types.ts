/**
 * GitHub MCP Server Types
 *
 * Type definitions for GitHub API interactions.
 */

import { z } from 'zod';

// ============================================================================
// Repository Tools
// ============================================================================

export const GetRepoArgsSchema = z.object({
  owner: z.string().describe('Repository owner (username or organization)'),
  repo: z.string().describe('Repository name'),
});

export const ListBranchesArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  protected: z.coerce.boolean().optional().describe('Filter by protected status'),
});

export const CreateBranchArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().describe('Branch name to create'),
  from_branch: z.string().optional().default('main').describe('Source branch (default: main)'),
});

export const DeleteBranchArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().describe('Branch name to delete'),
});

export const GetFileContentsArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  path: z.string().describe('File or directory path'),
  ref: z.string().optional().describe('Branch, tag, or commit SHA (default: default branch)'),
});

export const CreateOrUpdateFileArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  path: z.string().describe('File path'),
  content: z.string().describe('File content (will be base64 encoded)'),
  message: z.string().describe('Commit message'),
  branch: z.string().describe('Branch name'),
  sha: z.string().optional().describe('Blob SHA of the file being replaced (required for updates)'),
});

// ============================================================================
// Pull Request Tools
// ============================================================================

export const ListPullRequestsArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('PR state filter'),
  limit: z.coerce.number().optional().default(30).describe('Maximum number of PRs to return'),
});

export const GetPullRequestArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  pull_number: z.coerce.number().describe('Pull request number'),
});

export const CreatePullRequestArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  title: z.string().describe('PR title'),
  body: z.string().optional().describe('PR description'),
  head: z.string().describe('Branch containing changes'),
  base: z.string().describe('Branch to merge into'),
  draft: z.coerce.boolean().optional().default(false).describe('Create as draft PR'),
});

export const MergePullRequestArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  pull_number: z.coerce.number().describe('Pull request number'),
  merge_method: z.enum(['merge', 'squash', 'rebase']).optional().default('merge').describe('Merge method'),
  commit_title: z.string().optional().describe('Custom commit title'),
  commit_message: z.string().optional().describe('Custom commit message'),
});

export const GetPullRequestFilesArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  pull_number: z.coerce.number().describe('Pull request number'),
});

// ============================================================================
// Issue Tools
// ============================================================================

export const ListIssuesArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  state: z.enum(['open', 'closed', 'all']).optional().default('open').describe('Issue state filter'),
  labels: z.string().optional().describe('Comma-separated list of label names'),
  limit: z.coerce.number().optional().default(30).describe('Maximum number of issues to return'),
});

export const GetIssueArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  issue_number: z.coerce.number().describe('Issue number'),
});

export const CreateIssueArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  title: z.string().describe('Issue title'),
  body: z.string().optional().describe('Issue description'),
  labels: z.array(z.string()).optional().describe('Labels to apply'),
  assignees: z.array(z.string()).optional().describe('Usernames to assign'),
});

export const CreateIssueCommentArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  issue_number: z.coerce.number().describe('Issue number'),
  body: z.string().describe('Comment body'),
});

// ============================================================================
// Workflow Tools
// ============================================================================

export const ListWorkflowRunsArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  workflow_id: z.string().optional().describe('Workflow ID or filename (e.g., "ci.yml")'),
  branch: z.string().optional().describe('Filter by branch'),
  status: z.enum(['queued', 'in_progress', 'completed']).optional().describe('Filter by status'),
  limit: z.coerce.number().optional().default(20).describe('Maximum number of runs to return'),
});

export const GetWorkflowRunArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  run_id: z.coerce.number().describe('Workflow run ID'),
});

export const RerunWorkflowArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  run_id: z.coerce.number().describe('Workflow run ID'),
});

export const CancelWorkflowRunArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  run_id: z.coerce.number().describe('Workflow run ID'),
});

// ============================================================================
// Secrets Tools
// ============================================================================

export const CreateSecretArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  secret_name: z.string().describe('Secret name (uppercase with underscores)'),
  secret_value: z.string().describe('Secret value to encrypt and store'),
});

export const ListSecretsArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
});

export const DeleteSecretArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  secret_name: z.string().describe('Secret name to delete'),
});

// ============================================================================
// Environment Tools
// ============================================================================

export const ListEnvironmentsArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
});

export const CreateEnvironmentSecretArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  environment_name: z.string().describe('Environment name (e.g., "production", "staging")'),
  secret_name: z.string().describe('Secret name (uppercase with underscores)'),
  secret_value: z.string().describe('Secret value to encrypt and store'),
});

export const DeleteEnvironmentSecretArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  environment_name: z.string().describe('Environment name'),
  secret_name: z.string().describe('Secret name to delete'),
});

// ============================================================================
// Branch Protection Tools
// ============================================================================

export const GetBranchProtectionArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().describe('Branch name'),
});

export const UpdateBranchProtectionArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().describe('Branch name'),
  required_status_checks: z.object({
    strict: z.coerce.boolean().describe('Require branches to be up to date before merging'),
    contexts: z.array(z.string()).describe('Status checks that must pass'),
  }).optional().describe('Required status checks configuration'),
  enforce_admins: z.coerce.boolean().optional().describe('Enforce restrictions for administrators'),
  required_pull_request_reviews: z.object({
    required_approving_review_count: z.coerce.number().min(1).max(6).describe('Number of approvals required'),
    dismiss_stale_reviews: z.coerce.boolean().optional().describe('Dismiss stale reviews on new commits'),
    require_code_owner_reviews: z.coerce.boolean().optional().describe('Require review from code owners'),
  }).optional().describe('Pull request review requirements'),
  restrictions: z.object({
    users: z.array(z.string()).optional().describe('Users with push access'),
    teams: z.array(z.string()).optional().describe('Teams with push access'),
  }).optional().describe('Push access restrictions'),
  required_linear_history: z.coerce.boolean().optional().describe('Require linear history (no merge commits)'),
  allow_force_pushes: z.coerce.boolean().optional().describe('Allow force pushes'),
  allow_deletions: z.coerce.boolean().optional().describe('Allow branch deletion'),
});

export const DeleteBranchProtectionArgsSchema = z.object({
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().describe('Branch name'),
});

// ============================================================================
// Type Exports
// ============================================================================

export type GetRepoArgs = z.infer<typeof GetRepoArgsSchema>;
export type ListBranchesArgs = z.infer<typeof ListBranchesArgsSchema>;
export type CreateBranchArgs = z.infer<typeof CreateBranchArgsSchema>;
export type DeleteBranchArgs = z.infer<typeof DeleteBranchArgsSchema>;
export type GetFileContentsArgs = z.infer<typeof GetFileContentsArgsSchema>;
export type CreateOrUpdateFileArgs = z.infer<typeof CreateOrUpdateFileArgsSchema>;

export type ListPullRequestsArgs = z.infer<typeof ListPullRequestsArgsSchema>;
export type GetPullRequestArgs = z.infer<typeof GetPullRequestArgsSchema>;
export type CreatePullRequestArgs = z.infer<typeof CreatePullRequestArgsSchema>;
export type MergePullRequestArgs = z.infer<typeof MergePullRequestArgsSchema>;
export type GetPullRequestFilesArgs = z.infer<typeof GetPullRequestFilesArgsSchema>;

export type ListIssuesArgs = z.infer<typeof ListIssuesArgsSchema>;
export type GetIssueArgs = z.infer<typeof GetIssueArgsSchema>;
export type CreateIssueArgs = z.infer<typeof CreateIssueArgsSchema>;
export type CreateIssueCommentArgs = z.infer<typeof CreateIssueCommentArgsSchema>;

export type ListWorkflowRunsArgs = z.infer<typeof ListWorkflowRunsArgsSchema>;
export type GetWorkflowRunArgs = z.infer<typeof GetWorkflowRunArgsSchema>;
export type RerunWorkflowArgs = z.infer<typeof RerunWorkflowArgsSchema>;
export type CancelWorkflowRunArgs = z.infer<typeof CancelWorkflowRunArgsSchema>;

export type CreateSecretArgs = z.infer<typeof CreateSecretArgsSchema>;
export type ListSecretsArgs = z.infer<typeof ListSecretsArgsSchema>;
export type DeleteSecretArgs = z.infer<typeof DeleteSecretArgsSchema>;

export type ListEnvironmentsArgs = z.infer<typeof ListEnvironmentsArgsSchema>;
export type CreateEnvironmentSecretArgs = z.infer<typeof CreateEnvironmentSecretArgsSchema>;
export type DeleteEnvironmentSecretArgs = z.infer<typeof DeleteEnvironmentSecretArgsSchema>;

export type GetBranchProtectionArgs = z.infer<typeof GetBranchProtectionArgsSchema>;
export type UpdateBranchProtectionArgs = z.infer<typeof UpdateBranchProtectionArgsSchema>;
export type DeleteBranchProtectionArgs = z.infer<typeof DeleteBranchProtectionArgsSchema>;

// ============================================================================
// Response Types
// ============================================================================

export interface RepositorySummary {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  clone_url: string;
  created_at: string;
  updated_at: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
}

export interface BranchSummary {
  name: string;
  commit_sha: string;
  protected: boolean;
}

export interface FileContentSummary {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
  content?: string; // base64 encoded for files
  encoding?: string;
  download_url?: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  head_ref: string;
  base_ref: string;
  html_url: string;
}

export interface PullRequestFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  user: string;
  created_at: string;
  updated_at: string;
  labels: string[];
  assignees: string[];
  html_url: string;
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface SuccessResult {
  success: true;
  message: string;
}

export interface SecretSummary {
  name: string;
  created_at: string;
  updated_at: string;
}

export interface EnvironmentSummary {
  id: number;
  name: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface BranchProtectionSummary {
  required_status_checks: {
    strict: boolean;
    contexts: string[];
  } | null;
  enforce_admins: {
    enabled: boolean;
  };
  required_pull_request_reviews: {
    required_approving_review_count: number;
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
  } | null;
  restrictions: {
    users: Array<{ login: string }>;
    teams: Array<{ slug: string }>;
  } | null;
  required_linear_history: {
    enabled: boolean;
  };
  allow_force_pushes: {
    enabled: boolean;
  };
  allow_deletions: {
    enabled: boolean;
  };
}
