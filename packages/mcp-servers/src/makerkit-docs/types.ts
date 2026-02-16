/**
 * Types for the Makerkit Docs MCP Server
 *
 * Provides search and retrieval tools for Makerkit documentation
 * generated from the makerkit/documentation GitHub repo.
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const SearchDocsSchema = z.object({
  query: z.string().min(1).describe('Search query for Makerkit documentation'),
  max_results: z.number().min(1).max(20).default(5).describe('Maximum results to return (1-20, default 5)'),
});

export const ListDocsSchema = z.object({});

export const ReadDocSchema = z.object({
  file_name: z.string().min(1).describe('Name of the doc file to read (from makerkit_docs_list)'),
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
  path: string;
}

export interface DocSearchResultItem {
  file_name: string;
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
  name: string;
  word_count: number;
}

export interface DocListResult {
  files: DocListItem[];
  total_files: number;
  total_words: number;
}

export interface DocReadResult {
  file_name: string;
  content: string;
  word_count: number;
}

export interface DocReadErrorResult {
  error: string;
  hint: string;
}

export interface DocStatusResult {
  available: boolean;
  docs_path: string | null;
  total_files: number;
  total_words: number;
  last_generated: string | null;
  kit: string | null;
}
