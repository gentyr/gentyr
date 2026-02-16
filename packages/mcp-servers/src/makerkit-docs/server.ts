#!/usr/bin/env node
/**
 * Makerkit Docs MCP Server
 *
 * Provides tools to search and retrieve Makerkit documentation
 * generated from the makerkit/documentation GitHub repo.
 * Docs are generated during GENTYR setup.sh and stored in
 * vendor/makerkit/docs-generated/.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
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

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

/**
 * Resolve the docs path. Checks:
 * 1. MAKERKIT_DOCS_PATH env var (absolute or relative to PROJECT_DIR)
 * 2. Default: .claude-framework/vendor/makerkit/docs-generated/
 */
function resolveDocsPath(): string | null {
  if (process.env.MAKERKIT_DOCS_PATH) {
    const envPath = process.env.MAKERKIT_DOCS_PATH;
    const resolved = path.isAbsolute(envPath)
      ? envPath
      : path.resolve(PROJECT_DIR, envPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // Default fallback
  const defaultPath = path.join(PROJECT_DIR, '.claude-framework', 'vendor', 'makerkit', 'docs-generated');
  if (fs.existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

// ============================================================================
// Document Loading & Indexing
// ============================================================================

let docsCache: DocFile[] | null = null;

function loadDocs(): DocFile[] {
  if (docsCache !== null) {
    return docsCache;
  }

  const docsPath = resolveDocsPath();
  if (!docsPath) {
    docsCache = [];
    return docsCache;
  }

  try {
    const files = fs.readdirSync(docsPath)
      .filter(f => f.endsWith('.md'))
      .sort();

    docsCache = files.map(f => {
      const filePath = path.join(docsPath, f);
      const content = fs.readFileSync(filePath, 'utf8');
      return {
        name: f,
        content,
        wordCount: content.split(/\s+/).length,
        path: filePath,
      };
    });
  } catch (err) {
    console.error(`[makerkit-docs] Failed to load docs from ${docsPath}: ${err instanceof Error ? err.message : String(err)}`);
    docsCache = [];
  }

  return docsCache;
}

/**
 * Score a document against a search query.
 * Uses keyword matching with title-weighting for relevance.
 */
function scoreDocument(doc: DocFile, queryTerms: string[]): number {
  const contentLower = doc.content.toLowerCase();
  const nameLower = doc.name.toLowerCase();
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
    // No match found, return beginning of content
    return content.slice(0, maxLength) + (content.length > maxLength ? '...' : '');
  }

  // Center the snippet around the match
  const start = Math.max(0, bestIdx - Math.floor(maxLength / 4));
  const end = Math.min(content.length, start + maxLength);
  let snippet = content.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

// ============================================================================
// Tool Implementations
// ============================================================================

function searchDocs(args: SearchDocsArgs): DocSearchResult {
  const docs = loadDocs();
  const queryTerms = args.query.split(/\s+/).filter(t => t.length > 0);
  const maxResults = args.max_results ?? 5;

  if (queryTerms.length === 0) {
    return { query: args.query, results: [], total_matches: 0 };
  }

  const scored = docs
    .map(doc => ({
      doc,
      score: scoreDocument(doc, queryTerms),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const results = scored.slice(0, maxResults).map(item => ({
    file_name: item.doc.name,
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

function listDocs(): DocListResult {
  const docs = loadDocs();

  return {
    files: docs.map(d => ({
      name: d.name,
      word_count: d.wordCount,
    })),
    total_files: docs.length,
    total_words: docs.reduce((sum, d) => sum + d.wordCount, 0),
  };
}

function readDoc(args: ReadDocArgs): DocReadResult | DocReadErrorResult {
  const docs = loadDocs();
  const doc = docs.find(d => d.name === args.file_name);

  if (!doc) {
    const available = docs.map(d => d.name).slice(0, 10).join(', ');
    return {
      error: `Document not found: ${args.file_name}`,
      hint: `Use makerkit_docs_list to see available files. Available: ${available}${docs.length > 10 ? '...' : ''}`,
    };
  }

  return {
    file_name: doc.name,
    content: doc.content,
    word_count: doc.wordCount,
  };
}

function getStatus(): DocStatusResult {
  const docsPath = resolveDocsPath();
  const docs = loadDocs();

  // Try to read config.json for metadata
  let lastGenerated: string | null = null;
  let kit: string | null = null;

  if (docsPath) {
    const configPath = path.join(path.dirname(docsPath), 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        lastGenerated = config.lastUpdated || null;
        kit = config.kit || null;
      } catch {
        // Ignore config parse errors
      }
    }
  }

  return {
    available: docs.length > 0,
    docs_path: docsPath,
    total_files: docs.length,
    total_words: docs.reduce((sum, d) => sum + d.wordCount, 0),
    last_generated: lastGenerated,
    kit,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: AnyToolHandler[] = [
  {
    name: 'makerkit_docs_search',
    description: 'Search Makerkit documentation by keywords. Returns matching doc files with relevance scores and snippets.',
    schema: SearchDocsSchema,
    handler: searchDocs,
  },
  {
    name: 'makerkit_docs_list',
    description: 'List all available Makerkit documentation files with word counts.',
    schema: ListDocsSchema,
    handler: listDocs,
  },
  {
    name: 'makerkit_docs_read',
    description: 'Read the full content of a specific Makerkit documentation file. Use file_name from makerkit_docs_list.',
    schema: ReadDocSchema,
    handler: readDoc,
  },
  {
    name: 'makerkit_docs_status',
    description: 'Show Makerkit docs availability, file count, and generation metadata.',
    schema: StatusSchema,
    handler: getStatus,
  },
];

const server = new McpServer({
  name: 'makerkit-docs',
  version: '1.0.0',
  tools,
});

server.start();
