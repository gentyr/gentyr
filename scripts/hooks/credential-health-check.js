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

  // Check vault mappings
  let configuredCount = 0;
  const missingKeys = [];
  let hasOpRefs = false;

  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    const mappings = data.mappings || {};
    for (const key of requiredKeys) {
      if (mappings[key]) {
        // Both op:// references and direct values count as configured
        configuredCount++;
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
      output('GENTYR: 1Password is not authenticated. Run `op signin` or set OP_SERVICE_ACCOUNT_TOKEN. MCP servers will start without credentials.');
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
