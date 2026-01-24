/**
 * MetricCard component - displays a label + value pair
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface MetricCardProps {
  label: string;
  value: string | number;
  color?: string;
  valueColor?: string;
  width?: number;
}

export function MetricCard({
  label,
  value,
  color = 'white',
  valueColor = 'green',
  width,
}: MetricCardProps): React.ReactElement {
  return (
    <Box width={width}>
      <Text color={color}>{label}: </Text>
      <Text color={valueColor} bold>
        {value}
      </Text>
    </Box>
  );
}

export interface MetricRowProps {
  metrics: Array<{ label: string; value: string | number; color?: string }>;
}

export function MetricRow({ metrics }: MetricRowProps): React.ReactElement {
  return (
    <Box flexDirection="row" gap={2}>
      {metrics.map((metric, idx) => (
        <MetricCard
          key={idx}
          label={metric.label}
          value={metric.value}
          valueColor={metric.color}
        />
      ))}
    </Box>
  );
}
