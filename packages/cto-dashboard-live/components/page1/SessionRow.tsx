/**
 * SessionRow — Ink native bordered card.
 * Title in <Box borderStyle> (single <Text> child, avoids Ink multi-line bug).
 * Detail/description below as plain <Text> (outside the border).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { SessionItem } from '../../types.js';
import { formatElapsed, formatTokens, truncate } from '../../utils/formatters.js';

interface SessionRowProps {
  item: SessionItem;
  selected: boolean;
  width: number;
  indent?: number;
}

const COL_PRI = 7;
const COL_STATUS = 10;
const COL_AGENT = 16;

function statusLabel(status: string): string {
  switch (status) {
    case 'alive': return 'RUNNING';
    case 'queued': return 'QUEUED';
    case 'spawning': return 'SPAWNING';
    case 'suspended': return 'SUSPENDED';
    case 'paused': return 'PAUSED';
    case 'completed': return 'DONE';
    case 'failed': return 'FAILED';
    case 'killed': return 'KILLED';
    default: return status.toUpperCase();
  }
}

function priorityCol(priority: string): string {
  if (priority === 'cto') return '[CTO] ';
  if (priority === 'critical') return '[CRIT]';
  if (priority === 'urgent') return '[URG] ';
  return '      ';
}

export function estimateCardLines(item: SessionItem): number {
  let h = 3; // border top + title + border bottom
  if (item.pid || (item.elapsed && item.status !== 'queued') || item.lastAction) h += 1;
  const lastAge = item.lastActionTimestamp
    ? formatElapsed(Date.now() - new Date(item.lastActionTimestamp).getTime()) + ' ago'
    : '';
  const tok = item.totalTokens != null ? formatTokens(item.totalTokens) : '';
  if (lastAge || tok) h += 1;
  if (item.lastMessage || item.description || item.worklog?.summary) h += 1;
  if (item.killReason) h += 1;
  if (item.worklog) h += 1;
  return h;
}

export function SessionRow({ item, selected, width, indent = 0 }: SessionRowProps): React.ReactElement {
  const cardW = Math.max(20, width - indent);
  const innerW = cardW - 4;

  const pri = priorityCol(item.priority).padEnd(COL_PRI);
  const status = statusLabel(item.status).padEnd(COL_STATUS);
  const agent = truncate(item.agentType, COL_AGENT - 1).padEnd(COL_AGENT);
  const titleW = Math.max(4, innerW - COL_PRI - COL_STATUS - COL_AGENT);
  const titleText = truncate(item.title, titleW);
  const titleLine = `${pri}${status}${agent}${titleText}`;

  // Detail parts
  const detailParts: string[] = [];
  if (item.pid) detailParts.push(`PID ${item.pid}`);
  if (item.elapsed && item.status !== 'queued') detailParts.push(item.elapsed);
  if (item.lastAction) detailParts.push(truncate(item.lastAction, 28));
  const lastAge = item.lastActionTimestamp
    ? formatElapsed(Date.now() - new Date(item.lastActionTimestamp).getTime()) + ' ago'
    : '';
  if (lastAge) detailParts.push(lastAge);
  const tok = item.totalTokens != null ? formatTokens(item.totalTokens) : '';
  if (tok) detailParts.push(tok);
  const detailStr = detailParts.length > 0 ? detailParts.join('  ') : null;

  const msgText = item.lastMessage || item.description || (item.worklog ? item.worklog.summary : null);

  const pad = indent + 2;

  return (
    <Box marginLeft={indent} flexDirection="column" width={cardW}>
      {/* Bordered title — single <Text> child to avoid Ink multi-line bug */}
      <Box
        borderStyle="round"
        borderColor={selected ? 'white' : undefined}
        borderDimColor={!selected}
        width={cardW}
        paddingX={1}
      >
        <Text bold={selected} wrap="truncate-end">{truncate(titleLine, innerW)}</Text>
      </Box>

      {/* Detail, description, worklog — outside the border, indented */}
      {detailStr && (
        <Box marginLeft={pad}><Text dimColor wrap="truncate-end">{truncate(detailStr, cardW - pad - 2)}</Text></Box>
      )}
      {msgText && (
        <Box marginLeft={pad}><Text dimColor wrap="truncate-end">{truncate(msgText, cardW - pad - 2)}</Text></Box>
      )}
      {item.killReason && (
        <Box marginLeft={pad}><Text dimColor wrap="truncate-end">{truncate(`Reason: ${item.killReason}`, cardW - pad - 2)}</Text></Box>
      )}
      {item.worklog && (
        <Box marginLeft={pad}>
          <Text wrap="truncate-end">
            <Text bold>{item.worklog.success ? 'OK' : 'FAIL'}</Text>
            <Text dimColor>{' '}{item.worklog.durationMs != null ? formatElapsed(item.worklog.durationMs) : '-'} {formatTokens(item.worklog.tokens)}</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
