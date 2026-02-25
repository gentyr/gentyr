/**
 * Unit tests for the Docs Feedback MCP Server
 *
 * Tests recursive directory walking, search scoring, file reading,
 * listing, status, and graceful error handling when docs are not configured.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createDocsFeedbackServer, type DocsFeedbackConfig } from '../server.js';
import type { AuditedMcpServer } from '../../shared/audited-server.js';

// ============================================================================
// Helpers
// ============================================================================

interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: {
    content?: Array<{ type: string; text: string }>;
    [key: string]: unknown;
  };
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Create a temp directory tree with nested markdown files for testing.
 * Returns the root path of the created directory.
 */
function createTempDocs(structure: Record<string, string>): string {
  const root = path.join(tmpdir(), `docs-feedback-test-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });

  for (const [relativePath, content] of Object.entries(structure)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  return root;
}

function createTempDbPath(): string {
  return path.join(tmpdir(), `docs-feedback-audit-${randomUUID()}.db`);
}

function buildServer(docsPath: string, dbPath?: string): AuditedMcpServer {
  const config: DocsFeedbackConfig = {
    docsPath,
    auditSessionId: randomUUID(),
    auditPersonaName: 'test-persona',
    auditDbPath: dbPath ?? createTempDbPath(),
  };
  return createDocsFeedbackServer(config);
}

async function callTool(
  server: AuditedMcpServer,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const response = (await server.processRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  })) as JsonRpcResponse;

  const text = response.result?.content?.[0]?.text;
  if (!text) throw new Error(`No content in response for tool ${toolName}`);
  return JSON.parse(text);
}

// ============================================================================
// Tests
// ============================================================================

describe('docs-feedback MCP server', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // Missing / empty docs path
  // --------------------------------------------------------------------------

  describe('docs not configured', () => {
    it('docs_search returns a clear error when docsPath is empty', async () => {
      const server = buildServer('');
      const result = await callTool(server, 'docs_search', { query: 'authentication' });
      expect(result).toMatchObject({ error: expect.stringContaining('Docs not configured') });
    });

    it('docs_list returns a clear error when docsPath is empty', async () => {
      const server = buildServer('');
      const result = await callTool(server, 'docs_list');
      expect(result).toMatchObject({ error: expect.stringContaining('Docs not configured') });
    });

    it('docs_read returns a clear error when docsPath is empty', async () => {
      const server = buildServer('');
      const result = await callTool(server, 'docs_read', { file_path: 'readme.md' });
      expect(result).toMatchObject({ error: expect.stringContaining('Docs not configured') });
    });

    it('docs_status returns available: false when docsPath does not exist', async () => {
      const server = buildServer('/nonexistent/path/to/docs');
      const result = await callTool(server, 'docs_status') as Record<string, unknown>;
      expect(result).toMatchObject({
        available: false,
        total_files: 0,
        total_words: 0,
      });
    });

    it('docs_status returns available: false when docsPath is empty string', async () => {
      const server = buildServer('');
      const result = await callTool(server, 'docs_status') as Record<string, unknown>;
      expect(result).toMatchObject({
        available: false,
        total_files: 0,
      });
    });
  });

  // --------------------------------------------------------------------------
  // Recursive directory walk
  // --------------------------------------------------------------------------

  describe('recursive directory walk', () => {
    it('discovers markdown files in nested subdirectories', async () => {
      const docsRoot = createTempDocs({
        'index.md': '# Index\nTop level doc.',
        'api/auth.md': '# Authentication\nAPI auth docs.',
        'api/endpoints.md': '# Endpoints\nAPI endpoint docs.',
        'guides/setup.md': '# Setup Guide\nSetup instructions.',
        'guides/advanced/tips.md': '# Advanced Tips\nAdvanced usage.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_list') as {
        files: Array<{ relative_path: string; word_count: number }>;
        total_files: number;
        total_words: number;
      };

      expect(result.total_files).toBe(5);

      const paths = result.files.map(f => f.relative_path).sort();
      expect(paths).toContain('index.md');
      expect(paths).toContain(path.join('api', 'auth.md'));
      expect(paths).toContain(path.join('api', 'endpoints.md'));
      expect(paths).toContain(path.join('guides', 'setup.md'));
      expect(paths).toContain(path.join('guides', 'advanced', 'tips.md'));
    });

    it('discovers .mdx files alongside .md files', async () => {
      const docsRoot = createTempDocs({
        'page.md': '# Page\nA markdown page.',
        'component.mdx': '# Component\nAn MDX component page.',
        'nested/other.mdx': '# Other\nAnother MDX page.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_list') as { total_files: number };
      expect(result.total_files).toBe(3);
    });

    it('ignores non-markdown files', async () => {
      const docsRoot = createTempDocs({
        'readme.md': '# Readme\nDocumentation here.',
        'image.png': 'binary data',
        'style.css': 'body { color: red; }',
        'script.js': 'console.log("hi");',
        'data.json': '{"key": "value"}',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_list') as { total_files: number };
      expect(result.total_files).toBe(1);
    });

    it('handles an empty directory gracefully', async () => {
      const docsRoot = createTempDocs({});

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_list') as { total_files: number; total_words: number };
      expect(result.total_files).toBe(0);
      expect(result.total_words).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Search scoring
  // --------------------------------------------------------------------------

  describe('docs_search scoring', () => {
    it('returns results sorted by relevance score', async () => {
      const docsRoot = createTempDocs({
        'authentication.md': '# Authentication\nThis document covers authentication and auth tokens. Authentication is important.',
        'endpoints.md': '# Endpoints\nAPI endpoint list. No auth here.',
        'configuration.md': '# Configuration\nEnvironment variables and settings.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_search', { query: 'authentication' }) as {
        results: Array<{ relative_path: string; score: number; snippet: string; word_count: number }>;
        total_matches: number;
      };

      expect(result.total_matches).toBeGreaterThanOrEqual(1);
      // The file named "authentication.md" should rank first (title match 3x + content)
      expect(result.results[0].relative_path).toBe('authentication.md');
      expect(result.results[0].score).toBeGreaterThan(3);
    });

    it('filename match scores 3x higher than a single content occurrence', async () => {
      const docsRoot = createTempDocs({
        'token.md': '# Token Management\nHow to manage API tokens.',
        'other.md': '# Other\nThis doc mentions token once.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_search', { query: 'token' }) as {
        results: Array<{ relative_path: string; score: number }>;
      };

      const tokenDoc = result.results.find(r => r.relative_path === 'token.md');
      const otherDoc = result.results.find(r => r.relative_path === 'other.md');

      expect(tokenDoc).toBeDefined();
      // token.md: filename match (3) + at least 1 content match = 4+
      // other.md: 1 content match = 1
      expect(tokenDoc!.score).toBeGreaterThan(otherDoc!.score);
    });

    it('respects max_results limit', async () => {
      const docsRoot = createTempDocs({
        'doc1.md': '# Doc 1\nThe word guide appears here.',
        'doc2.md': '# Doc 2\nAnother guide document.',
        'doc3.md': '# Doc 3\nYet another guide for reference.',
        'doc4.md': '# Doc 4\nA guide to everything.',
        'doc5.md': '# Doc 5\nThe definitive guide.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_search', { query: 'guide', max_results: 2 }) as {
        results: unknown[];
        total_matches: number;
      };

      expect(result.results).toHaveLength(2);
      expect(result.total_matches).toBeGreaterThanOrEqual(2);
    });

    it('returns empty results for a query with no matches', async () => {
      const docsRoot = createTempDocs({
        'readme.md': '# Readme\nBasic documentation.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_search', { query: 'xyzzy-no-match-9999' }) as {
        results: unknown[];
        total_matches: number;
      };

      expect(result.results).toHaveLength(0);
      expect(result.total_matches).toBe(0);
    });

    it('includes a snippet from each matching result', async () => {
      const docsRoot = createTempDocs({
        'guide.md': '# Guide\nThis is a comprehensive guide to configuration and setup.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_search', { query: 'configuration' }) as {
        results: Array<{ snippet: string }>;
      };

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].snippet).toContain('configuration');
    });

    it('searches nested files with relative_path in results', async () => {
      const docsRoot = createTempDocs({
        'api/auth.md': '# Authentication\nBearer token authentication.',
        'getting-started.md': '# Getting Started\nBasic setup.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_search', { query: 'authentication' }) as {
        results: Array<{ relative_path: string }>;
      };

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results[0].relative_path).toContain('auth');
    });
  });

  // --------------------------------------------------------------------------
  // docs_read
  // --------------------------------------------------------------------------

  describe('docs_read', () => {
    it('returns full content of an existing file', async () => {
      const content = '# My Doc\n\nThis is the full content of the document.\n\nIt has multiple paragraphs.';
      const docsRoot = createTempDocs({
        'my-doc.md': content,
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_read', { file_path: 'my-doc.md' }) as {
        relative_path: string;
        content: string;
        word_count: number;
      };

      expect(result.relative_path).toBe('my-doc.md');
      expect(result.content).toBe(content);
      expect(result.word_count).toBeGreaterThan(0);
    });

    it('reads nested files using relative path', async () => {
      const docsRoot = createTempDocs({
        'api/endpoints.md': '# Endpoints\nGET /api/data returns data.',
      });

      const server = buildServer(docsRoot);
      const nestedPath = path.join('api', 'endpoints.md');
      const result = await callTool(server, 'docs_read', { file_path: nestedPath }) as {
        relative_path: string;
        content: string;
      };

      expect(result.relative_path).toBe(nestedPath);
      expect(result.content).toContain('Endpoints');
    });

    it('returns an error with hint when file does not exist', async () => {
      const docsRoot = createTempDocs({
        'existing.md': '# Existing\nThis file exists.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_read', { file_path: 'nonexistent.md' }) as {
        error: string;
        hint: string;
      };

      expect(result.error).toContain('nonexistent.md');
      expect(result.hint).toContain('docs_list');
    });
  });

  // --------------------------------------------------------------------------
  // docs_list
  // --------------------------------------------------------------------------

  describe('docs_list', () => {
    it('returns all files with correct word counts', async () => {
      const docsRoot = createTempDocs({
        'short.md': '# Short\nFour words here.',
        'long.md': '# Long Doc\n\nThis document has many more words than the short one does.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_list') as {
        files: Array<{ relative_path: string; word_count: number }>;
        total_files: number;
        total_words: number;
      };

      expect(result.total_files).toBe(2);
      expect(result.total_words).toBeGreaterThan(0);

      const shortFile = result.files.find(f => f.relative_path === 'short.md');
      const longFile = result.files.find(f => f.relative_path === 'long.md');

      expect(shortFile).toBeDefined();
      expect(longFile).toBeDefined();
      expect(longFile!.word_count).toBeGreaterThan(shortFile!.word_count);
    });

    it('total_words equals sum of individual word counts', async () => {
      const docsRoot = createTempDocs({
        'a.md': '# A\nOne two three.',
        'b.md': '# B\nFour five six seven.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_list') as {
        files: Array<{ word_count: number }>;
        total_words: number;
      };

      const summedWords = result.files.reduce((acc, f) => acc + f.word_count, 0);
      expect(result.total_words).toBe(summedWords);
    });
  });

  // --------------------------------------------------------------------------
  // docs_status
  // --------------------------------------------------------------------------

  describe('docs_status', () => {
    it('returns available: true with correct counts when docs are present', async () => {
      const docsRoot = createTempDocs({
        'doc1.md': '# Doc 1\nContent here.',
        'sub/doc2.md': '# Doc 2\nMore content.',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_status') as {
        available: boolean;
        docs_path: string;
        total_files: number;
        total_words: number;
      };

      expect(result.available).toBe(true);
      expect(result.docs_path).toBe(docsRoot);
      expect(result.total_files).toBe(2);
      expect(result.total_words).toBeGreaterThan(0);
    });

    it('returns available: false when directory exists but contains no markdown', async () => {
      const docsRoot = createTempDocs({
        'data.json': '{"key": "value"}',
        'image.png': 'binary',
      });

      const server = buildServer(docsRoot);
      const result = await callTool(server, 'docs_status') as {
        available: boolean;
        total_files: number;
      };

      expect(result.available).toBe(false);
      expect(result.total_files).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Tool registration
  // --------------------------------------------------------------------------

  describe('tool registration', () => {
    it('lists all four tools via tools/list', async () => {
      const server = buildServer('');
      const response = (await server.processRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      })) as JsonRpcResponse;

      const tools = (response.result as { tools: Array<{ name: string }> }).tools;
      const names = tools.map(t => t.name);

      expect(names).toContain('docs_search');
      expect(names).toContain('docs_list');
      expect(names).toContain('docs_read');
      expect(names).toContain('docs_status');
    });
  });
});
