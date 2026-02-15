#!/usr/bin/env node
/**
 * Cloudflare MCP Server
 *
 * Provides tools for managing Cloudflare DNS records and zones.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - CLOUDFLARE_API_TOKEN: Cloudflare API token with DNS edit permissions
 * - CLOUDFLARE_ZONE_ID: Zone ID for DNS operations
 *
 * @version 1.0.0
 */

import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  ListDnsRecordsArgsSchema,
  GetDnsRecordArgsSchema,
  CreateDnsRecordArgsSchema,
  UpdateDnsRecordArgsSchema,
  DeleteDnsRecordArgsSchema,
  GetZoneArgsSchema,
  type ListDnsRecordsArgs,
  type GetDnsRecordArgs,
  type CreateDnsRecordArgs,
  type UpdateDnsRecordArgs,
  type DeleteDnsRecordArgs,
  type GetZoneArgs,
  type DnsRecordSummary,
  type ZoneSummary,
  type SuccessResult,
  type PaginatedDnsRecordsResult,
} from './types.js';

const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID } = process.env;
const BASE_URL = 'https://api.cloudflare.com/client/v4';

if (!CLOUDFLARE_API_TOKEN) {
  console.error('CLOUDFLARE_API_TOKEN environment variable is required');
  process.exit(1);
}

if (!CLOUDFLARE_ZONE_ID) {
  console.error('CLOUDFLARE_ZONE_ID environment variable is required');
  process.exit(1);
}

async function cloudflareFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json() as {
    success: boolean;
    errors: Array<{ message: string }>;
    result: unknown;
    result_info?: {
      page: number;
      per_page: number;
      total_count: number;
      total_pages: number;
    };
  };

  if (!response.ok || !data.success) {
    const errorMessages = data.errors.map(e => e.message).join(', ');
    throw new Error(errorMessages || `HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ============================================================================
// Handler Functions
// ============================================================================

async function listDnsRecords(args: ListDnsRecordsArgs): Promise<PaginatedDnsRecordsResult> {
  const params = new URLSearchParams();
  if (args.type) { params.set('type', args.type); }
  if (args.name) { params.set('name', args.name); }
  if (args.content) { params.set('content', args.content); }
  if (args.page) { params.set('page', args.page.toString()); }
  if (args.per_page) { params.set('per_page', args.per_page.toString()); }

  const data = await cloudflareFetch(`/zones/${CLOUDFLARE_ZONE_ID}/dns_records?${params}`) as {
    result: Array<{
      id: string;
      type: string;
      name: string;
      content: string;
      proxied: boolean;
      ttl: number;
      locked: boolean;
      zone_id: string;
      zone_name: string;
      created_on: string;
      modified_on: string;
      priority?: number;
      comment?: string;
    }>;
    result_info: {
      page: number;
      per_page: number;
      total_count: number;
      total_pages: number;
    };
  };

  return {
    records: data.result.map(r => ({
      id: r.id,
      type: r.type,
      name: r.name,
      content: r.content,
      proxied: r.proxied,
      ttl: r.ttl,
      locked: r.locked,
      zone_id: r.zone_id,
      zone_name: r.zone_name,
      created_on: r.created_on,
      modified_on: r.modified_on,
      priority: r.priority,
      comment: r.comment,
    })),
    total_count: data.result_info.total_count,
    page: data.result_info.page,
    per_page: data.result_info.per_page,
    total_pages: data.result_info.total_pages,
  };
}

async function getDnsRecord(args: GetDnsRecordArgs): Promise<DnsRecordSummary> {
  const data = await cloudflareFetch(`/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${args.recordId}`) as {
    result: {
      id: string;
      type: string;
      name: string;
      content: string;
      proxied: boolean;
      ttl: number;
      locked: boolean;
      zone_id: string;
      zone_name: string;
      created_on: string;
      modified_on: string;
      priority?: number;
      comment?: string;
    };
  };

  return {
    id: data.result.id,
    type: data.result.type,
    name: data.result.name,
    content: data.result.content,
    proxied: data.result.proxied,
    ttl: data.result.ttl,
    locked: data.result.locked,
    zone_id: data.result.zone_id,
    zone_name: data.result.zone_name,
    created_on: data.result.created_on,
    modified_on: data.result.modified_on,
    priority: data.result.priority,
    comment: data.result.comment,
  };
}

async function createDnsRecord(args: CreateDnsRecordArgs): Promise<DnsRecordSummary> {
  const body: Record<string, unknown> = {
    type: args.type,
    name: args.name,
    content: args.content,
    ttl: args.ttl,
    proxied: args.proxied,
  };

  if (args.priority !== undefined) {
    body.priority = args.priority;
  }

  if (args.comment !== undefined) {
    body.comment = args.comment;
  }

  const data = await cloudflareFetch(`/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    method: 'POST',
    body: JSON.stringify(body),
  }) as {
    result: {
      id: string;
      type: string;
      name: string;
      content: string;
      proxied: boolean;
      ttl: number;
      locked: boolean;
      zone_id: string;
      zone_name: string;
      created_on: string;
      modified_on: string;
      priority?: number;
      comment?: string;
    };
  };

  return {
    id: data.result.id,
    type: data.result.type,
    name: data.result.name,
    content: data.result.content,
    proxied: data.result.proxied,
    ttl: data.result.ttl,
    locked: data.result.locked,
    zone_id: data.result.zone_id,
    zone_name: data.result.zone_name,
    created_on: data.result.created_on,
    modified_on: data.result.modified_on,
    priority: data.result.priority,
    comment: data.result.comment,
  };
}

async function updateDnsRecord(args: UpdateDnsRecordArgs): Promise<DnsRecordSummary> {
  const body: Record<string, unknown> = {};

  if (args.type !== undefined) { body.type = args.type; }
  if (args.name !== undefined) { body.name = args.name; }
  if (args.content !== undefined) { body.content = args.content; }
  if (args.ttl !== undefined) { body.ttl = args.ttl; }
  if (args.proxied !== undefined) { body.proxied = args.proxied; }
  if (args.priority !== undefined) { body.priority = args.priority; }
  if (args.comment !== undefined) { body.comment = args.comment; }

  const data = await cloudflareFetch(`/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${args.recordId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  }) as {
    result: {
      id: string;
      type: string;
      name: string;
      content: string;
      proxied: boolean;
      ttl: number;
      locked: boolean;
      zone_id: string;
      zone_name: string;
      created_on: string;
      modified_on: string;
      priority?: number;
      comment?: string;
    };
  };

  return {
    id: data.result.id,
    type: data.result.type,
    name: data.result.name,
    content: data.result.content,
    proxied: data.result.proxied,
    ttl: data.result.ttl,
    locked: data.result.locked,
    zone_id: data.result.zone_id,
    zone_name: data.result.zone_name,
    created_on: data.result.created_on,
    modified_on: data.result.modified_on,
    priority: data.result.priority,
    comment: data.result.comment,
  };
}

async function deleteDnsRecord(args: DeleteDnsRecordArgs): Promise<SuccessResult> {
  await cloudflareFetch(`/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${args.recordId}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Deleted DNS record ${args.recordId}` };
}

async function getZone(_args: GetZoneArgs): Promise<ZoneSummary> {
  const data = await cloudflareFetch(`/zones/${CLOUDFLARE_ZONE_ID}`) as {
    result: {
      id: string;
      name: string;
      status: string;
      paused: boolean;
      type: string;
      development_mode: number;
      name_servers: string[];
      original_name_servers: string[];
      created_on: string;
      modified_on: string;
      activated_on: string;
    };
  };

  return {
    id: data.result.id,
    name: data.result.name,
    status: data.result.status,
    paused: data.result.paused,
    type: data.result.type,
    development_mode: data.result.development_mode,
    name_servers: data.result.name_servers,
    original_name_servers: data.result.original_name_servers,
    created_on: data.result.created_on,
    modified_on: data.result.modified_on,
    activated_on: data.result.activated_on,
  };
}

// ============================================================================
// Server Setup
// ============================================================================

// Cast handlers to ToolHandler - args are validated by McpServer before calling
const tools = [
  {
    name: 'cloudflare_list_dns_records',
    description: 'List all DNS records for the configured zone. Supports filtering by type, name, and content. Returns paginated results.',
    schema: ListDnsRecordsArgsSchema,
    handler: listDnsRecords as (args: unknown) => unknown,
  },
  {
    name: 'cloudflare_get_dns_record',
    description: 'Get details of a specific DNS record by ID',
    schema: GetDnsRecordArgsSchema,
    handler: getDnsRecord as (args: unknown) => unknown,
  },
  {
    name: 'cloudflare_create_dns_record',
    description: 'Create a new DNS record in the zone. Supports A, AAAA, CNAME, TXT, MX, NS, SRV, CAA, and PTR records.',
    schema: CreateDnsRecordArgsSchema,
    handler: createDnsRecord as (args: unknown) => unknown,
  },
  {
    name: 'cloudflare_update_dns_record',
    description: 'Update an existing DNS record. Only provided fields will be updated.',
    schema: UpdateDnsRecordArgsSchema,
    handler: updateDnsRecord as (args: unknown) => unknown,
  },
  {
    name: 'cloudflare_delete_dns_record',
    description: 'Delete a DNS record from the zone',
    schema: DeleteDnsRecordArgsSchema,
    handler: deleteDnsRecord as (args: unknown) => unknown,
  },
  {
    name: 'cloudflare_get_zone',
    description: 'Get details of the configured zone including name servers and status',
    schema: GetZoneArgsSchema,
    handler: getZone as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// Create and start server
const server = new McpServer({
  name: 'cloudflare-mcp',
  version: '1.0.0',
  tools,
});

server.start();
