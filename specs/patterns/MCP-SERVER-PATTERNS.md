# MCP Server Patterns

Standard patterns for implementing MCP servers in the GENTYR.

## Directory Structure

```
packages/mcp-servers/src/{server-name}/
├── index.ts          # Re-exports
├── server.ts         # Server implementation
├── types.ts          # Zod schemas and TypeScript types
└── __tests__/
    └── {server-name}.test.ts
```

## Server Implementation Pattern

```typescript
// server.ts
import { z } from 'zod';
import { createMcpServer, type McpTool } from '../shared/server.js';
import { YourInputSchema, YourOutputSchema } from './types.js';

const tools: McpTool[] = [
  {
    name: 'your_tool_name',
    description: 'What this tool does',
    inputSchema: YourInputSchema,
    handler: async (args) => {
      const parsed = YourInputSchema.safeParse(args);
      if (!parsed.success) {
        return { error: `Validation failed: ${parsed.error.message}` };
      }

      // Implementation
      return { result: 'success' };
    },
  },
];

// Start server
createMcpServer('your-server-name', tools);
```

## Type Definition Pattern

```typescript
// types.ts
import { z } from 'zod';

// Input schemas (for validation)
export const YourInputSchema = z.object({
  required_field: z.string().min(1),
  optional_field: z.number().optional(),
});

// Derive TypeScript types from Zod
export type YourInput = z.infer<typeof YourInputSchema>;

// Output types (for documentation)
export interface YourOutput {
  result: string;
  data?: Record<string, unknown>;
}
```

## Database Pattern

```typescript
import Database from 'better-sqlite3';
import path from 'path';

function getDatabase(): Database.Database {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'your-server.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS your_table (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now')),
      -- other columns
    )
  `);

  return db;
}
```

## Testing Pattern

```typescript
// __tests__/your-server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';
import path from 'path';

describe('YourServer', () => {
  let testDir: string;
  let db: Database.Database;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'test-'));
    process.env.CLAUDE_PROJECT_DIR = testDir;
    // Initialize test database
  });

  afterEach(() => {
    db?.close();
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  it('should validate input', () => {
    // Test validation
  });
});
```

## Error Handling

```typescript
// Always return structured errors, never throw
handler: async (args) => {
  try {
    // operation
    return { success: true, data: result };
  } catch (error) {
    // Log the error (F004 - fail loud)
    console.error(`[server-name] Error in tool_name:`, error);

    // Return structured error
    return {
      error: error instanceof Error ? error.message : 'Unknown error',
      success: false
    };
  }
}
```
