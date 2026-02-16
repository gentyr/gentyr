/**
 * Prerequisites Checker for E2E Tests
 *
 * Verifies that the environment has everything needed for real Claude E2E tests:
 * 1. `claude` CLI is installed and accessible
 * 2. MCP server dist files are built
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const FRAMEWORK_PATH = path.resolve(__dirname, '..', '..', '..');
const MCP_DIST = path.join(FRAMEWORK_PATH, 'packages', 'mcp-servers', 'dist');

export interface PrerequisiteResult {
  claudeAvailable: boolean;
  claudeVersion?: string;
  mcpServersBuilt: boolean;
  playwrightAvailable: boolean;
  missingServers: string[];
  errors: string[];
}

const REQUIRED_SERVERS = [
  'programmatic-feedback/server.js',
  'feedback-reporter/server.js',
  'playwright-feedback/server.js',
  'user-feedback/server.js',
  'shared/server.js',
  'shared/audited-server.js',
];

export async function checkPrerequisites(): Promise<PrerequisiteResult> {
  const result: PrerequisiteResult = {
    claudeAvailable: false,
    mcpServersBuilt: false,
    playwrightAvailable: false,
    missingServers: [],
    errors: [],
  };

  // Check claude CLI
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5000 });
    result.claudeAvailable = true;
    result.claudeVersion = stdout.trim();
  } catch {
    result.claudeAvailable = false;
    result.errors.push('claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code');
  }

  // Check MCP server dist files
  const missing: string[] = [];
  for (const server of REQUIRED_SERVERS) {
    const serverPath = path.join(MCP_DIST, server);
    if (!fs.existsSync(serverPath)) {
      missing.push(server);
    }
  }

  result.missingServers = missing;
  result.mcpServersBuilt = missing.length === 0;

  if (!result.mcpServersBuilt) {
    result.errors.push(
      `MCP servers not built. Missing: ${missing.join(', ')}. Run: cd packages/mcp-servers && npm run build`
    );
  }

  // Check Playwright browsers
  try {
    let defaultCacheDir: string;
    const platform = os.platform();
    if (platform === 'darwin') {
      defaultCacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
    } else if (platform === 'win32') {
      defaultCacheDir = path.join(process.env['LOCALAPPDATA'] || os.homedir(), 'ms-playwright');
    } else {
      defaultCacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
    }

    const cacheDir = process.env['PLAYWRIGHT_BROWSERS_PATH'] || defaultCacheDir;
    if (fs.existsSync(cacheDir)) {
      const entries = fs.readdirSync(cacheDir);
      const chromiumDir = entries.find(e => e.startsWith('chromium-'));
      if (chromiumDir) {
        // Verify actual browser binary exists (not just a partial download)
        const chromiumPath = path.join(cacheDir, chromiumDir);
        const binaryPaths = platform === 'darwin'
          ? [
              'chrome-mac/Chromium.app',
              'chrome-mac-arm64/Chromium.app',
              'chrome-mac/Google Chrome for Testing.app',
              'chrome-mac-arm64/Google Chrome for Testing.app',
            ]
          : platform === 'win32'
            ? ['chrome-win/chrome.exe']
            : ['chrome-linux/chrome'];
        result.playwrightAvailable = binaryPaths.some(
          bp => fs.existsSync(path.join(chromiumPath, bp))
        );
      }
    }
  } catch {
    result.playwrightAvailable = false;
  }

  return result;
}

/**
 * Skip the current test suite if prerequisites are not met.
 * Call this in beforeAll() to conditionally skip E2E tests.
 */
export async function skipIfPrerequisitesNotMet(): Promise<boolean> {
  const prereqs = await checkPrerequisites();

  if (!prereqs.claudeAvailable || !prereqs.mcpServersBuilt) {
    console.warn(`\n  Skipping E2E tests: ${prereqs.errors.join('; ')}\n`);
    return true;
  }

  return false;
}

/**
 * Check test capabilities including optional features like Playwright.
 * Returns structured result for selective test skipping.
 */
export async function checkTestCapabilities(): Promise<{ skip: boolean; playwrightAvailable: boolean }> {
  const prereqs = await checkPrerequisites();

  if (!prereqs.claudeAvailable || !prereqs.mcpServersBuilt) {
    console.warn(`\n  Skipping E2E tests: ${prereqs.errors.join('; ')}\n`);
    return { skip: true, playwrightAvailable: false };
  }

  if (!prereqs.playwrightAvailable) {
    console.warn('\n  Playwright browsers not installed. GUI tests will be skipped.');
    console.warn('  To install: npx playwright install chromium\n');
  }

  return { skip: false, playwrightAvailable: prereqs.playwrightAvailable };
}
