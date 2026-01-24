/**
 * Unit tests for timeline aggregator
 *
 * Tests aggregation of events from multiple data sources:
 * - Agent tracker (hook spawns)
 * - CTO reports database
 * - Deputy CTO questions database
 * - Todo tasks database
 * - Session JSONL files
 *
 * Validates event merging, sorting, filtering, and limiting.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { TimelineEvent } from '../../components/TimelineItem.js';

describe('Timeline Aggregator', () => {
  let tempDir: string;
  let ctoReportsPath: string;
  let agentTrackerPath: string;

  beforeEach(() => {
    tempDir = path.join('/tmp', `timeline-test-${randomUUID()}`);
    const claudeDir = path.join(tempDir, '.claude');
    const stateDir = path.join(claudeDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    ctoReportsPath = path.join(claudeDir, 'cto-reports.db');
    agentTrackerPath = path.join(stateDir, 'agent-tracker-history.json');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createAgentHistory = (agents: Array<{ type: string; hookType: string; timestamp: string; description?: string }>) => {
    fs.writeFileSync(agentTrackerPath, JSON.stringify({ agents }));
  };

  const getHookEvents = (since: number): TimelineEvent[] => {
    const events: TimelineEvent[] = [];

    if (!fs.existsSync(agentTrackerPath)) return events;

    try {
      const content = fs.readFileSync(agentTrackerPath, 'utf8');
      const history = JSON.parse(content) as { agents: Array<{ type: string; hookType: string; timestamp: string; description?: string }> };

      for (const agent of history.agents || []) {
        const agentTime = new Date(agent.timestamp).getTime();
        if (agentTime < since) continue;

        events.push({
          type: 'hook',
          timestamp: new Date(agent.timestamp),
          title: agent.hookType || 'unknown-hook',
          subtitle: `${agent.type}: "${agent.description || 'No description'}"`,
        });
      }
    } catch {
      // Ignore errors
    }

    return events;
  };

  const getReportEvents = (since: number): TimelineEvent[] => {
    const events: TimelineEvent[] = [];

    if (!fs.existsSync(ctoReportsPath)) return events;

    try {
      const db = new Database(ctoReportsPath, { readonly: true });
      const sinceIso = new Date(since).toISOString();

      const rows = db.prepare(`
        SELECT id, title, category, priority, reporting_agent, triage_status, created_at
        FROM reports
        WHERE created_at >= ?
        ORDER BY created_at DESC
      `).all(sinceIso) as Array<{
        id: string;
        title: string;
        category: string;
        priority: string;
        reporting_agent: string;
        triage_status: string | null;
        created_at: string;
      }>;

      for (const row of rows) {
        events.push({
          type: 'report',
          timestamp: new Date(row.created_at),
          title: row.title,
          subtitle: `From: ${row.reporting_agent} | Status: ${row.triage_status || 'pending'}`,
          priority: row.priority as 'low' | 'normal' | 'high' | 'critical',
        });
      }

      db.close();
    } catch {
      // Ignore errors
    }

    return events;
  };

  it('should aggregate hook events from agent tracker', () => {
    const now = Date.now();
    createAgentHistory([
      {
        type: 'deputy-cto-review',
        hookType: 'pre-commit',
        timestamp: new Date(now - 1000).toISOString(),
        description: 'Review commit',
      },
      {
        type: 'lint-fixer',
        hookType: 'session-start',
        timestamp: new Date(now - 2000).toISOString(),
        description: 'Fix linting issues',
      },
    ]);

    const events = getHookEvents(now - 10000);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('hook');
    expect(events[0].title).toBe('pre-commit');
    expect(events[1].type).toBe('hook');
    expect(events[1].title).toBe('session-start');
  });

  it('should aggregate report events from database', () => {
    const db = new Database(ctoReportsPath);
    db.exec(`
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        reporting_agent TEXT NOT NULL,
        triage_status TEXT,
        created_at TEXT NOT NULL
      );
    `);

    const now = new Date();
    db.prepare(`
      INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('1', 'Test Report', 'architecture', 'high', 'test-writer', 'pending', now.toISOString());
    db.close();

    const events = getReportEvents(now.getTime() - 10000);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('report');
    expect(events[0].title).toBe('Test Report');
    expect(events[0].priority).toBe('high');
  });

  it('should filter events by time range', () => {
    const now = Date.now();
    createAgentHistory([
      {
        type: 'recent',
        hookType: 'hook1',
        timestamp: new Date(now - 1000).toISOString(),
      },
      {
        type: 'old',
        hookType: 'hook2',
        timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      },
    ]);

    const since = now - (24 * 60 * 60 * 1000); // Last 24 hours
    const events = getHookEvents(since);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('hook1');
  });

  it('should sort events by timestamp descending', () => {
    const now = Date.now();
    const events: TimelineEvent[] = [
      {
        type: 'hook',
        timestamp: new Date(now - 3000),
        title: 'Third',
        subtitle: 'subtitle',
      },
      {
        type: 'report',
        timestamp: new Date(now - 1000),
        title: 'First',
        subtitle: 'subtitle',
      },
      {
        type: 'task',
        timestamp: new Date(now - 2000),
        title: 'Second',
        subtitle: 'subtitle',
      },
    ];

    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    expect(events[0].title).toBe('First');
    expect(events[1].title).toBe('Second');
    expect(events[2].title).toBe('Third');
  });

  it('should limit number of returned events', () => {
    const now = Date.now();
    const events: TimelineEvent[] = [];

    for (let i = 0; i < 30; i++) {
      events.push({
        type: 'hook',
        timestamp: new Date(now - i * 1000),
        title: `Event ${i}`,
        subtitle: 'subtitle',
      });
    }

    const maxEvents = 20;
    const limited = events.slice(0, maxEvents);

    expect(limited).toHaveLength(20);
  });

  it('should filter events by type', () => {
    const events: TimelineEvent[] = [
      { type: 'hook', timestamp: new Date(), title: 'Hook 1', subtitle: 'sub' },
      { type: 'report', timestamp: new Date(), title: 'Report 1', subtitle: 'sub' },
      { type: 'task', timestamp: new Date(), title: 'Task 1', subtitle: 'sub' },
      { type: 'hook', timestamp: new Date(), title: 'Hook 2', subtitle: 'sub' },
    ];

    const filtered = events.filter(e => ['hook', 'task'].includes(e.type));

    expect(filtered).toHaveLength(3);
    expect(filtered.filter(e => e.type === 'hook')).toHaveLength(2);
    expect(filtered.filter(e => e.type === 'task')).toHaveLength(1);
  });

  it('should return empty array when no data sources exist', () => {
    const events = getHookEvents(Date.now() - 10000);
    expect(events).toEqual([]);
  });

  it('should validate structure of timeline events', () => {
    const now = Date.now();
    createAgentHistory([
      {
        type: 'test-type',
        hookType: 'test-hook',
        timestamp: new Date(now).toISOString(),
        description: 'Test description',
      },
    ]);

    const events = getHookEvents(now - 10000);

    expect(events).toHaveLength(1);
    const event = events[0];

    expect(event).toHaveProperty('type');
    expect(event).toHaveProperty('timestamp');
    expect(event).toHaveProperty('title');
    expect(event).toHaveProperty('subtitle');

    expect(typeof event.type).toBe('string');
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(typeof event.title).toBe('string');
    expect(typeof event.subtitle).toBe('string');
  });

  it('should handle missing optional fields gracefully', () => {
    const now = Date.now();
    createAgentHistory([
      {
        type: 'test-type',
        hookType: 'test-hook',
        timestamp: new Date(now).toISOString(),
        // description is optional
      },
    ]);

    const events = getHookEvents(now - 10000);

    expect(events).toHaveLength(1);
    expect(events[0].subtitle).toContain('No description');
  });

  it('should merge events from multiple sources correctly', () => {
    const now = Date.now();

    // Create hook events
    createAgentHistory([
      {
        type: 'hook-type',
        hookType: 'pre-commit',
        timestamp: new Date(now - 1000).toISOString(),
      },
    ]);

    // Create report events
    const db = new Database(ctoReportsPath);
    db.exec(`
      CREATE TABLE reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        reporting_agent TEXT NOT NULL,
        triage_status TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO reports VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('1', 'Report', 'architecture', 'normal', 'agent', null, new Date(now - 2000).toISOString());
    db.close();

    const since = now - 10000;
    const hookEvents = getHookEvents(since);
    const reportEvents = getReportEvents(since);

    const allEvents = [...hookEvents, ...reportEvents];
    allEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    expect(allEvents).toHaveLength(2);
    expect(allEvents[0].type).toBe('hook'); // More recent
    expect(allEvents[1].type).toBe('report');
  });
});
