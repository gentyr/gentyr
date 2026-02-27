#!/usr/bin/env node
/**
 * Docs Feedback MCP Server
 *
 * Provides generic search and retrieval tools for documentation directories
 * configured per feedback persona. Supports recursive directory walks for
 * nested doc structures (.md and .mdx files).
 *
 * Uses AuditedMcpServer to log every tool call to session-events.db.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditedMcpServer } from '../shared/audited-server.js';
import type { AnyToolHandler } from '../shared/server.js';
import {
  SearchDocsSchema,
  ListDocsSchema,
  ReadDocSchema,
  StatusSchema,
  type SearchDocsArgs,
  type ReadDocArgs,
  type DocFile,
  type DocSearchResult,
  type DocListResult,
  type DocReadResult,
  type DocReadErrorResult,
  type DocStatusResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface DocsFeedbackConfig {
  docsPath: string;
  auditSessionId: string;
  auditPersonaName?: string;
  auditDbPath?: string;
}

const NOT_CONFIGURED_ERROR = 'Docs not configured. Use /configure-personas to set the docs directory for this persona.';

// ============================================================================
// Document Loading & Indexing
// ============================================================================

/**
 * Recursively walk a directory and collect all .md and .mdx files.
 * Returns paths relative to the docs root.
 */
function walkDocs(docsRoot: string, dir: string, results: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDocs(docsRoot, fullPath, results);
    } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
      results.push(path.relative(docsRoot, fullPath));
    }
  }
}

function loadDocs(docsPath: string): DocFile[] {
  if (!docsPath || !fs.existsSync(docsPath)) {
    return [];
  }

  const relativePaths: string[] = [];
  walkDocs(docsPath, docsPath, relativePaths);
  relativePaths.sort();

  const docs: DocFile[] = [];
  for (const relativePath of relativePaths) {
    const filePath = path.join(docsPath, relativePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      docs.push({
        name: path.basename(relativePath),
        content,
        wordCount: content.split(/\s+/).filter(w => w.length > 0).length,
        relativePath,
      });
    } catch (err) {
      process.stderr.write(`[docs-feedback] Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  return docs;
}

// ============================================================================
// Scoring & Snippets
// ============================================================================

/**
 * Score a document against a search query.
 * Title/filename match is weighted 3x over content matches.
 */
function scoreDocument(doc: DocFile, queryTerms: string[]): number {
  const contentLower = doc.content.toLowerCase();
  const nameLower = doc.relativePath.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    const termLower = term.toLowerCase();

    // Title/filename match (weighted 3x)
    if (nameLower.includes(termLower)) {
      score += 3;
    }

    // Count content occurrences
    let idx = 0;
    let count = 0;
    while ((idx = contentLower.indexOf(termLower, idx)) !== -1) {
      count++;
      idx += termLower.length;
    }
    score += count;
  }

  return score;
}

/**
 * Extract a relevant snippet around the first match of any query term.
 */
function extractSnippet(content: string, queryTerms: string[], maxLength: number = 500): string {
  const contentLower = content.toLowerCase();
  let bestIdx = -1;

  for (const term of queryTerms) {
    const idx = contentLower.indexOf(term.toLowerCase());
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }

  if (bestIdx === -1) {
    return content.slice(0, maxLength) + (content.length > maxLength ? '...' : '');
  }

  const start = Math.max(0, bestIdx - Math.floor(maxLength / 4));
  const end = Math.min(content.length, start + maxLength);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// ============================================================================
// Factory Function
// ============================================================================

export function createDocsFeedbackServer(config: DocsFeedbackConfig): AuditedMcpServer {
  // Cache docs per server instance — loaded lazily on first tool call
  let docsCache: DocFile[] | null = null;

  function getDocs(): DocFile[] {
    if (docsCache === null) {
      docsCache = loadDocs(config.docsPath);
    }
    return docsCache;
  }

  function isConfigured(): boolean {
    return !!(config.docsPath && config.docsPath.trim() && fs.existsSync(config.docsPath));
  }

  // ============================================================================
  // Tool Implementations
  // ============================================================================

  function searchDocs(args: SearchDocsArgs): DocSearchResult | DocReadErrorResult {
    if (!isConfigured()) {
      return { error: NOT_CONFIGURED_ERROR, hint: 'Set the docs directory for this persona via /configure-personas.' };
    }

    const docs = getDocs();
    const queryTerms = args.query.split(/\s+/).filter(t => t.length > 0);
    const maxResults = args.max_results ?? 5;

    if (queryTerms.length === 0) {
      return { query: args.query, results: [], total_matches: 0 };
    }

    const scored = docs
      .map(doc => ({ doc, score: scoreDocument(doc, queryTerms) }))
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);

    const results = scored.slice(0, maxResults).map(item => ({
      relative_path: item.doc.relativePath,
      score: item.score,
      snippet: extractSnippet(item.doc.content, queryTerms),
      word_count: item.doc.wordCount,
    }));

    return {
      query: args.query,
      results,
      total_matches: scored.length,
    };
  }

  function listDocs(): DocListResult | DocReadErrorResult {
    if (!isConfigured()) {
      return { error: NOT_CONFIGURED_ERROR, hint: 'Set the docs directory for this persona via /configure-personas.' };
    }

    const docs = getDocs();
    return {
      files: docs.map(d => ({
        relative_path: d.relativePath,
        word_count: d.wordCount,
      })),
      total_files: docs.length,
      total_words: docs.reduce((sum, d) => sum + d.wordCount, 0),
    };
  }

  function readDoc(args: ReadDocArgs): DocReadResult | DocReadErrorResult {
    if (!isConfigured()) {
      return { error: NOT_CONFIGURED_ERROR, hint: 'Set the docs directory for this persona via /configure-personas.' };
    }

    const docs = getDocs();
    const doc = docs.find(d => d.relativePath === args.file_path);

    if (!doc) {
      const available = docs.map(d => d.relativePath).slice(0, 10).join(', ');
      return {
        error: `Document not found: ${args.file_path}`,
        hint: `Use docs_list to see available files. Available: ${available}${docs.length > 10 ? '...' : ''}`,
      };
    }

    return {
      relative_path: doc.relativePath,
      content: doc.content,
      word_count: doc.wordCount,
    };
  }

  function getStatus(): DocStatusResult | DocReadErrorResult {
    if (!isConfigured()) {
      return {
        available: false,
        docs_path: config.docsPath || '',
        total_files: 0,
        total_words: 0,
      };
    }

    const docs = getDocs();
    return {
      available: docs.length > 0,
      docs_path: config.docsPath,
      total_files: docs.length,
      total_words: docs.reduce((sum, d) => sum + d.wordCount, 0),
    };
  }

  // ============================================================================
  // Server Setup
  // ============================================================================

  const tools: AnyToolHandler[] = [
    {
      name: 'docs_search',
      description: 'Search documentation by keywords. Returns matching doc files with relevance scores and snippets.',
      schema: SearchDocsSchema,
      handler: searchDocs,
    },
    {
      name: 'docs_list',
      description: 'List all available documentation files with relative paths and word counts.',
      schema: ListDocsSchema,
      handler: listDocs,
    },
    {
      name: 'docs_read',
      description: 'Read the full content of a specific documentation file. Use file_path from docs_list.',
      schema: ReadDocSchema,
      handler: readDoc,
    },
    {
      name: 'docs_status',
      description: 'Show documentation availability, file count, and configured path.',
      schema: StatusSchema,
      handler: getStatus,
    },
  ];

  return new AuditedMcpServer({
    name: 'docs-feedback',
    version: '1.0.0',
    tools,
    auditSessionId: config.auditSessionId,
    auditPersonaName: config.auditPersonaName,
    auditDbPath: config.auditDbPath,
  });
}

// ============================================================================
// Auto-start when run directly (not when imported by tests)
// ============================================================================

import { fileURLToPath } from 'url';
import * as pathMod from 'path';

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && pathMod.resolve(process.argv[1]) === pathMod.resolve(__filename)) {
  const autoConfig: DocsFeedbackConfig = {
    docsPath: process.env['FEEDBACK_DOCS_PATH'] || '',
    auditSessionId: process.env['FEEDBACK_SESSION_ID'] || '',
    auditPersonaName: process.env['FEEDBACK_PERSONA_NAME'],
  };

  const server = createDocsFeedbackServer(autoConfig);

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  server.start();
}
