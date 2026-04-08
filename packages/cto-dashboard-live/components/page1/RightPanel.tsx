/**
 * RightPanel — compact intelligence widgets. Monochrome.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../Section.js';
import { QuotaBar } from '../QuotaBar.js';
import type { LiveDashboardData, PlanItem, UsageSnapshot, AutomatedInstance } from '../../types.js';
import { formatNumber, formatDuration, formatPercent, formatTokens, formatTimeAgo, truncate } from '../../utils/formatters.js';

// ── Analytics helpers (mirrored from Page3) ─────────────────────────────────

function sparkline(snapshots: UsageSnapshot[], width: number): string {
  if (snapshots.length === 0) return '';
  const chars = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
  const values = snapshots.map(s => s.utilization);
  const maxVal = Math.max(...values, 1);
  const step = Math.max(1, Math.floor(values.length / width));
  let result = '';
  for (let i = 0; i < values.length && result.length < width; i += step) {
    const idx = Math.min(chars.length - 1, Math.floor((values[i] / maxVal) * (chars.length - 1)));
    result += chars[idx];
  }
  return result;
}

function UsageTrendsWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const usage = data.pageAnalytics.usage;
  if (!usage.hasData) {
    return (
      <Section title="USAGE TRENDS" width={width} tip="/show usage">
        <Text dimColor>No usage data available</Text>
      </Section>
    );
  }
  const sparkW = Math.max(10, width - 20);
  const fiveHourSpark = sparkline(usage.fiveHourSnapshots, sparkW);
  const sevenDaySpark = sparkline(usage.sevenDaySnapshots, sparkW);
  const lastFive = usage.fiveHourSnapshots.length > 0 ? usage.fiveHourSnapshots[usage.fiveHourSnapshots.length - 1].utilization : 0;
  const lastSeven = usage.sevenDaySnapshots.length > 0 ? usage.sevenDaySnapshots[usage.sevenDaySnapshots.length - 1].utilization : 0;
  return (
    <Section title="USAGE TRENDS" width={width} tip="/show usage">
      <Text bold>5-Hour Window</Text>
      <Text dimColor>{fiveHourSpark}</Text>
      <QuotaBar label="Current" percentage={lastFive} width={Math.max(8, width - 20)} />
      <Text bold>7-Day Window</Text>
      <Text dimColor>{sevenDaySpark}</Text>
      <QuotaBar label="Current" percentage={lastSeven} width={Math.max(8, width - 20)} />
    </Section>
  );
}

function UsageTrajectoryWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const usage = data.pageAnalytics.usage;
  if (!usage.hasData) {
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
        <Text bold>{usage.cooldownFactor.toFixed(1)}x</Text>
      </Box>
      <Box>
        <Text dimColor>Target </Text>
        <Text bold>{usage.targetPct}%</Text>
      </Box>
      <Box>
        <Text dimColor>Projected at Reset </Text>
        <Text bold>{usage.projectedAtResetPct != null ? `${usage.projectedAtResetPct}%` : 'N/A'}</Text>
      </Box>
    </Section>
  );
}

function AutomatedInstancesWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const instances = data.pageAnalytics.automatedInstances;
  if (instances.length === 0) {
    return (
      <Section title="AUTOMATED INSTANCES" width={width} tip="/show automations">
        <Text dimColor>No automation data</Text>
      </Section>
    );
  }
  const totalSessions = instances.reduce((s: number, i: AutomatedInstance) => s + i.count, 0);
  const totalTokens = instances.reduce((s: number, i: AutomatedInstance) => s + i.tokensTotal, 0);
  const sorted = [...instances].sort((a: AutomatedInstance, b: AutomatedInstance) => b.tokensTotal - a.tokensTotal);
  return (
    <Section title={`AUTOMATED INSTANCES (${totalSessions} total, ${formatNumber(totalTokens)} tokens)`} width={width} tip="/show automations">
      <Box flexDirection="column">
        <Box>
          <Text bold dimColor>{'Agent Type'.padEnd(22)}{'Count'.padStart(7)}{'Tokens'.padStart(10)}{'Share'.padStart(7)}</Text>
        </Box>
        {sorted.map((inst: AutomatedInstance) => {
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

interface RightPanelProps {
  data: LiveDashboardData;
  width: number;
  height: number;
}

function QuotaWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const { quota } = data;
  return (
    <Section title="QUOTA & CAPACITY" width={width} tip="/show quota">
      <QuotaBar label="5-hour" percentage={quota.fiveHourPct} width={Math.max(8, width - 20)} />
      <QuotaBar label="7-day" percentage={quota.sevenDayPct} width={Math.max(8, width - 20)} />
    </Section>
  );
}

function DeputyCtoWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const d = data.deputyCtoSummary;
  return (
    <Section title="DEPUTY-CTO" width={width} tip="/show deputy-cto">
      <Box>
        <Text bold>{d.untriagedCount}</Text><Text dimColor>{' untriaged · '}</Text>
        <Text bold>{d.escalatedCount}</Text><Text dimColor> escalated</Text>
      </Box>
      <Box>
        <Text bold>{d.pendingQuestionCount}</Text><Text dimColor>{' pending Q · '}</Text>
        <Text bold>{d.handled24h}</Text><Text dimColor> handled/24h</Text>
      </Box>
    </Section>
  );
}

function StatusWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const s = data.systemStatus;
  return (
    <Section title="SYSTEM" width={width}>
      <Box>
        <Text dimColor>Deputy </Text>
        <Text bold>{s.deputyEnabled ? 'ON' : 'OFF'}</Text>
        <Text dimColor> ({s.deputyIntervalMinutes}m)</Text>
      </Box>
      <Box>
        <Text dimColor>Protect </Text>
        <Text bold>{s.protectionStatus.toUpperCase()}</Text>
      </Box>
      <Box>
        <Text dimColor>Commits </Text>
        <Text bold>{s.commitsBlocked ? 'BLOCKED' : 'ALLOWED'}</Text>
      </Box>
    </Section>
  );
}

function PlansWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  if (data.plans.length === 0) {
    return (
      <Section title="PLANS" width={width} tip="/show plans">
        <Text dimColor>No active plans</Text>
      </Section>
    );
  }
  return (
    <Section title={`PLANS (${data.plans.length})`} width={width} tip="/show plans">
      {data.plans.map((plan: PlanItem) => {
        const barW = Math.max(6, width - 30);
        const filled = Math.round((plan.progressPct / 100) * barW);
        const empty = barW - filled;
        const titleStr = plan.title.length > (width - 22) ? plan.title.substring(0, width - 25) + '...' : plan.title;
        return (
          <Box key={plan.id}>
            <Text>{titleStr} </Text>
            <Text bold>{'\u2588'.repeat(filled)}</Text>
            <Text dimColor>{'\u2591'.repeat(empty)}</Text>
            <Text bold> {plan.progressPct}%</Text>
          </Box>
        );
      })}
    </Section>
  );
}

function MetricsWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const m = data.metricsSummary;
  return (
    <Section title="METRICS" width={width} tip="/show tasks">
      <Box>
        <Text dimColor>Tok </Text>
        <Text>In {formatNumber(m.tokensIn)} Out {formatNumber(m.tokensOut)} </Text>
        <Text dimColor>Cache </Text><Text bold>{m.cacheRate}%</Text>
      </Box>
      <Box>
        <Text dimColor>Tasks </Text>
        <Text bold>{m.tasksPending}</Text><Text dimColor>p </Text>
        <Text bold>{m.tasksActive}</Text><Text dimColor>a </Text>
        <Text bold>{m.tasksDone24h}</Text><Text dimColor>d</Text>
      </Box>
      <Box>
        <Text dimColor>Hooks </Text>
        <Text>{m.hooksTotal} </Text>
        <Text bold>{m.hooksSuccessRate}%</Text>
      </Box>
      <Box>
        <Text dimColor>Triage </Text>
        <Text bold>{m.triagePending}</Text><Text dimColor>p </Text>
        <Text bold>{m.triageHandled24h}</Text><Text dimColor>h</Text>
        <Text dimColor>{' · Cool '}</Text><Text>{m.cooldownFactor.toFixed(1)}x</Text>
      </Box>
    </Section>
  );
}

// Fixed column widths for worklog alignment
const WL_RES = 3;    // "OK " or "FL "
const WL_SEC = 13;   // section name
const WL_DUR = 8;    // duration right-aligned
const WL_TOK = 6;    // tokens right-aligned
const WL_FIXED = WL_RES + WL_SEC + WL_DUR + WL_TOK; // 30

function WorklogWidget({ data, width, maxEntries }: { data: LiveDashboardData; width: number; maxEntries: number }): React.ReactElement {
  const w = data.worklogMetrics;
  const entries = data.page2.worklogEntries.slice(0, maxEntries);
  const total = data.page2.worklogEntries.length;
  const innerW = Math.max(16, width - 4);
  const titleW = Math.max(6, innerW - WL_FIXED);

  return (
    <Section title={`WORKLOG (${total} · ${w.successRatePct ?? 0}% · avg ${formatDuration(w.avgCompleteMs)})`} width={width} tip="/show worklog">
      <Box flexDirection="column">
        {entries.map(e => (
          <Box key={e.id}>
            <Text bold>{(e.success ? 'OK' : 'FL').padEnd(WL_RES)}</Text>
            <Text dimColor>{truncate(e.section, WL_SEC - 1).padEnd(WL_SEC)}</Text>
            <Text>{truncate(e.title, titleW).padEnd(titleW)}</Text>
            <Text dimColor>{formatDuration(e.durationMs).padStart(WL_DUR)}</Text>
            <Text dimColor>{formatTokens(e.tokens).padStart(WL_TOK)}</Text>
          </Box>
        ))}
        {total > maxEntries && <Text dimColor>{'  '}...{total - maxEntries} more</Text>}
      </Box>
    </Section>
  );
}

export function RightPanel({ data, width, height }: RightPanelProps): React.ReactElement {
  // Other widgets take ~24 lines (borders + content). Give remaining to worklog.
  // Each worklog entry = 1 line, plus 3 lines for border + "...N more".
  const worklogMax = Math.max(3, height - 27);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QuotaWidget data={data} width={width} />
      <DeputyCtoWidget data={data} width={width} />
      <StatusWidget data={data} width={width} />
      <PlansWidget data={data} width={width} />
      <MetricsWidget data={data} width={width} />
      <WorklogWidget data={data} width={width} maxEntries={worklogMax} />
      <UsageTrendsWidget data={data} width={width} />
      <UsageTrajectoryWidget data={data} width={width} />
      <AutomatedInstancesWidget data={data} width={width} />
    </Box>
  );
}
