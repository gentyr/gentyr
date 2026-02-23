#!/usr/bin/env node
/**
 * Playwright Health Check — SessionStart hook
 *
 * Writes .claude/playwright-health.json with auth/extension state.
 * Read by slash-command-prefetch.js for instant health status in /demo.
 * Version 1.0
 */

import fs from 'fs';
import path from 'path';

// Skip spawned task sessions
if (process.env.CLAUDE_SPAWNED_SESSION === 'true') process.exit(0);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const HEALTH_FILE = path.join(PROJECT_DIR, '.claude', 'playwright-health.json');

function run() {
  // Only run if this project has Playwright
  const hasPwConfig = fs.existsSync(path.join(PROJECT_DIR, 'playwright.config.ts'))
    || fs.existsSync(path.join(PROJECT_DIR, 'playwright.config.js'));
  if (!hasPwConfig) process.exit(0);

  const authDir = path.join(PROJECT_DIR, '.auth');
  const primaryAuth = path.join(authDir, 'vendor-owner.json');

  let authState = { exists: false, ageHours: null, cookiesExpired: false, isStale: true };
  if (fs.existsSync(primaryAuth)) {
    try {
      const stat = fs.statSync(primaryAuth);
      const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000;
      let cookiesExpired = false;
      try {
        const state = JSON.parse(fs.readFileSync(primaryAuth, 'utf-8'));
        const now = Date.now() / 1000;
        cookiesExpired = (state.cookies || []).some(c => c.expires && c.expires > 0 && c.expires < now);
      } catch { /* ignore */ }
      authState = {
        exists: true,
        ageHours: Math.round(ageHours * 10) / 10,
        cookiesExpired,
        isStale: cookiesExpired || ageHours > 24,
      };
    } catch { /* ignore */ }
  }

  // Extension dist path is project-specific; read from env to maintain F005 portability
  const extensionDistRelative = process.env.GENTYR_EXTENSION_DIST_PATH;
  const extensionBuilt = extensionDistRelative
    ? fs.existsSync(path.join(PROJECT_DIR, extensionDistRelative))
    : true; // No extension configured = not a blocker

  const health = {
    checkedAt: new Date().toISOString(),
    authState,
    extensionBuilt,
    needsRepair: authState.isStale || !extensionBuilt,
  };

  try {
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2));
  } catch { /* ignore — .claude/ may not exist yet */ }

  // Log stale auth as a visible warning (shows in Claude Code output)
  if (authState.isStale) {
    const reason = !authState.exists ? 'missing' : authState.cookiesExpired ? 'cookies expired' : `${authState.ageHours}h old`;
    process.stderr.write(`[playwright-health-check] Auth state is stale (${reason}). Run /demo to auto-repair.\n`);
  }

  process.exit(0);
}

run();
