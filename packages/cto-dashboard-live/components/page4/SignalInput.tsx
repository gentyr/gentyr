/**
 * SignalInput — signal input bar at the bottom of the observe panel.
 *
 * States:
 *   inactive: shows "Press 's' to send a signal"
 *   active:   shows "> " + typed text + block cursor
 *   sent:     shows "Sent: {message} ✓" for 5 seconds after sending
 *
 * Keystroke handling is done in the parent (Page4) via useInput.
 * This component is purely presentational.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { truncate } from '../../utils/formatters.js';

interface SignalInputProps {
  active: boolean;
  text: string;
  lastSent: string | null;
  width: number;
}

export function SignalInput({ active, text, lastSent, width }: SignalInputProps): React.ReactElement {
  const innerWidth = Math.max(10, width - 4);

  if (lastSent !== null && !active) {
    return (
      <Box flexDirection="row">
        <Text color="green">Sent: </Text>
        <Text color="green" bold>{truncate(lastSent, innerWidth - 12)}</Text>
        <Text color="green"> </Text>
      </Box>
    );
  }

  if (active) {
    return (
      <Box flexDirection="row">
        <Text bold color="cyan">{'> '}</Text>
        <Text>{text}</Text>
        <Text inverse>{' '}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row">
      <Text dimColor>Press </Text>
      <Text bold inverse>{' s '}</Text>
      <Text dimColor> to send a directive signal</Text>
    </Box>
  );
}
