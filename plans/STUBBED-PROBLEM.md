# STUBBED-PROBLEM: Feedback E2E Tests Are Not Actually E2E

## Summary

The file `tests/integration/feedback-e2e.test.ts` claims to be "True E2E Tests" but the feedback pipeline itself — persona selection, agent sessions, MCP tool calls, audit trail — is entirely stubbed. The toy app HTTP/CLI tests are genuine, but everything between "changed files detected" and "findings appear in agent-reports" is faked with direct DB inserts.

---

## System Architecture Overview

### The AI User Feedback System

GENTYR's feedback system simulates real users testing a product. The intended production flow is:

```
Changed files pushed to staging
    ↓
Orchestrator (hourly-automation.js) detects changes
    ↓
user-feedback MCP server: get_personas_for_changes(changed_files)
    → Matches file paths against feature patterns (glob matching)
    → Returns which personas should test
    ↓
user-feedback MCP server: start_feedback_run(trigger_type, changed_files)
    → Creates feedback_runs record
    → Creates feedback_sessions records (one per triggered persona)
    ↓
feedback-launcher.js: For each persona session:
    → Reads persona details from user-feedback.db
    → Generates temporary MCP config (feedback-mcp.json) with ONLY:
        - programmatic-feedback OR playwright-feedback (based on consumption_mode)
        - feedback-reporter (always included)
    → Builds persona-specific prompt (behavioral traits, test scenarios)
    → Spawns isolated Claude session with --strict-mcp-config
    → Passes FEEDBACK_SESSION_ID and FEEDBACK_PERSONA_NAME as env vars
    ↓
Claude agent (isolated session) acts as the persona:
    → Uses programmatic-feedback MCP to call api_request / cli_run / page_navigate
    → Discovers bugs through real interaction
    → Uses feedback-reporter MCP to call submit_finding for each bug
    → Calls submit_summary when done
    ↓
AuditedMcpServer (wrapping each MCP server):
    → Logs every tool call to session-events.db
    → Records: tool name, args, result, duration_ms, mcp_server name
    ↓
feedback-reporter MCP server:
    → Stores findings in per-session DB (.claude/feedback-sessions/{session_id}.db)
    → Forwards each finding as a report to agent-reports DB (.claude/cto-reports.db)
    ↓
user-feedback MCP server: complete_feedback_session(session_id, status)
    → Updates session status, findings count, report IDs
    ↓
Deputy-CTO triages reports via agent-reports MCP server
```

### Key Components

#### MCP Servers (packages/mcp-servers/src/)

| Server | Purpose | File |
|--------|---------|------|
| **user-feedback** | Manages personas, features, mappings, runs, sessions. The orchestration brain. | `user-feedback/server.ts` |
| **programmatic-feedback** | Provides `api_request` and `cli_run` tools for API/CLI personas | `programmatic-feedback/server.ts` |
| **playwright-feedback** | Provides browser automation tools for GUI personas | `playwright-feedback/server.ts` |
| **feedback-reporter** | Provides `submit_finding`, `submit_summary`, `list_findings` tools | `feedback-reporter/server.ts` |
| **session-events** | Reads/queries the session-events.db audit trail | `session-events/server.ts` |
| **agent-reports** | Deputy-CTO triage queue for all agent-submitted reports | `agent-reports/server.ts` |

#### Shared Infrastructure

| Component | Purpose | File |
|-----------|---------|------|
| **McpServer** | Base class for all MCP servers. JSON-RPC 2.0 over stdio. | `shared/server.ts` |
| **AuditedMcpServer** | Subclass that wraps every tool handler with audit logging. Mandatory for feedback servers. | `shared/audited-server.ts` |

#### Databases

| Database | Location | Purpose |
|----------|----------|---------|
| user-feedback.db | `.claude/user-feedback.db` | Personas, features, mappings, runs, sessions |
| cto-reports.db | `.claude/cto-reports.db` | Agent-reports triage queue |
| session-events.db | `.claude/session-events.db` | MCP tool call audit trail |
| {session_id}.db | `.claude/feedback-sessions/{id}.db` | Per-session findings + summary |

#### Feedback Launcher

| File | Purpose |
|------|---------|
| `.claude/hooks/feedback-launcher.js` | Generates isolated MCP configs, builds persona prompts, spawns Claude sessions |
| `scripts/feedback-launcher.js` | Same file, symlinked for direct execution |

### Personas and Consumption Modes

Each persona has a `consumption_mode` that determines which MCP server it gets:

| Mode | MCP Server | Tools Available |
|------|-----------|-----------------|
| `gui` | playwright-feedback | page_navigate, page_click, page_type, page_snapshot, etc. |
| `api` | programmatic-feedback (api mode) | api_request |
| `cli` | programmatic-feedback (cli mode) | cli_run |
| `sdk` | programmatic-feedback (sdk mode) | sdk_call |

All modes also get `feedback-reporter` for `submit_finding` and `submit_summary`.

### The Toy App (Test Target)

Located at `tests/fixtures/toy-app/`. A single-file HTTP server with:

- **server.js**: HTTP server with web UI, REST API, SQLite DB
- **cli.js**: CLI that calls the REST API

Seed data: 1 user (admin/admin123), 2 tasks ("Buy groceries", "Write documentation")

5 intentional bugs planted:

| # | Bug | Interface | Severity |
|---|-----|-----------|----------|
| 1 | Login shows no error on wrong password (just redirects back) | GUI | Medium |
| 2 | No confirmation dialog before deleting tasks | GUI | Low |
| 3 | Broken "Privacy Policy" link on Settings page | GUI | Low |
| 4 | POST /api/tasks returns 200 instead of 201 | API | Medium |
| 5 | No --help flag (treated as unknown command) | CLI | Low |

---

## What The Current E2E Tests Actually Do

### Test File: `tests/integration/feedback-e2e.test.ts` (12 tests)

#### Setup: Toy App Startup (REAL)

```
beforeAll: startToyApp()
  → spawn('node', ['tests/fixtures/toy-app/server.js'], { env: { PORT: '0' } })
  → toy app logs: "Toy app running at http://localhost:{port}/"
  → test captures the free port
```

This is genuine. A real HTTP server starts with a real SQLite DB.

#### Test 1: "should list tasks via real API" (REAL)

```
fetch(baseUrl + '/api/tasks')
  → Real HTTP request to real server
  → Checks response.status === 200
  → Parses JSON, checks seed data: "Buy groceries", "Write documentation"
```

Genuinely tests the toy app API.

#### Test 2: "should discover Bug #4: wrong status code" (REAL)

```
fetch(baseUrl + '/api/tasks', { method: 'POST', body: { title: 'Test task' } })
  → Real HTTP request
  → Asserts response.status === 200 (the bug)
  → Asserts response.status !== 201 (what it should be)
```

Genuinely confirms Bug #4 exists via real HTTP.

#### Test 3: "should submit API findings and verify in agent-reports" (PARTIALLY STUBBED)

```
Step 1: Create persona/feature/mapping → DIRECT DB INSERT (not MCP)
  createPersona(feedbackDb, { name: 'api-consumer', consumption_mode: 'api' })
  registerFeature(feedbackDb, { name: 'task-api', file_patterns: ['src/api/**', 'server.js'] })
  mapPersonaToFeature(feedbackDb, { ... })
  ^ These are local helper functions that INSERT INTO in-memory SQLite.
  ^ No MCP call to create_persona, register_feature, or map_persona_feature.

Step 2: Real API call → REAL
  fetch(baseUrl + '/api/tasks', { method: 'POST', body: { title: 'E2E finding test' } })
  expect(createResponse.status).toBe(200) // Bug confirmed

Step 3: Submit finding → STUBBED
  simulateFeedbackSession(sessionDb, reportsDb, 'api-consumer', [{
    title: 'POST /api/tasks returns 200 instead of 201',
    category: 'functionality',
    severity: 'medium',
    description: '...',
    steps_to_reproduce: [...],
  }])
  ^ This is a stub from tests/integration/mocks/feedback-agent-stub.ts
  ^ It directly INSERT INTO findings and INSERT INTO reports
  ^ No MCP server started, no JSON-RPC, no tool handler called
  ^ No AuditedMcpServer wrapping, no audit trail generated

Step 4: Verify reports → CHECKS STUB OUTPUT
  reportsDb.prepare('SELECT * FROM reports').all()
  ^ Verifies the stub's direct inserts exist
```

#### Tests 4-6: CLI Persona Flow (REAL CLI, STUBBED FINDINGS)

```
Test 4: execFile('node', [cli.js, 'tasks', 'list', '--api-url=...'])
  → Real CLI subprocess, real HTTP to toy app
  → Checks stdout contains "Tasks:" and "Buy groceries"

Test 5: execFile('node', [cli.js, 'tasks', 'create', '--title=...'])
  → Real CLI, creates task via API
  → Then completes it via CLI
  → Real subprocess execution throughout

Test 6: execFile('node', [cli.js, '--help'])
  → Real CLI, confirms Bug #5 (exits with "Unknown command: --help")

Test 7: simulateFeedbackSession(sessionDb, reportsDb, 'cli-expert', [{
    title: 'CLI has no --help flag', ...
  }])
  → Same stub pattern. Direct DB insert. No MCP.
```

#### Test 8: "Multi-Persona Run" (MOSTLY STUBBED)

This is the "big" test. Here's every action:

```
Step 1: Setup personas and features → DIRECT DB INSERT
  createPersona(db, { name: 'api-tester', consumption_mode: 'api' })
  createPersona(db, { name: 'cli-tester', consumption_mode: 'cli' })
  registerFeature(db, { name: 'rest-api', file_patterns: ['src/api/**', 'server.js'] })
  registerFeature(db, { name: 'cli-interface', file_patterns: ['cli.js', 'src/cli/**'] })
  mapPersonaToFeature(db, { api-tester → rest-api })
  mapPersonaToFeature(db, { cli-tester → cli-interface })
  ^ All local helper functions, no MCP

Step 2: Persona selection → LOCAL RE-IMPLEMENTATION
  getPersonasForChanges(feedbackDb, ['server.js', 'cli.js'])
  ^ This is a function defined IN THE TEST FILE (lines 152-198)
  ^ It re-implements the glob matching + SQL join logic from user-feedback/server.ts
  ^ Not called through MCP. No JSON-RPC. No audit trail of this decision.
  ^ Result: api-tester matches (server.js), cli-tester matches (cli.js)

Step 3: Start feedback run → LOCAL RE-IMPLEMENTATION
  startFeedbackRun(feedbackDb, { trigger_type: 'staging-push', trigger_ref: 'abc123', changed_files })
  ^ Also defined in the test file (lines 201-224)
  ^ Directly inserts into feedback_runs and feedback_sessions tables
  ^ Not called through MCP

Step 4: API persona session → ONE REAL CALL + STUB
  fetch(baseUrl + '/api/tasks', { method: 'POST', body: ... })
  ^ ONE real HTTP call to confirm Bug #4

  simulateFeedbackSession(apiSessionDb, reportsDb, 'api-tester', [{
    title: 'Wrong HTTP status code on POST /api/tasks',
    severity: 'medium',
    description: 'Returns 200 instead of 201',
  }])
  ^ STUB: Direct DB insert of hardcoded finding
  ^ No Claude agent spawned
  ^ No api_request tool handler called
  ^ No submit_finding tool handler called
  ^ No AuditedMcpServer logging
  ^ The test author pre-determined this bug would be "found"

Step 5: CLI persona session → PURE STUB
  simulateFeedbackSession(cliSessionDb, reportsDb, 'cli-tester', [{
    title: 'No --help flag',
    severity: 'low',
  }])
  ^ No CLI execution at all in this step
  ^ Direct DB insert of hardcoded finding

Step 6: Manual status updates → DIRECT SQL
  feedbackDb.prepare("UPDATE feedback_sessions SET status = 'completed'...").run(...)
  feedbackDb.prepare("UPDATE feedback_runs SET status = 'completed'...").run(...)
  ^ Not MCP calls to complete_feedback_session

Step 7: Verification → CHECKS STUB OUTPUT
  SELECT * FROM reports → 2 reports exist (because stub inserted them)
  SELECT * FROM feedback_sessions → both completed (because we UPDATE'd them)
```

#### Tests 9-12: "Audit Trail Verification" (FULLY STUBBED)

```
recordAuditEvent(eventsDb, {
  session_id: ...,
  persona_name: 'api-auditor',
  tool_name: 'api_request',
  tool_args: { method: 'GET', path: '/api/tasks' },
  result: { status: 200, body: { tasks: [...] } },
  duration_ms: 45,
  mcp_server: 'programmatic-feedback',
})
^ recordAuditEvent is a LOCAL HELPER (line 227) that directly INSERT INTO session_events
^ Does NOT go through AuditedMcpServer
^ Does NOT start any MCP server process
^ The test then queries the same DB and verifies the rows it just inserted
```

---

## What The Stub Actually Does

The `simulateFeedbackSession` function from `tests/integration/mocks/feedback-agent-stub.ts`:

1. Creates `findings` and `session_summary` tables in an empty in-memory DB
2. For each finding in the hardcoded array:
   - `INSERT INTO findings (id, title, category, severity, ...)` in session DB
   - Builds a summary string
   - `INSERT INTO reports (id, reporting_agent, title, summary, category, priority, ...)` in reports DB
3. If a summary is provided, inserts into `session_summary` and `reports`
4. Returns the generated IDs

It mirrors the logic of `feedback-reporter/server.ts`'s `submitFinding` and `submitSummary` functions, but bypasses:
- MCP server process lifecycle
- JSON-RPC protocol
- Zod schema validation
- AuditedMcpServer audit logging
- Tool handler wrapping
- Error handling paths in the real handlers

---

## What IS Genuinely Tested

| Component | Tested? | How? |
|-----------|---------|------|
| Toy app HTTP server | Yes | Real `fetch()` calls |
| Toy app REST API (CRUD) | Yes | Real HTTP requests |
| Toy app CLI | Yes | Real `execFile()` subprocess |
| Bug #4 (200 vs 201) | Yes | Real HTTP response code |
| Bug #5 (no --help) | Yes | Real CLI execution |
| SQLite schema correctness | Yes | In-memory DB operations |
| severity → priority mapping | Yes | Via stub logic |
| Glob pattern matching | Yes | Via local reimplementation |
| AuditedMcpServer middleware | Yes, **but only in unit tests** | 16 tests in `shared/__tests__/audited-server.test.ts` |
| get_session_audit tool | Yes, **but only in unit tests** | 13 tests in `user-feedback/__tests__/user-feedback.test.ts` |
| All MCP tool handlers individually | Yes, **but only in unit tests** | ~500 unit tests across all servers |

## What Is NOT Tested At All

| Component | Gap |
|-----------|-----|
| Claude agent spawning | No agent is ever spawned in any test |
| Persona prompt generation | `buildPrompt()` in feedback-launcher never called |
| MCP server process lifecycle | No MCP server process started in E2E |
| JSON-RPC protocol in E2E context | No JSON-RPC messages sent |
| Real tool handler execution in E2E (api_request, cli_run) | Handler functions never called |
| Real submit_finding through MCP pipeline | Never called through MCP |
| AuditedMcpServer in E2E context | Not exercised (only in unit tests) |
| get_session_audit in E2E context | Never called through MCP |
| Feedback launcher end-to-end | Never called |
| Real persona selection decision | Pre-determined by test author |
| Agent actually discovering bugs | Findings are hardcoded |
| Claude session transcript audit | No transcript exists |
| Orchestrator → launcher → agent chain | Not tested |
| MCP config generation + isolation | `generateMcpConfig()` never called in tests |
| Cross-server audit trail (events from multiple MCP servers in one session) | Only stubbed |
| Error propagation from tool handler → audit → report | Not tested end-to-end |

---

## The Path to Real E2E Tests

### Option A: Handler-Level E2E (No Claude, Achievable)

Import and call real MCP tool handler functions directly, without going through JSON-RPC or spawning Claude. This tests the actual code paths:

```ts
// Import REAL handlers
import { apiRequest } from 'programmatic-feedback/server';
import { submitFinding } from 'feedback-reporter/server';
import { startFeedbackRun, getPersonasForChanges, completeFeedbackSession } from 'user-feedback/server';

// Call real handlers with real DBs pointed at toy app
const tasks = apiRequest({ method: 'GET', path: '/api/tasks' });
const create = apiRequest({ method: 'POST', path: '/api/tasks', body: { title: 'test' } });

// Agent "discovers" bug via real HTTP response
if (create.status === 200) {
  submitFinding({ title: 'Wrong status code', category: 'functionality', ... });
}
```

This would exercise: real handlers → real Zod validation → real DB writes → real AuditedMcpServer audit logging → real session-events.db entries → queryable via real `get_session_audit`.

**Challenge:** The server files (programmatic-feedback/server.ts, feedback-reporter/server.ts) are structured as top-level scripts that read env vars and call `server.start()` at module level. The handler functions are not exported separately — they're defined as local functions passed to the server constructor. To import handlers directly, we'd need to either:
1. Extract handler functions into separate exportable modules
2. Or instantiate the server objects in test context with appropriate env vars

### Option B: JSON-RPC Level E2E (No Claude, More Complete)

Start real MCP server processes, send JSON-RPC messages through stdin, read responses from stdout. This tests the full protocol layer:

```ts
const server = spawn('node', ['dist/programmatic-feedback/server.js'], {
  env: { FEEDBACK_MODE: 'api', FEEDBACK_API_BASE_URL: toyApp.baseUrl, FEEDBACK_SESSION_ID: sessionId, ... }
});

// Send JSON-RPC tool call
server.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'api_request', arguments: { method: 'GET', path: '/api/tasks' } }
}));

// Read JSON-RPC response from stdout
```

**Challenge:** More complex setup, process lifecycle management, but tests the full MCP protocol including AuditedMcpServer wrapping.

### Option C: Full Agent E2E (With Claude, Expensive)

Actually spawn Claude sessions via the feedback-launcher with real personas. Non-deterministic, requires API credits, but tests the complete chain including whether the agent actually discovers bugs.

This is what happens in production. Not suitable for CI but valuable as a manual smoke test.

---

## Architecture Details for Planning

### File Structure

```
packages/mcp-servers/src/
  shared/
    server.ts              # McpServer base class (handleToolCall is protected)
    audited-server.ts      # AuditedMcpServer subclass (mandatory audit)
    __tests__/
      server.test.ts       # 29 unit tests
      audited-server.test.ts # 16 unit tests
  user-feedback/
    server.ts              # Persona/feature/run/session management (1100+ lines)
    types.ts               # Zod schemas + TypeScript types
    __tests__/
      user-feedback.test.ts # 56 unit tests (includes 13 for get_session_audit)
  programmatic-feedback/
    server.ts              # api_request, cli_run tools
    types.ts
    __tests__/
      programmatic-feedback.test.ts # 47 unit tests
  playwright-feedback/
    server.ts              # Browser automation tools
    types.ts
    __tests__/
      playwright-feedback.test.ts # 34 unit tests
  feedback-reporter/
    server.ts              # submit_finding, submit_summary, list_findings
    types.ts
    __tests__/
      feedback-reporter.test.ts # 21 unit tests

tests/
  integration/
    feedback-e2e.test.ts   # THE FILE IN QUESTION (12 tests, largely stubbed)
    feedback-pipeline.test.ts # Older pipeline tests (also stubbed, 9 tests)
    helpers/
      toy-app-runner.ts    # Starts/stops toy app on free port
    mocks/
      feedback-agent-stub.ts # simulateFeedbackSession stub
  fixtures/
    toy-app/
      server.js            # HTTP server with 5 bugs
      cli.js               # CLI that calls REST API

.claude/hooks/
  feedback-launcher.js     # Spawns isolated Claude sessions per persona
```

### Handler Function Accessibility

The handler functions in each server are **local functions**, not exported:

```ts
// In programmatic-feedback/server.ts:
function apiRequest(args: ApiRequestArgs): ApiRequestResult | ErrorResult { ... }
function cliRun(args: CliRunArgs): CliRunResult | ErrorResult { ... }

// These are passed to the server constructor:
const tools: AnyToolHandler[] = [
  { name: 'api_request', schema: ApiRequestArgsSchema, handler: apiRequest },
  { name: 'cli_run', schema: CliRunArgsSchema, handler: cliRun },
];

const server = new AuditedMcpServer({ name: 'programmatic-feedback', tools });
server.start(); // Begins reading stdin for JSON-RPC
```

To test handlers directly, they'd need to be exported. Currently, the only way to call them is through the JSON-RPC protocol (send a `tools/call` message to the server's stdin).

### AuditedMcpServer Contract

- **Mandatory**: Throws if no session ID provided
- **Wraps handlers in constructor**: Each tool handler is wrapped with timing + audit logging before being passed to `super()`
- **Writes to session-events.db**: Same schema as session-events MCP server
- **Non-fatal audit failures**: If the audit DB write fails, the tool still returns its result (logs error to stderr)
- **Test overrides**: `auditDbPath`, `auditSessionId`, `auditPersonaName` options for test isolation

### Current Test Counts

| Suite | Tests |
|-------|-------|
| Unit tests (packages/mcp-servers) | ~504 |
| AuditedMcpServer unit tests | 16 |
| get_session_audit unit tests | 13 |
| "E2E" tests (feedback-e2e.test.ts) | 12 |
| Pipeline tests (feedback-pipeline.test.ts) | 9 |
| **Total** | **~541** |

All passing. TypeScript build clean.
