/**
 * Page 3: Analytics — Usage Trends, Usage Trajectory, Automated Instances.
 * Two-column layout. Monochrome.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../Section.js';
import { QuotaBar } from '../QuotaBar.js';
import type { PageAnalyticsData, UsageSnapshot, AutomatedInstance } from '../../types.js';
import { formatNumber, formatTimestamp, truncate } from '../../utils/formatters.js';

interface Page3Props {
  data: PageAnalyticsData;
  scrollOffset: number;
  height: number;
  width: number;
}

// Simple ASCII sparkline from snapshot data
function sparkline(snapshots: UsageSnapshot[], width: number): string {
  if (snapshots.length === 0) return '';
  const chars = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
  const values = snapshots.map(s => s.utilization);
  const maxVal = Math.max(...values, 1);
  // Sample down to fit width
  const step = Math.max(1, Math.floor(values.length / width));
  let result = '';
  for (let i = 0; i < values.length && result.length < width; i += step) {
    const idx = Math.min(chars.length - 1, Math.floor((values[i] / maxVal) * (chars.length - 1)));
    result += chars[idx];
  }
  return result;
}

function UsageTrendsSection({ data, width }: { data: PageAnalyticsData['usage']; width: number }): React.ReactElement {
  if (!data.hasData) {
    return (
      <Section title="USAGE TRENDS" width={width} tip="/show usage">
        <Text dimColor>No usage data available</Text>
      </Section>
    );
  }

  const sparkW = Math.max(10, width - 20);
  const fiveHourSpark = sparkline(data.fiveHourSnapshots, sparkW);
  const sevenDaySpark = sparkline(data.sevenDaySnapshots, sparkW);
  const lastFive = data.fiveHourSnapshots.length > 0 ? data.fiveHourSnapshots[data.fiveHourSnapshots.length - 1].utilization : 0;
  const lastSeven = data.sevenDaySnapshots.length > 0 ? data.sevenDaySnapshots[data.sevenDaySnapshots.length - 1].utilization : 0;

  return (
    <Section title="USAGE TRENDS" width={width} tip="/show usage">
      <Text bold>5-Hour Window</Text>
      <Text dimColor>{fiveHourSpark}</Text>
      <QuotaBar label="Current" percentage={lastFive} width={Math.max(8, width - 20)} />
      <Text bold>{'7-Day Window'}</Text>
      <Text dimColor>{sevenDaySpark}</Text>
      <QuotaBar label="Current" percentage={lastSeven} width={Math.max(8, width - 20)} />
    </Section>
  );
}

function UsageTrajectorySection({ data, width }: { data: PageAnalyticsData['usage']; width: number }): React.ReactElement {
  if (!data.hasData) {
    return (
      <Section title="USAGE TRAJECTORY" width={width} tip="/show usage">
        <Text dimColor>No projection data</Text>
      </Section>
    );
  }

  return (
    <Section title="USAGE TRAJECTORY" width={width} tip="/show usage">
      <Box>
        <Text dimColor>Cooldown Factor </Text>
        <Text bold>{data.cooldownFactor.toFixed(1)}x</Text>
      </Box>
      <Box>
        <Text dimColor>Target </Text>
        <Text bold>{data.targetPct}%</Text>
      </Box>
      <Box>
        <Text dimColor>Projected at Reset </Text>
        <Text bold>{data.projectedAtResetPct != null ? `${data.projectedAtResetPct}%` : 'N/A'}</Text>
      </Box>
    </Section>
  );
}

function AutomatedInstancesSection({ instances, width }: { instances: AutomatedInstance[]; width: number }): React.ReactElement {
  if (instances.length === 0) {
    return (
      <Section title="AUTOMATED INSTANCES" width={width} tip="/show automations">
        <Text dimColor>No automation data</Text>
      </Section>
    );
  }

  const totalSessions = instances.reduce((s, i) => s + i.count, 0);
  const totalTokens = instances.reduce((s, i) => s + i.tokensTotal, 0);

  // Sort by tokens descending
  const sorted = [...instances].sort((a, b) => b.tokensTotal - a.tokensTotal);

  return (
    <Section title={`AUTOMATED INSTANCES (${totalSessions} total, ${formatNumber(totalTokens)} tokens)`} width={width} tip="/show automations">
      <Box flexDirection="column">
        <Box>
          <Text bold dimColor>{'Agent Type'.padEnd(22)}{'Count'.padStart(7)}{'Tokens'.padStart(10)}{'Share'.padStart(7)}</Text>
        </Box>
        {sorted.map(inst => {
          const share = totalTokens > 0 ? Math.round((inst.tokensTotal / totalTokens) * 100) : 0;
          return (
            <Box key={inst.type}>
              <Text>{truncate(inst.type, 21).padEnd(22)}</Text>
              <Text bold>{String(inst.count).padStart(7)}</Text>
              <Text dimColor>{formatNumber(inst.tokensTotal).padStart(10)}</Text>
              <Text dimColor>{`${share}%`.padStart(7)}</Text>
            </Box>
          );
        })}
      </Box>
    </Section>
  );
}

export function Page3({ data, scrollOffset, height, width }: Page3Props): React.ReactElement {
  const leftW = Math.floor(width / 2);
  const rightW = width - leftW - 1;

  return (
    <Box flexDirection="row" height={height}>
      {/* Left: Usage */}
      <Box flexDirection="column" width={leftW} height={height} overflow="hidden">
        <Box flexDirection="column" marginTop={-scrollOffset}>
          <UsageTrendsSection data={data.usage} width={leftW} />
          <Box marginTop={1}>
            <UsageTrajectorySection data={data.usage} width={leftW} />
          </Box>
        </Box>
      </Box>
      {/* Gap */}
      <Box width={1} />
      {/* Right: Automations */}
      <Box flexDirection="column" width={rightW} height={height} overflow="hidden">
        <Box flexDirection="column" marginTop={-scrollOffset}>
          <AutomatedInstancesSection instances={data.automatedInstances} width={rightW} />
        </Box>
      </Box>
    </Box>
  );
}
