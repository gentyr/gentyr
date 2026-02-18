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
 */

import { render } from 'ink';
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
import {
  getMockDashboardData, getMockTimelineEvents, getMockTrajectory,
  getMockAutomatedInstances, getMockDeputyCto, getMockTesting,
  getMockDeployments, getMockInfra, getMockLogging,
} from './mock-data.js';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { hours: number; mock: boolean } {
  const args = process.argv.slice(2);
  let hours = 24;
  let mock = false;

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
  }

  return { hours, mock };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { hours, mock } = parseArgs();

  try {
    let data, timelineEvents, trajectory, automatedInstances, deputyCto, testing, deployments, infra, logging;

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
        : { hasData: false, render: { services: [], recentDeploys: [] }, vercel: { projects: [], recentDeploys: [] }, pipeline: { previewStatus: null, stagingStatus: null, lastPromotionAt: null, lastPreviewCheck: null, lastStagingCheck: null }, combined: [], byEnvironment: { preview: [], staging: [], production: [] }, stats: { totalDeploys24h: 0, successCount24h: 0, failedCount24h: 0 } };

      infra = infraResult.status === 'fulfilled'
        ? infraResult.value
        : { hasData: false, render: { serviceCount: 0, suspendedCount: 0, available: false, lastDeployAt: null }, vercel: { projectCount: 0, errorDeploys: 0, buildingCount: 0, available: false }, supabase: { healthy: false, available: false }, elastic: { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] }, cloudflare: { status: 'unavailable', nameServers: [], planName: null, available: false } };

      logging = loggingResult.status === 'fulfilled'
        ? loggingResult.value
        : { hasData: false, totalLogs1h: 0, totalLogs24h: 0, volumeTimeseries: [], byLevel: [], byService: [], bySource: [], topErrors: [], topWarnings: [], storage: { estimatedDailyGB: 0, estimatedMonthlyCost: 0, indexCount: 0 }, sourceCoverage: [] };

      if (tokenUsageResult.status === 'fulfilled' && tokenUsageResult.value) {
        automatedInstances.tokensByType = tokenUsageResult.value;
      }
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
