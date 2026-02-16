/**
 * Usage Trends Component
 *
 * Displays historical line graphs for 5-hour and 7-day usage.
 * Uses @pppp606/ink-chart LineGraph component.
 * Only shows actual historical data (no projections on graph).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { UsageSnapshot } from '../utils/trajectory.js';

export interface UsageTrendsProps {
  snapshots: UsageSnapshot[];
  hasData: boolean;
}

/**
 * Simple ASCII sparkline chart using block characters.
 * More reliable than external packages and works in all terminals.
 */
function Sparkline({
  data,
  width = 40,
  height = 3,
  color = 'cyan',
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}): React.ReactElement {
  if (data.length === 0) {
    return <Text color="gray">No data</Text>;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  // Normalize data to 0-1
  const normalized = data.map(v => (v - min) / range);

  // Resample to fit width
  const resampled: number[] = [];
  for (let i = 0; i < width; i++) {
    const srcIdx = Math.floor((i / width) * data.length);
    resampled.push(normalized[srcIdx]);
  }

  // Block characters from empty to full (8 levels)
  const blocks = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

  // Build multi-row chart
  const rows: string[] = [];
  for (let row = height - 1; row >= 0; row--) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const val = resampled[col];
      const rowBottom = row / height;
      const rowTop = (row + 1) / height;

      if (val >= rowTop) {
        // Full block
        line += '█';
      } else if (val > rowBottom) {
        // Partial block
        const fraction = (val - rowBottom) * height;
        const blockIdx = Math.round(fraction * 8);
        line += blocks[Math.min(8, Math.max(0, blockIdx))];
      } else {
        // Empty
        line += ' ';
      }
    }
    rows.push(line);
  }

  return (
    <Box flexDirection="column">
      {rows.map((row, idx) => (
        <Text key={idx} color={color}>{row}</Text>
      ))}
    </Box>
  );
}

/**
 * Format time ago string
 */
function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));

  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function UsageTrends({ snapshots, hasData }: UsageTrendsProps): React.ReactElement | null {
  if (!hasData || snapshots.length === 0) {
    return null;
  }

  // Extract data for charts
  const fiveHourData = snapshots.map(s => s.fiveHour);
  const sevenDayData = snapshots.map(s => s.sevenDay);

  // Get time range
  const firstTime = snapshots[0].timestamp;

  // Calculate current and min/max values
  const current5h = fiveHourData[fiveHourData.length - 1];
  const current7d = sevenDayData[sevenDayData.length - 1];
  const min5h = Math.min(...fiveHourData);
  const max5h = Math.max(...fiveHourData);
  const min7d = Math.min(...sevenDayData);
  const max7d = Math.max(...sevenDayData);

  return (
    <Section title="USAGE TRENDS" borderColor="blue" width="100%">
      <Box flexDirection="column" gap={1}>
        {/* 5-Hour Usage Chart */}
        <Box flexDirection="column">
          <Box>
            <Text color="cyan" bold>5-Hour Usage</Text>
            <Text color="gray"> ({snapshots.length} snapshots, </Text>
            <Text color="gray">{formatTimeAgo(firstTime)} to now)</Text>
          </Box>

          <Box marginTop={0}>
            <Sparkline data={fiveHourData} width={74} height={3} color="cyan" />
          </Box>

          <Box gap={2}>
            <Box>
              <Text color="gray">Current: </Text>
              <Text color="white">{Math.round(current5h)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Min: </Text>
              <Text color="green">{Math.round(min5h)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Max: </Text>
              <Text color="yellow">{Math.round(max5h)}%</Text>
            </Box>
          </Box>
        </Box>

        {/* 7-Day Usage Chart */}
        <Box flexDirection="column">
          <Box>
            <Text color="magenta" bold>7-Day Usage</Text>
          </Box>

          <Box marginTop={0}>
            <Sparkline data={sevenDayData} width={74} height={3} color="magenta" />
          </Box>

          <Box gap={2}>
            <Box>
              <Text color="gray">Current: </Text>
              <Text color="white">{Math.round(current7d)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Min: </Text>
              <Text color="green">{Math.round(min7d)}%</Text>
            </Box>
            <Box>
              <Text color="gray">Max: </Text>
              <Text color="yellow">{Math.round(max7d)}%</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    </Section>
  );
}
