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
import { getAutomatedInstances } from './utils/automated-instances.js';
import { getDeputyCtoData } from './utils/deputy-cto-reader.js';
import { getTestingData, getCodecovData } from './utils/testing-reader.js';
import { getDeploymentsData } from './utils/deployments-reader.js';
import { getInfraData } from './utils/infra-reader.js';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseArgs(): { hours: number } {
  const args = process.argv.slice(2);
  let hours = 24;

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
  }

  return { hours };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { hours } = parseArgs();

  try {
    // Fetch data from all sources
    const data = await getDashboardData(hours);
    const timelineEvents = aggregateTimeline({ hours, maxEvents: 20 });
    const trajectory = getUsageTrajectory();
    const automatedInstances = getAutomatedInstances();
    const deputyCto = getDeputyCtoData();
    const testing = getTestingData();

    // Fetch optional async data in parallel
    const [codecovResult, deploymentsResult, infraResult] = await Promise.allSettled([
      getCodecovData(),
      getDeploymentsData(),
      getInfraData(),
    ]);

    if (codecovResult.status === 'fulfilled' && codecovResult.value) {
      testing.codecov = codecovResult.value;
    }

    const deployments = deploymentsResult.status === 'fulfilled'
      ? deploymentsResult.value
      : { hasData: false, render: { services: [], recentDeploys: [] }, vercel: { projects: [], recentDeploys: [] }, pipeline: { previewStatus: null, stagingStatus: null, lastPromotionAt: null }, combined: [] };

    const infra = infraResult.status === 'fulfilled'
      ? infraResult.value
      : { hasData: false, render: { serviceCount: 0, suspendedCount: 0, available: false }, vercel: { projectCount: 0, errorDeploys: 0, available: false }, supabase: { healthy: false, available: false }, elastic: { available: false, totalLogs1h: 0, errorCount1h: 0, warnCount1h: 0, topServices: [] }, cloudflare: { status: 'unavailable', nameServers: [], available: false } };

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
