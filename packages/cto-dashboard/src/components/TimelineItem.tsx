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

const EVENT_ICONS: Record<TimelineEventType, string> = {
  hook: '\u25CF',     // Black circle (filled)
  report: '\u25C6',   // Black diamond
  question: '\u25C7', // White diamond
  task: '\u25A0',     // Black square
  session: '\u25CB',  // White circle
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
const COL_ICON = 3;    // icon (1-2 visual cols) + space, box enforces width
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
        <Box width={COL_TIME}>
          <Text color="gray">{formatTime(event.timestamp)}</Text>
        </Box>
        <Box width={COL_ICON}>
          <Text color={color}>{icon}</Text>
        </Box>
        <Box width={COL_LABEL}>
          <Text color={color} bold>{label}</Text>
        </Box>
        <Text color="white">{event.title}</Text>
        {priorityTag && <Text color={priorityColor}>{priorityTag}</Text>}
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
