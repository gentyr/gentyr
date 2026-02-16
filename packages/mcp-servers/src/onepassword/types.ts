import { z } from 'zod';

// Input schemas
export const readSecretSchema = z.object({
  reference: z.string().describe('op://vault/item/field reference'),
});

export const listItemsSchema = z.object({
  vault: z.string().optional().describe('Vault name (default: Production)'),
  categories: z.array(z.string()).optional().describe('Filter by category'),
  tags: z.array(z.string()).optional().describe('Filter by tags'),
});

export const createServiceAccountSchema = z.object({
  name: z.string().describe('Service account name'),
  vaults: z.array(z.string()).describe('Vault access list'),
  expiresInDays: z.coerce.number().optional().describe('Token expiry (default: never)'),
});

export const getAuditLogSchema = z.object({
  vault: z.string().describe('Vault name'),
  from: z.string().optional().describe('ISO8601 start time (default: 24h ago)'),
  to: z.string().optional().describe('ISO8601 end time (default: now)'),
  action: z.string().optional().describe('Filter by action type'),
});

// Type exports
export type ReadSecretArgs = z.infer<typeof readSecretSchema>;
export type ListItemsArgs = z.infer<typeof listItemsSchema>;
export type CreateServiceAccountArgs = z.infer<typeof createServiceAccountSchema>;
export type GetAuditLogArgs = z.infer<typeof getAuditLogSchema>;
