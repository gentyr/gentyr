#!/usr/bin/env node
/**
 * GitHub MCP Server
 *
 * Provides tools for managing GitHub repositories, pull requests, issues, and workflows.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - GITHUB_TOKEN: GitHub personal access token or fine-grained token
 *
 * @version 1.0.0
 */

import nacl from 'tweetnacl';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  GetRepoArgsSchema,
  ListBranchesArgsSchema,
  CreateBranchArgsSchema,
  DeleteBranchArgsSchema,
  GetFileContentsArgsSchema,
  CreateOrUpdateFileArgsSchema,
  ListPullRequestsArgsSchema,
  GetPullRequestArgsSchema,
  CreatePullRequestArgsSchema,
  MergePullRequestArgsSchema,
  GetPullRequestFilesArgsSchema,
  ListIssuesArgsSchema,
  GetIssueArgsSchema,
  CreateIssueArgsSchema,
  CreateIssueCommentArgsSchema,
  ListWorkflowRunsArgsSchema,
  GetWorkflowRunArgsSchema,
  RerunWorkflowArgsSchema,
  CancelWorkflowRunArgsSchema,
  CreateSecretArgsSchema,
  ListSecretsArgsSchema,
  DeleteSecretArgsSchema,
  ListEnvironmentsArgsSchema,
  CreateEnvironmentSecretArgsSchema,
  DeleteEnvironmentSecretArgsSchema,
  GetBranchProtectionArgsSchema,
  UpdateBranchProtectionArgsSchema,
  DeleteBranchProtectionArgsSchema,
  type GetRepoArgs,
  type ListBranchesArgs,
  type CreateBranchArgs,
  type DeleteBranchArgs,
  type GetFileContentsArgs,
  type CreateOrUpdateFileArgs,
  type ListPullRequestsArgs,
  type GetPullRequestArgs,
  type CreatePullRequestArgs,
  type MergePullRequestArgs,
  type GetPullRequestFilesArgs,
  type ListIssuesArgs,
  type GetIssueArgs,
  type CreateIssueArgs,
  type CreateIssueCommentArgs,
  type ListWorkflowRunsArgs,
  type GetWorkflowRunArgs,
  type RerunWorkflowArgs,
  type CancelWorkflowRunArgs,
  type CreateSecretArgs,
  type ListSecretsArgs,
  type DeleteSecretArgs,
  type ListEnvironmentsArgs,
  type CreateEnvironmentSecretArgs,
  type DeleteEnvironmentSecretArgs,
  type GetBranchProtectionArgs,
  type UpdateBranchProtectionArgs,
  type DeleteBranchProtectionArgs,
  type RepositorySummary,
  type BranchSummary,
  type FileContentSummary,
  type PullRequestSummary,
  type PullRequestFileSummary,
  type IssueSummary,
  type WorkflowRunSummary,
  type SecretSummary,
  type EnvironmentSummary,
  type BranchProtectionSummary,
  type SuccessResult,
} from './types.js';

const BASE_URL = 'https://api.github.com';

/**
 * Make a request to the GitHub API
 */
async function githubFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  // G001: Fail-closed on missing API key (checked at invocation time for tool discoverability)
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is required. Ensure 1Password credentials are configured.');
  }
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // Handle 204 No Content responses
  if (response.status === 204) {
    return { success: true };
  }

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const error = data.message as string | undefined;
    throw new Error(error || `HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ============================================================================
// Repository Handlers
// ============================================================================

async function getRepo(args: GetRepoArgs): Promise<RepositorySummary> {
  const data = await githubFetch(`/repos/${args.owner}/${args.repo}`) as {
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
  };

  return {
    id: data.id,
    name: data.name,
    full_name: data.full_name,
    private: data.private,
    description: data.description,
    default_branch: data.default_branch,
    html_url: data.html_url,
    clone_url: data.clone_url,
    created_at: data.created_at,
    updated_at: data.updated_at,
    language: data.language,
    stargazers_count: data.stargazers_count,
    forks_count: data.forks_count,
  };
}

async function listBranches(args: ListBranchesArgs): Promise<BranchSummary[]> {
  const endpoint = `/repos/${args.owner}/${args.repo}/branches`;
  const params = args.protected !== undefined ? `?protected=${args.protected}` : '';

  const data = await githubFetch(`${endpoint}${params}`) as Array<{
    name: string;
    commit: { sha: string };
    protected: boolean;
  }>;

  return data.map(branch => ({
    name: branch.name,
    commit_sha: branch.commit.sha,
    protected: branch.protected,
  }));
}

async function createBranch(args: CreateBranchArgs): Promise<SuccessResult> {
  // First, get the SHA of the source branch
  const refData = await githubFetch(
    `/repos/${args.owner}/${args.repo}/git/ref/heads/${args.from_branch}`
  ) as { object: { sha: string } };

  const { sha } = refData.object;

  // Create the new branch
  await githubFetch(`/repos/${args.owner}/${args.repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${args.branch}`,
      sha,
    }),
  });

  return {
    success: true,
    message: `Created branch ${args.branch} from ${args.from_branch}`,
  };
}

async function deleteBranch(args: DeleteBranchArgs): Promise<SuccessResult> {
  await githubFetch(`/repos/${args.owner}/${args.repo}/git/refs/heads/${args.branch}`, {
    method: 'DELETE',
  });

  return {
    success: true,
    message: `Deleted branch ${args.branch}`,
  };
}

async function getFileContents(args: GetFileContentsArgs): Promise<FileContentSummary | FileContentSummary[]> {
  const params = args.ref ? `?ref=${args.ref}` : '';
  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/contents/${args.path}${params}`
  );

  // Handle directory contents (array response)
  if (Array.isArray(data)) {
    return (data as Array<{
      name: string;
      path: string;
      sha: string;
      size: number;
      type: string;
      download_url?: string;
    }>).map(item => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
      size: item.size,
      type: item.type as 'file' | 'dir',
      download_url: item.download_url,
    }));
  }

  // Handle single file response
  const file = data as {
    name: string;
    path: string;
    sha: string;
    size: number;
    type: string;
    content?: string;
    encoding?: string;
    download_url?: string;
  };

  return {
    name: file.name,
    path: file.path,
    sha: file.sha,
    size: file.size,
    type: file.type as 'file' | 'dir',
    content: file.content,
    encoding: file.encoding,
    download_url: file.download_url,
  };
}

async function createOrUpdateFile(args: CreateOrUpdateFileArgs): Promise<SuccessResult> {
  // Base64 encode the content
  const contentBase64 = Buffer.from(args.content).toString('base64');

  const body: Record<string, unknown> = {
    message: args.message,
    content: contentBase64,
    branch: args.branch,
  };

  if (args.sha) {
    body.sha = args.sha;
  }

  await githubFetch(`/repos/${args.owner}/${args.repo}/contents/${args.path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return {
    success: true,
    message: `${args.sha ? 'Updated' : 'Created'} file ${args.path}`,
  };
}

// ============================================================================
// Pull Request Handlers
// ============================================================================

async function listPullRequests(args: ListPullRequestsArgs): Promise<PullRequestSummary[]> {
  const params = new URLSearchParams();
  params.set('state', args.state || 'open');
  params.set('per_page', (args.limit || 30).toString());

  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/pulls?${params}`
  ) as Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    updated_at: string;
    draft: boolean;
    head: { ref: string };
    base: { ref: string };
    html_url: string;
  }>;

  return data.map(pr => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    user: pr.user.login,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    draft: pr.draft,
    head_ref: pr.head.ref,
    base_ref: pr.base.ref,
    html_url: pr.html_url,
  }));
}

async function getPullRequest(args: GetPullRequestArgs): Promise<unknown> {
  return await githubFetch(`/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}`);
}

async function createPullRequest(args: CreatePullRequestArgs): Promise<PullRequestSummary> {
  const body: Record<string, unknown> = {
    title: args.title,
    head: args.head,
    base: args.base,
    draft: args.draft || false,
  };

  if (args.body) {
    body.body = args.body;
  }

  const data = await githubFetch(`/repos/${args.owner}/${args.repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify(body),
  }) as {
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    updated_at: string;
    draft: boolean;
    head: { ref: string };
    base: { ref: string };
    html_url: string;
  };

  return {
    number: data.number,
    title: data.title,
    state: data.state,
    user: data.user.login,
    created_at: data.created_at,
    updated_at: data.updated_at,
    draft: data.draft,
    head_ref: data.head.ref,
    base_ref: data.base.ref,
    html_url: data.html_url,
  };
}

async function mergePullRequest(args: MergePullRequestArgs): Promise<SuccessResult> {
  const body: Record<string, unknown> = {
    merge_method: args.merge_method || 'merge',
  };

  if (args.commit_title) {
    body.commit_title = args.commit_title;
  }

  if (args.commit_message) {
    body.commit_message = args.commit_message;
  }

  await githubFetch(`/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/merge`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return {
    success: true,
    message: `Merged PR #${args.pull_number}`,
  };
}

async function getPullRequestFiles(args: GetPullRequestFilesArgs): Promise<PullRequestFileSummary[]> {
  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/pulls/${args.pull_number}/files`
  ) as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>;

  return data.map(file => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    patch: file.patch,
  }));
}

// ============================================================================
// Issue Handlers
// ============================================================================

async function listIssues(args: ListIssuesArgs): Promise<IssueSummary[]> {
  const params = new URLSearchParams();
  params.set('state', args.state || 'open');
  params.set('per_page', (args.limit || 30).toString());

  if (args.labels) {
    params.set('labels', args.labels);
  }

  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/issues?${params}`
  ) as Array<{
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    updated_at: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
    html_url: string;
    pull_request?: unknown; // Issues API returns PRs too, filter them out
  }>;

  // Filter out pull requests (they have a pull_request field)
  const issues = data.filter(item => !item.pull_request);

  return issues.map(issue => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    user: issue.user.login,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    labels: issue.labels.map(l => l.name),
    assignees: issue.assignees.map(a => a.login),
    html_url: issue.html_url,
  }));
}

async function getIssue(args: GetIssueArgs): Promise<unknown> {
  return await githubFetch(`/repos/${args.owner}/${args.repo}/issues/${args.issue_number}`);
}

async function createIssue(args: CreateIssueArgs): Promise<IssueSummary> {
  const body: Record<string, unknown> = {
    title: args.title,
  };

  if (args.body) {
    body.body = args.body;
  }

  if (args.labels && args.labels.length > 0) {
    body.labels = args.labels;
  }

  if (args.assignees && args.assignees.length > 0) {
    body.assignees = args.assignees;
  }

  const data = await githubFetch(`/repos/${args.owner}/${args.repo}/issues`, {
    method: 'POST',
    body: JSON.stringify(body),
  }) as {
    number: number;
    title: string;
    state: string;
    user: { login: string };
    created_at: string;
    updated_at: string;
    labels: Array<{ name: string }>;
    assignees: Array<{ login: string }>;
    html_url: string;
  };

  return {
    number: data.number,
    title: data.title,
    state: data.state,
    user: data.user.login,
    created_at: data.created_at,
    updated_at: data.updated_at,
    labels: data.labels.map(l => l.name),
    assignees: data.assignees.map(a => a.login),
    html_url: data.html_url,
  };
}

async function createIssueComment(args: CreateIssueCommentArgs): Promise<SuccessResult> {
  await githubFetch(`/repos/${args.owner}/${args.repo}/issues/${args.issue_number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: args.body }),
  });

  return {
    success: true,
    message: `Added comment to issue #${args.issue_number}`,
  };
}

// ============================================================================
// Workflow Handlers
// ============================================================================

async function listWorkflowRuns(args: ListWorkflowRunsArgs): Promise<WorkflowRunSummary[]> {
  const params = new URLSearchParams();
  params.set('per_page', (args.limit || 20).toString());

  if (args.branch) {
    params.set('branch', args.branch);
  }

  if (args.status) {
    params.set('status', args.status);
  }

  let endpoint = `/repos/${args.owner}/${args.repo}/actions/runs`;

  if (args.workflow_id) {
    endpoint = `/repos/${args.owner}/${args.repo}/actions/workflows/${args.workflow_id}/runs`;
  }

  const data = await githubFetch(`${endpoint}?${params}`) as {
    workflow_runs: Array<{
      id: number;
      name: string;
      head_branch: string;
      status: string;
      conclusion: string | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    }>;
  };

  return data.workflow_runs.map(run => ({
    id: run.id,
    name: run.name,
    head_branch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
  }));
}

async function getWorkflowRun(args: GetWorkflowRunArgs): Promise<unknown> {
  return await githubFetch(`/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}`);
}

async function rerunWorkflow(args: RerunWorkflowArgs): Promise<SuccessResult> {
  await githubFetch(`/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}/rerun`, {
    method: 'POST',
  });

  return {
    success: true,
    message: `Triggered rerun of workflow run ${args.run_id}`,
  };
}

async function cancelWorkflowRun(args: CancelWorkflowRunArgs): Promise<SuccessResult> {
  await githubFetch(`/repos/${args.owner}/${args.repo}/actions/runs/${args.run_id}/cancel`, {
    method: 'POST',
  });

  return {
    success: true,
    message: `Cancelled workflow run ${args.run_id}`,
  };
}

// ============================================================================
// Secrets Handlers
// ============================================================================

/**
 * Encrypt a secret value using the repository's public key
 * GitHub requires secrets to be encrypted using the sealed box algorithm
 */
function encryptSecretValue(publicKeyBase64: string, secretValue: string): string {
  // Decode the public key from base64
  const publicKey = Uint8Array.from(Buffer.from(publicKeyBase64, 'base64'));

  // Convert secret to bytes
  const secretBytes = Buffer.from(secretValue);

  // Generate an ephemeral key pair for the sealed box
  const ephemeralKeyPair = nacl.box.keyPair();

  // Create a nonce (24 bytes of zeros followed by the first 24 bytes of the ephemeral public key)
  const nonce = new Uint8Array(24);
  for (let i = 0; i < 24; i++) {
    nonce[i] = ephemeralKeyPair.publicKey[i % ephemeralKeyPair.publicKey.length];
  }

  // Encrypt the secret using nacl.box (sealed box format)
  const encryptedMessage = nacl.box(
    secretBytes,
    nonce,
    publicKey,
    ephemeralKeyPair.secretKey
  );

  // Combine ephemeral public key + encrypted message (sealed box format)
  const sealedBox = new Uint8Array(ephemeralKeyPair.publicKey.length + encryptedMessage.length);
  sealedBox.set(ephemeralKeyPair.publicKey);
  sealedBox.set(encryptedMessage, ephemeralKeyPair.publicKey.length);

  // Return base64 encoded
  return Buffer.from(sealedBox).toString('base64');
}

async function createSecret(args: CreateSecretArgs): Promise<SuccessResult> {
  // First, get the repository's public key for encryption
  const keyData = await githubFetch(
    `/repos/${args.owner}/${args.repo}/actions/secrets/public-key`
  ) as { key: string; key_id: string };

  // Encrypt the secret value using NaCl sealed box algorithm (G017 compliance)
  const encryptedValue = encryptSecretValue(keyData.key, args.secret_value);

  await githubFetch(`/repos/${args.owner}/${args.repo}/actions/secrets/${args.secret_name}`, {
    method: 'PUT',
    body: JSON.stringify({
      encrypted_value: encryptedValue,
      key_id: keyData.key_id,
    }),
  });

  return {
    success: true,
    message: `Created/updated secret ${args.secret_name}`,
  };
}

async function listSecrets(args: ListSecretsArgs): Promise<SecretSummary[]> {
  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/actions/secrets`
  ) as { secrets: Array<{ name: string; created_at: string; updated_at: string }> };

  return data.secrets.map(secret => ({
    name: secret.name,
    created_at: secret.created_at,
    updated_at: secret.updated_at,
  }));
}

async function deleteSecret(args: DeleteSecretArgs): Promise<SuccessResult> {
  await githubFetch(`/repos/${args.owner}/${args.repo}/actions/secrets/${args.secret_name}`, {
    method: 'DELETE',
  });

  return {
    success: true,
    message: `Deleted secret ${args.secret_name}`,
  };
}

// ============================================================================
// Environment Handlers
// ============================================================================

async function listEnvironments(args: ListEnvironmentsArgs): Promise<EnvironmentSummary[]> {
  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/environments`
  ) as { environments: Array<{ id: number; name: string; html_url: string; created_at: string; updated_at: string }> };

  return data.environments.map(env => ({
    id: env.id,
    name: env.name,
    html_url: env.html_url,
    created_at: env.created_at,
    updated_at: env.updated_at,
  }));
}

async function createEnvironmentSecret(args: CreateEnvironmentSecretArgs): Promise<SuccessResult> {
  // First, get the environment's public key for encryption
  const keyData = await githubFetch(
    `/repos/${args.owner}/${args.repo}/environments/${args.environment_name}/secrets/public-key`
  ) as { key: string; key_id: string };

  // Encrypt the secret value
  const encryptedValue = encryptSecretValue(keyData.key, args.secret_value);

  await githubFetch(
    `/repos/${args.owner}/${args.repo}/environments/${args.environment_name}/secrets/${args.secret_name}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: keyData.key_id,
      }),
    }
  );

  return {
    success: true,
    message: `Created/updated secret ${args.secret_name} in environment ${args.environment_name}`,
  };
}

async function deleteEnvironmentSecret(args: DeleteEnvironmentSecretArgs): Promise<SuccessResult> {
  await githubFetch(
    `/repos/${args.owner}/${args.repo}/environments/${args.environment_name}/secrets/${args.secret_name}`,
    {
      method: 'DELETE',
    }
  );

  return {
    success: true,
    message: `Deleted secret ${args.secret_name} from environment ${args.environment_name}`,
  };
}

// ============================================================================
// Branch Protection Handlers
// ============================================================================

async function getBranchProtection(args: GetBranchProtectionArgs): Promise<BranchProtectionSummary> {
  const data = await githubFetch(
    `/repos/${args.owner}/${args.repo}/branches/${args.branch}/protection`
  ) as BranchProtectionSummary;

  return data;
}

async function updateBranchProtection(args: UpdateBranchProtectionArgs): Promise<SuccessResult> {
  const body: Record<string, unknown> = {};

  if (args.required_status_checks) {
    body.required_status_checks = args.required_status_checks;
  }

  if (args.enforce_admins !== undefined) {
    body.enforce_admins = args.enforce_admins;
  }

  if (args.required_pull_request_reviews) {
    body.required_pull_request_reviews = args.required_pull_request_reviews;
  }

  if (args.restrictions) {
    body.restrictions = args.restrictions;
  }

  if (args.required_linear_history !== undefined) {
    body.required_linear_history = args.required_linear_history;
  }

  if (args.allow_force_pushes !== undefined) {
    body.allow_force_pushes = args.allow_force_pushes;
  }

  if (args.allow_deletions !== undefined) {
    body.allow_deletions = args.allow_deletions;
  }

  await githubFetch(`/repos/${args.owner}/${args.repo}/branches/${args.branch}/protection`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

  return {
    success: true,
    message: `Updated branch protection for ${args.branch}`,
  };
}

async function deleteBranchProtection(args: DeleteBranchProtectionArgs): Promise<SuccessResult> {
  await githubFetch(`/repos/${args.owner}/${args.repo}/branches/${args.branch}/protection`, {
    method: 'DELETE',
  });

  return {
    success: true,
    message: `Removed branch protection from ${args.branch}`,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools = [
  // Repository tools
  {
    name: 'github_get_repo',
    description: 'Get repository details including description, default branch, and metadata',
    schema: GetRepoArgsSchema,
    handler: getRepo as (args: unknown) => unknown,
  },
  {
    name: 'github_list_branches',
    description: 'List all branches in a repository',
    schema: ListBranchesArgsSchema,
    handler: listBranches as (args: unknown) => unknown,
  },
  {
    name: 'github_create_branch',
    description: 'Create a new branch from an existing branch',
    schema: CreateBranchArgsSchema,
    handler: createBranch as (args: unknown) => unknown,
  },
  {
    name: 'github_delete_branch',
    description: 'Delete a branch (protected branches cannot be deleted)',
    schema: DeleteBranchArgsSchema,
    handler: deleteBranch as (args: unknown) => unknown,
  },
  {
    name: 'github_get_file_contents',
    description: 'Get contents of a file or directory. Returns base64-encoded content for files, array of items for directories',
    schema: GetFileContentsArgsSchema,
    handler: getFileContents as (args: unknown) => unknown,
  },
  {
    name: 'github_create_or_update_file',
    description: 'Create a new file or update an existing file. Content will be base64 encoded automatically',
    schema: CreateOrUpdateFileArgsSchema,
    handler: createOrUpdateFile as (args: unknown) => unknown,
  },
  // Pull request tools
  {
    name: 'github_list_pull_requests',
    description: 'List pull requests in a repository',
    schema: ListPullRequestsArgsSchema,
    handler: listPullRequests as (args: unknown) => unknown,
  },
  {
    name: 'github_get_pull_request',
    description: 'Get detailed information about a specific pull request',
    schema: GetPullRequestArgsSchema,
    handler: getPullRequest as (args: unknown) => unknown,
  },
  {
    name: 'github_create_pull_request',
    description: 'Create a new pull request',
    schema: CreatePullRequestArgsSchema,
    handler: createPullRequest as (args: unknown) => unknown,
  },
  {
    name: 'github_merge_pull_request',
    description: 'Merge a pull request using specified merge method',
    schema: MergePullRequestArgsSchema,
    handler: mergePullRequest as (args: unknown) => unknown,
  },
  {
    name: 'github_get_pull_request_files',
    description: 'Get the list of files changed in a pull request with diff stats',
    schema: GetPullRequestFilesArgsSchema,
    handler: getPullRequestFiles as (args: unknown) => unknown,
  },
  // Issue tools
  {
    name: 'github_list_issues',
    description: 'List issues in a repository (excludes pull requests)',
    schema: ListIssuesArgsSchema,
    handler: listIssues as (args: unknown) => unknown,
  },
  {
    name: 'github_get_issue',
    description: 'Get detailed information about a specific issue',
    schema: GetIssueArgsSchema,
    handler: getIssue as (args: unknown) => unknown,
  },
  {
    name: 'github_create_issue',
    description: 'Create a new issue with optional labels and assignees',
    schema: CreateIssueArgsSchema,
    handler: createIssue as (args: unknown) => unknown,
  },
  {
    name: 'github_create_issue_comment',
    description: 'Add a comment to an existing issue or pull request',
    schema: CreateIssueCommentArgsSchema,
    handler: createIssueComment as (args: unknown) => unknown,
  },
  // Workflow tools
  {
    name: 'github_list_workflow_runs',
    description: 'List GitHub Actions workflow runs with optional filters',
    schema: ListWorkflowRunsArgsSchema,
    handler: listWorkflowRuns as (args: unknown) => unknown,
  },
  {
    name: 'github_get_workflow_run',
    description: 'Get detailed information about a specific workflow run',
    schema: GetWorkflowRunArgsSchema,
    handler: getWorkflowRun as (args: unknown) => unknown,
  },
  {
    name: 'github_rerun_workflow',
    description: 'Re-run a failed or completed workflow',
    schema: RerunWorkflowArgsSchema,
    handler: rerunWorkflow as (args: unknown) => unknown,
  },
  {
    name: 'github_cancel_workflow_run',
    description: 'Cancel a running workflow',
    schema: CancelWorkflowRunArgsSchema,
    handler: cancelWorkflowRun as (args: unknown) => unknown,
  },
  // Secrets tools
  {
    name: 'github_create_secret',
    description: 'Create or update a repository secret for GitHub Actions',
    schema: CreateSecretArgsSchema,
    handler: createSecret as (args: unknown) => unknown,
  },
  {
    name: 'github_list_secrets',
    description: 'List all repository secrets (names only, values are never exposed)',
    schema: ListSecretsArgsSchema,
    handler: listSecrets as (args: unknown) => unknown,
  },
  {
    name: 'github_delete_secret',
    description: 'Delete a repository secret',
    schema: DeleteSecretArgsSchema,
    handler: deleteSecret as (args: unknown) => unknown,
  },
  // Environment tools
  {
    name: 'github_list_environments',
    description: 'List deployment environments (e.g., production, staging)',
    schema: ListEnvironmentsArgsSchema,
    handler: listEnvironments as (args: unknown) => unknown,
  },
  {
    name: 'github_create_environment_secret',
    description: 'Create or update an environment-specific secret',
    schema: CreateEnvironmentSecretArgsSchema,
    handler: createEnvironmentSecret as (args: unknown) => unknown,
  },
  {
    name: 'github_delete_environment_secret',
    description: 'Delete an environment-specific secret',
    schema: DeleteEnvironmentSecretArgsSchema,
    handler: deleteEnvironmentSecret as (args: unknown) => unknown,
  },
  // Branch protection tools
  {
    name: 'github_get_branch_protection',
    description: 'Get branch protection rules',
    schema: GetBranchProtectionArgsSchema,
    handler: getBranchProtection as (args: unknown) => unknown,
  },
  {
    name: 'github_update_branch_protection',
    description: 'Update branch protection rules (e.g., require PR reviews, status checks)',
    schema: UpdateBranchProtectionArgsSchema,
    handler: updateBranchProtection as (args: unknown) => unknown,
  },
  {
    name: 'github_delete_branch_protection',
    description: 'Remove branch protection rules',
    schema: DeleteBranchProtectionArgsSchema,
    handler: deleteBranchProtection as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// Create and start server
const server = new McpServer({
  name: 'github-mcp',
  version: '1.0.0',
  tools,
});

server.start();
