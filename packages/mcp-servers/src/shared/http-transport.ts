/**
 * Shared HTTP transport for hosting multiple MCP servers on a single port.
 *
 * Uses MCP Streamable HTTP protocol: JSON-RPC 2.0 over HTTP POST with
 * session management via Mcp-Session-Id header.
 *
 * Binds to 127.0.0.1 only — no network exposure.
 *
 * @version 1.0.0
 */

import * as http from 'http';
import * as crypto from 'crypto';
import type { McpServer } from './server.js';
import { JSON_RPC_ERRORS } from './types.js';

export interface SharedHttpServerOptions {
  port: number;
  host?: string;
  servers: Map<string, McpServer>;
  isReady?: () => boolean;
  /** Optional pre-handler. Return true if the request was handled (short-circuits MCP routing). */
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;
}

export interface SharedHttpServer {
  httpServer: http.Server;
  close: () => Promise<void>;
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB — tool calls are small JSON-RPC payloads

/**
 * Read the full body of an incoming HTTP request.
 * Aborts with an error if the body exceeds MAX_BODY_SIZE.
 */
async function readBody(req: http.IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_SIZE) {
      throw new Error('Request body too large');
    }
  }
  return body;
}

/**
 * Write a JSON response.
 */
function writeJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Write a JSON-RPC error response (always 200 per JSON-RPC spec).
 */
function writeJsonRpcError(
  res: http.ServerResponse,
  id: string | number | null,
  code: number,
  message: string,
): void {
  writeJson(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

/**
 * Start a shared HTTP server that routes to multiple McpServer instances.
 *
 * Routes:
 *   GET  /health                → { status: 'ok', servers: [...], uptime: N }
 *   POST /mcp/{server-name}     → route to server.processRequest(body)
 *   DELETE /mcp/{server-name}   → session termination (200 OK)
 *   GET  /mcp/{server-name}     → 405 (SSE not supported)
 *   *                           → 404
 */
export function startSharedHttpServer(options: SharedHttpServerOptions): SharedHttpServer {
  const { port, host = '127.0.0.1', servers } = options;

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // No CORS headers — this server is consumed by Claude Code (not a browser).
    // Omitting Access-Control-Allow-Origin prevents browser-based exfiltration
    // of sensitive tool responses (1Password secrets, GitHub tokens, etc.).

    // Pre-handler hook (daemon-level routes like /secrets/resolve)
    if (options.onRequest) {
      try {
        const handled = await options.onRequest(req, res);
        if (handled) return;
      } catch { /* non-fatal — fall through to normal routing */ }
    }

    // Health check
    if (url === '/health' && method === 'GET') {
      const ready = options.isReady?.() ?? true;
      writeJson(res, 200, {
        status: ready ? 'ok' : 'starting',
        servers: [...servers.keys()],
        uptime: process.uptime(),
      });
      return;
    }

    // MCP route: /mcp/{server-name}
    const mcpMatch = url.match(/^\/mcp\/([^/?#]+)/);
    if (!mcpMatch) {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }

    const serverName = mcpMatch[1];
    const server = servers.get(serverName);

    if (!server) {
      writeJson(res, 404, { error: `Unknown server: ${serverName}` });
      return;
    }

    // Session termination (DELETE)
    if (method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }

    // SSE endpoint not supported
    if (method === 'GET') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end('Method Not Allowed');
      return;
    }

    // Only POST from here
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE, GET' });
      res.end('Method Not Allowed');
      return;
    }

    // Parse request body
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp-daemon:${serverName}] Body read error: ${message}\n`);
      writeJsonRpcError(res, null, JSON_RPC_ERRORS.INTERNAL_ERROR, 'Failed to read request body');
      return;
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      writeJsonRpcError(res, null, JSON_RPC_ERRORS.PARSE_ERROR, 'Parse error');
      return;
    }

    // Process request via the McpServer
    let response: Awaited<ReturnType<McpServer['processRequest']>>;
    try {
      response = await server.processRequest(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp-daemon:${serverName}] processRequest error: ${message}\n`);
      const partial = parsed as { id?: unknown } | null;
      const id = partial && typeof partial.id !== 'undefined'
        ? (partial.id as string | number | null)
        : null;
      writeJsonRpcError(res, id, JSON_RPC_ERRORS.INTERNAL_ERROR, message);
      return;
    }

    // null response = notification (no reply needed per JSON-RPC spec)
    if (response === null) {
      res.writeHead(204);
      res.end();
      return;
    }

    // For initialize requests, generate and attach a session ID
    const isInitialize =
      parsed !== null &&
      typeof parsed === 'object' &&
      'method' in (parsed as object) &&
      (parsed as { method: string }).method === 'initialize';

    if (isInitialize) {
      res.setHeader('Mcp-Session-Id', crypto.randomUUID());
    }

    writeJson(res, 200, response);
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(
      `[mcp-daemon] HTTP server listening on ${host}:${port} (${servers.size} servers)\n`,
    );
  });

  httpServer.on('error', (err) => {
    process.stderr.write(`[mcp-daemon] HTTP server error: ${err.message}\n`);
    throw err;
  });

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      httpServer.close((err) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });

  return { httpServer, close };
}
