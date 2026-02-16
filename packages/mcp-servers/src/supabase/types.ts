/**
 * Supabase MCP Server Types
 *
 * Type definitions for Supabase API interactions.
 */

import { z } from 'zod';

// Tool argument schemas
export const SelectArgsSchema = z.object({
  table: z.string(),
  select: z.string().optional().default('*'),
  filter: z.string().optional(),
  order: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

export const InsertArgsSchema = z.object({
  table: z.string(),
  data: z.record(z.unknown()),
  onConflict: z.string().optional(),
});

export const UpdateArgsSchema = z.object({
  table: z.string(),
  data: z.record(z.unknown()),
  filter: z.string(),
});

export const DeleteArgsSchema = z.object({
  table: z.string(),
  filter: z.string(),
});

export const RpcArgsSchema = z.object({
  function: z.string(),
  params: z.record(z.unknown()).optional(),
});

export const ListTablesArgsSchema = z.object({});

export const DescribeTableArgsSchema = z.object({
  table: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'Invalid table name: must be a valid SQL identifier'),
});

export const SqlArgsSchema = z.object({
  query: z.string(),
});

export const ListBucketsArgsSchema = z.object({});

export const ListFilesArgsSchema = z.object({
  bucket: z.string(),
  path: z.string().optional().default(''),
  limit: z.coerce.number().optional().default(100),
});

export const DeleteFileArgsSchema = z.object({
  bucket: z.string(),
  path: z.string(),
});

export const GetPublicUrlArgsSchema = z.object({
  bucket: z.string(),
  path: z.string(),
});

export const ListUsersArgsSchema = z.object({
  page: z.coerce.number().optional().default(1),
  perPage: z.coerce.number().optional().default(50),
});

export const GetUserArgsSchema = z.object({
  userId: z.string(),
});

export const DeleteUserArgsSchema = z.object({
  userId: z.string(),
});

export const GetProjectArgsSchema = z.object({});

export const ListMigrationsArgsSchema = z.object({});

export const PushMigrationArgsSchema = z.object({
  name: z.string().describe('Migration name (e.g., "add_orders_table"). Prefixed with timestamp by the API.'),
  sql: z.string().describe('SQL content of the migration to execute and track'),
});

export const GetMigrationArgsSchema = z.object({
  version: z.string().describe('Migration version/timestamp to retrieve'),
});

// Type exports
export type SelectArgs = z.infer<typeof SelectArgsSchema>;
export type InsertArgs = z.infer<typeof InsertArgsSchema>;
export type UpdateArgs = z.infer<typeof UpdateArgsSchema>;
export type DeleteArgs = z.infer<typeof DeleteArgsSchema>;
export type RpcArgs = z.infer<typeof RpcArgsSchema>;
export type ListTablesArgs = z.infer<typeof ListTablesArgsSchema>;
export type DescribeTableArgs = z.infer<typeof DescribeTableArgsSchema>;
export type SqlArgs = z.infer<typeof SqlArgsSchema>;
export type ListBucketsArgs = z.infer<typeof ListBucketsArgsSchema>;
export type ListFilesArgs = z.infer<typeof ListFilesArgsSchema>;
export type DeleteFileArgs = z.infer<typeof DeleteFileArgsSchema>;
export type GetPublicUrlArgs = z.infer<typeof GetPublicUrlArgsSchema>;
export type ListUsersArgs = z.infer<typeof ListUsersArgsSchema>;
export type GetUserArgs = z.infer<typeof GetUserArgsSchema>;
export type DeleteUserArgs = z.infer<typeof DeleteUserArgsSchema>;
export type GetProjectArgs = z.infer<typeof GetProjectArgsSchema>;
export type ListMigrationsArgs = z.infer<typeof ListMigrationsArgsSchema>;
export type PushMigrationArgs = z.infer<typeof PushMigrationArgsSchema>;
export type GetMigrationArgs = z.infer<typeof GetMigrationArgsSchema>;

// Response types
export interface SuccessResult {
  success: true;
  message: string;
}

export interface PublicUrlResult {
  publicUrl: string;
}

export interface InfoMessage {
  message: string;
}
