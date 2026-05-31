# Control Surface Inventory

GENTYR guides Claude Code agents through **8 distinct control surface categories**, each operating at a different point in the agent lifecycle. This inventory is the authoritative reference for understanding how GENTYR shapes agent behavior. CLAUDE.md links here from the "Control Surfaces" section.

## Overview

| Category | Count | When It Fires | What It Controls |
|----------|-------|---------------|-----------------|
| 1. Hooks | ~60 JS files | Every tool call, session start/stop, user prompt | Context injection, lifecycle management, audit gates |
| 2. Agent Definitions | 26 shared (target projects only) | At agent spawn | Model tier, allowed tools, behavioral instructions, workflow. The gentyr repo itself has no `.claude/agents/` — these definitions live in the framework's `agents/` directory and are symlinked into target projects on install. |
| 3. MCP Servers/Tools | ~38 servers, ~700+ tools | On tool invocation | What actions agents can take, what data they can access |
| 4. Slash Commands | ~40 commands | User-initiated | Workflows, dashboards, configuration |
| 5. CLAUDE.md (managed section) | 1 template | Every conversation turn | Persistent behavioral instructions in system prompt |
| 6. Session Briefing | 1 hook + content | Session start | One-time context dump: queue status, active tasks, focus mode |
| 7. Prompt Templates | ~10 builders | Agent spawn | Task-specific instructions injected into spawn prompts |
| 8. Automation Scripts | 26 scripts | Cron/launchd/daemon | Background orchestration outside of agent sessions |

## What Each Category CAN and CANNOT Do

| Category | Can Block | Can Inject Context | Can Spawn Agents | Can Modify Code | Persists Across Sessions |
|----------|-----------|-------------------|-----------------|----------------|------------------------|
| PreToolUse hooks | Yes (audit + signal gates only) | No | No | No | No (stateless) |
| PostToolUse hooks | No | **Yes** | **Yes** | No | No (stateless) |
| SessionStart hooks | No | **Yes** | **Yes** | No | No (one-shot) |
| Agent Definitions | No | **Yes** (instructions) | No | Indirectly | **Yes** (file-based) |
| MCP Tools | No | **Yes** (returns) | No | Indirectly | **Yes** (DB-backed) |
| CLAUDE.md | No | **Yes** (system prompt) | No | No | **Yes** (file-based) |
| Prompt Templates | No | **Yes** (spawn prompt) | No | No | No (per-spawn) |
| Automation Scripts | No | No | **Yes** | No | **Yes** (daemon) |

## Hooks by Lifecycle Phase

### PreToolUse (2 hooks — audit gate and signal compliance)

| Hook | Matcher | Purpose |
|------|---------|---------|
| gate-confirmation-enforcer.js | `mcp__todo-db__complete_task,mcp__persistent-task__complete_persistent_task` | Block task completion while `pending_audit` is active; prevents bypassing the audit gate |
| signal-compliance-gate.js | `mcp__agent-tracker__send_session_signal` | Validate inter-agent signals against schema before delivery; reject malformed or unauthorized signal types |

### PostToolUse (40 hooks — REACT to actions, inject context, spawn agents)

| Hook | Matcher | Purpose |
|------|---------|---------|
| signal-reader.js | `""` (all) | Read inter-agent signals/directives |
| worktree-freshness-check.js | `""` (all) | Nag if worktree is stale (every 2 min) |
| agent-comms-reminder.js | `""` (all) | Remind agents to check for communications |
| alignment-reminder.js | `""` (all) | Remind agents to check task alignment |
| persistent-task-briefing.js | `""` (all) | Inject persistent task state into monitor context |
| progress-tracker.js | `""` (all) | Track pipeline stage progress |
| monitor-reminder.js | `""` (all) | Remind monitors to check sub-task status |
| uncommitted-change-monitor.js | `Write,Edit` | Warn after 5 uncommitted file edits |
| pr-auto-merge-nudge.js | `Bash` | Nudge to self-merge after PR creation |
| ai-pr-review-hook.js | `Bash` | Spawn Haiku gate agent to review PR diff on every PR creation; posts PR comments for critical findings, adds ai-reviewed label when clean (5-min TTL, gate lane) |
| plan-merge-tracker.js | `Bash` | Auto-advance plan tasks on PR merge |
| strict-infra-nudge-hook.js | `Bash` | Redirect agents from Bash infra commands to MCP tools |
| urgent-task-spawner.js | `create_task` | Auto-spawn urgent tasks |
| task-gate-spawner.js | `create_task` | Spawn gate agent for pending_review tasks |
| workstream-spawner.js | `create_task` | Auto-spawn workstream tasks |
| persistent-task-linker.js | `create_task` | Auto-link sub-tasks to persistent tasks |
| orchestration-guidance-hook.js | `create_task` | Analyze task complexity; nudge CTO toward parallel tasks, persistent tasks, or plans when complexity signals detected |
| task-deletion-cascade.js | `delete_task` | Cascade-kill running sessions linked to a deleted task via `cancelSessionsByTaskId` |
| project-manager-reminder.js | `summarize_work` | Remind to spawn project-manager |
| worktree-cleanup-gate.js | `summarize_work` | Remind to clean up worktree |
| plan-work-tracker.js | `summarize_work` | Record work against plan tasks |
| session-completion-gate.js | `summarize_work,complete_task` | Validate completion prerequisites |
| workstream-dep-satisfier.js | `complete_task` | Cascade workstream dependency satisfaction |
| demo-failure-spawner.js | `check_demo_result,check_demo_batch_result,run_demo` | Auto-spawn repair agents on demo failure; enriches repair prompts with `failure_classification` and ECONNREFUSED infrastructure guidance; injects skipped-scenario accountability context for completed batches |
| demo-remote-enforcement.js | `run_demo` | Enforce remote+batch execution for spawned agents; detect sequential local anti-pattern |
| long-command-warning.js | `secret_run_command` | Warn about MCP transport timeout |
| persistent-task-spawner.js | `activate/resume/amend/pause/cancel_persistent_task` | Spawn/stop persistent monitors |
| plan-persistent-sync.js | `complete_persistent_task` | Sync completion to plan tasks |
| plan-activation-spawner.js | `update_plan_status` | Spawn plan manager on plan activation |
| plan-audit-spawner.js | `update_task_progress` | Spawn independent auditor on pending_audit |
| screenshot-reminder.js | `""` (all) | Remind agents to Read screenshot paths in tool responses |
| context-pressure-hook.js | `""` (all) | Monitor spawned-agent context window size and session age; nudge at configurable tiers; call `request_self_compact` at critical threshold |
| release-artifact-collector.js | `complete_task,summarize_work` | Archive session transcripts to release artifact directory when GENTYR_RELEASE_ID is set |
| release-completion-hook.js | `complete_persistent_task` | On release plan-manager completion: unlock staging, generate report, emit audit event, broadcast signal |
| universal-audit-spawner.js | `complete_task,update_task_progress,complete_persistent_task` | Fire on task completion; when `gate_success_criteria` / `verification_strategy` set, transition to `pending_audit` and enqueue Haiku auditor in `audit` lane |
| alignment-monitor-briefing.js | `""` (all) | Deliver cross-session alignment violation summaries to active deputy-CTO monitor sessions |
| monitor-poll-budget-hook.js | `mcp__agent-tracker__peek_session` | Advisory: track `peek_session` frequency per spawned monitor session; emit `additionalContext` warning when >5 calls in 5-min rolling window. Fast-exits in under 1ms for non-`peek_session` tools, interactive sessions, and non-monitor spawned sessions |

### SessionStart (9 hooks — set initial context)

| Hook | Purpose |
|------|---------|
| gentyr-splash.js | Display GENTYR branding |
| gentyr-sync.js | Auto-rebuild MCP servers if stale, re-merge configs |
| todo-maintenance.js | Clean up stale tasks |
| dead-agent-recovery.js | Detect and revive dead agents |
| crash-loop-resume.js | Resume persistent tasks paused by circuit breaker |
| credential-health-check.js | Verify 1Password connectivity |
| playwright-health-check.js | Verify Playwright and browser availability |
| plan-briefing.js | Brief agent on active plan state |
| session-briefing.js | Comprehensive context dump: queue, tasks, focus mode, active persona profile; also warns when main has commits not in staging (merge-back needed) |

### UserPromptSubmit (13 hooks — process user/CTO input)

| Hook | Purpose |
|------|---------|
| cto-notification-hook.js | Update CTO status line; inject relevant status into model context on every prompt |
| slash-command-prefetch.js | Pre-fetch data for slash commands |
| branch-drift-check.js | Check for upstream branch drift |
| comms-notifier.js | Notify about pending inter-agent communications |
| workstream-notifier.js | Notify about workstream updates |
| cto-prompt-detector.js | Detect CTO-directed prompts in spawned sessions |
| secrets-local-health.js | Warn about missing secrets.local entries |
| mcp-guidance-hook.js | Inject MCP server guidance and pending server notifications |
| pending-sync-notifier.js | Warn CTO when pending config files need npx gentyr sync; injects `additionalContext` so the model also sees pending state (not just terminal `systemMessage`) |
| interactive-heartbeat.js | Track per-session interactive liveness; writes `.claude/state/interactive-sessions.json` keyed by session UUID for rescue/reaper cross-check; 30-min staleness threshold + PID liveness; root-owned via `criticalHooks` |

### Stop (1 hook — gate session termination)

| Hook | Purpose |
|------|---------|
| stop-continue-hook.js | Gate session stop, check unfinished work, trigger revival |

## Shared Hook Libraries (hooks/lib/ — 38 modules)

Key modules consumed by hooks:
- `session-queue.js` — Central queue management (enqueue, drain, spawn, suspend/resume)
- `session-reaper.js` — Dead session detection and cleanup (sync + async passes); includes audit revival detection in `reapSyncPass()` — stale `audit`-lane sessions for all four task types (`todo`, `persistent`, `plan`, `authorization`) are re-enqueued via `buildAuditorSessionSpec({ taskType })`
- `session-audit.js` — Audit event emission to session-audit.log
- `session-signals.js` — Inter-agent signal delivery
- `resource-lock.js` — Shared resource coordination (display, chrome-bridge, main-dev-server)
- `memory-pressure.js` — RAM monitoring for spawn gating
- `worktree-manager.js` — Worktree provisioning and cleanup
- `port-allocator.js` — Per-worktree port isolation
- `process-tree.js` — Process group management (killProcessGroup, killProcessesInDirectory)
- `task-category.js` — Task pipeline resolution (resolveCategory, buildPromptFromCategory)
- `blocker-auto-heal.js` — Self-healing orchestrator for persistent monitors: diagnoses crash type, spawns fix tasks, escalates to CTO after max attempts (`handleBlocker`)
- `pause-propagation.js` — Hierarchical pause/resume propagation between persistent tasks and plans (propagatePauseToPlan, propagateResumeToPlan, assessPlanBlocking)
- `persistent-monitor-revival-prompt.js` — Revival prompt builder (now includes self-heal context from blocker_diagnosis)
- `persistent-revival-context.js` — Revival context assembly (last_summary, amendments, sub-tasks, blocker_diagnosis)
- `persistent-monitor-demo-instructions.js` — Demo-specific monitor instructions
- `persistent-monitor-strict-infra-instructions.js` — Infrastructure guidance for monitors
- `strict-infra-guidance-prompt.js` — Bash prohibition prompts
- `user-prompt-resolver.js` — Resolve user prompt UUIDs to content
- `spawn-env.js` — Environment variable injection for spawned agents
- `feature-branch-helper.js` — Branch naming and detection
- `llm-client.js` — Shared `callLLMStructured` for Haiku structured JSON output via `--json-schema`
- `report-auto-resolver.js` — PR-based report auto-resolution and dedup (runReportAutoResolve, runReportDedup)
- `release-orchestrator.js` — Production release artifact collection: `enumerateReleasePRs` (gh pr list with git fallback), `getArtifactDir` (create `.claude/releases/{id}/prs|sessions|reports/`), `collectSessionArtifact` (copy JSONL by agent marker), `collectDemoArtifacts` (copy screenshots/recordings + demo-results.json), `collectTriageArtifacts` (query cto-reports.db + deputy-cto.db)
- `release-report-generator.js` — Structured release report pipeline: `generateStructuredReport` reads release-ledger.db + artifacts, fills `templates/release-report-template.md`, writes `report.md` to artifact dir; `convertToPdf` converts to PDF via headless Chromium
- `cto-approval-proof.js` — CTO release approval verification: `verifyQuoteInJsonl` (line-by-line JSONL scan for verbatim quote), `computeFileHash` (SHA-256), `findCurrentSessionJsonl` (session discovery). Consumed by `record_cto_approval` tool on release-ledger server. **Spawned-session guard**: `record_cto_approval` blocks `CLAUDE_SPAWNED_SESSION=true` sessions — only interactive CTO sessions can sign off releases. **`approval_text` minimum**: 10 characters (enforced by Zod schema) to ensure a substantive audit trail
- `compact-session.js` — Session compaction utilities: reads session context token counts from JSONL tails, tracks compaction events in `compact-tracker.json`, and executes `claude --resume <id> -p /compact` on dead sessions before revival when context is high. Exports `compactSessionIfNeeded(sessionId, cwd, opts)`. Consumed by `session-queue.js` `spawnQueueItem` for revival-time compaction of `resume`-type spawns.
- `auditor-prompt.js` — Single source of truth for building auditor session specs. Exports `buildAuditorSessionSpec()` consumed by `universal-audit-spawner.js` (first spawn) and `session-queue.js` Step 1b.5 (revival spawn). Internally calls `resolveAuditTools(taskType)` to dispatch across three task types: `'todo'` (universal-auditor + todo-db tools), `'persistent'` (universal-auditor + persistent-task tools), `'plan'` (plan-auditor + plan-orchestrator tools).
- `load-test-runner.js` — Lightweight autocannon-based load test runner. Reads route configuration from `services.json` (`loadTest` section), runs load tests per route, and returns structured performance results. `autocannon` must be installed in the target project. Used by the promotion pipeline when `loadTest.enabled: true`.
- `ai-compatibility-check.js` — LLM-powered (Haiku) dependency upgrade compatibility validator. Fetches npm registry metadata and changelogs, analyzes project usage patterns, and classifies upgrades as compatible/risky with specific breaking-change identification. Returns `{ compatible, risks, recommendation }`.
- `ai-pr-decomposition.js` — LLM-powered (Haiku) large-PR decomposer. When a PR exceeds 3000 lines, suggests how to split commits into independently-promotable groups by feature/concern. Returns `{ groups }` with each group's commits, rationale, and suggested branch name.

## Agent Definitions (26 shared, target projects only)

These agent definitions live in the framework's `agents/` directory and are installed into target projects at `.claude/agents/` via the CLI's symlink pipeline. The gentyr source repo itself has no `.claude/agents/` directory.

| Agent | Model | Purpose | Key Constraints |
|-------|-------|---------|----------------|
| code-writer | opus | Write code | Must run in worktree, does NOT commit |
| code-reviewer | opus | Review code | Read-only, does NOT commit |
| test-writer | sonnet | Write/update tests | Must run in worktree, does NOT commit |
| project-manager | sonnet | Git operations | ONLY agent that commits, pushes, creates PRs, self-merges |
| investigator | opus | Research/diagnose | Read-only, no worktree needed |
| user-alignment | sonnet | Verify user intent, propose specs | Auditor; proposes spec changes via deferred actions (CTO-gated), no source code edits |
| deputy-cto | opus | Triage/escalation | Review promotion PRs, manage task queue; can operate as global alignment monitor |
| persistent-monitor | opus | Long-running orchestrator | Never edits files, spawns sub-agents via create_task |
| plan-manager | opus | Plan execution | Spawns persistent tasks for plan steps |
| plan-updater | haiku | Sync plan substeps | Lightweight, completes in <30s |
| plan-auditor | sonnet | Verify plan task completion | Independent, 8-min TTL, audit lane |
| universal-auditor | sonnet | Verify todo-db and persistent task completion | Independent, 8-min TTL, audit lane, signal-excluded; does NOT audit plan tasks |
| demo-manager | sonnet | Demo lifecycle | Only agent that creates/modifies .demo.ts files |
| feedback-agent | sonnet | User persona testing | No source code access |
| product-manager | opus | PMF analysis | External research only |
| antipattern-hunter | sonnet | Anti-pattern detection | Read-only |
| icon-finder | opus | Icon sourcing | SVG processing pipeline |
| secret-manager | sonnet | Credential lifecycle | 1Password-based operations |
| repo-hygiene-expert | sonnet | Repo structure analysis | Read-only |
| workstream-manager | haiku | Queue dependency analysis | Read-only |
| staging-reviewer | sonnet | Staging reactive review (antipattern, code-quality, user-alignment, spec-compliance) | Read-only reviewer; spawns code-writer sub-agents for fixes |
| cicd-manager | sonnet | Deployment, promotion, rollback, release infrastructure | Single authority for CI/CD pipeline; does NOT edit source code |
| security-auditor | sonnet | OWASP Top 10 code security review (Injection, Auth, XSS, CSRF, IDOR, SSRF, Misconfiguration, Data Exposure) | Read-only; does NOT fix issues, reports via agent-reports; reviews recent git history |

## MCP Servers (~38 servers)

### Core State Servers (Tier 2 — per-session, stateful)

| Server | Key Tools | Purpose |
|--------|-----------|---------|
| todo-db | create_task, list_tasks, complete_task, summarize_work, gate_approve_task, list_categories | Task CRUD, categories, gate approval |
| persistent-task | create/activate/amend/pause/resume/cancel/complete_persistent_task, inspect_persistent_task | Persistent task lifecycle |
| plan-orchestrator | create_plan, add_phase, add_plan_task, get_spawn_ready_tasks, plan_dashboard | Plans, phases, tasks, dependencies |
| agent-tracker | get_session_queue_status, set_max_concurrent_sessions, acquire/release_shared_resource, peek_session, browse_session, set_automation_toggle, get_automation_toggles, repair_main_tree_drift, query_token_usage, top_token_sessions, token_attribution_health, revival_cost_summary | Session queue, signals, locks, automation toggles, main-tree drift repair, token usage attribution |
| user-feedback | create_persona, register_feature, create_demo_scenario, register_prerequisite, lock/unlock_feature, create/archive/switch/list/get/delete_persona_profile, verify_demo_completeness | Personas, features, scenarios, prerequisites, persona profiles, demo completeness gate |
| product-manager | start_section, approve_section, get_section | PMF analysis pipeline |
| deputy-cto | create_report, list_reports, acknowledge_report | Reports, triage, delegation |
| release-ledger | create_release, get_release, list_releases, update_release, sign_off_release, cancel_release, add_release_pr, update_release_pr_status, add_release_session, add_release_report, add_release_task, get_release_evidence, generate_release_report, present_release_summary, record_cto_approval | Production release evidence chain (CTO sign-off) |

### Infrastructure Servers (Tier 1 — shared daemon)

| Server | Purpose |
|--------|---------|
| secret-sync | Credential resolution, services.json config (`get/update_services_config`, `populate_secrets_local`, `populate_secrets_fly`, secret profile CRUD), command execution with secrets, secret_sync_secrets with `target: 'render' | 'vercel' | 'fly'` |
| github | GitHub API (issues, PRs, repos) |
| cloudflare | DNS and worker management |
| supabase | Database operations |
| onepassword | 1Password read/write |
| vercel | Deployment management |
| render | Service management |
| codecov | Coverage tracking |
| resend | Email sending |
| elastic-logs | Log querying, logging config verification (`query_logs`, `get_log_stats`, `verify_logging_config`) |

### Browser Automation Servers

| Server | Tool Count | Purpose |
|--------|-----------|---------|
| playwright | ~38 | Demo execution, test running, screenshots, video, prerequisites |
| chrome-bridge | 35 | 17 socket-based + 2 AppleScript + 4 convenience + 4 React automation + diagnostics |

### Content/Display Servers
specs-browser, cto-report, cto-reports, show, setup-helper, feedback-explorer, icon-processor, docs-feedback, makerkit-docs

### Feedback Agent Servers
feedback-reporter, playwright-feedback, programmatic-feedback

## Slash Commands (47)

**Demo**: demo, demo-all, demo-autonomous, demo-bulk, demo-interactive, demo-session, demo-validate
**Tasks**: spawn-tasks, task-queue, triage, persistent-task, persistent-tasks
**Monitoring**: monitor, status, tokens
**Plans**: plan, plan-progress, plan-timeline, plan-audit, plan-sessions
**Config**: automation-rate, concurrent-sessions, configure-personas, focus-mode, global-monitor, setup-gentyr, toggle-automation-gentyr, toggle-product-manager
**Operations**: cto-dashboard, deputy-cto, promote-to-prod, promote-to-staging, session-queue, show, workstream
**Infrastructure**: push-migrations, push-secrets, overdrive-gentyr, setup-fly
**Analysis**: persona-feedback, product-manager, replay, run-feedback

## Prompt Injection Points (7 major sources)

| Source | When | What |
|--------|------|------|
| CLAUDE.md.gentyr-section | Every turn (system prompt) | Merge chain, agent workflow, commit rules, tool reference |
| session-briefing.js | Session start | Queue state, active tasks, focus mode |
| plan-briefing.js | Session start | Active plan state and progress |
| buildPromptFromCategory() | Agent spawn | 6-step pipeline (or custom category sequence) |
| buildPersistentMonitorRevivalPrompt() | Monitor revival | Last summary, amendments, sub-task status, demo/infra flags |
| persistent-task-briefing.js | Every tool call (monitors) | Current task state, amendment reminders, heartbeat |
| strict-infra-guidance-prompt.js | Agent spawn (when flagged) | MCP-only infrastructure instructions |

## Control Surface Interaction Flow

```
User/CTO Message
    |
    +-- UserPromptSubmit hooks (11) --> Context injection, leak detection, notification
    |
    v
Agent Reasoning (informed by CLAUDE.md + session briefing + plan briefing)
    |
    +-- PreToolUse hooks (14) --> BLOCK dangerous actions
    |
    v
Tool Execution (MCP tools, Bash, Read, Write, Edit, Agent)
    |
    +-- PostToolUse hooks (27) --> REACT: inject context, spawn agents, track progress
    |
    v
Agent Spawn (via Agent tool or session queue)
    |
    +-- Agent Definition (.md) --> Model, tools, behavioral constraints
    +-- Prompt Template --> Task-specific instructions, pipeline steps
    +-- SessionStart hooks (9) --> Initial context, health checks, briefing
    |
    v
Session Stop
    |
    +-- Stop hook (1) --> Gate completion, trigger revival if needed
    |
    v
Background Automation
    |
    +-- hourly-automation.js --> Spawn tasks, reap sessions, cleanup worktrees, auto-rollback
    +-- revival-daemon.js --> Detect dead agents, revive immediately
    +-- session-activity-broadcaster.js --> Generate and deliver session summaries
    +-- live-feed-daemon.js --> Generate Live Feed commentary entries to live-feed.db
    +-- preview-watcher.js --> Keep worktrees fresh
    +-- synthetic-monitor.js --> Probe health endpoints, write alerts for auto-rollback pipeline
```
