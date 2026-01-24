/**
 * MetricGrid component - displays a grid of metric cards in nested boxes
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';

export interface MetricBoxData {
  title: string;
  metrics: Array<{ label: string; value: string | number; color?: string }>;
}

export interface MetricGridProps {
  boxes: MetricBoxData[];
  columns?: number;
}

function MetricBox({ title, metrics }: MetricBoxData): React.ReactElement {
  return (
    <Section title={title} minWidth={16} paddingX={1}>
      {metrics.map((metric, idx) => (
        <Box key={idx}>
          <Text color="gray">{metric.label}: </Text>
          <Text color={metric.color || 'white'} bold>
            {metric.value}
          </Text>
        </Box>
      ))}
    </Section>
  );
}

export function MetricGrid({ boxes }: MetricGridProps): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {boxes.map((box, idx) => (
        <MetricBox key={idx} {...box} />
      ))}
    </Box>
  );
}
