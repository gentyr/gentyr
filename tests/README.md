# GENTYR Test Suite

This directory contains integration tests and test fixtures for the GENTYR AI User Feedback System.

## Structure

```
tests/
├── fixtures/
│   └── toy-app/          # Minimal test application with intentional bugs
│       ├── server.js     # HTTP server (web UI + REST API)
│       ├── cli.js        # Command-line interface
│       └── package.json
├── integration/
│   ├── mocks/
│   │   └── feedback-agent-stub.ts  # Stub for simulating feedback agents
│   └── feedback-pipeline.test.ts   # End-to-end integration tests
└── README.md             # This file
```

## Toy Application

The toy app is a minimal Node.js application used to test the feedback system end-to-end. It includes:

- **Web UI**: Login, task dashboard, settings pages
- **REST API**: Authentication and task management endpoints
- **CLI**: Command-line task management tool
- **Intentional Bugs**: Seeded bugs for feedback agents to discover

### Intentional Bugs

The toy app contains these intentional bugs:

1. Login form shows no error on wrong password (just redirects back to login)
2. No confirmation dialog before deleting tasks
3. Settings page has a broken link to "Privacy Policy"
4. API returns 200 instead of 201 for successful task creation
5. CLI has no `--help` flag

### Running the Toy App

```bash
cd tests/fixtures/toy-app
node server.js
# Server starts on a random port (or use PORT=3000 node server.js)

# Test the CLI
node cli.js tasks list --api-url=http://localhost:PORT
node cli.js tasks create --title="New task" --api-url=http://localhost:PORT
```

Default credentials: `admin` / `admin123`

## Integration Tests

The integration tests verify the full feedback pipeline WITHOUT spawning real Claude sessions.

### Test Coverage

1. **Persona CRUD + Feature Registration Flow**
   - Create personas (GUI, CLI, API)
   - Register features with file patterns
   - Map personas to features
   - Verify `get_personas_for_changes` returns correct personas

2. **Feedback Run Lifecycle**
   - Start feedback runs with changed files
   - Create sessions for matching personas
   - Complete sessions with findings
   - Verify run status transitions (pending → in_progress → completed/partial/failed)
   - Verify `get_feedback_run_summary` aggregates correctly

3. **Feedback Reporter → Agent Reports Bridge**
   - Submit findings via feedback-reporter functions
   - Verify reports appear in agent-reports DB
   - Verify category is 'user-feedback'
   - Verify reporting_agent includes persona name
   - Verify severity-to-priority mapping

4. **Change Analysis Edge Cases**
   - No matching features → empty personas
   - Multiple features match → correct persona set
   - Disabled personas excluded
   - Feature with no mapped personas

### Running Tests

```bash
# Run all integration tests
npx vitest run tests/integration/

# Run specific test file
npx vitest run tests/integration/feedback-pipeline.test.ts

# Watch mode
npx vitest tests/integration/
```

## Feedback Agent Stub

The `feedback-agent-stub.ts` module simulates a feedback agent session by directly calling feedback-reporter functions with canned findings.

### Usage Example

```typescript
import { simulateFeedbackSession } from './mocks/feedback-agent-stub.js';

const sessionDb = createTestDb(''); // In-memory session DB
const reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);

const findings: StubFinding[] = [
  {
    title: 'Login button not responsive',
    category: 'usability',
    severity: 'high',
    description: 'The login button does not respond to clicks on mobile',
  },
];

const result = simulateFeedbackSession(
  sessionDb,
  reportsDb,
  'power-user',
  findings
);

// result.findingIds - Array of finding IDs in session DB
// result.reportIds - Array of report IDs in agent-reports DB
```

## Architecture

The integration tests verify the feedback system without spawning real Claude sessions by:

1. Creating in-memory SQLite databases for user-feedback and agent-reports
2. Calling MCP server functions directly (not via stdio)
3. Using the feedback agent stub to simulate feedback session behavior
4. Verifying data flows correctly through all components

This approach:
- ✅ Runs fast (no real Claude sessions)
- ✅ Requires no network access
- ✅ Tests the actual MCP server logic
- ✅ Provides deterministic, reproducible results
- ✅ Enables testing edge cases and error conditions

## Adding New Tests

When adding new test scenarios:

1. Create helper functions that mirror the MCP server implementations
2. Use `createTestDb` from `__testUtils__` for in-memory databases
3. Use the feedback agent stub to simulate feedback sessions
4. Verify both the feedback DB and agent-reports DB state
5. Clean up databases in `afterEach` hooks

Example:

```typescript
describe('New Feature', () => {
  let feedbackDb: Database.Database;
  let reportsDb: Database.Database;

  beforeEach(() => {
    feedbackDb = createTestDb(USER_FEEDBACK_SCHEMA);
    reportsDb = createTestDb(AGENT_REPORTS_SCHEMA);
  });

  afterEach(() => {
    feedbackDb.close();
    reportsDb.close();
  });

  it('should test new functionality', () => {
    // Test implementation
  });
});
```

## Future Enhancements

- [ ] Add E2E tests that spawn real Claude sessions
- [ ] Add performance benchmarks for feedback pipeline
- [ ] Add tests for concurrent feedback runs
- [ ] Add tests for feedback session timeout handling
- [ ] Add tests for feedback run cancellation
