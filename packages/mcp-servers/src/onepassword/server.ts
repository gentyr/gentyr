import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'child_process';
import { zodToJsonSchema } from '../shared/server.js';
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
  return { value };
}

// Tool: List items in vault
async function listItems(args: ListItemsArgs) {
  const parsed = listItemsSchema.parse(args);

  const cmdArgs = ['item', 'list', '--format', 'json'];
  if (parsed.vault) {cmdArgs.push('--vault', parsed.vault);}
  if (parsed.categories?.length) {cmdArgs.push('--categories', parsed.categories.join(','));}
  if (parsed.tags?.length) {cmdArgs.push('--tags', parsed.tags.join(','));}

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
  if (parsed.action) {cmdArgs.push('--action', parsed.action);}

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

// MCP Server
const server = new Server(
  { name: 'onepassword', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_secret',
      description: 'Read a secret from 1Password vault using op:// reference',
      inputSchema: zodToJsonSchema(readSecretSchema),
    },
    {
      name: 'list_items',
      description: 'List items in a 1Password vault with optional filtering',
      inputSchema: zodToJsonSchema(listItemsSchema),
    },
    {
      name: 'create_service_account',
      description: 'Create a service account for CI/CD (admin only, requires CTO approval)',
      inputSchema: zodToJsonSchema(createServiceAccountSchema),
    },
    {
      name: 'get_audit_log',
      description: 'Get audit log of vault access (for security review)',
      inputSchema: zodToJsonSchema(getAuditLogSchema),
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'read_secret':
        return { content: [{ type: 'text', text: JSON.stringify(await readSecret(args as ReadSecretArgs), null, 2) }] };
      case 'list_items':
        return { content: [{ type: 'text', text: JSON.stringify(await listItems(args as ListItemsArgs), null, 2) }] };
      case 'create_service_account':
        return { content: [{ type: 'text', text: JSON.stringify(await createServiceAccount(args as CreateServiceAccountArgs), null, 2) }] };
      case 'get_audit_log':
        return { content: [{ type: 'text', text: JSON.stringify(await getAuditLog(args as GetAuditLogArgs), null, 2) }] };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
