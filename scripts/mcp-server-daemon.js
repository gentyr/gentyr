#!/usr/bin/env node
/**
 * Shared MCP Server Daemon
 *
 * Hosts Tier 1 (stateless/read-only) MCP servers in a single process
 * with HTTP transport, eliminating per-session process overhead.
 *
 * A single daemon process replaces ~15 per-session stdio processes,
 * saving ~750MB RAM per concurrent agent.
 *
 * Two-phase startup: HTTP server binds immediately (health endpoint
 * responds with status:'starting'), then credentials resolve in
 * parallel and server modules load (status:'ok').
 *
 * Usage: node scripts/mcp-server-daemon.js
 *
 * Environment:
 *   CLAUDE_PROJECT_DIR       - Project directory (required)
 *   MCP_DAEMON_PORT          - Port to listen on (default: 18090)
 *   OP_SERVICE_ACCOUNT_TOKEN - 1Password token (optional)
 *   GENTYR_LAUNCHD_SERVICE   - Set to 'true' in headless launchd context
 *
 * @version 2.0.0
 */

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.MCP_DAEMON_PORT || '18090', 10);
const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

if (!PROJECT_DIR) {
  process.stderr.write('[mcp-daemon] FATAL: CLAUDE_PROJECT_DIR is required\n');
  process.exit(1);
}

// Enforce CWD — launchd WorkingDirectory is unreliable
try { process.chdir(PROJECT_DIR); } catch (err) {
  process.stderr.write(`[mcp-daemon] FATAL: Cannot chdir to ${PROJECT_DIR}: ${err.message}\n`);
  process.exit(1);
}

const LOG_FILE = path.join(PROJECT_DIR, '.claude', 'mcp-daemon.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr.write(line + '\n');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch { /* non-fatal */ }
}

// Set flag before importing any server modules so they skip stdio transport
process.env.MCP_SHARED_DAEMON = '1';

import { TIER1_SERVERS } from '../lib/shared-mcp-config.js';

const DIST_DIR = path.join(__dirname, '..', 'packages', 'mcp-servers', 'dist');
const stateDir = path.join(PROJECT_DIR, '.claude', 'state');
const stateFile = path.join(stateDir, 'shared-mcp-daemon.json');

// ---------------------------------------------------------------------------
// Phase 1: Start HTTP Server immediately (responds with status:'starting')
// ---------------------------------------------------------------------------

const servers = new Map();
let daemonReady = false;

const { startSharedHttpServer } = await import(
  path.join(DIST_DIR, 'shared', 'http-transport.js')
);

const { httpServer, close } = startSharedHttpServer({
  port: PORT,
  servers,
  isReady: () => daemonReady,
});

log(`HTTP server listening on port ${PORT} (status: starting)`);

// ---------------------------------------------------------------------------
// Phase 2: Resolve credentials in parallel, then load server modules
// ---------------------------------------------------------------------------

async function resolveAllCredentials() {
  const mappingsPath = path.join(PROJECT_DIR, '.claude', 'vault-mappings.json');
  const actionsPath = path.join(PROJECT_DIR, '.claude', 'hooks', 'protected-actions.json');

  let mappings = {};
  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    mappings = data.mappings || {};
  } catch (err) {
    log(`No vault mappings (${err.message || 'file not found'}) — starting without credentials`);
  }

  let actions = {};
  try {
    actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
  } catch (err) {
    log(`No protected-actions config (${err.message || 'file not found'}) — no credential keys known`);
  }

  // Collect all unique credential keys needed by Tier 1 servers
  const allKeys = new Set();
  for (const serverName of TIER1_SERVERS) {
    const keys = actions.servers?.[serverName]?.credentialKeys || [];
    for (const k of keys) { allKeys.add(k); }
  }

  let resolved = 0;
  let skipped = 0;
  let failed = 0;

  // Separate direct values (sync) from op:// refs (async parallel)
  const opReads = [];

  for (const key of allKeys) {
    if (process.env[key]) {
      skipped++;
      continue;
    }

    const ref = mappings[key];
    if (!ref) { continue; }

    if (ref.startsWith('op://')) {
      if (process.env.GENTYR_LAUNCHD_SERVICE === 'true' && !process.env.OP_SERVICE_ACCOUNT_TOKEN) {
        log(`Skipping ${key}: headless automation, no OP_SERVICE_ACCOUNT_TOKEN`);
        continue;
      }
      opReads.push({ key, ref });
    } else {
      // Direct value (non-secret identifier like URL, zone ID)
      process.env[key] = ref;
      resolved++;
    }
  }

  // Resolve all op:// references in parallel
  if (opReads.length > 0) {
    const startTime = Date.now();
    const results = await Promise.allSettled(
      opReads.map(({ key, ref }) =>
        execFileAsync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          env: process.env,
        }).then(({ stdout }) => ({ key, value: stdout.trim() }))
      )
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled' && result.value.value) {
        process.env[result.value.key] = result.value.value;
        resolved++;
      } else {
        const reason = result.status === 'rejected' ? result.reason?.message : 'empty value';
        log(`Failed to resolve ${opReads[i].key}: ${reason || 'unknown error'}`);
        failed++;
      }
    }

    log(`Parallel op:// resolution: ${opReads.length} refs in ${Date.now() - startTime}ms`);
  }

  log(`Credentials: resolved=${resolved} skipped(from-env)=${skipped} failed=${failed} total=${allKeys.size}`);
}

await resolveAllCredentials();

// ---------------------------------------------------------------------------
// Load Tier 1 Server Modules
// ---------------------------------------------------------------------------

for (const name of TIER1_SERVERS) {
  const serverPath = path.join(DIST_DIR, name, 'server.js');
  try {
    if (name === 'feedback-explorer') {
      // Uses a factory function pattern
      const mod = await import(serverPath);
      if (typeof mod.createFeedbackExplorerServer !== 'function') {
        throw new Error('createFeedbackExplorerServer is not exported');
      }
      const projectDir = path.resolve(PROJECT_DIR);
      const instance = mod.createFeedbackExplorerServer({ projectDir });
      servers.set(name, instance);
    } else {
      const mod = await import(serverPath);
      if (!mod.server) {
        throw new Error(`server is not exported from ${name}/server.js`);
      }
      servers.set(name, mod.server);
    }
    log(`Loaded: ${name}`);
  } catch (err) {
    log(`Failed to load ${name}: ${err.message}`);
    // Non-fatal: continue loading remaining servers
  }
}

if (servers.size === 0) {
  log('FATAL: No servers loaded — exiting');
  process.exit(1);
}

// Mark as ready — health endpoint now returns status:'ok'
daemonReady = true;

// ---------------------------------------------------------------------------
// Write State File (for config-gen detection)
// ---------------------------------------------------------------------------

try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: process.pid,
    port: PORT,
    servers: [...servers.keys()],
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');
} catch (err) {
  log(`Warning: could not write state file: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Cleanup on Exit
// ---------------------------------------------------------------------------

function cleanup() {
  try { fs.unlinkSync(stateFile); } catch { /* non-fatal */ }
}

process.on('SIGINT', async () => {
  cleanup();
  try {
    await Promise.race([close(), new Promise(r => setTimeout(r, 5000))]);
  } catch { /* non-fatal */ }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  cleanup();
  try {
    await Promise.race([close(), new Promise(r => setTimeout(r, 5000))]);
  } catch { /* non-fatal */ }
  process.exit(0);
});

process.on('exit', cleanup);

log(`Shared MCP daemon ready: ${servers.size}/${TIER1_SERVERS.length} servers on port ${PORT}`);
