/**
 * SessionInfo — detail panel for the selected session.
 * Shows: PID, agent type, elapsed, title (wrapped), last tool, worktree.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionItem } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface SessionInfoProps {
  session: SessionItem | null;
  height: number;
}

function InfoRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Text dimColor>{label.padEnd(12)}</Text>
      <Text>{value}</Text>
    </Box>
  );
}

export function SessionInfo({ session, height }: SessionInfoProps): React.ReactElement {
  if (!session) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  Select a session</Text>
      </Box>
    );
  }

  const pid = session.pid ? String(session.pid) : 'N/A';
  const agentType = session.agentType || 'unknown';
  const elapsed = session.elapsed;
  const lastTool = session.lastAction ?? 'none';

  // Wrap title across multiple lines at 30 chars.
  const title = session.title || '(untitled)';
  const titleChunks: string[] = [];
  for (let i = 0; i < title.length; i += 28) {
    titleChunks.push(title.slice(i, i + 28));
  }

  const rows = [
    <InfoRow key="pid" label="PID:" value={pid} />,
    <InfoRow key="type" label="Type:" value={truncate(agentType, 20)} />,
    <InfoRow key="elapsed" label="Elapsed:" value={elapsed} />,
    <InfoRow key="tool" label="Last tool:" value={truncate(lastTool, 20)} />,
  ];

  titleChunks.forEach((chunk, i) => {
    rows.push(
      <InfoRow key={`title-${i}`} label={i === 0 ? 'Title:' : ''} value={chunk} />,
    );
  });

  return (
    <Box flexDirection="column" height={height}>
      {rows.slice(0, height)}
    </Box>
  );
}
