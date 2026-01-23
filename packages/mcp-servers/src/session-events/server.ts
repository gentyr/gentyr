#!/usr/bin/env node
/**
 * Session Events MCP Server
 *
 * Provides tools for viewing and searching session events.
 * Enables offline work by allowing agents to analyze recorded sessions.
 *
 * @version 2.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { McpServer, type ToolHandler } from '../shared/server.js';
import {
  ListEventsArgsSchema,
  GetEventArgsSchema,
  ExpandEventsArgsSchema,
  SearchEventsArgsSchema,
  TimelineArgsSchema,
  RecordEventArgsSchema,
  EVENT_CATEGORIES,
  type ListEventsArgs,
  type GetEventArgs,
  type ExpandEventsArgs,
  type SearchEventsArgs,
  type TimelineArgs,
  type RecordEventArgs,
  type ListEventsResult,
  type ExpandedEvent,
  type SearchEventsResult,
  type TimelineResult,
  type TimelineEvent,
  type TimelineSummary,
  type RecordEventResult,
  type EventRecord,
  type EventListItem,
  type ErrorResult,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const DB_PATH = process.env.SESSION_EVENTS_DB ||
  path.join(PROJECT_DIR, '.claude', 'session-events.db');

// ============================================================================
// Database Schema
// ============================================================================

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS idx_session_events_integration ON session_events(integration_id);
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);
CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(timestamp);
`;

// ============================================================================
// Database Management
// ============================================================================

let _db: Database.Database | null = null;

function initDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

function getDb(): Database.Database {
  if (!_db) {
    _db = initDb();
  }
  return _db;
}

function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Safely parse JSON with a fallback value.
 * Prevents crashes from malformed JSON in database fields.
 */
function safeParse(json: string | null, fallback: any = {}): any {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// ============================================================================
// Tool Implementations
// ============================================================================

function listEvents(args: ListEventsArgs): ListEventsResult {
  const db = getDb();
  let query = 'SELECT id, session_id, agent_id, integration_id, event_type, event_category, duration_ms, page_url, timestamp FROM session_events WHERE 1=1';
  const queryParams: unknown[] = [];

  if (args.sessionId) {
    query += ' AND session_id = ?';
    queryParams.push(args.sessionId);
  }

  if (args.integrationId) {
    query += ' AND integration_id = ?';
    queryParams.push(args.integrationId);
  }

  if (args.eventTypes && args.eventTypes.length > 0) {
    query += ` AND event_type IN (${args.eventTypes.map(() => '?').join(',')})`;
    queryParams.push(...args.eventTypes);
  }

  if (args.timeRange?.start) {
    query += ' AND timestamp >= ?';
    queryParams.push(args.timeRange.start);
  }

  if (args.timeRange?.end) {
    query += ' AND timestamp <= ?';
    queryParams.push(args.timeRange.end);
  }

  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  queryParams.push(limit, offset);

  const events = db.prepare(query).all(...queryParams) as EventListItem[];

  return {
    events,
    count: events.length,
    hasMore: events.length === limit,
  };
}

function getEvent(args: GetEventArgs): ExpandedEvent | ErrorResult {
  const db = getDb();
  const event = db.prepare('SELECT * FROM session_events WHERE id = ?').get(args.eventId) as EventRecord | undefined;

  if (!event) {
    return { error: 'Event not found' };
  }

  return {
    id: event.id,
    session_id: event.session_id,
    agent_id: event.agent_id,
    integration_id: event.integration_id,
    event_type: event.event_type,
    event_category: event.event_category,
    input: safeParse(event.input, {}),
    output: safeParse(event.output, null),
    error: safeParse(event.error, null),
    duration_ms: event.duration_ms,
    page_url: event.page_url,
    page_title: event.page_title,
    element_selector: event.element_selector,
    timestamp: event.timestamp,
    metadata: safeParse(event.metadata, {}),
  };
}

function expandEvents(args: ExpandEventsArgs): ExpandedEvent[] {
  const db = getDb();
  const placeholders = args.eventIds.map(() => '?').join(',');
  const events = db.prepare(`SELECT * FROM session_events WHERE id IN (${placeholders})`).all(...args.eventIds) as EventRecord[];

  return events.map(event => ({
    id: event.id,
    session_id: event.session_id,
    agent_id: event.agent_id,
    integration_id: event.integration_id,
    event_type: event.event_type,
    event_category: event.event_category,
    input: safeParse(event.input, {}),
    output: safeParse(event.output, null),
    error: safeParse(event.error, null),
    duration_ms: event.duration_ms,
    page_url: event.page_url,
    page_title: event.page_title,
    element_selector: event.element_selector,
    timestamp: event.timestamp,
    metadata: safeParse(event.metadata, {}),
  }));
}

function searchEvents(args: SearchEventsArgs): SearchEventsResult {
  const db = getDb();
  let query = `
    SELECT id, session_id, agent_id, integration_id, event_type, event_category, duration_ms, page_url, timestamp
    FROM session_events
    WHERE (input LIKE ? OR output LIKE ? OR page_url LIKE ?)
  `;
  const searchTerm = `%${args.query}%`;
  const queryParams: unknown[] = [searchTerm, searchTerm, searchTerm];

  if (args.sessionId) {
    query += ' AND session_id = ?';
    queryParams.push(args.sessionId);
  }

  if (args.integrationId) {
    query += ' AND integration_id = ?';
    queryParams.push(args.integrationId);
  }

  query += ' ORDER BY timestamp DESC LIMIT 50';

  const events = db.prepare(query).all(...queryParams) as EventListItem[];

  return { events, query: args.query };
}

function getTimeline(args: TimelineArgs): TimelineResult {
  const db = getDb();
  const events = db.prepare(`
    SELECT id, event_type, event_category, duration_ms, page_url, timestamp
    FROM session_events
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(args.sessionId) as TimelineEvent[];

  // Generate summary
  const summary: TimelineSummary = {
    totalEvents: events.length,
    byCategory: {},
    byType: {},
    duration: 0,
    pages: [],
  };

  const pagesSet = new Set<string>();

  for (const event of events) {
    summary.byCategory[event.event_category] = (summary.byCategory[event.event_category] || 0) + 1;
    summary.byType[event.event_type] = (summary.byType[event.event_type] || 0) + 1;
    summary.duration += event.duration_ms ?? 0;
    if (event.page_url) {pagesSet.add(event.page_url);}
  }

  summary.pages = Array.from(pagesSet);

  return { timeline: events, summary };
}

function recordEvent(args: RecordEventArgs): RecordEventResult {
  const db = getDb();
  const id = randomUUID();
  const category = EVENT_CATEGORIES[args.eventType] || 'other';

  db.prepare(`
    INSERT INTO session_events (id, session_id, agent_id, integration_id, event_type, event_category, input, output, error, duration_ms, page_url, page_title, element_selector, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    args.sessionId,
    args.agentId ?? null,
    args.integrationId ?? null,
    args.eventType,
    category,
    JSON.stringify(args.input),
    args.output ? JSON.stringify(args.output) : null,
    args.error ? JSON.stringify(args.error) : null,
    args.durationMs ?? null,
    args.pageUrl ?? null,
    args.pageTitle ?? null,
    args.elementSelector ?? null,
    JSON.stringify(args.metadata ?? {})
  );

  return { id, success: true };
}

// ============================================================================
// Server Setup
// ============================================================================

const tools: ToolHandler[] = [
  {
    name: 'session_events_list',
    description: 'List all events for a session with filtering',
    schema: ListEventsArgsSchema,
    handler: listEvents,
  },
  {
    name: 'session_events_get',
    description: 'Get full details of a specific event',
    schema: GetEventArgsSchema,
    handler: getEvent,
  },
  {
    name: 'session_events_expand',
    description: 'Expand multiple events to see full outputs',
    schema: ExpandEventsArgsSchema,
    handler: expandEvents,
  },
  {
    name: 'session_events_search',
    description: 'Search events by content (API endpoints, selectors, errors)',
    schema: SearchEventsArgsSchema,
    handler: searchEvents,
  },
  {
    name: 'session_events_timeline',
    description: 'Get chronological timeline of session with summary',
    schema: TimelineArgsSchema,
    handler: getTimeline,
  },
  {
    name: 'session_events_record',
    description: 'Record a new session event',
    schema: RecordEventArgsSchema,
    handler: recordEvent,
  },
];

const server = new McpServer({
  name: 'session-events',
  version: '2.0.0',
  tools,
});

// Handle cleanup on exit
process.on('SIGINT', () => {
  closeDb();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  process.exit(0);
});

server.start();
