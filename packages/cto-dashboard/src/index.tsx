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

    // Render dashboard (static mode - prints once and exits)
    const { unmount, waitUntilExit } = render(
      <App
        data={data}
        timelineEvents={timelineEvents}
        trajectory={trajectory}
        automatedInstances={automatedInstances}
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
