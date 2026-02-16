/**
 * Cloudflare MCP Server Types
 *
 * Type definitions for Cloudflare DNS API interactions.
 */

import { z } from 'zod';

// DNS Record Type enum
export const DnsRecordTypeSchema = z.enum([
  'A',
  'AAAA',
  'CNAME',
  'TXT',
  'MX',
  'NS',
  'SRV',
  'CAA',
  'PTR',
]);

// Tool argument schemas
export const ListDnsRecordsArgsSchema = z.object({
  type: DnsRecordTypeSchema.optional().describe('Filter by DNS record type'),
  name: z.string().optional().describe('Filter by DNS record name'),
  content: z.string().optional().describe('Filter by DNS record content'),
  page: z.coerce.number().optional().default(1).describe('Page number for pagination'),
  per_page: z.coerce.number().optional().default(100).describe('Number of records per page'),
});

export const GetDnsRecordArgsSchema = z.object({
  recordId: z.string().describe('DNS record identifier'),
});

export const CreateDnsRecordArgsSchema = z.object({
  type: DnsRecordTypeSchema.describe('DNS record type'),
  name: z.string().describe('DNS record name (e.g., example.com or subdomain.example.com)'),
  content: z.string().describe('DNS record content (e.g., IP address, CNAME target)'),
  ttl: z.coerce.number().optional().default(1).describe('Time to live (1 = automatic)'),
  proxied: z.coerce.boolean().optional().default(false).describe('Whether the record is proxied through Cloudflare'),
  priority: z.coerce.number().optional().describe('Priority for MX and SRV records'),
  comment: z.string().optional().describe('Comments or notes about the DNS record'),
});

export const UpdateDnsRecordArgsSchema = z.object({
  recordId: z.string().describe('DNS record identifier'),
  type: DnsRecordTypeSchema.optional().describe('DNS record type'),
  name: z.string().optional().describe('DNS record name'),
  content: z.string().optional().describe('DNS record content'),
  ttl: z.coerce.number().optional().describe('Time to live'),
  proxied: z.coerce.boolean().optional().describe('Whether the record is proxied through Cloudflare'),
  priority: z.coerce.number().optional().describe('Priority for MX and SRV records'),
  comment: z.string().optional().describe('Comments or notes about the DNS record'),
});

export const DeleteDnsRecordArgsSchema = z.object({
  recordId: z.string().describe('DNS record identifier'),
});

export const GetZoneArgsSchema = z.object({});

// Type exports
export type DnsRecordType = z.infer<typeof DnsRecordTypeSchema>;
export type ListDnsRecordsArgs = z.infer<typeof ListDnsRecordsArgsSchema>;
export type GetDnsRecordArgs = z.infer<typeof GetDnsRecordArgsSchema>;
export type CreateDnsRecordArgs = z.infer<typeof CreateDnsRecordArgsSchema>;
export type UpdateDnsRecordArgs = z.infer<typeof UpdateDnsRecordArgsSchema>;
export type DeleteDnsRecordArgs = z.infer<typeof DeleteDnsRecordArgsSchema>;
export type GetZoneArgs = z.infer<typeof GetZoneArgsSchema>;

// Response types
export interface DnsRecordSummary {
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
}

export interface ZoneSummary {
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
}

export interface SuccessResult {
  success: true;
  message: string;
}

export interface PaginatedDnsRecordsResult {
  records: DnsRecordSummary[];
  total_count: number;
  page: number;
  per_page: number;
  total_pages: number;
}
