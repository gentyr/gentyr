/**
 * SessionSelector — scrollable list of sessions with strict two-line items.
 *
 * Each item is exactly 2 rows using fixed-width Ink columns:
 *   Row 1: [icon 2] [id 9] [title ...fill...]
 *   Row 2: [pad  2] [type 18] [pri 5] [last activity ago ...fill...]
 *
 * Persistent task children are indented with a tree connector.
 * overflow="hidden" on each item prevents content from wrapping to a 3rd row.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DisplaySession } from '../../types.js';
import { truncate, formatElapsed } from '../../utils/formatters.js';

interface SessionSelectorProps {
  displaySessions: DisplaySession[];
  selectedId: string | null;
  height: number;
  width: number;
}

const COL_ICON = 2;
const COL_ID = 9;
const COL_TYPE = 18;
const COL_PRI = 5;
const INDENT_WIDTH = 4;

const DOT = '\u25CF';   // filled circle
const RING = '\u25CB';  // empty circle
const PAUSE = '\u2016'; // double bar
const CROSS = '\u2717'; // x mark
const TREE = '\u2514';  // corner connector

function statusIcon(status: string): { char: string; color: string } {
  switch (status) {
    case 'alive':     return { char: DOT, color: 'white' };
    case 'queued':    return { char: RING, color: 'yellow' };
    case 'spawning':  return { char: RING, color: 'yellow' };
    case 'suspended': return { char: PAUSE, color: 'yellow' };
    case 'paused':    return { char: PAUSE, color: 'yellow' };
    case 'completed': return { char: DOT, color: 'green' };
    case 'failed':    return { char: CROSS, color: 'red' };
    case 'killed':    return { char: CROSS, color: 'red' };
    default:          return { char: '?', color: 'gray' };
  }
}

function priLabel(priority: string): { text: string; color: string | undefined; bold: boolean; dim: boolean } {
  switch (priority) {
    case 'cto':      return { text: 'CTO', color: 'magenta', bold: true, dim: false };
    case 'critical': return { text: 'CRIT', color: 'red', bold: true, dim: false };
    case 'urgent':   return { text: 'URG', color: 'yellow', bold: false, dim: false };
    case 'low':      return { text: 'low', color: undefined, bold: false, dim: true };
    default:         return { text: '', color: undefined, bold: false, dim: true };
  }
}

function lastActivityAgo(timestamp: string | null): string {
  if (!timestamp) return '';
  try {
    const ms = Date.now() - new Date(timestamp).getTime();
    if (ms < 0 || isNaN(ms)) return '';
    return formatElapsed(ms) + ' ago';
  } catch { return ''; }
}

function SessionRow({ ds, isSelected, width }: { ds: DisplaySession; isSelected: boolean; width: number }): React.ReactElement {
  const { session, indent, isMonitor } = ds;
  const icon = statusIcon(session.status);
  const pri = priLabel(session.priority);
  const idText = session.id.slice(0, 8);
  const isIndented = indent > 0;

  // Calculate title width: total - icon - id - padding - optional indent
  const titleWidth = Math.max(4, width - COL_ICON - COL_ID - (isIndented ? INDENT_WIDTH : 0));
  const monitorPrefix = isMonitor ? '[M] ' : '';
  const rawTitle = session.title || session.agentType;
  const titleText = truncate(`${monitorPrefix}${rawTitle}`, titleWidth);

  // Row 2 fields
  const typeText = truncate(session.agentType, COL_TYPE - 1).padEnd(COL_TYPE - 1);
  const priText = pri.text.padEnd(COL_PRI - 1);
  const activityAgo = lastActivityAgo(session.lastActionTimestamp);
  const activityWidth = Math.max(4, width - COL_ICON - COL_TYPE - COL_PRI - (isIndented ? INDENT_WIDTH : 0));
  const activityText = activityAgo ? truncate(activityAgo, activityWidth) : '';

  return (
    <Box flexDirection="column" height={2} overflow="hidden">
      {/* Row 1: icon | id | title */}
      <Box height={1}>
        {isIndented && <Box width={INDENT_WIDTH}><Text dimColor>{`  ${TREE} `}</Text></Box>}
        <Box width={COL_ICON}>
          <Text {...(isSelected ? { inverse: true } : {})} color={icon.color} bold>{icon.char} </Text>
        </Box>
        <Box width={COL_ID}>
          <Text {...(isSelected ? { inverse: true, bold: true } : {})}>{idText} </Text>
        </Box>
        <Box width={titleWidth} overflow="hidden">
          <Text {...(isSelected ? { inverse: true, bold: true } : { dimColor: true })}>{titleText}</Text>
        </Box>
      </Box>

      {/* Row 2: pad | type | priority | last activity ago */}
      <Box height={1}>
        {isIndented && <Box width={INDENT_WIDTH}><Text> </Text></Box>}
        <Box width={COL_ICON}><Text> </Text></Box>
        <Box width={COL_TYPE}>
          <Text {...(isSelected ? { inverse: true } : {})} dimColor>{typeText}</Text>
        </Box>
        <Box width={COL_PRI}>
          {pri.text ? (
            <Text {...(isSelected ? { inverse: true } : {})} color={pri.color} bold={pri.bold} dimColor={pri.dim}>{priText}</Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
        <Box overflow="hidden">
          {activityText ? (
            <Text {...(isSelected ? { inverse: true } : {})} dimColor>{activityText}</Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

export function SessionSelector({ displaySessions, selectedId, height, width }: SessionSelectorProps): React.ReactElement {
  if (displaySessions.length === 0) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  No sessions</Text>
      </Box>
    );
  }

  // Each item is exactly 2 rows
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
        <SessionRow key={ds.session.id} ds={ds} isSelected={ds.session.id === selectedId} width={width} />
      ))}
    </Box>
  );
}
