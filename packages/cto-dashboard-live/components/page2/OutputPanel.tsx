/**
 * OutputPanel — displays live output from a running demo or test process.
 * Status bar at top, scrolling text lines below.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { RunningProcess } from '../../types.js';
import { truncate, formatElapsed } from '../../utils/formatters.js';

interface OutputPanelProps {
  proc: RunningProcess | null;
  lines: string[];
  height: number;
  width: number;
}

const DOT = '\u25CF';

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'green';
    case 'passed':  return 'green';
    case 'failed':  return 'red';
    default:        return 'gray';
  }
}

function StatusBar({ proc, width }: { proc: RunningProcess; width: number }): React.ReactElement {
  const elapsed = formatElapsed(Math.max(0, Date.now() - new Date(proc.startedAt).getTime()));
  const color = statusColor(proc.status);

  if (proc.status === 'running') {
    const info = `Running: ${proc.label} | PID ${proc.pid} | ${elapsed}`;
    return (
      <Box height={1}>
        <Text color={color} bold>{DOT} </Text>
        <Text bold>{truncate(info, width - 3)}</Text>
      </Box>
    );
  }

  const label = proc.status === 'passed' ? 'Passed' : `Failed (exit ${proc.exitCode ?? '?'})`;
  const info = `${label}: ${proc.label} | ${elapsed}`;
  return (
    <Box height={1}>
      <Text color={color} bold>{DOT} </Text>
      <Text {...(proc.status === 'passed' ? { color: 'green' as const } : { color: 'red' as const })} bold>
        {truncate(info, width - 3)}
      </Text>
    </Box>
  );
}

export function OutputPanel({ proc, lines, height, width }: OutputPanelProps): React.ReactElement {
  if (!proc) {
    return (
      <Box flexDirection="column" height={height}>
        <Text dimColor>  Select a demo or test and press Enter to run</Text>
      </Box>
    );
  }

  const textHeight = Math.max(1, height - 1);
  const visibleLines = lines.slice(-textHeight);

  return (
    <Box flexDirection="column" height={height}>
      <StatusBar proc={proc} width={width} />
      <Box flexDirection="column" height={textHeight} overflow="hidden">
        {visibleLines.map((line, i) => (
          <Box key={i} height={1} overflow="hidden">
            <Text dimColor>{truncate(line, width)}</Text>
          </Box>
        ))}
        {visibleLines.length === 0 && (
          <Text dimColor>  Waiting for output...</Text>
        )}
      </Box>
    </Box>
  );
}
