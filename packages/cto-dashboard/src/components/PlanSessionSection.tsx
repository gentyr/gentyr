/**
 * Plan Session Section Component — Per-session lifecycle timeline
 *
 * Shows a vertical timeline per agent session: spawns, proxy rotations,
 * quota interruptions, revivals, worklog entries, and PR events.
 *
 * White + Gray only design.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { PlanSessionData, PlanSessionInfo, SessionEvent } from '../utils/plan-session-reader.js';

export interface PlanSessionSectionProps {
  data: PlanSessionData;
  tip?: string;
}

// ============================================================================
// Formatting helpers
// ============================================================================

function formatEventTime(isoString: string): string {
  const d = new Date(isoString);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTokens(n: number): string {
  if (n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000)}K`;
}

function truncateTitle(title: string, maxLen = 30): string {
  if (title.length <= maxLen) return title;
  return title.substring(0, maxLen - 3) + '...';
}

// ============================================================================
// EventRow
// ============================================================================

function EventRow({ event }: { event: SessionEvent }): React.ReactElement {
  const time = formatEventTime(event.timestamp);
  const detail = event.detail ? ` (${event.detail})` : '';

  return (
    <Box>
      <Text color="gray">  {time}  </Text>
      <Text color="gray">{'→ '}</Text>
      <Text color="white">{event.label}</Text>
      <Text color="gray">{detail}</Text>
    </Box>
  );
}

// ============================================================================
// SessionBlock
// ============================================================================

function SessionBlock({ session }: { session: PlanSessionInfo }): React.ReactElement {
  const title = truncateTitle(session.planTaskTitle);
  const duration = formatDuration(session.durationMs);
  const isRunning = session.status === 'running';

  const headerLine = isRunning
    ? `SESSION: ${session.agentId} | Task: "${title}" | RUNNING (${duration})`
    : session.tokensTotal > 0
      ? `SESSION: ${session.agentId} | Task: "${title}" | ${duration} | ${formatTokens(session.tokensTotal)} tokens`
      : `SESSION: ${session.agentId} | Task: "${title}" | ${duration}`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color="white">{headerLine}</Text>
      </Box>
      <Box flexDirection="column">
        {session.events.map((event, idx) => (
          <EventRow key={idx} event={event} />
        ))}
        {isRunning && (
          <Box>
            <Text color="gray" dimColor italic>{'  ...currently running...'}</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// ============================================================================
// PlanSessionSection
// ============================================================================

export function PlanSessionSection({ data, tip }: PlanSessionSectionProps): React.ReactElement {
  if (!data.hasData || data.sessions.length === 0) {
    return (
      <Section title="PLAN SESSIONS" borderColor="white" tip={tip}>
        <Text color="gray">No plan session data available. Agents must be linked to plan tasks via todo_task_id.</Text>
      </Section>
    );
  }

  const { summary } = data;
  const totalTokensStr = formatTokens(summary.totalTokens);

  return (
    <Section title={`PLAN SESSIONS (${data.sessions.length} session${data.sessions.length !== 1 ? 's' : ''})`} borderColor="white" tip={tip}>
      <Box flexDirection="column">
        {data.sessions.map((session, idx) => (
          <SessionBlock key={idx} session={session} />
        ))}
        <Box marginTop={1}>
          <Text color="gray">
            {`Summary: ${summary.totalSessions} session${summary.totalSessions !== 1 ? 's' : ''} | ${summary.running} running | ${summary.completed} completed | ${summary.revived} revived | ${totalTokensStr} tokens`}
          </Text>
        </Box>
      </Box>
    </Section>
  );
}
