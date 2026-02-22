/**
 * Unit tests for Supabase MCP Server Schema Validation
 *
 * Tests the SQL injection fix applied to all table/function identifier schemas.
 * The `sqlIdentifier` validator was added to prevent injection attacks via
 * malicious table names passed to supabase_select, supabase_insert,
 * supabase_update, supabase_delete, supabase_rpc, and supabase_describe_table.
 *
 * Security context: These schemas are the primary defence against SQL injection
 * through identifier fields. The `supabase_sql` tool intentionally accepts
 * arbitrary strings as it is a raw SQL execution tool — that is documented below.
 */

import { describe, it, expect } from 'vitest';
import {
  SelectArgsSchema,
  InsertArgsSchema,
  UpdateArgsSchema,
  DeleteArgsSchema,
  RpcArgsSchema,
  DescribeTableArgsSchema,
  SqlArgsSchema,
} from '../types.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/**
 * Identifiers that satisfy the SQL_IDENTIFIER_REGEX:
 *   /^[a-zA-Z_][a-zA-Z0-9_]*$/
 * Every schema that uses `sqlIdentifier` must accept all of these.
 */
const VALID_IDENTIFIERS = [
  // Simple common names
  'users',
  'orders',
  'products',
  // Underscores anywhere
  'user_roles',
  '_internal',
  '_meta',
  '_config',
  // Mixed case
  'UserRoles',
  'myTable',
  'CamelCase',
  // Single characters
  'A',
  'z',
  '_',
  // Numbers after the first character
  'table123',
  'table1',
  'schema2',
  'a1b2c3',
];

/**
 * Classic SQL injection payloads targeting identifier positions.
 * None of these must pass validation.
 */
const SQL_INJECTION_PAYLOADS = [
  "'; DROP TABLE users; --",
  'users; SELECT 1',
  "table' OR '1'='1",
  "users'",
  'table; --',
  '1=1',
  'users OR 1=1',
  'users--',
  '"; DROP TABLE users; --',
  'users UNION SELECT * FROM secrets',
];

/**
 * Other strings that are structurally invalid as SQL identifiers.
 * None of these must pass validation.
 */
const INVALID_IDENTIFIERS = [
  // Starts with a digit
  '123start',
  '1table',
  '0_prefix',
  // Empty string
  '',
  // Contains spaces
  'table name',
  'my table',
  // Contains hyphens
  'table-name',
  'my-schema',
  // Contains dots (schema.table notation not supported)
  'schema.table',
  'public.users',
  // Contains query-string characters
  'table?foo=bar',
  'table&other',
  // Contains slashes
  'path/to/table',
  // Contains brackets
  'table[0]',
  // Contains percent encoding
  'table%20name',
  // Contains null bytes
  'table\x00',
  // Contains parentheses
  'func()',
  // Contains asterisk
  'table*',
  // Contains equals
  'table=1',
  // Contains semicolon alone
  ';',
];

// ---------------------------------------------------------------------------
// Helper: build a minimal valid object for each schema
// ---------------------------------------------------------------------------

function selectInput(table: string) {
  return { table };
}

function insertInput(table: string) {
  return { table, data: { col: 'val' } };
}

function updateInput(table: string) {
  return { table, data: { col: 'val' }, filter: 'id=eq.1' };
}

function deleteInput(table: string) {
  return { table, filter: 'id=eq.1' };
}

function rpcInput(fn: string) {
  return { function: fn };
}

function describeInput(table: string) {
  return { table };
}

// ---------------------------------------------------------------------------
// Parameterised test helper
// ---------------------------------------------------------------------------

type SchemaParser = (input: unknown) => { success: boolean };

function makeParser(parse: (v: unknown) => { success: boolean }): SchemaParser {
  return parse;
}

/**
 * Verify that a schema accepts every valid identifier.
 */
function expectAllValidIdentifiersPass(
  schemaName: string,
  parser: SchemaParser,
  buildInput: (id: string) => unknown,
) {
  describe(`${schemaName} - valid SQL identifiers`, () => {
    for (const identifier of VALID_IDENTIFIERS) {
      it(`should accept '${identifier}'`, () => {
        const result = parser(buildInput(identifier));
        expect(result.success).toBe(true);
      });
    }
  });
}

/**
 * Verify that a schema rejects every SQL injection payload.
 */
function expectAllInjectionPayloadsReject(
  schemaName: string,
  parser: SchemaParser,
  buildInput: (id: string) => unknown,
) {
  describe(`${schemaName} - SQL injection payloads MUST be rejected`, () => {
    for (const payload of SQL_INJECTION_PAYLOADS) {
      it(`should reject injection payload: '${payload}'`, () => {
        const result = parser(buildInput(payload));
        expect(result.success).toBe(false);
      });
    }
  });
}

/**
 * Verify that a schema rejects every structurally invalid identifier.
 */
function expectAllInvalidIdentifiersReject(
  schemaName: string,
  parser: SchemaParser,
  buildInput: (id: string) => unknown,
) {
  describe(`${schemaName} - invalid SQL identifiers MUST be rejected`, () => {
    for (const identifier of INVALID_IDENTIFIERS) {
      it(`should reject '${identifier}'`, () => {
        const result = parser(buildInput(identifier));
        expect(result.success).toBe(false);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Tests: SelectArgsSchema
// ---------------------------------------------------------------------------

describe('SelectArgsSchema', () => {
  const parser = makeParser((v) => SelectArgsSchema.safeParse(v));
  const build = selectInput;

  expectAllValidIdentifiersPass('SelectArgsSchema', parser, build);
  expectAllInjectionPayloadsReject('SelectArgsSchema', parser, build);
  expectAllInvalidIdentifiersReject('SelectArgsSchema', parser, build);

  describe('error message quality', () => {
    it('should include a descriptive error for injection attempts', () => {
      const result = SelectArgsSchema.safeParse({ table: "'; DROP TABLE users; --" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ');
        expect(messages).toMatch(/Invalid SQL identifier/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: InsertArgsSchema
// ---------------------------------------------------------------------------

describe('InsertArgsSchema', () => {
  const parser = makeParser((v) => InsertArgsSchema.safeParse(v));
  const build = insertInput;

  expectAllValidIdentifiersPass('InsertArgsSchema', parser, build);
  expectAllInjectionPayloadsReject('InsertArgsSchema', parser, build);
  expectAllInvalidIdentifiersReject('InsertArgsSchema', parser, build);

  describe('error message quality', () => {
    it('should include a descriptive error for injection attempts', () => {
      const result = InsertArgsSchema.safeParse({ table: 'users; DROP TABLE users', data: {} });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ');
        expect(messages).toMatch(/Invalid SQL identifier/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: UpdateArgsSchema
// ---------------------------------------------------------------------------

describe('UpdateArgsSchema', () => {
  const parser = makeParser((v) => UpdateArgsSchema.safeParse(v));
  const build = updateInput;

  expectAllValidIdentifiersPass('UpdateArgsSchema', parser, build);
  expectAllInjectionPayloadsReject('UpdateArgsSchema', parser, build);
  expectAllInvalidIdentifiersReject('UpdateArgsSchema', parser, build);

  describe('error message quality', () => {
    it('should include a descriptive error for injection attempts', () => {
      const result = UpdateArgsSchema.safeParse({
        table: "table' OR '1'='1",
        data: {},
        filter: 'id=eq.1',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ');
        expect(messages).toMatch(/Invalid SQL identifier/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: DeleteArgsSchema
// ---------------------------------------------------------------------------

describe('DeleteArgsSchema', () => {
  const parser = makeParser((v) => DeleteArgsSchema.safeParse(v));
  const build = deleteInput;

  expectAllValidIdentifiersPass('DeleteArgsSchema', parser, build);
  expectAllInjectionPayloadsReject('DeleteArgsSchema', parser, build);
  expectAllInvalidIdentifiersReject('DeleteArgsSchema', parser, build);

  describe('error message quality', () => {
    it('should include a descriptive error for injection attempts', () => {
      const result = DeleteArgsSchema.safeParse({
        table: 'users; SELECT 1',
        filter: 'id=eq.1',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ');
        expect(messages).toMatch(/Invalid SQL identifier/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: RpcArgsSchema (uses `function` field, not `table`)
// ---------------------------------------------------------------------------

describe('RpcArgsSchema', () => {
  const parser = makeParser((v) => RpcArgsSchema.safeParse(v));
  const build = rpcInput;

  expectAllValidIdentifiersPass('RpcArgsSchema', parser, build);
  expectAllInjectionPayloadsReject('RpcArgsSchema', parser, build);
  expectAllInvalidIdentifiersReject('RpcArgsSchema', parser, build);

  describe('error message quality', () => {
    it('should include a descriptive error for injection attempts on function field', () => {
      const result = RpcArgsSchema.safeParse({ function: "'; DROP TABLE users; --" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ');
        expect(messages).toMatch(/Invalid SQL identifier/);
      }
    });
  });

  describe('optional params field', () => {
    it('should accept a valid function name with no params', () => {
      const result = RpcArgsSchema.safeParse({ function: 'my_function' });
      expect(result.success).toBe(true);
    });

    it('should accept a valid function name with params', () => {
      const result = RpcArgsSchema.safeParse({ function: 'my_function', params: { arg1: 'val' } });
      expect(result.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: DescribeTableArgsSchema
// ---------------------------------------------------------------------------

describe('DescribeTableArgsSchema', () => {
  const parser = makeParser((v) => DescribeTableArgsSchema.safeParse(v));
  const build = describeInput;

  expectAllValidIdentifiersPass('DescribeTableArgsSchema', parser, build);
  expectAllInjectionPayloadsReject('DescribeTableArgsSchema', parser, build);
  expectAllInvalidIdentifiersReject('DescribeTableArgsSchema', parser, build);

  describe('error message quality', () => {
    it('should include a descriptive error for injection attempts', () => {
      const result = DescribeTableArgsSchema.safeParse({ table: 'users--' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' ');
        expect(messages).toMatch(/Invalid SQL identifier/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: SqlArgsSchema — intentional pass-through (raw SQL execution)
// ---------------------------------------------------------------------------

/**
 * SqlArgsSchema intentionally accepts any string in its `query` field.
 *
 * This is by design: the `supabase_sql` tool is explicitly documented as a
 * raw SQL execution endpoint that requires SUPABASE_ACCESS_TOKEN.  It is
 * NOT subject to the sqlIdentifier constraint because the entire query is the
 * user-supplied input.  Access to this tool should be controlled at the
 * authorisation layer, not by input sanitisation.
 *
 * These tests assert that unrestricted input IS accepted, documenting the
 * intentional difference from the table/function schemas above.
 */
describe('SqlArgsSchema - intentional pass-through for raw SQL', () => {
  it('should accept a normal SELECT query', () => {
    const result = SqlArgsSchema.safeParse({ query: 'SELECT * FROM users' });
    expect(result.success).toBe(true);
  });

  it('should accept a query with semicolons (multi-statement raw SQL)', () => {
    const result = SqlArgsSchema.safeParse({
      query: 'BEGIN; UPDATE users SET active = true; COMMIT;',
    });
    expect(result.success).toBe(true);
  });

  it('should accept a query containing single quotes', () => {
    const result = SqlArgsSchema.safeParse({
      query: "SELECT * FROM users WHERE name = 'alice'",
    });
    expect(result.success).toBe(true);
  });

  it('should accept a query containing SQL injection-like patterns (intentional - raw SQL tool)', () => {
    // This is INTENTIONAL. The supabase_sql tool executes raw SQL.
    // Authorization controls must be enforced at the API layer, not here.
    const result = SqlArgsSchema.safeParse({
      query: "'; DROP TABLE users; --",
    });
    expect(result.success).toBe(true);
  });

  it('should accept DDL statements', () => {
    const result = SqlArgsSchema.safeParse({
      query: 'CREATE TABLE foo (id serial PRIMARY KEY)',
    });
    expect(result.success).toBe(true);
  });

  it('should reject a missing query field', () => {
    const result = SqlArgsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject a non-string query field', () => {
    const result = SqlArgsSchema.safeParse({ query: 42 });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Regex boundary conditions for the sqlIdentifier validator
// ---------------------------------------------------------------------------

describe('sqlIdentifier regex boundary conditions', () => {
  // Use SelectArgsSchema as the canonical schema for regex edge-case tests.
  const parse = (table: string) => SelectArgsSchema.safeParse({ table });

  describe('first character constraints', () => {
    it('should accept identifier starting with lowercase letter', () => {
      expect(parse('a').success).toBe(true);
    });

    it('should accept identifier starting with uppercase letter', () => {
      expect(parse('Z').success).toBe(true);
    });

    it('should accept identifier starting with underscore', () => {
      expect(parse('_').success).toBe(true);
    });

    it('should reject identifier starting with digit 0', () => {
      expect(parse('0name').success).toBe(false);
    });

    it('should reject identifier starting with digit 9', () => {
      expect(parse('9table').success).toBe(false);
    });

    it('should reject identifier starting with hyphen', () => {
      expect(parse('-name').success).toBe(false);
    });

    it('should reject identifier starting with space', () => {
      expect(parse(' name').success).toBe(false);
    });

    it('should reject identifier starting with single quote', () => {
      expect(parse("'name").success).toBe(false);
    });

    it('should reject identifier starting with double quote', () => {
      expect(parse('"name').success).toBe(false);
    });
  });

  describe('body character constraints', () => {
    it('should accept all-uppercase identifier', () => {
      expect(parse('TABLENAME').success).toBe(true);
    });

    it('should accept all-lowercase identifier', () => {
      expect(parse('tablename').success).toBe(true);
    });

    it('should accept identifier with trailing underscores', () => {
      expect(parse('table__').success).toBe(true);
    });

    it('should accept identifier with digits in the middle', () => {
      expect(parse('t1a2b3').success).toBe(true);
    });

    it('should reject identifier with dot in body', () => {
      expect(parse('table.name').success).toBe(false);
    });

    it('should reject identifier with hyphen in body', () => {
      expect(parse('table-name').success).toBe(false);
    });

    it('should reject identifier with space in body', () => {
      expect(parse('table name').success).toBe(false);
    });

    it('should reject identifier with semicolon in body', () => {
      expect(parse('table;drop').success).toBe(false);
    });

    it('should reject identifier with single quote in body', () => {
      expect(parse("table'name").success).toBe(false);
    });

    it('should reject identifier with newline in body', () => {
      expect(parse('table\nname').success).toBe(false);
    });

    it('should reject identifier with tab in body', () => {
      expect(parse('table\tname').success).toBe(false);
    });
  });

  describe('empty and whitespace-only strings', () => {
    it('should reject empty string', () => {
      expect(parse('').success).toBe(false);
    });

    it('should reject whitespace-only string', () => {
      expect(parse('   ').success).toBe(false);
    });

    it('should reject single space', () => {
      expect(parse(' ').success).toBe(false);
    });
  });
});
