/**
 * SessionSelector — scrollable list of sessions with two-line items.
 *
 * Each item renders two lines:
 *   Line 1: [status icon] [id-prefix] [title]                [elapsed]
 *   Line 2:   [agent-type] [priority] [last action or status]
 *
 * Persistent task children are indented with a tree connector.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DisplaySession } from '../../types.js';
import { truncate } from '../../utils/formatters.js';

interface SessionSelectorProps {
  displaySessions: DisplaySession[];
  selectedId: string | null;
  height: number;
}

function statusIcon(status: string): { char: string; color: string } {
  switch (status) {
    case 'alive':     return { char: '\u25CF', color: 'green' };
    case 'queued':    return { char: '\u25CB', color: 'yellow' };
    case 'spawning':  return { char: '\u25CB', color: 'yellow' };
    case 'suspended': return { char: '\u2016', color: 'yellow' };
    case 'paused':    return { char: '\u2016', color: 'yellow' };
    case 'completed': return { char: '\u2713', color: 'gray' };
    case 'failed':    return { char: '\u2717', color: 'red' };
    case 'killed':    return { char: '\u2717', color: 'red' };
    default:          return { char: '?', color: 'gray' };
  }
}

function priorityBadge(priority: string): React.ReactElement | null {
  switch (priority) {
    case 'cto':      return <Text color="magenta" bold>CTO</Text>;
    case 'critical':  return <Text color="red" bold>CRIT</Text>;
    case 'urgent':    return <Text color="yellow">URG</Text>;
    case 'low':       return <Text dimColor>low</Text>;
    default:          return null;
  }
}

function SessionRow({ ds, isSelected, maxWidth }: { ds: DisplaySession; isSelected: boolean; maxWidth: number }): React.ReactElement {
  const { session, indent, isMonitor } = ds;
  const icon = statusIcon(session.status);
  const indentStr = indent > 0 ? '  \u2514 ' : '';
  const monitorTag = isMonitor ? '[M] ' : '';
  const idPrefix = session.id.slice(0, 8);
  const fixedCharsLine1 = indentStr.length + 2 + idPrefix.length + 1 + monitorTag.length + 1 + session.elapsed.length;
  const titleMaxLen = Math.max(8, maxWidth - fixedCharsLine1);
  const title = truncate(session.title || session.agentType, titleMaxLen);
  const agentType = truncate(session.agentType, 20);
  const lastAction = session.lastAction ? truncate(session.lastAction, 30) : '';

  if (isSelected) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text inverse bold>
            {indentStr}<Text color={icon.color}>{icon.char}</Text> {idPrefix} {monitorTag}{title.padEnd(titleMaxLen)} {session.elapsed}
          </Text>
        </Box>
        <Box>
          <Text inverse dimColor>
            {' '.repeat(indent > 0 ? 4 : 0)}  {agentType}
          </Text>
          {priorityBadge(session.priority) && <Text inverse> </Text>}
          {priorityBadge(session.priority)}
          {lastAction ? <Text inverse dimColor> {lastAction}</Text> : null}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{indentStr}</Text>
        <Text color={icon.color}>{icon.char}</Text>
        <Text> </Text>
        <Text>{idPrefix}</Text>
        <Text> </Text>
        {isMonitor && <Text color="cyan">[M] </Text>}
        <Text dimColor>{truncate(session.title || session.agentType, titleMaxLen)}</Text>
        <Text> </Text>
        <Text dimColor>{session.elapsed}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {' '.repeat(indent > 0 ? 4 : 0)}  {agentType}
        </Text>
        {priorityBadge(session.priority) && <Text> </Text>}
        {priorityBadge(session.priority)}
        {lastAction ? <Text dimColor> {lastAction}</Text> : null}
      </Box>
    </Box>
  );
}

export function SessionSelector({ displaySessions, selectedId, height }: SessionSelectorProps): React.ReactElement {
  if (displaySessions.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No sessions</Text>
      </Box>
    );
  }

  const itemsPerPage = Math.max(1, Math.floor(height / 2));
  const selectedIndex = displaySessions.findIndex(ds => ds.session.id === selectedId);
  let startIdx = 0;
  if (selectedIndex >= 0) {
    startIdx = Math.max(0, Math.min(selectedIndex - Math.floor(itemsPerPage / 2), displaySessions.length - itemsPerPage));
  }
  const visible = displaySessions.slice(startIdx, startIdx + itemsPerPage);

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {visible.map((ds) => (
        <SessionRow key={ds.session.id} ds={ds} isSelected={ds.session.id === selectedId} maxWidth={40} />
      ))}
    </Box>
  );
}
