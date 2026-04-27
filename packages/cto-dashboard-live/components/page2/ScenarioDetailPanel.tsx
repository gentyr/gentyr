/**
 * ScenarioDetailPanel — middle panel showing scenario details and run history.
 *
 * Displays:
 *   - Scenario description (word-wrapped)
 *   - Last passed timestamp
 *   - Run history with pass/fail/stopped/killed/interrupted status
 *   - Recording path for last successful run
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { ScenarioDetailData, DemoResultHistoryItem, DemoFailureReason } from '../../types.js';
import { formatElapsed, truncate } from '../../utils/formatters.js';

interface ScenarioDetailPanelProps {
  detail: ScenarioDetailData | null;
  height: number;
  width: number;
}

function agoLabel(isoStr: string | null): string {
  if (!isoStr) return 'never';
  try {
    const ms = Date.now() - new Date(isoStr).getTime();
    return formatElapsed(Math.max(0, ms)) + ' ago';
  } catch { return '?'; }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m${remainSecs > 0 ? `${remainSecs}s` : ''}`;
}

function failureReasonLabel(reason: DemoFailureReason): string {
  switch (reason) {
    case 'stopped': return 'stopped by user';
    case 'killed': return 'process killed';
    case 'interrupted': return 'interrupted (Esc)';
    case 'test_failure': return 'test failure';
    default: return 'failed';
  }
}

function statusIcon(item: DemoResultHistoryItem): { icon: string; color: string } {
  if (item.status === 'passed') return { icon: '\u2713', color: 'green' };
  switch (item.failureReason) {
    case 'stopped': return { icon: '\u25A0', color: 'yellow' };
    case 'interrupted': return { icon: '\u238C', color: 'yellow' };
    case 'killed': return { icon: '\u2620', color: 'red' };
    default: return { icon: '\u2717', color: 'red' };
  }
}

function HistoryRow({ item, width }: { item: DemoResultHistoryItem; width: number }): React.ReactElement {
  const { icon, color } = statusIcon(item);
  const mode = item.executionMode === 'remote' ? 'R' : 'L';
  const duration = formatDuration(item.durationMs);
  const ago = agoLabel(item.completedAt);

  const statusText = item.status === 'passed'
    ? `passed (${mode})`
    : failureReasonLabel(item.failureReason);

  const rightInfo = `${duration} \u00B7 ${ago}`;
  const maxStatusWidth = Math.max(4, width - rightInfo.length - 5);

  return (
    <Box height={1}>
      <Text color={color}> {icon} </Text>
      <Box width={Math.min(maxStatusWidth, statusText.length + 1)}>
        <Text color={color === 'green' ? undefined : color}>{truncate(statusText, maxStatusWidth)}</Text>
      </Box>
      <Box flexGrow={1} />
      <Text dimColor>{rightInfo} </Text>
    </Box>
  );
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function ScenarioDetailPanel({ detail, height, width }: ScenarioDetailPanelProps): React.ReactElement {
  if (!detail) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  Select a scenario to view details</Text>
      </Box>
    );
  }

  const innerWidth = Math.max(10, width - 2);
  const { scenario, history, lastPassedAt, lastSuccessRecordingPath } = detail;

  // Word-wrap description — cap at 4 lines
  const descLines = wrapText(scenario.description, innerWidth).slice(0, 4);
  const descHeight = descLines.length;

  // Header section: description + last passed + recording path
  const headerLines = descHeight + 2 + (lastSuccessRecordingPath ? 1 : 0); // desc + blank + lastPassed + recording
  const historyHeight = Math.max(1, height - headerLines - 1); // -1 for history header

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {/* Description */}
      {descLines.map((line, i) => (
        <Box key={i} height={1}>
          <Text dimColor wrap="truncate"> {line}</Text>
        </Box>
      ))}

      {/* Last passed */}
      <Box height={1}>
        <Text> </Text>
        <Text dimColor>Last passed: </Text>
        <Text color={lastPassedAt ? 'green' : 'yellow'}>{lastPassedAt ? agoLabel(lastPassedAt) : 'never'}</Text>
      </Box>

      {/* Recording path */}
      {lastSuccessRecordingPath && (
        <Box height={1}>
          <Text dimColor> Video: </Text>
          <Text color="cyan">{truncate(lastSuccessRecordingPath, innerWidth - 8)}</Text>
        </Box>
      )}

      {/* History header */}
      <Box height={1}>
        <Text dimColor> {'─'.repeat(Math.max(1, innerWidth - 1))}</Text>
      </Box>

      {/* History list */}
      <Box flexDirection="column" height={historyHeight} overflow="hidden">
        {history.length === 0 ? (
          <Text dimColor>  No run history</Text>
        ) : (
          history.slice(0, historyHeight).map((item) => (
            <HistoryRow key={item.id} item={item} width={innerWidth} />
          ))
        )}
      </Box>
    </Box>
  );
}
