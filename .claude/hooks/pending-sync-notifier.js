#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Pending Sync Notifier
 *
 * In interactive (CTO) sessions, warns when any pending configuration files
 * exist that require `npx gentyr sync` to apply. Checks all 5 pending file types:
 *   - secrets-local-pending.json (staged secrets.local entries)
 *   - services-config-pending.json (staged services.json config changes)
 *   - mcp-servers-pending.json (staged MCP server registrations)
 *   - fly-config-pending.json (staged Fly.io config changes)
 *   - secrets-fly-pending.json (staged secrets.fly entries)
 *   - fly-config-pending.json (staged Fly.io config)
 *
 * Only fires in interactive sessions (not spawned). 10-minute cooldown.
 * Shows in systemMessage (terminal) only — does NOT inject into model context
 * since the CTO can see the terminal warning and act on it.
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// Fast-path: skip spawned sessions
// ============================================================================

if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');

// ============================================================================
// Cooldown (10 minutes)
// ============================================================================

const COOLDOWN_MS = 10 * 60 * 1000;
const COOLDOWN_PATH = path.join(STATE_DIR, 'pending-sync-notifier-state.json');

let lastCheck = 0;
try {
  const state = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf-8'));
  lastCheck = state.lastCheck || 0;
} catch { /* first run */ }

if (Date.now() - lastCheck < COOLDOWN_MS) {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

// ============================================================================
// Stdin consumption (required by hook harness)
// ============================================================================

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });

process.stdin.on('end', () => {
  try {
    const pending = [];

    // Check each pending file type
    const checks = [
      {
        file: 'secrets-local-pending.json',
        label: 'secrets.local entries',
        describe: (data) => {
          const keys = Object.keys(data.entries || {});
          return keys.length > 0 ? `${keys.length} key(s): ${keys.join(', ')}` : null;
        },
      },
      {
        file: 'services-config-pending.json',
        label: 'services.json config',
        describe: (data) => {
          const keys = Object.keys(data).filter(k => k !== 'timestamp');
          return keys.length > 0 ? `${keys.length} field(s): ${keys.join(', ')}` : null;
        },
      },
      {
        file: 'mcp-servers-pending.json',
        label: 'MCP server registrations',
        describe: (data) => {
          const names = Object.keys(data.servers || data);
          return names.length > 0 ? `${names.length} server(s): ${names.join(', ')}` : null;
        },
      },
      {
        file: 'fly-config-pending.json',
        label: 'Fly.io config',
        describe: (data) => {
          const keys = Object.keys(data).filter(k => k !== 'timestamp');
          return keys.length > 0 ? `${keys.length} field(s)` : null;
        },
      },
      {
        file: 'secrets-fly-pending.json',
        label: 'secrets.fly entries',
        describe: (data) => {
          const apps = Object.keys(data.entries || {});
          if (apps.length === 0) return null;
          const summary = apps.map(app => {
            const count = Object.keys(data.entries[app] || {}).length;
            return `${app} (${count} key${count === 1 ? '' : 's'})`;
          });
          return summary.join(', ');
        },
      },
    ];

    for (const check of checks) {
      const filePath = path.join(STATE_DIR, check.file);
      try {
        if (fs.existsSync(filePath)) {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const desc = check.describe(data);
          if (desc) {
            pending.push(`  - ${check.label}: ${desc}`);
          }
        }
      } catch { /* malformed file — skip */ }
    }

    // Save cooldown state
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(COOLDOWN_PATH, JSON.stringify({ lastCheck: Date.now() }) + '\n');
    } catch { /* non-fatal */ }

    if (pending.length === 0) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      process.exit(0);
    }

    const message = `⚠ PENDING SYNC: ${pending.length} change(s) staged for next 'npx gentyr sync':\n${pending.join('\n')}`;

    console.log(JSON.stringify({
      continue: true,
      suppressOutput: false,
      systemMessage: message,
    }));
    process.exit(0);
  } catch {
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
