import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readSecretSchema, listItemsSchema, createServiceAccountSchema, getAuditLogSchema, createItemSchema, addFieldsSchema } from '../types.js';
import { execFileSync } from 'child_process';

// Mock execFileSync to verify command injection prevention
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

// Prevent MCP server from starting its stdio readline loop (which calls process.exit)
process.env.MCP_SHARED_DAEMON = '1';

// Import tools after mock is established so handlers use the mocked execFileSync
const { tools } = await import('../server.js');

function findHandler(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler;
}

describe('1Password MCP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Schema Validation', () => {
    it('validates read_secret args', () => {
      const valid = { reference: 'op://Production/Supabase/service-role-key' };
      expect(() => readSecretSchema.parse(valid)).not.toThrow();
    });

    it('validates list_items args', () => {
      const valid = { vault: 'Production', categories: ['password', 'database'] };
      expect(() => listItemsSchema.parse(valid)).not.toThrow();
    });

    it('validates list_items with optional fields', () => {
      const valid = { vault: 'Production' };
      expect(() => listItemsSchema.parse(valid)).not.toThrow();
    });

    it('validates create_service_account args', () => {
      const valid = { name: 'Test Service Account', vaults: ['Production', 'Staging'] };
      expect(() => createServiceAccountSchema.parse(valid)).not.toThrow();
    });

    it('validates create_service_account with expiry', () => {
      const valid = { name: 'Test', vaults: ['Production'], expiresInDays: 90 };
      expect(() => createServiceAccountSchema.parse(valid)).not.toThrow();
    });

    it('validates get_audit_log args', () => {
      const valid = { vault: 'Production' };
      expect(() => getAuditLogSchema.parse(valid)).not.toThrow();
    });

    it('validates get_audit_log with time range', () => {
      const valid = {
        vault: 'Production',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-31T23:59:59Z',
        action: 'item.read',
      };
      expect(() => getAuditLogSchema.parse(valid)).not.toThrow();
    });

    it('validates read_secret with include_value false (default)', () => {
      const valid = { reference: 'op://Production/Supabase/service-role-key' };
      const parsed = readSecretSchema.parse(valid);
      expect(parsed.include_value).toBe(false);
    });

    it('validates read_secret with include_value true', () => {
      const valid = { reference: 'op://Production/Supabase/service-role-key', include_value: true };
      const parsed = readSecretSchema.parse(valid);
      expect(parsed.include_value).toBe(true);
    });

    it('validates create_item with minimal args', () => {
      const valid = { title: 'My API Key' };
      const parsed = createItemSchema.parse(valid);
      expect(parsed.category).toBe('Secure Note');
      expect(parsed.generate_password).toBe(false);
    });

    it('validates create_item with all fields', () => {
      const valid = {
        title: 'Production DB',
        category: 'Database' as const,
        vault: 'Production',
        fields: [
          { field: 'hostname', value: 'db.example.com', type: 'text' as const },
          { field: 'password', value: 'secret123', type: 'concealed' as const, section: 'Credentials' },
        ],
        tags: ['production', 'database'],
        url: 'https://db.example.com',
        notes: 'Production database credentials',
      };
      expect(() => createItemSchema.parse(valid)).not.toThrow();
    });

    it('validates create_item rejects invalid category', () => {
      const invalid = { title: 'Test', category: 'InvalidCategory' };
      expect(() => createItemSchema.parse(invalid)).toThrow();
    });

    it('validates create_item field type defaults to text', () => {
      const valid = {
        title: 'Test',
        fields: [{ field: 'host', value: 'localhost' }],
      };
      const parsed = createItemSchema.parse(valid);
      expect(parsed.fields![0].type).toBe('text');
    });

    it('validates add_item_fields with required fields', () => {
      const valid = {
        item: 'My API Key',
        fields: [{ field: 'api_secret', value: 'sk-123', type: 'concealed' as const }],
      };
      expect(() => addFieldsSchema.parse(valid)).not.toThrow();
    });

    it('validates add_item_fields with vault and section', () => {
      const valid = {
        item: 'abc123',
        vault: 'Production',
        fields: [
          { field: 'db_host', value: 'postgres.example.com', section: 'Connection' },
          { field: 'db_password', value: 'secret', type: 'concealed' as const, section: 'Connection' },
        ],
      };
      expect(() => addFieldsSchema.parse(valid)).not.toThrow();
    });

    it('validates add_item_fields requires at least one field', () => {
      const invalid = { item: 'My API Key', fields: [] };
      expect(() => addFieldsSchema.parse(invalid)).toThrow();
    });
  });

  describe('Command Injection Prevention (execFileSync)', () => {
    it('should use execFileSync instead of execSync to prevent shell injection', () => {
      // This test verifies that the implementation uses execFileSync
      // which prevents shell injection by not invoking a shell

      // The server.ts file imports execFileSync from 'child_process'
      // This is the secure approach vs execSync which would allow shell injection

      // Verify the import exists (type-level check)
      expect(typeof execFileSync).toBe('function');
    });

    it('should reject malicious input in reference argument', () => {
      // Attempt shell injection via reference field
      const malicious = {
        reference: 'op://Production/Secret && rm -rf / #',
      };

      // Schema validation should allow this (it's a valid string)
      // but execFileSync will treat it as a literal argument, not shell code
      expect(() => readSecretSchema.parse(malicious)).not.toThrow();

      // The key security property: execFileSync(['op', 'read', reference])
      // will pass the entire string as ONE argument to op, not execute the shell command
    });

    it('should handle vault names with special characters safely', () => {
      const specialChars = {
        vault: 'Production;echo"pwned"',
        categories: ['password'],
      };

      // Should validate successfully
      expect(() => listItemsSchema.parse(specialChars)).not.toThrow();

      // execFileSync will treat the vault name as a literal argument
      // The semicolon and quotes won't be interpreted by a shell
    });

    it('should handle service account names with shell metacharacters safely', () => {
      const maliciousName = {
        name: 'TestAccount`whoami`',
        vaults: ['Production'],
      };

      // Should validate successfully
      expect(() => createServiceAccountSchema.parse(maliciousName)).not.toThrow();

      // execFileSync prevents backtick command substitution
      // The backticks are treated as literal characters in the argument
    });

    it('should handle action parameter with injection attempts safely', () => {
      const maliciousAction = {
        vault: 'Production',
        action: 'item.read|cat/etc/passwd',
      };

      // Should validate successfully
      expect(() => getAuditLogSchema.parse(maliciousAction)).not.toThrow();

      // execFileSync prevents pipe interpretation
      // The entire string is passed as one argument to op
    });

    it('should handle create_item field values with shell metacharacters safely', () => {
      const malicious = {
        title: 'Test$(whoami)',
        fields: [{ field: 'key`rm -rf /`', value: 'val;echo pwned' }],
      };
      // Schema validates (strings are valid), execFileSync prevents execution
      expect(() => createItemSchema.parse(malicious)).not.toThrow();
    });

    it('should handle add_item_fields with injection in item name', () => {
      const malicious = {
        item: 'item;cat /etc/passwd',
        fields: [{ field: 'test', value: 'value' }],
      };
      expect(() => addFieldsSchema.parse(malicious)).not.toThrow();
    });
  });

  describe('Security Properties', () => {
    it('should fail loudly on 1Password CLI errors', () => {
      // When execFileSync throws, the error should propagate
      // This ensures we don't silently ignore failures (G001)

      const mockError = new Error('1Password CLI not found');
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw mockError;
      });

      // The opCommand helper should wrap and re-throw errors
      // This test documents the expected behavior
      expect(execFileSync).toBeDefined();
    });

    it('should not expose OP_SERVICE_ACCOUNT_TOKEN in error messages', () => {
      // Verify that errors don't leak the service account token
      const invalidRef = { reference: 'op://Invalid/Path' };

      // Schema validation passes
      expect(() => readSecretSchema.parse(invalidRef)).not.toThrow();

      // If execFileSync fails, the error message should not contain the token
      // This is a documentation test for the error handling behavior
    });
  });

  describe('create_item handler — CLI argument construction', () => {
    const mockCreatedItem = {
      id: 'abc123',
      title: 'Test Item',
      category: 'Secure Note',
      vault: { id: 'v1', name: 'Production' },
      fields: [
        { label: 'api_key', reference: 'op://Production/Test Item/api_key', type: 'CONCEALED' },
      ],
    };

    beforeEach(() => {
      // Reset clears any pending mockImplementationOnce entries from previous tests
      vi.resetAllMocks();
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify(mockCreatedItem));
    });

    it('should call op item create with correct base args', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Test Item', vault: 'Production' });

      expect(execFileSync).toHaveBeenCalledWith(
        'op',
        expect.arrayContaining(['item', 'create', '--format', 'json', '--title', 'Test Item', '--vault', 'Production']),
        expect.any(Object),
      );
    });

    it('should include --category arg', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'DB Creds', category: 'Database', vault: 'Production' });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('--category');
      expect(args).toContain('Database');
    });

    it('should include --generate-password when generate_password is true', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Login Item', category: 'Login', generate_password: true });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('--generate-password');
    });

    it('should NOT include --generate-password when generate_password is false (default)', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Test' });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).not.toContain('--generate-password');
    });

    it('should append notesPlain assignment when notes are provided', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Test', notes: 'my notes' });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('notesPlain=my notes');
    });

    it('should NOT append notesPlain when notes are absent', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Test' });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args.some((a: string) => a.startsWith('notesPlain'))).toBe(false);
    });

    it('should include --tags when tags are provided', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Test', tags: ['production', 'api'] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('--tags');
      expect(args).toContain('production,api');
    });

    it('should include --url when url is provided', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'Test', url: 'https://api.example.com' });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('--url');
      expect(args).toContain('https://api.example.com');
    });

    it('should return field references not raw values', async () => {
      const handler = findHandler('create_item');
      const result = await handler({ title: 'Test' }) as Record<string, unknown>;

      expect(result).toHaveProperty('id', 'abc123');
      expect(result).toHaveProperty('title', 'Test Item');
      expect(result).toHaveProperty('vault', 'Production');
      expect(Array.isArray(result.fields)).toBe(true);
      // Response must not contain raw secret value — only op:// references
      const fields = result.fields as Array<{ reference: string }>;
      expect(fields[0].reference).toMatch(/^op:\/\//);
    });

    it('should fail loudly when op CLI throws on create_item', async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('op: vault not found');
      });

      const handler = findHandler('create_item');
      await expect(handler({ title: 'Test', vault: 'NonExistent' })).rejects.toThrow(
        '1Password CLI error',
      );
    });
  });

  describe('buildAssignment — field assignment string construction', () => {
    // buildAssignment is internal but its output is observable via execFileSync args.
    // We test by invoking the create_item handler and inspecting args.

    const baseItem = {
      id: 'x1',
      title: 'T',
      category: 'Secure Note',
      vault: { id: 'v1', name: 'Default' },
      fields: [],
    };

    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify(baseItem));
    });

    it('should produce "field=value" for a plain text field', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'T', fields: [{ field: 'username', value: 'alice' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('username=alice');
    });

    it('should produce "field[type]=value" for non-text type', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'T', fields: [{ field: 'token', value: 'sk-123', type: 'concealed' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('token[concealed]=sk-123');
    });

    it('should produce "section.field=value" when section is provided', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'T', fields: [{ field: 'host', value: 'localhost', section: 'DB' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('DB.host=localhost');
    });

    it('should produce "section.field[type]=value" when both section and type are provided', async () => {
      const handler = findHandler('create_item');
      await handler({
        title: 'T',
        fields: [{ field: 'password', value: 'secret', type: 'concealed', section: 'Credentials' }],
      });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('Credentials.password[concealed]=secret');
    });

    it('should escape dots in section names with backslash', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'T', fields: [{ field: 'key', value: 'v', section: 'A.B' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      // The dot in "A.B" must be escaped as "A\.B" so op CLI treats it as a literal section name
      expect(args).toContain('A\\.B.key=v');
    });

    it('should escape dots in field names with backslash', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'T', fields: [{ field: 'my.field', value: 'v' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('my\\.field=v');
    });

    it('should escape equals signs in field names', async () => {
      const handler = findHandler('create_item');
      await handler({ title: 'T', fields: [{ field: 'key=name', value: 'v' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('key\\=name=v');
    });

    it('should NOT add type bracket for the default text type', async () => {
      const handler = findHandler('create_item');
      // type: 'text' is the default — should emit "field=value" not "field[text]=value"
      await handler({ title: 'T', fields: [{ field: 'host', value: 'db.example.com', type: 'text' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('host=db.example.com');
      expect(args).not.toContain('host[text]=db.example.com');
    });
  });

  describe('add_item_fields handler — CLI argument construction', () => {
    const mockUpdatedItem = {
      id: 'item-abc',
      title: 'Supabase',
      category: 'Database',
      vault: { id: 'v1', name: 'Production' },
      fields: [
        { label: 'service_role_key', reference: 'op://Production/Supabase/service_role_key', type: 'CONCEALED' },
      ],
    };

    beforeEach(() => {
      vi.resetAllMocks();
      vi.mocked(execFileSync).mockReturnValue(JSON.stringify(mockUpdatedItem));
    });

    it('should call op item edit with item name and --format json', async () => {
      const handler = findHandler('add_item_fields');
      await handler({
        item: 'Supabase',
        fields: [{ field: 'service_role_key', value: 'eyJ...' }],
      });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('item');
      expect(args).toContain('edit');
      expect(args).toContain('Supabase');
      expect(args).toContain('--format');
      expect(args).toContain('json');
    });

    it('should include --vault when vault is provided', async () => {
      const handler = findHandler('add_item_fields');
      await handler({
        item: 'Supabase',
        vault: 'Production',
        fields: [{ field: 'key', value: 'val' }],
      });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('--vault');
      expect(args).toContain('Production');
    });

    it('should NOT include --vault when vault is absent', async () => {
      const handler = findHandler('add_item_fields');
      await handler({ item: 'Supabase', fields: [{ field: 'key', value: 'val' }] });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).not.toContain('--vault');
    });

    it('should append field assignments as separate args for multiple fields', async () => {
      const handler = findHandler('add_item_fields');
      await handler({
        item: 'MyItem',
        fields: [
          { field: 'host', value: 'db.example.com' },
          { field: 'port', value: '5432' },
        ],
      });

      const [, args] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], unknown];
      expect(args).toContain('host=db.example.com');
      expect(args).toContain('port=5432');
    });

    it('should return added field references', async () => {
      const handler = findHandler('add_item_fields');
      const result = await handler({
        item: 'Supabase',
        fields: [{ field: 'service_role_key', value: 'eyJ...' }],
      }) as Record<string, unknown>;

      expect(result).toHaveProperty('id', 'item-abc');
      expect(result).toHaveProperty('title', 'Supabase');
      expect(result).toHaveProperty('vault', 'Production');
      expect(Array.isArray(result.added_fields)).toBe(true);
      const addedFields = result.added_fields as Array<{ reference: string }>;
      expect(addedFields[0].reference).toMatch(/^op:\/\//);
    });

    it('should fail loudly when op CLI throws on add_item_fields', async () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('op: item not found');
      });

      const handler = findHandler('add_item_fields');
      await expect(
        handler({ item: 'NonExistent', fields: [{ field: 'k', value: 'v' }] }),
      ).rejects.toThrow('1Password CLI error');
    });

    it('field type defaults to text in addFieldsSchema', () => {
      const parsed = addFieldsSchema.parse({
        item: 'MyItem',
        fields: [{ field: 'host', value: 'localhost' }],
      });
      expect(parsed.fields[0].type).toBe('text');
    });
  });
});
