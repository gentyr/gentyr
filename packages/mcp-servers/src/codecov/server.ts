#!/usr/bin/env node
/**
 * Codecov MCP Server
 *
 * Provides tools for querying code coverage data via Codecov API v2.
 * Read-only access to coverage reports, trends, commits, branches, and PRs.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - CODECOV_TOKEN: Codecov API token (bearer auth)
 *
 * Optional env vars:
 * - CODECOV_OWNER: Default repository owner (avoids repeating in every call)
 * - CODECOV_SERVICE: Default git service (default: github)
 *
 * @version 1.0.0
 */

import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListReposArgsSchema,
  GetRepoArgsSchema,
  GetCoverageArgsSchema,
  GetCoverageTrendArgsSchema,
  GetFileCoverageArgsSchema,
  ListCommitsArgsSchema,
  GetCommitArgsSchema,
  ListBranchesArgsSchema,
  GetBranchArgsSchema,
  ListPullsArgsSchema,
  GetPullArgsSchema,
  CompareArgsSchema,
  ListFlagsArgsSchema,
  ListComponentsArgsSchema,
  type ListReposArgs,
  type GetRepoArgs,
  type GetCoverageArgs,
  type GetCoverageTrendArgs,
  type GetFileCoverageArgs,
  type ListCommitsArgs,
  type GetCommitArgs,
  type ListBranchesArgs,
  type GetBranchArgs,
  type ListPullsArgs,
  type GetPullArgs,
  type CompareArgs,
  type ListFlagsArgs,
  type ListComponentsArgs,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const { CODECOV_TOKEN, CODECOV_OWNER, CODECOV_SERVICE } = process.env;
const BASE_URL = 'https://api.codecov.io/api/v2';
const DEFAULT_SERVICE = CODECOV_SERVICE || 'github';

if (!CODECOV_TOKEN) {
  console.error('CODECOV_TOKEN environment variable is required');
  process.exit(1);
}

// ============================================================================
// API Helper
// ============================================================================

async function codecovFetch(endpoint: string, params?: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${endpoint}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `bearer ${CODECOV_TOKEN}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    // G001: Fail-closed on authentication errors
    if (response.status === 401 || response.status === 403) {
      console.error(`Codecov authentication failed (${response.status}) - token may be invalid or expired`);
      process.exit(1);
    }

    const text = await response.text();
    let message: string;
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const detail = typeof data.detail === 'string' ? data.detail : undefined;
      const msg = typeof data.message === 'string' ? data.message : undefined;
      message = detail || msg || text;
    } catch {
      message = text;
    }
    throw new Error(`Codecov API error ${response.status}: ${message}`);
  }

  return response.json();
}

function repoPath(service: string, owner: string, repo: string): string {
  return `/${encodeURIComponent(service)}/${encodeURIComponent(owner)}/repos/${encodeURIComponent(repo)}`;
}

// ============================================================================
// Tool Handlers
// ============================================================================

async function listRepos(args: ListReposArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required (or set CODECOV_OWNER env var)');}

  const data = await codecovFetch(`/${encodeURIComponent(service)}/${encodeURIComponent(owner)}/repos/`, {
    active: args.active,
    page: args.page,
    page_size: args.page_size,
  });

  return data;
}

async function getRepo(args: GetRepoArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/`);
}

async function getCoverage(args: GetCoverageArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/totals/`, {
    branch: args.branch,
  });
}

async function getCoverageTrend(args: GetCoverageTrendArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/coverage/`, {
    branch: args.branch,
    interval: args.interval,
  });
}

async function getFileCoverage(args: GetFileCoverageArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/file-report/`, {
    path: args.path,
    branch: args.branch,
  });
}

async function listCommits(args: ListCommitsArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/commits/`, {
    branch: args.branch,
    page: args.page,
    page_size: args.page_size,
  });
}

async function getCommit(args: GetCommitArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/commits/${encodeURIComponent(args.commitid)}/`);
}

async function listBranches(args: ListBranchesArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/branches/`, {
    page: args.page,
    page_size: args.page_size,
  });
}

async function getBranch(args: GetBranchArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/branches/${encodeURIComponent(args.branch)}/`);
}

async function listPulls(args: ListPullsArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/pulls/`, {
    state: args.state,
    page: args.page,
    page_size: args.page_size,
  });
}

async function getPull(args: GetPullArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/pulls/${encodeURIComponent(String(args.pullid))}/`);
}

async function compare(args: CompareArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/compare/`, {
    base: args.base,
    head: args.head,
  });
}

async function listFlags(args: ListFlagsArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/flags/`, {
    page: args.page,
    page_size: args.page_size,
  });
}

async function listComponents(args: ListComponentsArgs) {
  const service = args.service || DEFAULT_SERVICE;
  const owner = args.owner || CODECOV_OWNER;
  if (!owner) {throw new Error('owner is required');}

  return codecovFetch(`${repoPath(service, owner, args.repo)  }/components/`);
}

// ============================================================================
// Tool Registration
// ============================================================================

const tools = [
  // Repositories
  {
    name: 'codecov_list_repos',
    description: 'List repositories tracked by Codecov for an owner/organization.',
    schema: ListReposArgsSchema,
    handler: listRepos as (args: unknown) => unknown,
  },
  {
    name: 'codecov_get_repo',
    description: 'Get details of a specific repository including coverage percentage and configuration.',
    schema: GetRepoArgsSchema,
    handler: getRepo as (args: unknown) => unknown,
  },

  // Coverage
  {
    name: 'codecov_get_coverage',
    description: 'Get current coverage totals for a repository, optionally filtered by branch.',
    schema: GetCoverageArgsSchema,
    handler: getCoverage as (args: unknown) => unknown,
  },
  {
    name: 'codecov_get_coverage_trend',
    description: 'Get coverage trend data over time for a repository. Useful for tracking coverage changes.',
    schema: GetCoverageTrendArgsSchema,
    handler: getCoverageTrend as (args: unknown) => unknown,
  },
  {
    name: 'codecov_get_file_coverage',
    description: 'Get coverage report for a specific file in the repository.',
    schema: GetFileCoverageArgsSchema,
    handler: getFileCoverage as (args: unknown) => unknown,
  },

  // Commits
  {
    name: 'codecov_list_commits',
    description: 'List commits with coverage data for a repository.',
    schema: ListCommitsArgsSchema,
    handler: listCommits as (args: unknown) => unknown,
  },
  {
    name: 'codecov_get_commit',
    description: 'Get coverage details for a specific commit.',
    schema: GetCommitArgsSchema,
    handler: getCommit as (args: unknown) => unknown,
  },

  // Branches
  {
    name: 'codecov_list_branches',
    description: 'List branches with coverage data for a repository.',
    schema: ListBranchesArgsSchema,
    handler: listBranches as (args: unknown) => unknown,
  },
  {
    name: 'codecov_get_branch',
    description: 'Get coverage details for a specific branch.',
    schema: GetBranchArgsSchema,
    handler: getBranch as (args: unknown) => unknown,
  },

  // Pull Requests
  {
    name: 'codecov_list_pulls',
    description: 'List pull requests with coverage data.',
    schema: ListPullsArgsSchema,
    handler: listPulls as (args: unknown) => unknown,
  },
  {
    name: 'codecov_get_pull',
    description: 'Get coverage details for a specific pull request including coverage diff.',
    schema: GetPullArgsSchema,
    handler: getPull as (args: unknown) => unknown,
  },

  // Comparison
  {
    name: 'codecov_compare',
    description: 'Compare coverage between two commits or branches. Shows coverage diff and impacted files.',
    schema: CompareArgsSchema,
    handler: compare as (args: unknown) => unknown,
  },

  // Flags & Components
  {
    name: 'codecov_list_flags',
    description: 'List coverage flags configured for a repository.',
    schema: ListFlagsArgsSchema,
    handler: listFlags as (args: unknown) => unknown,
  },
  {
    name: 'codecov_list_components',
    description: 'List coverage components configured for a repository.',
    schema: ListComponentsArgsSchema,
    handler: listComponents as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// ============================================================================
// Start Server
// ============================================================================

const server = new McpServer({
  name: 'codecov-mcp',
  version: '1.0.0',
  tools,
});

server.start();
