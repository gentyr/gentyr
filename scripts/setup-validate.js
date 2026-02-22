#!/usr/bin/env node
/**
 * GENTYR Permission Validator
 *
 * Validates that configured credentials have correct permissions by making
 * lightweight read-only API calls to each service's health check endpoint.
 * Credentials are resolved from vault-mappings.json (same as mcp-launcher.js)
 * and NEVER logged or included in output.
 *
 * Output: Single JSON object on stdout. Diagnostics go to stderr.
 *
 * Usage: node node_modules/gentyr/scripts/setup-validate.js [--repo owner/repo]
 *        node .claude-framework/scripts/setup-validate.js [--repo owner/repo]  (legacy)
 *
 * @version 1.0.0
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

function parseRepoArg() {
  const idx = process.argv.indexOf('--repo');
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  const parts = process.argv[idx + 1].split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

function parseGitRemote(projectDir) {
  try {
    const output = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      cwd: projectDir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // SSH: git@github.com:OWNER/REPO.git
    const sshMatch = output.match(/git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    // HTTPS: https://github.com/OWNER/REPO.git
    const httpsMatch = output.match(/https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

    return null;
  } catch {
    return null;
  }
}

function readVaultMappings(projectDir) {
  const mappingsPath = path.join(projectDir, '.claude', 'vault-mappings.json');
  try {
    const data = JSON.parse(fs.readFileSync(mappingsPath, 'utf8'));
    return data.mappings || {};
  } catch {
    return {};
  }
}

function loadOpTokenFromMcpJson(projectDir) {
  const mcpPath = path.join(projectDir, '.mcp.json');
  try {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    for (const server of Object.values(config.mcpServers || {})) {
      if (server.env && server.env.OP_SERVICE_ACCOUNT_TOKEN) {
        const mcpToken = server.env.OP_SERVICE_ACCOUNT_TOKEN;
        if (process.env.OP_SERVICE_ACCOUNT_TOKEN && process.env.OP_SERVICE_ACCOUNT_TOKEN !== mcpToken) {
          process.stderr.write('[setup-validate] OP_SERVICE_ACCOUNT_TOKEN in env differs from .mcp.json — using .mcp.json (source of truth)\n');
        } else if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
          process.stderr.write('[setup-validate] OP_SERVICE_ACCOUNT_TOKEN already in env (matches .mcp.json)\n');
          return;
        }
        process.env.OP_SERVICE_ACCOUNT_TOKEN = mcpToken;
        process.stderr.write('[setup-validate] Loaded OP_SERVICE_ACCOUNT_TOKEN from .mcp.json\n');
        return;
      }
    }
    process.stderr.write('[setup-validate] No OP_SERVICE_ACCOUNT_TOKEN found in .mcp.json server envs\n');
  } catch (err) {
    if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
      process.stderr.write('[setup-validate] Could not read .mcp.json, falling back to env token\n');
    } else {
      process.stderr.write(`[setup-validate] Failed to read .mcp.json: ${err.message}\n`);
    }
  }
}

function resolveAllCredentials(mappings) {
  const credentials = {};
  const opPathCache = new Map();

  for (const [key, ref] of Object.entries(mappings)) {
    if (!ref) continue;

    if (typeof ref === 'string' && ref.startsWith('op://')) {
      if (opPathCache.has(ref)) {
        credentials[key] = opPathCache.get(ref);
        continue;
      }

      try {
        const value = execFileSync('op', ['read', ref], {
          encoding: 'utf-8',
          timeout: 15000,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        credentials[key] = value;
        opPathCache.set(ref, value);
      } catch {
        process.stderr.write(`[setup-validate] Failed to resolve ${key}\n`);
      }
    } else {
      credentials[key] = ref;
    }
  }

  return credentials;
}

// ---------------------------------------------------------------------------
// Service Validators
// ---------------------------------------------------------------------------

async function validateVercel(creds) {
  const response = await fetchWithTimeout('https://api.vercel.com/v9/projects?limit=1', {
    headers: { Authorization: `Bearer ${creds.VERCEL_TOKEN}` },
  });

  if (response.status === 401) {
    return { status: 'fail', message: 'Token invalid or expired',
      remediation: 'Regenerate token at https://vercel.com/account/tokens' };
  }
  if (response.status === 403) {
    return { status: 'fail', message: 'Token valid but insufficient permissions',
      remediation: 'Create a new token with Full Account scope at https://vercel.com/account/tokens' };
  }
  if (!response.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${response.status}` };
  }

  const data = await response.json();
  const count = data.projects?.length ?? 0;
  return { status: 'pass', message: `Authenticated. ${count} project(s) accessible.` };
}

async function validateRender(creds) {
  const response = await fetchWithTimeout('https://api.render.com/v1/services?limit=1', {
    headers: { Authorization: `Bearer ${creds.RENDER_API_KEY}` },
  });

  if (response.status === 401) {
    return { status: 'fail', message: 'API key invalid or expired',
      remediation: 'Generate a new API key at https://dashboard.render.com/account/api-keys' };
  }
  if (!response.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${response.status}` };
  }

  const data = await response.json();
  const count = Array.isArray(data) ? data.length : 0;
  return { status: 'pass', message: `Authenticated. ${count} service(s) found.` };
}

async function validateGitHub(creds, options) {
  const { owner, repo } = options;
  if (!owner || !repo) {
    return { status: 'skip', message: 'Could not determine repo owner/name from git remote. Use --repo owner/repo.' };
  }

  const headers = {
    Authorization: `Bearer ${creds.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // Basic auth check
  const repoResponse = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}`, { headers });

  if (repoResponse.status === 401) {
    return { status: 'fail', message: 'Token invalid or expired',
      remediation: 'Regenerate fine-grained token at https://github.com/settings/tokens' };
  }
  if (repoResponse.status === 404) {
    return { status: 'fail', message: `Repository ${owner}/${repo} not accessible with this token`,
      remediation: 'Ensure token has access to this repository in its fine-grained settings' };
  }
  if (!repoResponse.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${repoResponse.status}` };
  }

  // Probe specific permission endpoints
  const permissionChecks = [
    { name: 'Actions', endpoint: `/repos/${owner}/${repo}/actions/runs?per_page=1` },
    { name: 'Issues', endpoint: `/repos/${owner}/${repo}/issues?per_page=1&state=all` },
    { name: 'Pull Requests', endpoint: `/repos/${owner}/${repo}/pulls?per_page=1&state=all` },
    { name: 'Secrets', endpoint: `/repos/${owner}/${repo}/actions/secrets` },
    { name: 'Environments', endpoint: `/repos/${owner}/${repo}/environments` },
  ];

  const results = await Promise.allSettled(
    permissionChecks.map(async (check) => {
      const r = await fetchWithTimeout(`https://api.github.com${check.endpoint}`, { headers });
      return { name: check.name, status: r.status };
    })
  );

  const accessible = [];
  const missing = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.status === 200) {
        accessible.push(result.value.name);
      } else {
        missing.push(result.value.name);
      }
    } else {
      missing.push('Unknown (timeout)');
    }
  }

  if (missing.length > 0) {
    return {
      status: 'warn',
      message: `Token valid but missing permissions: ${missing.join(', ')}`,
      permissions: { accessible, missing },
      remediation: 'Update fine-grained token permissions at https://github.com/settings/tokens. Required: Actions R/W, Contents R/W, Issues R/W, PRs R/W, Secrets R/W, Environments R/W',
    };
  }

  return { status: 'pass', message: `Authenticated with all required permissions for ${owner}/${repo}`,
    permissions: { accessible } };
}

async function validateCloudflare(creds) {
  if (!creds.CLOUDFLARE_ZONE_ID) {
    return { status: 'skip', message: 'CLOUDFLARE_ZONE_ID not configured' };
  }

  const response = await fetchWithTimeout(
    `https://api.cloudflare.com/client/v4/zones/${creds.CLOUDFLARE_ZONE_ID}`, {
      headers: { Authorization: `Bearer ${creds.CLOUDFLARE_API_TOKEN}` },
    });

  if (response.status === 401) {
    return { status: 'fail', message: 'API token invalid or expired',
      remediation: 'Create a new token with "Edit zone DNS" template at https://dash.cloudflare.com/profile/api-tokens' };
  }
  if (response.status === 403) {
    return { status: 'fail', message: 'Token valid but cannot access this zone',
      remediation: 'Ensure token has Zone DNS Edit permission for this specific zone' };
  }
  if (!response.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${response.status}` };
  }

  const data = await response.json();
  if (!data.success) {
    return { status: 'fail', message: `Cloudflare API error: ${data.errors?.map(e => e.message).join(', ') || 'unknown'}` };
  }

  const zoneName = data.result?.name || 'unknown';
  return { status: 'pass', message: `Authenticated. Zone: ${zoneName}` };
}

async function validateSupabase(creds) {
  if (!creds.SUPABASE_URL) {
    return { status: 'skip', message: 'SUPABASE_URL not configured' };
  }

  // Test 1: URL reachable via OpenAPI schema endpoint
  const schemaResponse = await fetchWithTimeout(`${creds.SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: creds.SUPABASE_ANON_KEY || creds.SUPABASE_SERVICE_ROLE_KEY || '' },
  });

  if (!schemaResponse.ok) {
    return { status: 'fail', message: `Supabase URL unreachable (HTTP ${schemaResponse.status})`,
      remediation: 'Verify SUPABASE_URL is correct. Find it at Supabase Dashboard > Project Settings > API > URL' };
  }

  const checks = ['URL reachable'];

  // Test 2: Service role key via storage bucket listing (requires service role)
  if (creds.SUPABASE_SERVICE_ROLE_KEY) {
    const bucketResponse = await fetchWithTimeout(`${creds.SUPABASE_URL}/storage/v1/bucket`, {
      headers: {
        apikey: creds.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${creds.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (bucketResponse.status === 401 || bucketResponse.status === 403) {
      return { status: 'fail', message: 'Service role key invalid',
        remediation: 'Get the correct service_role key from Supabase Dashboard > Project Settings > API' };
    }
    checks.push('service role key valid');
  }

  // Test 3: Anon key works
  if (creds.SUPABASE_ANON_KEY) {
    const anonResponse = await fetchWithTimeout(`${creds.SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: creds.SUPABASE_ANON_KEY },
    });

    if (anonResponse.status === 401) {
      return { status: 'warn', message: 'Anon key invalid (service role key works)',
        remediation: 'Get the correct anon key from Supabase Dashboard > Project Settings > API' };
    }
    checks.push('anon key valid');
  }

  // Test 4: Management access token (calls Supabase Management API)
  if (creds.SUPABASE_ACCESS_TOKEN) {
    const mgmtResponse = await fetchWithTimeout('https://api.supabase.com/v1/projects', {
      headers: { Authorization: `Bearer ${creds.SUPABASE_ACCESS_TOKEN}` },
    });
    if (mgmtResponse.status === 401 || mgmtResponse.status === 403) {
      return { status: 'warn', message: checks.join(', ') + ', access token invalid',
        remediation: 'Generate a new access token at https://supabase.com/dashboard/account/tokens' };
    }
    checks.push('access token valid');
  } else {
    return { status: 'warn', message: checks.join(', ') + ', access token not configured',
      remediation: 'Generate an access token at https://supabase.com/dashboard/account/tokens. Enables SQL, migrations, and schema MCP tools.' };
  }

  return { status: 'pass', message: checks.join(', ') };
}

async function validateResend(creds) {
  // GET /domains requires full access; send-only keys get 401 with "restricted_api_key"
  const domainsResponse = await fetchWithTimeout('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${creds.RESEND_API_KEY}` },
  });

  if (domainsResponse.status === 401) {
    // Resend returns 401 for both invalid keys AND restricted (send-only) keys.
    // Parse response body to distinguish them.
    try {
      const body = await domainsResponse.json();
      if (body.name === 'restricted_api_key') {
        return {
          status: 'warn',
          message: 'API key valid but has "Sending access" only. Domain management and API key tools will not work.',
          permissions: { level: 'sending_only' },
          remediation: 'For full MCP functionality, create a "Full access" API key at https://resend.com/api-keys. Send-only is sufficient if you only need email sending.',
        };
      }
    } catch {
      // JSON parse failed — treat as invalid key
    }
    return { status: 'fail', message: 'API key invalid or expired',
      remediation: 'Generate a new API key at https://resend.com/api-keys' };
  }

  if (!domainsResponse.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${domainsResponse.status}` };
  }

  const data = await domainsResponse.json();
  const domainCount = data.data?.length ?? 0;
  return { status: 'pass', message: `Authenticated with full access. ${domainCount} domain(s) configured.`,
    permissions: { level: 'full_access' } };
}

async function validateElastic(creds) {
  const cloudId = creds.ELASTIC_CLOUD_ID;
  const endpoint = creds.ELASTIC_ENDPOINT;

  if (!cloudId && !endpoint) {
    return { status: 'skip', message: 'Neither ELASTIC_CLOUD_ID nor ELASTIC_ENDPOINT configured' };
  }

  let baseUrl;
  if (endpoint) {
    baseUrl = endpoint;
  } else {
    // Decode Cloud ID: deployment-name:base64(es-host$kibana-host)
    const parts = cloudId.split(':');
    if (parts.length !== 2) {
      return { status: 'fail', message: 'Invalid ELASTIC_CLOUD_ID format (expected name:base64)',
        remediation: 'Get Cloud ID from Elastic Cloud > Deployments > your deployment > Cloud ID' };
    }
    try {
      const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
      const [esHost] = decoded.split('$');
      baseUrl = `https://${esHost}`;
    } catch {
      return { status: 'fail', message: 'Failed to decode ELASTIC_CLOUD_ID base64 portion' };
    }
  }

  const response = await fetchWithTimeout(`${baseUrl}/logs-*/_search`, {
    method: 'POST',
    headers: {
      Authorization: `ApiKey ${creds.ELASTIC_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ size: 0 }),
  });

  if (response.status === 401) {
    return { status: 'fail', message: 'API key invalid or expired',
      remediation: 'Generate a new read-only API key at Elastic Cloud > Deployment > Security > API Keys' };
  }
  if (response.status === 403) {
    return { status: 'fail', message: 'API key valid but cannot read logs-* indices',
      remediation: 'Ensure API key has read privileges on logs-* indices' };
  }
  if (response.status === 404) {
    return { status: 'warn', message: 'Connected but no logs-* indices exist yet. This is normal for new deployments.' };
  }
  if (!response.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${response.status}` };
  }

  const data = await response.json();
  const totalHits = data.hits?.total?.value ?? 0;
  return { status: 'pass', message: `Connected. ${totalHits} log entries in logs-* indices.` };
}

async function validateCodecov(creds, options) {
  const { owner } = options;
  if (!owner) {
    return { status: 'skip', message: 'Could not determine repo owner from git remote' };
  }

  const response = await fetchWithTimeout(
    `https://api.codecov.io/api/v2/github/${encodeURIComponent(owner)}/repos/?page_size=1`, {
      headers: {
        Authorization: `token ${creds.CODECOV_TOKEN}`,
        Accept: 'application/json',
      },
    });

  if (response.status === 401 || response.status === 403) {
    return { status: 'fail', message: 'Token invalid or does not have access to this organization',
      remediation: 'Get upload token from https://app.codecov.io > Repository Settings' };
  }
  if (!response.ok) {
    return { status: 'fail', message: `Unexpected HTTP ${response.status}` };
  }

  return { status: 'pass', message: `Authenticated. Repos accessible for ${owner}.` };
}

function validateOnePassword() {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    return { status: 'fail', message: '1Password service account token not configured',
      remediation: 'Run setup.sh with --op-token or set OP_SERVICE_ACCOUNT_TOKEN' };
  }

  // Use `op whoami` as primary auth check — works with all permission levels.
  // `op vault list` can return 403 for scoped service account tokens that have
  // read access to specific vaults but not vault enumeration permissions.
  try {
    const whoamiOutput = execFileSync('op', ['whoami', '--format', 'json'], {
      encoding: 'utf-8',
      timeout: 10000,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const whoami = JSON.parse(whoamiOutput);
    const identity = whoami.url || whoami.email || 'service account';

    // Optional: try vault list for richer status message
    try {
      const vaultOutput = execFileSync('op', ['vault', 'list', '--format', 'json'], {
        encoding: 'utf-8',
        timeout: 10000,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const vaults = JSON.parse(vaultOutput);
      if (Array.isArray(vaults) && vaults.length > 0) {
        return { status: 'pass', message: `Authenticated as ${identity}. ${vaults.length} vault(s) accessible.` };
      }
      return { status: 'warn', message: `Authenticated as ${identity} but no vaults accessible`,
        remediation: 'Grant the service account access to at least one vault in 1Password Settings > Integrations > Service Accounts' };
    } catch {
      // vault list failed but whoami succeeded — token is valid with scoped permissions
      return { status: 'pass', message: `Authenticated as ${identity}. Vault enumeration not permitted (op read still works).` };
    }
  } catch (err) {
    const stderr = err.stderr || '';
    const message = (err.message || '') + ' ' + stderr;
    if (message.includes('not signed in') || message.includes('unauthorized') || message.includes('401')) {
      return { status: 'fail', message: '1Password CLI not authenticated',
        remediation: 'Run `op signin` or set OP_SERVICE_ACCOUNT_TOKEN' };
    }
    if (message.includes('403') || message.includes('Forbidden')) {
      return { status: 'fail', message: '1Password service account token invalid or revoked',
        remediation: 'Generate a new service account token in 1Password Settings > Integrations > Service Accounts, then reinstall GENTYR with --op-token' };
    }
    return { status: 'fail', message: '1Password CLI error: ' + (stderr.trim() || err.message || 'unknown'),
      remediation: 'Check `op` CLI installation: brew install --cask 1password-cli' };
  }
}

function validateShellSync() {
  // Find the .mcp.json token (source of truth)
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const mcpPath = path.join(projectDir, '.mcp.json');
  let mcpToken = null;
  try {
    const config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    for (const server of Object.values(config.mcpServers || {})) {
      if (server.env && server.env.OP_SERVICE_ACCOUNT_TOKEN) {
        mcpToken = server.env.OP_SERVICE_ACCOUNT_TOKEN;
        break;
      }
    }
  } catch {
    return { status: 'warn', message: 'Could not read .mcp.json to compare tokens' };
  }

  if (!mcpToken) {
    return { status: 'warn', message: 'No OP_SERVICE_ACCOUNT_TOKEN in .mcp.json' };
  }

  // Find shell profile
  const profilePath = fs.existsSync(path.join(process.env.HOME, '.zshrc'))
    ? path.join(process.env.HOME, '.zshrc')
    : fs.existsSync(path.join(process.env.HOME, '.bashrc'))
      ? path.join(process.env.HOME, '.bashrc')
      : null;

  if (!profilePath) {
    return { status: 'warn', message: 'No .zshrc or .bashrc found',
      remediation: 'Run setup.sh to create managed OP block in shell profile' };
  }

  let profileContent;
  try {
    profileContent = fs.readFileSync(profilePath, 'utf8');
  } catch {
    return { status: 'warn', message: `Could not read ${profilePath}` };
  }

  // Check for managed block
  const hasBlock = profileContent.includes('# BEGIN GENTYR OP') && profileContent.includes('# END GENTYR OP');
  if (!hasBlock) {
    // Check for legacy unmanaged export
    if (profileContent.includes('export OP_SERVICE_ACCOUNT_TOKEN=')) {
      return { status: 'fail', message: 'Unmanaged OP_SERVICE_ACCOUNT_TOKEN in shell profile (not in GENTYR block)',
        remediation: 'Run setup.sh to replace with managed block' };
    }
    return { status: 'fail', message: 'No GENTYR OP block in shell profile',
      remediation: 'Run setup.sh to add managed OP block' };
  }

  // Extract token from managed block
  const blockMatch = profileContent.match(/# BEGIN GENTYR OP\n[\s\S]*?export OP_SERVICE_ACCOUNT_TOKEN="?([^"\s]+)"?\n[\s\S]*?# END GENTYR OP/);
  if (!blockMatch) {
    return { status: 'fail', message: 'GENTYR OP block found but could not parse token',
      remediation: 'Run setup.sh to regenerate managed block' };
  }

  const shellToken = blockMatch[1];
  if (shellToken === mcpToken) {
    return { status: 'pass', message: `Shell profile in sync with .mcp.json (${path.basename(profilePath)})` };
  }

  return { status: 'fail', message: 'Shell OP token differs from .mcp.json (source of truth)',
    remediation: 'Run setup.sh to re-sync shell profile with .mcp.json token' };
}

// ---------------------------------------------------------------------------
// Service Validator Registry
// ---------------------------------------------------------------------------

const SERVICE_VALIDATORS = [
  {
    name: 'vercel',
    credentialKeys: ['VERCEL_TOKEN'],
    validate: validateVercel,
  },
  {
    name: 'render',
    credentialKeys: ['RENDER_API_KEY'],
    validate: validateRender,
  },
  {
    name: 'github',
    credentialKeys: ['GITHUB_TOKEN'],
    validate: validateGitHub,
  },
  {
    name: 'cloudflare',
    credentialKeys: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE_ID'],
    validate: validateCloudflare,
  },
  {
    name: 'supabase',
    credentialKeys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_ACCESS_TOKEN'],
    validate: validateSupabase,
  },
  {
    name: 'resend',
    credentialKeys: ['RESEND_API_KEY'],
    validate: validateResend,
  },
  {
    name: 'elastic',
    credentialKeys: ['ELASTIC_API_KEY'],
    altCredentialKeys: { connection: ['ELASTIC_CLOUD_ID', 'ELASTIC_ENDPOINT'] },
    validate: validateElastic,
  },
  {
    name: 'codecov',
    credentialKeys: ['CODECOV_TOKEN'],
    validate: validateCodecov,
  },
  {
    name: 'onepassword',
    credentialKeys: [],
    validate: validateOnePassword,
  },
  {
    name: 'shellSync',
    credentialKeys: [],
    validate: validateShellSync,
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const repoArg = parseRepoArg();
  const gitRepo = parseGitRemote(projectDir);
  const repo = repoArg || gitRepo;

  // Load vault mappings and resolve credentials
  loadOpTokenFromMcpJson(projectDir);
  const mappings = readVaultMappings(projectDir);
  const credentials = resolveAllCredentials(mappings);

  // Run all validations in parallel
  const results = {};

  const validationPromises = SERVICE_VALIDATORS.map(async (validator) => {
    // Check if all required credentials are available
    const requiredKeys = [...validator.credentialKeys];

    // For services with alt keys, require at least one alternative
    if (validator.altCredentialKeys) {
      for (const alts of Object.values(validator.altCredentialKeys)) {
        const hasAlt = alts.some(k => credentials[k]);
        if (!hasAlt) {
          requiredKeys.push(alts.join(' or '));
        }
      }
    }

    const missingKeys = validator.credentialKeys.filter(k => !credentials[k]);

    // For alt keys, check if at least one is present
    if (validator.altCredentialKeys) {
      for (const alts of Object.values(validator.altCredentialKeys)) {
        if (!alts.some(k => credentials[k])) {
          missingKeys.push(alts.join(' or '));
        }
      }
    }

    if (missingKeys.length > 0) {
      results[validator.name] = {
        status: 'skip',
        message: `Missing credentials: ${missingKeys.join(', ')}`,
        credentialKeys: validator.credentialKeys,
      };
      return;
    }

    try {
      const result = await Promise.race([
        Promise.resolve(validator.validate(credentials, { owner: repo?.owner, repo: repo?.repo })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Validation timed out after 10s')), 10000)),
      ]);
      results[validator.name] = { ...result, credentialKeys: validator.credentialKeys };
    } catch (err) {
      results[validator.name] = {
        status: 'fail',
        message: `Validation error: ${err.message}`,
        credentialKeys: validator.credentialKeys,
      };
    }
  });

  await Promise.allSettled(validationPromises);

  // Build summary
  const statuses = Object.values(results);
  const summary = {
    totalServices: SERVICE_VALIDATORS.length,
    passed: statuses.filter(r => r.status === 'pass').length,
    failed: statuses.filter(r => r.status === 'fail').length,
    warnings: statuses.filter(r => r.status === 'warn').length,
    skipped: statuses.filter(r => r.status === 'skip').length,
    repo: repo ? `${repo.owner}/${repo.repo}` : null,
  };

  const output = {
    services: results,
    summary,
    timestamp: new Date().toISOString(),
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(err => {
  process.stderr.write(`[setup-validate] Fatal error: ${err.message}\n`);
  process.stdout.write(JSON.stringify({
    services: {},
    summary: { totalServices: 0, passed: 0, failed: 0, warnings: 0, skipped: 0, repo: null },
    error: err.message,
    timestamp: new Date().toISOString(),
  }, null, 2) + '\n');
  process.exit(1);
});
