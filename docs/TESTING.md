# GENTYR - Comprehensive End-to-End Test Plan

## Executive Summary

This plan provides a complete inventory of all .claude-framework components and an end-to-end test plan for each. The goal is to test all capabilities naturally without mocking, using realistic workflows that exercise the system as it would run in production.

---

## Framework Component Inventory

### MCP Servers (8 total)

| Server | Database | Purpose | Key Tools |
|--------|----------|---------|-----------|
| **todo-db** | `.claude/todo.db` | Task tracking across agent sections | `create_task`, `start_task`, `complete_task`, `get_sessions_for_task` |
| **agent-tracker** | `agent-tracker-history.json` | Track spawned agents + session browser | `list_spawned_agents`, `list_sessions`, `search_sessions` |
| **specs-browser** | Filesystem (`specs/`) | Read project specifications | `list_specs`, `get_spec` |
| **deputy-cto** | `.claude/deputy-cto.db` | CTO question queue + commit control | `add_question`, `approve_commit`, `reject_commit`, `request_bypass` |
| **agent-reports** | `.claude/agent-reports.db` | Agent report triage queue | `report_to_deputy_cto`, `start_triage`, `complete_triage` |
| **review-queue** | `.claude/review-queue.db` | Schema mapping review | `list_pending_reviews`, `approve_review` |
| **session-events** | `.claude/session-events.db` | Session event logging | `session_events_record`, `session_events_search` |
| **cto-report** | Multiple sources | Metrics generation | `get_report`, `get_session_metrics`, `get_task_metrics` |

### Hooks (10 automation hooks + 5 utility modules)

| Hook | Trigger | Purpose | Cooldown |
|------|---------|---------|----------|
| **block-no-verify.js** | PreToolUse | Blocks `--no-verify` and bypass commands | None |
| **api-key-watcher.js** | SessionStart | Auto-rotate API keys based on usage | Per-session |
| **cto-notification-hook.js** | UserPromptSubmit | Display CTO status at session start | None |
| **todo-maintenance.js** | UserPromptSubmit | Auto-spawn todo-processing agent | 15 min |
| **bypass-approval-hook.js** | UserPromptSubmit | Process "APPROVE BYPASS <code>" messages | None |
| **antipattern-hunter-hook.js** | Post-Commit | Spawn spec violation hunters | 6 hours |
| **compliance-checker.js** | Post-Commit | Enforce spec compliance | 7 days per file |
| **schema-mapper-hook.js** | CLI/Programmatic | Generate schema mappings | 24h per schema |
| **hourly-automation.js** | Hourly service | Triage, plan execution, refactoring | 55 min |
| **pre-commit-review.js** | Git pre-commit | Deputy-CTO review + lint | Per commit |
| **agent-tracker.js** | Support module | Shared spawn tracking | N/A |
| **config-reader.js** | Support module | Shared cooldown configuration | N/A |
| **mapping-validator.js** | Support module | Validate spec-file-mappings.json | N/A |
| **plan-executor.js** | Support module | Execute pending plans (via hourly) | N/A |
| **usage-optimizer.js** | Support module | Dynamic cooldown adjustment | N/A |

### Git Hooks (3 total)

| Hook | Location | Triggers |
|------|----------|----------|
| **pre-commit** | `.husky/pre-commit` | lint-staged + pre-commit-review.js |
| **post-commit** | `.husky/post-commit` | antipattern-hunter + compliance-checker |
| **pre-push** | `.husky/pre-push` | Tests + repo-hygiene-expert |

### Framework Agents (8 total)

| Agent | Model | Purpose | Spawned By |
|-------|-------|---------|------------|
| **investigator** | Opus | Research and planning (read-only) | First in workflow |
| **code-writer** | Sonnet | Implementation | After investigator |
| **test-writer** | Sonnet | Unit/integration testing | After code-writer |
| **code-reviewer** | Opus | Review and commits | After test-writer |
| **project-manager** | Sonnet | Doc sync and cleanup | Last in workflow |
| **deputy-cto** | Opus | Commit review, CTO decisions | pre-commit-review.js, /deputy-cto |
| **antipattern-hunter** | Opus | Spec violation detection | antipattern-hunter-hook.js |
| **repo-hygiene-expert** | Opus | Repository structure audit | pre-push hook |

### Project-Specific Agents (x_test example)

These agents are NOT part of the framework - they're project-specific and stored in the project's `.claude/agents.backup/`:

| Agent | Model | Purpose | Spawned By |
|-------|-------|---------|------------|
| **federation-mapper** | Opus | Schema mapping generation | schema-mapper-hook.js |
| **integration-researcher** | Opus | Platform API research | Manual for integrations |
| **integration-frontend-dev** | Sonnet | Browser extension connector | After researcher |
| **integration-backend-dev** | Sonnet | Backend API connector | After researcher |
| **integration-guide-dev** | Sonnet | Credential setup guide | After researcher |

### Commands (2 total)

| Command | Purpose | Interactive |
|---------|---------|-------------|
| `/cto-report` | Generate CTO status report | No |
| `/deputy-cto` | Interactive CTO briefing session | Yes |

---

## Test Plan

### Phase 1: MCP Server Tests (Parallel OK)

#### Test 1.1: todo-db Full CRUD
**Natural Action:** Create tasks for different agents, track their lifecycle
```
1. mcp__todo-db__create_task({ section: "TEST-WRITER", title: "Write auth tests" })
2. mcp__todo-db__list_tasks({ section: "TEST-WRITER" })
3. mcp__todo-db__start_task({ id: <id> })
4. mcp__todo-db__complete_task({ id: <id> })
5. mcp__todo-db__get_summary()
6. mcp__todo-db__cleanup()
```
**Verify:** Query `.claude/todo.db` directly; check state transitions

#### Test 1.2: todo-db Session Attribution
**Natural Action:** Complete a task, find which session did it
```
1. Create and complete a task
2. mcp__todo-db__get_sessions_for_task({ id: <completed-id> })
3. mcp__todo-db__browse_session({ session_id: <candidate> })
```
**Verify:** Session file content matches what was done

#### Test 1.3: specs-browser Operations
**Natural Action:** Look up project specifications
```
1. mcp__specs-browser__list_specs()
2. mcp__specs-browser__get_spec({ spec_id: "G001" })
3. mcp__specs-browser__get_spec({ spec_id: "TESTING" })
```
**Verify:** Spec content returned correctly; categories match directory structure

#### Test 1.4: deputy-cto Question Queue
**Natural Action:** Escalate a decision to CTO
```
1. mcp__deputy-cto__add_question({ type: "decision", title: "Architecture choice", description: "..." })
2. mcp__deputy-cto__list_questions({})
3. mcp__deputy-cto__read_question({ id: <id> })
4. mcp__deputy-cto__answer_question({ id: <id>, answer: "Use option A", decided_by: "cto" })
5. mcp__deputy-cto__clear_question({ id: <id> })
```
**Verify:** Question flows through states; cleared questions searchable via `search_cleared_items`

#### Test 1.5: agent-reports Triage Flow
**Natural Action:** Report an issue, have it triaged
```
1. mcp__agent-reports__report_to_deputy_cto({ reporting_agent: "code-reviewer", title: "Security concern", summary: "...", category: "security", priority: "high" })
2. mcp__agent-reports__get_reports_for_triage({ limit: 10 })
3. mcp__agent-reports__start_triage({ id: <id> })
4. mcp__agent-reports__complete_triage({ id: <id>, status: "escalated", outcome: "Added to CTO queue" })
```
**Verify:** Report moves through pending → in_progress → completed; stats updated

#### Test 1.6: cto-report Metrics
**Natural Action:** Generate a CTO status report
```
1. Create activity (tasks, sessions, reports)
2. mcp__cto-report__get_report({ hours: 24 })
```
**Verify:** Report includes token usage, session counts, task metrics, pending items

---

### Phase 2: Hook Behavioral Tests (Sequential)

#### Test 2.1: PreToolUse block-no-verify
**Natural Action:** Try to bypass git hooks
**Steps:**
```bash
# Simulate hook input
echo '{"tool_name":"Bash","tool_input":{"command":"git commit --no-verify"}}' | node .claude/hooks/block-no-verify.js
```
**Expected:** Exit code 1, error message about blocked command
**Also test:** `git commit -n`, `git config core.hooksPath`, `rm -rf .husky`, `eslint --quiet`

#### Test 2.2: SessionStart cto-notification-hook
**Natural Action:** Start a new session, see CTO status
**Steps:**
```bash
node .claude/hooks/cto-notification-hook.js
```
**Expected:** JSON with `systemMessage` showing quota, token usage, pending items

#### Test 2.3: UserPromptSubmit bypass-approval-hook
**Natural Action:** CTO approves emergency bypass
**Steps:**
```
1. mcp__deputy-cto__request_bypass({ reason: "System error", reporting_agent: "test" })
   → Returns code like "X7K9M2"
2. CTO types: "APPROVE BYPASS X7K9M2"
3. bypass-approval-hook creates .claude/bypass-approval-token.json
4. mcp__deputy-cto__execute_bypass({ bypass_code: "X7K9M2" })
```
**Verify:** Token file created with 5-minute expiry; bypass proceeds

#### Test 2.4: Post-commit antipattern-hunter
**Natural Action:** Commit code, hunters spawn
**Steps:**
```
1. Reset antipattern-hunter-state.json (set lastSpawn to 7+ hours ago)
2. git commit -m "test commit"
3. Check agent-tracker-history.json
```
**Expected:** Two hunters spawned (antipattern-hunter-repo, antipattern-hunter-commit)
**Time Acceleration:** Modify `lastSpawn` timestamp in state file

---

### Phase 3: Git Workflow Tests (Sequential)

#### Test 3.1: Full Commit Approval Flow
**Natural Action:** Make a code change and commit it
**Steps:**
```
1. Edit a TypeScript file
2. git add <file>
3. git commit -m "Add feature" (spawns deputy-cto review)
4. Wait for deputy-cto to call approve_commit()
5. git commit -m "Add feature" (second attempt succeeds)
6. Verify post-commit hooks run (antipattern-hunter, compliance-checker)
```
**Verify:** Commit succeeds after approval; approval token created and consumed

#### Test 3.2: Commit Rejection Flow
**Natural Action:** Try to commit code with security issue
**Steps:**
```
1. Stage file with hardcoded API key
2. git commit -m "test" (deputy-cto rejects)
3. Verify commits blocked (rejection question exists)
4. Run /deputy-cto to address rejection
5. Fix code, commit succeeds
```
**Verify:** Rejection blocks all commits until addressed

#### Test 3.3: Lint Enforcement (Unbypassable)
**Natural Action:** Try to commit with lint errors
**Steps:**
```
1. Stage TypeScript file with lint errors
2. Attempt commit (even with valid approval token)
```
**Expected:** Commit blocked by ESLint - cannot be bypassed

#### Test 3.4: Forbidden Config Files
**Natural Action:** Try to add .eslintignore
**Steps:**
```
1. Create .eslintignore in project root
2. git add .eslintignore
3. Attempt commit
```
**Expected:** Commit blocked with message about forbidden config files

---

### Phase 4: Hourly Automation Tests (Sequential)

#### Test 4.1: Autonomous Mode Toggle
**Natural Action:** Enable/disable hourly automation
**Steps:**
```
1. mcp__deputy-cto__toggle_autonomous_mode({ enabled: true })
2. Check .claude/autonomous-mode.json
3. mcp__deputy-cto__get_autonomous_mode_status()
```
**Verify:** Config file updated; status shows next run time

#### Test 4.2: Report Triage Automation
**Natural Action:** Let hourly automation triage reports
**Steps:**
```
1. Enable autonomous mode
2. Create pending reports via report_to_deputy_cto
3. Set lastTriageCheck to 6+ minutes ago
4. Run: node .claude/hooks/hourly-automation.js
```
**Expected:** Deputy-CTO spawned to triage; reports move to completed
**Time Acceleration:** Modify `lastTriageCheck` in hourly-automation-state.json

#### Test 4.3: Task Runner (Hourly TODO Processing)
**Natural Action:** Let hourly automation process pending TODO items
**Steps:**
```
1. Enable autonomous mode with taskRunnerEnabled: true
2. Create TODO items via mcp__todo-db__create_task (wait >1h or backdate)
3. Set lastTaskRunnerCheck to 61+ minutes ago
4. Run: node .claude/hooks/hourly-automation.js
```
**Expected:** A separate Claude session spawned for each pending TODO >1h old
**Time Acceleration:** Modify `lastTaskRunnerCheck` in state file

#### Test 4.4: CLAUDE.md Refactoring
**Natural Action:** Let hourly automation compact CLAUDE.md
**Steps:**
```
1. Make CLAUDE.md > 25,000 characters
2. Enable claudeMdRefactorEnabled: true
3. Run hourly-automation.js
```
**Expected:** claudemd-refactor agent spawned; content moved to sub-files

---

### Phase 5: Agent Workflow Tests (Sequential, Natural)

#### Test 5.1: Standard Bug Fix Workflow
**Natural Action:** Ask to fix a bug, watch full workflow
```
User: "There's a bug in the login function - it accepts empty passwords"

Expected flow:
1. INVESTIGATOR: Researches codebase, creates plan, creates TODOs
2. CODE-WRITER: Implements fix based on plan
3. TEST-WRITER: Adds test cases for empty password rejection
4. CODE-REVIEWER: Reviews changes, commits
5. PROJECT-MANAGER: Updates docs if needed
```
**Verify:** Each agent completes; TODOs tracked in todo-db; commit succeeds

#### Test 5.2: Antipattern Hunter Detection
**Natural Action:** Commit code with spec violation, let hunter find it
**Steps:**
```
1. Add code with G001 violation: `const value = dangerousCall() || null`
2. Commit the code (hunters spawn after 6h cooldown - accelerate)
3. Wait for hunters to complete
4. Check agent-reports for findings
5. Check todo-db for created fix tasks
```
**Verify:** Hunters detect violation; report to CTO; create TODO for fix

#### Test 5.3: Deputy-CTO Interactive Session
**Natural Action:** Run /deputy-cto command, address pending items
**Steps:**
```
1. Create: pending questions, reports, rejected commit
2. Run: /deputy-cto
3. Review items, answer questions, spawn tasks
4. Verify commits unblocked
```
**Verify:** All pending items addressed; commit block lifted

#### Test 5.4: CTO Report Generation
**Natural Action:** Run /cto-report command
**Steps:**
```
1. Generate activity (tasks, sessions, reports)
2. Run: /cto-report
```
**Verify:** Formatted report with quota, usage, sessions, tasks, pending items

---

### Phase 6: Installation Tests (Parallel, Isolated Directories)

#### Test 6.1: Fresh Installation
**Steps:**
```bash
mkdir /tmp/test-install && cd /tmp/test-install
git init
sudo /path/to/.claude-framework/scripts/setup.sh --path . --protect
```
**Verify:** Symlinks created, .mcp.json generated, husky hooks installed, MCP servers built, protection active

#### Test 6.2: Protection Toggle
**Steps:**
```bash
sudo scripts/setup.sh --path /path/to/project --unprotect-only
ls -la .claude/hooks/pre-commit-review.js  # Should be user-owned
sudo scripts/setup.sh --path /path/to/project --protect-only
ls -la .claude/hooks/pre-commit-review.js  # Should be root-owned
```
**Verify:** Protection toggles correctly

#### Test 6.3: Hourly Service Setup
**Steps:**
```bash
./scripts/setup-automation-service.sh
./scripts/setup-automation-service.sh status
./scripts/setup-automation-service.sh run  # Manual trigger
./scripts/setup-automation-service.sh remove
```
**Verify:** Service installs (systemd or launchd), runs, can be removed

---

## Time Acceleration Strategies

| Component | Cooldown | Acceleration Method |
|-----------|----------|---------------------|
| antipattern-hunter | 6 hours | Edit `lastSpawn` in `antipattern-hunter-state.json` |
| compliance-checker | 7 days/file | Edit timestamps in `compliance-state.json` |
| todo-maintenance | 15 minutes | Edit `lastSpawn` in `todo-maintenance-state.json` |
| schema-mapper | 24h/schema | Edit `cooldowns` in `schema-mapper-state.json` |
| hourly-automation | 55 minutes | Edit `lastRun` in `hourly-automation-state.json` |
| approval tokens | 5 minutes | Edit `expiresAt` in token files |

---

## State Files to Reset Between Tests

```bash
# Databases
rm -f .claude/todo.db .claude/deputy-cto.db .claude/agent-reports.db
rm -f .claude/review-queue.db .claude/session-events.db

# State files
rm -f .claude/hooks/agent-tracker-history.json
rm -f .claude/hooks/antipattern-hunter-state.json
rm -f .claude/hooks/compliance-state.json
rm -f .claude/hooks/todo-maintenance-state.json
rm -f .claude/hooks/schema-mapper-state.json
rm -f .claude/hourly-automation-state.json
rm -f .claude/autonomous-mode.json
rm -f .claude/commit-approval-token.json
rm -f .claude/bypass-approval-token.json
```

---

## Verification Checklist

After all tests, verify:

- [ ] All 8 MCP servers respond correctly to tool calls
- [ ] All 14 hooks execute without crashes
- [ ] Commit blocking works when CTO items pending
- [ ] Commit approval flow completes (spawn → review → approve → commit)
- [ ] Emergency bypass system works end-to-end
- [ ] Hourly automation runs when enabled (with time acceleration)
- [ ] All 8 framework agents spawn correctly from appropriate triggers
- [ ] Agent-tracker records all spawns with prompts
- [ ] TODO database maintains data integrity through lifecycle
- [ ] Protection system prevents unauthorized modifications
- [ ] Installation script is idempotent (safe to run multiple times)
- [ ] Uninstallation is clean (no orphaned files)
- [ ] All cooldowns enforced at boundaries
- [ ] Rate limits work (daily agent caps, per-file cooldowns)

---

## Test Execution Order

1. **Phase 1** (parallel): MCP Server Tests - verify all tools work
2. **Phase 2** (sequential): Hook Behavioral Tests - verify hook logic
3. **Phase 3** (sequential): Git Workflow Tests - verify commit flow
4. **Phase 4** (sequential): Hourly Automation Tests - verify automation
5. **Phase 5** (sequential): Agent Workflow Tests - verify end-to-end
6. **Phase 6** (parallel, isolated): Installation Tests
