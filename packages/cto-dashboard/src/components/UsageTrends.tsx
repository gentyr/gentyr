/**
 * Usage Trends Component
 *
 * Displays historical line graphs for 5-hour and 7-day usage.
 * Uses custom AreaChart with line on top and shaded fill below.
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
 * ASCII area chart with line on top and shaded fill below.
 * Shows Y-axis percentage values on the left.
 */
function AreaChart({
  data,
  width = 40,
  height = 5,
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

  // Auto-scale Y-axis: floor to 0, ceiling to nearest 10 above max (or 100)
  const dataMin = Math.min(...data);
  const dataMax = Math.max(...data);
  const min = Math.max(0, Math.floor(dataMin / 10) * 10 - 10);
  const max = Math.min(100, Math.ceil(dataMax / 10) * 10 + 10);
  const range = max - min || 1;

  // Normalize data to 0-1
  const normalized = data.map(v => Math.max(0, Math.min(1, (v - min) / range)));

  // Resample to fit width (excluding Y-axis labels)
  const chartWidth = width - 5; // Reserve 5 chars for Y-axis labels
  const resampled: number[] = [];
  for (let i = 0; i < chartWidth; i++) {
    const srcIdx = Math.floor((i / chartWidth) * data.length);
    resampled.push(normalized[srcIdx]);
  }

  // Build multi-row chart (labels separate from chart content for color control)
  const labels: string[] = [];
  const chartLines: string[] = [];
  for (let row = 0; row < height; row++) {
    const rowValue = Math.round(max - (row / (height - 1)) * range);

    // Y-axis label (right-aligned in 4 chars + separator)
    labels.push(`${rowValue}%`.padStart(4) + '│');

    // Build chart row
    let chartLine = '';
    for (let col = 0; col < chartWidth; col++) {
      const val = resampled[col];
      const rowTop = 1 - (row / height);
      const rowBottom = 1 - ((row + 1) / height);
      // Check previous value for line slope
      const prevVal = col > 0 ? resampled[col - 1] : val;

      // Determine if this position is on the line or below it
      const isOnLine = val >= rowBottom && val <= rowTop;
      const isBelowLine = val > rowTop;

      if (isOnLine) {
        // Draw line character based on slope
        if (Math.abs(val - prevVal) < 0.02) {
          chartLine += '─';
        } else if (val > prevVal) {
          chartLine += '╱';
        } else {
          chartLine += '╲';
        }
      } else if (isBelowLine) {
        // Solid fill below the line
        chartLine += '█';
      } else {
        chartLine += ' ';
      }
    }

    chartLines.push(chartLine);
  }

  return (
    <Box flexDirection="column">
      {labels.map((label, idx) => (
        <Box key={idx}>
          <Text color="gray">{label}</Text>
          <Text color={color} dimColor={idx === 0 || idx === labels.length - 1}>{chartLines[idx]}</Text>
        </Box>
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
            <AreaChart data={fiveHourData} width={74} height={5} color="cyan" />
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
            <AreaChart data={sevenDayData} width={74} height={5} color="magenta" />
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
