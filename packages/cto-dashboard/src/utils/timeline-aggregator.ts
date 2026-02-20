/**
 * Timeline Aggregator - merges all data sources into unified timeline events
 *
 * Data sources:
 * - agent-tracker → agents (Hook spawns)
 * - cto-reports.db → reports (Reports)
 * - deputy-cto.db → questions (Questions)
 * - todo.db → tasks completed (Tasks)
 * - session JSONL files (Sessions)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { openReadonlyDb } from './readonly-db.js';
import type { TimelineEvent, TimelineEventType } from '../components/TimelineItem.js';

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = path.resolve(process.env['CLAUDE_PROJECT_DIR'] || process.cwd());
const TODO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'todo.db');
const DEPUTY_CTO_DB_PATH = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB_PATH = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const AGENT_TRACKER_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'agent-tracker-history.json');

function getSessionDir(): string {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

// ============================================================================
// Internal Types
// ============================================================================

interface AgentHistoryEntry {
  id: string;
  type: string;
  hookType: string;
  timestamp: string;
  description?: string;
}

interface AgentHistory {
  agents: AgentHistoryEntry[];
}

interface ReportRow {
  id: string;
  title: string;
  category: string;
  priority: string;
  reporting_agent: string;
  triage_status: string | null;
  created_at: string;
}

interface QuestionRow {
  id: string;
  title: string;
  type: string;
  status: string;
  created_at: string;
  answered_at: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  section: string;
  status: string;
  completed_timestamp: number | null;
}

interface SessionEntry {
  timestamp?: string;
  type?: string;
  message?: {
    content?: string;
  };
  content?: string;
}

// ============================================================================
// Hook Events (from agent-tracker)
// ============================================================================

function getHookEvents(since: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (!fs.existsSync(AGENT_TRACKER_PATH)) return events;

  try {
    const content = fs.readFileSync(AGENT_TRACKER_PATH, 'utf8');
    const history = JSON.parse(content) as AgentHistory;

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
}

// ============================================================================
// Report Events (from cto-reports.db)
// ============================================================================

function getReportEvents(since: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (!fs.existsSync(CTO_REPORTS_DB_PATH)) return events;

  try {
    const db = openReadonlyDb(CTO_REPORTS_DB_PATH);
    const sinceIso = new Date(since).toISOString();

    const rows = db.prepare(`
      SELECT id, title, category, priority, reporting_agent, triage_status, created_at
      FROM reports
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `).all(sinceIso) as ReportRow[];

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
}

// ============================================================================
// Question Events (from deputy-cto.db)
// ============================================================================

function getQuestionEvents(since: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (!fs.existsSync(DEPUTY_CTO_DB_PATH)) return events;

  try {
    const db = openReadonlyDb(DEPUTY_CTO_DB_PATH);
    const sinceIso = new Date(since).toISOString();

    const rows = db.prepare(`
      SELECT id, title, type, status, created_at, answered_at
      FROM questions
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `).all(sinceIso) as QuestionRow[];

    for (const row of rows) {
      events.push({
        type: 'question',
        timestamp: new Date(row.created_at),
        title: row.title,
        subtitle: `Type: ${row.type} | Status: ${row.status}`,
        status: row.status,
      });
    }

    db.close();
  } catch {
    // Ignore errors
  }

  return events;
}

// ============================================================================
// Task Events (from todo.db - completed tasks)
// ============================================================================

function getTaskEvents(since: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  if (!fs.existsSync(TODO_DB_PATH)) return events;

  try {
    const db = openReadonlyDb(TODO_DB_PATH);
    const sinceTimestamp = Math.floor(since / 1000);

    const rows = db.prepare(`
      SELECT id, title, section, status, completed_timestamp
      FROM tasks
      WHERE status = 'completed' AND completed_timestamp >= ?
      ORDER BY completed_timestamp DESC
    `).all(sinceTimestamp) as TaskRow[];

    for (const row of rows) {
      const timestamp = row.completed_timestamp
        ? new Date(row.completed_timestamp * 1000)
        : new Date();

      events.push({
        type: 'task',
        timestamp,
        title: row.title,
        subtitle: `Assignee: ${row.section}`,
        status: 'completed',
      });
    }

    db.close();
  } catch {
    // Ignore errors
  }

  return events;
}

// ============================================================================
// Session Events (from JSONL files)
// ============================================================================

function parseTaskType(messageContent: string): string | null {
  if (!messageContent.startsWith('[Task]')) return null;
  const typeMatch = messageContent.match(/^\[Task\]\[([^\]]+)\]/);
  if (typeMatch && typeMatch[1]) return typeMatch[1];
  return 'unknown';
}

function getSessionEvents(since: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const sessionDir = getSessionDir();

  if (!fs.existsSync(sessionDir)) return events;

  try {
    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        let sessionTimestamp: Date | null = null;
        let sessionType: 'user' | 'task' = 'user';
        let taskType: string | null = null;
        const toolsUsed = new Set<string>();

        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as SessionEntry;

            // Get session start time from first timestamp
            if (entry.timestamp && !sessionTimestamp) {
              sessionTimestamp = new Date(entry.timestamp);
            }

            // Detect if this is a task-triggered session
            if (entry.type === 'human' || entry.type === 'user') {
              const messageContent = typeof entry.message?.content === 'string'
                ? entry.message.content
                : entry.content;

              if (messageContent) {
                const parsedType = parseTaskType(messageContent);
                if (parsedType) {
                  sessionType = 'task';
                  taskType = parsedType;
                }
              }
            }

            // Track tools used (simplified - just check for tool_use type)
            if (entry.type === 'tool_use') {
              // Would need more parsing to get tool name
              toolsUsed.add('Tool');
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (sessionTimestamp && sessionTimestamp.getTime() >= since) {
          const subtitle = sessionType === 'task'
            ? `Task: ${taskType || 'unknown'}`
            : 'User session (manual)';

          events.push({
            type: 'session',
            timestamp: sessionTimestamp,
            title: file.replace('.jsonl', '').slice(0, 8) + '...',
            subtitle,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Ignore errors
  }

  return events;
}

// ============================================================================
// Main Aggregator
// ============================================================================

export interface TimelineOptions {
  hours?: number;
  maxEvents?: number;
  types?: TimelineEventType[];
}

export function aggregateTimeline(options: TimelineOptions = {}): TimelineEvent[] {
  const { hours = 24, maxEvents = 20, types } = options;
  const since = Date.now() - (hours * 60 * 60 * 1000);

  let events: TimelineEvent[] = [];

  // Collect events from all sources
  const hookEvents = getHookEvents(since);
  const reportEvents = getReportEvents(since);
  const questionEvents = getQuestionEvents(since);
  const taskEvents = getTaskEvents(since);
  const sessionEvents = getSessionEvents(since);

  // Merge all events
  events = [
    ...hookEvents,
    ...reportEvents,
    ...questionEvents,
    ...taskEvents,
    ...sessionEvents,
  ];

  // Filter by type if specified
  if (types && types.length > 0) {
    events = events.filter(e => types.includes(e.type));
  }

  // Sort by timestamp descending (most recent first)
  events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  // Limit to maxEvents
  return events.slice(0, maxEvents);
}
