/**
 * Usage Trajectory Component
 *
 * Displays usage projections: current %, projected at reset, time to reset, trend rate.
 * Side-by-side display for 5-hour and 7-day windows.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Section } from './Section.js';
import { QuotaBar } from './QuotaBar.js';
import type { TrajectoryResult } from '../utils/trajectory.js';
import type { VerifiedQuotaResult } from '../utils/data-reader.js';
import type { AccountOverviewData, AccountKeyDetail } from '../utils/account-overview-reader.js';

export interface UsageTrajectoryProps {
  trajectory: TrajectoryResult;
  verifiedQuota?: VerifiedQuotaResult;
  accountOverview?: AccountOverviewData;
}

/**
 * Format duration until reset
 */
function formatTimeUntil(resetTime: Date | null): string {
  if (!resetTime) return 'N/A';

  const now = Date.now();
  const diffMs = resetTime.getTime() - now;

  if (diffMs <= 0) return 'now';

  const diffMins = Math.floor(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  if (diffHours < 24) {
    const mins = diffMins % 60;
    return mins > 0 ? `${diffHours}h ${mins}m` : `${diffHours}h`;
  }
  const hours = diffHours % 24;
  return hours > 0 ? `${diffDays}d ${hours}h` : `${diffDays}d`;
}

/**
 * Format trend with arrow indicator
 */
function formatTrend(trendPerUnit: number | null, unit: string): { text: string; color: string } {
  if (trendPerUnit === null) {
    return { text: 'N/A', color: 'gray' };
  }

  const absValue = Math.abs(trendPerUnit);
  const sign = trendPerUnit >= 0 ? '+' : '';
  const arrow = trendPerUnit > 0.1 ? '↑' : trendPerUnit < -0.1 ? '↓' : '→';

  // Color based on trend direction (higher usage = more yellow/red)
  let color = 'gray';
  if (trendPerUnit > 1) color = 'red';
  else if (trendPerUnit > 0.5) color = 'yellow';
  else if (trendPerUnit < -0.5) color = 'green';
  else if (trendPerUnit < 0) color = 'cyan';

  return {
    text: `${sign}${absValue.toFixed(1)}%/${unit} ${arrow}`,
    color,
  };
}

/**
 * Format projected value with indicator
 */
function formatProjected(current: number, projected: number | null): { text: string; arrow: string; color: string } {
  if (projected === null) {
    return { text: 'N/A', arrow: '', color: 'gray' };
  }

  const rounded = Math.round(projected);
  const arrow = projected > current + 1 ? ' ↑' : projected < current - 1 ? ' ↓' : '';

  // Color based on projected value
  let color = 'green';
  if (rounded >= 95) color = 'red';
  else if (rounded >= 85) color = 'yellow';
  else if (rounded >= 70) color = 'cyan';

  return {
    text: `${rounded}%`,
    arrow,
    color,
  };
}

interface WindowCardProps {
  title: string;
  titleColor: string;
  current: number;
  projected: number | null;
  resetTime: Date | null;
  trendPerHour: number | null;
  trendUnit: string;
}

function WindowCard({
  title,
  titleColor,
  current,
  projected,
  resetTime,
  trendPerHour,
  trendUnit,
}: WindowCardProps): React.ReactElement {
  const projectedInfo = formatProjected(current, projected);
  const trendInfo = formatTrend(trendPerHour, trendUnit);

  return (
    <Box flexDirection="column" width={32}>
      <Text color={titleColor} bold>{title}</Text>
      <Box marginLeft={1} flexDirection="column">
        <Box>
          <Text color="gray">├─ Current:     </Text>
          <Text color="white">{Math.round(current)}%</Text>
        </Box>
        <Box>
          <Text color="gray">├─ At Reset:    </Text>
          <Text color={projectedInfo.color}>{projectedInfo.text}</Text>
          <Text color={projectedInfo.color}>{projectedInfo.arrow}</Text>
        </Box>
        <Box>
          <Text color="gray">├─ Reset In:    </Text>
          <Text color="cyan">{formatTimeUntil(resetTime)}</Text>
        </Box>
        <Box>
          <Text color="gray">└─ Trend:       </Text>
          <Text color={trendInfo.color}>{trendInfo.text}</Text>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Deduplicate accounts by email (or keyId if no email).
 * Multiple keys for the same account have identical quota — keep only the first.
 */
function deduplicateByEmail(accounts: AccountKeyDetail[]): AccountKeyDetail[] {
  const seen = new Set<string>();
  const result: AccountKeyDetail[] = [];
  for (const acct of accounts) {
    const key = acct.email ?? acct.keyId;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(acct);
    }
  }
  return result;
}

const LABEL_PAD = 22;

function truncateLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 3) + '...';
}

interface AccountQuotaBarsProps {
  verifiedQuota: VerifiedQuotaResult;
  accountOverview: AccountOverviewData;
}

function AccountQuotaBars({ verifiedQuota, accountOverview }: AccountQuotaBarsProps): React.ReactElement | null {
  const unique = deduplicateByEmail(accountOverview.accounts);
  if (unique.length <= 1) return null;

  const { aggregate } = verifiedQuota;
  const total5h = aggregate.five_hour?.utilization ?? 0;
  const total7d = aggregate.seven_day?.utilization ?? 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray" bold>Per-Account Quota  {'(* = active)'}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>5-Hour</Text>
        <Box marginLeft={1} flexDirection="column">
          <QuotaBar label={truncateLabel('Total', LABEL_PAD).padEnd(LABEL_PAD)} percentage={total5h} width={16} />
          {unique.map((acct) => {
            const label = truncateLabel(acct.email ?? acct.keyId, LABEL_PAD - 2);
            const suffix = acct.isCurrent ? ' *' : '';
            const padded = (label + suffix).padEnd(LABEL_PAD);
            return (
              <QuotaBar
                key={acct.keyId + '-5h'}
                label={padded}
                percentage={acct.fiveHourPct ?? 0}
                width={16}
              />
            );
          })}
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color="magenta" bold>7-Day</Text>
        <Box marginLeft={1} flexDirection="column">
          <QuotaBar label={truncateLabel('Total', LABEL_PAD).padEnd(LABEL_PAD)} percentage={total7d} width={16} />
          {unique.map((acct) => {
            const label = truncateLabel(acct.email ?? acct.keyId, LABEL_PAD - 2);
            const suffix = acct.isCurrent ? ' *' : '';
            const padded = (label + suffix).padEnd(LABEL_PAD);
            return (
              <QuotaBar
                key={acct.keyId + '-7d'}
                label={padded}
                percentage={acct.sevenDayPct ?? 0}
                width={16}
              />
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}

export function UsageTrajectory({ trajectory, verifiedQuota, accountOverview }: UsageTrajectoryProps): React.ReactElement | null {
  if (!trajectory.hasData || trajectory.snapshots.length === 0) {
    return null;
  }

  // Get current values from latest snapshot
  const latest = trajectory.snapshots[trajectory.snapshots.length - 1];
  const current5h = latest.fiveHour;
  const current7d = latest.sevenDay;

  return (
    <Section title="USAGE TRAJECTORY" borderColor="yellow" width="100%">
      <Box flexDirection="column">
        {/* Side-by-side windows */}
        <Box flexDirection="row" gap={4}>
          <WindowCard
            title="5-Hour Window"
            titleColor="cyan"
            current={current5h}
            projected={trajectory.fiveHourProjectedAtReset}
            resetTime={trajectory.fiveHourResetTime}
            trendPerHour={trajectory.fiveHourTrendPerHour}
            trendUnit="hr"
          />

          <WindowCard
            title="7-Day Window"
            titleColor="magenta"
            current={current7d}
            projected={trajectory.sevenDayProjectedAtReset}
            resetTime={trajectory.sevenDayResetTime}
            trendPerHour={trajectory.sevenDayTrendPerDay}
            trendUnit="day"
          />
        </Box>

        {/* Per-account quota bars */}
        {verifiedQuota && accountOverview?.hasData && (
          <AccountQuotaBars verifiedQuota={verifiedQuota} accountOverview={accountOverview} />
        )}

        {/* Footer with projection method */}
        <Box marginTop={1}>
          <Text color="gray">Projection Method: Linear regression on last {Math.min(30, trajectory.snapshots.length)} snapshots</Text>
        </Box>
      </Box>
    </Section>
  );
}
