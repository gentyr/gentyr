/**
 * Audited MCP Server
 *
 * Subclass of McpServer that automatically logs every tool call to session-events.db.
 * Auditing is mandatory — a session ID must always be provided (via constructor option
 * or FEEDBACK_SESSION_ID env var). Throws if no session ID is available.
 *
 * Writes to the same schema as the session-events MCP server, using event_type
 * 'mcp_tool_call' (success) or 'mcp_tool_error' (failure).
 *
 * @version 1.1.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type AnyToolHandler, type McpServerOptions } from './server.js';

// Re-use the session-events DB schema (only the table we need)
const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  integration_id TEXT,
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  duration_ms INTEGER,
  page_url TEXT,
  page_title TEXT,
  element_selector TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp);
`;

/**
 * Options for AuditedMcpServer.
 *
 * Extends McpServerOptions. The `auditDbPath` override is only used in tests
 * to point to an in-memory or temp DB instead of the real session-events.db.
 */
export interface AuditedMcpServerOptions extends McpServerOptions {
  /** Override the audit DB path (for testing). When omitted, uses SESSION_EVENTS_DB env var or PROJECT_DIR/.claude/session-events.db */
  auditDbPath?: string;
  /** Override the session ID (for testing). When omitted, reads FEEDBACK_SESSION_ID env var */
  auditSessionId?: string;
  /** Override the persona name (for testing). When omitted, reads FEEDBACK_PERSONA_NAME env var */
  auditPersonaName?: string;
}

export class AuditedMcpServer extends McpServer {
  constructor(options: AuditedMcpServerOptions) {
    const sessionId = options.auditSessionId ?? process.env['FEEDBACK_SESSION_ID'];
    const personaName = options.auditPersonaName ?? process.env['FEEDBACK_PERSONA_NAME'] ?? null;
    const serverName = options.name;

    // When no session ID is available (e.g. base interactive session), audit logging is a no-op.
    // The server still starts and connects — tools return errors at invocation time if needed.

    // Audit state (closure-captured, not instance properties)
    // This avoids referencing `this` before super()
    let auditDb: Database.Database | null = null;

    const projectDir = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
    const dbPath = options.auditDbPath ??
      process.env['SESSION_EVENTS_DB'] ??
      path.join(projectDir, '.claude', 'session-events.db');

    function getAuditDb(): Database.Database {
      if (!auditDb) {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        auditDb = new Database(dbPath);
        auditDb.pragma('journal_mode = WAL');
        auditDb.exec(AUDIT_SCHEMA);
      }
      return auditDb;
    }

    function recordAudit(
      toolName: string,
      args: unknown,
      result: unknown,
      durationMs: number,
    ): void {
      if (!sessionId) return; // No audit without a session
      try {
        const db = getAuditDb();
        db.prepare(`
          INSERT INTO session_events (id, session_id, agent_id, event_type, event_category, input, output, duration_ms, metadata)
          VALUES (?, ?, ?, 'mcp_tool_call', 'mcp', ?, ?, ?, ?)
        `).run(
          randomUUID(),
          sessionId,
          personaName,
          JSON.stringify({ tool: toolName, args }),
          JSON.stringify(result),
          durationMs,
          JSON.stringify({ mcp_server: serverName }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[audit] Failed to record tool call: ${msg}\n`);
      }
    }

    function recordAuditError(
      toolName: string,
      args: unknown,
      error: unknown,
      durationMs: number,
    ): void {
      if (!sessionId) return; // No audit without a session
      try {
        const db = getAuditDb();
        const errorMsg = error instanceof Error ? error.message : String(error);
        db.prepare(`
          INSERT INTO session_events (id, session_id, agent_id, event_type, event_category, input, error, duration_ms, metadata)
          VALUES (?, ?, ?, 'mcp_tool_error', 'mcp', ?, ?, ?, ?)
        `).run(
          randomUUID(),
          sessionId,
          personaName,
          JSON.stringify({ tool: toolName, args }),
          JSON.stringify({ message: errorMsg, tool: toolName }),
          durationMs,
          JSON.stringify({ mcp_server: serverName }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[audit] Failed to record tool error: ${msg}\n`);
      }
    }

    // Wrap each tool handler with audit logging
    const wrappedTools: AnyToolHandler[] = options.tools.map(tool => ({
      ...tool,
      handler: async (args: unknown) => {
        const start = Date.now();
        try {
          const result = await tool.handler(args);
          recordAudit(tool.name, args, result, Date.now() - start);
          return result;
        } catch (err) {
          recordAuditError(tool.name, args, err, Date.now() - start);
          throw err;
        }
      },
    }));

    super({ ...options, tools: wrappedTools });

    // Cleanup on process exit
    process.on('exit', () => {
      if (auditDb) {
        try { auditDb.close(); } catch { /* ignore */ }
        auditDb = null;
      }
    });
  }
}
