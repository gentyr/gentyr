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

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Main line: time, icon, type, title */}
      <Box>
        <Text color="gray">{formatTime(event.timestamp)}  </Text>
        <Text color={color}>{icon} </Text>
        <Text color={color} bold>{label}</Text>
        <Text color="white">  {event.title}</Text>
        {priorityTag && <Text color={priorityColor}>{priorityTag}</Text>}
      </Box>

      {/* Subtitle line with tree connector */}
      {event.subtitle && (
        <Box marginLeft={8}>
          <Text color="gray">{'\u2514\u2500 '}</Text>
          <Text color="white">{event.subtitle}</Text>
        </Box>
      )}

      {/* Details line */}
      {event.details && (
        <Box marginLeft={11}>
          <Text color="gray">{event.details}</Text>
        </Box>
      )}
    </Box>
  );
}
