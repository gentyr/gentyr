/**
 * Playwright Custom Reporter - Test Failure Handler
 *
 * This reporter spawns Claude Code to fix test failures automatically.
 * Triggered by Playwright after test runs complete (not by Claude Code hooks).
 *
 * Features:
 * - Per-suite cooldown (120 minutes) - per individual test file
 * - Content-based deduplication via SHA-256 hashing (24-hour expiry)
 * - Dynamic suite name extraction (no hardcoding)
 * - Spawns Claude with failure details attached
 * - Fire and forget (doesn't block test completion)
 * - [Task][test-failure-playwright] prefix for CTO dashboard tracking
 * - CLAUDE_SPAWNED_SESSION env var to prevent hook chain reactions
 *
 * Playwright Reporter Interface:
 *   onBegin(config, suite) - test run starts
 *   onTestEnd(test, result) - individual test finishes
 *   onEnd(result) - all tests finish
 *
 * @author GENTYR Framework
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const CONFIG = {
  STATE_FILENAME: 'test-failure-state.json',
  PROMPT_FILENAME: 'test-failure-prompt.md',
  COOLDOWN_MINUTES: 120,  // Per-suite cooldown
  MAX_SUITES_PER_SPAWN: 3,
  HASH_EXPIRY_HOURS: 24,  // Failure output hashes expire after 24 hours
};

/**
 * Resolve the framework directory from the reporter location
 * Works whether reporter is accessed via symlink or directly
 * @returns {string}
 */
function getFrameworkDir() {
  // Reporter is at .claude/hooks/reporters/playwright-failure-reporter.js
  // Framework root is 3 levels up
  return path.resolve(__dirname, '..', '..', '..');
}

/**
 * Get the project root directory (where playwright is running)
 * @returns {string}
 */
function getProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Get the path to the state file (in project's .claude directory)
 * @returns {string}
 */
function getStatePath() {
  return path.join(getProjectRoot(), '.claude', CONFIG.STATE_FILENAME);
}

/**
 * Get the path to the prompt file (in framework)
 * @returns {string}
 */
function getPromptPath() {
  return path.join(getFrameworkDir(), '.claude', 'hooks', CONFIG.PROMPT_FILENAME);
}

/**
 * Get the configured cooldown from centralized config-reader.
 * Uses dynamic import since reporters live in a subdirectory accessed via symlinks.
 * @returns {Promise<number>} Cooldown in minutes
 */
async function getConfiguredCooldown() {
  try {
    const configReaderPath = path.join(getFrameworkDir(), '.claude', 'hooks', 'config-reader.js');
    const { getCooldown } = await import(configReaderPath);
    return getCooldown('test_failure_reporter', 120);
  } catch {
    return 120;
  }
}

/**
 * Dynamically import agent-tracker
 * @returns {Promise<{registerSpawn: Function, AGENT_TYPES: object, HOOK_TYPES: object}>}
 */
async function getAgentTracker() {
  try {
    const trackerPath = path.join(getFrameworkDir(), '.claude', 'hooks', 'agent-tracker.js');
    return await import(trackerPath);
  } catch (err) {
    console.error(`Warning: Could not load agent-tracker: ${err.message}`);
    return {
      registerSpawn: () => {},
      AGENT_TYPES: { TEST_FAILURE_PLAYWRIGHT: 'test-failure-playwright' },
      HOOK_TYPES: { PLAYWRIGHT_REPORTER: 'playwright-reporter' }
    };
  }
}

/**
 * Read the cooldown state from file
 * @returns {object}
 */
function readState() {
  try {
    const content = fs.readFileSync(getStatePath(), 'utf8');
    const state = JSON.parse(content);
    return {
      suites: state.suites || {},
      failureHashes: state.failureHashes || {}
    };
  } catch {
    return { suites: {}, failureHashes: {} };
  }
}

/**
 * Write the state to file
 * @param {object} state
 */
function writeState(state) {
  try {
    const statePath = getStatePath();
    const dir = path.dirname(statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error(`Warning: Could not write state: ${err.message}`);
  }
}

/**
 * Check if a suite is in cooldown
 * @param {object} state
 * @param {string} suiteName
 * @param {number} cooldownMinutes - Cooldown in minutes
 * @param {Date} now
 * @returns {boolean}
 */
function isInCooldown(state, suiteName, cooldownMinutes = CONFIG.COOLDOWN_MINUTES, now = new Date()) {
  const lastSpawn = state.suites[suiteName];
  if (!lastSpawn) return false;

  const lastSpawnDate = new Date(lastSpawn);
  const minutesSince = (now - lastSpawnDate) / (1000 * 60);

  return minutesSince < cooldownMinutes;
}

/**
 * Record spawn time for suites
 * @param {string[]} suiteNames
 * @param {Date} now
 */
function recordSpawn(suiteNames, now = new Date()) {
  const state = readState();

  for (const suite of suiteNames) {
    state.suites[suite] = now.toISOString();
  }

  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  for (const [suite, timestamp] of Object.entries(state.suites)) {
    if (new Date(timestamp) < oneDayAgo) {
      delete state.suites[suite];
    }
  }

  writeState(state);
}

/**
 * Compute a hash of failure details for deduplication
 * @param {string} failureDetails
 * @returns {string}
 */
function computeFailureHash(failureDetails) {
  return crypto.createHash('sha256').update(failureDetails).digest('hex').slice(0, 16);
}

/**
 * Check if a failure hash has been seen recently
 * @param {object} state
 * @param {string} hash
 * @param {Date} now
 * @returns {boolean}
 */
function isHashSeen(state, hash, now = new Date()) {
  const timestamp = state.failureHashes[hash];
  if (!timestamp) return false;

  const hashDate = new Date(timestamp);
  const hoursSince = (now - hashDate) / (1000 * 60 * 60);

  return hoursSince < CONFIG.HASH_EXPIRY_HOURS;
}

/**
 * Record a failure hash
 * @param {string} hash
 * @param {Date} now
 */
function recordFailureHash(hash, now = new Date()) {
  const state = readState();

  state.failureHashes[hash] = now.toISOString();

  const expiryTime = new Date(now - CONFIG.HASH_EXPIRY_HOURS * 60 * 60 * 1000);
  for (const [h, timestamp] of Object.entries(state.failureHashes)) {
    if (new Date(timestamp) < expiryTime) {
      delete state.failureHashes[h];
    }
  }

  writeState(state);
}

/**
 * Read the prompt template from file
 * @returns {string|null}
 */
function readPrompt() {
  try {
    return fs.readFileSync(getPromptPath(), 'utf8').trim();
  } catch (err) {
    console.error(`Warning: Could not read prompt file: ${err.message}`);
    return null;
  }
}

/**
 * Format failure details from Playwright test results
 * @param {Map<string, object[]>} failedTests - Map of file path to array of {titlePath, errors, location}
 * @returns {string}
 */
function formatFailureDetails(failedTests) {
  const details = [];

  for (const [filePath, tests] of failedTests) {
    details.push(`\n=== ${filePath} ===`);

    for (const test of tests) {
      const testPath = test.titlePath.filter(Boolean).join(' › ');
      details.push(`\n● ${testPath}`);

      if (test.location) {
        details.push(`  at ${test.location.file}:${test.location.line}`);
      }

      for (const error of test.errors) {
        const msg = error.message || error.stack || String(error);
        const truncated = msg.length > 1000 ? msg.slice(0, 1000) + '\n... (truncated)' : msg;
        details.push(truncated);
      }
    }
  }

  return details.join('\n');
}

/**
 * Spawn Claude to fix test failures
 * @param {string[]} suiteNames
 * @param {string} failureDetails
 * @returns {Promise<boolean>}
 */
async function spawnClaude(suiteNames, failureDetails) {
  const promptTemplate = readPrompt();

  if (!promptTemplate) {
    console.error('Warning: No prompt file found, skipping Claude spawn');
    return false;
  }

  const projectRoot = getProjectRoot();
  const suitesFormatted = suiteNames.slice(0, CONFIG.MAX_SUITES_PER_SPAWN).join('\n- ');

  // Use [Task][test-failure-playwright] format for CTO dashboard tracking
  const prompt = `[Task][test-failure-playwright] ${promptTemplate}

FAILING TEST SUITES (processing up to ${CONFIG.MAX_SUITES_PER_SPAWN}):
- ${suitesFormatted}

FAILURE OUTPUT:
\`\`\`
${failureDetails.slice(0, 8000)}
\`\`\``;

  try {
    const { registerSpawn, AGENT_TYPES, HOOK_TYPES } = await getAgentTracker();

    registerSpawn({
      type: AGENT_TYPES.TEST_FAILURE_PLAYWRIGHT,
      hookType: HOOK_TYPES.PLAYWRIGHT_REPORTER || 'playwright-reporter',
      description: `Fixing ${suiteNames.length} failing Playwright test suite(s): ${suiteNames.slice(0, 3).join(', ')}`,
      prompt,
      metadata: {
        suiteNames,
        suiteCount: suiteNames.length,
        failureDetailsLength: failureDetails.length
      },
      projectDir: projectRoot
    });

    const claude = spawn('claude', [
      '--dangerously-skip-permissions',
      '-p',
      prompt
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_SPAWNED_SESSION: 'true'
      }
    });

    claude.unref();
    return true;
  } catch (err) {
    console.error(`Warning: Failed to spawn Claude: ${err.message}`);
    return false;
  }
}

/**
 * Playwright Custom Reporter
 *
 * Implements Playwright's Reporter interface.
 * Collects failures during the run and spawns Claude at the end.
 *
 * @see https://playwright.dev/docs/api/class-reporter
 */
class PlaywrightFailureReporter {
  constructor(options = {}) {
    this._options = options;
    /** @type {Map<string, object[]>} file path → array of failed test info */
    this._failedTests = new Map();
  }

  /**
   * Called when a test finishes (pass or fail).
   * We collect failures here for processing in onEnd.
   *
   * @param {import('@playwright/test').TestCase} test
   * @param {import('@playwright/test').TestResult} result
   */
  onTestEnd(test, result) {
    if (result.status !== 'failed' && result.status !== 'timedOut') {
      return;
    }

    const filePath = test.location.file;
    if (!this._failedTests.has(filePath)) {
      this._failedTests.set(filePath, []);
    }

    // Capture screenshot attachments for demo failure enrichment
    const screenshots = (result.attachments || [])
      .filter(a => a.contentType && a.contentType.startsWith('image/') && a.path)
      .map(a => a.path);

    this._failedTests.get(filePath).push({
      titlePath: test.titlePath(),
      location: test.location,
      errors: result.errors || [],
      status: result.status,
      duration: result.duration,
      screenshots,
    });
  }

  /**
   * Called when all tests finish.
   * Processes collected failures and spawns Claude if needed.
   *
   * @param {import('@playwright/test').FullResult} result
   */
  async onEnd(result) {
    if (this._failedTests.size === 0) {
      return;
    }

    // Skip if this is a spawned session (prevent infinite loops)
    if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
      return;
    }

    const cooldownMinutes = await getConfiguredCooldown();
    const suiteNames = Array.from(this._failedTests.keys()).map(fp => path.basename(fp));

    const state = readState();
    const now = new Date();

    const suitesToProcess = suiteNames.filter(suite => !isInCooldown(state, suite, cooldownMinutes, now));

    if (suitesToProcess.length === 0) {
      if (this._options.verbose) {
        console.log('\n[PlaywrightFailureReporter] All failing suites are in cooldown, skipping spawn');
      }
      return;
    }

    const suitesToSpawn = suitesToProcess.slice(0, CONFIG.MAX_SUITES_PER_SPAWN);

    // Filter failedTests to only those we're spawning for
    const filteredFailedTests = new Map();
    for (const [filePath, tests] of this._failedTests) {
      if (suitesToSpawn.includes(path.basename(filePath))) {
        filteredFailedTests.set(filePath, tests);
      }
    }

    const failureDetails = formatFailureDetails(filteredFailedTests);

    const failureHash = computeFailureHash(failureDetails);
    if (isHashSeen(state, failureHash, now)) {
      if (this._options.verbose) {
        console.log(`\n[PlaywrightFailureReporter] Duplicate failure output detected (hash: ${failureHash}), skipping spawn`);
      }
      return;
    }

    const spawned = await spawnClaude(suitesToSpawn, failureDetails);

    if (spawned) {
      recordSpawn(suitesToSpawn, now);
      recordFailureHash(failureHash, now);
      console.log(`\n[PlaywrightFailureReporter] Spawned Claude to fix ${suitesToSpawn.length} failing Playwright test suite(s) (hash: ${failureHash}):`);
      for (const suite of suitesToSpawn) {
        console.log(`  - ${suite}`);
      }
    }

    // Write enriched lastDemoFailure for .demo.ts files (consumed by check_demo_result MCP tool)
    const demoFailures = [...filteredFailedTests.entries()]
      .filter(([fp]) => fp.endsWith('.demo.ts'));
    if (demoFailures.length > 0) {
      const allScreenshots = [];
      const demoSuiteNames = [];
      for (const [fp, tests] of demoFailures) {
        demoSuiteNames.push(path.basename(fp));
        for (const t of tests) {
          if (t.screenshots) allScreenshots.push(...t.screenshots);
        }
      }
      const state = readState();
      state.lastDemoFailure = {
        testFile: demoFailures[0][0],
        suiteNames: demoSuiteNames,
        failureDetails: failureDetails.slice(0, 4000),
        screenshotPaths: allScreenshots.slice(0, 5),
        timestamp: now.toISOString(),
      };
      writeState(state);
    }
  }
}

export default PlaywrightFailureReporter;
