# GENTYR

GENTYR is not a tool you micromanage. It is a team you direct.

Eleven agents work. A deputy CTO triages. You make the decisions that count.

**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

GENTYR turns Claude Code into an autonomous engineering team. It installs as a framework of agents, hooks, servers, and guards that govern how AI writes, tests, reviews, and ships code. You point it at a new SaaS project. It builds. You steer.

> **macOS only.** The automation services and window recording features use launchd and macOS APIs. Linux and Windows are not supported.

> **Install:** `pnpm add gentyr` (npm) or `pnpm link ~/git/gentyr` (local dev)

## who this is for

Solo founders building new SaaS products from scratch. You want a full engineering team without hiring one. You are willing to adopt a locked stack and let the framework make infrastructure decisions for you. This is not for existing codebases. GENTYR builds from the ground up.

## the stack

GENTYR chose managed services so every agent, hook, and server is purpose-built for exactly these tools. No abstraction layers. No configuration matrices. No "bring your own database."

TypeScript in strict mode is the only language. Next.js deploys to Vercel for the frontend. Hono deploys to Render for the backend API. Supabase provides PostgreSQL, auth, storage, and row-level security through a single API. Zod validates every payload at runtime. The compliance checker enforces this.

A pnpm monorepo organizes the project. GitHub Actions run CI/CD. 1Password resolves every secret at runtime through `op://` references. Cloudflare manages DNS. Elastic Cloud aggregates logs. Resend handles transactional email. Codecov tracks test coverage. Vitest runs unit tests. Playwright runs end-to-end tests.

This stack is not configurable. Thirty-two MCP servers are built for these exact tools. If you want a different database or hosting provider, this is not for you.

See [docs/STACK.md](docs/STACK.md) for technical details and MCP server mappings.

## core primitives

### agents

Twenty-four specialized roles. Fixed sequence: investigate, plan, write, test, review, align, analyze, audit. Each agent has restricted tool access and a single responsibility. The investigator cannot edit files. The code writer cannot deploy. The test writer cannot approve commits. The user-alignment agent cannot modify files. The product manager cannot modify code. No general-purpose fallback exists.

The persistent monitor is a long-running Opus session that the CTO delegates complex multi-step objectives to. It oversees sub-agents and drives work to completion without supervision. Create one with `/persistent-task`, manage all active monitors with `/persistent-tasks`.

### hooks

Ninety-one automation hooks triggered by session events, commits, timers, and failures. They run without being asked. Credential sync, test failure response, stale work detection, merge chain enforcement, compliance checking, antipattern scanning, secret leak detection, long-running command routing, audit gate enforcement, signal compliance validation, CTO authorization auditing. Hooks govern what agents can and cannot do.

### servers

Thirty-eight protocol servers connecting agents to external systems. Deployment platforms, secret vaults, task databases, plan orchestrators, log aggregators, feedback pipelines, coverage reporters. Agents never touch raw APIs. Every external interaction goes through a typed MCP server with a schema and a handler.

Fifteen stateless API-proxy servers (GitHub, Cloudflare, Supabase, Vercel, Render, and others) run as a single shared HTTP daemon instead of one process per agent session. A single daemon process on port 18090 replaces up to 15 per-session stdio processes, saving ~750MB RAM per concurrent agent. Installed via `setup-automation-service.sh`; auto-detected by `config-gen.js` which rewrites `.mcp.json` with HTTP entries when the daemon is running.

### the merge chain

Four stages: feature, preview, staging, main. Enforced locally by root-owned hooks that agents cannot modify. Preview requires passing tests. Staging requires deputy-CTO approval. Main requires CTO sign-off. Stale work is detected and reported automatically.

### the deputy

An autonomous Opus agent that reviews every PR before it merges, triages reports, spawns urgent tasks, and escalates decisions to you. Runs on a background timer. You interact through one command: `/deputy-cto`.

## how it runs

Tasks enter the database. The task runner assigns agents on a timer. Agents work in isolated git worktrees. Code flows through the merge chain. The deputy reviews every PR before it merges. Hooks enforce compliance on every file change. Dead sessions revive automatically. Persistent monitors drive complex objectives to completion without supervision.

You make the decisions that matter. Automation handles everything else.

## quick start

```bash
git clone git@github.com:gentyr/gentyr.git
cd /path/to/project
pnpm link ~/git/gentyr        # node_modules/gentyr -> ~/git/gentyr
npx gentyr init --op-token <token>
npx gentyr protect
```

No 1Password? Use local mode — all 24 local servers stay fully functional:

```bash
npx gentyr init --local
```

Start Claude Code in your project and run `/setup-gentyr` to configure credentials. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for details.

## the CTO dashboard

This is what the CTO sees. Run `/cto-report` for a static multi-page report in the Claude Code session, or `/cto-dashboard` to open a live TUI in a new Terminal.app window (polls every 3 seconds, keyboard-navigable).

<img src="docs/assets/claude-logo.svg" width="69" height="70" align="left">

&nbsp; **Claude Code** v2.1.34<br>
&nbsp; Opus 4.6 · Claude Max<br>
&nbsp; `~/git/my-project`

<!-- CTO_DASHBOARD_START -->
```
❯ /cto-report
     UserPromptSubmit says: Quota (2 accounts): 5h ██████░░░░░░░░░░ 35% | 7d ██████████████░░ 88%
     Accounts: dev@acme.io (33% 5h) | ops@acme.io (2% 5h)
     Usage (30d): 2371.0M tokens | 318 task / 279 user sessions | TODOs: 278 queued, 2 active | Deputy: ON (ready)
     Pending: 5 CTO decision(s)

⏺ Bash(node packages/cto-dashboard/dist/index.js)
     ╭─ QUOTA & CAPACITY ──────────────────╮ ╭─ SYSTEM STATUS ──────────────────────╮
     │ 5-hour   ██████░░░░░░░░░░  35%      │ │ Deputy CTO: ENABLED                  │
     │ 7-day    ██████████████░░  88%      │ │   Runs every 50m | Next: 10:26AM (3… │
     │  Tip: /show quota                   │ │ Protection: PROTECTED                │
     │                                     │ │ Commits:    BLOCKED                  │
     ╰─────────────────────────────────────╯ ╰──────────────────────────────────────╯
     
     ╭─ DEPUTY CTO ─────────────────────────────────────────────────────────────────╮
     │ ╭────────────╮ ╭────────────╮ ╭────────────╮ ╭─────────────╮                 │
     │ │ Untriaged  │ │ Escalated  │ │ Pending Q  │ │ 24h Handled │                 │
     │ │ 2          │ │ 4          │ │ 5          │ │ 3           │                 │
     │ ╰────────────╯ ╰────────────╯ ╰────────────╯ ╰─────────────╯                 │
     │                                                                              │
     │ ╭───────────────╮ ╭───────────────╮                                          │
     │ │ 24h Escalated │ │ 24h Dismissed │                                          │
     │ │ 4             │ │ 2             │                                          │
     │ ╰───────────────╯ ╰───────────────╯                                          │
     │                                                                              │
     │ ◆ UNTRIAGED (2)                                                              │
     │    Title                              Priority  Time                         │
     │ ────────────────────────────────────────────────────────────                 │
     │ ◆  Hardcoded JWT secret detected in…  critical  18m ago                      │
     │ ◆  Missing RLS policy on user_sessi…  high      47m ago                      │
     │                                                                              │
     │ ▲ ESCALATED                                                                  │
     │    Title                              Priority  Time                         │
     │ ────────────────────────────────────────────────────────────                 │
     │ ◆  API rate-limiting bypass via hea…  critical  2h ago                       │
     │ ◆  CORS wildcard allowed on product…  high      4h ago                       │
     │ ◆  Service account has write access…  high      6h ago                       │
     │ ◆  PII logged in request bodies und…  high      8h ago                       │
     │                                                                              │
     │ ? PENDING QUESTIONS (5)                                                      │
     │    Title                              Type      Time                         │
     │ ────────────────────────────────────────────────────────────                 │
     │ ?  Should the triage pipeline use a…  architectu25m ago                      │
     │                                       re                                     │
     │    └─ Stay with SQLite for now — add a migrati…                              │
     │ ?  Approve relaxing CSP to allow in…  security  52m ago                      │
     │    └─ Reject — use CSS variables and data attr…                              │
     │ ?  G009 exemption request: skip pre…  compliance1h ago                       │
     │    └─ Grant exemption only for files in dist/ …                              │
     │ ?  Which caching layer for the quot…  architectu2h ago                       │
     │                                       re                                     │
     │    └─ Cache at 5-minute TTL in memory — no ext…                              │
     │ ?  Should oauth tokens be stored in…  security  3h ago                       │
     │    └─ Use Supabase Vault with envelope encrypt…                              │
     │                                                                              │
     │ ────────────────────────────────────────────────────────────                 │
     │                                                                              │
     │ ○ Recently Triaged                                                           │
     │    Title                              Priority  Outcome     Time             │
     │ ────────────────────────────────────────────────────────────────────────     │
     │ ◆  Unused env vars referencing dele…  low       ✕ Dismissed 9h ago           │
     │ ◆  Dependency audit: lodash 4.17.20…  normal    ✓ Handled   11h ago          │
     │ ◆  Spec G003 violation: Zod schema …  high      ↑ Escalated 13h ago          │
     │ ◆  Antipattern detected: silent cat…  critical  ↑ Escalated 15h ago          │
     │ ◆  TypeScript strict mode disabled …  normal    ✓ Handled   17h ago          │
     │ ◆  Session token expiry not validat…  high      ↑ Escalated 19h ago          │
     │ ◆  Missing index on foreign key: ta…  low       ✕ Dismissed 21h ago          │
     │ ◆  Compliance check: G004 hardcoded…  normal    ✓ Handled   22h ago          │
     │  Tip: /show deputy-cto                                                       │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ AUTOMATED INSTANCES ────────────────────────────────────────────────────────╮
     │ Type                  Runs (24h)  Until Next    Freq Adj                     │
     │ ───────────────────────────────────────────────────────────────────          │
     │ Triage Check          0           5m            +80% slower                  │
     │ Lint Checker          9           16m           +80% slower                  │
     │ CLAUDE.md Refactor    3           38m           +80% slower                  │
     │ Task Runner           8           36m           +80% slower                  │
     │ Production Health     14          52m           +80% slower                  │
     │ Compliance (Sched.)   4           1h12m         +80% slower                  │
     │ User Feedback         2           1h48m         +80% slower                  │
     │ Antipattern Hunter    3           3h24m         +80% slower                  │
     │ Staging Health        7           2h9m          +80% slower                  │
     │ Preview Promotion     1           5h18m         +80% slower                  │
     │ Staging Promotion     0           18h42m        +80% slower                  │
     │ Staging Review        2           42m           -                            │
     │ ───────────────────────────────────────────────────────────────────          │
     │ Pre-Commit Hook       18          on commit     +80% slower                  │
     │ Test Suite            5           on failure    +80% slower                  │
     │ Compliance (Hook)     11          on change     baseline                     │
     │ Todo Maintenance      7           on change     +80% slower                  │
     │ Demo Repair           1           on failure    -                            │
     │ Persistent Monitor    6           on demand     -                            │
     │ Universal Auditor     4           on demand     -                            │
     │ Plan Auditor          2           on demand     -                            │
     │ Task Gate             3           on demand     -                            │
     │ Session Revival       5           on demand     -                            │
     │                                                                              │
     │ Usage Target: 90%  |  Current Projected: 2%  |  Adjusting: → stable          │
     │                                                                              │
     │ Token Usage by Automation (24h)                                              │
     │ Task Runner         ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆ 85.4M │
     │ Pre-Commit Hook     ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆               61.9M │
     │ Antipattern Hunter  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆                       48.4M │
     │ Lint Checker        ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆                             37.7M │
     │ Compliance (Hook)   ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆                                  29.1M │
     │ Compliance (Sched.) ▆▆▆▆▆▆▆▆▆▆▆▆▆                                      22.7M │
     │ Production Health   ▆▆▆▆▆▆▆▆▆▆                                         18.5M │
     │ CLAUDE.md Refactor  ▆▆▆▆▆▆▆▆                                           14.3M │
     │ User Feedback       ▆▆▆▆▆▆                                             11.8M │
     │ Staging Health      ▆▆▆▆                                                8.5M │
     │ Test Suite          ▆▆▆                                                 5.9M │
     │                                                                              │
     │ Tip: Ask Claude Code to adjust frequency or switch modes (load balanced /    │
     │ static).                                                                     │
     │  Tip: /show automations                                                      │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ METRICS SUMMARY ────────────────────────────────────────────────────────────╮
     │ ╭─ Tokens ────────╮ ╭─ Sessions ─────╮ ╭─ Agents ───────╮ ╭─ Tasks ────────╮ │
     │ │ In: 148.3K      │ │ Task: 148      │ │ Spawns: 41     │ │ Pending: 278   │ │
     │ │ Out: 118.0K     │ │ User: 34       │ │ Types: 8       │ │ Active: 2      │ │
     │ │ Cache: 49%      │ │ Total: 182     │ │                │ │ Done: 21       │ │
     │ ╰─────────────────╯ ╰────────────────╯ ╰────────────────╯ ╰────────────────╯ │
     │                                                                              │
     │ ╭─ Hooks (24h) ───╮ ╭─ Triage ───────╮ ╭─ CTO Queue ────╮ ╭─ Cooldowns ────╮ │
     │ │ Total: 447      │ │ Pending: 0     │ │ Questions: 5   │ │ Factor: 0.6x   │ │
     │ │ Success: 99%    │ │ Handled: 4     │ │ Rejections: 1  │ │ Target: 90%    │ │
     │ │ Skipped: 44     │ │ Escalated: 14  │ │ Triage: 0      │ │ Proj: 1.8%     │ │
     │ │ Failures: 3     │ │                │ │                │ │                │ │
     │ ╰─────────────────╯ ╰────────────────╯ ╰────────────────╯ ╰────────────────╯ │
     │  Tip: /show tasks                                                            │
     ╰──────────────────────────────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · PR #9 · ctrl+t to hide tasks
```
<!-- CTO_DASHBOARD_END -->

See [docs/CTO-DASHBOARD.md](docs/CTO-DASHBOARD.md) for the full report.

The static report is auto-generated. To refresh:

```bash
npm run generate:readme
```

## the automation layer

Eighty-six hooks and background timers keep the system running without human triggers.

### credentials

Single-account model. The `credential-health-check.js` hook validates credentials at session start. 1Password resolves all secrets at runtime through `op://` references — no credentials stored in `.env` files or agent context windows. The secret-sync MCP server propagates secrets to deployment platforms without exposing values to agents.

### session recovery

Three modes. Interrupted sessions resume automatically via `--resume`. Dead agents are detected immediately at session start and also cross-referenced by the periodic reaper. Session revival follows worktree-based agents into their original working directories. Paused sessions re-spawn immediately when a slot opens. Persistent monitors have their own dedicated revival path: dead monitors re-enqueue at critical priority within seconds, with a crash-loop circuit breaker (max 5 revivals per hour) that auto-pauses the task if a monitor crashes repeatedly. When a monitor hits the circuit breaker, the **self-healing system** (`lib/blocker-auto-heal.js`) classifies the failure type (rate-limit cooldown, auth error, or crash) and automatically spawns a targeted investigation task to diagnose and fix the root cause. If fix attempts are exhausted (configurable, default 3), the system escalates to the CTO via a bypass request rather than spinning indefinitely.

### task orchestration

A background timer spawns agents for pending tasks every cycle. Urgent tasks dispatch immediately. Normal tasks wait one hour. Concurrency configurable (default 10 simultaneous agents) via `set_max_concurrent_sessions` or `/concurrent-sessions`. All spawning routes through a single SQLite-backed session queue with priority ordering (`cto` > `critical` > `urgent` > `normal` > `low`), reserved slot pools for high-priority work, inline preemption (SIGTSTP/SIGCONT — non-destructive), and focus mode to block automated spawning except CTO-directed work. An `automated` lane handles background system sessions (22 sources including `hourly-automation`, `demo-failure-spawner`, `session-reviver`, etc.) with no concurrency limit — automated sessions are excluded from the standard slot count so background work never competes with CTO-directed tasks. `get_session_queue_status` reports `standardRunning` and `automatedRunning` separately.

When the aggregate Anthropic API quota reaches 99% on either the 5-hour or 7-day usage window, all non-CTO sessions are killed automatically and new enqueues are blocked — only the CTO's interactive session (`priority: 'cto'`) passes through. A dedicated `quota-recovery-daemon.js` (KeepAlive launchd service) watches for the reset time and resumes all sessions within 10 seconds of quota recovery. The CTO notification hook shows `QUOTA EXHAUSTED` in the status line during exhaustion. State at `.claude/state/quota-exhaustion.json`; to manually clear: delete that file.

Structured multi-phase work is managed by the plan orchestrator (`plan-orchestrator` MCP server). Plans contain phases, tasks, substeps, and dependency graphs with cycle detection. Progress rolls up automatically from substep to plan. PR merges auto-advance linked plan tasks via the plan-merge-tracker hook. Four dashboard views (`/plan`, `/plan-progress`, `/plan-timeline`, `/plan-audit`) show live execution state. Plans are executed by a dedicated `plan-manager` agent — itself a specialized persistent task monitor — which spawns a separate persistent task per plan step and tracks them to completion. **Activating a plan (`update_plan_status(status: "active")`) automatically spawns the plan-manager** via the `plan-activation-spawner` PostToolUse hook — do NOT manually spawn tasks or call `get_spawn_ready_tasks`/`force_spawn_tasks` after activation; the plan-manager handles all orchestration automatically. The `plan-persistent-sync.js` hook auto-completes linked plan tasks when their persistent task finishes, cascading phase and plan completion automatically. A multi-layer completion gate prevents plans from being marked complete when verification phases were skipped: gate phases block task skipping entirely, skipped phases do not count as complete, and plans with any skipped required phase require explicit `force_complete` with a justification note. All plan tasks require a `verification_strategy` field — `add_plan_task` rejects tasks that omit it. When the task is marked complete, it enters `pending_audit` status and `plan-audit-spawner.js` enqueues an independent Sonnet `plan-auditor` in the `audit` session lane (8-min TTL). The auditor verifies the completion evidence matches the strategy, then calls `verification_audit_pass` (advances to `completed`, cascades) or `verification_audit_fail` (resets to `in_progress`) — preventing plan managers from accepting unverified success claims. Stale auditors are detected by `session-reaper.js` and re-spawned automatically.

Non-exempt todo-db tasks and persistent tasks require `gate_success_criteria` (or its alias `verification_strategy`) — the server rejects task completion for tasks that were created without these fields, enforcing the Universal Audit Gate for all deliverable work. On completion, `universal-audit-spawner.js` transitions the task to `pending_audit` and enqueues an independent `universal-auditor` agent in the `audit` session lane. The auditor verifies actual artifacts against the stated criteria, then passes or fails the gate — preventing agents from claiming completion without evidence. Gate-exempt categories (Triage & Delegation, Project Management, Workstream Management) complete directly. The `gate-confirmation-enforcer.js` PreToolUse hook blocks any re-completion attempt while the audit is in progress. The `signal-compliance-gate.js` hook validates all inter-agent signals before delivery, and directive signals must be acknowledged before an agent can complete its task.

Complex delegated objectives run through the persistent task system. The CTO creates a persistent task via `/persistent-task`, which refines the intent into a high-specificity prompt and spawns a dedicated Opus monitor session. The monitor runs in its own session queue lane (not counted against the global concurrency cap), creates and tracks sub-tasks, acknowledges amendments as the CTO steers the objective, and drives work to completion without interruption. Manage all active monitors with `/persistent-tasks`. An optional Global Deputy-CTO Monitor (persistent task with `GENTYR_DEPUTY_CTO_MONITOR=true`) continuously checks active tasks for alignment with CTO intent, dispatching user-alignment sub-agents before code is written and escalating significant drift.

Task routing is driven by a category system stored in `todo.db`. Each category defines an agent pipeline (sequence of sub-agent types), model tier, creator restrictions, and urgency authorization. Five categories are seeded by default: Standard Development (6-step pipeline), Deep Investigation, Test Suite Work, Triage & Delegation, and Demo Design. Categories replace the legacy hardcoded section routing and can be created or modified at runtime via MCP tools without code changes.

Agents blocked by authorization or access constraints use the bypass request system instead of failing silently. The agent calls `submit_bypass_request` (on the `agent-tracker` MCP server), which pauses the task and surfaces the request in the CTO's next session briefing with a one-call resolution (`resolve_bypass_request`). On approval, the task is immediately revived with the CTO's instructions injected into the revival prompt. All revival paths check for pending bypass requests before spawning, preventing auto-resumption while a request is awaiting the CTO. For agents that hit a protected MCP action block, the **Unified CTO Authorization System** stores the blocked tool call as a deferred action — the agent presents the context to the CTO and calls `record_cto_decision` with the CTO's verbatim response. An independent `authorization-auditor` then verifies the CTO was presented accurate context (via session JSONL inspection), and on audit pass, `deferred-action-audit-executor.js` executes the blocked action autonomously — no phrase to type, no agent session required. **Bypass request visibility**: The CTO notification hook injects pending bypass request details directly into model context on every prompt — the CTO never needs to explicitly ask about blocked work.

### code quality

The compliance checker validates against framework specifications on every file change. The antipattern hunter scans for silent catches, hardcoded secrets, and disabled tests. Test failures auto-spawn the test-writer agent. Lint runs on every cycle. Every PR is reviewed by the deputy CTO before it merges. Feature branch commits pass through lint and security gates only, keeping commit latency low.

**100% test coverage gate**: Production promotion is hard-gated on 100% coverage (lines, statements, functions, branches). When CI fails the coverage check, the preview-promoter agent autonomously spawns test-writer sub-agents, waits for completion, and re-runs CI — up to 3 iterations — before escalating. The CI template (`templates/github/workflows/ci.yml.template`) enforces this on every push. Agents never ask the CTO to approve a PR with failing CI — they fix it themselves or escalate only after exhausting attempts.

### deployment pipeline

The merge chain promotes code through four stages on configurable timers. The stale work detector flags uncommitted changes and unpushed branches. Feedback agents spawn on staging changes to test the product as real users across GUI, CLI, API, and SDK modes.

When staging is ready for production, `/promote-to-prod` orchestrates an 8-phase release plan: per-PR quality review, initial triage, meta-review, test and demo execution, demo coverage audit, final triage, CTO sign-off, and release report generation. The plan-manager runs autonomously through all phases, locks staging during the release, collects artifacts (session transcripts, screenshots, triage actions), and unlocks staging when the release is signed off. The CTO reviews and approves at Phase 7 via `sign_off_release`.

A synthetic monitoring daemon (`scripts/synthetic-monitor.js`) probes health endpoints from `services.json` every 60 seconds (production) or 5 minutes (staging). When 3 or more consecutive failures are detected within 5 minutes of a deploy, the auto-rollback pipeline (`auto-rollback.js`) automatically reverts to the last known-good deployment — Vercel via `npx vercel rollback` or Render via REST API. This is safe because all database migrations must be backward-compatible (enforced by the migration safety gate), so rolling back code leaves the database in a valid state for the prior version.

### protection

Critical files are root-owned. Agents cannot modify the hooks, guards, or specs that govern them. The credential file guard blocks agents from reading `.mcp.json`. Secret leak detection scans every diff. Protected path enforcement triggers on any write attempt to `.claude/hooks/`.

See [docs/AUTOMATION-SYSTEMS.md](docs/AUTOMATION-SYSTEMS.md) for implementation details.

## the feedback loop

AI personas test the product as real users. Five modes: GUI, CLI, API, SDK, ADK. No source code access. Personas interact with the running application and report findings. Those findings go to the deputy-CTO triage pipeline. SDK agents test the SDK in a scratch workspace with browser-based docs access; ADK agents do the same programmatically via the docs-feedback MCP server. Not testing code. Testing product.

Persona profiles let the CTO snapshot an entire persona configuration — personas, features, and a strategic guiding prompt — and switch between named market-research configurations instantly. The active profile's guiding prompt surfaces in the session briefing and in the product-manager's analysis context.

## secret management

Zero secrets on disk. Zero secrets in agent context. 1Password is the single source of truth. Agents request secrets by name. The server resolves `op://` references internally. Output is sanitized to replace accidentally leaked values with `[REDACTED]`. The executable allowlist prevents arbitrary command injection.

## local plugins

GENTYR supports local-only extensions via a gitignored `plugins/` directory. Each plugin is a self-contained Node package with a `config.json` (managed via MCP tools) and an optional MCP server that auto-registers in `.mcp.json` when working in the gentyr repo. The plugin-manager MCP server (`list_plugins`, `get_plugin_config`, `set_plugin_config`, `add_plugin_mapping`, `remove_plugin_mapping`) is the entry point for managing plugin configuration.

The Notion plugin (`plugins/notion/`) syncs four GENTYR data sources to Notion databases via a 60-second launchd daemon: AI user feedback personas (full-sync each cycle), feedback review sessions (waterline on `completed_at`), worklog entries (waterline on `timestamp_completed`), and todo tasks (sync-time waterline for new tasks, status transitions, and archived task detection — tasks moved to the `archived_tasks` table are PATCHed to status `Done` and `Archived` checkbox `true` in Notion; all task upserts write the `Archived` checkbox unconditionally so the Tasks database remains filterable by archive state). Managed via five MCP tools: `notion_check_status`, `notion_sync`, `notion_start_service`, `notion_stop_service`, `notion_setup_instructions`.

## components

39 MCP servers. 21 agents. 86 hooks. 42 commands. CLI dashboard. Plugin system with extensible local MCP servers.

## documentation

- [Setup Guide](docs/SETUP-GUIDE.md) -- installation, credentials, protection, troubleshooting
- [Executive Overview](docs/Executive.md) -- architecture, capability inventory, dashboard reference
- [Deployment Flow](docs/DEPLOYMENT-FLOW.md) -- preview, staging, production promotion pipeline
- [Stack](docs/STACK.md) -- infrastructure providers, MCP mappings, monorepo structure
- [Automation Systems](docs/AUTOMATION-SYSTEMS.md) -- quota management, session recovery, usage optimization
- [CTO Dashboard](docs/CTO-DASHBOARD.md) -- full dashboard output
- [Credential Detection](docs/CREDENTIAL-DETECTION.md) -- multi-layer API key detection architecture
- [Secret Paths](docs/SECRET-PATHS.md) -- canonical 1Password `op://` references
- [Testing](docs/TESTING.md) -- AI user feedback system and end-to-end test plan
- [Developer Guide](docs/DEVELOPER.md) -- local development from cloned source, propagation model
- [Changelog](docs/CHANGELOG.md) -- version history

## requirements

- Node.js 20+
- pnpm 8+
- Claude Code CLI
- Claude Max subscription (Opus 4.6)
- 1Password CLI (optional, for infrastructure credentials)

---

GENTYR treats development as continuous orchestration rather than episodic prompting.

Agents coordinate. Products ship.

```
pnpm link ~/git/gentyr && npx gentyr init --op-token <token>
```

## license

[MIT](LICENSE)
