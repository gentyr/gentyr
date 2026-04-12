/**
 * SignalInput — signal input bar at the bottom of the observe panel.
 * Purely presentational. Keystroke handling is in ObserveView.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../../utils/formatters.js';

interface SignalInputProps {
  active: boolean;
  text: string;
  lastStatus: string | null;
  width: number;
  isCompleted?: boolean;
}

export function SignalInput({ active, text, lastStatus, width, isCompleted }: SignalInputProps): React.ReactElement {
  const innerWidth = Math.max(10, width - 4);

  if (lastStatus !== null && !active) {
    const isPending = lastStatus.startsWith('Pending:');
    const isQueued = lastStatus.startsWith('Queued:');
    const isResumed = lastStatus.startsWith('Resumed:');
    const isError = lastStatus.startsWith('ERROR:');
    const isAcked = lastStatus.startsWith("Ack'd:");
    const isDelivered = lastStatus.startsWith('Delivered:');
    const color = isError ? 'red' : isAcked ? 'green' : isDelivered ? 'cyan' : isResumed ? 'cyan' : (isPending || isQueued) ? 'yellow' : 'cyan';
    const hint = isPending ? ' (waiting for agent tool call...)'
      : isQueued ? ' (agent busy, will deliver on next tool call)'
      : isResumed ? ' (opened in new Terminal)'
      : '';
    return (
      <Box flexDirection="row">
        <Text color={color}>{truncate(lastStatus, innerWidth)}</Text>
        {hint && <Text dimColor>{hint}</Text>}
      </Box>
    );
  }

  if (active) {
    return (<Box flexDirection="row"><Text bold color="cyan">{'> '}</Text><Text>{text}</Text><Text inverse>{' '}</Text></Box>);
  }

  const hint = isCompleted ? 'to resume session with a message' : 'to send a message to this agent';
  return (<Box flexDirection="row"><Text dimColor>Press </Text><Text bold inverse>{' \u23CE '}</Text><Text dimColor> {hint}</Text></Box>);
}
