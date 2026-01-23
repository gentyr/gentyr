/**
 * Unit tests for Session Events MCP Server
 *
 * Tests event recording, querying, and timeline generation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// Types for event recording and querying
interface EventInput {
  sessionId: string;
  eventType: string;
  input: Record<string, unknown>;
  category?: string;
  output?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface EventRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  integration_id: string | null;
  event_type: string;
  event_category: string;
  input: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  page_url: string | null;
  page_title: string | null;
  element_selector: string | null;
  timestamp: string;
  metadata: string;
}

describe('Session Events Server', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
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
    `);
  });

  afterEach(() => {
    db.close();
  });

  const recordEvent = (event: EventInput) => {
    const id = randomUUID();
    db.prepare(`
      INSERT INTO session_events (id, session_id, event_type, event_category, input, output, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      event.sessionId,
      event.eventType,
      event.category || 'other',
      JSON.stringify(event.input),
      event.output ? JSON.stringify(event.output) : null,
      JSON.stringify(event.metadata || {})
    );
    return id;
  };

  describe('Event Recording', () => {
    it('should record event with required fields', () => {
      const id = recordEvent({
        sessionId: 'session-1',
        eventType: 'page_click',
        input: { selector: '.button' },
      });

      const event = db.prepare('SELECT * FROM session_events WHERE id = ?').get(id) as EventRow;
      expect(event).toBeDefined();
      expect(event.session_id).toBe('session-1');
      expect(event.event_type).toBe('page_click');
    });

    it('should record event with optional fields', () => {
      const id = recordEvent({
        sessionId: 'session-1',
        eventType: 'api_call',
        input: { endpoint: '/api/users' },
        output: { data: [{ id: 1 }] },
        metadata: { duration: 150 },
      });

      const event = db.prepare('SELECT * FROM session_events WHERE id = ?').get(id) as EventRow;
      expect(event.output).toBeDefined();
      expect(JSON.parse(event.output)).toEqual({ data: [{ id: 1 }] });
    });
  });

  describe('Event Querying', () => {
    beforeEach(() => {
      recordEvent({ sessionId: 'session-1', eventType: 'page_click', input: {} });
      recordEvent({ sessionId: 'session-1', eventType: 'api_call', input: {} });
      recordEvent({ sessionId: 'session-2', eventType: 'page_click', input: {} });
    });

    it('should list events for session', () => {
      const events = db.prepare(
        'SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp DESC'
      ).all('session-1') as EventRow[];

      expect(events).toHaveLength(2);
      expect(events.every(e => e.session_id === 'session-1')).toBe(true);
    });

    it('should filter by event type', () => {
      const events = db.prepare(
        'SELECT * FROM session_events WHERE event_type = ?'
      ).all('page_click') as EventRow[];

      expect(events).toHaveLength(2);
      expect(events.every(e => e.event_type === 'page_click')).toBe(true);
    });

    it('should apply limit', () => {
      for (let i = 0; i < 20; i++) {
        recordEvent({ sessionId: 'session-1', eventType: 'test', input: {} });
      }

      const events = db.prepare(
        'SELECT * FROM session_events WHERE session_id = ? LIMIT ?'
      ).all('session-1', 10) as EventRow[];

      expect(events).toHaveLength(10);
    });
  });

  describe('Search Functionality', () => {
    it('should search events by content', () => {
      recordEvent({
        sessionId: 'session-1',
        eventType: 'api_call',
        input: { endpoint: '/api/users' },
      });
      recordEvent({
        sessionId: 'session-1',
        eventType: 'api_call',
        input: { endpoint: '/api/posts' },
      });

      const events = db.prepare(
        'SELECT * FROM session_events WHERE input LIKE ?'
      ).all('%users%') as EventRow[];

      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].input).endpoint).toContain('users');
    });
  });

  describe('Timeline Generation', () => {
    it('should generate timeline with summary', () => {
      recordEvent({ sessionId: 'session-1', eventType: 'page_load', category: 'navigation', input: {} });
      recordEvent({ sessionId: 'session-1', eventType: 'page_click', category: 'interaction', input: {} });
      recordEvent({ sessionId: 'session-1', eventType: 'api_call', category: 'api', input: {} });

      const events = db.prepare(
        'SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp ASC'
      ).all('session-1') as EventRow[];

      const summary = {
        totalEvents: events.length,
        byCategory: {} as Record<string, number>,
        byType: {} as Record<string, number>,
      };

      for (const event of events) {
        summary.byCategory[event.event_category] = (summary.byCategory[event.event_category] || 0) + 1;
        summary.byType[event.event_type] = (summary.byType[event.event_type] || 0) + 1;
      }

      expect(summary.totalEvents).toBe(3);
      expect(summary.byCategory['navigation']).toBe(1);
      expect(summary.byType['page_click']).toBe(1);
    });
  });

  describe('Database Indexes', () => {
    it('should have required indexes', () => {
      const indexes = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index'"
      ).all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);
      expect(indexNames).toContain('idx_session_events_session');
      expect(indexNames).toContain('idx_session_events_type');
      expect(indexNames).toContain('idx_session_events_timestamp');
    });
  });

  describe('Error Handling', () => {
    it('should require session_id', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO session_events (id, event_type, event_category, input)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), 'test', 'other', '{}');
      }).toThrow();
    });

    it('should require event_type', () => {
      expect(() => {
        db.prepare(`
          INSERT INTO session_events (id, session_id, event_category, input)
          VALUES (?, ?, ?, ?)
        `).run(randomUUID(), 'session-1', 'other', '{}');
      }).toThrow();
    });
  });
});
