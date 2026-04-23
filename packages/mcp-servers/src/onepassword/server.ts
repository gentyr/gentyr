/**
 * 1Password MCP Server
 *
 * Tools for reading secrets, listing vault items, managing service accounts,
 * and reviewing audit logs via the 1Password CLI.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * @version 2.0.0
 */

import { execFileSync } from 'child_process';
import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  readSecretSchema,
  listItemsSchema,
  createServiceAccountSchema,
  getAuditLogSchema,
  checkAuthSchema,
  opVaultMapSchema,
  type ReadSecretArgs,
  type ListItemsArgs,
  type CreateServiceAccountArgs,
  type GetAuditLogArgs,
  type CheckAuthArgs,
  type OpVaultMapArgs,
} from './types.js';

// Helper: Execute op CLI command (uses execFileSync to prevent shell injection)
function opCommand(args: string[], timeoutMs = 30000): string {
  try {
    const result = execFileSync('op', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env: {
        ...process.env,
        OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN,
      },
    });
    return result.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`1Password CLI error: ${message}`);
  }
}

// Tool: Read secret from vault
async function readSecret(args: ReadSecretArgs) {
  const parsed = readSecretSchema.parse(args);
  const value = opCommand(['read', parsed.reference]);

  if (parsed.include_value) {
    return {
      value,
      reference: parsed.reference,
      warning: 'Raw secret is now in conversation context. Do NOT write to files or logs.',
    };
  }

  return {
    reference: parsed.reference,
    exists: true,
    message: 'Secret exists and is readable. Use secret_run_command to inject into processes — do not request the raw value.',
  };
}

// Tool: List items in vault
async function listItems(args: ListItemsArgs) {
  const parsed = listItemsSchema.parse(args);

  const cmdArgs = ['item', 'list', '--format', 'json'];
  if (parsed.vault) { cmdArgs.push('--vault', parsed.vault); }
  if (parsed.categories?.length) { cmdArgs.push('--categories', parsed.categories.join(',')); }
  if (parsed.tags?.length) { cmdArgs.push('--tags', parsed.tags.join(',')); }

  const json = opCommand(cmdArgs);
  const items = JSON.parse(json) as Array<{
    id: string;
    title: string;
    category: string;
    vault?: { name: string };
    tags?: string[];
    updated_at: string;
  }>;

  return {
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      category: item.category,
      vault: item.vault?.name,
      tags: item.tags || [],
      updatedAt: item.updated_at,
    })),
    count: items.length,
  };
}

// Tool: Create service account (admin only)
async function createServiceAccount(args: CreateServiceAccountArgs) {
  const parsed = createServiceAccountSchema.parse(args);

  const cmdArgs = [
    'service-account', 'create', parsed.name,
    '--vault', parsed.vaults.join(','),
  ];
  if (parsed.expiresInDays) {
    cmdArgs.push('--expires-in', `${parsed.expiresInDays}d`);
  }

  const output = opCommand(cmdArgs);
  const tokenMatch = output.match(/Token:\s+(.+)/);
  const hasToken = !!tokenMatch;

  return {
    success: true,
    hasToken,
    message: hasToken
      ? 'Service account created. Retrieve token from 1Password CLI directly — token is not returned here for security (G004).'
      : 'Service account created but token was not found in output. Check 1Password CLI.',
  };
}

// Tool: Get audit log
async function getAuditLog(args: GetAuditLogArgs) {
  const parsed = getAuditLogSchema.parse(args);

  const from = parsed.from || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = parsed.to || new Date().toISOString();

  const cmdArgs = [
    'events', 'list',
    '--vault', parsed.vault,
    '--start', from,
    '--end', to,
    '--format', 'json',
  ];
  if (parsed.action) { cmdArgs.push('--action', parsed.action); }

  const json = opCommand(cmdArgs);
  const events = JSON.parse(json) as Array<{
    timestamp: string;
    actor: string;
    action: string;
    resource: string;
    details: unknown;
  }>;

  return {
    events: events.map((e) => ({
      timestamp: e.timestamp,
      actor: e.actor,
      action: e.action,
      resource: e.resource,
      details: e.details,
    })),
    count: events.length,
    timeRange: { from, to },
  };
}

// Tool: Check 1Password authentication status (no secret access, no CTO approval)
async function checkAuth(args: CheckAuthArgs) {
  checkAuthSchema.parse(args);
  const hasToken = !!process.env.OP_SERVICE_ACCOUNT_TOKEN;

  if (!hasToken) {
    return {
      authenticated: false,
      message: '1Password is not configured — OP_SERVICE_ACCOUNT_TOKEN is not set. Run /setup-gentyr to configure.',
    };
  }

  try {
    const result = opCommand(['whoami', '--format', 'json']);
    const info = JSON.parse(result) as { url?: string; email?: string; user_uuid?: string };
    return {
      authenticated: true,
      account_url: info.url,
      email: info.email,
      message: `1Password authenticated as ${info.email || 'service account'} (${info.url || 'unknown'}).`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const isAuthError = msg.includes('not signed in') || msg.includes('auth') || msg.includes('session expired') || msg.includes('401');
    return {
      authenticated: false,
      message: isAuthError
        ? '1Password is not authenticated. Please unlock the 1Password desktop app or re-authenticate before running demos that require credentials.'
        : `1Password connectivity check failed: ${msg.slice(0, 200)}`,
    };
  }
}

// Tool: Full vault map with op:// references for all items and fields
async function opVaultMap(args: OpVaultMapArgs) {
  const parsed = opVaultMapSchema.parse(args);

  // Step 1: Get vaults
  let vaults: Array<{ id: string; name: string }>;
  if (parsed.vault) {
    vaults = [{ id: parsed.vault, name: parsed.vault }];
  } else {
    const vaultJson = opCommand(['vault', 'list', '--format', 'json']);
    vaults = JSON.parse(vaultJson) as Array<{ id: string; name: string }>;
  }

  const result: Array<{
    name: string;
    items: Array<{
      id: string;
      title: string;
      category: string;
      fields: Array<{ label: string; reference: string; type: string; section: string | null }>;
    }>;
  }> = [];

  let totalItems = 0;
  let totalFields = 0;

  for (const vault of vaults) {
    // Step 2: List items in vault
    const itemsJson = opCommand(['item', 'list', '--vault', vault.name, '--format', 'json']);
    const items = JSON.parse(itemsJson) as Array<{ id: string; title: string; category: string }>;

    const vaultItems: typeof result[0]['items'] = [];

    for (const item of items) {
      // Step 3: Get full item detail with field references
      try {
        const detailJson = opCommand(['item', 'get', item.id, '--format', 'json']);
        const detail = JSON.parse(detailJson) as {
          fields?: Array<{
            label?: string;
            reference?: string;
            type?: string;
            section?: { label?: string };
            purpose?: string;
          }>;
        };

        // SECURITY: only extract reference metadata — never include f.value (contains actual secret)
        const fields = (detail.fields || [])
          .filter(f => f.reference && f.purpose !== 'NOTES')
          .map(f => ({
            label: f.label || '(unlabeled)',
            reference: f.reference!,
            type: f.type || 'STRING',
            section: f.section?.label || null,
          }));

        if (fields.length > 0) {
          vaultItems.push({
            id: item.id,
            title: item.title,
            category: item.category,
            fields,
          });
          totalFields += fields.length;
        }
      } catch (err) {
        process.stderr.write(`[op_vault_map] Failed to read item ${item.id} (${item.title}): ${err instanceof Error ? err.message : String(err)}\n`);
      }
      totalItems++;
    }

    result.push({ name: vault.name, items: vaultItems });
  }

  return {
    vaults: result,
    totalItems,
    totalFields,
    note: `Fetched ${totalItems} items across ${vaults.length} vault(s). Use the 'reference' field values as op:// entries for populate_secrets_local.`,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

export const tools: AnyToolHandler[] = [
  {
    name: 'read_secret',
    description: 'Read a secret from 1Password vault using op:// reference. By default returns confirmation only (no raw value). Use secret_run_command to inject secrets into processes. Pass include_value: true only for vault audits — the raw value enters conversation context and must NEVER be written to files or hardcoded.',
    schema: readSecretSchema,
    handler: readSecret as (args: unknown) => unknown,
  },
  {
    name: 'list_items',
    description: 'List items in a 1Password vault with optional filtering',
    schema: listItemsSchema,
    handler: listItems as (args: unknown) => unknown,
  },
  {
    name: 'create_service_account',
    description: 'Create a service account for CI/CD (admin only, requires CTO approval)',
    schema: createServiceAccountSchema,
    handler: createServiceAccount as (args: unknown) => unknown,
  },
  {
    name: 'get_audit_log',
    description: 'Get audit log of vault access (for security review)',
    schema: getAuditLogSchema,
    handler: getAuditLog as (args: unknown) => unknown,
  },
  {
    name: 'check_auth',
    description: 'Check if 1Password is authenticated and accessible. Returns structured status — no secret access, no CTO approval needed. Use before demos or any workflow that requires credentials.',
    schema: checkAuthSchema,
    handler: checkAuth as (args: unknown) => unknown,
  },
  {
    name: 'op_vault_map',
    description: 'Full map of all 1Password items and their op:// field references across all accessible vaults. Returns reference paths (NOT secret values). Use to discover op:// references for populate_secrets_local. May be slow for large vaults.',
    schema: opVaultMapSchema,
    handler: opVaultMap as (args: unknown) => unknown,
  },
];

export const server = new McpServer({
  name: 'onepassword',
  version: '2.0.0',
  tools,
});

if (!process.env.MCP_SHARED_DAEMON) { server.start(); }
