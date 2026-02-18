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

function MetricBox({ title, metrics, width }: MetricBoxData & { width?: number }): React.ReactElement {
  return (
    <Section title={title} width={width} minWidth={16} paddingX={1}>
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

export function MetricGrid({ boxes, columns = 4 }: MetricGridProps): React.ReactElement {
  // Parent Section has 1-char border + 1-char padding on each side = 4 chars overhead
  const containerWidth = (process.stdout.columns || 80) - 4;
  const cols = Math.min(columns, boxes.length);
  const gaps = cols - 1;
  const baseWidth = Math.floor((containerWidth - gaps) / cols);
  const extraChars = (containerWidth - gaps) - baseWidth * cols;

  return (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {boxes.map((box, idx) => {
        // Distribute extra chars across first N boxes in each row
        const colIdx = idx % cols;
        const w = colIdx < extraChars ? baseWidth + 1 : baseWidth;
        return <MetricBox key={idx} {...box} width={w} />;
      })}
    </Box>
  );
}
