#!/usr/bin/env node
/**
 * Supabase MCP Server
 *
 * Provides tools for interacting with Supabase: data operations, schema inspection,
 * storage, auth, and project management.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL: Supabase project URL
 * - SUPABASE_SERVICE_ROLE_KEY: Service role key for admin access
 * Optional:
 * - SUPABASE_ACCESS_TOKEN: Management API token (for SQL, migrations, project info)
 * - SUPABASE_PROJECT_REF: Project reference (extracted from URL if not provided)
 *
 * @version 1.0.0
 */

import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  SelectArgsSchema,
  InsertArgsSchema,
  UpdateArgsSchema,
  DeleteArgsSchema,
  RpcArgsSchema,
  ListTablesArgsSchema,
  DescribeTableArgsSchema,
  SqlArgsSchema,
  ListBucketsArgsSchema,
  ListFilesArgsSchema,
  DeleteFileArgsSchema,
  GetPublicUrlArgsSchema,
  ListUsersArgsSchema,
  GetUserArgsSchema,
  DeleteUserArgsSchema,
  GetProjectArgsSchema,
  ListMigrationsArgsSchema,
  PushMigrationArgsSchema,
  GetMigrationArgsSchema,
  type SelectArgs,
  type InsertArgs,
  type UpdateArgs,
  type DeleteArgs,
  type RpcArgs,
  type DescribeTableArgs,
  type SqlArgs,
  type ListFilesArgs,
  type DeleteFileArgs,
  type GetPublicUrlArgs,
  type ListUsersArgs,
  type GetUserArgs,
  type DeleteUserArgs,
  type PushMigrationArgs,
  type GetMigrationArgs,
  type SuccessResult,
  type PublicUrlResult,
  type InfoMessage,
} from './types.js';

const { SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF } = process.env;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required');
  process.exit(1);
}

// Extract project ref from URL if not provided
const projectRef = SUPABASE_PROJECT_REF || SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1];

interface FetchOptions extends RequestInit {
  prefer?: string;
}

async function supabaseRest(endpoint: string, options: FetchOptions = {}): Promise<unknown> {
  const url = `${SUPABASE_URL}/rest/v1${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...options.headers,
    },
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(typeof data === 'object' ? JSON.stringify(data) : String(data));
  }

  return data;
}

async function supabaseManagement(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  if (!SUPABASE_ACCESS_TOKEN) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required for management API calls');
  }

  const url = `https://api.supabase.com${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json() as { message?: string };

  if (!response.ok) {
    throw new Error(data.message || JSON.stringify(data));
  }

  return data;
}

async function executeSql(sql: string): Promise<unknown> {
  if (SUPABASE_ACCESS_TOKEN && projectRef) {
    return await supabaseManagement(`/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      body: JSON.stringify({ query: sql }),
    });
  }

  throw new Error('SQL execution requires SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF');
}

// ============================================================================
// Handler Functions
// ============================================================================

async function selectData(args: SelectArgs): Promise<unknown> {
  let endpoint = `/${args.table}?select=${args.select || '*'}`;
  if (args.filter) { endpoint += `&${args.filter}`; }
  if (args.order) { endpoint += `&order=${args.order}`; }
  if (args.limit) { endpoint += `&limit=${args.limit}`; }
  if (args.offset) { endpoint += `&offset=${args.offset}`; }
  return await supabaseRest(endpoint);
}

async function insertData(args: InsertArgs): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (args.onConflict) {
    headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
    headers['on-conflict'] = args.onConflict;
  }
  return await supabaseRest(`/${args.table}`, {
    method: 'POST',
    body: JSON.stringify(args.data),
    headers,
  });
}

async function updateData(args: UpdateArgs): Promise<unknown> {
  return await supabaseRest(`/${args.table}?${args.filter}`, {
    method: 'PATCH',
    body: JSON.stringify(args.data),
  });
}

async function deleteData(args: DeleteArgs): Promise<unknown> {
  return await supabaseRest(`/${args.table}?${args.filter}`, {
    method: 'DELETE',
  });
}

async function callRpc(args: RpcArgs): Promise<unknown> {
  return await supabaseRest(`/rpc/${args.function}`, {
    method: 'POST',
    body: JSON.stringify(args.params || {}),
  });
}

async function listTables(): Promise<unknown | InfoMessage> {
  // Prefer Management API if available (more detailed results)
  if (SUPABASE_ACCESS_TOKEN && projectRef) {
    return await executeSql(`
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
  }

  // Fallback: Use PostgREST OpenAPI schema (works with service role key)
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY ?? '',
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });

    if (!response.ok) {
      return { message: 'Failed to fetch table list from PostgREST.' };
    }

    const schema = await response.json() as {
      paths?: Record<string, unknown>;
    };

    const tables: Array<{ table_name: string; table_type: string }> = [];
    if (schema.paths) {
      for (const p of Object.keys(schema.paths)) {
        if (p.startsWith('/rpc/')) continue;
        const tableName = p.replace(/^\//, '');
        if (tableName) {
          tables.push({ table_name: tableName, table_type: 'TABLE OR VIEW' });
        }
      }
    }

    return {
      note: 'PostgREST fallback: table_type cannot distinguish tables from views. Set SUPABASE_ACCESS_TOKEN for accurate types.',
      tables: tables.sort((a, b) => a.table_name.localeCompare(b.table_name)),
    };
  } catch {
    return { message: 'To list tables with full details, set SUPABASE_ACCESS_TOKEN.' };
  }
}

async function describeTable(args: DescribeTableArgs): Promise<unknown | InfoMessage> {
  // Prefer Management API if available (more detailed results)
  if (SUPABASE_ACCESS_TOKEN && projectRef) {
    return await executeSql(`
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${args.table}'
      ORDER BY ordinal_position
    `);
  }

  // Fallback: Use PostgREST OpenAPI schema definitions
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: SUPABASE_SERVICE_KEY ?? '',
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });

    if (!response.ok) {
      return { message: `Failed to describe table ${args.table} from PostgREST.` };
    }

    const schema = await response.json() as {
      definitions?: Record<string, {
        properties?: Record<string, {
          type?: string;
          format?: string;
          description?: string;
          default?: unknown;
          maxLength?: number;
        }>;
        required?: string[];
      }>;
    };

    const tableDef = schema.definitions?.[args.table];
    if (!tableDef) {
      return { message: `Table "${args.table}" not found in PostgREST schema.` };
    }

    const requiredColumns = new Set(tableDef.required || []);
    const columns = Object.entries(tableDef.properties || {}).map(([name, col]) => ({
      column_name: name,
      data_type: col.format || col.type || 'unknown',
      is_nullable: requiredColumns.has(name) ? 'NO' : 'YES',
      column_default: col.default ?? null,
      character_maximum_length: col.maxLength ?? null,
    }));

    return columns;
  } catch {
    return { message: `To describe tables with full details, set SUPABASE_ACCESS_TOKEN.` };
  }
}

async function executeSqlQuery(args: SqlArgs): Promise<unknown> {
  return await executeSql(args.query);
}

async function listBuckets(): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return await response.json();
}

async function listFiles(args: ListFilesArgs): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${args.bucket}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix: args.path || '',
      limit: args.limit || 100,
    }),
  });
  return await response.json();
}

async function deleteFile(args: DeleteFileArgs): Promise<SuccessResult> {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${args.bucket}/${args.path}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return { success: true, message: `Deleted ${args.path} from ${args.bucket}` };
}

function getPublicUrl(args: GetPublicUrlArgs): PublicUrlResult {
  return {
    publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${args.bucket}/${args.path}`,
  };
}

async function listUsers(args: ListUsersArgs): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${args.page || 1}&per_page=${args.perPage || 50}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return await response.json();
}

async function getUser(args: GetUserArgs): Promise<unknown> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${args.userId}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  return await response.json();
}

async function deleteUser(args: DeleteUserArgs): Promise<SuccessResult> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${args.userId}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_KEY ?? '',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return { success: true, message: `Deleted user ${args.userId}` };
}

async function getProjectInfo(): Promise<unknown> {
  if (!SUPABASE_ACCESS_TOKEN || !projectRef) {
    throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  }
  return await supabaseManagement(`/v1/projects/${projectRef}`);
}

async function listMigrations(): Promise<unknown> {
  if (!SUPABASE_ACCESS_TOKEN || !projectRef) {
    throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  }
  return await supabaseManagement(`/v1/projects/${projectRef}/database/migrations`);
}

async function pushMigration(args: PushMigrationArgs): Promise<unknown> {
  if (!SUPABASE_ACCESS_TOKEN || !projectRef) {
    throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  }
  return await supabaseManagement(`/v1/projects/${projectRef}/database/migrations`, {
    method: 'POST',
    body: JSON.stringify({
      name: args.name,
      query: args.sql,
    }),
  });
}

async function getMigration(args: GetMigrationArgs): Promise<unknown> {
  if (!SUPABASE_ACCESS_TOKEN || !projectRef) {
    throw new Error('SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are required');
  }
  return await supabaseManagement(`/v1/projects/${projectRef}/database/migrations/${args.version}`);
}

// ============================================================================
// Server Setup
// ============================================================================

// Cast handlers to ToolHandler - args are validated by McpServer before calling
const tools = [
  {
    name: 'supabase_select',
    description: 'Query data from a table using PostgREST syntax',
    schema: SelectArgsSchema,
    handler: selectData as (args: unknown) => unknown,
  },
  {
    name: 'supabase_insert',
    description: 'Insert data into a table',
    schema: InsertArgsSchema,
    handler: insertData as (args: unknown) => unknown,
  },
  {
    name: 'supabase_update',
    description: 'Update data in a table',
    schema: UpdateArgsSchema,
    handler: updateData as (args: unknown) => unknown,
  },
  {
    name: 'supabase_delete',
    description: 'Delete data from a table',
    schema: DeleteArgsSchema,
    handler: deleteData as (args: unknown) => unknown,
  },
  {
    name: 'supabase_rpc',
    description: 'Call a stored procedure/function',
    schema: RpcArgsSchema,
    handler: callRpc as (args: unknown) => unknown,
  },
  {
    name: 'supabase_list_tables',
    description: 'List all tables in the public schema',
    schema: ListTablesArgsSchema,
    handler: listTables as (args: unknown) => unknown,
  },
  {
    name: 'supabase_describe_table',
    description: 'Get column information for a table',
    schema: DescribeTableArgsSchema,
    handler: describeTable as (args: unknown) => unknown,
  },
  {
    name: 'supabase_sql',
    description: 'Execute raw SQL query (requires SUPABASE_ACCESS_TOKEN)',
    schema: SqlArgsSchema,
    handler: executeSqlQuery as (args: unknown) => unknown,
  },
  {
    name: 'supabase_list_buckets',
    description: 'List all storage buckets',
    schema: ListBucketsArgsSchema,
    handler: listBuckets as (args: unknown) => unknown,
  },
  {
    name: 'supabase_list_files',
    description: 'List files in a storage bucket',
    schema: ListFilesArgsSchema,
    handler: listFiles as (args: unknown) => unknown,
  },
  {
    name: 'supabase_delete_file',
    description: 'Delete a file from storage',
    schema: DeleteFileArgsSchema,
    handler: deleteFile as (args: unknown) => unknown,
  },
  {
    name: 'supabase_get_public_url',
    description: 'Get public URL for a file',
    schema: GetPublicUrlArgsSchema,
    handler: getPublicUrl as (args: unknown) => unknown,
  },
  {
    name: 'supabase_list_users',
    description: 'List all auth users',
    schema: ListUsersArgsSchema,
    handler: listUsers as (args: unknown) => unknown,
  },
  {
    name: 'supabase_get_user',
    description: 'Get a specific user by ID',
    schema: GetUserArgsSchema,
    handler: getUser as (args: unknown) => unknown,
  },
  {
    name: 'supabase_delete_user',
    description: 'Delete a user from auth',
    schema: DeleteUserArgsSchema,
    handler: deleteUser as (args: unknown) => unknown,
  },
  {
    name: 'supabase_get_project',
    description: 'Get project details (requires SUPABASE_ACCESS_TOKEN)',
    schema: GetProjectArgsSchema,
    handler: getProjectInfo as (args: unknown) => unknown,
  },
  {
    name: 'supabase_list_migrations',
    description: 'List database migrations (requires SUPABASE_ACCESS_TOKEN)',
    schema: ListMigrationsArgsSchema,
    handler: listMigrations as (args: unknown) => unknown,
  },
  {
    name: 'supabase_push_migration',
    description: 'Push a database migration to the remote project. The SQL is executed and tracked in supabase_migrations.schema_migrations. Automatically rolls back on failure. (requires SUPABASE_ACCESS_TOKEN)',
    schema: PushMigrationArgsSchema,
    handler: pushMigration as (args: unknown) => unknown,
  },
  {
    name: 'supabase_get_migration',
    description: 'Get details of a specific migration by version/timestamp (requires SUPABASE_ACCESS_TOKEN)',
    schema: GetMigrationArgsSchema,
    handler: getMigration as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// Create and start server
const server = new McpServer({
  name: 'supabase-mcp',
  version: '1.0.0',
  tools,
});

server.start();
