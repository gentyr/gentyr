#!/usr/bin/env node
/**
 * SessionStart Hook: Credential Health Check
 *
 * Checks if vault mappings are configured for all required credential keys.
 * Outputs a message prompting the user to run /setup-gentyr if setup is incomplete.
 *
 * Reads:
 * - .claude/vault-mappings.json (op:// references and direct values)
 * - .claude/hooks/protected-actions.json (which servers need which keys)
 *
 * Output: JSON to stdout with systemMessage if setup is incomplete.
 *
 * @version 1.0.0
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const mappingsPath = path.join(projectDir, '.claude', 'vault-mappings.json');
const actionsPath = path.join(projectDir, '.claude', 'hooks', 'protected-actions.json');

function output(message) {
  if (message) {
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: false,
      systemMessage: message,
    }));
  } else {
    console.log(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }));
  }
}

try {
  // Skip for spawned sessions — don't clutter agent output
  if (process.env.CLAUDE_SPAWNED_SESSION === 'true') {
    output(null);
    process.exit(0);
  }

  // Load required credential keys from protected-actions.json
  const requiredKeys = new Set();
  try {
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    for (const server of Object.values(actions.servers || {})) {
      if (Array.isArray(server.credentialKeys)) {
        for (const key of server.credentialKeys) {
          requiredKeys.add(key);
        }
      }
    }
  } catch {
    // No protected-actions.json — nothing to check
    output(null);
    process.exit(0);
  }

  if (requiredKeys.size === 0) {
    output(null);
    process.exit(0);
  }

  // Known alternative keys — only one of each pair needs to be configured
  const ALTERNATIVES = {
    'ELASTIC_CLOUD_ID': 'ELASTIC_ENDPOINT',
    'ELASTIC_ENDPOINT': 'ELASTIC_CLOUD_ID',
  };

  // Check vault mappings
  let configuredCount = 0;
  let missingKeys = [];
  let hasOpRefs = false;
  const configuredKeys = new Set();

  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    const mappings = data.mappings || {};
    for (const key of requiredKeys) {
      if (mappings[key]) {
        // Both op:// references and direct values count as configured
        configuredCount++;
        configuredKeys.add(key);
        if (typeof mappings[key] === 'string' && mappings[key].startsWith('op://')) {
          hasOpRefs = true;
        }
      } else {
        missingKeys.push(key);
      }
    }
  } catch {
    // No vault-mappings.json — all keys are missing
    missingKeys.push(...requiredKeys);
  }

  // Also check .mcp.json env blocks for missing keys (e.g. OP_SERVICE_ACCOUNT_TOKEN
  // is injected into .mcp.json by the installer, not stored in vault-mappings).
  // Always load OP_SERVICE_ACCOUNT_TOKEN from .mcp.json (source of truth) — the env
  // may have a stale token from a previous session that predates a token rotation.
  {
    const mcpPath = path.join(projectDir, '.mcp.json');
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      const mcpEnvKeys = new Set();
      for (const server of Object.values(mcpConfig.mcpServers || {})) {
        if (server.env) {
          for (const k of Object.keys(server.env)) {
            if (server.env[k]) mcpEnvKeys.add(k);
          }
          // Always prefer .mcp.json token — it's updated by reinstall.sh
          if (server.env.OP_SERVICE_ACCOUNT_TOKEN) {
            process.env.OP_SERVICE_ACCOUNT_TOKEN = server.env.OP_SERVICE_ACCOUNT_TOKEN;
          }
        }
      }
      missingKeys = missingKeys.filter(k => !mcpEnvKeys.has(k));
    } catch {
      // .mcp.json not readable — skip this check
    }
  }

  // Handle alternative keys — if one of a pair is configured, the other is not missing
  if (missingKeys.length > 0) {
    missingKeys = missingKeys.filter(key => {
      const alt = ALTERNATIVES[key];
      return !alt || !configuredKeys.has(alt);
    });
  }

  if (missingKeys.length > 0) {
    output(`GENTYR: ${missingKeys.length} credential mapping(s) not configured. Run /setup-gentyr to complete setup.`);
  } else if (hasOpRefs) {
    // Only test 1Password connectivity if there are op:// references to resolve
    try {
      execFileSync('op', ['whoami', '--format', 'json'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: process.env,
      });
      // Connected — no message needed
      output(null);
    } catch {
      output('GENTYR: 1Password is not authenticated. Run `sudo scripts/setup.sh --path <project> --op-token <TOKEN>` to configure. MCP servers will start without credentials.');
    }
  } else {
    // All mappings are direct values — no 1Password needed
    output(null);
  }
} catch (err) {
  // Don't block session — but log the error for debugging
  console.error(`[credential-health-check] Unexpected error: ${err.message || err}`);
  output(null);
}
