<!-- HOOK:GENTYR:local-mode -->
# /local-mode - Toggle Local Prototyping Mode

Excludes all remote/deployment MCP servers (GitHub, Cloudflare, Supabase, Vercel, Render,
Codecov, Resend, Elastic, 1Password, Secret-Sync) so you can use GENTYR purely for local
prototyping without needing any external service accounts or 1Password.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Step 1: Check Current Local Mode State

Read the local mode state file directly:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'state', 'local-mode.json');
try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(JSON.stringify(state));
} catch {
  console.log(JSON.stringify({ enabled: false }));
}
"
```

Parse the JSON output:
- `enabled: true` → local mode is currently **ENABLED**
- `enabled: false` or file missing → local mode is currently **DISABLED**

## Step 2: Toggle to Opposite State

Based on the current state from Step 1:

### If currently DISABLED → Enable local mode

Enabling is unrestricted. Write the state file directly:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'state', 'local-mode.json');
const dir = path.dirname(statePath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const newState = { enabled: true, enabledAt: new Date().toISOString(), enabledBy: 'cto' };
fs.writeFileSync(statePath, JSON.stringify(newState, null, 2));
console.log(JSON.stringify(newState));
"
```

### If currently ENABLED → Disable local mode

Disabling requires CTO authorization via the Unified CTO Authorization System. Call:

```
mcp__agent-tracker__set_local_mode({ enabled: false })
```

The tool returns a deferred action ID. Ask the CTO to confirm by typing their approval.
Then call `record_cto_decision` with the CTO's verbatim text and the deferred action ID.
The system auto-executes after independent audit pass.

## Step 3: Apply MCP Server Changes

**IMPORTANT:** Toggling the state file only affects automation behavior immediately.
To add or remove remote MCP servers from `.mcp.json`, you must run:

```bash
npx gentyr sync
```

Then **restart the Claude Code session** for the MCP server changes to take effect.

## Step 4: Show Result

Display the new state clearly:

**If local mode is now ENABLED:**
```
Local mode: ENABLED

EXCLUDED (10 remote servers removed from .mcp.json after sync):
  - github, cloudflare, supabase, vercel, render
  - codecov, resend, elastic-logs, onepassword, secret-sync

STILL AVAILABLE (24 local servers):
  - agent-tracker, todo-db, deputy-cto, persistent-task, plan-orchestrator
  - playwright, chrome-bridge, user-feedback, session-activity
  - specs-browser, setup-helper, show, and all other local servers

AUTOMATION CHANGES (immediate):
  - Credential health check: skipped
  - Health monitors (staging/production): skipped
  - Promotion pipeline (preview/staging): skipped
  - Demo validation with OP secrets: skipped
  - Feedback spawning: skipped
  - Session reviver, reaper, worktree cleanup, task runner: still running

1Password is NOT required in local mode.

NEXT STEPS:
  1. Run: npx gentyr sync
  2. Restart Claude Code session
  3. Run /local-mode again to re-enable remote servers (requires CTO authorization via MCP tool)
```

**If local mode is now DISABLED:**
```
Local mode: DISABLED

All 34 MCP servers will be included in .mcp.json after sync.
Remote automation (health monitors, promotions, feedback) will resume.

NEXT STEPS:
  1. Run: npx gentyr sync
  2. Restart Claude Code session
```
