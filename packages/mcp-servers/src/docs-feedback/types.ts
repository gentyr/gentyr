/**
 * Types for the Docs Feedback MCP Server
 *
 * Provides generic search and retrieval tools for documentation
 * directories configured per feedback persona.
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const SearchDocsSchema = z.object({
  query: z.string().min(1).describe('Search query for documentation'),
  max_results: z.coerce.number().min(1).max(20).default(5).describe('Maximum results to return (1-20, default 5)'),
});

export const ListDocsSchema = z.object({});

export const ReadDocSchema = z.object({
  file_path: z.string().min(1).describe('Relative path of the doc file to read (from docs_list)'),
});

export const StatusSchema = z.object({});

// ============================================================================
// Type Definitions
// ============================================================================

export type SearchDocsArgs = z.infer<typeof SearchDocsSchema>;
export type ListDocsArgs = z.infer<typeof ListDocsSchema>;
export type ReadDocArgs = z.infer<typeof ReadDocSchema>;
export type StatusArgs = z.infer<typeof StatusSchema>;

export interface DocFile {
  name: string;
  content: string;
  wordCount: number;
  relativePath: string;
}

export interface DocSearchResultItem {
  relative_path: string;
  score: number;
  snippet: string;
  word_count: number;
}

export interface DocSearchResult {
  query: string;
  results: DocSearchResultItem[];
  total_matches: number;
}

export interface DocListItem {
  relative_path: string;
  word_count: number;
}

export interface DocListResult {
  files: DocListItem[];
  total_files: number;
  total_words: number;
}

export interface DocReadResult {
  relative_path: string;
  content: string;
  word_count: number;
}

export interface DocReadErrorResult {
  error: string;
  hint: string;
}

export interface DocStatusResult {
  available: boolean;
  docs_path: string;
  total_files: number;
  total_words: number;
}
