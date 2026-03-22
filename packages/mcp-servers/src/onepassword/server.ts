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
  type ReadSecretArgs,
  type ListItemsArgs,
  type CreateServiceAccountArgs,
  type GetAuditLogArgs,
} from './types.js';

// Helper: Execute op CLI command (uses execFileSync to prevent shell injection)
function opCommand(args: string[]): string {
  try {
    const result = execFileSync('op', args, {
      encoding: 'utf-8',
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
];

export const server = new McpServer({
  name: 'onepassword',
  version: '2.0.0',
  tools,
});

if (!process.env.MCP_SHARED_DAEMON) { server.start(); }
