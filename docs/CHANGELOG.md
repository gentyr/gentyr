# GENTYR Framework Changelog

## 2026-02-16 - CTO Dashboard Trajectory Forecast Graph

### Added

**Visual Trajectory Forecasting:**

1. **Trajectory Forecast Chart** (UsageTrends component)
   - Combined visualization showing historical usage transitioning to linear projections
   - 3 series: cyan 5h line, magenta 7d line, gray 90% target overlay
   - X-axis labels: "[timeAgo] → now → reset: Xh" to separate history from forecast
   - Projection point generation using linear extrapolation clamped to [0, 100]
   - Graceful degradation (only renders when projection data exists)

### Fixed

**Multi-Account Reset Time Bug:**
- Previously: `trajectory.ts` arbitrarily took the last API key's reset time during iteration
- Now: Picks the **earliest** reset time across all keys (most conservative estimate for aggregate quota tracking)

### Modified

**Files Changed (3 total):**
- `packages/cto-dashboard/src/utils/trajectory.ts` (lines 174-175) - Fixed reset time selection logic
- `packages/cto-dashboard/src/components/UsageTrends.tsx` - Added forecast chart with projection helpers
- `packages/cto-dashboard/src/App.tsx` - Updated props from `{snapshots, hasData}` to `{trajectory: TrajectoryResult}`

**Tests Added (2 files, 48 tests):**
- `packages/cto-dashboard/src/utils/__tests__/trajectory.test.ts` (21 tests)
- `packages/cto-dashboard/src/components/__tests__/UsageTrends.test.tsx` (27 tests)

**Documentation:**
- `docs/Executive.md` - Updated Usage Trends section to describe forecast chart and distinguish from text-based trajectory section

**Total Changes:** +165 lines added, 3 files modified, 48 tests added, 330 total tests passing

---

## 2026-02-16 - Multi-Layer Credential Detection

### Added

**4-Layer Credential Detection Architecture:**

1. **Shared Key Sync Module** (`key-sync.js`)
   - Multi-source credential reading (env var, macOS Keychain, credentials file)
   - User-level rotation state I/O at `~/.claude/api-key-rotation.json`
   - OAuth token refresh for expired credentials
   - Subscription tier detection (Free, Pro, Team)
   - Rate limit tier tracking (tier-1 through tier-5)

2. **Detection Layers**
   - Layer 1: launchd `WatchPaths` - instant file change detection on `~/.claude/.credentials.json`
   - Layer 2: 10-minute `StartInterval` - automation service key-sync calls
   - Layer 3: SessionStart hook (`api-key-watcher.js`) - full discovery on Claude Code start
   - Layer 4: PreToolUse hook (`credential-sync-hook.js`) - throttled mid-session checks (30-min)

3. **Key Features**
   - Aggregates credentials from all sources without short-circuiting
   - Shared rotation state registry across all projects (user-level)
   - Per-project rotation event logging
   - Automatic OAuth token refresh before expiration
   - Health checks and capacity alerts

**Files Created (2 total):**
- `.claude/hooks/key-sync.js` (328 lines) - Shared credential detection module
- `.claude/hooks/credential-sync-hook.js` (80 lines) - Throttled PreToolUse hook

**Files Modified (11 total):**
- `.claude/hooks/api-key-watcher.js` - Refactored to thin wrapper around key-sync.js (v2.0.0)
- `.claude/hooks/usage-optimizer.js` - Updated rotation state path to user-level
- `.claude/hooks/cto-notification-hook.js` - Updated rotation state path
- `.claude/hooks/credential-file-guard.js` - Added comment about user-level path coverage
- `.claude/hooks/hourly-automation.js` - Added key-sync step after usage optimizer
- `.claude/settings.json.template` - Added credential-sync-hook PreToolUse entry
- `scripts/setup-automation-service.sh` - Added WatchPaths to launchd plist template
- `packages/cto-dashboard/src/utils/data-reader.ts` - Updated rotation state path
- `packages/mcp-servers/src/cto-report/server.ts` - Updated rotation state path
- `.claude/hooks/__tests__/api-key-watcher.test.js` - Multiple test updates (75 tests passing)
- `.claude/hooks/__tests__/usage-optimizer.test.js` - Updated assertion (107 tests passing)

**Documentation:**
- `docs/CREDENTIAL-DETECTION.md` - Test coverage details for 4-layer architecture
- `README.md` - Added Multi-Layer Credential Detection section
- `CLAUDE.md` - (unchanged, no agent-facing updates needed)

**Total Changes:** +408 lines added, 11 files modified, 182 tests passing

### Code Review Findings

**9 Issues Identified:**

1. **CRITICAL**: Plaintext token aggregation without restrictive file permissions
2. **HIGH**: Race condition on rotation state file (3 concurrent callers, no file locking)
3. **HIGH**: Missing Zod validation on external API responses (OAuth token endpoint)
4. **MEDIUM**: Timeout mismatch in credential-sync-hook (5s timeout but OAuth refresh can exceed)
5. **MEDIUM**: Error swallowing in key-sync.js catch blocks (no telemetry)
6. **MEDIUM**: No retry logic for transient Keychain failures
7. **LOW**: Magic number for throttle cooldown (30 * 60 * 1000 should be constant)
8. **LOW**: Missing JSDoc for public functions in key-sync.js
9. **LOW**: No telemetry for credential source usage patterns

### Test Coverage

**Coverage Status:**
- `api-key-watcher.js` - 75 tests passing (full coverage)
- `usage-optimizer.js` - 107 tests passing (full coverage)
- `key-sync.js` - 0% coverage (new module, tests recommended)
- `credential-sync-hook.js` - 0% coverage (new hook, tests recommended)

**Coverage Gaps:**
- `refreshExpiredToken()` - 0% coverage (security-critical OAuth flow)
- `updateActiveCredentials()` - 0% behavioral coverage (dual-write to state)
- `readCredentialSources()` - indirect coverage only
- Recommendation: Create `.claude/hooks/__tests__/key-sync.test.js`

### Architecture Decisions

**Why user-level rotation state:**
- Supports multi-project workflows (same API key across multiple repos)
- Prevents state desync when same key used in multiple projects
- Enables global key tracking and quota aggregation
- Backward compatible with project-level fallback

**Why 4 detection layers:**
- Layer 1 (WatchPaths): Instant response to file changes (macOS only)
- Layer 2 (StartInterval): Cross-platform periodic checks
- Layer 3 (SessionStart): Initial discovery on new sessions
- Layer 4 (PreToolUse): Detects mid-session changes without restart

**Why shared key-sync module:**
- DRY principle (single source of truth for credential logic)
- Consistent behavior across all detection layers
- Easier testing and maintenance
- Supports future OAuth flow changes

---

## 2026-02-16 - Chrome Extension Bridge

### Added

**Chrome Bridge MCP Server:**

1. **Protocol Reverse Engineering**
   - Extracted Claude for Chrome extension protocol from Claude Desktop app.asar
   - Discovered Unix domain socket bridge at `/tmp/claude-mcp-browser-bridge-{username}/*.sock`
   - Binary framing protocol: 4-byte LE uint32 length prefix + UTF-8 JSON payload
   - Archived extraction to `~/Documents/archives/claude-desktop-app-extract-2026-02-16/`

2. **18 Chrome Extension Tools**
   - **Tab management** (4): `tabs_context_mcp`, `tabs_create_mcp`, `navigate`, `switch_browser`
   - **Page interaction** (6): `read_page`, `get_page_text`, `find`, `form_input`, `computer`, `javascript_tool`
   - **Debugging** (2): `read_console_messages`, `read_network_requests`
   - **Media** (3): `gif_creator`, `upload_image`, `resize_window`
   - **Workflows** (3): `shortcuts_list`, `shortcuts_execute`, `update_plan`

3. **Standalone MCP Server** (`chrome-bridge`)
   - Pure proxy architecture (no Zod validation, Chrome handles its own validation)
   - Multi-socket support (connects to all available Chrome instances)
   - Tab routing (remembers which socket owns which tab)
   - Connection resilience (exponential backoff, max 100 reconnect attempts)
   - Request serialization (per-socket queuing prevents response interleaving)
   - Proper timeout handling (2s for tabs_context_mcp, 120s for other tools)
   - Windows-compatible (null-safe `process.getuid` check)

4. **Integration**
   - Added to `.mcp.json.template` as direct server (no launcher needed)
   - Added `mcp-chrome-bridge` bin entry to package.json
   - Re-exported as ChromeBridge in packages/mcp-servers/src/index.ts

### Technical Details

**Files Created (3 total):**
- `packages/mcp-servers/src/chrome-bridge/types.ts` (51 lines) - Protocol types
- `packages/mcp-servers/src/chrome-bridge/server.ts` (997 lines) - Socket client + JSON-RPC server
- `packages/mcp-servers/src/chrome-bridge/index.ts` (4 lines) - Re-exports

**Files Modified:**
- `packages/mcp-servers/package.json` - Added bin entry
- `.mcp.json.template` - Added chrome-bridge server config
- `packages/mcp-servers/src/index.ts` - Added ChromeBridge export
- `README.md` - Updated server count, directory structure, MCP server list, version history
- `CLAUDE.md` - Added Chrome Browser Automation section

**Total Changes:** +1,052 lines added

### Testing

**Manual Testing:**
- TypeScript compilation: Clean
- MCP server initialization: Successful
- Live connection test: Retrieved tab context from 9 Chrome tabs
- Socket discovery: Detected Chrome extension socket
- Tool execution: `tabs_context_mcp` returned complete tab list

### Architecture Decisions

**Why not use McpServer base class:**
- Chrome extension handles its own validation (no need for Zod schemas)
- Binary content support (screenshots) incompatible with text-only base class
- Proxy pattern requires custom content normalization
- Simpler to implement raw JSON-RPC for pure proxy use case

**Security:**
- Socket ownership validation (only connects to user's own sockets via UID check)
- No credential storage (local socket communication only)
- Fail-safe reconnection logic (prevents infinite loops)

### Use Cases

**Example: Multi-Browser Testing**
- Developer has Chrome instances on multiple displays
- chrome-bridge discovers all sockets automatically
- Routes tab operations to correct browser instance
- Maintains tab-to-socket mapping for efficient targeting

**Example: Long-Running Automation**
- Browser crashes mid-automation
- Socket connection lost
- chrome-bridge reconnects with exponential backoff
- Automation resumes when browser restarts

### Requirements

- Claude for Chrome extension installed and running
- Chrome browser with extension socket active
- Unix-like OS with domain socket support (macOS, Linux)

---

## 2026-02-15 - MCP Server Thread-Safety Improvements

### Fixed

**Feedback System MCP Server Refactoring:**

1. **Thread-safety in McpServer base class**
   - Eliminated instance-level mutable state (`_captureMode`, `_capturedResponse`)
   - Refactored `handleRequest()` and `handleToolCall()` to return responses instead of using side-effect methods
   - Replaced `sendResponse`/`sendSuccess`/`sendError` with pure `createSuccessResponse`/`createErrorResponse`/`writeResponse`
   - Updated all 68 tests across server.test.ts and audited-server.test.ts

2. **Resource cleanup in factories**
   - Added `process.on('exit')` DB cleanup handler in `createUserFeedbackServer` factory
   - Removed signal handler leaks from `createFeedbackReporterServer` and `createPlaywrightFeedbackServer`
   - Moved SIGINT/SIGTERM handlers to auto-start guards only

3. **Verification**
   - TypeScript build: clean
   - Unit tests: 529 passed (16 files)
   - Integration tests: 21 passed (2 files)
   - Zero regressions

**Project Organization:**
- Moved Executive.md, STUBBED-PROBLEM.md, and TESTING.md from root to `/docs`
- Updated README.md reference to docs/TESTING.md
- Root directory now contains only essential files (README, CLAUDE, LICENSE, package files, version.json, and CLAUDE.md.gentyr-section template)

## 2026-02-15 - AI User Feedback System

### Added

**AI User Feedback System (Phase 1-8 complete):**

1. **Data Layer** - `user-feedback` MCP server
   - 16 tools for persona/feature CRUD, persona-feature mapping, feedback run lifecycle, and session management
   - SQLite schema with personas, features, persona_features, feedback_runs, and feedback_sessions tables
   - Support for 4 consumption modes: gui, cli, api, sdk
   - Persona cooldown tracking and rate limiting (4h default, max 5 per run)
   - 43 unit tests passing

2. **Configuration Interface** - `/configure-personas` slash command
   - Interactive persona management (create, edit, delete)
   - Feature registration with file/URL glob patterns
   - Persona-feature mapping with priority and test scenarios
   - Dry run: `get_personas_for_changes` previews which personas would trigger

3. **GUI Testing** - `playwright-feedback` MCP server
   - 20 user-perspective-only tools (navigate, click, type, screenshot, read_text)
   - No developer tools (no evaluate_javascript, get_page_source, etc.)
   - Browser context isolation per session
   - 34 unit tests passing

4. **Programmatic Testing** - `programmatic-feedback` MCP server
   - CLI mode: execFile with shell injection prevention
   - API mode: HTTP fetch with base URL validation
   - SDK mode: worker thread sandbox with blocked dangerous modules
   - 12 tools supporting 3 testing modes
   - 47 unit tests passing

5. **Reporting Bridge** - `feedback-reporter` MCP server
   - Bridges findings from feedback sessions to agent-reports pipeline
   - Severity-to-priority mapping (critical→critical, high→high, medium→normal, low/info→low)
   - Persona-named reporting agents (e.g., "feedback-agent [power-user]")
   - Category: 'user-feedback' (added to REPORT_CATEGORIES)
   - 21 unit tests passing

6. **Feedback Agent** - `feedback-agent.md`
   - Restricted tool access: only playwright-feedback, programmatic-feedback, feedback-reporter
   - Disallowed: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, Task, NotebookEdit
   - Persona-driven instructions: stays in character, tests as real user
   - Reports findings via feedback-reporter tools

7. **Session Launcher** - `scripts/feedback-launcher.js`
   - Generates isolated .mcp.json configs for feedback sessions
   - Spawns Claude Code sessions with feedback-agent
   - Passes persona config and test scenarios via chat prompt
   - Detached process spawning for fire-and-forget execution

8. **Orchestration Pipeline** - `scripts/feedback-orchestrator.js`
   - Detects staging changes and matches affected features
   - Selects personas mapped to matched features
   - Respects 4h per-persona cooldown and max-5-per-run limit
   - Creates feedback_run and feedback_session records
   - Spawns feedback agents via feedback-launcher

**Testing Infrastructure:**

- Toy app (server.js, cli.js) with 5 intentional bugs for end-to-end testing
- 9 integration tests covering full pipeline: persona CRUD → feature registration → change analysis → feedback run lifecycle → reporter bridge
- Feedback agent stub for simulating sessions without spawning real Claude sessions
- 475 MCP server unit tests: ALL PASSING
- 9 integration tests: ALL PASSING

**Modified Files:**

- `.mcp.json.template` - Added user-feedback, playwright-feedback, programmatic-feedback, feedback-reporter servers
- `packages/mcp-servers/src/agent-reports/types.ts` - Added 'user-feedback' category
- `.claude/agents/feedback-agent.md` - New agent definition
- `.claude/commands/configure-personas.md` - New slash command
- `scripts/feedback-launcher.js` - New launcher script
- `scripts/feedback-orchestrator.js` - New orchestration pipeline
- `tests/README.md` - Documentation for feedback system tests
- `tests/fixtures/toy-app/` - Toy application with intentional bugs
- `tests/integration/feedback-pipeline.test.ts` - Integration tests
- `tests/integration/mocks/feedback-agent-stub.ts` - Agent simulation stub

**Known Remaining Work (not in scope):**

- Move feedback-launcher.js and feedback-orchestrator.js to .claude/hooks/ after unprotect
- Add feedback pipeline block to hourly-automation.js
- Add `user_feedback: 120` cooldown default to config-reader.js

## 2026-02-15 - Usage Optimizer Improvements

### Enhanced

**Six behavioral improvements to usage-optimizer.js:**

1. **MIN_EFFECTIVE_MINUTES floor constant**
   - Added 2-minute floor to prevent cooldowns from going below practical minimums
   - `applyFactor()` clamps adjusted cooldowns to never go below 2 minutes
   - Prevents impractical sub-minute cooldowns that cause scheduler thrashing

2. **Reset-boundary detection**
   - New `RESET_BOUNDARY_DROP_THRESHOLD = 0.30` constant
   - Detects when 5-hour utilization drops >30pp between snapshots
   - Indicates quota reset occurred, clears trajectory data to start fresh
   - Prevents false trajectory calculations across reset boundaries

3. **EMA rate smoothing**
   - New `calculateEmaRate()` function with alpha=0.3
   - Exponential moving average smooths noisy utilization rates
   - Reduces overreaction to single anomalous snapshots
   - More stable cooldown adjustments over time

4. **Max-key awareness**
   - `calculateAggregate()` now tracks `maxKey5h` and `maxKey7d`
   - Uses highest utilization across all keys for trajectory projection
   - Prevents underutilization when one key is saturated
   - Ensures system doesn't spawn tasks on exhausted keys

5. **Per-key rate tracking**
   - New `perKeyUtilization` object tracks each key's 5h/7d rates
   - Logs warnings when any individual key exceeds 80% utilization
   - Helps identify single-key bottlenecks before hitting hard limits
   - Provides visibility into multi-key quota distribution

6. **Enhanced logging**
   - Direction tracking: "projected-at-reset falling behind target" messages
   - `hoursUntilReset` included in all adjustment logs and config writes
   - More context for understanding optimizer behavior in production

### Changed

**Modified Files:**
- `.claude/hooks/usage-optimizer.js` - All 6 improvements implemented
- `.claude/hooks/__tests__/usage-optimizer.test.js` - 27 new behavioral tests added

**Total Changes:** +412 lines added (including tests)

### Testing

**New Test Suite (27 behavioral tests):**
- MIN_EFFECTIVE_MINUTES floor enforcement tests (4)
- Reset-boundary detection tests (5)
- EMA rate smoothing tests (5)
- Max-key awareness tests (4)
- Per-key utilization tracking tests (4)
- Enhanced logging tests (5)

**Test Results:**
- All 107 usage-optimizer tests passing (80 existing + 27 new)
- Code review: No violations
- TypeScript compilation: Passed

### Technical Details

**Behavioral Examples:**

**Floor Enforcement:**
```
Target: 1 min cooldown → Clamped to 2 min
Target: 0.5 min cooldown → Clamped to 2 min
Prevents scheduler thrashing
```

**Reset Detection:**
```
Snapshot 1: 5h=0.75 (75%)
Snapshot 2: 5h=0.40 (40%)
Drop = 35pp > 30pp threshold → Reset detected
Action: Clear trajectory, start fresh
```

**EMA Smoothing:**
```
Snapshot 1: rate=8.0 (spike)
Snapshot 2: rate=2.0 (normal)
EMA rate = 0.3*8.0 + 0.7*2.0 = 3.8 (smoothed)
Prevents overreaction to outliers
```

**Max-Key Awareness:**
```
Key A: 5h=0.60, 7d=0.50
Key B: 5h=0.85, 7d=0.70 (saturated)
Aggregate uses maxKey: 5h=0.85, 7d=0.70
Prevents spawning tasks on exhausted keys
```

### Use Cases

**Example 1: Quota Reset Boundary**
- System samples quota at 11:58 AM (75% used)
- Quota resets at 12:00 PM
- Next sample at 12:08 PM (5% used)
- Reset detector triggers, clears trajectory
- Prevents false "rate slowed dramatically" calculation

**Example 2: Single-Key Saturation**
- Project has 3 API keys
- Key #1 hits 90% utilization
- Keys #2 and #3 at 40% utilization
- Max-key tracking uses 90% for trajectory
- System reduces spawn rate to avoid key exhaustion

**Example 3: Noisy Environment**
- Network glitch causes one anomalous sample (spike)
- EMA smoothing reduces impact of outlier
- Cooldown adjustment remains stable
- Prevents unnecessary spawn rate swings

### Backward Compatibility

Fully backward compatible:
- All changes are internal to usage-optimizer.js
- No config schema changes
- No MCP tool changes
- Existing snapshots remain valid
- No breaking changes to hourly-automation.js integration

---

## 2026-02-15 - CTO Activity Gate for Autonomous Automation

### Added

**24-Hour CTO Activity Gate**
- New fail-closed safety mechanism for autonomous automation system
- All timer-based automations (task runner, health monitors, promotion pipelines, etc.) require CTO briefing within past 24 hours
- `checkCtoActivityGate()` function validates CTO activity before running any automation
- Prevents runaway automation when CTO is not actively engaged with the project

**Deputy-CTO MCP Tool**
- `mcp__deputy-cto__record_cto_briefing` - Records timestamp when CTO runs `/deputy-cto`
- Updates `lastCtoBriefing` in deputy-cto config database
- Automatically refreshes the 24-hour automation window

**Configuration Schema Extension**
- Added `lastCtoBriefing` field to deputy-cto config (ISO 8601 timestamp)
- Persisted in `.claude/deputy-cto-config.db` SQLite database

**Status Reporting**
- `mcp__deputy-cto__get_status` now includes gate status:
  - `activityGate.open` - Whether automation is currently allowed
  - `activityGate.hoursSinceLastBriefing` - Hours since last CTO activity
  - `activityGate.reason` - Human-readable explanation

### Changed

**Hourly Automation Service**
- Modified `hourly-automation.js` main() to check CTO activity gate before running
- If gate is closed, logs reason and exits gracefully (no automations run)
- Gate check happens immediately after config load

**`/deputy-cto` Command**
- Added `mcp__deputy-cto__record_cto_briefing()` as step 0 in opening briefing
- CTO activity is automatically recorded at the start of every briefing session
- Ensures automation window is refreshed each time CTO engages

### Security Features (G001 Compliance)

**Fail-Closed Design:**
- Missing `lastCtoBriefing` field → automation gated
- Invalid timestamp → automation gated
- Parse errors → automation gated
- Timestamp >24h old → automation gated

**Why This Matters:**
- Prevents autonomous agents from running indefinitely without human oversight
- Ensures CTO remains engaged with automated decision-making
- Creates natural checkpoint for reviewing autonomous actions (daily)
- Reduces risk of automation drift from project goals

### Technical Details

**Files Modified (5 total):**
- `packages/mcp-servers/src/deputy-cto/types.ts` - Added lastCtoBriefing to config type, new tool schemas
- `packages/mcp-servers/src/deputy-cto/server.ts` - Added recordCtoBriefing() function, registered tool
- `.claude/hooks/hourly-automation.js` - Added checkCtoActivityGate() and gate check in main()
- `.claude/commands/deputy-cto.md` - Added record_cto_briefing() as step 0
- `packages/mcp-servers/src/deputy-cto/__tests__/deputy-cto.test.ts` - 12 new tests for gate feature

**Total Changes:** +203 lines added, -14 lines removed

### Testing

**New Test Suite (12 tests):**
- `record_cto_briefing` tool functionality
- `get_status` includes gate information
- Gate opens when briefing is recent (<24h)
- Gate closes when briefing is old (>24h)
- Gate closes when briefing is missing
- Gate closes on invalid timestamp
- Fail-closed behavior on all error conditions

**Test Results:**
- TypeScript compilation: ✓ Passed
- All 330 tests passing (318 existing + 12 new)
- Code review: ✓ No violations

### Use Cases

**Example 1: Fresh Installation**
- User installs GENTYR, autonomous mode enabled by default
- Hourly automation runs, checks gate → closed (no briefing yet)
- User runs `/deputy-cto` → briefing recorded
- Hourly automation runs, checks gate → open (briefing fresh)

**Example 2: Inactive Project**
- User is away for 2 days
- Hourly automation runs every hour → gate closed after 24h
- No tasks spawned, no promotions, no health checks
- User returns, runs `/deputy-cto` → automation resumes

**Example 3: Active Development**
- User runs `/deputy-cto` daily as part of workflow
- Gate always open, automation runs normally
- Natural cadence of human oversight and automated execution

### Backward Compatibility

Fully backward compatible:
- Existing deputy-cto config database migrates seamlessly (lastCtoBriefing defaults to null)
- First run of `/deputy-cto` populates the field
- Projects without deputy-cto installed are unaffected (no automation anyway)

---

## 2026-02-03 - CTO Approval System for MCP Actions

### Added

**Protected MCP Action Gate**
- New PreToolUse hook: `protected-action-gate.js` - Blocks protected MCP actions until CTO approval
- New UserPromptSubmit hook: `protected-action-approval-hook.js` - Processes CTO approval phrases
- Configuration file: `protected-actions.json.template` - Maps approval phrases to MCP tools
- Approval utilities library: `.claude/hooks/lib/approval-utils.js` - Encryption, code generation, validation

**CLI Utilities**
- `scripts/encrypt-credential.js` - Encrypt credentials for protected-actions.json
- `scripts/generate-protected-actions-spec.js` - Auto-generate spec file from config

**Deputy-CTO MCP Tools**
- `mcp__deputy-cto__list_protections` - List all protected MCP actions and their approval phrases
- `mcp__deputy-cto__get_protected_action_request` - Get details of pending approval request by code

**Setup Script Integration**
- Added `--protect-mcp` flag to setup.sh for protecting MCP action config files
- Protection includes: `protected-actions.json`, `protected-action-approvals.json`

**Agent Instructions**
- Updated `CLAUDE.md.gentyr-section` with CTO-Protected Actions workflow section
- Agents now instructed to stop and wait for CTO approval when actions are blocked

### Security Fixes

**G001 Fail-Closed Compliance**
- Fixed fail-open vulnerability in protected-action-gate.js
- Now properly fails closed when config is missing or invalid
- Added explicit error handling for all edge cases

**Cryptographic Security**
- Replaced weak RNG (Math.random) with crypto.randomBytes for approval code generation
- 6-character codes now use cryptographically secure random values

**Protection Integrity**
- Updated do_unprotect() to include new approval system files
- Ensures uninstall properly removes all protected files

### Changed

**Hook Configuration**
- `.claude/settings.json.template` updated with new hook registrations:
  - PreToolUse: protected-action-gate.js
  - UserPromptSubmit: protected-action-approval-hook.js

### Technical Details

**Approval Workflow:**
1. Agent calls protected MCP action (e.g., production deployment tool)
2. PreToolUse hook blocks the action, generates 6-character code
3. Agent displays: "Action blocked. CTO must type: APPROVE PROD A7X9K2"
4. CTO types approval phrase in chat
5. UserPromptSubmit hook validates phrase and code, creates one-time approval token
6. Agent retries action, PreToolUse hook allows it (one-time use, 5-minute expiry)

**Configuration Schema:**
```json
{
  "protections": [
    {
      "phrase": "APPROVE PROD",
      "encryptedCredential": "...",
      "tools": [
        { "server": "mcp-server", "tool": "deploy_to_production" }
      ]
    }
  ]
}
```

**Files Created (13 total):**
- `.claude/hooks/lib/approval-utils.js` (269 lines)
- `.claude/hooks/protected-action-gate.js` (137 lines)
- `.claude/hooks/protected-action-approval-hook.js` (120 lines)
- `.claude/hooks/protected-actions.json.template` (52 lines)
- `scripts/encrypt-credential.js` (85 lines)
- `scripts/generate-protected-actions-spec.js` (116 lines)
- `.claude/hooks/__tests__/approval-utils.test.js` (231 lines)
- `.claude/hooks/__tests__/protected-action-gate.test.js` (189 lines)
- `.claude/hooks/__tests__/protected-action-approval-hook.test.js` (192 lines)

**Files Modified:**
- `.claude/settings.json.template` (+14 lines)
- `CLAUDE.md.gentyr-section` (+7 lines)
- `packages/mcp-servers/src/deputy-cto/server.ts` (+98 lines)
- `packages/mcp-servers/src/deputy-cto/types.ts` (+23 lines)
- `scripts/setup.sh` (+32 lines)

**Total Changes:** +1565 lines added

### Testing

All new components include comprehensive unit tests:
- approval-utils.test.js: Encryption, code generation, validation
- protected-action-gate.test.js: Hook blocking behavior, fail-closed compliance
- protected-action-approval-hook.test.js: Approval phrase processing, token creation

### Use Cases

**Example 1: Production Deployment**
Protect production deployment tools to require explicit CTO approval before execution.

**Example 2: Database Migrations**
Prevent agents from running migrations without CTO review and approval.

**Example 3: API Key Rotation**
Require CTO approval before rotating production API keys.

### Security Considerations

- Approval codes expire after 5 minutes
- One-time use tokens (cannot be reused)
- Fail-closed design (blocks on any error)
- Credentials encrypted with AES-256-GCM
- Cryptographically secure random code generation

---

## 2026-01-31 - Deputy CTO Task Assignment Feature

### Added

**Deputy CTO Agent: Task Assignment Capability**
- Added `mcp__todo-db__create_task` to deputy-cto allowed tools
- New "Task Assignment" section with urgency-based decision criteria
- Reduces resource usage by queuing non-urgent tasks instead of immediate spawning

**Decision Framework:**
- **Urgent tasks** (immediate spawning via `spawn_implementation_task`):
  - Security issues or vulnerabilities
  - Blocking issues preventing commits
  - Time-sensitive fixes
  - CTO explicitly requests immediate action
- **Non-urgent tasks** (queued via `mcp__todo-db__create_task`):
  - Feature implementation from plans
  - Refactoring work
  - Documentation updates
  - General improvements

### Changed

**`.claude/agents/deputy-cto.md`**
- Added `mcp__todo-db__create_task` to allowedTools
- Updated "Your Powers" section to list both spawn and queue options
- Added "Task Assignment" section with urgency criteria and code examples

**`.claude/commands/deputy-cto.md`**
- Replaced "Spawning Implementation Tasks" section with "Task Assignment"
- Added urgency-based decision criteria
- Added code examples for both immediate spawning and queuing

### Technical Details

The deputy-cto agent now intelligently chooses between:
1. **Immediate spawning** - Fire-and-forget Claude sessions for urgent work
2. **Task queuing** - Adding tasks to todo.db for agent pickup during normal workflow

This reduces unnecessary resource consumption while maintaining responsiveness for critical issues.

### Files Modified

- `.claude/agents/deputy-cto.md` (configuration changes)
- `.claude/commands/deputy-cto.md` (documentation changes)

### Review Status

- Code Reviewer: APPROVED - Changes well-structured, consistent, correct tool usage
- Test Writer: N/A - Markdown configuration files, no executable code

---

## 2026-01-29 - CLAUDE.md Agent Instructions Feature

### Added

**Setup Script: CLAUDE.md Management**
- Automatic injection of agent workflow instructions into target project CLAUDE.md files
- Template file: `CLAUDE.md.gentyr-section` with golden rules and standard workflow
- Smart append/replace logic:
  - Creates CLAUDE.md if it doesn't exist
  - Appends section to existing files
  - Replaces section on re-install (no duplicates)
  - Uses `<!-- GENTYR-FRAMEWORK-START/END -->` markers for idempotency

**Uninstall Cleanup**
- Removes GENTYR section from CLAUDE.md
- Deletes file if empty after removal
- Preserves project-specific content

**Agent Workflow Documentation**
- Golden rules: Never skip agents, always follow order, one agent per role
- Standard sequence: INVESTIGATOR → CODE-WRITER → TEST-WRITER → CODE-REVIEWER → PROJECT-MANAGER → SUMMARY
- CTO reporting guidelines for architecture, security, breaking changes, blockers
- Slash command reference

### Changed

**scripts/setup.sh**
- Added section 8: CLAUDE.md agent instructions injection
- Added CLAUDE.md cleanup in uninstall section
- Skip CLAUDE.md operations if file is write-protected

**README.md**
- Expanded "Custom CLAUDE.md" section with installation behavior details
- Documented template location and content
- Added uninstall behavior explanation

### Files Modified

- `scripts/setup.sh` (+47 lines)
- `CLAUDE.md` (new, 60 lines) - Framework's own CLAUDE.md
- `CLAUDE.md.gentyr-section` (new, 34 lines) - Template for target projects
- `README.md` (+20 lines)
- `docs/CHANGELOG.md` (+35 lines, this entry)

### Technical Details

**Idempotency:**
- Section markers ensure re-installs replace old section instead of appending duplicates
- Sed-based removal using marker comments

**Protection Integration:**
- Setup skips CLAUDE.md if write-protected (post-protection state)
- Uninstall skips cleanup if write-protected

### Use Case

Before this feature, each project needed manual CLAUDE.md creation with agent workflow instructions. Now the framework automatically provides:
- Consistent agent workflow across all projects
- Up-to-date best practices for multi-agent coordination
- Standardized CTO reporting conventions

Projects can still add custom instructions above/below the framework section.

---

## 2026-01-24 - Spec Suite System

### Added

**MCP Server: specs-browser**
- 9 new MCP tools for spec and suite management:
  - `createSpec` - Create new specification files
  - `editSpec` - Edit existing specifications
  - `deleteSpec` - Delete specifications
  - `get_specs_for_file` - Get all applicable specs for a file (main + subspecs)
  - `listSuites` - List all configured spec suites
  - `getSuite` - Get suite configuration details
  - `createSuite` - Create new spec suite
  - `editSuite` - Modify suite configuration
  - `deleteSuite` - Remove spec suite

**Compliance Checker**
- Suite-based enforcement system
- Pattern matching for file scoping using glob patterns
- `loadSuitesConfig()` - Load suite configuration
- `getSuitesForFile()` - Determine applicable suites for a file
- `getAllApplicableSpecs()` - Collect specs from matching suites (global)
- `getAllExploratorySpecs()` - Collect specs from matching suites (local)
- `matchesGlob()` - Simple glob pattern matcher

**Configuration**
- New config file: `.claude/hooks/suites-config.json`
- Suite schema with scope, priority, and enabled flags
- Backward compatibility with legacy enforcement

**Documentation**
- Comprehensive spec suites section in `.claude/hooks/README.md`
- Session documentation: `docs/sessions/2026-01-24-spec-suite-implementation.md`
- Updated README.md with spec suite examples

### Changed

**Compliance Prompts**
- `spec-enforcement.md` - Added optional Suite Context section
- `local-spec-enforcement.md` - Added Suite Context and Scope Constraint sections

**README.md**
- Updated Specification Enforcement section with suite examples
- Updated specs-browser description to include CRUD operations
- Updated MCP tools examples

### Technical Details

**Files Modified (7 total):**
- `.claude/hooks/README.md` (+89 lines)
- `.claude/hooks/compliance-checker.js` (+382 lines major refactor)
- `.claude/hooks/prompts/local-spec-enforcement.md` (+24 lines)
- `.claude/hooks/prompts/spec-enforcement.md` (+9 lines)
- `README.md` (+34 lines)
- `packages/mcp-servers/src/specs-browser/server.ts` (+442 lines)
- `packages/mcp-servers/src/specs-browser/types.ts` (+232 lines)

**Total Changes:** +1101 lines, -111 lines

### Verification

- TypeScript build: ✓ Passed
- JavaScript syntax check: ✓ Passed
- Code review: ✓ No violations
- Vitest tests: ✓ 51 tests passing

### Testing

**specs-browser/__tests__/specs-browser.test.ts**
- Fixed test cleanup issue in Suite Management describe block
- Added `afterEach` to remove `.claude` directory created during tests
- All 51 tests now pass consistently across test runs
- Root cause: Missing cleanup caused directory persistence across runs

### Architecture

Spec suites allow projects to:
1. Group related specifications (global + local)
2. Scope specs to specific file patterns using glob syntax
3. Reduce enforcement noise by checking only relevant specs
4. Configure priority when multiple suites match

Example use case: Integration-specific specs only check integration files, not the entire codebase.

### Backward Compatibility

Fully backward compatible:
- Legacy behavior if suites-config.json doesn't exist
- Existing spec-file-mappings.json still supported
- No breaking changes to existing workflows

---

## Previous Releases

See git history for pre-2026-01-24 changes.
