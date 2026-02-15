#!/usr/bin/env node
/**
 * GENTYR Setup Check
 *
 * Performs ALL credential evaluation programmatically and outputs structured JSON.
 * Called by the /setup-gentyr agent to get a complete picture of the project's
 * credential state in one invocation — no individual bash commands needed.
 *
 * Output: Single JSON object on stdout. All diagnostic/error messages go to stderr.
 *
 * Usage: node .claude-framework/scripts/setup-check.js
 *
 * @version 1.0.0
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Credential Registry (authoritative source of truth)
// ---------------------------------------------------------------------------

const CREDENTIALS = [
  { key: 'GITHUB_TOKEN',              type: 'secret',     opPath: 'op://Production/GitHub/token',              setupGuidePhase: 'Phase 2: GitHub Token' },
  { key: 'GITHUB_PAT',                type: 'secret',     opPath: 'op://Production/GitHub/token',              setupGuidePhase: 'Phase 2: GitHub Token' },
  { key: 'RENDER_API_KEY',            type: 'secret',     opPath: 'op://Production/Render/api-key',            setupGuidePhase: 'Phase 3: Render API Key' },
  { key: 'VERCEL_TOKEN',              type: 'secret',     opPath: 'op://Production/Vercel/token',              setupGuidePhase: 'Phase 4: Vercel Token' },
  { key: 'CLOUDFLARE_API_TOKEN',      type: 'secret',     opPath: 'op://Production/Cloudflare/api-token',      setupGuidePhase: 'Phase 5: Cloudflare API Token' },
  { key: 'SUPABASE_SERVICE_ROLE_KEY', type: 'secret',     opPath: 'op://Production/Supabase/service-role-key', setupGuidePhase: 'Phase 6: Supabase Credentials' },
  { key: 'RESEND_API_KEY',            type: 'secret',     opPath: 'op://Production/Resend/api-key',            setupGuidePhase: 'Phase 8: Resend API Key' },
  { key: 'ELASTIC_API_KEY',           type: 'secret',     opPath: 'op://Production/Elastic/api-key-query',     setupGuidePhase: 'Phase 7: Elastic Cloud Credentials' },
  { key: 'CODECOV_TOKEN',             type: 'secret',     opPath: 'op://Production/Codecov/token',             setupGuidePhase: 'Phase 9: Codecov Token' },
  { key: 'OP_CONNECT_TOKEN',          type: 'secret',     opPath: 'op://Production/1Password/connect-token',   setupGuidePhase: 'Phase 1: 1Password Service Account' },
  { key: 'CLOUDFLARE_ZONE_ID',        type: 'identifier', opPath: null,                                        setupGuidePhase: 'Phase 5: Cloudflare API Token' },
  { key: 'SUPABASE_URL',              type: 'identifier', opPath: null,                                        setupGuidePhase: 'Phase 6: Supabase Credentials' },
  { key: 'SUPABASE_ANON_KEY',         type: 'identifier', opPath: null,                                        setupGuidePhase: 'Phase 6: Supabase Credentials' },
  { key: 'ELASTIC_CLOUD_ID',          type: 'identifier', opPath: null,                                        setupGuidePhase: 'Phase 7: Elastic Cloud Credentials', altKey: 'ELASTIC_ENDPOINT' },
  { key: 'SUPABASE_ACCESS_TOKEN',    type: 'secret',     opPath: 'op://Production/Supabase/access-token',     setupGuidePhase: 'Phase 6: Supabase Credentials' },
];

// ---------------------------------------------------------------------------
// Step 1: Check GENTYR installation
// ---------------------------------------------------------------------------

function checkGentyrInstalled(projectDir) {
  const frameworkPath = path.join(projectDir, '.claude-framework');
  try {
    const stat = fs.lstatSync(frameworkPath);
    return stat.isSymbolicLink() || stat.isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 1b: Load OP_SERVICE_ACCOUNT_TOKEN from .mcp.json (source of truth)
// ---------------------------------------------------------------------------

function loadOpTokenFromMcpJson(projectDir) {
  const mcpPath = path.join(projectDir, '.mcp.json');
  try {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    for (const server of Object.values(config.mcpServers || {})) {
      if (server.env && server.env.OP_SERVICE_ACCOUNT_TOKEN) {
        const mcpToken = server.env.OP_SERVICE_ACCOUNT_TOKEN;
        if (process.env.OP_SERVICE_ACCOUNT_TOKEN && process.env.OP_SERVICE_ACCOUNT_TOKEN !== mcpToken) {
          process.stderr.write('[setup-check] OP_SERVICE_ACCOUNT_TOKEN in env differs from .mcp.json — using .mcp.json (source of truth)\n');
        } else if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
          process.stderr.write('[setup-check] OP_SERVICE_ACCOUNT_TOKEN already in env (matches .mcp.json)\n');
          return;
        }
        process.env.OP_SERVICE_ACCOUNT_TOKEN = mcpToken;
        process.stderr.write('[setup-check] Loaded OP_SERVICE_ACCOUNT_TOKEN from .mcp.json\n');
        return;
      }
    }
    process.stderr.write('[setup-check] No OP_SERVICE_ACCOUNT_TOKEN found in .mcp.json server envs\n');
  } catch (err) {
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      process.stderr.write('[setup-check] Could not read .mcp.json, falling back to env token\n');
    } else {
      process.stderr.write(`[setup-check] Failed to read .mcp.json: ${err.message}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: Check 1Password CLI availability and authentication
// ---------------------------------------------------------------------------

function checkOpCli() {
  const result = { available: false, version: null, authenticated: false, account: null };

  try {
    const version = execFileSync('op', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    result.available = true;
    result.version = version;
  } catch {
    return result;
  }

  try {
    const vaultRaw = execFileSync('op', ['vault', 'list', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 8000,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const vaults = JSON.parse(vaultRaw);
    result.authenticated = true;
    result.account = vaults.length > 0 ? vaults[0].name : 'service-account';
  } catch {
    // Not authenticated — token missing, invalid, or expired
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: Read vault-mappings.json
// ---------------------------------------------------------------------------

function readVaultMappings(projectDir) {
  const mappingsPath = path.join(projectDir, '.claude', 'vault-mappings.json');
  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    return { exists: true, mappings: data.mappings || {} };
  } catch {
    return { exists: false, mappings: {} };
  }
}

// ---------------------------------------------------------------------------
// Step 4: Check a single secret's existence in 1Password
// ---------------------------------------------------------------------------

function checkOpSecret(opPath) {
  try {
    execFileSync('op', ['read', opPath], {
      encoding: 'utf-8',
      timeout: 5000,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const gentyrInstalled = checkGentyrInstalled(projectDir);
  loadOpTokenFromMcpJson(projectDir);
  const op = checkOpCli();
  const vault = readVaultMappings(projectDir);

  // Deduplicate op:// paths (GITHUB_TOKEN and GITHUB_PAT share the same path)
  const opPathCache = new Map();

  const credentials = {};
  let secretsConfigured = 0;
  let secretsMissing = 0;
  let identifiersConfigured = 0;
  let identifiersMissing = 0;

  for (const cred of CREDENTIALS) {
    let existsInOp = null;

    if (cred.type === 'secret' && cred.opPath) {
      if (op.available && op.authenticated) {
        if (opPathCache.has(cred.opPath)) {
          existsInOp = opPathCache.get(cred.opPath);
        } else {
          existsInOp = checkOpSecret(cred.opPath);
          opPathCache.set(cred.opPath, existsInOp);
        }
      }
    }

    // For identifiers with alternatives (e.g., ELASTIC_CLOUD_ID / ELASTIC_ENDPOINT),
    // consider configured if either the key or its alternative is mapped
    const selfMapped = cred.key in vault.mappings && Boolean(vault.mappings[cred.key]);
    const altMapped = cred.altKey ? (cred.altKey in vault.mappings && Boolean(vault.mappings[cred.altKey])) : false;
    const mappedInVault = selfMapped || altMapped;

    if (cred.type === 'secret') {
      // Secret is "configured" if mapped AND not known-missing from 1Password
      if (mappedInVault && existsInOp !== false) {
        secretsConfigured++;
      } else {
        secretsMissing++;
      }
    } else {
      if (mappedInVault) {
        identifiersConfigured++;
      } else {
        identifiersMissing++;
      }
    }

    credentials[cred.key] = {
      type: cred.type,
      opPath: cred.opPath,
      existsInOp,
      mappedInVault,
      setupGuidePhase: cred.setupGuidePhase,
    };
  }

  const output = {
    gentyrInstalled,
    opCliAvailable: op.available,
    opCliVersion: op.version,
    opAuthenticated: op.authenticated,
    opAccount: op.account,
    vaultMappingsExists: vault.exists,
    credentials,
    summary: {
      totalCredentials: CREDENTIALS.length,
      secretsConfigured,
      secretsMissing,
      identifiersConfigured,
      identifiersMissing,
      requiresOpAuth: op.available && !op.authenticated && secretsMissing > 0,
    },
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
