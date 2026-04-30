#!/usr/bin/env node
/**
 * PostToolUse Hook: Stale Demo Warning
 *
 * Fires on every tool call. Checks demo-runs.json for running demos
 * that have not been polled via check_demo_result for an extended period.
 * Injects additionalContext warnings urging the agent to poll or stop
 * the orphaned demo.
 *
 * Fast path: <2ms when no stale demos exist (file read + JSON parse only).
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { createInterface } from 'readline';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEMO_RUNS_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'demo-runs.json');

// Threshold: warn when a running demo has not been polled for this long.
// Matches DEMO_STALE_WARNING_MS in the Playwright MCP server.
const STALE_THRESHOLD_MS = 60_000;

// Cooldown: don't spam warnings more than once per 2 minutes per session.
let lastWarningAt = 0;
const WARNING_COOLDOWN_MS = 120_000;

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', (l) => { data += l; });
rl.on('close', () => {
  try {
    // Cooldown check — exit fast if we warned recently
    if (Date.now() - lastWarningAt < WARNING_COOLDOWN_MS) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Fast path: no state file means no demos to check
    if (!fs.existsSync(DEMO_RUNS_PATH)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    let entries;
    try {
      const raw = fs.readFileSync(DEMO_RUNS_PATH, 'utf-8');
      entries = JSON.parse(raw);
    } catch {
      // Corrupt or empty state file — skip silently
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    if (!Array.isArray(entries)) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const now = Date.now();
    const staleWarnings = [];

    for (const entry of entries) {
      if (!entry || !entry.pid) continue;
      if (entry.status !== 'running' && entry.status !== 'interrupted') continue;

      // Check if the process is actually alive (avoid warning about dead processes)
      try {
        process.kill(entry.pid, 0);
      } catch {
        // Process is dead — not stale, just uncleaned. Skip.
        continue;
      }

      // Calculate staleness from started_at since last_polled_at is runtime-only
      // and not persisted to demo-runs.json. The MCP server tracks last_polled_at
      // in-memory; this hook uses started_at + duration as a secondary signal.
      const startedMs = new Date(entry.started_at).getTime();
      const runDuration = now - startedMs;

      // Only warn for demos running longer than 2 minutes (they should be polled)
      if (runDuration < STALE_THRESHOLD_MS * 2) continue;

      const scenarioLabel = entry.scenario_id
        ? `scenario "${entry.scenario_id}"`
        : `test ${entry.test_file || '(unknown)'}`;
      const durationSec = Math.round(runDuration / 1000);
      const durationMin = Math.round(durationSec / 60);

      staleWarnings.push(
        `  - PID ${entry.pid}: ${scenarioLabel} — running for ${durationMin > 0 ? `${durationMin}m` : `${durationSec}s`}. ` +
        `Call check_demo_result({ pid: ${entry.pid} }) to poll, or stop_demo({ pid: ${entry.pid} }) to terminate.`
      );
    }

    if (staleWarnings.length === 0) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    lastWarningAt = now;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          `STALE DEMO WARNING: ${staleWarnings.length} demo process(es) still running without recent polling:`,
          ...staleWarnings,
          '',
          'Demos are NOT auto-killed. You must explicitly poll or stop them.',
          'Unpolled demos waste resources: browser processes, display locks, and dev server ports.',
        ].join('\n'),
      },
    }));
    process.exit(0);
  } catch {
    // PostToolUse hooks must never block — exit 0 on any error
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
