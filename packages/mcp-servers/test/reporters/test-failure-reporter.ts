/**
 * Vitest Custom Reporter - Test Failure Handler
 *
 * This reporter spawns Claude Code to fix test failures automatically.
 * Triggered by Vitest after test runs complete.
 *
 * Features:
 * - Per-suite cooldown (120 minutes) - per individual test suite
 * - Content-based deduplication via SHA-256 hashing (24-hour expiry)
 * - Dynamic suite name extraction (no hardcoding)
 * - Spawns Claude with failure details attached
 * - Fire and forget (doesn't block test completion)
 * - [Task][test-failure-vitest] prefix for CTO report tracking
 * - CLAUDE_SPAWNED_SESSION env var to prevent hook chain reactions
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import type { Reporter, File, Task } from 'vitest';

// Configuration
const CONFIG = {
  STATE_FILENAME: 'test-failure-state.json',
  PROMPT_FILENAME: 'test-failure-prompt.md',
  COOLDOWN_MINUTES: 60, // Per-suite cooldown
  MAX_SUITES_PER_SPAWN: 3,
  HASH_EXPIRY_HOURS: 12, // Failure output hashes expire after 12 hours
  HOOKS_DIR: '.claude/hooks',
};

interface TestFailureState {
  suites: Record<string, string>; // suiteName -> ISO timestamp
  failureHashes: Record<string, string>; // hash -> ISO timestamp
}

interface FailedSuite {
  name: string;
  filepath: string;
  failures: Array<{
    name: string;
    error: string;
  }>;
}

/**
 * Get the project root directory
 */
function getProjectRoot(): string {
  // Navigate from packages/mcp-servers/test/reporters/ to project root
  return process.env['CLAUDE_PROJECT_DIR'] || path.resolve(__dirname, '..', '..', '..', '..');
}

/**
 * Get the path to the state file
 */
function getStatePath(): string {
  return path.join(getProjectRoot(), CONFIG.HOOKS_DIR, CONFIG.STATE_FILENAME);
}

/**
 * Get the path to the prompt file
 */
function getPromptPath(): string {
  return path.join(getProjectRoot(), CONFIG.HOOKS_DIR, CONFIG.PROMPT_FILENAME);
}

/**
 * Read the cooldown state from file
 */
function readState(): TestFailureState {
  try {
    const content = fs.readFileSync(getStatePath(), 'utf8');
    const state = JSON.parse(content) as Partial<TestFailureState>;
    return {
      suites: state.suites || {},
      failureHashes: state.failureHashes || {},
    };
  } catch {
    return { suites: {}, failureHashes: {} };
  }
}

/**
 * Write the state to file
 */
function writeState(state: TestFailureState): void {
  try {
    const statePath = getStatePath();
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not write state: ${message}`);
  }
}

/**
 * Check if a suite is in cooldown
 */
function isInCooldown(state: TestFailureState, suiteName: string, now: Date = new Date()): boolean {
  const lastSpawn = state.suites[suiteName];
  if (!lastSpawn) {return false;}

  const lastSpawnDate = new Date(lastSpawn);
  const minutesSince = (now.getTime() - lastSpawnDate.getTime()) / (1000 * 60);

  return minutesSince < CONFIG.COOLDOWN_MINUTES;
}

/**
 * Record spawn time for suites
 */
function recordSpawn(suiteNames: string[], now: Date = new Date()): void {
  const state = readState();

  // Record per-suite timestamps
  for (const suite of suiteNames) {
    state.suites[suite] = now.toISOString();
  }

  // Clean up old entries (older than 24 hours)
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  for (const [suite, timestamp] of Object.entries(state.suites)) {
    if (new Date(timestamp) < oneDayAgo) {
      delete state.suites[suite];
    }
  }

  writeState(state);
}

/**
 * Compute a hash of failure details for deduplication
 */
function computeFailureHash(failureDetails: string): string {
  return crypto.createHash('sha256').update(failureDetails).digest('hex').slice(0, 16);
}

/**
 * Check if a failure hash has been seen recently (within expiry period)
 */
function isHashSeen(state: TestFailureState, hash: string, now: Date = new Date()): boolean {
  const timestamp = state.failureHashes[hash];
  if (!timestamp) {return false;}

  const hashDate = new Date(timestamp);
  const hoursSince = (now.getTime() - hashDate.getTime()) / (1000 * 60 * 60);

  return hoursSince < CONFIG.HASH_EXPIRY_HOURS;
}

/**
 * Record a failure hash and clean up expired hashes
 */
function recordFailureHash(hash: string, now: Date = new Date()): void {
  const state = readState();

  // Record the new hash
  state.failureHashes[hash] = now.toISOString();

  // Clean up expired hashes (older than 24 hours)
  const expiryTime = new Date(now.getTime() - CONFIG.HASH_EXPIRY_HOURS * 60 * 60 * 1000);
  for (const [h, timestamp] of Object.entries(state.failureHashes)) {
    if (new Date(timestamp) < expiryTime) {
      delete state.failureHashes[h];
    }
  }

  writeState(state);
}

/**
 * Read the prompt template from file
 */
function readPrompt(): string | null {
  try {
    return fs.readFileSync(getPromptPath(), 'utf8').trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Could not read prompt file: ${message}`);
    return null;
  }
}

/**
 * Format failure details from Vitest test results
 */
function formatFailureDetails(failedSuites: FailedSuite[]): string {
  const details: string[] = [];

  for (const suite of failedSuites) {
    details.push(`\n=== ${suite.filepath} ===`);

    for (const failure of suite.failures) {
      details.push(`\n● ${failure.name}`);
      // Truncate very long messages
      const truncated =
        failure.error.length > 1000 ? `${failure.error.slice(0, 1000)  }\n... (truncated)` : failure.error;
      details.push(truncated);
    }
  }

  return details.join('\n');
}

/**
 * Extract failed tests from a Vitest task tree
 */
function extractFailures(tasks: Task[], ancestorNames: string[] = []): Array<{ name: string; error: string }> {
  const failures: Array<{ name: string; error: string }> = [];

  for (const task of tasks) {
    const fullName = [...ancestorNames, task.name].join(' › ');

    if (task.type === 'test' && task.result?.state === 'fail') {
      const errorMessage = task.result.errors?.map((e) => e.message || String(e)).join('\n') || 'Unknown error';
      failures.push({ name: fullName, error: errorMessage });
    }

    // Recursively check nested tasks (describe blocks)
    if ('tasks' in task && Array.isArray(task.tasks)) {
      failures.push(...extractFailures(task.tasks, [...ancestorNames, task.name]));
    }
  }

  return failures;
}

/**
 * Spawn Claude to fix test failures
 */
function spawnClaude(suiteNames: string[], failureDetails: string): boolean {
  const promptTemplate = readPrompt();

  if (!promptTemplate) {
    console.error('Warning: No prompt file found, skipping Claude spawn');
    return false;
  }

  const projectRoot = getProjectRoot();
  const suitesFormatted = suiteNames.slice(0, CONFIG.MAX_SUITES_PER_SPAWN).join('\n- ');

  // Add [Task][test-failure-vitest] prefix for CTO report tracking
  const prompt = `[Task][test-failure-vitest] ${promptTemplate}

FAILING TEST SUITES (processing up to ${CONFIG.MAX_SUITES_PER_SPAWN}):
- ${suitesFormatted}

FAILURE OUTPUT:
\`\`\`
${failureDetails.slice(0, 8000)}
\`\`\``;

  try {
    // Try to register spawn with agent tracker (fire-and-forget, don't fail if unavailable)
    try {
      // Dynamic import to avoid hard dependency
      const agentTrackerPath = path.join(projectRoot, '.claude/hooks/agent-tracker.js');
      if (fs.existsSync(agentTrackerPath)) {
        // We can't use dynamic import in this context, so we'll skip registration
        // The agent will still be tracked by the session itself
      }
    } catch {
      // Agent tracker not available, continue without registration
    }

    const claude = spawn(
      'claude',
      ['--dangerously-skip-permissions', '-p', prompt],
      {
        detached: true,
        stdio: 'ignore',
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_SPAWNED_SESSION: 'true', // Prevent chain reaction from hooks
        },
      }
    );

    claude.unref();
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Failed to spawn Claude: ${message}`);
    return false;
  }
}

/**
 * Vitest Custom Reporter Class
 */
export default class TestFailureReporter implements Reporter {
  onFinished(files?: File[]): void {
    if (!files || files.length === 0) {
      return;
    }

    // Extract failed suites
    const failedSuites: FailedSuite[] = [];

    for (const file of files) {
      const failures = extractFailures(file.tasks);

      if (failures.length > 0) {
        failedSuites.push({
          name: path.basename(file.filepath),
          filepath: file.filepath,
          failures,
        });
      }
    }

    if (failedSuites.length === 0) {
      return; // No failures, nothing to do
    }

    // Get suite names
    const suiteNames = failedSuites.map((s) => s.name);

    // Check cooldowns
    const state = readState();
    const now = new Date();

    // Check per-suite cooldowns
    const suitesToProcess = suiteNames.filter((suite) => !isInCooldown(state, suite, now));

    if (suitesToProcess.length === 0) {
      console.warn('\n[TestFailureReporter] All failing suites are in cooldown, skipping spawn');
      return;
    }

    // Limit to max suites per spawn
    const suitesToSpawn = suitesToProcess.slice(0, CONFIG.MAX_SUITES_PER_SPAWN);

    // Get the failed suites that match our spawn list
    const failedSuitesToReport = failedSuites.filter((s) => suitesToSpawn.includes(s.name));

    // Format failure details
    const failureDetails = formatFailureDetails(failedSuitesToReport);

    // Check if this exact failure output has been seen recently (deduplication)
    const failureHash = computeFailureHash(failureDetails);
    if (isHashSeen(state, failureHash, now)) {
      console.warn(`\n[TestFailureReporter] Duplicate failure output detected (hash: ${failureHash}), skipping spawn`);
      return;
    }

    // Spawn Claude
    const spawned = spawnClaude(suitesToSpawn, failureDetails);

    if (spawned) {
      recordSpawn(suitesToSpawn, now);
      recordFailureHash(failureHash, now);
      // Use console.warn since console.log is not allowed by lint rules
      console.warn(
        `\n[TestFailureReporter] Spawned Claude to fix ${suitesToSpawn.length} failing test suite(s) (hash: ${failureHash}):`
      );
      for (const suite of suitesToSpawn) {
        console.warn(`  - ${suite}`);
      }
    }
  }
}
