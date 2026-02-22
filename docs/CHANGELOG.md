# GENTYR Framework Changelog

## 2026-02-21 - Seamless Credential Rotation + Health Auditing

### Changed

**Seamless rotation for quota-based switches** (`.claude/hooks/quota-monitor.js`):
- Removed disruptive kill/restart paths (old lines 432-491): no more AppleScript terminal injection, no more orphaned process spawning
- Interactive sessions: now receive `continue: true` with system message explaining adoption timing (credentials written to Keychain, picked up at SRA or r6T, not immediate)
- Automated sessions: now receive `continue: false` with stopReason (clean stop for session-reviver to resume with fresh credentials from Keychain)
- Removed unused imports: `spawn`, `getClaudePid`, `detectTerminal`, `generateRestartScript`, `shellEscape`
- Updated doc comment to reflect seamless rotation behavior (version 2.0.0)

**Post-rotation health audit** (`.claude/hooks/quota-monitor.js`):
- Added `pendingAudit` field to throttle state
- Added `verifyPendingAudit()` function to verify rotation success
- Writes audit results to `rotation-audit.log`
- Imports `readKeychainCredentials` and `generateKeyId` from key-sync.js

**Shared keychain reader** (`.claude/hooks/key-sync.js`):
- New export: `readKeychainCredentials()` - reads and parses macOS Keychain credentials directly
- Used by quota-monitor for post-rotation auditing and by monitor-token-swap for state verification

**Rotation health monitoring** (`scripts/monitor-token-swap.mjs`):
- Added `--audit` flag: prints rotation health report (recent rotations, pending audits, current state, Keychain status, alerts)
- Refactored `readKeychainState()` to delegate to shared `readKeychainCredentials()` from key-sync.js
- Audit mode shows rotation success rate, credential sync status, and system health metrics

### Added

**Binary patch research** (`scripts/patch-credential-cache.py`):
- Dry-run only research script for Claude Code's `iB()` credential memoization
- Searches for 9 patterns in Bun SEA binary (all found on v2.1.34)
- Proposes Approach A: setInterval injection to periodically clear `iB.cache` (60-second TTL)
- Not production-ready; exists for future reference if immediate adoption needed for quota rotation
- Test coverage: `scripts/__tests__/patch-credential-cache.test.js` (37 tests)

### Tests

**Test updates**:
- Updated quota-monitor tests for seamless rotation paths (186 tests total, all passing)
- Added `readKeychainCredentials()` coverage in key-sync tests
- Added `--audit` flag tests for monitor-token-swap
- Created `patch-credential-cache.test.js` with 37 tests for binary patch research script
- Fixed `readKeychainState` test to match new delegation pattern

### Documentation

**Updated files**:
- `CLAUDE.md` - Seamless rotation behavior, rotation monitoring tools, binary patch research note
- `docs/AUTOMATION-SYSTEMS.md` - Updated session flow diagrams and quota-monitor steps
- `MEMORY.md` - Added seamless rotation pattern note

---

## 2026-02-21 - Priority-Based Urgent Task Dispatch

### Added

**Priority field in TODO database** (`packages/mcp-servers/src/todo-db/`):
- New `priority` field in task schema with values `'normal' | 'urgent'`
- Exposed in `CreateTaskArgsSchema` with default value `'normal'`
- Exposed in `ListTasksArgsSchema` as optional filter parameter
- Auto-migration added: `ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'` runs on server init if column missing
- Type exports: `TASK_PRIORITY` constant array, `TaskPriority` type from `shared/constants.ts`

**Urgent dispatcher in hourly automation** (`.claude/hooks/hourly-automation.js`):
- New `tryDispatchUrgentTasks()` step runs before task runner (bypasses 1-hour age filter)
- Urgent tasks are NOT age-gated — they dispatch immediately when spawned
- Concurrency limit enforced: urgent dispatcher respects global agent cap
- Queries for tasks with `status='pending' AND priority='urgent'`
- Uses same `spawnTaskAgent()` flow as regular task runner

**Governance routing for triage self-handle** (`packages/mcp-servers/src/deputy-cto/server.ts`):
- Triage self-handle path now routes through `create_task` with `priority: 'urgent'` instead of ungoverned `spawn_implementation_task`
- Ensures ALL task spawning goes through centralized governance (concurrency limits, tracking, recovery)
- Urgent priority ensures immediate dispatch without waiting for 1-hour age threshold

### Changed

**Force-spawn script** (`scripts/force-spawn-tasks.js`):
- Updated to support priority filter in task queries
- No behavioral changes (force-spawn bypasses priority entirely, spawns all matching tasks)

### Tests

**Test coverage**:
- 76 vitest tests (MCP servers) + 113 node:test tests (hooks) = 189 total tests
- All tests passing
- TypeScript build clean
- Coverage includes priority field validation, schema migration, urgent dispatcher logic

### Files Modified

**10 files across 3 areas**:
- MCP server: `shared/constants.ts`, `todo-db/types.ts`, `todo-db/server.ts`, `__testUtils__/schemas.ts`
- Hooks: `hourly-automation.js`
- Scripts: `force-spawn-tasks.js`
- Tests: `todo-db.test.ts`, `hourly-automation.test.js`

---

## 2026-02-21 - Health Data Freshness Gate + Monitor Actuation Mode

### Added

**Health data freshness gate** (`.claude/hooks/key-sync.js`):
- New `HEALTH_DATA_MAX_AGE_MS` export (15 minutes) - usage data older than this is treated as unknown
- `selectActiveKey()` now nulls out usage data when `last_health_check` is older than 15 minutes
- Effect: prevents uninformed key switches when health data is stale
- Stale keys pass "usable" filter (not proven exhausted) but are excluded from comparison logic
- System stays put with current key rather than making blind decisions on outdated data

**Monitor actuation mode** (`scripts/monitor-token-swap.mjs`):
- New `--act` CLI flag enables actuation mode (default remains observation-only)
- DESYNC auto-fix: after 3 consecutive polls (~90s) with Keychain-vs-active desync, writes active key to Keychain automatically
- Actuation rotation: when `--act` enabled and active key >=90% usage, rotates to lower-usage alternative on different account with 5-min cooldown
- Stale-data health refresh (ALWAYS ON): deep checks now write fresh `last_health_check` and `last_usage` back to rotation state for ALL keys
- Email propagation: usage data propagates to all keys sharing same `account_email`
- New alert counters: `ACT_ROTATION`, `ACT_DESYNC_FIX`

**Test coverage** (`.claude/hooks/__tests__/health-data-freshness-gate.test.js`):
- 25 new tests covering `HEALTH_DATA_MAX_AGE_MS` constant and freshness gate behavior
- Code structure validation (8 tests): export check, value check, comment check, freshness loop placement
- Behavioral logic (9 tests): staleness detection, null-out logic, filter effects, comparison exclusion
- Integration scenarios (8 tests): no-switch with stale data, exhausted-current fallback to stale

### Changed

**Global hooks configuration** (`~/.claude/settings.json`):
- Added PostToolUse hook: `quota-monitor.js` with absolute path, timeout 10s (fires for ALL projects)
- Added Stop hook: `stop-continue-hook.js` with absolute path, timeout 5s (fires for ALL projects)
- Ensures quota monitoring works even in projects without their own hooks

### Fixed

**Usage optimizer maxKey computation** (`.claude/hooks/usage-optimizer.js`):
- Moved `maxKey5h`/`maxKey7d` computation to after exhausted key filtering
- Prevents exhausted keys from biasing effectiveUsage upward

### Tests

**Test results**:
- All 25 new freshness gate tests pass
- All existing key-sync tests pass (deduplication, expired-filter, proactive-refresh)
- All quota-monitor adaptive tests pass
- Code review verified all critical logic (freshness gate, actuation rotation, DESYNC fix, email propagation)

### Documentation

**Updated files**:
- `CLAUDE.md` - Added freshness gate documentation to Key Sync Module section
- `docs/CHANGELOG.md` - This entry

**Files modified (8 total)**:
- `.claude/hooks/key-sync.js` - Added `HEALTH_DATA_MAX_AGE_MS` constant + freshness gate in `selectActiveKey()`
- `scripts/monitor-token-swap.mjs` - Added `--act` actuation mode + DESYNC auto-fix + health refresh
- `~/.claude/settings.json` - Added global PostToolUse and Stop hooks
- `.claude/hooks/__tests__/health-data-freshness-gate.test.js` - New test suite (25 tests)
- `.claude/hooks/usage-optimizer.js` - Fixed maxKey computation timing
- `.claude/hooks/__tests__/usage-optimizer.test.js` - Updated tests
- `.claude/hooks/hourly-automation.js` - Updated tests
- `.claude/hooks/__tests__/hourly-automation.test.js` - Updated tests

---

## 2026-02-21 - Fix GENTYR Monitoring Gaps: Step 8 Violation Fixes

### Fixed

**3 security violations in hourly-automation hook** (`.claude/hooks/hourly-automation.js`):

1. **VIOLATION 1: Missing schema validation in readPersistentAlerts**
   - Risk: Malformed persistent-alerts.json could cause type confusion or runtime errors
   - Fix: Added comprehensive validation for top-level structure (`typeof`, null checks, `Array.isArray`)
   - Fix: Alert entries missing required `severity` (string) or `resolved` (boolean) fields are now dropped
   - Impact: Prevents injection or corruption attacks via malformed alert files

2. **VIOLATION 2: Missing API response validation in checkCiStatus**
   - Risk: Unexpected GitHub API responses could cause null pointer exceptions
   - Fix: Added `Array.isArray(runs)` validation before accessing runs array
   - Fix: Added `typeof latestRun.conclusion !== 'string'` validation before comparing conclusion
   - Impact: Graceful degradation when GitHub API returns unexpected data

3. **VIOLATION 3: Prompt injection risk in spawnAlertEscalation**
   - Risk: Alert fields containing backticks, template literals, or newlines could inject arbitrary commands into agent prompt
   - Fix: Created `sanitizeAlertField()` function (strips backticks, newlines, `${` syntax, truncates to 200 chars)
   - Fix: Applied sanitization to ALL alert fields before prompt interpolation: title, key, severity, source, first_detected_at
   - Fix: Moved sanitization before `registerSpawn` call to protect the description field
   - Fix: Added `Number.isFinite` safety check on age calculation
   - Impact: Prevents malicious alert data from executing arbitrary code in agent context

### Added

**Test coverage** (`.claude/hooks/__tests__/hourly-automation.test.js`):
- 4 structural tests for VIOLATION 1 (schema validation)
- 3 structural tests for VIOLATION 2 (CI API response validation)
- 8 structural tests for VIOLATION 3 (sanitization placement)
- 14 behavioral tests for `sanitizeAlertField` function
- 15 behavioral tests for `readPersistentAlerts` with file I/O
- Total: 44 new tests added

### Tests

**Test results**:
- All 102 hourly-automation tests pass (58 existing + 44 new)
- All 202 usage-optimizer tests pass
- Code review: All violations addressed, 2 follow-up fixes applied (sanitize in registerSpawn, safe age calculation)

### Context

This completes Step 8 (final step) of the "Fix GENTYR Monitoring Gaps" plan. GAPs 1-7 were implemented in a prior session. All monitoring gap fixes are now complete.

**Files modified (2 total)**:
- `.claude/hooks/hourly-automation.js` - 3 violation fixes + 2 follow-up improvements
- `.claude/hooks/__tests__/hourly-automation.test.js` - 44 new tests

---

## 2026-02-21 - Usage Optimizer: 7 Cascading Bug Fixes + Trajectory Alignment

### Fixed

**7 interconnected bugs causing permanent over-throttling** (factor stuck at 0.099, automation +913% slower):

1. **Bug 1: Reset time selection picks last, not earliest** (`.claude/hooks/usage-optimizer.js`)
   - When multiple keys have different reset times, the optimizer must use the earliest reset time to be conservative
   - Previous: Used arbitrary last key's reset time (could be far in future)
   - Fix: Changed `resetAt5h = k['5h_reset']` to `resetAt5h = k['5h_reset'] < resetAt5h`

2. **Bug 2: Exhausted accounts (7d >= 99.5%) pollute aggregate + EMA rate** (`.claude/hooks/usage-optimizer.js`)
   - Exhausted keys should be filtered from both aggregate averaging AND trajectory rate calculation
   - Previous: Filtered from aggregate but still included in EMA rate calculation
   - Fix: Added `exhaustedKeyIds` Set, filter from both `calculateAggregate()` and `calculateTrajectory()`

3. **Bug 3: No tiered factor recovery from extreme throttling** (`.claude/hooks/usage-optimizer.js`)
   - When factor hits MIN_FACTOR (0.05), 10% MAX_CHANGE_PER_CYCLE limit prevents recovery
   - Fix: Two-tier recovery system:
     - Tier 1 (hard reset): When factor <= 0.15 AND current usage < 63%, reset factor to 1.0 immediately
     - Tier 2 (gradual boost): When factor < 0.5 AND current usage < target, apply 1.5x boost per cycle

4. **Bug 4: No per-key reset boundary detection** (`.claude/hooks/usage-optimizer.js`)
   - Reset detection only looked at aggregate utilization drop, missing individual key resets
   - Fix: Added PER_KEY_RESET_DROP_THRESHOLD (50pp) check — if ANY key's 5h drops >50pp between snapshots, reset factor to 1.0

5. **Bug 5: Key-count discontinuity causes spurious rate spikes** (`.claude/hooks/usage-optimizer.js`)
   - When number of active keys changes between snapshots, rate calculation becomes invalid
   - Fix: Added key-count validation — reject snapshot pairs where key counts differ

6. **Bug 6: Trajectory.ts not aligned with optimizer** (`packages/cto-dashboard/src/utils/trajectory.ts`)
   - Dashboard trajectory calculation didn't filter exhausted accounts (inconsistent with optimizer)
   - Fix: Added same exhausted account filtering (7d >= 0.995) to `getQuotaTrajectory()`

7. **Bug 7: maxKey computed from all keys including exhausted** (`.claude/hooks/usage-optimizer.js`)
   - When computing effectiveUsage (max of average vs. maxKey), exhausted keys biased maxKey upward
   - Fix: Moved maxKey5h/maxKey7d computation to after active key filtering

### Added

**Utility function** (`.claude/hooks/usage-optimizer.js`):
- `resetOptimizer()` export for manual cleanup after polluted data (clears snapshots, resets factor to 1.0)

**Test coverage** (`.claude/hooks/__tests__/usage-optimizer.test.js`):
- 13 new tests covering reset time selection, exhausted account filtering, tier-1/tier-2 recovery, per-key reset detection, key-count validation
- 3 new trajectory tests for exhausted account filtering (`packages/cto-dashboard/src/utils/__tests__/trajectory.test.ts`)

### Tests

**Test results**:
- All 202 usage-optimizer tests pass (189 existing + 13 new)
- All 23 trajectory tests pass (20 existing + 3 new)
- All 25 cto-report tests pass
- Code review: 1 minor concern addressed (maxKey bug fix added as Bug 7)

### Impact

**Before fixes**: Factor stuck at 0.099 (MIN_FACTOR), all automation throttled to +913% slower (essentially paused)

**After fixes**: Factor can reset to 1.0 on usage drop or key reset, tier-1 recovery provides immediate escape from extreme throttling, tier-2 recovery prevents gradual descent back to MIN_FACTOR

**Post-deploy action required**: Call `resetOptimizer()` on target project to clear polluted usage-snapshots.json and reset factor from 0.099 to 1.0

**Files modified (5 total)**:
- `.claude/hooks/usage-optimizer.js` - 7 bug fixes + resetOptimizer() export
- `packages/cto-dashboard/src/utils/trajectory.ts` - Exhausted account filtering alignment
- `.claude/hooks/__tests__/usage-optimizer.test.js` - 13 new tests
- `packages/cto-dashboard/src/utils/__tests__/trajectory.test.ts` - 3 new tests
- `.claude/hooks/hourly-automation.js` - Updated tests (not functionality)

---

## 2026-02-21 - Product Manager Agent & PMF Analysis System

### Added

**Product Manager MCP Server** (2 files):
- `packages/mcp-servers/src/product-manager/server.ts` - 13 MCP tools with SQLite DB, sequential section lock, markdown auto-generation
- `packages/mcp-servers/src/product-manager/types.ts` - Zod schemas for 6 analysis sections (market_space, buyer_personas, competitor_differentiation, pricing_models, niche_strengths, user_sentiment)

**Agent & Command Integration** (2 files):
- `.claude/agents/product-manager.md` - Opus model agent with read-only codebase access, WebSearch/WebFetch for research
- `.claude/commands/product-manager.md` - `/product-manager` slash command with status display and workflow options

**Dashboard Integration** (3 files):
- `packages/cto-dashboard/src/utils/product-manager-reader.ts` - Data reader for PMF analysis state
- `packages/cto-dashboard/src/components/ProductManagerSection.tsx` - Ink/React dashboard component
- Modified: `packages/cto-dashboard/src/App.tsx`, `index.tsx`, `components/index.ts`, `mock-data.ts`

**System Integration** (4 files):
- `packages/mcp-servers/src/shared/constants.ts` - Added PRODUCT-MANAGER to VALID_SECTIONS
- `packages/mcp-servers/src/todo-db/server.ts` - CHECK constraint + migration for PRODUCT-MANAGER section
- `.claude/hooks/agent-tracker.js` - New agent type registration
- `.claude/hooks/hourly-automation.js` - SECTION_AGENT_MAP entry
- `.claude/hooks/slash-command-prefetch.js` - Prefetch handler

**User Feedback Access Control** (2 files):
- `packages/mcp-servers/src/user-feedback/server.ts` - cto_protected migration + CTO-only access control for deletePersona
- `packages/mcp-servers/src/user-feedback/types.ts` - cto_protected + caller fields added to persona schema

**MCP Tools** (13 tools):
- `initiate_analysis` - Start PMF analysis (creates pending_approval state)
- `approve_analysis` - CTO approval to proceed
- `get_analysis_status` - Check overall progress
- `read_section` - Read content with prior context cascading
- `write_section` - Write single-content sections (1, 3, 4, 5)
- `add_entry` - Add list entries (sections 2, 6)
- `list_pain_points` - Query user_sentiment entries
- `map_pain_point_persona` - Link pain points to user-feedback personas
- `clear_and_respawn` - Wipe and rebuild analysis via task chain
- `get_compliance_report` - Persona mapping coverage stats
- `regenerate_md` - Export to `pmf-analysis.md`
- `delete_analysis` - Reset state
- `update_analysis_metadata` - Update timestamps and metadata

**Analysis Workflow**:
1. User/deputy-CTO calls `initiate_analysis` → state: pending_approval
2. Deputy-CTO approves → state: approved
3. Hourly automation spawns PRODUCT-MANAGER agent tasks for each section (sequential)
4. Agent researches via WebSearch/WebFetch, reads codebase, writes sections
5. After Section 6 completes, persona evaluation task maps pain points to user-feedback personas
6. `regenerate_md` exports full analysis to markdown

**Sequential Lock**:
- Each section requires all prior sections to be populated before writing
- Context cascading: `read_section` returns all previous sections as context
- Prevents fragmented or out-of-order analysis

### Tests

**New test files** (4 files):
- `packages/mcp-servers/src/product-manager/__tests__/product-manager.test.ts` - 32 tests covering all 13 MCP tools, state machine, sequential lock, persona mapping
- `.claude/hooks/__tests__/agent-tracker-product-manager.test.js` - 11 tests for agent type registration
- `.claude/hooks/__tests__/hourly-automation-product-manager.test.js` - 14 tests for task spawning
- `.claude/hooks/__tests__/slash-command-prefetch-product-manager.test.js` - 30 tests for command prefetch handler

**Test results**:
- All 1092 mcp-servers tests pass
- All 55 hook tests pass
- Clean TypeScript build for both packages/mcp-servers and packages/cto-dashboard
- Mock dashboard renders ProductManagerSection correctly

### Fixed

**Critical security/compliance issues** (identified during code review):
1. `deletePersona` missing CTO-protected access control - FIXED (requires deputy-CTO caller)
2. PRODUCT-MANAGER missing from spawn-tasks pending query - FIXED (added to slash-command-prefetch.js)
3. AddEntryArgsSchema.section not constrained to valid values (2, 6) - FIXED (Zod enum)
4. `clearAndRespawn` opens todo.db without WAL pragma - FIXED (added pragma)
5. `mapPainPointPersona` silently continues on persona verification failure - FIXED (throws error)
6. metadata field not validated as JSON - FIXED (Zod z.record)

### Impact

This session delivered the 11th agent (PRODUCT-MANAGER) and a complete PMF analysis system:
1. **Market research automation**: Agent uses WebSearch/WebFetch for competitive intelligence
2. **Codebase analysis**: Read-only access to understand product features
3. **Sequential workflow**: 6 sections populate in order with context cascading
4. **Persona integration**: Pain points map to user-feedback personas for automated testing
5. **CTO oversight**: Analysis requires approval before starting
6. **Dashboard visibility**: CTO sees PMF progress in main dashboard

All changes backward-compatible. New agent joins existing 10-agent ecosystem. Full integration with task runner, deputy-CTO triage, and hourly automation.

## 2026-02-21 - Dashboard Sections as Agent-Facing MCP Tools & Slash Commands

### Added

**Show MCP Server** (3 files):
- `packages/mcp-servers/src/show/types.ts` - Zod schemas and constants for 12 dashboard sections (`QUOTA`, `ACCOUNTS`, `DEPUTY_CTO`, `USAGE`, `AUTOMATIONS`, `TESTING`, `DEPLOYMENTS`, `WORKTREES`, `INFRA`, `LOGGING`, `TIMELINE`, `TASKS`)
- `packages/mcp-servers/src/show/server.ts` - 12 MCP tools generated from data-driven loop: `show_quota`, `show_accounts`, `show_deputy_cto`, etc. Each tool spawns the dashboard binary with `--section <name>` and optional `--limit <N>` flags
- `.mcp.json.template` - Registered `show` MCP server entry

**Slash Command Integration** (2 files):
- `.claude/commands/show.md` - New `/show` slash command reference page listing all 12 section tools with descriptions and usage examples
- `.claude/hooks/slash-command-prefetch.js` - Added `show` sentinel and lightweight `handleShow()` handler for instant command reference

**Dashboard CLI Enhancement** (1 file):
- `packages/cto-dashboard/src/index.tsx` - Added `--section <name>` and `--limit <N>` CLI flags with `renderSection()` function that renders individual dashboard sections. Includes exhaustiveness check, invalid section warning, and support for all 12 sections.

**Agent Guidance** (2 files):
- `CLAUDE.md.gentyr-section` - Added "Status Displays" section encouraging agents to use `mcp__show__*` tools before token-heavy operations, deployments, test runs, etc. Added `/show` to slash commands list.
- `.claude/agents/deputy-cto.md` - Added `mcp__show__*` to `allowedTools` and brief "Status Displays" usage guidance

**Use cases**:
- `mcp__show__show_quota()` before token-heavy operations
- `mcp__show__show_testing()` before writing or running tests
- `mcp__show__show_deployments()` before triggering deploys
- `mcp__show__show_tasks()` before creating tasks
- `mcp__show__show_worktrees()` before provisioning worktrees
- `mcp__show__show_automations()` before spawning agents

**Architecture**:
- Tools use `execFileSync` to spawn the dashboard binary (prevents shell injection)
- Pass `{ limit: N }` to expand the number of rows shown
- Renders rich terminal displays (Ink-based React components)
- Works with both `--mock` (development) and live MCP connections

### Tests

**Test results**:
- All 760 cto-dashboard tests pass
- All 1060 mcp-servers tests pass
- Both packages build cleanly
- All 12 sections verified working with `--mock` flag

### Documentation

**Updated documentation** (1 file):
- `CLAUDE.md.gentyr-section` - Added comprehensive "Status Displays" section with usage guidance and tool listings

### Impact

This session delivered agent-facing status displays:
1. **12 MCP tools**: Agents can now check individual dashboard sections on-demand without viewing the full CTO report
2. **Contextual usage**: Tools support passing `{ limit: N }` for expanded views
3. **Slash command**: `/show` provides quick reference for all available section tools
4. **Integration**: Works with both mock data (development) and live MCP connections (production)

All changes backward-compatible. Full dashboard (`/cto-report`) still available. New tools provide granular, on-demand access to specific metrics.

## 2026-02-21 - CTO Dashboard: Hotfix Pathway, Deployments Upgrade, Worktree Visualization

### Added

**CTO Emergency Hotfix Pathway** (4 files):
- `packages/mcp-servers/src/deputy-cto/types.ts` - Zod schemas for `RequestHotfixPromotionArgs`, `ExecuteHotfixPromotionArgs`, `HotfixRequest`
- `packages/mcp-servers/src/deputy-cto/server.ts` - `request_hotfix_promotion` and `execute_hotfix_promotion` MCP tools, `hotfix_requests` DB table
- `.claude/hooks/bypass-approval-hook.js` - APPROVE HOTFIX pattern matching, 6-char code validation, HMAC token writing to `hotfix-approval-token.json`
- `.claude/commands/hotfix.md` - New `/hotfix` slash command with CTO approval workflow

**Hotfix workflow**:
1. Agent calls `request_hotfix_promotion` → validates staging has unreleased commits → returns 6-char approval code
2. Agent presents code to user: `APPROVE HOTFIX <code>`
3. User types approval → bypass-approval-hook writes HMAC token (5-minute expiry)
4. Agent calls `execute_hotfix_promotion` with code → validates token → spawns staging→main promotion immediately (bypasses 24h stability window + midnight gate)

**DEPLOYMENTS Section Upgrade** (3 files):
- `packages/cto-dashboard/src/utils/deployments-reader.ts` - Added `localDevCount` (counts active worktrees), `stagingFreezeActive` (boolean flag) to pipeline data
- `packages/cto-dashboard/src/components/DeploymentsSection.tsx` - 4-column EnvironmentHealth (added Local Dev), PipelineDetail shows worktree count + freeze snowflake (❄)
- `packages/cto-dashboard/src/mock-data.ts` - Added preview deploys, `localDevCount`, `stagingFreezeActive`, `getMockWorktrees()` for realistic rendering

**Pipeline visualization**:
```
local dev (3) → preview ✓ → staging ✓ ❄ → production (24h gate)  Last: 5h ago
```

**WORKTREES Section** (2 new files, 3 modified):
- `packages/cto-dashboard/src/utils/worktree-reader.ts` - Reads git worktree state, agent tracker DB, maps to pipeline stages
- `packages/cto-dashboard/src/components/WorktreeSection.tsx` - Full visualization: summary cards, worktree table (branch, agent, stage, stale flag, files), cleanup hints
- `packages/cto-dashboard/src/components/index.ts` - Added WorktreeSection export
- `packages/cto-dashboard/src/App.tsx` - Added worktrees prop, WorktreeSection rendering
- `packages/cto-dashboard/src/index.tsx` - Wired worktree data loading (mock + live paths)

**Worktree details displayed**:
- Branch name, agent ID, pipeline stage, creation time, modified files count
- Stale indicator for worktrees >3 days old
- Cleanup hints for merged branches

### Fixed

**Critical deputy-cto tool registration bug** (1 file):
- `packages/mcp-servers/src/deputy-cto/server.ts` - `request_hotfix_promotion` and `execute_hotfix_promotion` were defined as tool handlers but never added to the `tools` array
- Result: Tools were invisible to MCP clients (would have failed at runtime)
- Fix: Added both tools to the array before passing to `McpServer` constructor

### Tests

**New test files** (1 file):
- `.claude/hooks/__tests__/bypass-approval-hotfix.test.js` - 8 unit tests for APPROVE HOTFIX pattern matching, HMAC token generation, expiry, invalid code rejection

**Updated test files** (3 files):
- `packages/cto-dashboard/src/utils/__tests__/account-overview-reader.test.ts` - Added tests for worktree integration (schema changes)
- `packages/mcp-servers/src/deputy-cto/__tests__/deputy-cto.test.ts` - Tests for hotfix promotion tools (validation, DB writes, approval flow)
- Mock data validation tests for deployments-reader and worktree-reader

**Test results**:
- TypeScript build clean for both `cto-dashboard` and `mcp-servers`
- All existing tests pass
- Mock mode dashboard renders all 3 new features correctly

### Documentation

**Updated documentation** (2 files):
- `README.md` - Regenerated via `generate-readme.js` with new dashboard sections visible
- `docs/DEPLOYMENT-FLOW.md` - Added "Emergency Hotfix Pathway" section with workflow, prerequisites, safety measures; added `APPROVE HOTFIX` to CTO approval gates table

### Impact

This session delivered 3 major CTO dashboard enhancements:
1. **Emergency hotfix pathway**: CTO can approve immediate staging→main promotion when production is broken (bypasses 24h + midnight gates)
2. **Deployments visibility**: Pipeline now shows local dev worktrees and staging freeze status at a glance
3. **Worktree tracking**: CTO sees all active feature branches, agent assignments, stale work, and cleanup hints

All changes isolated to dashboard + deputy-CTO MCP server. No changes to core automation or promotion logic.

## 2026-02-21 - Chrome Bridge: Contextual Browser Automation Tips

### Added

**Contextual browser automation tips** (3 files):
- `packages/mcp-servers/src/chrome-bridge/browser-tips.ts` - BrowserTip interface, BrowserTipTracker class with session-scoped deduplication
- 14 contextual tips (5 general + 9 site-specific) sourced from docs/SETUP-GUIDE.md
- Tips are injected into chrome-bridge tool responses based on hostname and tool usage
- Each tip shown at most once per Claude Code session (MCP server lifetime)
- Domain boundary hostname matching (github.com matches *.github.com)
- Only shown on interactive tools: `navigate`, `computer`, `form_input`, `find`, `read_page`
- `packages/mcp-servers/src/chrome-bridge/server.ts` - Import BrowserTipTracker, cache URLs on navigate, appendTips method called at both return paths in executeTool
- `packages/mcp-servers/src/chrome-bridge/index.ts` - Re-export browser-tips module

**Site-specific tips included**:
- GitHub: Form input preference for special characters in token names
- 1Password: Field creation workflow (chevron + button + form_input + save verification)
- Render: One-time API key capture with get_page_text
- Vercel: One-time token capture, Team ID extraction
- Cloudflare: Zone ID extraction, multi-step wizard navigation
- Supabase: Reveal button for service_role key, multi-value extraction
- Elastic Cloud: Dev Tools Console API key creation (REST command preferred over UI)
- Resend: One-time API key capture, permission dropdown selection
- Codecov: GitHub OAuth disruption, manual login fallback, token extraction

### Tests

**New test files** (2 files):
- `packages/mcp-servers/src/chrome-bridge/__tests__/browser-tips.test.ts` - 38 unit tests for BrowserTipTracker (hostname matching, deduplication, tool filtering)
- `packages/mcp-servers/src/chrome-bridge/__tests__/appendTips.test.ts` - 24 integration tests for appendTips method (error exclusion, URL caching, anti-spam)

**Test results**:
- 93 chrome-bridge tests pass (31 existing + 62 new)
- TypeScript compilation clean (pre-existing deputy-cto unused variable warnings unrelated)

### Fixed

**Browser automation quirks** (2 files):
- Hostname matching: Changed from `endsWith(h)` to `hostname === h || hostname.endsWith('.' + h)` for proper domain boundary matching (prevents "github.com" from matching "notgithub.com")
- Tip text: Fixed reference to `zoom` as standalone tool when it's actually a `computer` action

### Design

**Anti-spam measures**:
- 5 interactive tools gate: Only `navigate`, `computer`, `form_input`, `find`, `read_page` trigger tips
- Per-tip Set deduplication: Each tip ID tracked, shown once per session
- Error exclusion: Tips never appended to error responses
- Session-scoped tracker: Tips reset on MCP server restart (new Claude Code session)

### Why This Feature

**Problem**: Agents using chrome-bridge MCP struggled with site-specific UI quirks. Browser automation tips existed only in docs/SETUP-GUIDE.md and were never shown to agents during actual browser automation.

**Solution**: Tips are now injected into chrome-bridge tool responses based on the site being visited. Agents see relevant guidance at the moment they need it.

## 2026-02-21 - CTO Dashboard: Per-Account Quota Bars in Usage Trajectory

### Added

**Per-account quota visualization** (4 files):
- `packages/cto-dashboard/src/components/UsageTrajectory.tsx` - Added `AccountQuotaBars` component showing per-account quota usage for 5-hour and 7-day windows
- Email-based deduplication: Multiple keys with the same `account_email` are merged to show one bar per account
- Invalid account filtering: Accounts with `status: 'invalid'` are excluded from display
- Truncated email labels: Shows first 20 chars + "..." for long email addresses
- Active account indicator: "*" suffix marks the currently active account
- `packages/cto-dashboard/src/App.tsx` - Passes `verifiedQuota` and `accountOverview` props to `UsageTrajectory`
- `packages/cto-dashboard/src/mock-data.ts` - Updated mock data to 3 distinct accounts for realistic quota bar rendering

### Fixed

**Zod schema bug in account-overview-reader** (1 file):
- `packages/cto-dashboard/src/utils/account-overview-reader.ts` - Fixed critical schema parsing bug
- Root cause: Strict Zod schema expected `resets_at` as string, but actual data includes Date objects (from active keys) and ISO strings (from exhausted keys)
- Schema also expected `account_uuid` and `account_email` as required strings, but some keys have null values
- Result: Entire parse failed with `hasData: false`, causing quota bars to never render in production
- Fix: Changed `resets_at` to `z.unknown()`, `account_uuid` and `account_email` to `.nullable().optional()`
- This was the root cause preventing quota bars from showing in production (entire parse was failing)

### Tests

**New test files** (2 files):
- `packages/cto-dashboard/src/components/__tests__/UsageTrajectory.test.tsx` - Updated for new props, added 7 new tests for deduplication and filtering (36 tests total, up from 29)
- `packages/cto-dashboard/src/utils/__tests__/account-overview-reader.test.ts` - New comprehensive test suite with 38 tests covering schema parsing, sorting, events, edge cases (96% statement coverage)

**Test results**:
- 760 tests pass across 22 test files (up from 719 across 21)
- Build passes (TypeScript compiles)
- Mock dashboard renders correctly with 3 accounts
- Live dashboard renders correctly with 4 real accounts (filtered from 32 keys)
- `generate-readme.js` successfully regenerates README with quota bars visible

### Documentation

- README.md updated via `generate-readme.js` to show per-account quota bars in USAGE TRAJECTORY section
- Bars display format: `Total`, then individual accounts with usage percentages and progress bars

## 2026-02-21 - Merge Chain Enforcement: Local Guards, Worktrees, and Stale Work Detection

### Added

**Local branch protection guards** (2 files):
- Pre-commit guard blocks direct commits to `main`, `staging`, `preview` - enforcement in `.claude/hooks/pre-commit-review.js`
- Pre-push guard blocks direct pushes to protected branches - enforcement in `templates/config/husky/pre-push.template`
- Both guards are unbypassable (cannot be disabled with `--no-verify`)
- Exception: Promotion pipeline agents with `GENTYR_PROMOTION_PIPELINE=true` environment variable
- Provides immediate local feedback before attempting forbidden operations

**Git worktrees for concurrent agents** (2 files):
- `.claude/hooks/lib/worktree-manager.js` - Worktree lifecycle management (create, provision, cleanup)
- `.claude/hooks/lib/feature-branch-helper.js` - Branch naming and protection checks
- Enables multiple agents to work concurrently on separate feature branches without checkout conflicts
- Each agent gets isolated working directory at `.claude/worktrees/<branch-name>/`
- Worktree provisioning: symlinks to `.claude/agents/`, `.claude/hooks/`, `.husky/`, generates worktree-specific `.mcp.json`
- State isolation: SQLite databases remain in main project, shared via `CLAUDE_PROJECT_DIR`
- Automatic cleanup after branch merged to preview (6-hour cycle)

**Stale work detection** (1 file):
- `.claude/hooks/stale-work-detector.js` - Detects uncommitted changes, unpushed commits, and stale feature branches (3+ days)
- Runs every 24 hours via hourly automation
- Reports to deputy-CTO with category `git-hygiene`
- Surfaced in `/deputy-cto` briefing under "Merge Chain Status"

**Deputy-CTO merge chain integration** (2 files):
- `packages/mcp-servers/src/deputy-cto/server.ts` - Added `get_merge_chain_status` MCP tool
- `.claude/commands/deputy-cto.md` - Updated briefing to include merge chain status (commits ahead, active branches, stale branches)
- Provides structured view of feature branches, promotion pipeline status, and stale work

**Template files for setup.sh** (2 files):
- `CLAUDE.md.gentyr-section` - GENTYR framework instructions template (includes Team Spawning section)
- `CLAUDE.md.makerkit-section` - Makerkit integration instructions template
- Used by `scripts/setup.sh` to inject framework and integration docs into project CLAUDE.md files

### Changed

**Agent spawning uses worktrees** (3 files):
- `.claude/hooks/hourly-automation.js` - Task agent spawning now creates worktrees and uses `cwd: worktreePath`
- `.claude/agents/code-writer.md` - Added feature branch workflow section (git workflow, PR creation, merge completion)
- `.claude/agents/test-writer.md` - Added worktree awareness and feature branch context

**Gitignore template** (1 file):
- `templates/config/gitignore.template` - Added `.claude/worktrees/` to prevent worktree tracking

### Documentation

**DEPLOYMENT-FLOW.md** (1 file):
- Added "Local Branch Protection" section documenting pre-commit and pre-push guards
- Added "Git Worktrees for Concurrent Agents" section documenting worktree architecture
- Added "Stale Work Detection" section documenting detection categories and integration
- Updated "Feature Branch Workflow" section to mention automated branch creation

**Implementation plan** (1 file):
- Created `/Users/jonathantodd/.claude/plans/sequential-sprouting-map.md` - Complete 3-phase implementation plan
  - Phase 1: Local branch guards (pre-commit + pre-push)
  - Phase 2: Worktrees + feature branch auto-creation
  - Phase 3: Stale work detection + deputy-CTO integration

### Impact

This implementation makes the merge chain airtight with local enforcement, enables concurrent agent workflows via worktrees, and provides CTO visibility into stale work. All enforcement happens before remote operations, providing immediate feedback and preventing forbidden merges at the earliest possible point.

## 2026-02-20 - Slash Command Detection Fix

### Fixed

**Slash commands not being recognized by UserPromptSubmit hooks** (2 files):
- Root cause: Hooks receive JSON stdin like `{"prompt":"/restart-session",...}` but were only checking for HTML sentinel markers that exist in expanded .md content
- Impact: All 10 GENTYR slash commands were non-functional
- Fix: Added `extractPrompt()` to parse JSON stdin and extract raw prompt field
- Fix: Added `matchesCommand()` to check both bare `/command-name` and sentinel markers
- Files changed:
  - `.claude/hooks/slash-command-prefetch.js` - Added JSON parsing for command detection (lines 66-90)
  - `.claude/hooks/cto-notification-hook.js` - Updated slash command suppression logic (lines 507-519)

### Tests

- **slash-command-detection**: 30/30 pass (new test file validates extractPrompt and matchesCommand)
- **cto-notification-hook**: 26/26 pass (8 new tests for slash command suppression)

## 2026-02-20 - Credential File Guard: Tiered Blocking with CTO Approval

### Added

**CTO-approvable file access for credential-file-guard** (8 files):
- Split blocked credential files into two protection tiers:
  1. **Always-blocked** - protection-key, approval tokens, .env files - hard deny with no escape hatch
  2. **Approvable** - services.json, .mcp.json, api-key-rotation.json, credential-provider.json, vault-mappings.json - deny with CTO approval code
- Approval flow via approval-utils.js: create HMAC-signed request → deputy-CTO generates one-time code → user types code → hook validates HMAC + expiry
- Files changed:
  - `.claude/hooks/credential-file-guard.js` - Core tiered blocking logic with approval flow integration
  - `.claude/hooks/protected-actions.json` - Added `files` section with 5 approvable file configs
  - `.claude/hooks/protected-action-approval-hook.js` - Updated `getValidPhrases()` to include file phrases
  - `.claude/hooks/lib/approval-utils.js` - Updated `createRequest` to add HMAC signature, argsHash, approval_mode
  - `packages/mcp-servers/src/deputy-cto/server.ts` - Fixed HMAC argsHash bug in `approveProtectedAction`, added `files` field to TypeScript interface

### Fixed

**Deputy-CTO HMAC argsHash bug**:
- `approveProtectedAction` was missing `argsHash` in HMAC computation (both verify and sign paths)
- Would cause "FORGERY DETECTED" errors for gate-originated approval requests
- Fixed by adding `argsHash` to `computeHmac(phrase, action, argsHash)` calls in verify and sign paths
- Added 7 new test cases in `packages/mcp-servers/src/deputy-cto/__tests__/hmac-argshash.test.ts`

### Tests

- **credential-file-guard**: 117/117 pass (13 new tests for approval flow)
- **approval-hook**: 18/18 pass (8 new tests in `protected-action-approval-hook-files.test.js`)
- **MCP servers**: 939/939 pass (7 new HMAC argsHash tests)

### Known Follow-up Items

1. HIGH: `checkApproval()` in approval-utils.js lacks HMAC verification (mitigated by ALWAYS_BLOCKED_SUFFIXES on approval file)
2. MEDIUM: Runtime files (.claude/hooks/.claude/) committed by prior checkpoint - need git rm --cached and .gitignore update (RESOLVED)
3. MEDIUM: HMAC key handling inconsistency (raw Buffer vs base64 string) between createRequest and computeHmac
4. MEDIUM: No HMAC integrity tests for credential-file-guard approval flow
5. LOW: Grep/Glob tools don't support approval path (intentional hard-block only)

## 2026-02-20 - Protection System: Fix Token File EACCES Errors

### Fixed

**Token file handling under sticky-bit protection** (4 files):
- Root cause: `commit-approval-token.json` was missing from pre-creation loop in `setup.sh`, and hooks used `fs.unlinkSync()` (delete semantics) to clear tokens, which fails under sticky-bit protection on `.claude/`
- Changes:
  1. **`scripts/setup.sh`** - Added `commit-approval-token.json` to pre-creation loop (line 603)
  2. **`.claude/hooks/pre-commit-review.js`** - Changed 2 `unlinkSync` calls to `writeFileSync(path, '{}')` pattern, added empty-object early-exit check
  3. **`.claude/hooks/block-no-verify.js`** - Changed 7 `unlinkSync` calls to `clearToken()` helper using overwrite pattern, added empty-object early-exit check
  4. **`packages/mcp-servers/src/deputy-cto/server.ts`** - Changed 2 `unlinkSync` calls to `writeFileSync(path, '{}')`, added empty-object early-exit check
- Result: All token files can now be safely written/cleared under sticky-bit protection without EACCES errors
- Pattern: Pre-create file during setup → overwrite with data to activate → overwrite with `{}` to consume/clear → treat `{}` as "no token"

### Documentation

**Created `docs/shared/EPHEMERAL-STATE-FILES.md`**:
- Comprehensive guide to the pre-create + overwrite pattern for ephemeral state files
- Lists all 6 state files using this pattern with their writers/consumers
- Step-by-step instructions for adding new state files
- Common mistakes and how to avoid them
- Critical for maintaining sticky-bit protection compatibility

### Validation

- Code review: CLEAN, no violations
- Test writer: No test updates needed (existing tests don't test token clearing behavior directly)
- Pre-existing test failures confirmed (unrelated to changes)
- TypeScript compiles clean with project tsconfig
- All JS files pass syntax check

## 2026-02-20 - Usage Optimizer: Per-Account Deduplication Fix

### Fixed

**Double-counting bug in usage optimizer and dashboard** (`.claude/hooks/usage-optimizer.js`, `packages/cto-dashboard/src/utils/data-reader.ts`):
- Root cause: When the same Anthropic account was discovered through multiple sources (environment variable, rotation state, Keychain, credentials file), each discovery was treated as a separate key for quota calculations
- Result: Usage projections were inflated, causing premature throttling and incorrect dashboard metrics
- Fix: `getApiKeys()` now includes `accountId` field (from `account_uuid`) in all returned key objects
- `collectSnapshot()` deduplicates keys by `accountId` before building snapshots, using fingerprint fallback (`fp:${five_hour}:${seven_day}`) when `accountId` is null
- `getKeyRotationMetrics()` in dashboard reader performs same per-account deduplication for consistent metrics
- Warning messages changed from "Key" to "Account" to reflect deduplication scope

### Tests

- **Updated 3 existing tests** in `.claude/hooks/__tests__/usage-optimizer.test.js`:
  - `getApiKeys()` structure test now asserts `accountId` field presence
  - `collectSnapshot()` tests updated for new `rawKeyData`/`keyLookup`/`accountMap` variables
  - Warning message assertions changed from "Key" to "Account"
- **Added 6 new behavioral tests** in "Per-Account Deduplication" describe block:
  - Deduplication by `accountId` when present
  - Fingerprint fallback when `accountId` is null
  - `accountId` preference over fingerprint when both exist
  - `accountId` field presence in all key source objects (env, rotation state, keychain, credentials)
- **Updated dashboard tests** in `packages/cto-dashboard/src/utils/__tests__/data-reader.test.ts`:
  - `getKeyRotationMetrics()` tests updated for account deduplication logic
- All 173 optimizer tests passing (was 167)
- All 662 dashboard tests passing

### Impact

This fix ensures accurate quota tracking when using multi-source credential discovery. Projects with the same account configured in both environment variables and rotation state will no longer show inflated usage projections or premature automation throttling.

---

## 2026-02-20 - macOS Compatibility: Setup Script Group Name Fix

### Fixed

**macOS "illegal group name" error in setup scripts** (`scripts/setup-automation-service.sh`, `scripts/protect-framework.sh`, `scripts/setup.sh`):
- Root cause: macOS does not create a default group matching the username; commands like `chown $SUDO_USER:$SUDO_USER` fail with "illegal group name"
- Fix: Replaced hardcoded `$SUDO_USER:$SUDO_USER` with `$SUDO_USER:$(id -gn "$SUDO_USER" 2>/dev/null || echo staff)` at 3 call sites (setup-automation-service.sh lines 181, 231; similar patterns in protect-framework.sh and setup.sh)
- Hardened `get_original_group()` function with explicit empty-check and OS-aware fallback (staff on Darwin, username on Linux)
- Lines affected: setup-automation-service.sh:181, 231; protect-framework.sh:118-127; setup.sh:170-179

### Added

**File Protection Error Handling documentation** (`.claude/agents/`, `CLAUDE.md.gentyr-section`):
- Added "Permission Denied on Protected Files" section to 3 agent configs: code-writer.md, code-reviewer.md, project-manager.md
- Added "File Protection Error Handling" section to CLAUDE.md.gentyr-section (deployed to target projects via setup.sh)
- Instructs agents to use `mcp__setup-helper__gentyr_setup({ action: "unprotect" })` when encountering Permission denied errors on protected files
- Prevents agents from attempting `chmod`/`chown` directly; enforces use of MCP tool for safe unprotect/protect workflow

**Protection System Documentation** (`docs/shared/PROTECTION-SYSTEM.md`):
- Comprehensive guide to GENTYR's 7-layer protection architecture
- Threat model, trust boundaries, and attack vectors prevented
- Layer-by-layer breakdown: Root Ownership, Protected Action Gate, MCP Server Allowlist, Credential File Guard, Bash Command Filter, Secret Leak Detector, Deputy-CTO Commit Review
- Fail-closed design principles and G001 compliance

### Impact

This fix enables GENTYR installation on macOS systems where the primary user does not have a matching group name (the default macOS configuration). Previously, `sudo scripts/setup.sh --protect` would fail with "chown: illegal group name" errors during systemd service setup and file protection operations.

---

## 2026-02-20 - Usage Optimizer: Remove Factor Caps for Aggressive Throttling

### Changed

**Usage optimizer factor range expansion** (`.claude/hooks/usage-optimizer.js`):
- MAX_FACTOR: 2.0 to 20.0 (up to 20x speedup; MIN_EFFECTIVE_MINUTES=5 is the real ceiling)
- MIN_FACTOR: 0.5 to 0.05 (up to 20x slowdown; sufficient to essentially pause automation)
- Recovery threshold: `currentFactor <= MIN_FACTOR + 0.01` to `currentFactor <= 0.15` with explanatory comment (threshold now independent of MIN_FACTOR value)
- MAX_CHANGE_PER_CYCLE: 0.10 unchanged (factor moves at most ±10% per cycle)
- MIN_EFFECTIVE_MINUTES: 5 unchanged (no cooldown goes below 5 minutes)

**Rationale**: The previous 0.5-2.0 range limited the optimizer to only 2x slowdown/speedup. When aggressive throttling was needed (e.g., approaching quota ceiling), the factor hit the floor and couldn't go lower. The new 0.05-20.0 range provides 20x dynamic range in both directions while preserving safety invariants.

### Tests

- **Updated 6 existing assertions** in `.claude/hooks/__tests__/usage-optimizer.test.js`:
  - Constant value regexes for MIN_FACTOR (0.05), MAX_FACTOR (20.0)
  - Recovery threshold detection regex
  - Behavioral recovery test values
- **Added 10 new boundary tests**:
  - 5 extreme factor boundary tests (MIN_EFFECTIVE_MINUTES floor enforcement, extreme slowdown scenarios)
  - 5 recovery threshold boundary tests (inclusive/exclusive boundary, independence from MIN_FACTOR)
- All 166 tests passing (was 156 tests)

### Fixed

**Documentation alignment**:
- Updated `docs/AUTOMATION-SYSTEMS.md` to reflect new 0.05-20.0 range (was 0.5-2.0)
- Factor effects table now shows full dynamic range examples
- Recovery threshold documentation updated to reflect 0.15 fixed value

### Impact

The usage optimizer can now throttle automation by up to 20x when approaching quota limits, preventing quota exhaustion in high-utilization scenarios. The 0.15 recovery threshold ensures the optimizer doesn't get trapped at extreme slowdown when usage drops far below target.

---

## 2026-02-20 - Secret-Sync MCP Server: Security Hardening

### Fixed

**HIGH: Path traversal vulnerability via confFile parameter** (`packages/mcp-servers/src/secret-sync/types.ts`, `packages/mcp-servers/src/secret-sync/server.ts`):
- Schema-level defense: Added Zod regex `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` to `confFile` field in `ServicesConfigSchema` to reject path traversal attempts (line 56)
- Runtime boundary check: Added `safeProjectPath()` helper function to verify resolved paths stay within project directory (defense-in-depth)
- Updated both `confFile` construction sites in `syncSecrets` and `listMappings` tools to use `safeProjectPath()` instead of bare `path.join()`
- Blocks 50+ attack vectors: null bytes, Unicode normalization tricks, symlink targets, URL-encoded traversal sequences, backslashes, etc.

**MEDIUM: Protected services.json from agent modification** (`.claude/hooks/credential-file-guard.js`, `scripts/protect-framework.sh`):
- Added `.claude/config/services.json` to credential-file-guard BLOCKED_PATH_SUFFIXES array (prevents write/overwrite operations)
- Added to protect-framework.sh PROTECTED_FILES array for root ownership enforcement when `--protect` flag is used

**MEDIUM: Removed "local" from "all" target expansion** (`packages/mcp-servers/src/secret-sync/server.ts`):
- All three tool functions (`syncSecrets`, `listMappings`, `verifySecrets`) now expand "all" to 3 remote targets only: `['render-production', 'render-staging', 'vercel']`
- Local file system operations now require explicit opt-in (`target: 'local'`)
- Prevents accidental writes to project directory when agent uses `target: 'all'`

**LOW: Added op-secrets.conf to .gitignore** (`.gitignore`):
- Prevents accidental commits of generated local secrets configuration file
- Placed in "Generated secret config" section with clear comment

### Tests

- **New security defense tests**: `packages/mcp-servers/src/secret-sync/__tests__/secret-sync.test.ts` (12 new tests, 79 total in file)
  - Zod schema rejection tests: path traversal strings (`../../../etc/passwd`), absolute paths, empty strings, Unicode normalization attacks
  - `safeProjectPath` boundary check tests: symlink resolution, null byte injection, directory escape attempts
  - "all" target expansion verification: ensures local is excluded from remote batch operations
  - Attack vector coverage: 50+ malicious path patterns tested
- All 873 tests passing (23 test files across MCP servers, hooks, and dashboard)
- TypeScript build: clean
- Code review: PASS (no violations)

### Changed

**Files modified (6 total):**
- `packages/mcp-servers/src/secret-sync/types.ts` (added regex validation to confFile schema)
- `packages/mcp-servers/src/secret-sync/server.ts` (added `safeProjectPath()` helper, updated 2 construction sites)
- `.claude/hooks/credential-file-guard.js` (added services.json to blocked paths)
- `scripts/protect-framework.sh` (added services.json to protected files)
- `.gitignore` (added op-secrets.conf)
- `packages/mcp-servers/src/secret-sync/__tests__/secret-sync.test.ts` (12 new security tests)

### Impact

This hardening eliminates path traversal vulnerabilities in the secret-sync MCP server's local file operations. The multi-layer defense (Zod schema + runtime boundary check) ensures agents cannot write outside the project directory or modify protected configuration files, even with sophisticated attack patterns.

---

## 2026-02-20 - CTO Dashboard: Readonly Database Fix for Protected Directories

### Fixed

**SQLite WAL-mode readonly access in root-owned directories** (`packages/cto-dashboard/src/utils/readonly-db.ts`, `packages/mcp-servers/src/shared/readonly-db.ts`, `packages/vscode-extension/src/extension/readonly-db.ts`):
- Root cause: When `setup.sh --protect` makes `.claude/` root-owned, SQLite cannot create `-shm`/`-wal` files needed for WAL mode even with `{ readonly: true }` option
- Fix: Created `openReadonlyDb()` helper function (3 identical implementations for dashboard, MCP servers, and VS Code extension)
- Fallback strategy: On readonly directory error, copies database to `/tmp`, converts journal mode from WAL to DELETE, reopens as readonly, patches `close()` method to clean up temp file
- Applied to 25 call sites across 12 files: replaced `new Database(path, { readonly: true })` with `openReadonlyDb(path)`

### Changed

**Files modified (12 total):**
- `packages/cto-dashboard/src/utils/readonly-db.ts` (new, 56 lines)
- `packages/cto-dashboard/src/utils/data-reader.ts` (4 call sites)
- `packages/cto-dashboard/src/utils/deputy-cto-reader.ts` (1 call site)
- `packages/cto-dashboard/src/utils/timeline-aggregator.ts` (2 call sites)
- `packages/mcp-servers/src/shared/readonly-db.ts` (new, 51 lines)
- `packages/mcp-servers/src/cto-report/server.ts` (3 call sites)
- `packages/mcp-servers/src/deputy-cto/server.ts` (1 call site)
- `packages/mcp-servers/src/feedback-explorer/server.ts` (3 call sites)
- `packages/mcp-servers/src/user-feedback/server.ts` (1 call site)
- `packages/vscode-extension/src/extension/readonly-db.ts` (new, 51 lines)
- `packages/vscode-extension/src/extension/DataService.ts` (4 call sites)

### Tests

- **New test file**: `packages/cto-dashboard/src/utils/__tests__/readonly-db.test.ts` (20 tests, 418 lines)
  - Direct readonly open path (normal directories)
  - Fallback temp-copy path (readonly directories)
  - Temp file cleanup on `.close()`
  - Error propagation for non-readonly errors
- All 632 dashboard tests + 847 MCP server tests + 20 new tests passing
- TypeScript build: clean
- Code review: PASS (no violations)

### Impact

This fix enables the CTO dashboard, MCP servers, and VS Code extension to read SQLite databases in protected GENTYR installations where `.claude/` directories are root-owned. Previously, all three components would fail with `SQLITE_READONLY_DIRECTORY` errors when attempting to open databases for reading.

---

## 2026-02-20 - Autonomous Restartless Credential Rotation

### Implemented

**Unified proactive refresh and pre-expiry swap** (`.claude/hooks/quota-monitor.js`, `.claude/hooks/key-sync.js`):
- **Step 4b unified**: Combined expired-token refresh and approaching-expiry proactive refresh into single loop using `isExpired`/`isApproachingExpiry` variables
- **Shared expiry constant**: `EXPIRY_BUFFER_MS` (10 min) exported from `key-sync.js`, imported by `quota-monitor.js` for consistent timing
- **Proactive standby refresh**: Non-active tokens within 10 min of expiry are refreshed automatically to keep standby pool perpetually fresh
- **Pre-expiry restartless swap**: When active key approaches expiry and valid standby exists, writes standby to Keychain; Claude Code's `SRA()` (5 min buffer) or `r6T()` (401 recovery) picks up new token seamlessly without restart
- **Idle session coverage**: `key-sync.js` also performs proactive refresh and pre-expiry swap during `syncKeys()` runs (called every 10 min by launchd even when no Claude Code process is active)
- **Date.now() consistency**: Cached into `now4b` variable to prevent time drift within execution (matches `key-sync.js` pattern)

### Tests

- **New test file**: `.claude/hooks/__tests__/proactive-refresh-and-swap.test.js` (35 tests, 592 lines)
  - Step 4b: `EXPIRY_BUFFER_MS` import verification, `isApproachingExpiry` variable presence, refresh loop behavior
  - Step 4c: Pre-expiry restartless swap trigger logic, standby selection, `updateActiveCredentials()` call verification
  - `key-sync.js`: proactive refresh in `syncKeys()`, pre-expiry swap logic, shared constant export
  - Coverage: all new autonomous rotation behaviors across both files
- **Updated existing tests**: `.claude/hooks/__tests__/key-sync-expired-filter.test.js`, `.claude/hooks/__tests__/quota-monitor.test.js` (updated for new source patterns)
- **Total**: 130 hook tests passing (92 existing + 35 new + 3 updated)

### Documentation

- **Implementation guide**: `docs/sessions/2026-02-20-credential-rotation-experiments.md` updated with detailed coverage matrix, autonomous rotation architecture, and `SRA()`/`r6T()` recovery path analysis
- **CLAUDE.md**: Updated quota-monitor and key-sync sections with new proactive refresh and pre-expiry swap capabilities

### Research Findings

**Token expiry vs revocation behavior** (documented in `docs/sessions/2026-02-20-credential-rotation-experiments.md`):
- Naturally expired OAuth tokens return HTTP **401** (`authentication_error`) — **recoverable** by Claude Code's built-in `r6T()` retry handler
- Revoked tokens (via `refresh_token` grant) return HTTP **403** (`permission_error`) — **terminal**, no recovery
- This means `refreshExpiredToken()` inadvertently causes unrecoverable 403 by revoking the old token, when waiting for natural expiry would yield a recoverable 401

**Claude Code token architecture**:
- Uses `Authorization: Bearer <oauth-token>` with `anthropic-beta: oauth-2025-04-20` for `/v1/messages` calls
- `SRA()` proactive refresh fires 5 minutes before `expiresAt`: clears credential cache → re-reads from disk → if new valid token found, adopts it seamlessly
- `r6T()` fires on HTTP 401: clears cache → re-reads Keychain → retries with new credentials
- The `org:create_api_key` scope and API key creation endpoint are optional; Bearer auth is the primary path

**Restartless rotation strategy identified**: Write new account's token to Keychain/file without refreshing the old one. When old token expires → `SRA()` or `r6T()` picks up new token from disk → seamless recovery, no restart needed.

### Bugs Found

**Missing process kill in automated rotation** (`.claude/hooks/quota-monitor.js:318-354`):
- Automated session rotation spawns new `claude --resume` process but never kills the old one
- Interactive sessions correctly kill via `generateRestartScript()` with `kill -TERM`/`kill -9`
- Confirmed 33 orphaned processes consuming ~2GB total RAM

**Selective proxy routing in Bun** (informational):
- `HTTPS_PROXY` routes eval, profile, and mcp_servers calls through proxy
- `/v1/messages` (main SDK call) bypasses the proxy entirely
- Proxy-based 401 injection is not viable for triggering credential recovery

## 2026-02-19 - Credential Lifecycle: invalid_grant Sentinel, Dead-Key Pruning, Secret Manager Agent

### Added

**invalid_grant sentinel in `refreshExpiredToken`** (`.claude/hooks/key-sync.js`):
- `refreshExpiredToken` now returns the string `'invalid_grant'` (not `null`) when the OAuth server responds HTTP 400 + `{ error: 'invalid_grant' }`, distinguishing a permanently revoked refresh token from a transient network failure
- All 4 callers updated atomically: `syncKeys()`, `api-key-watcher.js`, `quota-monitor.js`, `stop-continue-hook.js`
- On `invalid_grant`: key status set to `'invalid'`, rotation log records `refresh_token_invalid_grant` reason, key excluded from all future rotation candidates

**`pruneDeadKeys()` garbage collection** (`.claude/hooks/key-sync.js`):
- New exported function removes keys with `status === 'invalid'` where `last_health_check` (or `added_at`) is older than 7 days
- Never prunes the currently active key
- Removes orphaned `rotation_log` entries that reference pruned keys
- Called automatically at the end of every `syncKeys()` run

**Dashboard event display** (`packages/cto-dashboard/src/utils/account-overview-reader.ts`):
- Added `refresh_token_invalid_grant` reason mapping to human-readable description "Refresh token revoked for {key}"

**CTO report key status breakdown** (`packages/mcp-servers/src/cto-report/`):
- `types.ts`: Added optional `expired_keys`, `invalid_keys`, `exhausted_keys` fields to `KeyRotationMetrics` interface
- `server.ts`: `getKeyRotationMetrics()` counts and returns those three fields

**Secret Manager Agent** (`.claude/agents/secret-manager.md`):
- New specialized agent for secret lifecycle management via GENTYR's 1Password-based system
- Operations-only: uses MCP tools (`secret-sync`, `onepassword`, `todo-db`, `agent-reports`) without editing files
- Handles: adding/rotating secrets, syncing to Render/Vercel, diagnosing missing runtime credentials, setting up local dev secrets
- Creates TODO tasks for code-writer when `services.json` changes are needed
- Reports security findings (shadow secrets, plain-type secrets, mismatched vault refs) to deputy-CTO

**`/setup-gentyr` Phase 2: Claude Account Inventory** (`.claude/commands/setup-gentyr.md`, `.claude/hooks/slash-command-prefetch.js`):
- New `getAccountInventory()` function in `slash-command-prefetch.js` reads rotation state, deduplicates accounts by `account_uuid`, and injects data into prefetch payload
- Phase 2 added to setup flow: displays current Claude account inventory (email, status, quota), offers guided login loop to add additional accounts for quota rotation
- Existing phases renumbered 3–8 (was 2–7)

### Tests

- **New test file:** `.claude/hooks/__tests__/invalid-grant-and-prune.test.js` (43 tests)
  - `refreshExpiredToken` sentinel return value verification across all 4 caller files (static analysis)
  - `pruneDeadKeys` behavior: prunes keys older than 7 days, never prunes active key, removes orphaned log entries
  - `syncKeys` marks key `invalid` and logs `refresh_token_invalid_grant` on sentinel
  - All callers handle sentinel path by marking key `invalid`
- All 135 hook tests passing (92 existing + 43 new)
- TypeScript build: clean

### Verification

- Code review: PASS — no violations, no security issues, TypeScript compiles clean
- Static analysis confirms sentinel string `'invalid_grant'` returned (not `null`) in HTTP 400 + error body path
- `pruneDeadKeys` never touches active key in all test scenarios

**Total Changes:** 1 new agent, 1 new test file, 7 modified files, 43 new tests, 135 hook tests passing

---

## 2026-02-18 - Binary Patching: Clawd Mascot Customization

### Added

**Clawd Mascot Patcher** (`scripts/patch-clawd.py`, ~600 lines):
- Version-agnostic binary patcher for Claude Code CLI mascot customization
- Replaces stock Clawd with #29 Winged Eye design (sparkle wings, dark pupil, amber bases)
- Structural pattern detection using regex instead of hardcoded offsets
- Dynamic variable extraction for React createElement calls
- Exact-length replacement with empty-string padding
- 9 validation gates before and after writing
- Atomic write via temp file + os.rename() to prevent corruption
- Idempotent operation: detects already-patched binary and skips
- CLI flags: --dry-run, --restore, --binary, --no-color
- Automatic codesign and xattr quarantine clearing
- Colored terminal output with detailed block analysis

**Binary Patching Documentation** (`docs/BINARY-PATCHING.md`):
- Complete guide to customizing the Clawd mascot in Claude Code binary
- Architecture explanation: Bun-compiled executable with embedded JS source
- Mascot function locations and offset discovery methods
- Theme color system and available color names
- Byte-count compensation techniques (empty string padding, string adjustment)
- Current design specification: #29 Winged Eye with unicode char reference
- Automated patching workflow with safety gates
- Manual patching fallback instructions
- Rollback procedures
- Technical lessons learned from binary patching experiments

### Fixed

**Code Review Fixes Applied:**
- CRITICAL: Raw string bug in unicode escape sequences (lines 462, 475) - used r-prefix raw strings to preserve literal \u sequences
- CRITICAL: Non-atomic write pattern - replaced direct file.write() with temp file + os.rename()
- MEDIUM: Dead code removed - unused brace_depth variable in return block extraction
- MEDIUM: Regex $ handling - fixed \w+ to [\w$]+ to match JavaScript identifiers with $
- LOW: Missing verification - added binary execution check after codesign recovery
- LOW: Incomplete mascot char list - added all quadrant block characters to detection set

### Tests

**Manual Testing:**
- --dry-run on patched binary: detects 4 blocks, all "already patched"
- --dry-run on stock binary: detects 4 blocks, builds correct replacements with exact byte match
- Full patch cycle: detect → backup → patch → codesign → verify
- Idempotency verified: re-run on patched binary does nothing
- Visual verification: mascot displays correctly in terminal

### Technical Details

**Design #29 Winged Eye:**
```
▗▘ ✦ ▝▖       Row 1: wing tips + sparkle (penguinShimmer)
▐▌ ● ▐▌       Row 2: wings + dark pupil (penguinShimmer wings, clawd_body eye)
 ▀   ▀        Row 3: wing bases (chromeYellow)
```

**Pattern Detection:**
- Searches for flexDirection:"column",alignItems:"center" + clawd_body + mascot unicode chars
- Extracts React import variable (e.g., x$, mB) dynamically
- Extracts Flex and Text component variables dynamically
- Builds replacement with exact byte count using empty-string padding (,"")

**Safety Mechanisms:**
- Byte count verification before and after every replacement
- Binary execution test after patching
- Automatic backup creation before any write
- Codesign restoration with verification
- Idempotent operation prevents double-patching corruption

---

## 2026-02-18 - CTO Dashboard: Account Overview Section

### Added

**Account Overview Section** (`packages/cto-dashboard/`):
- New `account-overview-reader.ts` data reader module (~226 lines)
  - Parses `~/.claude/api-key-rotation.json` for per-account details and rotation events
  - Reads key metadata: status, subscription type, email, expiry, usage quotas
  - Filters and formats rotation event log (last 24h, max 20 events, excludes noisy health_check events)
  - Account sorting: current key first, then by status (active → exhausted → expired → invalid), then by added date
- New `AccountOverviewSection.tsx` component (~115 lines)
  - Per-account table with truncated key IDs, status indicators, subscription type, email, expiry date
  - Per-key quota bars: 5h, 7d, and conditional 7d-sonnet (only shown if >10pp difference from 7d)
  - Event history timeline (last 24h) with color-coded event types and timestamps
  - Title shows account count and 24h rotation count
- Mock data integration in `mock-data.ts`
  - `getMockAccountOverview()` returns 3 mock accounts with realistic quota spreads
  - 8 mock rotation events covering all event types (key_added, key_switched, key_exhausted, key_removed)
- Section wired into `App.tsx` between Quota & System Status and Deputy CTO sections
- Barrel export added to `components/index.ts`

### Fixed

**Code Review Findings (all addressed):**
- HIGH: React key collision risk — truncated 8-char key IDs used as React keys caused potential collisions
  - Fixed by adding index suffix: `key={`${account.keyId}-${idx}`}` for AccountRow components
- MEDIUM: Dead fields removed — `fiveHourResetsAt` and `sevenDayResetsAt` were always null (reset times now stored in rotation state)
  - Removed from `AccountKeyDetail` interface
- MEDIUM: Module-level constant prevents testability — `KEY_ROTATION_STATE_PATH` was a module-level constant
  - Refactored to lazy getter function `getKeyRotationStatePath()` for test isolation

### Tests

- **New test file:** `packages/cto-dashboard/src/components/__tests__/AccountOverviewSection.test.tsx` (30 tests)
  - Empty state rendering
  - Account table structure and ordering (current key first, then by status)
  - Quota bar rendering with conditional 7d-sonnet logic
  - Event history formatting and color coding
  - Edge cases: missing emails, no expiry dates, null usage data
- **Modified:** `mock-data.ts` — added `getMockAccountOverview()` function
- **Modified:** `account-overview-reader.ts` — fixed React key collision, removed dead fields, refactored path getter
- All 632 tests passing across 18 test files (up from 602)
- TypeScript build: clean
- README generation: clean (Account Overview section renders in mock mode)

### Verification

**Live Mode Testing:**
- Dashboard renders 12 real accounts from `~/.claude/api-key-rotation.json`
- Event history shows 8 rotation events from last 24h
- Quota bars display correct percentages from last_usage snapshots
- Current key marked with `*` prefix and cyan color

**Mock Mode Testing:**
- `npm run generate:readme` successfully regenerates README with Account Overview section
- Mock data shows 3 accounts with varied statuses (active, exhausted) and quota spreads
- Event timeline demonstrates all event type color coding

**Total Changes:** 2 new files, 4 modified files, 30 new tests, 632 total tests passing

---

## 2026-02-18 - Automatic Account Rotation & Session Recovery

### Added

**Quota Monitor Hook** (`.claude/hooks/quota-monitor.js`, ~230 lines):
- PostToolUse hook that monitors API quota usage every 5 minutes
- Triggers credential rotation at 95% utilization threshold
- Interactive sessions: spawns auto-restart script with new credentials
- Automated sessions: writes quota-interrupted state for session-reviver pickup
- All-accounts-exhausted detection: writes paused-sessions.json with pause reason and timestamp
- Cooldown protection: 10-minute rotation cooldown prevents rotation loops

**Session Reviver Hook** (`.claude/hooks/session-reviver.js`, ~320 lines):
- Called from hourly-automation.js to recover interrupted automated sessions
- Mode 1 (Quota-interrupted pickup): Reads quota-interrupted-sessions.json and re-spawns sessions with --resume after credential rotation
- Mode 2 (Historical dead session recovery): Scans agent-tracker-history.json for unexpectedly dead agents (process_already_dead) within last 7 days and re-spawns pending TODOs
- Mode 3 (Paused session resume): Reads paused-sessions.json and checks if any account has recovered, then resumes paused sessions
- Limits: Max 3 revivals per cycle, 7-day historical window
- TODO reconciliation integration with reap-completed-agents.js

**Recovery CLI Script** (`scripts/recover-interrupted-sessions.js`, ~200 lines):
- One-time manual recovery tool for interrupted sessions
- Accepts `--path`, `--dry-run`, `--max-concurrent` flags
- Cross-references agent-tracker-history with TODO database
- Identifies in_progress tasks with no corresponding live process
- Re-spawns sessions with original task context

### Changed

**Key Sync Module** (`.claude/hooks/key-sync.js`):
- Exported `checkKeyHealth()`, `selectActiveKey()`, `HIGH_USAGE_THRESHOLD` (80%), `EXHAUSTED_THRESHOLD` (95%) for reuse
- Added 120 lines of public API functions for credential rotation workflows

**API Key Watcher** (`.claude/hooks/api-key-watcher.js`):
- Refactored to use shared functions from key-sync.js (~100 lines removed, +10 added)
- Moved `checkKeyHealth`, `selectActiveKey`, threshold constants to imports
- Added local `ANTHROPIC_BETA_HEADER` constant for `fetchAccountProfile`

**Agent Tracker** (`.claude/hooks/agent-tracker.js`):
- Added `SESSION_REVIVED` to `AGENT_TYPES`
- Added `QUOTA_MONITOR` and `SESSION_REVIVER` to `HOOK_TYPES`

**Slash Command Prefetch** (`.claude/hooks/slash-command-prefetch.js`):
- Made 6 utility functions into named exports: `getSessionDir`, `discoverSessionId`, `getClaudePid`, `detectTerminal`, `shellEscape`, `generateRestartScript`
- Enables reuse in quota-monitor.js for restart script generation

**Settings Template** (`.claude/settings.json.template`):
- Added PostToolUse section registering quota-monitor.js

**Stop-Continue Hook** (`.claude/hooks/stop-continue-hook.js`):
- Added quota death detection: reads session JSONL for rate_limit errors
- Attempts credential rotation on quota death
- Writes recovery state to quota-interrupted-sessions.json for session-reviver pickup
- Fixed full-file read replaced with head-only read (4KB) for performance

**Reap Completed Agents** (`scripts/reap-completed-agents.js`):
- Added TODO reconciliation: marks completed or resets to pending based on reap reason
- Added `todoReconciled` field to result object

**Hourly Automation** (`.claude/hooks/hourly-automation.js`):
- Integrated session-reviver call after key-sync block with 10-minute cooldown

**Config Reader** (`.claude/hooks/config-reader.js`):
- Added `session_reviver: 10` (minutes) to cooldown defaults

### Fixed

**Code Review Fixes Applied:**
- CRITICAL: `ANTHROPIC_BETA_HEADER` undefined in api-key-watcher.js (now defined locally)
- HIGH: Full transcript file read in stop-hook replaced with 4KB head-read for performance
- MEDIUM: Changed `stdio: 'inherit'` to `'ignore'` in session-reviver.js to prevent stdio pollution
- MEDIUM: Stored only `resets_at` timestamp from raw API instead of full response object
- LOW: Default project path uses `process.cwd()` instead of hardcoded path
- LOW: `isProcessAlive` handles EPERM consistently across platforms

### Known Technical Debt

**Pre-existing Architectural Patterns (not introduced by this change):**
- Race condition on shared state files (no file locking) - systemic pattern across framework
- Duplicate utility functions (readHead, readTail, etc.) across multiple modules - consolidation candidate
- Inconsistent `getSessionDir` implementations across 4 files - should be unified

### Technical Details

**Recovery Workflow:**
1. Session hits quota limit during execution
2. Stop-continue-hook detects rate_limit error in JSONL tail
3. Attempts credential rotation via key-sync
4. Writes interrupted session state to quota-interrupted-sessions.json
5. Session-reviver picks up interrupted state during next hourly automation cycle
6. Re-spawns session with --resume flag and new credentials
7. Agent continues from interruption point

**Paused Sessions Workflow:**
1. Quota-monitor detects all accounts exhausted (all keys >= 95%)
2. Writes paused-sessions.json with pause reason and timestamp
3. Session-reviver checks paused state every hourly cycle
4. When any account recovers below 95%, resumes paused sessions
5. Logs recovery and clears paused state

**Files Created (3 total):**
- `.claude/hooks/quota-monitor.js` (230 lines)
- `.claude/hooks/session-reviver.js` (320 lines)
- `scripts/recover-interrupted-sessions.js` (200 lines)

**Files Modified (9 total):**
- `.claude/hooks/key-sync.js` (+120 lines)
- `.claude/hooks/api-key-watcher.js` (-100/+10 lines)
- `.claude/hooks/agent-tracker.js` (+3 lines)
- `.claude/hooks/slash-command-prefetch.js` (+6 exports)
- `.claude/settings.json.template` (+12 lines)
- `.claude/hooks/stop-continue-hook.js` (+130 lines)
- `scripts/reap-completed-agents.js` (+60 lines)
- `.claude/hooks/hourly-automation.js` (+20 lines)
- `.claude/hooks/config-reader.js` (+1 line)

**Total Changes:** +750 lines added across 12 files

---

## 2026-02-18 - Deputy-CTO Identity Injection and Investigator Session History

### Changed

**`/deputy-cto` command now fully assumes the deputy-CTO identity** by receiving the agent's complete knowledge base at session start, rather than operating as a generic assistant following session flow instructions.

**Prefetch hook — agent instructions injection** (`.claude/hooks/slash-command-prefetch.js`):
- `handleDeputyCto()` now reads `.claude/agents/deputy-cto.md` at hook invocation time
- Strips YAML frontmatter (between `---` markers) before injecting content
- Injects the stripped markdown as `agentInstructions` in the prefetch output under `gathered.agentInstructions`
- Non-fatal: if the agent file is missing, `agentInstructions` is set to `null` and the hook continues normally

**Deputy-CTO command — "Your Identity" section** (`.claude/commands/deputy-cto.md`):
- Added a new "Your Identity" section before "Session Behavior"
- Instructs Claude to locate the `agentInstructions` field injected by the prefetch hook and absorb it as its own identity
- Clarifies interactive-session differences from autonomous mode (wait for CTO input, present options rather than deciding unilaterally, use `AskUserQuestion` for batch review)

**Investigator agent — mandatory session history search** (`.claude/agents/investigator.md`):
- Added "Claude Session History (MANDATORY)" section with a table of `mcp__claude-sessions__*` tools (`search_sessions`, `list_sessions`, `read_session`)
- Session history search is now step 1 in the Investigation Workflow (was previously absent); all subsequent steps shifted from 1-7 to 2-8
- Prevents circular re-investigation of previously-explored issues and surfaces decisions not captured in code or docs

### Why This Matters

**Deputy-CTO identity**: Previously, `/deputy-cto` sessions ran Claude as a generic assistant following the command's session flow instructions. The deputy-cto agent's commit review criteria, decision framework, powers, and operating modes were only available in autonomous (pre-commit hook) contexts. Now both paths use the same identity and knowledge base, giving interactive CTO briefing sessions the full context they need to accurately represent the agent's standing policies and decision criteria.

**Investigator session history**: AI agents frequently re-investigate the same problems across sessions. The mandatory session history step surfaces prior work, failed approaches, and decisions before the agent spends time rediscovering them.

### Audit

All 10 slash commands were audited. The remaining 8 commands already follow their correct patterns and required no changes.

**Files Modified (3 total):**
- `.claude/hooks/slash-command-prefetch.js` - ~12 lines added to `handleDeputyCto()`
- `.claude/commands/deputy-cto.md` - ~8 lines added (new "Your Identity" section)
- `.claude/agents/investigator.md` - ~25 lines added (mandatory session history section and workflow reorder)

---

## 2026-02-17 - CTO Dashboard: Elastic/Elasticsearch Integration Fixes

### Fixed

**Elasticsearch field mapping errors** (`packages/cto-dashboard/src/utils/logging-reader.ts`, `packages/cto-dashboard/src/utils/infra-reader.ts`):
- Terms aggregations were failing with HTTP 400 errors because fields (`level`, `service`, `module`) are mapped as `text` type in the Elastic Serverless deployment and require the `.keyword` suffix for aggregations
- Updated all terms aggregation fields: `level` -> `level.keyword`, `service` -> `service.keyword`, `module` -> `module.keyword`
- Updated term filter fields in top-errors and top-warnings queries to use `level.keyword`

**Elasticsearch endpoint resolution** (`packages/cto-dashboard/src/utils/credentials.ts`):
- Dashboard previously only looked for `ELASTIC_ENDPOINT`; Elastic Cloud hosted deployments use `ELASTIC_CLOUD_ID` (base64-encoded Cloud ID format) instead
- Added `resolveElasticEndpoint()` helper: tries `ELASTIC_ENDPOINT` first, then decodes `ELASTIC_CLOUD_ID` (splits on `:`, base64-decodes the second segment, extracts the ES host from the `$`-delimited decoded string)
- Both `logging-reader.ts` and `infra-reader.ts` updated to call `resolveElasticEndpoint()` instead of `resolveCredential('ELASTIC_ENDPOINT')` directly

**Storage estimation 403 fallback** (`packages/cto-dashboard/src/utils/logging-reader.ts`):
- `queryStorage()` was calling `_cat/indices` which requires the `monitor` cluster privilege; the read-only API key returns 403
- On a 403 response `queryStorage()` now falls back to doc-count estimation (total document count × estimated bytes-per-doc) instead of returning null storage data

### Added

**`ELASTIC_API_KEY_WRITE` vault mapping** (`vault-mappings.json`):
- Added mapping for write-capable Elastic API key to support log ingestion use cases
- Read-only key (`ELASTIC_API_KEY`) continues to be used by dashboard queries

**Sample log data seeding:**
- Ingested 200 realistic sample log entries into the Elastic Serverless deployment covering multiple services, levels, and modules
- Verified all dashboard queries (timeseries, level/service breakdowns, top errors/warnings) return correct data after seeding

### Tests

- 47 new tests in `packages/cto-dashboard/src/utils/__tests__/credentials.test.ts` covering:
  - `resolveElasticEndpoint()`: `ELASTIC_ENDPOINT` priority, `ELASTIC_CLOUD_ID` base64 decode path, malformed Cloud ID handling
  - `.keyword` field naming: all aggregation and filter fields use the `.keyword` suffix
  - Storage 403 fallback: `queryStorage()` returns doc-count estimate when `_cat/indices` is unauthorized
- All 545 tests pass across 16 test files (up from 498)
- TypeScript builds clean
- Code review: PASS, no violations

**Total Changes:** 3 modified files, 1 vault-mappings.json update, 47 new tests, 545 total tests passing

---

## 2026-02-17 - CTO Dashboard: Layout Fixes, Environment-Based Deployments, Title-in-Border

### Changed

**Section Component — Title-in-Border Rendering** (`packages/cto-dashboard/src/components/Section.tsx`):
- Sections now render titles inline in the top border: `╭─ TITLE ──────╮`
- Uses `borderTop={false}` on the inner Box and a custom Text element for the top line
- All sections across the dashboard use this style automatically when a title prop is provided

**Deployments Section Restructure** (`packages/cto-dashboard/src/components/DeploymentsSection.tsx`, `packages/cto-dashboard/src/utils/deployments-reader.ts`):
- Added `DeployEnvironment` type (`preview | staging | production`) and `inferEnvironment()` function to `deployments-reader.ts`
- `inferEnvironment()` classifies deploys by service name keywords (`staging`, `stg`, `preview`, `dev`) and Vercel `target` field, defaulting to `production`
- Added `byEnvironment` grouping (`preview`, `staging`, `production` arrays, newest-first, up to 5 each) to `DeploymentsData`
- Replaced old platform-based layout (ServiceList/Render/Vercel split) with per-environment layout:
  - `EnvironmentHealth` component: Production/Staging/Preview side-by-side with health dot, last deploy time, and deploy count
  - `PipelineDetail` component: 3-stage pipeline (preview → staging → production) with check timestamps
  - `EnvironmentDeploys` per-environment table: time, status dot, service (24w), platform (9w), status (10w), commit message (25w)
  - `DeployStats` footer: 24h total, success rate, failure count, frequency

**Infrastructure Section Layout Fix** (`packages/cto-dashboard/src/components/InfraSection.tsx`):
- Restructured from 5-column card grid to clean tabular row layout
- Aligned columns: Provider (16w) | Status (14w) | Detail (20w) | Extra
- Each provider gets one row with consistent alignment and no wrapping

**Testing Section Chart Fix** (`packages/cto-dashboard/src/components/TestingSection.tsx`):
- Changed `yDomain` minimum from `1` to `5` for better chart readability when data values are low

### Tests

- 53 new tests in `packages/cto-dashboard/src/utils/__tests__/deployments-reader.test.ts` covering `inferEnvironment`, `normalizeRenderStatus`, `normalizeVercelStatus`, `truncateMessage`, `byEnvironment` grouping, and `stats` computation
- Fixed timing-sensitive `UsageTrends` test regex
- All 498 tests pass across 15 test files
- TypeScript builds clean

### Code Review

- All changes pass review with no violations
- No mocked/placeholder code, no credential leaks, no security regressions
- Pre-existing pattern noted: external API responses use TypeScript `as` casts rather than Zod validation (systemic, not a regression)

**Total Changes:** 4 modified files, 53 new tests, 498 total tests passing

---

## 2026-02-17 - Usage Optimizer and CTO Dashboard Bug Fixes

### Fixed

**Three interconnected bugs causing all automated instances to display "+100% slower":**

1. **Runaway 7-day projection** (`.claude/hooks/usage-optimizer.js`)
   - Linear rate extrapolation over long horizons (e.g. 155h remaining until 7d reset) was
     producing projections as high as 483%, which slammed the optimizer factor to MIN_FACTOR (0.5)
     and kept it there permanently — causing all automation cooldowns to double
   - Fix: Added `MAX_PROJECTION = 1.5` cap on both `projected5h` and `projected7d` to prevent
     linear extrapolation from producing nonsensical values

2. **No factor recovery** (`.claude/hooks/usage-optimizer.js`)
   - Once the factor reached MIN_FACTOR (0.5), the 10% MAX_CHANGE_PER_CYCLE limit prevented
     recovery as long as the inflated projection kept pushing the factor down each cycle
   - Fix: Added recovery clause — when factor is stuck at MIN_FACTOR AND current usage is below
     45% (half of the 90% target), the factor is reset to 1.0 and adjustment resumes normally

3. **Wrong display unit for projected_at_reset** (`packages/cto-dashboard/src/utils/automated-instances.ts`)
   - `projected_at_reset` is stored as a 0-1 fraction but was passed directly to the Footer
     component which expected a percentage integer — showing "5%" instead of "483%"
   - Fix: Multiply `projected_at_reset` by 100 when assigning to `currentProjected`

### Tests

- 11 new tests in `usage-optimizer.test.js` covering projection cap enforcement and factor recovery
- 10 new tests in `automated-instances.test.ts` covering `currentProjected` unit conversion
- All 54 automated-instances tests pass; all 132 usage-optimizer tests pass
- Code review: all 3 changes approved with no violations

**Total Changes:** 2 files modified, 21 new tests

---

## 2026-02-17 - CTO Dashboard: Deployments, Infrastructure, and Logging Overhaul

### Added

**Deployments Section Overhaul** (`packages/cto-dashboard/src/components/DeploymentsSection.tsx`, `packages/cto-dashboard/src/utils/deployments-reader.ts`):
- `PipelineDetail` component at the top showing a 3-stage pipeline (preview → staging → production) with timestamps
- Per-platform deploy tables: Render and Vercel each display 5 most recent deploys with service name (width 20), status, age (width 9), and commit message (width 30, constrained)
- `DeployStats` footer row: total deploy count, success rate, failure count, and deploy frequency
- `deployments-reader.ts` enriched with `lastPreviewCheck`, `lastStagingCheck`, and stats computation from deploy history

**Infrastructure Section Overhaul** (`packages/cto-dashboard/src/components/InfraSection.tsx`, `packages/cto-dashboard/src/utils/infra-reader.ts`):
- Per-platform event tables: Render deploy events and Vercel deployment events
- Load metrics: Render `lastDeployAt`, Vercel `buildingCount`, Cloudflare `planName`
- Cloudflare nameserver list added to display
- Elasticsearch detail row removed from InfraSection (moved to dedicated LOGGING section)
- `InfraSection` now accepts optional `deployments` prop to avoid duplicate Render/Vercel API calls
- Credential bug fixed: `CF_API_TOKEN` corrected to `CLOUDFLARE_API_TOKEN` (line 145 of `infra-reader.ts`)

**New LOGGING Section** (`packages/cto-dashboard/src/utils/logging-reader.ts`, `packages/cto-dashboard/src/components/LoggingSection.tsx`):
- `logging-reader.ts`: Elasticsearch queries for 24h volume timeseries (24 hourly buckets), level/service/source breakdowns, top 5 errors, top 5 warnings, storage estimates via `_cat/indices`, and source coverage assessment for 9 expected sources (api, worker, deployment, ci-cd, testing, database, cdn, auth, cron)
- `LoggingSection.tsx`: Full section with LineGraph (volume timeseries), BarCharts (by level, by service), top errors/warnings tables, source coverage dot indicators (active/low-volume/missing), and storage footer
- Wired into `index.tsx` via `getLoggingData` in `Promise.allSettled` parallel fetch block
- Wired into `App.tsx` between `InfraSection` and `FeedbackPersonas`
- Exported from `components/index.ts`

### Tests

- 45 new tests in `packages/cto-dashboard/src/utils/__tests__/logging-reader.test.ts` covering `parseSizeToBytes`, `assessSourceCoverage`, credential absence, storage estimation, `hasData` flag, and volumeTimeseries padding
- New `packages/cto-dashboard/src/components/__tests__/AutomatedInstances.test.tsx` — 35 tests (created in preceding session)
- All 445 tests pass across 14 test files
- TypeScript build compiles clean

### Code Review Findings (informational, not blocking)

- Duplicated `truncate`/`statusColor` utilities across 3 component files — candidate for shared `formatters.ts` extraction
- Render `updatedAt` used as proxy for `lastDeployAt` (documented with inline comment)
- URL validation on trusted credential store values (informational)

**Total Changes:** 3 new files, 7 modified files, 445 tests passing

---

## 2026-02-17 - CTO Dashboard: Token Usage Bar Chart and Testing Section Fixes

### Added

**Automated Instances — Token Usage Bar Chart:**

1. **Token usage by automation type** (`packages/cto-dashboard/src/utils/automated-instances.ts`)
   - New `getAutomationTokenUsage()` async function reads session JSONL files from `~/.claude/projects/`
   - Extracts `[Task][agent-type]` prefix from the first user message to identify automation sessions
   - Sums all token usage fields (input, output, cache read, cache creation) per session
   - Rolls up raw agent types into INSTANCE_DEFINITIONS display names
   - Helper functions: `getSessionDir()`, `buildAgentTypeToDisplayName()`, `SessionEntry` interface
   - `tokensByType: Record<string, number>` field added to `AutomatedInstancesData` type

2. **Bar chart rendering** (`packages/cto-dashboard/src/components/AutomatedInstances.tsx`)
   - Horizontal bar chart (via `@pppp606/ink-chart` `BarChart`) rendered between Footer and Tip
   - Conditionally shown only when `tokensByType` has entries
   - Values sorted descending, formatted with `formatNumber()`
   - Title: "Token Usage by Automation (24h)"

3. **Async data integration** (`packages/cto-dashboard/src/index.tsx`)
   - `getAutomationTokenUsage` added to `Promise.allSettled` parallel fetch block
   - Result merged into `automatedInstances.tokensByType` on success

### Fixed

**Testing Section agent breakdown display** (`packages/cto-dashboard/src/components/TestingSection.tsx`):
- Removed Jest from agent breakdown (not used by any agent type in testing-reader)
- Expanded "PW" abbreviation to full "Playwright" label
- Column width adjustments: COL_NAME 35→34, COL_AGE 9→10, COL_FW 9→11 for better alignment

### Tests

- **New:** `packages/cto-dashboard/src/components/__tests__/AutomatedInstances.test.tsx` — 35 tests covering empty state, table structure, footer, bar chart rendering, run counts, freq adjustments, until-next display, and render consistency
- **Updated:** `automated-instances.test.ts` — added `tokensByType` shape validation, 2 new describe blocks (11 tests) for JSONL parsing logic
- **Updated:** `TestingSection.test.tsx` — removed Jest assertions, uses "Playwright" label, updated zero-counts test data
- All 390 tests pass across 13 test files (up from 343/12)
- TypeScript build compiles clean

**Total Changes:** 1 new test file, 5 modified files, 390 tests passing

---

## 2026-02-17 - CTO Dashboard: Deployments, Infrastructure, and Testing Graph

### Added

**CTO Dashboard — New Sections and Shared Utilities:**

1. **Shared credential resolution module** (`packages/cto-dashboard/src/utils/credentials.ts`)
   - Common `resolveCredential()` function: env var → vault-mappings.json → `op read` chain
   - Shared `fetchWithTimeout()` helper used by all data readers
   - `loadOpTokenFromMcpJson()` for headless token resolution

2. **Deployments data reader** (`packages/cto-dashboard/src/utils/deployments-reader.ts`)
   - Fetches Render services and deploys, Vercel projects and deployments in parallel
   - All calls via `Promise.allSettled` with 10s timeouts (independently degradable)
   - Reads pipeline promotion state from local automation state file
   - Combines and sorts deploys from both platforms (newest first, up to 8)

3. **Infrastructure health reader** (`packages/cto-dashboard/src/utils/infra-reader.ts`)
   - 5-provider health queries: Render, Vercel, Supabase, Elasticsearch, Cloudflare
   - Each provider independently degradable — missing credentials or API failures return `{ available: false }`
   - Elasticsearch aggregation query returns 1h log totals, error/warn counts, top services

4. **DeploymentsSection component** (`packages/cto-dashboard/src/components/DeploymentsSection.tsx`)
   - Side-by-side Render service list and Vercel project list
   - Combined recent deploy timeline with platform badge and status color
   - Pipeline promotion state footer

5. **InfraSection component** (`packages/cto-dashboard/src/components/InfraSection.tsx`)
   - 5-provider health status row with colored dots
   - Elasticsearch logs detail row when available

### Modified

6. **TestingSection** (`packages/cto-dashboard/src/components/TestingSection.tsx`)
   - Replaced old 7-day sparkline with LineGraph using 42 x 4h buckets for higher resolution
   - Codecov sparkline retained

7. **testing-reader.ts** (`packages/cto-dashboard/src/utils/testing-reader.ts`)
   - Added `testActivityTimeseries` field (42 buckets, 4h resolution, ~7-day window)
   - Switched to shared credentials module

8. **App.tsx** — Renders DeploymentsSection and InfraSection between Testing and FeedbackPersonas

9. **index.tsx** — Fetches deployments and infra data in parallel at startup

10. **components/index.ts** — Added exports for DeploymentsSection and InfraSection

### Fixed

- **Vercel availability bug** (`infra-reader.ts`): `errorDeploys >= 0` always-true check replaced with `available: true` inside success path

### Tests

- Updated 3 test cases in `TestingSection.test.tsx` to match LineGraph (replaces sparkline)
- All 343 tests pass across 12 test files
- TypeScript build compiles clean

**Total Changes:** 5 new files, 5 modified files, 343 tests passing

---

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
