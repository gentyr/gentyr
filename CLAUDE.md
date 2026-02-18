# GENTYR Framework

A modular automation framework for Claude Code.

## Usage

All commands run from the framework directory (`/path/to/gentyr`). Use `--path` to specify the target project.

### Install (with protection - recommended)

```bash
sudo scripts/setup.sh --path /path/to/project --protect
```

Installs framework symlinks, configs, husky hooks, builds MCP servers, and makes critical files root-owned to prevent agent bypass.

### Install (without protection - development only)

```bash
scripts/setup.sh --path /path/to/project
```

### Uninstall

```bash
sudo scripts/setup.sh --path /path/to/project --uninstall
```

Removes protection, symlinks, generated configs, and husky hooks. Preserves runtime state (`.claude/*.db`).

### Protect Only

```bash
sudo scripts/setup.sh --path /path/to/project --protect-only
```

Adds root ownership to critical files without reinstalling.

### Unprotect Only

```bash
sudo scripts/setup.sh --path /path/to/project --unprotect-only
```

Removes root ownership from critical files. Use before making manual changes to protected files, then re-protect with `--protect-only`.

### Verify Installation

```bash
cd /path/to/project && claude mcp list
```

## AI User Feedback System

Configure user personas to automatically test your app when staging changes are detected:

```bash
# In a Claude Code session after GENTYR is installed:
/configure-personas
```

Creates personas (GUI/CLI/API/SDK modes), registers features with file patterns, and maps personas to features. Feedback agents spawn on staging changes and report findings to deputy-CTO triage pipeline.

## Automation Service

```bash
scripts/setup-automation-service.sh status --path /project                  # Check service status
scripts/setup-automation-service.sh remove --path /project                  # Remove service
scripts/setup-automation-service.sh run --path /project                     # Manual run
scripts/setup-automation-service.sh setup --path /project --op-token TOKEN  # Install with 1Password service account
```

By default, the automation service runs without 1Password credentials in background mode to avoid macOS permission prompts. Provide `--op-token` with a 1Password service account token to enable headless credential resolution for infrastructure MCP servers.

### On-Demand Task Spawning

```bash
# In a Claude Code session after GENTYR is installed:
/spawn-tasks
```

Bypasses the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate to force-spawn pending TODO tasks immediately. The command prefetches current agent counts and concurrency limits, asks which sections to spawn and what concurrency cap to use, then calls `force_spawn_tasks` on the agent-tracker MCP server. Preserves the concurrency guard and task status tracking.

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by API quota limits.

**Quota Monitor Hook** (`.claude/hooks/quota-monitor.js`):
- Runs after every tool call (throttled to 5-minute intervals)
- Checks active key usage and triggers rotation at 95% utilization
- Interactive sessions: spawns auto-restart script with new credentials
- Automated sessions: writes state for session-reviver pickup
- All-accounts-exhausted: writes paused-sessions.json and waits for recovery

**Session Reviver Hook** (`.claude/hooks/session-reviver.js`):
- Called every hourly automation cycle with 10-minute cooldown
- Mode 1: Quota-interrupted pickup (reads quota-interrupted-sessions.json, re-spawns with --resume)
- Mode 2: Historical dead session recovery (scans agent-tracker-history.json, finds unexpectedly dead agents)
- Mode 3: Paused session resume (checks for account recovery when all were exhausted)
- Max 3 revivals per cycle, 7-day historical window

**Manual Recovery** (`scripts/recover-interrupted-sessions.js`):
```bash
# One-time recovery for interrupted sessions
node scripts/recover-interrupted-sessions.js --path /project [--dry-run] [--max-concurrent 3]
```

Cross-references agent-tracker-history with TODO database to find in_progress tasks with no corresponding live process. Re-spawns sessions with original task context.

## VS Code Companion Extension

The GENTYR VS Code extension provides a real-time dashboard for developers who use VS Code as their primary editor. It displays the same metrics as the CLI dashboard but in a persistent, always-visible format.

**Features:**
- **Status bar item** - Always-visible quota/usage summary
- **Dashboard panel** - Full metrics view with quota bars, deputy CTO status, task breakdown, and system health
- **Real-time updates** - File watchers monitor SQLite databases and state files for changes
- **No configuration** - Reads same data sources as CLI dashboard

**Installation:**
```bash
cd packages/vscode-extension
npm install
npm run build          # Development build
npm run package        # Create VSIX package for installation
```

Install the generated `.vsix` file in VS Code via Extensions > Install from VSIX.

**Architecture:**
- Extension host (Node.js/CommonJS) handles data aggregation and file watching
- Webview (React/ESM) renders the dashboard UI
- Self-contained DataService (~700 lines) aggregates data from:
  - SQLite databases (todo.db, agent-tracker.db, agent-reports.db, deputy-cto.db)
  - JSON state files (quota snapshots, autonomous mode, usage optimizer)
  - Anthropic API (quota and usage data)

## Chrome Browser Automation

The chrome-bridge MCP server provides access to Claude for Chrome extension capabilities:

```bash
# Chrome extension must be installed and running
# Server auto-discovers browser instances via Unix domain socket at:
# /tmp/claude-mcp-browser-bridge-{username}/*.sock
```

**18 Available Tools:**
- Tab management: `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `switch_browser`
- Page interaction: `read_page`, `get_page_text`, `find`, `form_input`, `computer`, `javascript_tool`
- Debugging: `read_console_messages`, `read_network_requests`
- Media: `gif_creator`, `upload_image`, `resize_window`
- Workflows: `shortcuts_list`, `shortcuts_execute`, `update_plan`

No credentials required - communicates via local Unix domain socket with length-prefixed JSON framing protocol.

## CTO Dashboard Development

The CTO dashboard (`packages/cto-dashboard/`) supports a `--mock` flag for development and README generation. The `packages/cto-dashboard/src/mock-data.ts` module provides deterministic fixture data (waypoint-interpolated usage curves, realistic triage reports, deployment history) that renders without requiring live MCP connections.

### Regenerate README Dashboard Section

```bash
node scripts/generate-readme.js
```

Or via npm:

```bash
npm run generate:readme
```

Runs the dashboard with `--mock` and `COLUMNS=80`, then replaces the content between `<!-- CTO_DASHBOARD_START -->` and `<!-- CTO_DASHBOARD_END -->` markers in `README.md`. The script uses `execFileSync` (not `execSync`) to prevent shell injection. Tests live at `scripts/__tests__/generate-readme.test.js`.
