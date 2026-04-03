/**
 * RightPanel — compact intelligence widgets. Monochrome.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from '../Section.js';
import { QuotaBar } from '../QuotaBar.js';
import type { LiveDashboardData, PlanItem } from '../../types.js';
import { formatNumber, formatDuration, formatPercent, formatTokens, formatTimeAgo, truncate } from '../../utils/formatters.js';

interface RightPanelProps {
  data: LiveDashboardData;
  width: number;
  height: number;
}

function QuotaWidget({ data, width }: { data: LiveDashboardData; width: number }): React.ReactElement {
  const { quota } = data;
  return (
    <Section title={`QUOTA (${quota.activeAccounts} acct${quota.activeAccounts !== 1 ? 's' : ''})`} width={width} tip="/show quota">
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
    </Box>
  );
}
