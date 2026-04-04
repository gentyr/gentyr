/**
 * Session Activity MCP Server — Zod schemas and TypeScript types.
 *
 * @module session-activity/types
 * @version 1.0.0
 */

import { z } from 'zod';

// ============================================================================
// Tool Schemas
// ============================================================================

export const GetSessionSummaryArgsSchema = z.object({
  id: z.string().describe('Summary UUID (from broadcast message or list_session_summaries)'),
});

export const ListSessionSummariesArgsSchema = z.object({
  session_id: z.string().describe('Session ID or agent ID to filter by'),
  limit: z.preprocess(
    (v) => (typeof v === 'string' ? parseInt(v, 10) : v),
    z.number().optional().default(20),
  ).describe('Maximum results to return (default 20)'),
});

export const ListProjectSummariesArgsSchema = z.object({
  limit: z.preprocess(
    (v) => (typeof v === 'string' ? parseInt(v, 10) : v),
    z.number().optional().default(20),
  ).describe('Maximum results to return (default 20)'),
});

export const GetProjectSummaryArgsSchema = z.object({
  id: z.string().describe('Project summary UUID (from broadcast message or list_project_summaries)'),
});

// ============================================================================
// TypeScript Types
// ============================================================================

export type GetSessionSummaryArgs = z.infer<typeof GetSessionSummaryArgsSchema>;
export type ListSessionSummariesArgs = z.infer<typeof ListSessionSummariesArgsSchema>;
export type ListProjectSummariesArgs = z.infer<typeof ListProjectSummariesArgsSchema>;
export type GetProjectSummaryArgs = z.infer<typeof GetProjectSummaryArgsSchema>;

export interface SessionSummaryRecord {
  id: string;
  session_id: string | null;
  agent_id: string | null;
  queue_id: string | null;
  title: string | null;
  summary: string;
  model: string;
  tokens_used: number;
  created_at: string;
}

export interface ProjectSummaryRecord {
  id: string;
  summary: string;
  session_count: number;
  model: string;
  tokens_used: number;
  created_at: string;
}

export interface ErrorResult {
  error: string;
}
