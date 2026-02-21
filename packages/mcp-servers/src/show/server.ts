#!/usr/bin/env node
/**
 * Show MCP Server
 *
 * Provides 12 tools that render individual CTO dashboard sections by spawning
 * the dashboard binary with --section flag. Agents can check deployments,
 * quota, testing, etc. without running the full dashboard.
 *
 * @version 1.0.0
 */

import { execFileSync } from 'child_process';
import { existsSync, readlinkSync } from 'fs';
import { join, resolve } from 'path';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  SECTION_IDS,
  SECTION_DESCRIPTIONS,
  ShowSectionArgsSchema,
  type ShowSectionArgs,
  type SectionId,
} from './types.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || '.';

// ============================================================================
// Dashboard Path Resolution
// ============================================================================

function resolveDashboardPath(): string {
  // Try .claude-framework symlink first (standard GENTYR setup)
  const frameworkLink = join(PROJECT_DIR, '.claude-framework');
  let frameworkDir: string | null = null;

  try {
    if (existsSync(frameworkLink)) {
      frameworkDir = readlinkSync(frameworkLink);
      if (!frameworkDir.startsWith('/')) {
        frameworkDir = resolve(PROJECT_DIR, frameworkDir);
      }
    }
  } catch {
    // Symlink doesn't exist or can't be read
  }

  // Fallback: follow .claude/hooks symlink to find framework
  if (!frameworkDir) {
    const hooksPath = join(PROJECT_DIR, '.claude', 'hooks');
    try {
      const resolved = readlinkSync(hooksPath);
      const absResolved = resolved.startsWith('/') ? resolved : resolve(PROJECT_DIR, resolved);
      // hooks -> <framework>/.claude/hooks, so framework is 2 levels up
      frameworkDir = resolve(absResolved, '..', '..');
    } catch {
      // Not a symlink
    }
  }

  if (!frameworkDir) {
    throw new Error('Cannot find GENTYR framework directory. Ensure .claude-framework symlink exists.');
  }

  const dashboardPath = join(frameworkDir, 'packages', 'cto-dashboard', 'dist', 'index.js');
  if (!existsSync(dashboardPath)) {
    throw new Error(`Dashboard binary not found: ${dashboardPath}. Run: cd ${frameworkDir}/packages/cto-dashboard && npm run build`);
  }

  return dashboardPath;
}

// ============================================================================
// Section Renderer
// ============================================================================

function renderSection(section: SectionId, args: ShowSectionArgs): string {
  const dashboardPath = resolveDashboardPath();

  const cmdArgs = [dashboardPath, '--section', section];
  if (args.limit) {
    cmdArgs.push('--limit', String(args.limit));
  }

  try {
    const output = execFileSync('node', cmdArgs, {
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, COLUMNS: '100' },
      maxBuffer: 1024 * 1024,
    });

    const trimmed = output.trim();
    if (!trimmed) {
      return 'No data available for this section.';
    }
    return trimmed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error rendering ${section} section: ${message}`;
  }
}

// ============================================================================
// Tool Generation
// ============================================================================

function makeToolName(section: SectionId): string {
  return `show_${section.replace(/-/g, '_')}`;
}

const tools: AnyToolHandler[] = SECTION_IDS.map((section) => ({
  name: makeToolName(section),
  description: SECTION_DESCRIPTIONS[section],
  schema: ShowSectionArgsSchema,
  handler: (args: ShowSectionArgs) => {
    const output = renderSection(section, args);
    return { section, output };
  },
}));

// ============================================================================
// Server
// ============================================================================

const server = new McpServer({
  name: 'show',
  version: '1.0.0',
  tools,
});

server.start();
