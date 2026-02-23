/**
 * Worklog Section Component
 *
 * Shows recent agent work log entries with duration, tokens, and success/failure status.
 * Bottom metrics block shows 30-day rolling averages.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import type { WorklogData, WorklogMetricsData } from '../utils/worklog-reader.js';
import { formatNumber } from '../utils/formatters.js';

export interface WorklogSectionProps {
  data: WorklogData;
  tip?: string;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m`;
}

function formatTokens(total: number | null): string {
  if (total == null) return '-';
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(0)}K`;
  return String(total);
}

function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function EntryRow({ entry }: { entry: import('../utils/worklog-reader.js').WorklogEntryData }): React.ReactElement {
  const time = formatTimeAgo(entry.created_at).padEnd(8);
  const section = entry.section.substring(0, 14).padEnd(14);
  const title = entry.title.length > 22 ? entry.title.substring(0, 19) + '...' : entry.title.padEnd(22);
  const result = entry.success ? ' OK ' : 'FAIL';
  const resultColor = entry.success ? 'green' : 'red';
  const duration = formatDuration(entry.duration_start_to_complete_ms).padStart(9);
  const tokens = formatTokens(entry.tokens_total).padStart(6);

  return (
    <Box>
      <Text color="gray">{time}</Text>
      <Text color="cyan">{section}</Text>
      <Text color="white">{title}</Text>
      <Text color={resultColor}> {result} </Text>
      <Text color="gray">{duration}</Text>
      <Text color="gray">{tokens}</Text>
    </Box>
  );
}

function MetricsBlock({ metrics }: { metrics: WorklogMetricsData }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="gray">Coverage: </Text>
        <Text color="white">{metrics.coverage_entries} of {metrics.coverage_completed_tasks} completed tasks</Text>
        <Text color="gray"> ({metrics.coverage_pct}%)</Text>
      </Box>
      <Box>
        <Text color="gray">Avg time-to-start: </Text>
        <Text color="white">{formatDuration(metrics.avg_time_to_start_ms)}</Text>
        <Text color="gray">    Avg tokens/task: </Text>
        <Text color="white">{metrics.avg_tokens_per_task != null ? formatNumber(metrics.avg_tokens_per_task) : '-'}</Text>
      </Box>
      <Box>
        <Text color="gray">Avg time-to-complete: </Text>
        <Text color="white">{formatDuration(metrics.avg_time_to_complete_from_start_ms)}</Text>
        <Text color="gray">  Cache hit rate: </Text>
        <Text color="white">{metrics.cache_hit_pct != null ? `${metrics.cache_hit_pct}%` : '-'}</Text>
      </Box>
      <Box>
        <Text color="gray">Avg total turnaround: </Text>
        <Text color="white">{formatDuration(metrics.avg_time_to_complete_from_assign_ms)}</Text>
        <Text color="gray">  Success rate: </Text>
        <Text color={metrics.success_rate_pct != null && metrics.success_rate_pct >= 80 ? 'green' : metrics.success_rate_pct != null && metrics.success_rate_pct >= 50 ? 'yellow' : 'red'}>{metrics.success_rate_pct != null ? `${metrics.success_rate_pct}%` : '-'}</Text>
      </Box>
    </Box>
  );
}

export function WorklogSection({ data, tip }: WorklogSectionProps): React.ReactElement {
  if (!data.hasData || data.entries.length === 0) {
    return (
      <Section title="WORKLOG" borderColor="yellow" tip={tip}>
        <Text color="gray">No worklog entries yet. Agents call summarize_work to record completed tasks.</Text>
      </Section>
    );
  }

  return (
    <Section title={`WORKLOG (${data.entries.length} recent)`} borderColor="yellow" tip={tip}>
      <Box flexDirection="column">
        {/* Header */}
        <Box>
          <Text color="gray" bold>{'Time'.padEnd(8)}</Text>
          <Text color="gray" bold>{'Section'.padEnd(14)}</Text>
          <Text color="gray" bold>{'Title'.padEnd(22)}</Text>
          <Text color="gray" bold>{' Res  '}</Text>
          <Text color="gray" bold>{'Duration'.padStart(9)}</Text>
          <Text color="gray" bold>{'Tokens'.padStart(6)}</Text>
        </Box>

        {/* Entries */}
        {data.entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}

        {/* Metrics */}
        {data.metrics && <MetricsBlock metrics={data.metrics} />}
      </Box>
    </Section>
  );
}
