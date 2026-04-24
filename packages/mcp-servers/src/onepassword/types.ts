import { z } from 'zod';

// Input schemas
export const readSecretSchema = z.object({
  reference: z.string().describe('op://vault/item/field reference'),
  include_value: z.boolean().optional().default(false)
    .describe('Return the raw secret value. WARNING: value enters conversation context. Default false — use secret_run_command instead.'),
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

export const checkAuthSchema = z.object({});

export const opVaultMapSchema = z.object({
  vault: z.string().optional().describe('Filter to a specific vault name. Omit for all accessible vaults.'),
});

// Valid 1Password item categories for create_item
const opItemCategories = [
  'Login', 'Password', 'Secure Note', 'API Credential', 'Database',
  'Server', 'Software License', 'Email Account', 'Credit Card',
  'Bank Account', 'Identity', 'Document', 'Membership', 'Passport',
  'Driver License', 'Outdoor License', 'Reward Program', 'Wireless Router',
  'Social Security Number', 'Crypto Wallet', 'Medical Record', 'SSH Key',
] as const;

// Valid field types for assignment statements
const opFieldTypes = [
  'text', 'password', 'concealed', 'email', 'url', 'date', 'monthyear',
  'phone', 'otp', 'file',
] as const;

const fieldAssignmentSchema = z.object({
  field: z.string().min(1).describe('Field name (e.g. "username", "api_key")'),
  value: z.string().describe('Field value. For sensitive values, consider using generate_password instead.'),
  type: z.enum(opFieldTypes).optional().default('text')
    .describe('Field type. Use "concealed" or "password" for secrets. Default: "text".'),
  section: z.string().optional()
    .describe('Optional section name to group the field under (e.g. "Database Credentials").'),
});

export const createItemSchema = z.object({
  title: z.string().describe('Item title (e.g. "Production API Key", "Staging Database")'),
  category: z.enum(opItemCategories).default('Secure Note')
    .describe('Item category. Default: "Secure Note". Use "API Credential" for API keys, "Login" for username/password pairs, "Database" for DB credentials.'),
  vault: z.string().optional()
    .describe('Vault name to store the item in. Default: account default vault.'),
  fields: z.array(fieldAssignmentSchema).optional()
    .describe('Fields to set on the item. Each field has a name, value, optional type, and optional section.'),
  tags: z.array(z.string()).optional()
    .describe('Tags to apply to the item (e.g. ["production", "api"])'),
  url: z.string().optional()
    .describe('URL associated with the item (e.g. "https://api.example.com")'),
  generate_password: z.boolean().optional().default(false)
    .describe('Generate a random password for Login/Password items. The generated value is NOT returned to conversation context.'),
  notes: z.string().optional()
    .describe('Notes to attach to the item.'),
});

export const addFieldsSchema = z.object({
  item: z.string().describe('Item name or ID to add fields to'),
  vault: z.string().optional()
    .describe('Vault containing the item. Required if item name is ambiguous.'),
  fields: z.array(fieldAssignmentSchema).min(1)
    .describe('Fields to add to the item. New field names create new fields; existing field names update their values.'),
});

// Type exports
export type ReadSecretArgs = z.infer<typeof readSecretSchema>;
export type ListItemsArgs = z.infer<typeof listItemsSchema>;
export type CreateServiceAccountArgs = z.infer<typeof createServiceAccountSchema>;
export type GetAuditLogArgs = z.infer<typeof getAuditLogSchema>;
export type CheckAuthArgs = z.infer<typeof checkAuthSchema>;
export type OpVaultMapArgs = z.infer<typeof opVaultMapSchema>;
export type CreateItemArgs = z.infer<typeof createItemSchema>;
export type AddFieldsArgs = z.infer<typeof addFieldsSchema>;
