/**
 * SessionSelector — scrollable list of sessions with strict two-line items.
 *
 * Each item is exactly 2 rows using fixed-width Ink columns:
 *   Row 1: [icon 2] [id 9] [title ...fill...]
 *   Row 2: [pad  2] [category·status 18] [pri 5] [last activity ago ...fill...]
 *
 * Status is shown via colored dots only (green=running, yellow=queued,
 * blue=paused/suspended, gray=done, red=failed).
 * Persistent task children are indented. Category: Monitor / Sub-Task / Task.
 * overflow="hidden" on each item prevents content from wrapping to a 3rd row.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DisplaySession } from '../../types.js';
import { truncate, formatElapsed, cleanTitle } from '../../utils/formatters.js';

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

function statusIcon(status: string): { char: string; color: string } {
  switch (status) {
    case 'alive':     return { char: DOT, color: 'green' };
    case 'queued':    return { char: DOT, color: 'yellow' };
    case 'spawning':  return { char: DOT, color: 'yellow' };
    case 'suspended': return { char: DOT, color: 'blue' };
    case 'paused':    return { char: DOT, color: 'blue' };
    case 'completed': return { char: DOT, color: 'gray' };
    case 'failed':    return { char: DOT, color: 'red' };
    case 'killed':    return { char: DOT, color: 'red' };
    default:          return { char: DOT, color: 'gray' };
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

function statusLabel(status: string): string {
  switch (status) {
    case 'alive':     return 'running';
    case 'queued':    return 'queued';
    case 'spawning':  return 'spawning';
    case 'suspended': return 'suspended';
    case 'paused':    return 'paused';
    case 'completed': return 'done';
    case 'failed':    return 'failed';
    case 'killed':    return 'killed';
    default:          return status;
  }
}

function categoryLabel(ds: DisplaySession): string {
  const category = ds.isMonitor ? 'Monitor' : ds.indent > 0 ? 'Sub-Task' : 'Task';
  return `${category} · ${statusLabel(ds.session.status)}`;
}


function SessionRow({ ds, isSelected, width }: { ds: DisplaySession; isSelected: boolean; width: number }): React.ReactElement {
  const { session, indent } = ds;
  const icon = statusIcon(session.status);
  const pri = priLabel(session.priority);
  const idText = session.id.slice(0, 8);
  const isIndented = indent > 0;

  // Calculate title width: total - icon - id - padding - optional indent
  const titleWidth = Math.max(4, width - COL_ICON - COL_ID - (isIndented ? INDENT_WIDTH : 0));
  const rawTitle = cleanTitle(session.title || session.agentType);
  const titleText = truncate(rawTitle, titleWidth);

  // Row 2 fields
  const category = categoryLabel(ds).padEnd(COL_TYPE - 1);
  const priText = pri.text.padEnd(COL_PRI - 1);
  const activityAgo = lastActivityAgo(session.lastActionTimestamp);
  const activityWidth = Math.max(4, width - COL_ICON - COL_TYPE - COL_PRI - (isIndented ? INDENT_WIDTH : 0));
  const activityText = activityAgo ? truncate(activityAgo, activityWidth) : '';

  // Selected items get white text; unselected get dim text
  const sel = isSelected ? { color: 'white' as const, bold: true } : {};
  const selDim = isSelected ? { color: 'white' as const } : { dimColor: true };

  return (
    <Box flexDirection="column" height={2} overflow="hidden">
      {/* Row 1: icon | id | title */}
      <Box height={1}>
        {isIndented && <Box width={INDENT_WIDTH}><Text>{`    `}</Text></Box>}
        <Box width={COL_ICON}>
          <Text color={icon.color} bold>{icon.char} </Text>
        </Box>
        <Box width={COL_ID}>
          <Text {...sel}>{idText} </Text>
        </Box>
        <Box width={titleWidth} overflow="hidden">
          <Text {...(isSelected ? sel : { dimColor: true })}>{titleText}</Text>
        </Box>
      </Box>

      {/* Row 2: pad | category | priority | last activity ago */}
      <Box height={1}>
        {isIndented && <Box width={INDENT_WIDTH}><Text> </Text></Box>}
        <Box width={COL_ICON}><Text> </Text></Box>
        <Box width={COL_TYPE}>
          <Text {...selDim}>{category}</Text>
        </Box>
        <Box width={COL_PRI}>
          {pri.text ? (
            <Text {...(isSelected ? selDim : {})} color={isSelected ? 'white' : pri.color} bold={pri.bold} dimColor={!isSelected && pri.dim}>{priText}</Text>
          ) : (
            <Text> </Text>
          )}
        </Box>
        <Box overflow="hidden">
          {activityText ? (
            <Text {...selDim}>{activityText}</Text>
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
