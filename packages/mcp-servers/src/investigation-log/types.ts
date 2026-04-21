/**
 * Investigation Log — Types & Schemas
 *
 * Zod schemas and TypeScript types for the investigation-log MCP server.
 * Tracks hypotheses tested and solutions proven across agent sessions,
 * preventing redundant re-investigation of eliminated root causes.
 */

import { z } from 'zod';

// ============================================================================
// Tool Argument Schemas
// ============================================================================

export const LogHypothesisArgsSchema = z.object({
  symptom: z.string().describe('Observable symptom that triggered the investigation (e.g., "fillInput sets DOM value but form submits empty")'),
  hypothesis: z.string().describe('Proposed explanation for the symptom (e.g., "React _valueTracker not updated by programmatic value set")'),
  test_performed: z.string().optional().describe('What test was done to validate/invalidate this hypothesis'),
  result: z.string().optional().describe('What the test showed (e.g., "Confirmed: tracker.getValue() returns pre-fill value")'),
  conclusion: z.enum(['confirmed', 'eliminated', 'inconclusive']).describe('Whether this hypothesis was confirmed, eliminated, or remains inconclusive'),
  root_cause_tag: z.string().optional().describe('Grouping tag for related hypotheses (e.g., "react-controlled-input", "chrome-extension-cache")'),
  persistent_task_id: z.string().optional().describe('ID of the persistent task this investigation belongs to'),
});
export type LogHypothesisArgs = z.infer<typeof LogHypothesisArgsSchema>;

export const SearchHypothesesArgsSchema = z.object({
  query: z.string().describe('Search text — matched against symptom, hypothesis, and result fields via full-text search'),
  root_cause_tag: z.string().optional().describe('Filter by root cause tag'),
  conclusion: z.enum(['confirmed', 'eliminated', 'inconclusive']).optional().describe('Filter by conclusion'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
});
export type SearchHypothesesArgs = z.infer<typeof SearchHypothesesArgsSchema>;

export const LogSolutionArgsSchema = z.object({
  problem: z.string().describe('Description of the problem this solution addresses'),
  solution: z.string().describe('The solution pattern or approach (code snippet, tool name, configuration change)'),
  files: z.array(z.string()).optional().describe('File paths involved in the solution'),
  pr_number: z.number().int().optional().describe('PR number where this solution was implemented'),
  root_cause_tag: z.string().optional().describe('Links this solution to hypotheses with the same tag'),
  promoted_to_tool: z.string().optional().describe('Name of the MCP tool this was promoted to (e.g., "react_fill_input")'),
});
export type LogSolutionArgs = z.infer<typeof LogSolutionArgsSchema>;

export const SearchSolutionsArgsSchema = z.object({
  query: z.string().describe('Search text — matched against problem and solution fields via full-text search'),
  root_cause_tag: z.string().optional().describe('Filter by root cause tag'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
});
export type SearchSolutionsArgs = z.infer<typeof SearchSolutionsArgsSchema>;

export const GetInvestigationContextArgsSchema = z.object({
  symptom: z.string().describe('Symptom description to search for related hypotheses and solutions'),
  limit: z.number().int().min(1).max(20).default(5).describe('Maximum results per category'),
});
export type GetInvestigationContextArgs = z.infer<typeof GetInvestigationContextArgsSchema>;

// ============================================================================
// Result Types
// ============================================================================

export interface HypothesisRecord {
  id: string;
  persistent_task_id: string | null;
  symptom: string;
  hypothesis: string;
  test_performed: string | null;
  result: string | null;
  conclusion: string;
  root_cause_tag: string | null;
  created_at: string;
  agent_id: string | null;
  session_id: string | null;
}

export interface SolutionRecord {
  id: string;
  problem: string;
  solution: string;
  files: string | null;
  pr_number: number | null;
  root_cause_tag: string | null;
  verified_count: number;
  promoted_to_tool: string | null;
  created_at: string;
}

export interface InvestigationContext {
  hypotheses: HypothesisRecord[];
  solutions: SolutionRecord[];
  summary: string;
}
