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

Removes protection, symlinks, generated configs, husky hooks, and the managed `# BEGIN GENTYR OP` / `# END GENTYR OP` block from shell profiles. Preserves runtime state (`.claude/*.db`).

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

### On-Demand Triage

```bash
# In a Claude Code session after GENTYR is installed:
/triage
```

Force-spawns the deputy-CTO triage cycle immediately, bypassing the hourly automation's triage check interval, the automation-enabled flag, and the CTO activity gate. The command prefetches pending report counts and running agent info, asks for confirmation, then calls `force_triage_reports` on the agent-tracker MCP server. Returns the spawned session ID so the user can `claude --resume` into the triage session. Preserves the concurrency guard, agent tracker registration, and per-item triage cooldown filtering.

## Automatic Session Recovery

GENTYR automatically detects and recovers sessions interrupted by API quota limits.

**Quota Monitor Hook** (`.claude/hooks/quota-monitor.js`):
- Runs after every tool call (throttled to 5-minute intervals)
- Checks active key usage and triggers rotation at 95% utilization
- **Step 4b unified refresh loop**: Refreshes expired tokens AND proactively refreshes non-active tokens approaching expiry (within 10 min of `EXPIRY_BUFFER_MS`); uses single loop with `isExpired`/`isApproachingExpiry` variables for efficiency
- `refreshExpiredToken` returns the sentinel string `'invalid_grant'` (not `null`) when the OAuth server responds HTTP 400 + `{ error: 'invalid_grant' }`; callers mark the key `invalid` and skip it permanently
- **Step 4c pre-expiry restartless swap**: When the active key is within 10 min of expiry and a valid standby exists, writes standby to Keychain via `updateActiveCredentials()`; Claude Code's built-in `SRA()` (proactive refresh at 5 min before expiry) or `r6T()` (401 recovery) picks up the new token seamlessly — no restart needed
- Safe: refreshing Account B does not revoke Account A's in-memory token
- **Seamless rotation** (quota-based): writes new credentials to Keychain, continues with `continue: true` for all sessions, credentials adopted at token expiry (SRA) or 401 (r6T)
  - No disruptive kill/restart paths; no orphaned processes
- Post-rotation health audit: logs rotation verification to `rotation-audit.log`

**Key Sync Module** (`.claude/hooks/key-sync.js`):
- Shared library used by api-key-watcher, hourly-automation, credential-sync-hook, and quota-monitor
- Exports `EXPIRY_BUFFER_MS` (10 min) and `HEALTH_DATA_MAX_AGE_MS` (15 min) constants for consistent timing across all rotation logic
- `refreshExpiredToken` returns `'invalid_grant'` sentinel (distinct from `null`) when OAuth responds 400 + `error: invalid_grant`; all callers mark the key `status: 'invalid'` and log `refresh_token_invalid_grant`
- `syncKeys()` proactively refreshes non-active tokens approaching expiry (within `EXPIRY_BUFFER_MS`), resolves account profiles for keys missing `account_uuid` via `fetchAccountProfile()`, and performs pre-expiry restartless swap to Keychain; covers idle sessions because hourly-automation calls `syncKeys()` every 10 min via launchd even when no Claude Code process is active
- `fetchAccountProfile(accessToken)` — exported function that calls `https://api.anthropic.com/api/oauth/profile` to resolve `account_uuid` and `email` for keys added by automation or token refresh that skipped the interactive SessionStart profile-resolution path; non-fatal, retried on next sync
- `selectActiveKey()` freshness gate: nulls out usage data older than 15 minutes to prevent uninformed switches based on stale health checks; stale keys pass "usable" filter but are excluded from comparison logic, causing system to stay put rather than make blind decisions
- `pruneDeadKeys` immediately garbage-collects keys with `status: 'invalid'`; never prunes the active key; removes orphaned rotation_log entries; called automatically at the end of every `syncKeys()` run

**Rotation Monitoring** (`scripts/monitor-token-swap.mjs`):
```bash
# Real-time rotation state monitoring
node scripts/monitor-token-swap.mjs --path /project [--interval 30]

# Rotation health audit report
node scripts/monitor-token-swap.mjs --path /project --audit
```

Tracks credential rotation state, Keychain sync status, and account health. Audit mode generates rotation health reports showing recent rotations, pending audits, and system alerts.

**Binary Patch Research** (`scripts/patch-credential-cache.js`) — **ARCHIVED**:
Research artifact from investigating Claude Code's credential memoization cache. Replaced by the rotation proxy which handles credential swap at the network level, eliminating the need for binary modification. Kept for reference only.

**Credential Health Check Hook** (`.claude/hooks/credential-health-check.js`):
- Runs at `SessionStart` for interactive sessions only; skipped for spawned `[Task]` sessions
- Validates vault mappings against required keys in `protected-actions.json`
- Checks `.mcp.json` env blocks for keys injected directly (e.g. `OP_SERVICE_ACCOUNT_TOKEN`), which count as configured even if absent from vault-mappings
- **OP token desync detection**: Compares shell `OP_SERVICE_ACCOUNT_TOKEN` against `.mcp.json` value; if they differ, emits a warning and overwrites `process.env` with the `.mcp.json` value (source of truth); `.mcp.json` is always authoritative because it is updated by reinstall
- Staged at `scripts/hooks/credential-health-check.js`; deployed to `.claude/hooks/` during `setup.sh` install; both copies must stay identical
- Shell sync validation also available via `scripts/setup-validate.js` `validateShellSync()` function, which checks the `# BEGIN GENTYR OP` / `# END GENTYR OP` block in `~/.zshrc` or `~/.bashrc`

## Rotation Proxy

Local MITM proxy for transparent credential rotation (`scripts/rotation-proxy.js`).

**Architecture:**
```
Claude Code ──HTTPS_PROXY──> localhost:18080 ──TLS──> api.anthropic.com
                                    │
                            reads rotation state
                        (~/.claude/api-key-rotation.json)
                                    │
                            on 429: rotate key, retry
```

**What it intercepts** (TLS MITM + header swap):
- `api.anthropic.com` — main API
- `mcp-proxy.anthropic.com` — MCP proxy endpoint

**What passes through** (transparent CONNECT tunnel):
- `platform.claude.com` — OAuth refresh
- Everything else

**429 retry**: On quota exhaustion response, marks the current key as exhausted, calls `selectActiveKey()` to pick the next available key, and retries the request (max 2 retries). If no keys are available, returns the original 429 to the client.

**Logging**: Structured JSON lines to `~/.claude/rotation-proxy.log` (max 1MB with rotation). Logs token swaps (key ID only, never token values), 429 retries, and errors for debugging.

**Health endpoint**: `GET http://localhost:18080/__health` returns JSON status with active key ID, uptime, and request count.

**Lifecycle**: Runs as a launchd KeepAlive service (`com.local.gentyr-rotation-proxy`). Auto-restarts on crash. Starts before the automation service.

**CONNECT head buffer handling**: The CONNECT handler's `head` parameter (early client data — typically the TLS ClientHello — sent before the 200 response arrives) is pushed back into the socket's readable stream with `clientSocket.unshift(head)` before wrapping in TLSSocket. Omitting this caused intermittent ECONNRESET errors because the TLS handshake began with incomplete data. This is the textbook fix for Node.js HTTPS MITM proxies.

**Complements existing rotation**: The proxy handles immediate token swap at the network level. Quota-monitor still handles usage detection and key selection. Key-sync still handles token refresh and Keychain writes.

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

**Contextual Tips:**
The chrome-bridge server injects site-specific browser automation tips into tool responses. Tips are sourced from docs/SETUP-GUIDE.md and cover common UI quirks for GitHub, 1Password, Render, Vercel, Cloudflare, Supabase, Elastic Cloud, Resend, and Codecov. Each tip is shown at most once per session on interactive tools (`navigate`, `computer`, `form_input`, `find`, `read_page`).

No credentials required - communicates via local Unix domain socket with length-prefixed JSON framing protocol.

## Secret Management

The secret-sync MCP server orchestrates secrets from 1Password to deployment platforms without exposing values to agent context.

**Security model:**
- Secret values NEVER pass through agent context window
- Agent calls tools with target platform names only
- Server resolves `op://` references internally via 1Password CLI
- Output is sanitized to redact accidentally leaked values

**6 Available Tools:**
- `secret_sync_secrets` - Push secrets to Render/Vercel from 1Password
- `secret_list_mappings` - List configured secret keys and op:// references
- `secret_verify_secrets` - Check secret existence on platforms (no values)
- `secret_run_command` - Run commands with secrets injected (Playwright, Prisma, etc.)
- `secret_dev_server_status` - Check running dev servers with secret injection
- `secret_dev_server_stop` - Terminate managed dev servers

**Key features:**
- Executable allowlist for `secret_run_command`: `pnpm`, `npx`, `node`, `tsx`, `playwright`, `prisma`, `drizzle-kit`, `vitest`
- Inline eval blocked: `-e`, `--eval`, `-c` flags rejected
- Infrastructure credentials filtered from child processes
- Output sanitization replaces secret values with `[REDACTED:KEY_NAME]`
- Background mode for long-running processes

Configuration via `.claude/config/services.json` with `secrets.local` section. Auto-generates `op-secrets.conf` during setup (contains `op://` references only).

See `packages/mcp-servers/src/secret-sync/README.md` for full documentation.

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
