# GENTYR Framework Changelog

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
