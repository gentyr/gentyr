/**
 * Codecov MCP Server Types
 *
 * Type definitions for Codecov API v2 interactions.
 */

import { z } from 'zod';

// ============================================================================
// Common Schemas
// ============================================================================

const ServiceSchema = z.enum(['github', 'gitlab', 'bitbucket']).default('github')
  .describe('Git hosting service provider');

// ============================================================================
// Repository Schemas
// ============================================================================

export const ListReposArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner (org or username)'),
  active: z.coerce.boolean().optional().describe('Filter by active repositories only'),
  page: z.coerce.number().optional().default(1).describe('Page number'),
  page_size: z.coerce.number().optional().default(20).describe('Results per page (max 100)'),
});

export const GetRepoArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
});

// ============================================================================
// Coverage Schemas
// ============================================================================

export const GetCoverageArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().optional().describe('Branch name (default: repo default branch)'),
});

export const GetCoverageTrendArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().optional().describe('Branch name'),
  interval: z.enum(['1d', '7d', '30d']).optional().default('7d').describe('Trend interval'),
});

export const GetFileCoverageArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  path: z.string().describe('File path within the repository'),
  branch: z.string().optional().describe('Branch name'),
});

// ============================================================================
// Commit Schemas
// ============================================================================

export const ListCommitsArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().optional().describe('Filter by branch'),
  page: z.coerce.number().optional().default(1).describe('Page number'),
  page_size: z.coerce.number().optional().default(20).describe('Results per page'),
});

export const GetCommitArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  commitid: z.string().describe('Commit SHA'),
});

// ============================================================================
// Branch Schemas
// ============================================================================

export const ListBranchesArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  page: z.coerce.number().optional().default(1).describe('Page number'),
  page_size: z.coerce.number().optional().default(20).describe('Results per page'),
});

export const GetBranchArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  branch: z.string().describe('Branch name'),
});

// ============================================================================
// Pull Request Schemas
// ============================================================================

export const ListPullsArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  state: z.enum(['open', 'closed', 'merged']).optional().describe('Filter by PR state'),
  page: z.coerce.number().optional().default(1).describe('Page number'),
  page_size: z.coerce.number().optional().default(20).describe('Results per page'),
});

export const GetPullArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  pullid: z.coerce.number().describe('Pull request number'),
});

// ============================================================================
// Comparison Schemas
// ============================================================================

export const CompareArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  base: z.string().describe('Base commit SHA or branch'),
  head: z.string().describe('Head commit SHA or branch'),
});

// ============================================================================
// Flag Schemas
// ============================================================================

export const ListFlagsArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
  page: z.coerce.number().optional().default(1).describe('Page number'),
  page_size: z.coerce.number().optional().default(20).describe('Results per page'),
});

// ============================================================================
// Component Schemas
// ============================================================================

export const ListComponentsArgsSchema = z.object({
  service: ServiceSchema,
  owner: z.string().describe('Repository owner'),
  repo: z.string().describe('Repository name'),
});

// ============================================================================
// Inferred Types
// ============================================================================

export type ListReposArgs = z.infer<typeof ListReposArgsSchema>;
export type GetRepoArgs = z.infer<typeof GetRepoArgsSchema>;
export type GetCoverageArgs = z.infer<typeof GetCoverageArgsSchema>;
export type GetCoverageTrendArgs = z.infer<typeof GetCoverageTrendArgsSchema>;
export type GetFileCoverageArgs = z.infer<typeof GetFileCoverageArgsSchema>;
export type ListCommitsArgs = z.infer<typeof ListCommitsArgsSchema>;
export type GetCommitArgs = z.infer<typeof GetCommitArgsSchema>;
export type ListBranchesArgs = z.infer<typeof ListBranchesArgsSchema>;
export type GetBranchArgs = z.infer<typeof GetBranchArgsSchema>;
export type ListPullsArgs = z.infer<typeof ListPullsArgsSchema>;
export type GetPullArgs = z.infer<typeof GetPullArgsSchema>;
export type CompareArgs = z.infer<typeof CompareArgsSchema>;
export type ListFlagsArgs = z.infer<typeof ListFlagsArgsSchema>;
export type ListComponentsArgs = z.infer<typeof ListComponentsArgsSchema>;
