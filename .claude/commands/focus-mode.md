<!-- HOOK:GENTYR:focus-mode -->
# /focus-mode - Toggle Focus Mode

Blocks ALL automated agent spawning except CTO-directed work, persistent task monitors,
and session revivals. Use when you want to dedicate all queue slots and API quota to
specific tasks without background automation interfering.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Step 1: Check Current Focus Mode State

Read the focus mode state file directly:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'state', 'focus-mode.json');
try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(JSON.stringify(state));
} catch {
  console.log(JSON.stringify({ enabled: false }));
}
"
```

Parse the JSON output:
- `enabled: true` → focus mode is currently **ENABLED**
- `enabled: false` or file missing → focus mode is currently **DISABLED**

## Step 2: Toggle to Opposite State

Based on the current state, toggle to the opposite:

- If currently **ENABLED** → write `{ "enabled": false, ... }`
- If currently **DISABLED** → write `{ "enabled": true, ... }`

Run the toggle:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'state', 'focus-mode.json');
const dir = path.dirname(statePath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
let current = { enabled: false };
try { current = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
const newEnabled = !current.enabled;
const newState = { enabled: newEnabled, enabledAt: new Date().toISOString(), enabledBy: 'cto' };
fs.writeFileSync(statePath, JSON.stringify(newState, null, 2));
console.log(JSON.stringify(newState));
"
```

## Step 3: Show Result

Display the new state clearly:

**If focus mode is now ENABLED:**
```
Focus mode: ENABLED

ALLOWED (will still spawn):
  - CTO-priority sessions (priority: cto or critical)
  - Persistent task monitors (lane: persistent)
  - Session revivals (lane: revival)
  - Task gate agents (lane: gate)
  - Manual CTO spawns via /spawn-tasks (source: force-spawn-tasks)
  - Persistent task spawner (source: persistent-task-spawner)
  - Inline session revival (source: stop-continue-hook)
  - Dead monitor revival (source: session-queue-reaper)
  - Children of persistent tasks (metadata.persistentTaskId set)

BLOCKED (will be rejected at enqueue):
  - Hourly automation task runners
  - Demo failure repair agents
  - AI feedback agents
  - Antipattern hunters
  - Compliance checkers
  - Lint fixers
  - CLAUDE.md refactors
  - Alert escalation agents
  - Plan executors
  - Workstream managers
  - All other background automation

Run /focus-mode again to disable.
```

**If focus mode is now DISABLED:**
```
Focus mode: DISABLED

All automated agent spawning is now unrestricted.
Background automation will resume on the next hourly cycle.
```
