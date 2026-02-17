/**
 * TimelineItem component - single event in the timeline
 * Icons: HOOK, REPORT, QUESTION, TASK, SESSION
 */

import React from 'react';
import { Box, Text } from 'ink';

export type TimelineEventType = 'hook' | 'report' | 'question' | 'task' | 'session';

export interface TimelineEvent {
  type: TimelineEventType;
  timestamp: Date;
  title: string;
  subtitle?: string;
  details?: string;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  status?: string;
}

// ASCII icons — guaranteed single-width in all terminals.
// The geometric shapes (●, ◆, ◇, ■, ○) are "East Asian Ambiguous" width
// and render as 2 columns in many terminals, breaking vertical alignment.
const EVENT_ICONS: Record<TimelineEventType, string> = {
  hook: '*',      // event trigger
  report: '!',    // alert / report
  question: '?',  // needs answer
  task: '+',      // work item
  session: 'o',   // neutral / informational
};

const EVENT_COLORS: Record<TimelineEventType, string> = {
  hook: 'blue',
  report: 'yellow',
  question: 'magenta',
  task: 'green',
  session: 'gray',
};

const EVENT_LABELS: Record<TimelineEventType, string> = {
  hook: 'HOOK',
  report: 'REPORT',
  question: 'QUESTION',
  task: 'TASK',
  session: 'SESSION',
};

// Column widths for consistent alignment
const COL_TIME = 7;    // "HH:MM" + padding
const COL_ICON = 3;    // 1-char ASCII icon + padding
const COL_LABEL = 10;  // longest label "QUESTION" = 8 chars + padding

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'red',
  high: 'yellow',
  normal: 'white',
  low: 'gray',
};

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function TimelineItem({ event }: { event: TimelineEvent }): React.ReactElement {
  const icon = EVENT_ICONS[event.type];
  const color = EVENT_COLORS[event.type];
  const label = EVENT_LABELS[event.type];
  const priorityTag = event.priority && event.priority !== 'normal'
    ? ` [${event.priority.toUpperCase()}]`
    : '';
  const priorityColor = event.priority ? PRIORITY_COLORS[event.priority] : 'white';

  const indentWidth = COL_TIME + COL_ICON + COL_LABEL;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Main line: time, icon, type, title */}
      <Box flexDirection="row">
        <Box width={COL_TIME} flexShrink={0}>
          <Text color="gray">{formatTime(event.timestamp)}</Text>
        </Box>
        <Box width={COL_ICON} flexShrink={0}>
          <Text color={color}>{icon}</Text>
        </Box>
        <Box width={COL_LABEL} flexShrink={0}>
          <Text color={color} bold>{label}</Text>
        </Box>
        <Box flexShrink={1}>
          <Text color="white" wrap="truncate-end">{event.title}{priorityTag ? ' ' : ''}</Text>
          {priorityTag && <Text color={priorityColor}>{priorityTag.trim()}</Text>}
        </Box>
      </Box>

      {/* Subtitle line with tree connector */}
      {event.subtitle && (
        <Box marginLeft={indentWidth}>
          <Text color="gray">{'\u2514\u2500 '}</Text>
          <Text color="white">{event.subtitle}</Text>
        </Box>
      )}

      {/* Details line */}
      {event.details && (
        <Box marginLeft={indentWidth + 3}>
          <Text color="gray">{event.details}</Text>
        </Box>
      )}
    </Box>
  );
}
