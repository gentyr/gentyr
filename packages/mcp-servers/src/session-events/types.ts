/**
 * Types for the Session Events MCP Server
 */

import { z } from 'zod';

// ============================================================================
// Constants
// ============================================================================

export const EVENT_CATEGORIES: Record<string, string> = {
  page_snapshot: 'page',
  page_element_get: 'page',
  page_navigate: 'page',
  page_click: 'action',
  page_type: 'action',
  script_inject: 'script',
  script_result: 'script',
  script_error: 'script',
  network_request: 'network',
  network_response: 'network',
  network_error: 'network',
  api_discovered: 'research',
  auth_pattern_found: 'research',
  selector_identified: 'research',
  mcp_tool_call: 'mcp',
  mcp_tool_error: 'mcp',
};

// ============================================================================
// Zod Schemas (G003 Compliance)
// ============================================================================

export const TimeRangeSchema = z.object({
  start: z.string().optional().describe('Start time (ISO 8601)'),
  end: z.string().optional().describe('End time (ISO 8601)'),
});

export const ListEventsArgsSchema = z.object({
  sessionId: z.string().optional().describe('Filter by session ID'),
  eventTypes: z.array(z.string()).optional().describe('Filter by event types'),
  integrationId: z.string().optional().describe('Filter by integration ID'),
  timeRange: TimeRangeSchema.optional(),
  limit: z.coerce.number().optional().default(100).describe('Max results'),
  offset: z.coerce.number().optional().default(0).describe('Pagination offset'),
});

export const GetEventArgsSchema = z.object({
  eventId: z.string().describe('Event ID to retrieve'),
});

export const ExpandEventsArgsSchema = z.object({
  eventIds: z.array(z.string()).describe('Event IDs to expand'),
});

export const SearchEventsArgsSchema = z.object({
  query: z.string().describe('Search query'),
  sessionId: z.string().optional().describe('Filter by session'),
  integrationId: z.string().optional().describe('Filter by integration'),
});

export const TimelineArgsSchema = z.object({
  sessionId: z.string().describe('Session ID'),
});

export const RecordEventArgsSchema = z.object({
  sessionId: z.string(),
  agentId: z.string().optional(),
  integrationId: z.string().optional(),
  eventType: z.string(),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()).optional(),
  error: z.record(z.unknown()).optional(),
  durationMs: z.coerce.number().optional(),
  pageUrl: z.string().optional(),
  pageTitle: z.string().optional(),
  elementSelector: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ============================================================================
// Type Definitions
// ============================================================================

export type ListEventsArgs = z.infer<typeof ListEventsArgsSchema>;
export type GetEventArgs = z.infer<typeof GetEventArgsSchema>;
export type ExpandEventsArgs = z.infer<typeof ExpandEventsArgsSchema>;
export type SearchEventsArgs = z.infer<typeof SearchEventsArgsSchema>;
export type TimelineArgs = z.infer<typeof TimelineArgsSchema>;
export type RecordEventArgs = z.infer<typeof RecordEventArgsSchema>;

export interface EventRecord {
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

export interface EventListItem {
  id: string;
  session_id: string;
  agent_id: string | null;
  integration_id: string | null;
  event_type: string;
  event_category: string;
  duration_ms: number | null;
  page_url: string | null;
  timestamp: string;
}

export interface ListEventsResult {
  events: EventListItem[];
  count: number;
  hasMore: boolean;
}

export interface ExpandedEvent {
  id: string;
  session_id: string;
  agent_id: string | null;
  integration_id: string | null;
  event_type: string;
  event_category: string;
  input: unknown;
  output: unknown;
  error: unknown;
  duration_ms: number | null;
  page_url: string | null;
  page_title: string | null;
  element_selector: string | null;
  timestamp: string;
  metadata: unknown;
}

export interface SearchEventsResult {
  events: EventListItem[];
  query: string;
}

export interface TimelineEvent {
  id: string;
  event_type: string;
  event_category: string;
  duration_ms: number | null;
  page_url: string | null;
  timestamp: string;
}

export interface TimelineSummary {
  totalEvents: number;
  byCategory: Record<string, number>;
  byType: Record<string, number>;
  duration: number;
  pages: string[];
}

export interface TimelineResult {
  timeline: TimelineEvent[];
  summary: TimelineSummary;
}

export interface RecordEventResult {
  id: string;
  success: boolean;
}

export interface ErrorResult {
  error: string;
}
