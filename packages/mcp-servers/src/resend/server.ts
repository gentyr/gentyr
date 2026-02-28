#!/usr/bin/env node
/**
 * Resend MCP Server
 *
 * Provides tools for managing emails, domains, and API keys via Resend API.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (stdio MCP)
 *
 * Required env vars:
 * - RESEND_API_KEY: Resend API key
 *
 * @version 1.0.0
 */

import { McpServer, type AnyToolHandler } from '../shared/server.js';
import {
  SendEmailArgsSchema,
  GetEmailArgsSchema,
  ListEmailsArgsSchema,
  ListDomainsArgsSchema,
  AddDomainArgsSchema,
  GetDomainArgsSchema,
  VerifyDomainArgsSchema,
  DeleteDomainArgsSchema,
  ListApiKeysArgsSchema,
  CreateApiKeyArgsSchema,
  DeleteApiKeyArgsSchema,
  type SendEmailArgs,
  type GetEmailArgs,
  type ListEmailsArgs,
  type ListDomainsArgs,
  type AddDomainArgs,
  type GetDomainArgs,
  type VerifyDomainArgs,
  type DeleteDomainArgs,
  type ListApiKeysArgs,
  type CreateApiKeyArgs,
  type DeleteApiKeyArgs,
  type EmailSummary,
  type EmailDetails,
  type DomainSummary,
  type DomainDetails,
  type ApiKeySummary,
  type ApiKeyDetails,
  type SuccessResult,
  type SendEmailResult,
} from './types.js';

const BASE_URL = 'https://api.resend.com';

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

async function resendFetch(endpoint: string, options: RequestInit = {}): Promise<unknown> {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  // G001: Fail-closed on missing API key (checked at invocation time for tool discoverability)
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY environment variable is required. Ensure 1Password credentials are configured.');
  }
  const url = `${BASE_URL}${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const error = data.message as string | undefined;
    throw new Error(error || `HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

// ============================================================================
// Email Handler Functions
// ============================================================================

async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const data = await resendFetch('/emails', {
    method: 'POST',
    body: JSON.stringify({
      from: args.from,
      to: Array.isArray(args.to) ? args.to : [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
      cc: args.cc ? toArray(args.cc) : undefined,
      bcc: args.bcc ? toArray(args.bcc) : undefined,
      reply_to: args.reply_to,
      attachments: args.attachments,
      tags: args.tags,
    }),
  }) as { id: string; message?: string };

  return {
    id: data.id,
    message: data.message || 'Email sent successfully',
  };
}

async function getEmail(args: GetEmailArgs): Promise<EmailDetails> {
  const data = await resendFetch(`/emails/${args.emailId}`) as {
    id: string;
    object: string;
    from: string;
    to: string[];
    subject: string;
    html?: string;
    text?: string;
    created_at: string;
    last_event?: string;
  };

  return {
    id: data.id,
    object: data.object,
    from: data.from,
    to: data.to,
    subject: data.subject,
    html: data.html,
    text: data.text,
    created_at: data.created_at,
    last_event: data.last_event,
  };
}

async function listEmails(args: ListEmailsArgs): Promise<EmailSummary[]> {
  const params = new URLSearchParams();
  if (args.limit) { params.set('limit', args.limit.toString()); }
  if (args.offset) { params.set('offset', args.offset.toString()); }

  const data = await resendFetch(`/emails?${params}`) as { data: Array<{
    id: string;
    from: string;
    to: string[];
    subject: string;
    created_at: string;
    last_event?: string;
  }> };

  return data.data.map(email => ({
    id: email.id,
    from: email.from,
    to: email.to,
    subject: email.subject,
    created_at: email.created_at,
    last_event: email.last_event,
  }));
}

// ============================================================================
// Domain Handler Functions
// ============================================================================

async function listDomains(_args: ListDomainsArgs): Promise<DomainSummary[]> {
  const data = await resendFetch('/domains') as { data: Array<{
    id: string;
    name: string;
    status: string;
    created_at: string;
    region: string;
  }> };

  return data.data.map(domain => ({
    id: domain.id,
    name: domain.name,
    status: domain.status,
    created_at: domain.created_at,
    region: domain.region,
  }));
}

async function addDomain(args: AddDomainArgs): Promise<DomainDetails> {
  const data = await resendFetch('/domains', {
    method: 'POST',
    body: JSON.stringify({
      name: args.name,
      region: args.region || 'us-east-1',
    }),
  }) as {
    id: string;
    name: string;
    status: string;
    created_at: string;
    region: string;
    records: Array<{
      record: string;
      name: string;
      type: string;
      ttl: string;
      priority?: number;
      value: string;
    }>;
  };

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    created_at: data.created_at,
    region: data.region,
    records: data.records.map(record => ({
      record: record.record,
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      priority: record.priority,
      value: record.value,
    })),
  };
}

async function getDomain(args: GetDomainArgs): Promise<DomainDetails> {
  const data = await resendFetch(`/domains/${args.domainId}`) as {
    id: string;
    name: string;
    status: string;
    created_at: string;
    region: string;
    records: Array<{
      record: string;
      name: string;
      type: string;
      ttl: string;
      priority?: number;
      value: string;
    }>;
  };

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    created_at: data.created_at,
    region: data.region,
    records: data.records.map(record => ({
      record: record.record,
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      priority: record.priority,
      value: record.value,
    })),
  };
}

async function verifyDomain(args: VerifyDomainArgs): Promise<DomainDetails> {
  const data = await resendFetch(`/domains/${args.domainId}/verify`, {
    method: 'POST',
  }) as {
    id: string;
    name: string;
    status: string;
    created_at: string;
    region: string;
    records: Array<{
      record: string;
      name: string;
      type: string;
      ttl: string;
      priority?: number;
      value: string;
    }>;
  };

  return {
    id: data.id,
    name: data.name,
    status: data.status,
    created_at: data.created_at,
    region: data.region,
    records: data.records.map(record => ({
      record: record.record,
      name: record.name,
      type: record.type,
      ttl: record.ttl,
      priority: record.priority,
      value: record.value,
    })),
  };
}

async function deleteDomain(args: DeleteDomainArgs): Promise<SuccessResult> {
  await resendFetch(`/domains/${args.domainId}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Deleted domain ${args.domainId}` };
}

// ============================================================================
// API Key Handler Functions
// ============================================================================

async function listApiKeys(_args: ListApiKeysArgs): Promise<ApiKeySummary[]> {
  const data = await resendFetch('/api-keys') as { data: Array<{
    id: string;
    name: string;
    created_at: string;
    permission: string;
    domain_id?: string;
  }> };

  return data.data.map(key => ({
    id: key.id,
    name: key.name,
    created_at: key.created_at,
    permission: key.permission,
    domain_id: key.domain_id,
  }));
}

async function createApiKey(args: CreateApiKeyArgs): Promise<ApiKeyDetails> {
  const data = await resendFetch('/api-keys', {
    method: 'POST',
    body: JSON.stringify({
      name: args.name,
      permission: args.permission || 'full_access',
      domain_id: args.domain_id,
    }),
  }) as {
    id: string;
    name: string;
    token: string;
    created_at: string;
    permission: string;
    domain_id?: string;
  };

  return {
    id: data.id,
    name: data.name,
    token: data.token,
    created_at: data.created_at,
    permission: data.permission,
    domain_id: data.domain_id,
  };
}

async function deleteApiKey(args: DeleteApiKeyArgs): Promise<SuccessResult> {
  await resendFetch(`/api-keys/${args.apiKeyId}`, {
    method: 'DELETE',
  });
  return { success: true, message: `Deleted API key ${args.apiKeyId}` };
}

// ============================================================================
// Server Setup
// ============================================================================

// Cast handlers to ToolHandler - args are validated by McpServer before calling
const tools = [
  // Email tools
  {
    name: 'resend_send_email',
    description: 'Send an email via Resend. Supports HTML/text content, attachments, CC/BCC, and tags.',
    schema: SendEmailArgsSchema,
    handler: sendEmail as (args: unknown) => unknown,
  },
  {
    name: 'resend_get_email',
    description: 'Get details of a specific email by ID',
    schema: GetEmailArgsSchema,
    handler: getEmail as (args: unknown) => unknown,
  },
  {
    name: 'resend_list_emails',
    description: 'List sent emails with pagination support',
    schema: ListEmailsArgsSchema,
    handler: listEmails as (args: unknown) => unknown,
  },
  // Domain tools
  {
    name: 'resend_list_domains',
    description: 'List all domains configured in Resend',
    schema: ListDomainsArgsSchema,
    handler: listDomains as (args: unknown) => unknown,
  },
  {
    name: 'resend_add_domain',
    description: 'Add a new domain to Resend. Returns DNS records that need to be configured.',
    schema: AddDomainArgsSchema,
    handler: addDomain as (args: unknown) => unknown,
  },
  {
    name: 'resend_get_domain',
    description: 'Get details of a specific domain including DNS records',
    schema: GetDomainArgsSchema,
    handler: getDomain as (args: unknown) => unknown,
  },
  {
    name: 'resend_verify_domain',
    description: 'Verify a domain by checking DNS records. Call after configuring DNS.',
    schema: VerifyDomainArgsSchema,
    handler: verifyDomain as (args: unknown) => unknown,
  },
  {
    name: 'resend_delete_domain',
    description: 'Delete a domain from Resend',
    schema: DeleteDomainArgsSchema,
    handler: deleteDomain as (args: unknown) => unknown,
  },
  // API Key tools
  {
    name: 'resend_list_api_keys',
    description: 'List all API keys for the account',
    schema: ListApiKeysArgsSchema,
    handler: listApiKeys as (args: unknown) => unknown,
  },
  {
    name: 'resend_create_api_key',
    description: 'Create a new API key with specified permissions',
    schema: CreateApiKeyArgsSchema,
    handler: createApiKey as (args: unknown) => unknown,
  },
  {
    name: 'resend_delete_api_key',
    description: 'Delete an API key',
    schema: DeleteApiKeyArgsSchema,
    handler: deleteApiKey as (args: unknown) => unknown,
  },
] satisfies AnyToolHandler[];

// Create and start server
const server = new McpServer({
  name: 'resend-mcp',
  version: '1.0.0',
  tools,
});

server.start();
