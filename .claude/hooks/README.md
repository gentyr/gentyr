# Claude Code Hooks

This directory contains automation hooks that extend Claude Code functionality.

## Hook Types by Trigger Event

### SessionStart

#### `api-key-watcher.js`
**Purpose**: Track multiple Claude API keys and auto-rotate based on usage

**Behavior**:
1. Reads current credentials from `~/.claude/.credentials.json`
2. Captures new keys when users log in with different accounts
3. Runs health checks on all tracked keys via Anthropic Usage API
4. Applies rotation logic based on usage thresholds
5. Updates credentials file if switching to a different key

**Rotation Logic**:
- Switch at 90% usage (any bucket) if a lower-usage key is available
- At 100% usage, switch to any usable key
- When all keys are above 90%, stick with current until 100%

**Storage Files**:
- `.claude/api-key-rotation.json` - Tracked keys and state
- `.claude/api-key-rotation.log` - Human-readable event log

**Data Schema** (`api-key-rotation.json`):
```json
{
  "version": 1,
  "active_key_id": "a1b2c3d4e5f6g7h8",
  "keys": {
    "a1b2c3d4e5f6g7h8": {
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1769059870151,
      "subscriptionType": "max",
      "rateLimitTier": "default_claude_max_20x",
      "added_at": 1705853100000,
      "last_used_at": 1705853200000,
      "last_health_check": 1705853300000,
      "last_usage": {
        "five_hour": 0.45,
        "seven_day": 0.30,
        "seven_day_sonnet": 0.25,
        "checked_at": 1705853300000
      },
      "status": "active"
    }
  },
  "rotation_log": [
    {
      "timestamp": 1705853300000,
      "event": "key_switched",
      "key_id": "a1b2c3d4e5f6g7h8",
      "reason": "initial_selection",
      "usage_snapshot": { "five_hour": 0.45, "seven_day": 0.30, "seven_day_sonnet": 0.25 }
    }
  ]
}
```

**CTO Report Integration**: Multi-key status visible in `/cto-report`:
```json
{
  "key_rotation": {
    "active_key_id": "a1b2c3d4...",
    "total_keys": 2,
    "usable_keys": 2,
    "keys": [...],
    "rotation_events_24h": 1
  }
}
```

---

### UserPromptSubmit

Hooks that run when the user submits a message in the chat.

#### `cto-notification-hook.js`
**Purpose**: Display CTO status report at session start

#### `bypass-approval-hook.js`
**Purpose**: Process CTO bypass approvals

**Trigger Pattern**: Message matches `APPROVE BYPASS <6-char-code>`

**Behavior**:
1. Parse user message for approval pattern
2. Validate code exists in pending bypass requests (deputy-cto.db)
3. Write approval token to `.claude/bypass-approval-token.json`
4. Token expires after 5 minutes

**Security Model**:
- Agents cannot trigger UserPromptSubmit hooks (only real user input triggers them)
- Agents cannot forge approval tokens without user typing the approval phrase
- Each bypass code is unique and tied to a specific request

**Token Format**:
```json
{
  "code": "X7K9M2",
  "request_id": "uuid",
  "user_message": "APPROVE BYPASS X7K9M2",
  "created_at": "2024-01-22T10:00:00Z",
  "expires_at": "2024-01-22T10:05:00Z",
  "expires_timestamp": 1705920300000
}
```

**Output Format** (cto-notification-hook):
```
Quota: 5-hour █░░░░░░░ 8% (resets 3h) | 7-day ████░░░░ 51% (resets 2d)
Usage: 1.2M tokens (24h) | 5 hook / 3 user sessions | 4 tasks | Deputy: ON
Pending: 2 CTO decision(s), 5 unread report(s)
```

**Data Sources**:
- Anthropic API for quota (`~/.claude/.credentials.json`)
- Session JSONL files for token usage
- `agent-tracker-history.json` for session counts
- `todo.db` for task counts
- `deputy-cto.db` for pending items
- `autonomous-mode.json` for deputy status

---

#### `todo-maintenance.js`
**Purpose**: Auto-process pending TODO items

**Behavior**:
1. Checks for pending tasks in `todo.db`
2. If pending > 0 and cooldown passed (15 min):
   - Spawns `todo-processing` agent
   - Registers with `agent-tracker.js`
3. Skips if `CLAUDE_SPAWNED_SESSION=true` (prevents chain reactions)

**State File**: `todo-maintenance-state.json`
```json
{ "lastSpawn": 1705853100000 }
```

---

### Pre-Commit (git commit)

#### `pre-commit-review.js`
**Purpose**: Deputy-CTO reviews all commits

**Flow**:
```
git commit
    ↓
pre-commit-review.js
    ↓
Check for pending rejections → BLOCK if any
    ↓
Get staged diff
    ↓
Spawn deputy-cto agent
    ↓
Wait for decision (30 min timeout)
    ↓
APPROVE (exit 0) or REJECT (exit 1)
```

**G001 Compliance**: Fails closed on any error

**Success/Failure Measurement**:
- **Success (exit 0)**: Deputy-CTO called `approve_commit` MCP tool
- **Failure (exit 1)**: Deputy-CTO called `reject_commit` OR timed out OR error occurred
- Decision is stored in `deputy-cto.db` `commit_decisions` table

**Emergency Bypass** (requires CTO approval):

The `SKIP_DEPUTY_CTO_REVIEW` env var bypass has been removed. To bypass commit blocking:

1. Agent calls `mcp__deputy-cto__request_bypass()` → Gets code like `X7K9M2`
2. Agent asks CTO: "Please type: APPROVE BYPASS X7K9M2"
3. **CTO types in chat**: `APPROVE BYPASS X7K9M2`
4. `bypass-approval-hook.js` creates approval token
5. Agent calls `mcp__deputy-cto__execute_bypass({ bypass_code: "X7K9M2" })`
6. Commit proceeds

This ensures only the CTO (human user) can approve bypasses - agents cannot trigger UserPromptSubmit hooks.

---

### Post-Commit (after git commit)

#### `antipattern-hunter-hook.js`
**Purpose**: Find spec violations in committed code

**Behavior**:
1. Check 6-hour cooldown
2. If cooldown passed, spawn `antipattern-hunter` agent
3. Fire-and-forget (non-blocking)

**State File**: `antipattern-hunter-state.json`

---

### Stop Event

#### `stop-continue-hook.js`
**Purpose**: Force continuation for spawned task sessions

**Behavior**:
- For spawned sessions starting with `[Task]`:
  - First stop: Force one continuation cycle
  - Subsequent stops: Allow normal stop

---

### Schema Mapping (Federation)

#### `schema-mapper-hook.js`
**Purpose**: Generate schema mappings for unknown data structures

**Trigger**: Called programmatically when federated search encounters unknown schema

**Note**: This is a project-specific hook (included in x_test) that requires the `federation-mapper` agent, which is NOT part of the framework. Projects using this hook must define the agent in their `.claude/agents/` directory.

**Behavior**:
1. Check 24-hour cooldown per schema
2. Spawn `federation-mapper` agent
3. Generate TypeScript mapping function
4. Queue for human review if confidence < 70%

---

### Compliance Checking

#### `compliance-checker.js`
**Purpose**: Enforce global and local specifications

**Modes**:
- `--global` - Check all files against global specs
- `--local` - Check specific files against local specs
- `--mapping` - Validate spec-file mappings

**Cooldown**: 7 days per file

---

### Hourly Automation

#### `hourly-automation.js`
**Purpose**: Wrapper for hourly systemd/launchd service

**Tasks (with independent cooldowns)**:

1. **Report Triage** (5-minute check interval, 1-hour per-item cooldown)
   - Checks for untriaged CTO reports in `agent-reports.db`
   - Per-item cooldown: if triage fails, that item won't be retried for 1 hour
   - Spawns deputy-cto agent to triage reports
   - Triage actions: `auto-acknowledged`, `escalated`, `needs-cto-review`

2. **Plan Executor** (55-minute cooldown, via `plan-executor.js`)
   - Studies PLAN.md and `/plans`
   - Spawns agent workflow for pending plans

3. **CLAUDE.md Refactor** (55-minute cooldown)
   - Triggers if CLAUDE.md > 25K characters
   - Moves content to sub-files

**Enable/Disable**: Via `autonomous-mode.json` or MCP tool

---

## Shared Modules

### `agent-tracker.js`
**Purpose**: Track all spawned agents

**Exports**:
```javascript
import { registerSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';

const agentId = registerSpawn({
  type: AGENT_TYPES.TODO_PROCESSING,
  hookType: HOOK_TYPES.TODO_MAINTENANCE,
  description: 'Processing 5 pending items',
  prompt: promptText,
  metadata: { ... }
});
```

**Agent Types**:
```javascript
AGENT_TYPES = {
  TODO_PROCESSING: 'todo-processing',
  TODO_SYNTAX_FIX: 'todo-syntax-fix',
  COMPLIANCE_GLOBAL: 'compliance-global',
  COMPLIANCE_LOCAL: 'compliance-local',
  COMPLIANCE_MAPPING_FIX: 'compliance-mapping-fix',
  COMPLIANCE_MAPPING_REVIEW: 'compliance-mapping-review',
  TEST_FAILURE_JEST: 'test-failure-jest',
  TEST_FAILURE_PLAYWRIGHT: 'test-failure-playwright',
  ANTIPATTERN_HUNTER: 'antipattern-hunter',
  FEDERATION_MAPPER: 'federation-mapper',
  DEPUTY_CTO_REVIEW: 'deputy-cto-review',
  PLAN_EXECUTOR: 'plan-executor',
  CLAUDEMD_REFACTOR: 'claudemd-refactor'
}
```

**Hook Types**:
```javascript
HOOK_TYPES = {
  TODO_MAINTENANCE: 'todo-maintenance',
  COMPLIANCE_CHECKER: 'compliance-checker',
  JEST_REPORTER: 'jest-reporter',
  PLAYWRIGHT_REPORTER: 'playwright-reporter',
  ANTIPATTERN_HUNTER: 'antipattern-hunter',
  SCHEMA_MAPPER: 'schema-mapper',
  PRE_COMMIT_REVIEW: 'pre-commit-review',
  PLAN_EXECUTOR: 'plan-executor',
  HOURLY_AUTOMATION: 'hourly-automation'
}
```

---

### `mapping-validator.js`
**Purpose**: Validate spec-file-mappings.json

---

## Prompt Files

### `prompts/`
- `local-spec-enforcement.md` - Local compliance checking
- `mapping-fix.md` - Mapping file fixes
- `mapping-review.md` - Mapping review
- `schema-mapper.md` - Federation schema mapping

### Root Level
- `todo-processing-prompt.md` - TODO item processing
- `test-failure-prompt.md` - Test failure handling

---

## State Management

Each hook maintains its own state file:

| Hook | State File | Contents |
|------|------------|----------|
| TODO Maintenance | `todo-maintenance-state.json` | `{ lastSpawn }` |
| Antipattern Hunter | `antipattern-hunter-state.json` | `{ lastRun }` |
| Compliance | `compliance-state.json` | Per-file timestamps |
| Schema Mapper | (in DB) | Per-schema cooldowns |
| Hourly Automation | `hourly-automation-state.json` | `{ lastRun, lastClaudeMdRefactor, lastTriageCheck, triageAttempts }` |

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CLAUDE_PROJECT_DIR` | Project root directory |
| `CLAUDE_SPAWNED_SESSION` | Set to `"true"` for spawned sessions |
| `CLAUDE_AGENT_ID` | Agent ID from tracker |
| `COMPLIANCE_MODE` | Current compliance mode |

Note: `SKIP_DEPUTY_CTO_REVIEW` has been removed. See "Framework Protection" section.

---

## Adding a New Hook

1. **Create the hook script** in this directory:
   ```javascript
   #!/usr/bin/env node
   import { registerSpawn, AGENT_TYPES, HOOK_TYPES } from './agent-tracker.js';
   // ... hook logic
   ```

2. **Add agent/hook types** to `agent-tracker.js`:
   ```javascript
   AGENT_TYPES.MY_NEW_AGENT = 'my-new-agent';
   HOOK_TYPES.MY_NEW_HOOK = 'my-new-hook';
   ```

3. **Register in settings.json**:
   ```json
   {
     "hooks": {
       "UserPromptSubmit": ["node .claude/hooks/my-hook.js"]
     }
   }
   ```

4. **Update MCP server types** in `packages/mcp-servers/src/agent-tracker/types.ts`

5. **Rebuild MCP servers**:
   ```bash
   cd packages/mcp-servers && npm run build
   ```

---

## Testing

### Pre-Commit Review Tests
```bash
node --test .claude/hooks/__tests__/pre-commit-review.test.js
```

See `__tests__/README.md` for details.

---

## Debugging

### View Hook Logs
```bash
# Todo maintenance
tail -f .claude/hooks/todo-maintenance-debug.log

# Stop/continue hook
tail -f .claude/hooks/stop-hook-debug.log

# Hourly automation
tail -f .claude/hourly-automation.log
```

### Check Agent History
```bash
cat .claude/hooks/agent-tracker-history.json | jq '.agents | length'
cat .claude/hooks/agent-tracker-history.json | jq '.agents[-1]'
```

### Check State Files
```bash
cat .claude/hooks/todo-maintenance-state.json
cat .claude/hooks/antipattern-hunter-state.json
```

---

## Technical Notes

### Capturing Claude CLI Output

When spawning Claude CLI with `stdio: 'pipe'` in Node.js, use `--output-format json` or `--output-format stream-json` to capture output:

```javascript
// Use --output-format json for structured output via pipes
const claude = spawn('claude', [
  '--dangerously-skip-permissions',
  '-p', prompt,
  '--output-format', 'json'  // or 'stream-json' for real-time streaming
], {
  cwd: PROJECT_DIR,
  stdio: 'pipe',
});

claude.stdout.on('data', (data) => {
  const result = JSON.parse(data.toString());
  console.log('Result:', result.result);
  console.log('Session ID:', result.session_id);
});
```

**Output formats**:
- `json` - Single JSON object with complete response
- `stream-json` - Real-time streaming JSON events
- `text` - Plain text (default, may not work with pipes)

**JSON output includes**:
- `result` - The assistant's response text
- `session_id` - Session ID for resuming
- `duration_ms` - Total execution time
- `total_cost_usd` - API cost
- `usage` - Token usage breakdown

**Hooks using JSON output**:
- `pre-commit-review.js` - Waits for approve/reject decision
- `plan-executor.js` - Waits for execution completion
- `hourly-automation.js` - Waits for CLAUDE.md refactor
- `schema-mapper-hook.js` - Real-time mapping output (stream-json)

**Fire-and-forget hooks** (no output capture needed):
- `todo-maintenance.js`
- `antipattern-hunter-hook.js`
- `compliance-checker.js`

### Session File Creation

All spawned Claude sessions create `.jsonl` files in `~/.claude/projects/{project-path}/`:

```bash
# List recent sessions
ls -lt ~/.claude/projects/-home-user-git-test-project/*.jsonl | head -10

# Search for specific session content
grep -l "deputy-cto agent" ~/.claude/projects/-home-user-git-test-project/*.jsonl
```

Session files are created even if the hook doesn't capture output.

---

## Framework Protection

To prevent agents from bypassing security mechanisms, critical files can be made root-owned. This is the only truly unbypassable protection since agents run as the same user and have the same file permissions.

### Protected Files

| File | Purpose |
|------|---------|
| `pre-commit-review.js` | Enforces lint + deputy-cto review |
| `bypass-approval-hook.js` | Processes CTO approval phrases |
| `eslint.config.js` | Lint rules (can't be weakened) |
| `.husky/pre-commit` | Git hook entry point |

### Setup

```bash
# Enable protection (one-time setup)
sudo ./scripts/protect-framework.sh

# Check protection status
./scripts/protect-framework.sh status

# Disable protection (to make changes)
sudo ./scripts/protect-framework.sh disable

# After making changes, re-enable
sudo ./scripts/protect-framework.sh
```

### How It Works

1. **Root ownership**: Files are owned by root with 644 permissions
2. **Agent cannot modify**: Agents run as user, not root - no sudo access
3. **Verification at commit**: Pre-commit hook warns if protection not enabled

### Bypass Flow (With Protection)

Even with protection enabled, the CTO can approve bypasses:

1. Agent calls `request_bypass()` → gets code `X7K9M2`
2. Agent asks: "Please type: APPROVE BYPASS X7K9M2"
3. CTO types in chat: `APPROVE BYPASS X7K9M2`
4. UserPromptSubmit hook creates approval token
5. Agent calls `execute_bypass()` → verifies token
6. Commit proceeds

The protection ensures:
- Agent cannot skip the approval flow
- Agent cannot modify the hooks to bypass checks
- Agent cannot weaken lint rules
- Only CTO typing the approval phrase can authorize bypasses
