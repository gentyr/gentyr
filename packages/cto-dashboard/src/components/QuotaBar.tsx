/**
 * QuotaBar component - displays a progress bar with percentage
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface QuotaBarProps {
  label: string;
  percentage: number;
  width?: number;
  showLabel?: boolean;
}

function getBarColor(percentage: number): string {
  if (percentage >= 90) return 'red';
  if (percentage >= 75) return 'yellow';
  return 'green';
}

export function QuotaBar({
  label,
  percentage,
  width = 20,
  showLabel = true,
}: QuotaBarProps): React.ReactElement {
  const safePercentage = Math.min(100, Math.max(0, percentage));
  const filled = Math.round((safePercentage / 100) * width);
  const empty = width - filled;

  const filledBar = '\u2588'.repeat(filled);  // Full block
  const emptyBar = '\u2591'.repeat(empty);    // Light shade

  const barColor = getBarColor(safePercentage);

  return (
    <Box>
      {showLabel && (
        <Text color="gray">{label.padEnd(8)} </Text>
      )}
      <Text color={barColor}>{filledBar}</Text>
      <Text color="gray">{emptyBar}</Text>
      <Text color="white"> {safePercentage.toFixed(0).padStart(3)}%</Text>
    </Box>
  );
}
