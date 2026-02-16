/**
 * Resend MCP Server Types
 *
 * Type definitions for Resend API interactions.
 */

import { z } from 'zod';

// Email attachment schema
const AttachmentSchema = z.object({
  filename: z.string(),
  content: z.string().describe('Base64 encoded content'),
  content_type: z.string().optional(),
});

// Tool argument schemas - Emails
export const SendEmailArgsSchema = z.object({
  from: z.string().describe('Sender email address'),
  to: z.union([z.string(), z.array(z.string())]).describe('Recipient email address(es)'),
  subject: z.string().describe('Email subject'),
  html: z.string().optional().describe('HTML content'),
  text: z.string().optional().describe('Plain text content'),
  cc: z.union([z.string(), z.array(z.string())]).optional().describe('CC recipients'),
  bcc: z.union([z.string(), z.array(z.string())]).optional().describe('BCC recipients'),
  reply_to: z.string().optional().describe('Reply-to email address'),
  attachments: z.array(AttachmentSchema).optional().describe('Email attachments'),
  tags: z.array(z.object({ name: z.string(), value: z.string() })).optional().describe('Email tags for tracking'),
});

export const GetEmailArgsSchema = z.object({
  emailId: z.string().describe('Email ID'),
});

export const ListEmailsArgsSchema = z.object({
  limit: z.coerce.number().optional().default(10).describe('Number of emails to return (max 100)'),
  offset: z.coerce.number().optional().default(0).describe('Number of emails to skip'),
});

// Tool argument schemas - Domains
export const ListDomainsArgsSchema = z.object({});

export const AddDomainArgsSchema = z.object({
  name: z.string().describe('Domain name to add (e.g., example.com)'),
  region: z.enum(['us-east-1', 'eu-west-1', 'sa-east-1']).optional().default('us-east-1').describe('AWS region for the domain'),
});

export const GetDomainArgsSchema = z.object({
  domainId: z.string().describe('Domain ID'),
});

export const VerifyDomainArgsSchema = z.object({
  domainId: z.string().describe('Domain ID to verify'),
});

export const DeleteDomainArgsSchema = z.object({
  domainId: z.string().describe('Domain ID to delete'),
});

// Tool argument schemas - API Keys
export const ListApiKeysArgsSchema = z.object({});

export const CreateApiKeyArgsSchema = z.object({
  name: z.string().describe('Name for the API key'),
  permission: z.enum(['full_access', 'sending_access']).optional().default('full_access').describe('Permission level'),
  domain_id: z.string().optional().describe('Restrict to specific domain ID'),
});

export const DeleteApiKeyArgsSchema = z.object({
  apiKeyId: z.string().describe('API key ID to delete'),
});

// Type exports
export type SendEmailArgs = z.infer<typeof SendEmailArgsSchema>;
export type GetEmailArgs = z.infer<typeof GetEmailArgsSchema>;
export type ListEmailsArgs = z.infer<typeof ListEmailsArgsSchema>;
export type ListDomainsArgs = z.infer<typeof ListDomainsArgsSchema>;
export type AddDomainArgs = z.infer<typeof AddDomainArgsSchema>;
export type GetDomainArgs = z.infer<typeof GetDomainArgsSchema>;
export type VerifyDomainArgs = z.infer<typeof VerifyDomainArgsSchema>;
export type DeleteDomainArgs = z.infer<typeof DeleteDomainArgsSchema>;
export type ListApiKeysArgs = z.infer<typeof ListApiKeysArgsSchema>;
export type CreateApiKeyArgs = z.infer<typeof CreateApiKeyArgsSchema>;
export type DeleteApiKeyArgs = z.infer<typeof DeleteApiKeyArgsSchema>;

// Response types
export interface EmailSummary {
  id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  last_event?: string;
}

export interface EmailDetails {
  id: string;
  object: string;
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  created_at: string;
  last_event?: string;
}

export interface DomainSummary {
  id: string;
  name: string;
  status: string;
  created_at: string;
  region: string;
}

export interface DomainDetails {
  id: string;
  name: string;
  status: string;
  created_at: string;
  region: string;
  records: DnsRecord[];
}

export interface DnsRecord {
  record: string;
  name: string;
  type: string;
  ttl: string;
  priority?: number;
  value: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  created_at: string;
  permission: string;
  domain_id?: string;
}

export interface ApiKeyDetails {
  id: string;
  name: string;
  token: string;
  created_at: string;
  permission: string;
  domain_id?: string;
}

export interface SuccessResult {
  success: true;
  message: string;
}

export interface SendEmailResult {
  id: string;
  message?: string;
}
