/**
 * SessionSelector — scrollable list of running sessions.
 * Arrow-up / arrow-down selection is handled by the parent (Page4).
 * Each row shows: agent ID prefix, truncated title, elapsed time.
 * The selected row is highlighted with inverse colors.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionItem } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface SessionSelectorProps {
  sessions: SessionItem[];
  selectedId: string | null;
  height: number;
}

export function SessionSelector({ sessions, selectedId, height }: SessionSelectorProps): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No running sessions</Text>
      </Box>
    );
  }

  // Visible window: show up to `height` rows centred on the selected item.
  const selectedIndex = sessions.findIndex(s => s.id === selectedId);
  const visibleCount = Math.max(1, height);
  let startIdx = 0;
  if (selectedIndex >= 0) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), sessions.length - visibleCount));
  }
  const visible = sessions.slice(startIdx, startIdx + visibleCount);

  return (
    <Box flexDirection="column" height={height}>
      {visible.map((session) => {
        const isSelected = session.id === selectedId;
        const idPrefix = session.id.slice(0, 8);
        // Determine available width for title (fixed layout: ">" 1 + space 1 + idPrefix 8 + space 1 + elapsed 6)
        const titleMaxLen = 20;
        const title = truncate(session.title || session.agentType, titleMaxLen);
        const elapsed = session.elapsed.padStart(5);

        if (isSelected) {
          return (
            <Text key={session.id} inverse bold>
              {`> ${idPrefix} ${title.padEnd(titleMaxLen)} ${elapsed}`}
            </Text>
          );
        }
        return (
          <Box key={session.id} flexDirection="row">
            <Text dimColor>{'  '}</Text>
            <Text>{idPrefix}</Text>
            <Text>{' '}</Text>
            <Text dimColor>{title.padEnd(titleMaxLen)}</Text>
            <Text>{' '}</Text>
            <Text dimColor>{elapsed}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
