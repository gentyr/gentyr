import React from 'react';
import { Box, Text } from 'ink';

export interface QuotaBarProps {
  label: string;
  percentage: number;
  width?: number;
}

export function QuotaBar({ label, percentage, width = 16 }: QuotaBarProps): React.ReactElement {
  const safe = Math.min(100, Math.max(0, percentage));
  const filled = Math.round((safe / 100) * width);
  const empty = width - filled;

  return (
    <Box>
      <Text dimColor>{label.padEnd(8)} </Text>
      <Text bold>{'\u2588'.repeat(filled)}</Text>
      <Text dimColor>{'\u2591'.repeat(empty)}</Text>
      <Text> {safe.toFixed(0).padStart(3)}%</Text>
    </Box>
  );
}
