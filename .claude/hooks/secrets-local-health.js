#!/usr/bin/env node
/**
 * UserPromptSubmit Hook: Secrets.local Health Check
 *
 * Warns on every message (with cooldown) if secrets.local in services.json is
 * not populated. Instructs the agent exactly how to fix it using MCP tools.
 *
 * Checks:
 * 1. secrets.local exists and is non-empty
 * 2. All secretProfile keys have matching entries in secrets.local
 *
 * Output: systemMessage (terminal) + additionalContext (model context)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCooldown } from './config-reader.js';

// ============================================================================
// Output helpers
// ============================================================================

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function warn(message) {
  console.log(JSON.stringify({
    continue: true,
    suppressOutput: false,
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: message,
    },
  }));
  process.exit(0);
}

// ============================================================================
// Fast-path: skip spawned sessions and local mode
// ============================================================================

if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
  silent();
}

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Skip in local mode — 1Password is not available
try {
  const focusPath = path.join(PROJECT_DIR, '.claude', 'state', 'local-mode.json');
  if (fs.existsSync(focusPath)) {
    const data = JSON.parse(fs.readFileSync(focusPath, 'utf-8'));
    if (data.enabled) silent();
  }
} catch { /* non-fatal */ }

// ============================================================================
// State management
// ============================================================================

const STATE_DIR = path.join(PROJECT_DIR, '.claude', 'state');
const STATE_PATH = path.join(STATE_DIR, 'secrets-local-health-state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { lastCheck: 0, lastStatus: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch { /* non-fatal — state dir may be root-protected */ }
}

// ============================================================================
// Stdin consumption (required by hook harness)
// ============================================================================

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { input += chunk; });

process.stdin.on('end', () => {
  try {
    const now = Date.now();
    const state = readState();
    const cooldownMs = getCooldown('secrets_local_health', 5) * 60 * 1000;

    // Check cooldown — but reset if status changed
    if (state.lastCheck && (now - state.lastCheck) < cooldownMs && state.lastStatus === 'ok') {
      silent();
    }

    // Read services.json
    const configPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(configPath)) {
      // No services.json — nothing to check (project may not use secrets)
      state.lastCheck = now;
      state.lastStatus = 'ok';
      writeState(state);
      silent();
    }

    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      silent();
    }

    const secrets = config?.secrets || {};
    const local = secrets.local || {};
    const localKeys = Object.keys(local);
    const profiles = config?.secretProfiles || {};
    const profileNames = Object.keys(profiles);

    // Check 1: Is secrets.local empty?
    const isEmpty = localKeys.length === 0;

    // Check 2: Are all profile keys present in secrets.local?
    const missingByProfile = {};
    for (const [profileName, profile] of Object.entries(profiles)) {
      const secretKeys = profile?.secretKeys || [];
      const missing = secretKeys.filter(k => !local[k]);
      if (missing.length > 0) {
        missingByProfile[profileName] = missing;
      }
    }

    const hasMissing = Object.keys(missingByProfile).length > 0;

    if (!isEmpty && !hasMissing) {
      // All good
      state.lastCheck = now;
      state.lastStatus = 'ok';
      writeState(state);
      silent();
    }

    // Build warning message
    const issues = [];

    if (isEmpty && profileNames.length > 0) {
      issues.push(`secrets.local is EMPTY but ${profileNames.length} secret profile(s) are configured (${profileNames.join(', ')}). All secret-dependent operations will fail.`);
    } else if (isEmpty) {
      issues.push('secrets.local is EMPTY. Secret-dependent operations (demos, secret_run_command with profiles) will fail.');
    }

    if (hasMissing) {
      for (const [profileName, keys] of Object.entries(missingByProfile)) {
        issues.push(`Profile "${profileName}" is missing ${keys.length} key(s) in secrets.local: ${keys.join(', ')}`);
      }
    }

    const message = `⚠ SECRETS.LOCAL NOT POPULATED — secret-dependent commands WILL FAIL.

${issues.join('\n')}

FIX THIS NOW:
1. Call mcp__onepassword__op_vault_map({}) to see all 1Password items and their op:// reference paths
2. Match each required env var name to the correct op:// reference from the vault map
3. Call mcp__secret-sync__populate_secrets_local({ entries: { "ENV_VAR_NAME": "op://Vault/Item/field", ... } })
4. If services.json is root-protected, the entries will be staged — run 'npx gentyr sync' to apply

Do this IMMEDIATELY — demos and secret-dependent operations will fail until secrets.local is populated.`;

    state.lastCheck = now;
    state.lastStatus = 'missing';
    writeState(state);
    warn(message);
  } catch (err) {
    // Fail open — never block the session
    console.log(JSON.stringify({ continue: true }));
    process.exit(0);
  }
});
