#!/usr/bin/env node
/**
 * MCP Server Launcher with 1Password Credential Resolution
 *
 * Wraps MCP server startup to resolve credentials from 1Password at runtime.
 * Credentials only exist in process memory — never written to disk.
 *
 * Usage: node mcp-launcher.js <server-name> <server-script-path>
 *
 * Flow:
 * 1. Reads .claude/vault-mappings.json for op:// references and direct values
 * 2. Reads .claude/hooks/protected-actions.json for which keys this server needs
 * 3. For each needed key not already in env: resolves via `op read` or uses direct value
 * 4. Dynamically imports the actual MCP server script
 *
 * Falls back gracefully — if 1Password is unavailable or vault mappings
 * are missing, the server starts without those credentials.
 *
 * @version 1.0.0
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [serverName, serverScript] = process.argv.slice(2);

if (!serverName || !serverScript) {
  console.error('Usage: node mcp-launcher.js <server-name> <server-script-path>');
  process.exit(1);
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ---------------------------------------------------------------------------
// 1. Load vault mappings (op:// references, NOT secrets)
// ---------------------------------------------------------------------------
const mappingsPath = path.join(projectDir, '.claude', 'vault-mappings.json');
let mappings = {};
try {
  const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
  mappings = data.mappings || {};
} catch (err) {
  console.error(`[mcp-launcher:${serverName}] No vault mappings: ${err.message || 'file not found'}`);
}

// ---------------------------------------------------------------------------
// 2. Determine which credential keys this server needs
// ---------------------------------------------------------------------------
const actionsPath = path.join(projectDir, '.claude', 'hooks', 'protected-actions.json');
let credentialKeys = [];
try {
  const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
  credentialKeys = actions.servers?.[serverName]?.credentialKeys || [];
} catch (err) {
  console.error(`[mcp-launcher:${serverName}] No protected-actions config: ${err.message || 'file not found'}`);
}

// ---------------------------------------------------------------------------
// 3. Resolve each credential from 1Password
// ---------------------------------------------------------------------------
let resolvedCount = 0;
let skippedCount = 0;

for (const key of credentialKeys) {
  // Skip if already set (e.g., from CI/CD environment, service account, etc.)
  if (process.env[key]) {
    skippedCount++;
    continue;
  }

  const ref = mappings[key];
  if (!ref) {
    continue;
  }

  if (ref.startsWith('op://')) {
    // Resolve from 1Password
    try {
      const value = execFileSync('op', ['read', ref], {
        encoding: 'utf-8',
        timeout: 15000,
        env: process.env,
      }).trim();

      if (value) {
        process.env[key] = value;
        resolvedCount++;
      }
    } catch (err) {
      console.error(`[mcp-launcher:${serverName}] Failed to resolve ${key}: ${err.message || 'unknown error'}`);
    }
  } else {
    // Direct value (non-secret identifier like URL, zone ID, cloud ID)
    process.env[key] = ref;
    resolvedCount++;
  }
}

if (credentialKeys.length > 0) {
  console.error(`[mcp-launcher:${serverName}] Resolved ${resolvedCount}/${credentialKeys.length} credentials (${skippedCount} from env)`);
}

// ---------------------------------------------------------------------------
// 4. Import and run the actual MCP server
// ---------------------------------------------------------------------------
const absoluteScript = path.resolve(serverScript);
await import(absoluteScript);
