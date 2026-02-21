#!/usr/bin/env node
/**
 * GENTYR CTO Dashboard
 *
 * Ink-based CLI dashboard with timeline view and rounded corners.
 *
 * Usage:
 *   npx gentyr-dashboard          # Default 24h
 *   npx gentyr-dashboard --hours 8
 *   npx gentyr-dashboard -h 48
 *   npx gentyr-dashboard --section deployments
 *   npx gentyr-dashboard --section deployments --limit 5
 */

import React from 'react';
import { render, Box } from 'ink';
import { App } from './App.js';
import { getDashboardData } from './utils/data-reader.js';
import { aggregateTimeline } from './utils/timeline-aggregator.js';
import { getUsageTrajectory } from './utils/trajectory.js';
import { getAutomatedInstances, getAutomationTokenUsage } from './utils/automated-instances.js';
import { getDeputyCtoData } from './utils/deputy-cto-reader.js';
import { getTestingData, getCodecovData } from './utils/testing-reader.js';
import { getDeploymentsData } from './utils/deployments-reader.js';
import { getInfraData } from './utils/infra-reader.js';
import { getLoggingData } from './utils/logging-reader.js';
import { getAccountOverviewData } from './utils/account-overview-reader.js';
import { getWorktreeData } from './utils/worktree-reader.js';
import {
  getMockDashboardData, getMockTimelineEvents, getMockTrajectory,
  getMockAutomatedInstances, getMockDeputyCto, getMockTesting,
  getMockDeployments, getMockInfra, getMockLogging, getMockAccountOverview,
  getMockWorktrees,
} from './mock-data.js';
import {
  Section,
  QuotaBar,
  Timeline,
  MetricGrid,
  AutomatedInstances,
  UsageTrends,
  UsageTrajectory,
  DeputyCtoSection,
  TestingSection,
  DeploymentsSection,
  InfraSection,
  LoggingSection,
  AccountOverviewSection,
  WorktreeSection,
  type MetricBoxData,
} from './components/index.js';
import { formatNumber, calculateCacheRate } from './utils/formatters.js';

// ============================================================================
// Section IDs
// ============================================================================

// Canonical source: packages/mcp-servers/src/show/types.ts
const SECTION_IDS = [
  'quota', 'accounts', 'deputy-cto', 'usage', 'automations',
  'testing', 'deployments', 'worktrees', 'infra', 'logging',
  'timeline', 'tasks',
] as const;

type SectionId = typeof SECTION_IDS[number];

// ============================================================================
// CLI Argument Parsing
// ============================================================================

interface ParsedArgs {
  hours: number;
  mock: boolean;
  section: SectionId | null;
  limit: number | null;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let hours = 24;
  let mock = false;
  let section: SectionId | null = null;
  let limit: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--hours' || arg === '-h') {
      const value = args[i + 1];
      if (value) {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 168) {
          hours = parsed;
        }
      }
    }
    if (arg === '--mock') {
      mock = true;
    }
    if (arg === '--section') {
      const value = args[i + 1];
      if (value && (SECTION_IDS as readonly string[]).includes(value)) {
        section = value as SectionId;
      } else if (value) {
        process.stderr.write(`Warning: unknown section "${value}". Valid: ${SECTION_IDS.join(', ')}\n`);
      }
    }
    if (arg === '--limit') {
      const value = args[i + 1];
      if (value) {
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 100) {
          limit = parsed;
        }
      }
    }
  }

  return { hours, mock, section, limit };
}

// ============================================================================
// Single-Section Rendering
// ============================================================================

async function renderSection(sectionId: SectionId, mock: boolean, hours: number, limit: number | null): Promise<React.ReactElement> {
  switch (sectionId) {
    case 'quota': {
      const data = mock ? getMockDashboardData() : await getDashboardData(hours);
      const { verified_quota } = data;
      const { aggregate } = verified_quota;
      const activeKeys = verified_quota.healthy_count;
      const fiveHourPct = aggregate.five_hour?.utilization ?? 0;
      const sevenDayPct = aggregate.seven_day?.utilization ?? 0;
      const title = `QUOTA & CAPACITY (${activeKeys} key${activeKeys !== 1 ? 's' : ''})`;
      return (
        <Section title={title}>
          <Box flexDirection="column">
            <QuotaBar label="5-hour" percentage={fiveHourPct} width={16} />
            <QuotaBar label="7-day" percentage={sevenDayPct} width={16} />
          </Box>
        </Section>
      );
    }

    case 'accounts': {
      const accountOverview = mock ? getMockAccountOverview() : getAccountOverviewData();
      return <AccountOverviewSection data={accountOverview} />;
    }

    case 'deputy-cto': {
      const deputyCto = mock ? getMockDeputyCto() : getDeputyCtoData();
      return <DeputyCtoSection data={deputyCto} />;
    }

    case 'usage': {
      const trajectory = mock ? getMockTrajectory() : getUsageTrajectory();
      const data = mock ? getMockDashboardData() : await getDashboardData(hours);
      const accountOverview = mock ? getMockAccountOverview() : getAccountOverviewData();
      return (
        <Box flexDirection="column">
          <UsageTrends trajectory={trajectory} />
          <Box marginTop={1}>
            <UsageTrajectory trajectory={trajectory} verifiedQuota={data.verified_quota} accountOverview={accountOverview} />
          </Box>
        </Box>
      );
    }

    case 'automations': {
      const automatedInstances = mock ? getMockAutomatedInstances() : getAutomatedInstances();
      if (!mock) {
        const tokenUsageResult = await getAutomationTokenUsage().catch(() => null);
        if (tokenUsageResult) {
          automatedInstances.tokensByType = tokenUsageResult;
        }
      }
      return <AutomatedInstances data={automatedInstances} />;
    }

    case 'testing': {
      const testing = mock ? getMockTesting() : getTestingData();
      if (!mock) {
        const codecov = await getCodecovData().catch(() => null);
        if (codecov) {
          testing.codecov = codecov;
        }
      }
      return <TestingSection data={testing} />;
    }

    case 'deployments': {
      let deployments = mock ? getMockDeployments() : await getDeploymentsData().catch(() => ({
        hasData: false, render: { services: [], recentDeploys: [] }, vercel: { projects: [], recentDeploys: [] },
        pipeline: { previewStatus: null, stagingStatus: null, lastPromotionAt: null, lastPreviewCheck: null, lastStagingCheck: null, localDevCount: 0, stagingFreezeActive: false },
        combined: [], byEnvironment: { preview: [], staging: [], production: [] },
        stats: { totalDeploys24h: 0, successCount24h: 0, failedCount24h: 0 },
      }));
      if (limit && deployments.combined) {
        deployments = { ...deployments, combined: deployments.combined.slice(0, limit) };
      }
      return <DeploymentsSection data={deployments} />;
    }

    case 'worktrees': {
      const worktrees = mock ? getMockWorktrees() : getWorktreeData();
      return <WorktreeSection data={worktrees} />;
    }

    case 'infra': {
      const infra = mock ? getMockInfra() : await getInfraData().catch(() => ({
        hasData: false, render: { serviceCount: 0, suspendedCount: 0, available: false, lastDeployAt: null },
        vercel: { projectCount: 0, errorDeploys: 0, buildingCount: 0, available: false },
        supabase: { healthy: false, available: false },
        elastic: { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] },
        cloudflare: { status: 'unavailable' as const, nameServers: [], planName: null, available: false },
      }));
      const deployments = mock ? getMockDeployments() : await getDeploymentsData().catch(() => ({
        hasData: false, render: { services: [], recentDeploys: [] }, vercel: { projects: [], recentDeploys: [] },
        pipeline: { previewStatus: null, stagingStatus: null, lastPromotionAt: null, lastPreviewCheck: null, lastStagingCheck: null, localDevCount: 0, stagingFreezeActive: false },
        combined: [], byEnvironment: { preview: [], staging: [], production: [] },
        stats: { totalDeploys24h: 0, successCount24h: 0, failedCount24h: 0 },
      }));
      return <InfraSection data={infra} deployments={deployments} />;
    }

    case 'logging': {
      const logging = mock ? getMockLogging() : await getLoggingData().catch(() => ({
        hasData: false, totalLogs1h: 0, totalLogs24h: 0, volumeTimeseries: [], byLevel: [], byService: [],
        bySource: [], topErrors: [], topWarnings: [],
        storage: { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 }, sourceCoverage: [],
      }));
      return <LoggingSection data={logging} />;
    }

    case 'timeline': {
      const maxEvents = limit ?? 20;
      const timelineEvents = mock ? getMockTimelineEvents().slice(0, maxEvents) : aggregateTimeline({ hours, maxEvents });
      return <Timeline events={timelineEvents} hours={hours} maxEvents={maxEvents} />;
    }

    case 'tasks': {
      const data = mock ? getMockDashboardData() : await getDashboardData(hours);
      const { tasks, token_usage } = data;
      const cacheRate = calculateCacheRate(token_usage.cache_read, token_usage.input);
      const boxes: MetricBoxData[] = [
        {
          title: 'Tasks',
          metrics: [
            { label: 'Pending', value: tasks.pending_total, color: tasks.pending_total > 0 ? 'yellow' : 'green' },
            { label: 'Active', value: tasks.in_progress_total, color: 'cyan' },
            { label: 'Done', value: tasks.completed_24h, color: 'green' },
          ],
        },
        {
          title: 'Tokens',
          metrics: [
            { label: 'In', value: formatNumber(token_usage.input), color: 'white' },
            { label: 'Out', value: formatNumber(token_usage.output), color: 'white' },
            { label: 'Cache', value: `${cacheRate}%`, color: cacheRate >= 80 ? 'green' : 'yellow' },
          ],
        },
      ];
      return (
        <Section title="TASK METRICS" borderColor="green">
          <MetricGrid boxes={boxes} />
        </Section>
      );
    }

    default: {
      const _exhaustive: never = sectionId;
      throw new Error(`Unhandled section: ${_exhaustive}`);
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { hours, mock, section, limit } = parseArgs();

  try {
    // Single-section mode: render only the requested section
    if (section) {
      const element = await renderSection(section, mock, hours, limit);
      const { unmount, waitUntilExit } = render(
        <Box flexDirection="column">{element}</Box>,
        { exitOnCtrlC: true }
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      unmount();
      await waitUntilExit();
      return;
    }

    // Full dashboard mode
    let data, timelineEvents, trajectory, automatedInstances, deputyCto, testing, deployments, infra, logging, accountOverview, worktrees;

    if (mock) {
      // Use hardcoded mock data — no DB, API, or filesystem access
      data = getMockDashboardData();
      timelineEvents = getMockTimelineEvents();
      trajectory = getMockTrajectory();
      automatedInstances = getMockAutomatedInstances();
      deputyCto = getMockDeputyCto();
      testing = getMockTesting();
      deployments = getMockDeployments();
      infra = getMockInfra();
      logging = getMockLogging();
      accountOverview = getMockAccountOverview();
      worktrees = getMockWorktrees();
    } else {
      // Fetch data from all sources
      data = await getDashboardData(hours);
      timelineEvents = aggregateTimeline({ hours, maxEvents: 20 });
      trajectory = getUsageTrajectory();
      automatedInstances = getAutomatedInstances();
      deputyCto = getDeputyCtoData();
      testing = getTestingData();

      // Fetch optional async data in parallel
      const [codecovResult, deploymentsResult, infraResult, tokenUsageResult, loggingResult] = await Promise.allSettled([
        getCodecovData(),
        getDeploymentsData(),
        getInfraData(),
        getAutomationTokenUsage(),
        getLoggingData(),
      ]);

      if (codecovResult.status === 'fulfilled' && codecovResult.value) {
        testing.codecov = codecovResult.value;
      }

      deployments = deploymentsResult.status === 'fulfilled'
        ? deploymentsResult.value
        : { hasData: false, render: { services: [], recentDeploys: [] }, vercel: { projects: [], recentDeploys: [] }, pipeline: { previewStatus: null, stagingStatus: null, lastPromotionAt: null, lastPreviewCheck: null, lastStagingCheck: null, localDevCount: 0, stagingFreezeActive: false }, combined: [], byEnvironment: { preview: [], staging: [], production: [] }, stats: { totalDeploys24h: 0, successCount24h: 0, failedCount24h: 0 } };

      infra = infraResult.status === 'fulfilled'
        ? infraResult.value
        : { hasData: false, render: { serviceCount: 0, suspendedCount: 0, available: false, lastDeployAt: null }, vercel: { projectCount: 0, errorDeploys: 0, buildingCount: 0, available: false }, supabase: { healthy: false, available: false }, elastic: { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] }, cloudflare: { status: 'unavailable', nameServers: [], planName: null, available: false } };

      logging = loggingResult.status === 'fulfilled'
        ? loggingResult.value
        : { hasData: false, totalLogs1h: 0, totalLogs24h: 0, volumeTimeseries: [], byLevel: [], byService: [], bySource: [], topErrors: [], topWarnings: [], storage: { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 }, sourceCoverage: [] };

      if (tokenUsageResult.status === 'fulfilled' && tokenUsageResult.value) {
        automatedInstances.tokensByType = tokenUsageResult.value;
      }

      accountOverview = getAccountOverviewData();
      worktrees = getWorktreeData();
    }

    // Render dashboard (static mode - prints once and exits)
    const { unmount, waitUntilExit } = render(
      <App
        data={data}
        timelineEvents={timelineEvents}
        trajectory={trajectory}
        automatedInstances={automatedInstances}
        deputyCto={deputyCto}
        testing={testing}
        deployments={deployments}
        infra={infra}
        logging={logging}
        accountOverview={accountOverview}
        worktrees={worktrees}
      />,
      { exitOnCtrlC: true }
    );

    // Wait a tick for render to complete, then exit
    await new Promise(resolve => setTimeout(resolve, 100));
    unmount();
    await waitUntilExit();

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

main();
