# GENTYR Test Suite

This directory contains integration tests, E2E tests, and test fixtures for the GENTYR AI User Feedback System.

## Structure

```
tests/
├── fixtures/
│   └── toy-app/                    # Minimal test application with intentional bugs
│       ├── server.js               # HTTP server (web UI + REST API)
│       ├── cli.js                  # Command-line interface
│       └── package.json
├── integration/
│   ├── helpers/
│   │   └── mcp-test-client.ts      # Convenience wrapper for processRequest
│   ├── feedback-e2e.test.ts        # Integration tests (real MCP handlers)
│   └── feedback-pipeline.test.ts   # Pipeline integration tests
├── e2e/
│   ├── helpers/
│   │   ├── project-factory.ts      # Creates temp project dirs with seeded DBs
│   │   ├── prerequisites.ts        # Checks for claude CLI and built MCP servers
│   │   └── result-verifier.ts      # Reads DB files and verifies session results
│   ├── feedback-agents.test.ts     # Real Claude agent E2E tests
│   └── vitest.config.ts            # E2E vitest config with long timeouts
└── README.md                       # This file
```

## Toy Application

The toy app is a minimal Node.js application used to test the feedback system end-to-end. It includes:

- **Web UI**: Login, task dashboard, settings pages
- **REST API**: Authentication and task management endpoints
- **CLI**: Command-line task management tool
- **SDK**: CommonJS module for programmatic task management
- **Intentional Bugs**: Seeded bugs for feedback agents to discover across all consumption modes

### Intentional Bugs

The toy app contains these intentional bugs across different consumption modes:

**Web UI / API (server.js):**
1. Login form shows no error on wrong password (just redirects back to login)
2. No confirmation dialog before deleting tasks
3. Settings page has a broken link to "Privacy Policy"
4. API returns 200 instead of 201 for successful task creation

**CLI (cli.js):**
5. CLI has no `--help` flag

**SDK (lib.cjs):**
6. `createTask()` accepts null/undefined/empty title without validation
7. `getTask()` returns property "complted" instead of "completed" (typo)
8. `deleteTask()` returns success even for non-existent task IDs
9. `listTasks({ completed: true })` filter fails with integer 1/0 values (strict equality bug)

### Running the Toy App

```bash
cd tests/fixtures/toy-app
node server.js
# Server starts on a random port (or use PORT=3000 node server.js)

# Test the CLI
node cli.js tasks list --api-url=http://localhost:PORT
node cli.js tasks create --title="New task" --api-url=http://localhost:PORT

# Test the SDK
node -e "const sdk = require('./lib.cjs'); console.log(sdk.listTasks());"
```

Default credentials: `admin` / `admin123`

## Integration Tests (Fast, No Claude)

The integration tests call real MCP handler code via server factories and `processRequest()`. No Claude sessions are spawned.

### How It Works

Each MCP server exports a factory function that returns a configured, unstarted server:

```typescript
import { createUserFeedbackServer } from '../../packages/mcp-servers/src/user-feedback/server.js';
import { createFeedbackReporterServer } from '../../packages/mcp-servers/src/feedback-reporter/server.js';
import { McpTestClient } from './helpers/mcp-test-client.js';

const server = createUserFeedbackServer({ db: testDb, projectDir: tmpDir });
const client = new McpTestClient(server);

const persona = await client.callTool('create_persona', { name: 'tester', ... });
```

### Test Coverage

1. **Persona CRUD + Feature Registration Flow**
   - Create personas, register features, map them via real `user-feedback` MCP calls
   - Verify `get_personas_for_changes` returns correct personas

2. **Feedback Run Lifecycle**
   - Start feedback runs, track sessions, complete them via real MCP calls
   - Verify run status transitions (pending → in_progress → completed/partial/failed)

3. **Feedback Reporter → Agent Reports Bridge**
   - Submit findings and summaries via real `feedback-reporter` MCP calls
   - Verify reports in agent-reports DB with correct category/priority mapping

4. **Audit Trail Verification**
   - Real `AuditedMcpServer` logging (no manual `recordAuditEvent` stubs)
   - Verify events, error tracking, and cross-server audit trails

5. **Change Analysis Edge Cases**
   - No matching features, multiple feature matches, disabled personas, orphan features

### Running Integration Tests

```bash
npx vitest run tests/integration/

# Specific file
npx vitest run tests/integration/feedback-e2e.test.ts
npx vitest run tests/integration/feedback-pipeline.test.ts
```

## E2E Tests (Real Claude Agents)

E2E tests spawn actual Claude agent sessions against the toy app. These are opt-in and require:

1. `claude` CLI installed and accessible
2. MCP servers built (`cd packages/mcp-servers && npm run build`)
3. Playwright browsers installed for GUI tests (optional): `npx playwright install chromium`

GUI tests will be automatically skipped if Playwright browsers are not installed.

### What They Test

- **Launcher functions**: `getPersona`, `generateMcpConfig`, `buildPrompt` with real project dirs
- **API persona session**: Real Claude agent using `api_request` tool to test the toy app REST API
- **CLI persona session**: Real Claude agent using `cli_run` tool to test the toy app CLI
- **GUI persona session**: Real Claude agent using Playwright to test the web UI (requires `npx playwright install chromium`)
- **SDK persona session**: Real Claude agent using SDK tools to test the programmatic interface
- **Full pipeline**: Multiple personas triggered by change detection, parallel Claude sessions across all consumption modes

### Running E2E Tests

```bash
# Build MCP servers first
cd packages/mcp-servers && npm run build && cd ../..

# Run E2E tests (requires claude CLI)
npm run test:e2e
```

E2E tests have long timeouts (5 min per test) and will skip automatically if prerequisites are not met.

## Architecture

The test suite uses a two-layer approach:

### Integration Layer (Fast, CI-friendly)
- Creates in-memory SQLite databases
- Calls real MCP server handler code via `processRequest()`
- Uses server factories (`createUserFeedbackServer`, `createFeedbackReporterServer`, etc.)
- No stubs, no mocks — real handler logic with test-injected databases
- Runs in seconds

### E2E Layer (Real Claude, Opt-in)
- Creates temporary project directories with seeded databases (project factory)
- Generates real MCP configs via the feedback launcher
- Spawns real Claude agent sessions with `runFeedbackAgent`
- Verifies findings, reports, and audit trails in actual DB files
- Runs in minutes

## Adding New Tests

### Integration Tests

```typescript
import { createUserFeedbackServer } from '../../packages/mcp-servers/src/user-feedback/server.js';
import { McpTestClient } from './helpers/mcp-test-client.js';
import Database from 'better-sqlite3';

describe('New Feature', () => {
  let db: Database.Database;
  let client: McpTestClient;

  beforeEach(() => {
    db = new Database(':memory:');
    // Initialize schema...
    const server = createUserFeedbackServer({ db, projectDir: '/tmp/test' });
    client = new McpTestClient(server);
  });

  afterEach(() => {
    db.close();
  });

  it('should test via real MCP handlers', async () => {
    const result = await client.callTool('some_tool', { arg: 'value' });
    expect(result).toBeDefined();
  });
});
```

### E2E Tests

```typescript
import { createTestProject } from './helpers/project-factory.js';
import { skipIfPrerequisitesNotMet } from './helpers/prerequisites.js';

describe('New E2E Test', () => {
  let skip: boolean;
  let project: TestProject;

  beforeAll(async () => {
    skip = await skipIfPrerequisitesNotMet();
    if (skip) return;
    project = createTestProject({ personas: [...], features: [...], mappings: [...] });
  });

  afterAll(() => { project?.cleanup(); });

  it('should test with real Claude', async () => {
    if (skip) return;
    // Use runFeedbackAgent to spawn real session...
  });
});
```
