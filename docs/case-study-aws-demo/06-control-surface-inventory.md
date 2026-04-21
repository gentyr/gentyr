# GENTYR Control Surface Inventory

## Overview

GENTYR guides Claude Code agents through **8 distinct control surface categories**, each operating at a different point in the agent lifecycle.

| Category | Count | When It Fires | What It Controls |
|----------|-------|---------------|-----------------|
| 1. Hooks | 56 JS files | Every tool call, session start/stop, user prompt | Real-time guardrails, context injection, lifecycle management |
| 2. Agent Definitions | 18 shared | At agent spawn | Model tier, allowed tools, behavioral instructions, workflow |
| 3. MCP Servers/Tools | ~40 servers, 200+ tools | On tool invocation | What actions agents can take, what data they can access |
| 4. Slash Commands | 39 commands | User-initiated | Workflows, dashboards, configuration |
| 5. CLAUDE.md (managed section) | 1 template | Every conversation turn | Persistent behavioral instructions in system prompt |
| 6. Session Briefing | 1 hook | Session start | One-time context dump: queue status, active tasks, bypass requests |
| 7. Prompt Templates | ~10 builders | Agent spawn | Task-specific instructions injected into spawn prompts |
| 8. Automation Scripts | 24 scripts | Cron/launchd/daemon | Background orchestration outside of agent sessions |

---

## Category 1: Hooks (56 files)

### Lifecycle: PreToolUse (fires BEFORE a tool executes — can block)

| Hook | Matcher | Purpose |
|------|---------|---------|
| interactive-lockdown-guard.js | `""` (all tools) | Block file-editing tools in interactive CTO sessions |
| block-no-verify.js | `Bash` | Block `--no-verify` flag on git commands |
| credential-file-guard.js | `Bash,Read,Write,Edit,NotebookEdit,Grep,Glob` | Block access to credential files (services.json, .env) |
| playwright-cli-guard.js | `Bash` | Block direct `npx playwright` CLI usage (use MCP tools) |
| branch-checkout-guard.js | `Bash` | Block branch switching in main tree |
| main-tree-commit-guard.js | `Bash` | Block git add/commit on protected branches |
| worktree-cwd-guard.js | `Bash` | Block Bash when CWD is a deleted worktree |
| worktree-path-guard.js | `Write,Edit,NotebookEdit` | Block file writes outside worktree boundary |
| interactive-agent-guard.js | `Agent` | Block code-modifying sub-agents in interactive sessions |
| block-team-tools.js | `TeamCreate,TeamDelete,SendMessage` | Block Team tools (use Agent tool instead) |
| secret-profile-gate.js | `mcp__secret-sync__secret_run_command` | Enforce secret profile usage |
| protected-action-gate.js | `mcp__*` | Block protected MCP actions without approval |

**Key insight**: PreToolUse hooks are BLOCKING gates. They prevent specific actions. They cannot inject information or guide behavior — only prevent it.

### Lifecycle: PostToolUse (fires AFTER a tool executes — can inject context)

| Hook | Matcher | Purpose |
|------|---------|---------|
| signal-reader.js | `""` (all) | Read inter-agent signals/directives |
| worktree-freshness-check.js | `""` (all) | Nag if worktree is stale (every 2 min) |
| agent-comms-reminder.js | `""` (all) | Remind agents to check for communications |
| alignment-reminder.js | `""` (all) | Remind agents to check task alignment |
| persistent-task-briefing.js | `""` (all) | Inject persistent task state into monitor context |
| progress-tracker.js | `""` (all) | Track pipeline stage progress |
| monitor-tasks-reminder.js | `""` (all) | Remind monitors to check sub-task status |
| uncommitted-change-monitor.js | `Write,Edit` | Warn after 5 uncommitted file edits |
| pr-auto-merge-nudge.js | `Bash` | Nudge to self-merge after PR creation |
| plan-merge-tracker.js | `Bash` | Auto-advance plan tasks on PR merge |
| strict-infra-nudge-hook.js | `Bash` | Redirect agents from Bash infra commands to MCP tools |
| urgent-task-spawner.js | `mcp__todo-db__create_task` | Auto-spawn urgent tasks |
| task-gate-spawner.js | `mcp__todo-db__create_task` | Spawn gate agent for pending_review tasks |
| workstream-spawner.js | `mcp__todo-db__create_task` | Auto-spawn workstream tasks |
| persistent-task-linker.js | `mcp__todo-db__create_task` | Auto-link sub-tasks to persistent tasks |
| project-manager-reminder.js | `mcp__todo-db__summarize_work` | Remind to spawn project-manager |
| worktree-cleanup-gate.js | `mcp__todo-db__summarize_work` | Remind to clean up worktree |
| plan-work-tracker.js | `mcp__todo-db__summarize_work` | Record agent work against plan tasks |
| session-completion-gate.js | `mcp__todo-db__summarize_work,complete_task` | Validate completion prerequisites |
| workstream-dep-satisfier.js | `mcp__todo-db__complete_task` | Cascade workstream dependency satisfaction |
| demo-failure-spawner.js | `mcp__playwright__check_demo_result,check_demo_batch_result,run_demo` | Auto-spawn repair agents on demo failure |
| long-command-warning.js | `mcp__secret-sync__secret_run_command` | Warn about MCP transport timeout |
| persistent-task-spawner.js | `activate/resume/amend/pause/cancel_persistent_task` | Spawn/stop persistent monitors |
| plan-persistent-sync.js | `mcp__persistent-task__complete_persistent_task` | Sync completion to plan tasks |
| plan-activation-spawner.js | `mcp__plan-orchestrator__update_plan_status` | Spawn plan manager on plan activation |

**Key insight**: PostToolUse hooks are REACTIVE. They inject context after an action. Most fire on `""` (all tools) for continuous context injection. Tool-specific hooks trigger workflow automation.

### Lifecycle: SessionStart (fires once when session begins)

| Hook | Purpose |
|------|---------|
| gentyr-splash.js | Display GENTYR branding |
| gentyr-sync.js | Auto-rebuild MCP servers if stale, re-merge configs |
| todo-maintenance.js | Clean up stale tasks |
| dead-agent-recovery.js | Detect and revive dead agents from previous session |
| crash-loop-resume.js | Resume persistent tasks paused by circuit breaker |
| credential-health-check.js | Verify 1Password connectivity |
| playwright-health-check.js | Verify Playwright and browser availability |
| plan-briefing.js | Brief agent on active plan state |
| session-briefing.js | Comprehensive context dump: queue, tasks, bypass requests, focus mode |

**Key insight**: SessionStart hooks set the INITIAL CONTEXT for the entire session. This is the primary opportunity to inform agents about the current state of the world.

### Lifecycle: UserPromptSubmit (fires on every user/CTO message)

| Hook | Purpose |
|------|---------|
| cto-notification-hook.js | Update CTO status line (agent count, queue status) |
| secret-leak-detector.js | Scan user prompt for leaked secrets |
| bypass-approval-hook.js | Detect "APPROVE BYPASS" pattern for lockdown disable |
| protected-action-approval-hook.js | Detect approval tokens for protected actions |
| slash-command-prefetch.js | Pre-fetch data for slash commands |
| branch-drift-check.js | Check for upstream branch drift |
| comms-notifier.js | Notify about pending inter-agent communications |
| workstream-notifier.js | Notify about workstream updates |
| cto-prompt-detector.js | Detect CTO-directed prompts in spawned sessions |

### Lifecycle: Stop (fires when session is about to end)

| Hook | Purpose |
|------|---------|
| stop-continue-hook.js | Gate session stop — check for unfinished work, revival needed |

### Shared Libraries (hooks/lib/ — 25 modules)

These are NOT hooks themselves but shared modules consumed by hooks:
- session-queue.js — Central queue management
- session-reaper.js — Dead session detection and cleanup
- session-audit.js — Audit event emission
- session-signals.js — Inter-agent signal delivery
- resource-lock.js — Shared resource (display, chrome-bridge) coordination
- memory-pressure.js — RAM monitoring for spawn gating
- worktree-manager.js — Worktree provisioning and cleanup
- port-allocator.js — Per-worktree port isolation
- process-tree.js — Process group management
- task-category.js — Task pipeline resolution
- bypass-guard.js — CTO bypass request checking
- persistent-monitor-revival-prompt.js — Revival prompt builder
- persistent-revival-context.js — Revival context assembly
- persistent-monitor-demo-instructions.js — Demo-specific monitor instructions
- persistent-monitor-strict-infra-instructions.js — Infrastructure guidance
- strict-infra-guidance-prompt.js — Bash prohibition prompts
- user-prompt-resolver.js — Resolve user prompt UUIDs to content
- spawn-env.js — Environment variable injection for spawned agents
- feature-branch-helper.js — Branch naming and detection
- display-lock.js — Backward-compat shim for resource-lock
- debug-log.js — Debug logging utility
- bypass-approval-token.js — HMAC token verification
- approval-utils.js — Approval workflow utilities
- demo-interrupt-setup.js — Demo Escape key interrupt wiring
- suppress-stderr.js — SessionStart stderr suppression

---

## Category 2: Agent Definitions (18 shared)

| Agent | Model | Purpose | Key Constraints |
|-------|-------|---------|----------------|
| code-writer | (inherited) | Write code | Must run in worktree, does NOT commit |
| code-reviewer | (inherited) | Review code | Must run in worktree, does NOT commit |
| test-writer | (inherited) | Write/update tests | Must run in worktree, does NOT commit |
| project-manager | (inherited) | Git operations | ONLY agent that commits, pushes, creates PRs, self-merges |
| investigator | (inherited) | Research/diagnose | Read-only, no worktree needed |
| user-alignment | (inherited) | Verify user intent | Read-only auditor, no file edits |
| deputy-cto | (inherited) | Triage/escalation | Review promotion PRs, manage task queue |
| persistent-monitor | Opus | Long-running orchestrator | Never edits files, spawns sub-agents via create_task |
| plan-manager | Opus | Plan execution | Spawns persistent tasks for plan steps |
| plan-updater | Haiku | Sync plan substeps | Lightweight, completes in <30s |
| demo-manager | (inherited) | Demo lifecycle | Only agent that creates/modifies .demo.ts files |
| feedback-agent | (inherited) | User persona testing | No source code access |
| product-manager | (inherited) | PMF analysis | External research only, no local project reference |
| antipattern-hunter | (inherited) | Anti-pattern detection | Read-only |
| icon-finder | (inherited) | Icon sourcing | SVG processing pipeline |
| secret-manager | (inherited) | Credential lifecycle | 1Password-based operations |
| repo-hygiene-expert | (inherited) | Repo structure analysis | Read-only |
| workstream-manager | (inherited) | Queue dependency analysis | Read-only |

---

## Category 3: MCP Servers (~40 servers, 200+ tools)

### Core State Servers (Tier 2 — per-session, stateful)
| Server | Tools | Purpose |
|--------|-------|---------|
| todo-db | ~15 | Task CRUD, categories, gate approval |
| persistent-task | 13 | Persistent task lifecycle, amendments |
| plan-orchestrator | 18 | Plans, phases, tasks, dependencies |
| agent-tracker | ~25 | Session queue, signals, resource locks, bypass requests, CTO session search |
| user-feedback | ~20 | Personas, features, scenarios, prerequisites, stability locks |
| product-manager | ~10 | PMF analysis pipeline |
| deputy-cto | ~8 | Reports, triage, delegation |

### Infrastructure Servers (Tier 1 — shared daemon)
| Server | Tools | Purpose |
|--------|-------|---------|
| secret-sync | ~15 | Credential resolution, services.json config, command execution |
| github | ~10 | GitHub API operations |
| cloudflare | ~5 | DNS and worker management |
| supabase | ~5 | Database operations |
| onepassword | ~5 | 1Password read/write |
| vercel | ~5 | Deployment management |
| render | ~5 | Service management |
| codecov | ~3 | Coverage tracking |
| resend | ~3 | Email sending |
| elastic-logs | ~5 | Log querying |

### Automation Servers
| Server | Tools | Purpose |
|--------|-------|---------|
| playwright | ~15 | Demo execution, test running, screenshots, video |
| chrome-bridge | 28 | Browser automation via Chrome extension |
| session-activity | ~5 | Session summary subscription/delivery |

### Content/Display Servers
| Server | Tools | Purpose |
|--------|-------|---------|
| specs-browser | ~5 | Spec file search and read |
| cto-report / cto-reports | ~5 | Static report generation |
| show | ~3 | Display utility |
| setup-helper | ~3 | Installation guidance |
| feedback-explorer | ~5 | Browse feedback history |
| icon-processor | 12 | Icon sourcing and processing |
| docs-feedback | 4 | Developer docs search/read |

### Feedback Agent Servers
| Server | Tools | Purpose |
|--------|-------|---------|
| feedback-reporter | ~5 | Submit feedback findings |
| playwright-feedback | ~5 | Browser-based feedback tools |
| programmatic-feedback | ~5 | CLI/API/SDK feedback tools |

### Other
| Server | Tools | Purpose |
|--------|-------|---------|
| workstream | ~5 | Workstream management |
| review-queue | ~3 | PR review queue |
| agent-reports | ~3 | Agent report filing |
| makerkit-docs | ~3 | MakerKit documentation (project-specific) |
| plugin-manager | ~5 | Plugin CRUD (gentyr repo only) |

---

## Category 4: Slash Commands (39)

### Demo Commands
demo, demo-all, demo-autonomous, demo-bulk, demo-interactive, demo-session, demo-validate

### Task Management
spawn-tasks, task-queue, triage, persistent-task, persistent-tasks, monitor-tasks

### Plan Management
plan, plan-progress, plan-timeline, plan-audit, plan-sessions

### Configuration
concurrent-sessions, configure-personas, focus-mode, lockdown, local-mode, setup-gentyr, toggle-automation-gentyr

### Operations
cto-dashboard, deputy-cto, session-queue, show, workstream

### Infrastructure
hotfix, push-migrations, push-secrets

### Analysis
persona-feedback, product-manager, replay, run-feedback, toggle-product-manager

### GENTYR Dev (repo-specific)
overdrive-gentyr

---

## Category 5: CLAUDE.md Managed Section

The `CLAUDE.md.gentyr-section` template is injected into every target project's CLAUDE.md. It contains:
- Merge chain rules (feature → preview → staging → main)
- Agent workflow (6-step pipeline: investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager)
- Sub-agent worktree isolation requirements
- Commit ownership rules (only project-manager commits)
- Demo system usage
- Chrome browser automation guidance
- MCP tool reference
- Secret management patterns

**This is the primary persistent behavioral instruction set.** It survives across all sessions and is loaded into every agent's context.

---

## Category 6: Session Briefing

`session-briefing.js` (SessionStart hook) injects a comprehensive one-time context block:
- Session queue status (running, queued, capacity)
- Active persistent tasks and their health
- Pending CTO bypass requests
- Focus mode status
- Active test scope
- Worktree freshness warnings
- Memory pressure level
- Recent agent activity summary

---

## Category 7: Prompt Templates (~10 builders)

| Builder | Location | Purpose |
|---------|----------|---------|
| buildPromptFromCategory() | lib/task-category.js | Standard 6-step pipeline prompt for spawned agents |
| buildPersistentMonitorRevivalPrompt() | lib/persistent-monitor-revival-prompt.js | Revival prompt with context, amendments, sub-task status |
| buildRevivalContext() | lib/persistent-revival-context.js | Enriched context from last_summary, amendments, sub-tasks |
| buildStrictInfraGuidancePrompt() | lib/strict-infra-guidance-prompt.js | MCP-only infrastructure instructions |
| buildPersistentMonitorStrictInfraInstructions() | lib/persistent-monitor-strict-infra-instructions.js | Monitor-specific infra guidance |
| persistent-monitor-demo-instructions.js | lib/ | Demo-specific monitor instructions |
| user-prompt-resolver.js | lib/ | Inject referenced user prompts into agent prompts |

---

## Category 8: Automation Scripts (24)

### Daemon/Service Scripts
| Script | Trigger | Purpose |
|--------|---------|---------|
| hourly-automation.js | Launchd (every minute, cooldown-gated) | Master automation: task spawning, worktree cleanup, reaping, promotions |
| revival-daemon.js | Launchd (KeepAlive) | Sub-second crash detection and agent revival |
| session-activity-broadcaster.js | Launchd (5-min poll) | Session summary generation and broadcast |
| preview-watcher.js | Launchd (30s poll) | Auto-merge worktrees on upstream changes |
| mcp-server-daemon.js | Launchd (KeepAlive) | Shared MCP daemon for Tier 1 servers |
| setup-automation-service.sh | Manual | Install/remove launchd services |
| watch-claude-version.js | Launchd | Monitor Claude Code version changes |

### Spawn Scripts
| Script | Trigger | Purpose |
|--------|---------|---------|
| force-spawn-tasks.js | /spawn-tasks command | Immediate task spawning bypassing cooldowns |
| force-triage-reports.js | /triage command | Immediate deputy-CTO triage |
| feedback-launcher.js | Staging change detection | Spawn persona feedback agents |
| feedback-orchestrator.js | /run-feedback command | Orchestrate feedback sessions |

### Utility Scripts
| Script | Purpose |
|--------|---------|
| reap-completed-agents.js | Legacy agent cleanup |
| setup.sh | Legacy installation |
| reinstall.sh | Reinstallation |
| setup-check.js / setup-validate.js | Installation verification |
| protect-framework.sh | Root-owned file protection |
| grant-chrome-ext-permissions.sh | Chrome debugger permissions |
| apply-credential-hardening.sh | Credential file hardening |
| encrypt-credential.js | Credential encryption |
| generate-protected-actions-spec.js | Protected action schema generation |
| generate-readme.js | README generation |
| mcp-launcher.js | MCP server process launcher |
| resign-node.sh | Code signing for Node.js |
| fix-mcp-launcher-issues.sh | MCP launcher troubleshooting |

---

## Control Surface Interaction Map

```
User/CTO Message
    │
    ├── UserPromptSubmit hooks (9) ──→ Context injection, leak detection, notification
    │
    ▼
Agent Reasoning (informed by CLAUDE.md + session briefing + plan briefing)
    │
    ├── PreToolUse hooks (12) ──→ BLOCK dangerous actions
    │
    ▼
Tool Execution (MCP tools, Bash, Read, Write, Edit, Agent)
    │
    ├── PostToolUse hooks (25) ──→ REACT: inject context, spawn agents, track progress
    │
    ▼
Agent Spawn (via Agent tool or session queue)
    │
    ├── Agent Definition (.md) ──→ Model, tools, behavioral constraints
    ├── Prompt Template ──→ Task-specific instructions, pipeline steps
    ├── SessionStart hooks (9) ──→ Initial context, health checks, briefing
    │
    ▼
Session Stop
    │
    ├── Stop hook (1) ──→ Gate completion, trigger revival if needed
    │
    ▼
Background Automation
    │
    ├── hourly-automation.js ──→ Spawn tasks, reap sessions, cleanup worktrees
    ├── revival-daemon.js ──→ Detect dead agents, revive immediately
    ├── session-activity-broadcaster.js ──→ Generate and deliver session summaries
    ├── preview-watcher.js ──→ Keep worktrees fresh
```
