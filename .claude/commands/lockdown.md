<!-- HOOK:GENTYR:lockdown -->
# /lockdown - Toggle Deputy-CTO Console Lockdown

Toggles the interactive session lockdown. When lockdown is **enabled** (default),
interactive Claude Code sessions operate as the deputy-CTO console: only read/observe
tools are available. File-editing tools (Edit, Write, NotebookEdit) and sub-agent tools
(Agent, Task) are blocked.

When lockdown is **disabled**, all tools are available and a warning is injected into
every tool call as a reminder to re-enable.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Usage

- `/lockdown` — Show current lockdown status
- `/lockdown on` — Enable the deputy-CTO lockdown (default)
- `/lockdown off` — Disable the lockdown (development/debugging only)

## Step 1: Determine the Argument

Parse the argument after `/lockdown`:
- No argument → **Status Only** mode
- `on` → **Enable** lockdown
- `off` → **Disable** lockdown
- Any other argument → Show error and print usage

## Step 2: Read Current State

Read the automation-config.json file to determine the current lockdown state:

```bash
cat .claude/state/automation-config.json 2>/dev/null || echo '{}'
```

The lockdown is **enabled** when `interactiveLockdownDisabled` is absent or `false`.
The lockdown is **disabled** when `interactiveLockdownDisabled` is `true`.

## Status Only Mode (no argument)

Display the current lockdown status clearly:

```
Deputy-CTO Console Lockdown: ENABLED

Interactive sessions operate as the deputy-CTO console.
File-editing and sub-agent tools are restricted.
Run /lockdown off to disable (development only).
```

or if disabled:

```
Deputy-CTO Console Lockdown: DISABLED (warning: non-standard)

All tools are available in interactive sessions.
A warning is injected on every tool call as a reminder.
Run /lockdown on to re-enable standard GENTYR workflow.
```

Stop after displaying status.

## Enable Lockdown (/lockdown on)

1. Read current config:
   ```bash
   cat .claude/state/automation-config.json 2>/dev/null || echo '{}'
   ```

2. Write updated config with `interactiveLockdownDisabled` set to `false` (or removed).
   Use Bash to update the file:
   ```bash
   node -e "
   const fs = require('fs');
   const path = '.claude/state/automation-config.json';
   let config = {};
   try { config = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
   delete config.interactiveLockdownDisabled;
   fs.mkdirSync(require('path').dirname(path), { recursive: true });
   fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
   console.log('done');
   "
   ```

3. Confirm:
   ```
   Deputy-CTO Console Lockdown: ENABLED

   Interactive sessions now operate as the deputy-CTO console.
   File-editing and sub-agent tools are restricted.
   This takes effect immediately for new tool calls.
   ```

## Disable Lockdown (/lockdown off)

1. Warn the user this is intended for development/debugging only.

2. Read current config:
   ```bash
   cat .claude/state/automation-config.json 2>/dev/null || echo '{}'
   ```

3. Write updated config with `interactiveLockdownDisabled: true`:
   ```bash
   node -e "
   const fs = require('fs');
   const path = '.claude/state/automation-config.json';
   let config = {};
   try { config = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
   config.interactiveLockdownDisabled = true;
   fs.mkdirSync(require('path').dirname(path), { recursive: true });
   fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
   console.log('done');
   "
   ```

4. Confirm:
   ```
   Deputy-CTO Console Lockdown: DISABLED

   WARNING: This is intended for development/debugging only.
   All tools are now available in this interactive session.
   A [LOCKDOWN DISABLED] warning will be injected on every tool call.
   Run /lockdown on to re-enable standard GENTYR workflow.
   ```

## What the Lockdown Controls

**Blocked in interactive sessions when lockdown is enabled:**
- `Edit` — file editing
- `Write` — file creation
- `NotebookEdit` — notebook editing
- `Agent` — sub-agent spawning
- `Task` — task-based sub-agent spawning

**Always allowed regardless of lockdown:**
- `Read`, `Glob`, `Grep` — code reading
- `Bash` — shell commands (git log, gh pr list, etc.)
- `WebFetch`, `WebSearch` — external reference
- `AskUserQuestion` — CTO interaction
- `Skill`, `ToolSearch` — slash commands and tool discovery
- All `mcp__*` tools — GENTYR's agent and task management system

**Spawned sessions** (`CLAUDE_SPAWNED_SESSION=true`) are always unrestricted
regardless of the lockdown setting.

## Important

- This does NOT require a session restart — takes effect immediately
- The setting persists across sessions (stored in `automation-config.json`)
- Re-enabling is always safe and recommended after debugging is complete
