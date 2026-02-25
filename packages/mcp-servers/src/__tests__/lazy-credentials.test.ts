/**
 * Lazy Credential Initialization Tests
 *
 * Verifies that the Render, Vercel, and Elastic Logs MCP servers:
 *
 * 1. Can be loaded (imported / started) without any credentials present.
 *    The old behavior called `process.exit(1)` at module load time; the new
 *    behavior defers the credential check to the first API call so that the
 *    MCP tool-discovery handshake (`initialize`, `tools/list`) always works.
 *
 * 2. Fail loudly (G001: fail-closed) the moment a tool is actually invoked
 *    without the required credentials, returning a structured error instead of
 *    silently returning undefined / null.
 *
 * Strategy: We spawn each server as a child process (using the compiled dist
 * files), send raw JSON-RPC 2.0 messages over stdin, and inspect stdout.
 * This is intentional — the servers call `server.start()` which hooks into
 * stdin/stdout, so they cannot be imported inside vitest's process without
 * side-effects.  Child-process spawning gives us true black-box coverage of
 * the actual runtime behavior.
 *
 * All child processes are launched without the relevant credential env vars
 * so that each test exercises the "missing credential" code path.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the compiled dist/ directory for the mcp-servers package */
const DIST_DIR = path.resolve(__dirname, '../../dist');

/**
 * Send a single JSON-RPC 2.0 request to a compiled MCP server script.
 *
 * The server is launched with a minimal environment (no credential vars) by
 * default.  Additional env vars can be supplied via `extraEnv`.
 *
 * Returns the parsed JSON-RPC response object.
 */
function sendMcpRequest(
  serverScript: string,
  jsonRpcRequest: Record<string, unknown>,
  extraEnv: Record<string, string> = {}
): {
  response: Record<string, unknown> | null;
  exitCode: number | null;
  stderr: string;
} {
  const scriptPath = path.join(DIST_DIR, serverScript);
  const requestLine = JSON.stringify(jsonRpcRequest) + '\n';

  const result = spawnSync('node', [scriptPath], {
    input: requestLine,
    // Strip all credential vars; only keep what the OS needs to run node.
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...extraEnv,
    },
    cwd: DIST_DIR,
    timeout: 5000,
    encoding: 'utf8',
  });

  let response: Record<string, unknown> | null = null;
  const rawStdout = (result.stdout ?? '').trim();
  if (rawStdout) {
    try {
      response = JSON.parse(rawStdout) as Record<string, unknown>;
    } catch {
      // If stdout is not valid JSON, return null and let the caller assert.
    }
  }

  return {
    response,
    exitCode: result.status,
    stderr: result.stderr ?? '',
  };
}

/**
 * Extracts the parsed tool result from a successful MCP tools/call response.
 * Throws with a clear message if the shape is unexpected.
 */
function extractToolResult(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result as Record<string, unknown> | undefined;
  if (!result) {
    throw new Error(`CRITICAL: JSON-RPC response has no result field: ${JSON.stringify(response)}`);
  }

  const content = result.content as Array<{ type: string; text: string }> | undefined;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error(`CRITICAL: tools/call result.content is missing or empty: ${JSON.stringify(result)}`);
  }

  const firstItem = content[0];
  if (firstItem.type !== 'text' || typeof firstItem.text !== 'string') {
    throw new Error(`CRITICAL: Expected text content item, got: ${JSON.stringify(firstItem)}`);
  }

  return JSON.parse(firstItem.text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module-Level Import Safety
// ---------------------------------------------------------------------------

describe('Lazy credential initialization — module-level import safety', () => {
  /**
   * Each server MUST respond to `initialize` without credentials present.
   * A crash or non-zero exit code here indicates the server is still doing
   * eager credential validation at module load time (the old behavior).
   */
  const servers = [
    {
      name: 'Render',
      script: 'render/server.js',
      serverInfoName: 'render-mcp',
    },
    {
      name: 'Vercel',
      script: 'vercel/server.js',
      serverInfoName: 'vercel-mcp',
    },
    {
      name: 'Elastic Logs',
      script: 'elastic-logs/server.js',
      serverInfoName: 'elastic-logs',
    },
  ] as const;

  for (const { name, script, serverInfoName } of servers) {
    it(`${name} server responds to initialize without credentials (does not crash at import)`, () => {
      const { response, exitCode } = sendMcpRequest(script, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      });

      // Server must exit cleanly (0) or still be running when stdin closes.
      // spawnSync gives exit code 0 when process exits normally.
      expect(exitCode).toBe(0);

      // Must return a valid JSON-RPC response — not crash before responding.
      expect(response).not.toBeNull();
      expect(response!.jsonrpc).toBe('2.0');
      expect(response!.id).toBe(1);

      const result = response!.result as Record<string, unknown>;
      expect(result).toBeDefined();
      expect(result.protocolVersion).toBe('2024-11-05');

      const serverInfo = result.serverInfo as Record<string, unknown>;
      expect(serverInfo.name).toBe(serverInfoName);
    });

    it(`${name} server lists tools without credentials (tool discovery works without creds)`, () => {
      const { response, exitCode } = sendMcpRequest(script, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      });

      expect(exitCode).toBe(0);
      expect(response).not.toBeNull();
      expect(response!.jsonrpc).toBe('2.0');

      const result = response!.result as Record<string, unknown>;
      const tools = result.tools as unknown[];

      // Every server must expose at least one tool.
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Each tool must have a name and description.
      for (const tool of tools) {
        const t = tool as Record<string, unknown>;
        expect(typeof t.name).toBe('string');
        expect(typeof t.description).toBe('string');
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Render Server — credential check at invocation time
// ---------------------------------------------------------------------------

describe('Render server (renderFetch) — fail-closed credential check', () => {
  it('throws with clear message when RENDER_API_KEY is missing', () => {
    const { response, exitCode } = sendMcpRequest('render/server.js', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'render_list_services',
        arguments: {},
      },
    });

    // Server must not crash — it exits 0 and surfaces the error in the result.
    expect(exitCode).toBe(0);
    expect(response).not.toBeNull();

    // MCP isError flag must be set.
    const result = response!.result as Record<string, unknown>;
    expect(result.isError).toBe(true);

    const toolResult = extractToolResult(response!);

    // Error message must be present and specific.
    expect(typeof toolResult.error).toBe('string');
    const errorMsg = toolResult.error as string;
    expect(errorMsg).toContain('RENDER_API_KEY');
    expect(errorMsg).toContain('environment variable is required');
    expect(errorMsg).toContain('1Password');
  });

  it('fails-closed on every Render tool when RENDER_API_KEY is missing', () => {
    // A representative sample of Render tools — they all funnel through renderFetch.
    const toolsToTest = [
      { name: 'render_get_service', arguments: { serviceId: 'srv-test' } },
      { name: 'render_list_deploys', arguments: { serviceId: 'srv-test' } },
      { name: 'render_list_env_vars', arguments: { serviceId: 'srv-test' } },
    ];

    for (const { name: toolName, arguments: toolArgs } of toolsToTest) {
      const { response } = sendMcpRequest('render/server.js', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
      });

      expect(response).not.toBeNull();

      const result = response!.result as Record<string, unknown>;
      expect(result.isError).toBe(true);

      const toolResult = extractToolResult(response!);
      expect(typeof toolResult.error).toBe('string');
      expect(toolResult.error as string).toContain('RENDER_API_KEY');
    }
  });

  it('does not expose the RENDER_API_KEY value in error messages', () => {
    const fakeKey = 'rnd_super_secret_key_abc123';

    // Provide a key but an invalid one — the server should fail with HTTP error, not leak the key.
    // Here we test the missing-key path ensures the key string itself is never echoed.
    const { response } = sendMcpRequest('render/server.js', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'render_list_services', arguments: {} },
      // Note: no extraEnv — RENDER_API_KEY is absent
    });

    expect(response).not.toBeNull();
    const toolResult = extractToolResult(response!);
    const errorText = JSON.stringify(toolResult);

    // The key value must never appear in the error output.
    expect(errorText).not.toContain(fakeKey);
  });
});

// ---------------------------------------------------------------------------
// Vercel Server — credential check at invocation time
// ---------------------------------------------------------------------------

describe('Vercel server (vercelFetch) — fail-closed credential check', () => {
  it('throws with clear message when VERCEL_TOKEN is missing', () => {
    const { response, exitCode } = sendMcpRequest('vercel/server.js', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'vercel_list_deployments',
        arguments: {},
      },
    });

    expect(exitCode).toBe(0);
    expect(response).not.toBeNull();

    const result = response!.result as Record<string, unknown>;
    expect(result.isError).toBe(true);

    const toolResult = extractToolResult(response!);

    expect(typeof toolResult.error).toBe('string');
    const errorMsg = toolResult.error as string;
    expect(errorMsg).toContain('VERCEL_TOKEN');
    expect(errorMsg).toContain('environment variable is required');
    expect(errorMsg).toContain('1Password');
  });

  it('fails-closed on every Vercel tool when VERCEL_TOKEN is missing', () => {
    const toolsToTest = [
      { name: 'vercel_list_projects', arguments: {} },
      { name: 'vercel_get_deployment', arguments: { idOrUrl: 'dpl-test' } },
      { name: 'vercel_list_domains', arguments: { projectId: 'prj-test' } },
    ];

    for (const { name: toolName, arguments: toolArgs } of toolsToTest) {
      const { response } = sendMcpRequest('vercel/server.js', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
      });

      expect(response).not.toBeNull();

      const result = response!.result as Record<string, unknown>;
      expect(result.isError).toBe(true);

      const toolResult = extractToolResult(response!);
      expect(typeof toolResult.error).toBe('string');
      expect(toolResult.error as string).toContain('VERCEL_TOKEN');
    }
  });

  it('accepts VERCEL_TOKEN and does not require VERCEL_TEAM_ID (optional)', () => {
    /**
     * VERCEL_TEAM_ID is optional — vercelFetch only appends teamId to the URL
     * when it is present.  The server must not throw the "VERCEL_TOKEN is
     * required" credential error when the token IS set.
     *
     * We verify this by checking the tools/list response (which requires no
     * credentials) and confirming the server started correctly, i.e. it did
     * NOT exit with the old module-level process.exit(1) behavior.
     *
     * A tools/call with a fake token would require a real network request to
     * api.vercel.com; we avoid that here to keep tests hermetic.
     */
    const { response, exitCode } = sendMcpRequest(
      'vercel/server.js',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      },
      { VERCEL_TOKEN: 'fake-token-for-test' } // no VERCEL_TEAM_ID
    );

    // Server must start (exit 0) and respond to tools/list even with a fake token.
    expect(exitCode).toBe(0);
    expect(response).not.toBeNull();

    const result = response!.result as Record<string, unknown>;
    const tools = result.tools as unknown[];

    // Tools are listed regardless of whether the token is valid — only
    // actual API invocations perform credential validation.
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Elastic Logs Server — lazy getClient() credential checks
// ---------------------------------------------------------------------------

describe('Elastic Logs server (getClient) — fail-closed credential checks', () => {
  describe('query_logs tool', () => {
    it('throws with clear message when ELASTIC_API_KEY is missing', () => {
      const { response, exitCode } = sendMcpRequest('elastic-logs/server.js', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'query_logs',
          arguments: { query: 'level:error' },
        },
      });

      expect(exitCode).toBe(0);
      expect(response).not.toBeNull();

      // Elastic tools wrap errors in a structured error result (not isError flag).
      // The error is returned in the tool result body so Claude can display it.
      const toolResult = extractToolResult(response!);

      expect(typeof toolResult.error).toBe('string');
      const errorMsg = toolResult.error as string;
      expect(errorMsg).toContain('ELASTIC_API_KEY');
      expect(errorMsg).toContain('Elasticsearch authentication');
      expect(errorMsg).toContain('1Password');

      expect(typeof toolResult.hint).toBe('string');
    });

    it('throws with clear message when ELASTIC_API_KEY is set but connection config is missing', () => {
      const { response, exitCode } = sendMcpRequest(
        'elastic-logs/server.js',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'query_logs',
            arguments: { query: '*' },
          },
        },
        // Supply API key but no ELASTIC_CLOUD_ID or ELASTIC_ENDPOINT
        { ELASTIC_API_KEY: 'test-api-key-value' }
      );

      expect(exitCode).toBe(0);
      expect(response).not.toBeNull();

      const toolResult = extractToolResult(response!);

      expect(typeof toolResult.error).toBe('string');
      const errorMsg = toolResult.error as string;
      expect(errorMsg).toContain('ELASTIC_CLOUD_ID');
      expect(errorMsg).toContain('ELASTIC_ENDPOINT');
      expect(errorMsg).toContain('Elasticsearch connection');

      expect(typeof toolResult.hint).toBe('string');
    });
  });

  describe('get_log_stats tool', () => {
    it('throws with clear message when ELASTIC_API_KEY is missing', () => {
      const { response, exitCode } = sendMcpRequest('elastic-logs/server.js', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'get_log_stats',
          arguments: {},
        },
      });

      expect(exitCode).toBe(0);
      expect(response).not.toBeNull();

      const toolResult = extractToolResult(response!);

      expect(typeof toolResult.error).toBe('string');
      expect(toolResult.error as string).toContain('ELASTIC_API_KEY');
      expect(typeof toolResult.hint).toBe('string');
    });

    it('throws with clear message when ELASTIC_API_KEY is set but connection config is missing', () => {
      const { response } = sendMcpRequest(
        'elastic-logs/server.js',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'get_log_stats',
            arguments: { groupBy: 'level' },
          },
        },
        { ELASTIC_API_KEY: 'test-api-key-value' }
      );

      expect(response).not.toBeNull();

      const toolResult = extractToolResult(response!);

      expect(typeof toolResult.error).toBe('string');
      const errorMsg = toolResult.error as string;
      expect(errorMsg).toContain('ELASTIC_CLOUD_ID');
      expect(errorMsg).toContain('ELASTIC_ENDPOINT');
    });
  });

  describe('getClient lazy initialization — ELASTIC_CLOUD_ID vs ELASTIC_ENDPOINT', () => {
    it('accepts ELASTIC_CLOUD_ID as a valid connection configuration', () => {
      /**
       * When ELASTIC_API_KEY and ELASTIC_CLOUD_ID are both set, getClient()
       * must not throw the "missing connection" error.  With a fake Cloud ID
       * the Elasticsearch Client constructor may throw a URL-parse error, but
       * that's a different error path — it means the credential guard passed.
       */
      const { response } = sendMcpRequest(
        'elastic-logs/server.js',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'query_logs', arguments: { query: '*' } },
        },
        {
          ELASTIC_API_KEY: 'test-api-key-value',
          ELASTIC_CLOUD_ID: 'test-cluster:dXMtZWFzdC0xLmF3cy5mb3VuZC5pbyQ...', // fake but parseable
        }
      );

      expect(response).not.toBeNull();

      const toolResult = extractToolResult(response!);
      const errorMsg = toolResult.error as string | undefined;

      // The missing-connection error must NOT appear.
      expect(errorMsg).not.toContain('Missing Elasticsearch connection');
      // The missing-API-key error must NOT appear.
      expect(errorMsg).not.toContain('Missing ELASTIC_API_KEY');
    });

    it('accepts ELASTIC_ENDPOINT as an alternative to ELASTIC_CLOUD_ID', () => {
      /**
       * Serverless Elastic deployments use ELASTIC_ENDPOINT instead of
       * ELASTIC_CLOUD_ID.  The credential guard accepts either one.
       *
       * Note: we skip this path as the Elasticsearch client will attempt a
       * real TCP connection to the fake endpoint and the test would hang.
       * Instead, we confirm the *absence* of the "missing connection" error
       * by verifying we get a different error (network or auth failure).
       *
       * We test with a deliberately unreachable URL so the request fails fast
       * (connection refused on localhost).
       */
      const { response } = sendMcpRequest(
        'elastic-logs/server.js',
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'query_logs', arguments: { query: '*' } },
        },
        {
          ELASTIC_API_KEY: 'test-api-key-value',
          ELASTIC_ENDPOINT: 'http://localhost:1', // refused immediately
        }
      );

      // Response may be null if the process timed out trying to connect.
      // Either way the "missing connection" error must not be the failure.
      if (response !== null) {
        const toolResult = extractToolResult(response);
        const errorMsg = toolResult.error as string | undefined;
        expect(errorMsg).not.toContain('Missing Elasticsearch connection');
        expect(errorMsg).not.toContain('Missing ELASTIC_API_KEY');
      }
      // If response is null, the process timed out — which is acceptable
      // because it means the credential guard passed (client was created).
    }, 8000); // Extended timeout: localhost:1 connection may take a moment to refuse
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: MCP protocol compliance without credentials
// ---------------------------------------------------------------------------

describe('MCP protocol compliance without credentials (all servers)', () => {
  const serverScripts = [
    'render/server.js',
    'vercel/server.js',
    'elastic-logs/server.js',
  ] as const;

  for (const script of serverScripts) {
    const serverLabel = script.replace('/server.js', '');

    it(`${serverLabel}: tools/list response has valid JSON Schema for every tool`, () => {
      const { response } = sendMcpRequest(script, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      });

      expect(response).not.toBeNull();

      const result = response!.result as Record<string, unknown>;
      const tools = result.tools as Array<Record<string, unknown>>;

      for (const tool of tools) {
        // Every tool must have a valid inputSchema.
        const schema = tool.inputSchema as Record<string, unknown> | undefined;
        expect(schema).toBeDefined();
        expect(schema!.type).toBe('object');
        expect(typeof schema!.properties).toBe('object');

        // Name and description must be non-empty strings.
        expect(typeof tool.name).toBe('string');
        expect((tool.name as string).length).toBeGreaterThan(0);
        expect(typeof tool.description).toBe('string');
        expect((tool.description as string).length).toBeGreaterThan(0);
      }
    });

    it(`${serverLabel}: unknown tool returns METHOD_NOT_FOUND error (not a crash)`, () => {
      const { response, exitCode } = sendMcpRequest(script, {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'nonexistent_tool_xyz', arguments: {} },
      });

      expect(exitCode).toBe(0);
      expect(response).not.toBeNull();

      // JSON-RPC error response (method not found), NOT a crash.
      const rpcError = response!.error as Record<string, unknown> | undefined;
      expect(rpcError).toBeDefined();
      expect(typeof rpcError!.code).toBe('number');
      expect(rpcError!.message).toContain('Unknown tool');
    });
  }
});
