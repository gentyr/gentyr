/**
 * Main Dashboard App component
 *
 * Layout:
 * - Header with title and timestamp
 * - Quota & Capacity (full width)
 * - System Status (full width)
 * - Timeline (full width)
 * - Metrics Summary (grid of metric boxes)
 */

import React from 'react';
import { Box, Text } from 'ink';
import {
  Section,
  QuotaBar,
  Timeline,
  MetricGrid,
  Automations,
  UsageTrends,
  UsageTrajectory,
  AutomatedInstances,
  FeedbackPersonas,
  DeputyCtoSection,
  TestingSection,
  DeploymentsSection,
  InfraSection,
  LoggingSection,
  AccountOverviewSection,
  type MetricBoxData,
} from './components/index.js';
import type { DashboardData } from './utils/data-reader.js';
import type { TimelineEvent } from './components/TimelineItem.js';
import type { TrajectoryResult } from './utils/trajectory.js';
import type { AutomatedInstancesData } from './utils/automated-instances.js';
import type { DeputyCtoData } from './utils/deputy-cto-reader.js';
import type { TestingData } from './utils/testing-reader.js';
import type { DeploymentsData } from './utils/deployments-reader.js';
import type { InfraData } from './utils/infra-reader.js';
import type { LoggingData } from './utils/logging-reader.js';
import type { AccountOverviewData } from './utils/account-overview-reader.js';
import { formatNumber, formatDateTime, formatTime12h, formatDelta, calculateCacheRate } from './utils/formatters.js';

interface AppProps {
  data: DashboardData;
  timelineEvents: TimelineEvent[];
  trajectory: TrajectoryResult;
  automatedInstances: AutomatedInstancesData;
  deputyCto: DeputyCtoData;
  testing: TestingData;
  deployments: DeploymentsData;
  infra: InfraData;
  logging: LoggingData;
  accountOverview: AccountOverviewData;
}

function Header({ data }: { data: DashboardData }): React.ReactElement {
  return (
    <Section borderColor="cyan">
      <Box justifyContent="space-between">
        <Box flexDirection="column">
          <Text color="cyan" bold>GENTYR CTO DASHBOARD</Text>
          <Text color="gray">Generated: {formatDateTime(data.generated_at)}</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text color="gray">Period: Last {data.hours}h</Text>
        </Box>
      </Box>
    </Section>
  );
}

function QuotaSection({ data, width }: { data: DashboardData; width?: number | string }): React.ReactElement {
  const { verified_quota } = data;
  const { aggregate } = verified_quota;

  const activeKeys = verified_quota.healthy_count;
  const fiveHourPct = aggregate.five_hour?.utilization ?? 0;
  const sevenDayPct = aggregate.seven_day?.utilization ?? 0;
  const title = `QUOTA & CAPACITY (${activeKeys} key${activeKeys !== 1 ? 's' : ''})`;

  return (
    <Section title={title} width={width ?? "100%"}>
      {aggregate.error ? (
        <Text color="red">Error: {aggregate.error}</Text>
      ) : (
        <Box flexDirection="column">
          <QuotaBar label="5-hour" percentage={fiveHourPct} width={16} />
          <QuotaBar label="7-day" percentage={sevenDayPct} width={16} />
          {verified_quota.rotation_events_24h > 0 && (
            <Text color="gray">Rotations (24h): {verified_quota.rotation_events_24h}</Text>
          )}
        </Box>
      )}
    </Section>
  );
}

function SystemStatusSection({ data, width }: { data: DashboardData; width?: number | string }): React.ReactElement {
  const { autonomous_mode, system_health, pending_items } = data;

  const deputyStatus = autonomous_mode.enabled ? 'ENABLED' : 'DISABLED';
  const deputyColor = autonomous_mode.enabled ? 'green' : 'gray';

  // Format deputy CTO timing info
  const intervalText = `Runs every ${autonomous_mode.interval_minutes}m`;
  const nextTimeText = autonomous_mode.next_run_time
    ? formatTime12h(autonomous_mode.next_run_time)
    : 'N/A';
  const deltaText = autonomous_mode.seconds_until_next != null
    ? formatDelta(autonomous_mode.seconds_until_next)
    : 'N/A';

  const protectionStatus = system_health.protection_status.toUpperCase();
  const protectionColor = system_health.protection_status === 'protected' ? 'green'
    : system_health.protection_status === 'unprotected' ? 'red'
    : 'yellow';

  const commitStatus = pending_items.commits_blocked ? 'BLOCKED' : 'ALLOWED';
  const commitColor = pending_items.commits_blocked ? 'red' : 'green';

  return (
    <Section title="SYSTEM STATUS" width={width ?? "100%"}>
      <Box flexDirection="column">
        <Box>
          <Text color="gray">Deputy CTO: </Text>
          <Text color={deputyColor} bold>{deputyStatus}</Text>
        </Box>
        {autonomous_mode.enabled && (
          <Box marginLeft={2}>
            <Text color="gray">{intervalText} | Next: </Text>
            <Text color="cyan">{nextTimeText}</Text>
            <Text color="gray"> (</Text>
            <Text color="yellow">{deltaText}</Text>
            <Text color="gray">)</Text>
          </Box>
        )}
        <Box>
          <Text color="gray">Protection: </Text>
          <Text color={protectionColor} bold>{protectionStatus}</Text>
        </Box>
        <Box>
          <Text color="gray">Commits:    </Text>
          <Text color={commitColor} bold>{commitStatus}</Text>
        </Box>
      </Box>
    </Section>
  );
}

function MetricsSummary({ data }: { data: DashboardData }): React.ReactElement {
  const { token_usage, sessions, agents, tasks, hooks, triage, pending_items, usage_projection } = data;

  const cacheRate = calculateCacheRate(token_usage.cache_read, token_usage.input);

  const boxes: MetricBoxData[] = [
    {
      title: 'Tokens',
      metrics: [
        { label: 'In', value: formatNumber(token_usage.input), color: 'white' },
        { label: 'Out', value: formatNumber(token_usage.output), color: 'white' },
        { label: 'Cache', value: `${cacheRate}%`, color: cacheRate >= 80 ? 'green' : 'yellow' },
      ],
    },
    {
      title: 'Sessions',
      metrics: [
        { label: 'Task', value: sessions.task_triggered, color: 'cyan' },
        { label: 'User', value: sessions.user_triggered, color: 'blue' },
        { label: 'Total', value: sessions.task_triggered + sessions.user_triggered, color: 'white' },
      ],
    },
    {
      title: 'Agents',
      metrics: [
        { label: 'Spawns', value: agents.spawns_24h, color: 'magenta' },
        { label: 'Types', value: Object.keys(agents.by_type).length, color: 'white' },
      ],
    },
    {
      title: 'Tasks',
      metrics: [
        { label: 'Pending', value: tasks.pending_total, color: tasks.pending_total > 0 ? 'yellow' : 'green' },
        { label: 'Active', value: tasks.in_progress_total, color: 'cyan' },
        { label: 'Done', value: tasks.completed_24h, color: 'green' },
      ],
    },
    {
      title: 'Hooks (24h)',
      metrics: [
        { label: 'Total', value: hooks.total_24h, color: 'white' },
        { label: 'Success', value: `${hooks.success_rate}%`, color: hooks.success_rate >= 95 ? 'green' : 'yellow' },
        { label: 'Skipped', value: hooks.skipped_24h, color: hooks.skipped_24h > 0 ? 'gray' : 'green' },
        { label: 'Failures', value: hooks.recent_failures.length, color: hooks.recent_failures.length > 0 ? 'red' : 'green' },
      ],
    },
    {
      title: 'Triage',
      metrics: [
        { label: 'Pending', value: triage.pending, color: triage.pending > 0 ? 'yellow' : 'green' },
        { label: 'Handled', value: triage.self_handled_24h, color: 'green' },
        { label: 'Escalated', value: triage.escalated_24h, color: triage.escalated_24h > 0 ? 'yellow' : 'gray' },
      ],
    },
    {
      title: 'CTO Queue',
      metrics: [
        { label: 'Questions', value: pending_items.cto_questions, color: pending_items.cto_questions > 0 ? 'yellow' : 'green' },
        { label: 'Rejections', value: pending_items.commit_rejections, color: pending_items.commit_rejections > 0 ? 'red' : 'green' },
        { label: 'Triage', value: pending_items.pending_triage, color: pending_items.pending_triage > 0 ? 'yellow' : 'green' },
      ],
    },
    {
      title: 'Cooldowns',
      metrics: [
        { label: 'Factor', value: `${usage_projection.factor.toFixed(1)}x`, color: usage_projection.factor > 1 ? 'yellow' : 'green' },
        { label: 'Target', value: `${usage_projection.target_pct}%`, color: 'white' },
        {
          label: 'Proj',
          value: usage_projection.projected_at_reset_pct != null
            ? `${usage_projection.projected_at_reset_pct}%`
            : (usage_projection.last_updated != null ? 'N/A' : 'No data'),
          color: usage_projection.projected_at_reset_pct != null
            ? (usage_projection.projected_at_reset_pct > usage_projection.target_pct + 5 ? 'yellow' : 'cyan')
            : 'gray',
        },
      ],
    },
  ];

  return (
    <Section title="METRICS SUMMARY" borderColor="green">
      <MetricGrid boxes={boxes} />
    </Section>
  );
}

export function App({ data, timelineEvents, trajectory, automatedInstances, deputyCto, testing, deployments, infra, logging, accountOverview }: AppProps): React.ReactElement {
  // Compute explicit widths for side-by-side sections
  const termCols = process.stdout.columns || 80;
  const leftWidth = Math.floor((termCols - 1) / 2);  // -1 for gap
  const rightWidth = termCols - leftWidth - 1;

  return (
    <Box flexDirection="column" padding={0}>
      {/* Header */}
      <Header data={data} />

      {/* Quota & System Status - side by side */}
      <Box marginTop={1} flexDirection="row" gap={1}>
        <QuotaSection data={data} width={leftWidth} />
        <SystemStatusSection data={data} width={rightWidth} />
      </Box>

      {/* Account Overview */}
      {accountOverview.hasData && (
        <Box marginTop={1}>
          <AccountOverviewSection data={accountOverview} />
        </Box>
      )}

      {/* Deputy CTO triage pipeline */}
      {deputyCto.hasData && (
        <Box marginTop={1}>
          <DeputyCtoSection data={deputyCto} />
        </Box>
      )}

      {/* Usage Trends - line graphs (only if data available) */}
      {trajectory.hasData && (
        <Box marginTop={1}>
          <UsageTrends trajectory={trajectory} />
        </Box>
      )}

      {/* Usage Trajectory - projections (only if data available) */}
      {trajectory.hasData && (
        <Box marginTop={1}>
          <UsageTrajectory trajectory={trajectory} />
        </Box>
      )}

      {/* Automated Instances (only if data available) */}
      {automatedInstances.hasData && (
        <Box marginTop={1}>
          <AutomatedInstances data={automatedInstances} />
        </Box>
      )}

      {/* Legacy Automations (fallback if automated instances not available) */}
      {!automatedInstances.hasData && (
        <Box marginTop={1}>
          <Automations automations={data.automations} />
        </Box>
      )}

      {/* Testing health */}
      {testing.hasData && (
        <Box marginTop={1}>
          <TestingSection data={testing} />
        </Box>
      )}

      {/* Deployments */}
      {deployments.hasData && (
        <Box marginTop={1}>
          <DeploymentsSection data={deployments} />
        </Box>
      )}

      {/* Infrastructure */}
      {infra.hasData && (
        <Box marginTop={1}>
          <InfraSection data={infra} deployments={deployments} />
        </Box>
      )}

      {/* Logging */}
      {logging.hasData && (
        <Box marginTop={1}>
          <LoggingSection data={logging} />
        </Box>
      )}

      {/* Feedback Personas */}
      {data.feedback_personas.personas.length > 0 && (
        <Box marginTop={1}>
          <FeedbackPersonas data={data.feedback_personas} />
        </Box>
      )}

      {/* Timeline */}
      <Box marginTop={1}>
        <Timeline events={timelineEvents} hours={data.hours} maxEvents={20} />
      </Box>

      {/* Metrics Summary */}
      <Box marginTop={1}>
        <MetricsSummary data={data} />
      </Box>
    </Box>
  );
}
