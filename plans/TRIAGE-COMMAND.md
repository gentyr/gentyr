# Plan: `/triage` Slash Command

## Summary

Create a `/triage` slash command that force-spawns the deputy-CTO triage cycle immediately, bypassing the hourly automation's cooldown and batch limits. Returns the spawned session ID so the user can `--resume` into it.

## Architecture

Mirrors the existing `/spawn-tasks` pattern:
1. **Command file** (`.claude/commands/triage.md`) — defines the UX flow
2. **Prefetch handler** (in `slash-command-prefetch.js`) — gathers pending report counts
3. **Backing script** (`scripts/force-triage-reports.js`) — spawns the deputy-cto agent
4. **MCP tool** (`force_triage_reports` in agent-tracker server) — calls the backing script
5. **Types** (in `types.ts`) — schema + result interface for the new tool

## Session ID Discovery

The backing script spawns a detached `claude` process, which creates a JSONL session file in `~/.claude/projects/`. To return the session ID:

- After spawning, poll (up to 3 seconds, 500ms intervals) for a new JSONL file in the session directory that appeared after spawn time
- Extract the UUID from the filename
- Return it in the JSON result alongside `agentId` and `pid`

This is reliable because Claude creates the session file immediately on startup, and the session dir path is deterministic (`~/.claude/projects/-<normalized-project-path>/`).

## Files to Create/Modify

### 1. `.claude/commands/triage.md` (NEW)
- Sentinel: `<!-- HOOK:GENTYR:triage -->`
- Step 1: Display pending report counts from prefetch data
- Step 2: AskUserQuestion — confirm triage or cancel
- Step 3: Call `mcp__agent-tracker__force_triage_reports()`
- Step 4: Display results including session ID for `claude --resume`

### 2. `scripts/force-triage-reports.js` (NEW)
Follows `force-spawn-tasks.js` pattern:
- Imports agent-tracker (`registerSpawn`, `updateAgent`, `AGENT_TYPES`, `HOOK_TYPES`)
- Checks `cto-reports.db` for pending reports count
- Registers spawn with `AGENT_TYPES.DEPUTY_CTO_REVIEW` / `HOOK_TYPES.HOURLY_AUTOMATION`
- Builds the triage prompt (reuses the exact prompt from `spawnReportTriage()` in hourly-automation.js)
- Spawns detached `claude` process with `stdio: 'ignore'`
- Polls for session JSONL file (up to 3s)
- Returns JSON: `{ agentId, pid, sessionId, pendingReports }`

### 3. `.claude/hooks/slash-command-prefetch.js` (MODIFY)
- Add sentinel: `'triage': '<!-- HOOK:GENTYR:triage -->'`
- Add `'triage'` to `needsDb` array
- Add `handleTriage()` function that queries `cto-reports.db` for pending/in-progress counts + running agent count
- Add `matchesCommand` branch for `'triage'`

### 4. `packages/mcp-servers/src/agent-tracker/types.ts` (MODIFY)
- Add `ForceTriageReportsArgsSchema` (no required args)
- Add `ForceTriageReportsResult` interface: `{ agentId, pid, sessionId, pendingReports }`
- Add type exports

### 5. `packages/mcp-servers/src/agent-tracker/server.ts` (MODIFY)
- Add `forceTriageReports()` handler (mirrors `forceSpawnTasks()`)
- Calls `scripts/force-triage-reports.js` via `execFileSync`
- Register tool in the `tools` array

### 6. `.claude/hooks/agent-tracker.js` (MODIFY — only if needed)
- No changes expected; `DEPUTY_CTO_REVIEW` agent type and `HOURLY_AUTOMATION` hook type already exist

## What This Bypasses
- Triage check interval (5-minute cooldown in hourly automation)
- Automation enabled flag
- CTO activity gate
- Per-item triage cooldown (the MCP tool's `get_reports_for_triage` still filters by cooldown — this is preserved)

## What This Preserves
- Concurrency guard (checks running agents before spawning)
- Agent tracker registration
- The triage prompt and decision framework (identical to hourly automation)
- Per-item cooldown filtering (via `get_reports_for_triage`)
