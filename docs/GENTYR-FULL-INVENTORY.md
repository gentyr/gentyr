# GENTYR Framework — Full System Inventory

> Research pass: Scope discovery only. Sections are empty placeholders for deep-dive analysis.

---

## 1. Installation & Initial Setup

### 1.1 CLI Commands
- `npx gentyr init` — 16-stage fresh installation
- `npx gentyr sync` — Force rebuild MCP + re-merge configs + session recycling
- `npx gentyr status` — Show installation state
- `npx gentyr protect` / `unprotect` — Root-owned file protection
- `npx gentyr migrate` — Legacy .claude-framework to npm model
- `npx gentyr uninstall` — Clean removal
- `npx gentyr scaffold` — New project from templates

### 1.2 Installation Models
- npm link (`node_modules/gentyr -> ~/git/gentyr`) — preferred
- Legacy symlink (`.claude-framework`) — deprecated
- Gentyr repo itself (`.`) — self-referential

### 1.3 Init Stages (16 stages)
- Stage 1: Framework verification
- Stage 2: Pre-create state files (DBs, JSON state, WAL/SHM files)
- Stage 3: Symlink setup (commands, hooks, mcp, docs, agents)
- Stage 4: Settings.json merge
- Stage 5: .mcp.json generation from template
- Stage 6: Shell profile OP token sync
- Stage 7: Git hooks installation (husky: pre-commit, post-commit, pre-push)
- Stage 8: GitHub Actions & branch protection
- Stage 9: Dependency & MCP build (npm install + tsc)
- Stage 10: op-secrets.conf generation
- Stage 11: Automation service setup (launchd/systemd)
- Stage 12: .gitignore update
- Stage 13: Specs directory creation
- Stage 14: Test failure reporters
- Stage 15: CLAUDE.md managed section injection
- Stage 16: Sync state write

### 1.4 Local Prototyping Mode
- `npx gentyr init --local` — no remote servers, no 1Password needed
- `/local-mode` toggle at runtime
- What's excluded vs what keeps running

### 1.5 /setup-gentyr Slash Command (Interactive Setup Wizard)
- Phase 1: Setup check (credential inventory)
- Phase 2: Claude account inventory
- Phase 3: Missing secrets guide (9 credential phases)
- Phase 4: Missing identifiers
- Phase 5: Write vault-mappings.json

---

## 2. Credential & Secret Management

### 2.1 Architecture: Zero-Disk Secret Storage
- `op://` references only — never raw values on disk
- Runtime resolution via MCP shared daemon
- 1Password as source of truth

### 2.2 1Password Integration
- `OP_SERVICE_ACCOUNT_TOKEN` — headless resolution for automation
- `op_vault_map` — discover available op:// references
- `create_item` / `add_item_fields` — programmatic item creation
- `read_secret` / `list_items` / `check_auth`
- Service account vs interactive auth

### 2.3 Credential Inventory (40+ credentials)
- GitHub: `GITHUB_TOKEN`
- Render: `RENDER_API_KEY`
- Vercel: `VERCEL_TOKEN`
- Cloudflare: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`
- Supabase: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_ACCESS_TOKEN`
- Elastic: `ELASTIC_API_KEY`, `ELASTIC_CLOUD_ID`
- Resend: `RESEND_API_KEY`
- Codecov: `CODECOV_TOKEN`
- Fly.io: `FLY_API_TOKEN`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`

### 2.4 Secret Sync to Deployment Platforms
- `secret_sync_secrets` — push from 1Password to Render/Vercel
- `populate_secrets_local` — add op:// refs to services.json
- Secret profiles (named bundles of keys)
- `/push-secrets` slash command

### 2.5 Credential Health Check (SessionStart hook)
- Verifies 1Password connectivity
- Warns about missing secrets.local entries
- Skipped in local mode

### 2.6 Gap: Chrome-Bridge Guided API Key Setup
- **NOT IMPLEMENTED**: No automated chrome-bridge flow for initial API key creation
- Users must manually create accounts and enter tokens via `read -rs`
- Opportunity: Guide account creation + key extraction via browser automation

---

## 3. External Vendor Integrations

### 3.1 Vendor → MCP Server Mapping

| Vendor | MCP Server | Function | Tools |
|--------|-----------|----------|-------|
| GitHub | github | Source control, PRs, issues, CI | 29 tools |
| Cloudflare | cloudflare | DNS management | 7 tools |
| Supabase | supabase | Database CRUD, users, SQL | 20 tools |
| Vercel | vercel | Frontend hosting, deployments | 16 tools |
| Render | render | Backend hosting, services | 15 tools |
| Codecov | codecov | Test coverage tracking | 15 tools |
| Resend | resend | Transactional email | 12 tools |
| Elastic Cloud | elastic-logs | Logging, observability | 4 tools |
| 1Password | onepassword | Secrets management | 9 tools |
| Fly.io | playwright (embedded) | Ephemeral compute for demos/tests | Part of playwright server |
| Steel.dev | playwright (embedded) | Stealth cloud browser | Part of playwright server |
| Stripe | (via secret-sync) | Billing (target project) | Accessed via secret_run_command |

### 3.2 GitHub Integration (29 tools)
### 3.3 Cloudflare Integration (7 tools)
### 3.4 Supabase Integration (20 tools)
### 3.5 Vercel Integration (16 tools)
### 3.6 Render Integration (15 tools)
### 3.7 Codecov Integration (15 tools)
### 3.8 Resend Integration (12 tools)
### 3.9 Elastic Cloud Integration (4 tools)
### 3.10 1Password Integration (9 tools)
### 3.11 Fly.io Ephemeral Compute
### 3.12 Steel.dev Stealth Browser

---

## 4. MCP Server Architecture

GENTYR hosts 40+ MCP servers across two tiers—stateless Tier 1 in a shared daemon, and session-specific Tier 2 via stdio—saving ~750MB RAM per concurrent agent.

### 4.1 Two-Tier Server Model

**Purpose** — Separate stateless API proxies (shared process) from stateful database servers (per-session process).

**Architecture** —
- **Tier 1 (Shared Daemon)**: 15 servers on port 18090 (localhost). JSON-RPC 2.0 over HTTP POST. Zero per-session overhead.
- **Tier 2 (Per-Session Stdio)**: 25+ servers launched on-demand. Each has own process, state, DB connections.
- **Transport**: Tier 1 = http-transport.ts. Tier 2 = stdio (JSON-RPC 2.0 over stdin/stdout via mcp-launcher.js).

**Startup**: Phase 1 (immediate HTTP bind, status:starting) → Phase 2 (parallel credential resolution, status:ok). Retry loop for failed credentials: 30s, 1m, 2m, 4m, 5m.

### 4.2 Configuration & Generation

**Purpose** — Generate per-project .mcp.json with correct transport, credentials, and project-local server preservation.

**Architecture** — `config-gen.js` orchestrates:
1. Template substitution (${FRAMEWORK_PATH})
2. OP token injection (preserves across regeneration)
3. Daemon detection (plist/systemd/state file → convert Tier 1 to HTTP entries)
4. Local mode filtering (removes REMOTE_SERVERS)
5. Project-local server preservation (non-template names survive regeneration)
6. Plugin discovery (plugins/*/dist/server.js → auto-register)

**Key Files** — `lib/shared-mcp-config.js` (TIER1_SERVERS list, port, preservation helpers), `cli/lib/config-gen.js` (generation logic), `scripts/mcp-launcher.js` (Tier 2 startup wrapper + credential resolution), `packages/mcp-servers/src/shared/http-transport.ts` (HTTP transport)

### 4.3 Integration Points & Monitoring

**Integration** — Daemon detection in config-gen.js. Vault mappings (vault-mappings.json) for op:// refs. Session queue coordinates Tier 2 tools for multi-agent work. Protected actions (protected-actions.json) gate MCP calls.

**Monitoring** — `GET /health` (status, servers, uptime). `GET /secrets/stats` (cache hit rate). `POST /secrets/flush` (clear cache). Daemon log: `.claude/mcp-daemon.log`. Audit: `.claude/op-cache-audit.jsonl`.

### 4.4 Complete Server Inventory (~730+ tools)

| Server | Tier | Tools | Primary Function |
|--------|------|-------|------------------|
| agent-tracker | 2 | 64 | Session queue, signals, locks, bypass, automation toggles |
| chrome-bridge | 2 | 44 | Browser automation via Chrome extension socket |
| cloudflare | 1 | 7 | DNS management |
| codecov | 1 | 15 | Coverage tracking |
| cto-report | 1 | 4 | CTO metrics aggregation |
| cto-reports | 2 | 11 | Agent report triage queue |
| deputy-cto | 2 | 34 | Questions, commit control, automation, bypass |
| elastic-logs | 1 | 4 | Log querying, config verification |
| feedback-explorer | 1 | 8 | Feedback browsing |
| feedback-reporter | 2 | 4 | Feedback HTML reports |
| github | 1 | 29 | PRs, issues, repos, workflows |
| icon-processor | 2 | 16 | Icon sourcing, SVG processing |
| investigation-log | 2 | 6 | Hypothesis/solution tracking |
| onepassword | 1 | 9 | Vault items, secret retrieval, item creation |
| persistent-task | 2 | 18 | Persistent task lifecycle, amendments, audit |
| plan-orchestrator | 2 | 25 | Plans, phases, tasks, dependencies, audit |
| playwright | 2 | 55 | Demo execution, test running, video, Fly.io |
| playwright-feedback | 2 | 32 | Browser-based feedback collection |
| plugin-manager | 2 | 6 | Plugin management (gentyr repo only) |
| product-manager | 2 | 15 | PMF analysis pipeline |
| programmatic-feedback | 2 | 7 | CLI/API feedback submission |
| release-ledger | 2 | 20 | Release evidence chain, CTO approval |
| render | 1 | 15 | Backend hosting, services |
| resend | 1 | 12 | Transactional email |
| secret-sync | 1 | 16 | Credential resolution, services.json, command execution |
| setup-helper | 1 | 11 | Installation checks |
| show | 1 | 22 | CTO dashboard section rendering |
| specs-browser | 1 | 12 | Spec file navigation, search |
| supabase | 1 | 20 | Database CRUD, users, SQL |
| todo-db | 2 | 38 | Tasks, categories, gate, audit, worklog |
| user-feedback | 2 | 40 | Personas, features, scenarios, prerequisites, profiles |
| vercel | 1 | 16 | Frontend hosting, deployments |
| workstream | 2 | 8 | Queue dependencies |
| docs-feedback | 2 | 4 | Developer docs search/read |

**Failure Modes** — HTTP 404: server not in TIER1_SERVERS. Status:starting timeout: credentials stuck. Port conflict: change MCP_DAEMON_PORT. Local mode: remote servers excluded. Project-local collision: gentyr servers always win.

---

## 5. Session Lifecycle Management

Session lifecycle management is the heartbeat of GENTYR's agent orchestration. Every Claude agent spawned by hooks goes through a centralized session queue with enforced concurrency limits, priority ordering, memory-aware throttling, and multi-mechanism revival on failure.

---

### 5.1 Centralized Session Queue

**Purpose** — Single source of truth for all agent spawning, enforcing concurrency caps, deduplication, and lane-based prioritization.

**Architecture** — SQLite-backed WAL queue with three layers: enqueueing (spec validation + 7 gate checks), draining (spawning up to concurrency limit), and reconciliation (reaping + revival). All spawners route through `enqueueSession()`.

**Data Model** — `.claude/state/session-queue.db`:
- **queue_items** — id, status (queued|spawning|running|suspended|completed|failed|cancelled), priority (cto>critical>urgent>normal>low), lane (standard|revival|gate|audit|persistent), spawn_type (fresh|resume), agent_id, pid, enqueued_at, spawned_at, completed_at, metadata (JSON: taskId, persistentTaskId, planId), error, expires_at (30-min TTL default)
- **queue_config** — max_concurrent_sessions (1-50, default 10), reserved_slots (0-10), reserved_slots_restore (with autoRestoreMinutes)
- **revival_events** — task_id, reason, created_at, diagnosis (JSON failure classification)

**Key Files** —
- `.claude/hooks/lib/session-queue.js` (2,334 lines) — Core queue module
- `.claude/hooks/lib/session-reaper.js` (1,085 lines) — Death detection
- `.claude/hooks/lib/session-audit.js` (119 lines) — Audit event emission
- `.claude/hooks/lib/memory-pressure.js` (256 lines) — RAM monitoring

**MCP Tools** (on agent-tracker server) —
- `get_session_queue_status` — Running items (PID liveness), queued count, capacity, memory pressure level, 24h throughput
- `set_max_concurrent_sessions` — Update global limit (1-50)
- `cancel_queued_session` — Cancel queued (not running) items by queue ID
- `drain_session_queue` — Force immediate drain; returns memoryBlocked count
- `activate_queued_session` — Promote queued item to CTO priority and spawn; suspends lowest-priority if at capacity

**Hooks** — PostToolUse hooks enqueue sessions (task-gate-spawner, persistent-task-spawner, urgent-task-spawner, plan-activation-spawner, universal-audit-spawner); drainQueue runs synchronously inside enqueueSession().

**Integration Points** — All spawners (task/plan/persistent-monitor/auditor/gate), session-reaper (sync pass in drain cycle), revival-daemon (async revival), memory-pressure (quota gating), resource-lock (expiry in drain).

**Configuration** — `automation-config.json`:
- `session_hard_kill_minutes` (default 60)
- `auth_stall_detection_minutes` (default 2)
- `persistent_heartbeat_stale_minutes` (default 5)
- Memory: GENTYR_MEM_CRITICAL_MB (512), GENTYR_MEM_HIGH_MB (1024), GENTYR_MEM_MODERATE_MB (2048)

**Test Coverage** — `.claude/hooks/__tests__/session-queue-*.test.js` (4 test files): dedup logic, circuit breaker, Step 1d revival, monitor re-enqueue. Framework: node:test.

**Failure Modes & Recovery** — DB corruption: auto-recovery renames aside, creates fresh. Spawn at capacity: item stays queued. Memory pressure: blocks until RAM frees. Stale items (>30 min TTL): expired via drainQueue Step 2.

---

### 5.2 Concurrency Control & Memory Pressure

**Purpose** — Prevent resource exhaustion via hard concurrency caps and soft memory-aware quotas.

**Architecture** — Two-gate system: (1) Hard queue cap via max_concurrent_sessions; (2) Memory pressure via `shouldAllowSpawn()` in memory-pressure.js. Each spawned agent ≈ 30 MCP processes × 40-60MB = ~1.4GB.
- **critical** (< 512 MB free) — block all except cto/critical/persistent
- **high** (< 1024 MB free) — allow urgent/cto/critical only
- **moderate** (< 2048 MB free) — allow with caution
- **low** — spawn freely

**Key Files** — `.claude/hooks/lib/memory-pressure.js` (256 lines)

**Configuration** — Environment variables: GENTYR_MEM_CRITICAL_MB, GENTYR_MEM_HIGH_MB, GENTYR_MEM_MODERATE_MB, GENTYR_NODE_RSS_CRITICAL_MB (16384), GENTYR_NODE_RSS_HIGH_MB (12288), GENTYR_MAX_AGENTS_MODERATE (5), GENTYR_MAX_AGENTS_HIGH (3)

**Failure Modes & Recovery** — False critical: wait for completions. RSS creep: indicates memory leak; restart automation service.

---

### 5.3 Session Spawning (drainQueue — 7 Steps)

**Purpose** — Atomically dequeue items and spawn Claude sessions with priority, lane limits, and resource checks.

**Architecture** — Single drainQueue() function:
- **Step 1**: Reap stale running items (sync pass — dead PIDs, zombies, stale heartbeats, auth stalls)
- **Step 1b**: Re-enqueue dead persistent monitors (circuit breaker protected)
- **Step 1b.5**: Audit session revival (dead auditors for pending_audit tasks)
- **Step 1c**: Orphan persistent task catch-all
- **Step 1d**: Non-persistent task revival (max 3/cycle, prefers --resume)
- **Step 2**: Expire old queued items (30-min TTL)
- **Step 2.5-2.7**: Reserved slots auto-restore, resource lock expiry, stale port cleanup
- **Steps 3-5**: Count by lane, fetch by priority, spawn loop (lane limits: gate=5, audit=5, persistent=unlimited)
- **Step 6**: Resume suspended sessions via SIGCONT

**Key Files** — `.claude/hooks/lib/session-queue.js` (drainQueue ~800 lines of total)

**Configuration** — Lane sub-limits hard-coded: GATE_LANE_LIMIT=5, AUDIT_LANE_LIMIT=5, ALIGNMENT_LANE_LIMIT=3. Focus mode blocks non-essential spawning.

**Failure Modes & Recovery** — At-capacity: item stays queued. Lane limit: re-queued for next drain. Spawn failure (missing CLI): marked failed with error.

---

### 5.4 Session Reaping (Death Detection)

**Purpose** — Detect dead PIDs, stalled auth loops, and stale monitors; clean up queue state; reset TODO tasks; diagnose failures.

**Architecture** — Two-pass design:
- **Sync Pass** (in drainQueue, fast): PID liveness via process.kill(pid,0), spawning zombies (5+ min), stale heartbeats (persistent, 5 min), auth stalls (3+ consecutive errors). Actions: mark completed, release resources, reconcile TODOs.
- **Async Pass** (hourly automation, background): For stuck-alive items (>60 min), analyzes JSONL tail for completion signals. If complete: graceful reap. If stuck: SIGTERM→SIGKILL, mark failed, deputy-CTO report.

**Data Model** — Failure diagnosis: `{ stalled, error_type: 'rate_limit'|'auth_error'|'crash'|'unknown', is_transient, consecutive_errors, sample_error, suggested_action }`

**Key Files** — `.claude/hooks/lib/session-reaper.js` (1,085 lines): reapSyncPass(), reapAsyncPass(), diagnoseSessionFailure(), reconcileTodo()

**Configuration** — `session_hard_kill_minutes` (60), `auth_stall_detection_minutes` (2), `persistent_heartbeat_stale_minutes` (5). Per-task override: `hard_kill_minutes` in persistent task metadata.

**Test Coverage** — `.claude/hooks/__tests__/diagnose-session-failure.test.js`: rate_limit detection, auth_error classification, usage_limit handling. Framework: node:test.

**Failure Modes & Recovery** — False-positive hard-kill: JSONL analysis prevents premature kills. Zombie detection failure: falls back to basic PID check. Worktree cleanup: fail-closed if lsof unavailable.

---

### 5.5 Session Revival (8 Mechanisms)

**Purpose** — Octuple-redundant recovery from agent death/stalls, each tuned for different failure scenarios and latency.

| # | Mechanism | Trigger | Latency | Guards |
|---|-----------|---------|---------|--------|
| 1 | Revival daemon (fs.watch) | Progress file deletion | <1s | Memory pressure, bypass guard, 3/10min rate limit |
| 2 | Session reviver | Hourly automation, 10-min cooldown | ~10 min | Memory pressure, bypass guard |
| 3 | Dead agent recovery | SessionStart hook | Session start | Lock coordination |
| 4 | Crash-loop resume | SessionStart hook | Session start | do_not_auto_resume check |
| 5 | Stop-continue hook | Agent attempts stop | Real-time | Persistent task status, plan completion |
| 6 | Stale-pause auto-resume | Persistent paused >30 min | ~15 min | Bypass guard, self-pause circuit breaker |
| 7 | Orphan catch-all | Every drain cycle | Per-drain | Bypass guard, dedup |
| 8 | requeueDeadPersistentMonitor | Dead PID detected | Immediate | Circuit breaker (3/10min + 5/hour), self-healing |

**Key Files** — Orchestrated across: session-queue.js (Steps 1b-1d), session-reaper.js, revival-daemon.js, stop-continue-hook.js, persistent-task-spawner.js

**Failure Modes & Recovery** — Circuit breaker exhaustion: auto-pauses task with do_not_auto_resume; CTO must resume. Stale heartbeat false positive: 60-sec spawn grace period.

---

### 5.6 Circuit Breakers

**Purpose** — Prevent infinite restart cycles for persistently broken agents.

**Architecture** — Dual-layer:
- **In-memory**: Map<taskId, timestamp[]> — max 3 hard revivals in 10 min
- **DB-based**: revival_events table — max 5 per task per hour
- **Backoff**: 5 → 10 → 20 → 60 min (exponential, capped)
- **Self-pause**: 2+ pauses in 2 hours → do_not_auto_resume flag

**Failure Modes & Recovery** — Trips: persistent task auto-paused. CTO amends to resume: monitor revived. False positive resolved: CTO manually resume_persistent_task.

---

### 5.7 Session Suspension & Preemption

**Purpose** — Gracefully pause running agents for CTO/critical tasks without losing session state.

**Architecture** — Non-destructive (SIGTSTP/SIGCONT): CTO/critical items preempt normal-priority via activate_queued_session. Suspended items don't count toward concurrency. drainQueue Step 6 resumes via SIGCONT when capacity frees.

**MCP Tools** — `activate_queued_session` (instant promote + spawn; suspends lowest-priority), `suspend_session`, `restart_session`

**Failure Modes & Recovery** — Process ignores SIGTSTP: drain detects via PID check, falls back to hard kill. Resume fails (PID dead): auto-reaped.

---

### 5.8 Session Audit Log

**Purpose** — Immutable JSON-lines audit trail of all session lifecycle events.

**Architecture** — Append-only at `.claude/state/session-audit.log`. Each event: `{ ts, event, ...fields }`. 24h retention, 5MB cap (halved on overflow). Atomic tmp+rename cleanup every 100 writes.

**Data Model** — 20+ event types: session_enqueued, session_spawned, session_completed, session_failed, session_cancelled, session_ttl_expired, session_reaped_dead, session_hard_killed, session_suspended, session_preempted, session_revival_triggered, display_lock_acquired/released/renewed/expired, persistent_task_paused/cancelled, audit_revival_candidate, session_queue_db_recovered.

**Key Files** — `.claude/hooks/lib/session-audit.js` (119 lines): auditEvent(), cleanupAuditLog()

**Configuration** — Hard-coded: MAX_FILE_SIZE=5MB, MAX_AGE_MS=24h, CLEANUP_INTERVAL=100 writes.

---

### 5.9 Compaction-Aware Session Reading & Context Pressure

**Purpose** — Detect context window growth, nudge agents to compact, and enable self-compaction on-demand.

**Architecture** — Three layers:
1. **Context Pressure Hook** (PostToolUse): Reads JSONL tail for token count; 3 tiers (suggestion/warning/critical) with cooldowns; auto-calls request_self_compact at critical.
2. **Compact Tracker** (`.claude/state/compact-tracker.json`): Per-session lastCompactAt, compactCount, 5-min cooldown.
3. **Session Compaction** (`request_self_compact` MCP tool): Executes `claude --resume <id> -p /compact` on dead sessions before revival.

**Key Files** — `.claude/hooks/context-pressure-hook.js` (291 lines), `.claude/hooks/lib/compact-session.js` (335 lines)

**Configuration** — `automation-config.json`: context_pressure_suggestion_tokens (200K), warning (300K), critical (400K), suggestion_minutes (15), warning_minutes (30), critical_minutes (60), nudge_cooldown_minutes (5)

**Failure Modes & Recovery** — JSONL read failure: hook exits early. Token count unavailable: uses time-based triggers. Compact timeout (>2 min): non-fatal, agent continues.

---

## 6. Task System

### 6.1 Task State Machine

**Purpose** — Manage task lifecycle from creation through completion with multi-stage validation gates.

**Architecture** — Five-state FSM: `pending_review → pending → in_progress → [pending_audit] → completed`. Non-privileged agents enter pending_review (10-min TTL gate review); privileged creators (deputy-cto, cto, human, pr-reviewer, system-followup, demo, self-heal-system) bypass directly to pending. Tasks with `gate_success_criteria` enter pending_audit after completion.

**Data Model** — SQLite table `tasks` in `.claude/todo.db`:
- **id**: TEXT PK (UUID), **status**: CHECK(pending|pending_review|in_progress|pending_audit|completed)
- **priority**: TEXT (normal|urgent), **category_id**: TEXT (routes to task_categories)
- **title, description, assigned_by**: task metadata
- **gate_success_criteria**: measurable outcome text
- **gate_verification_method**: executable verification steps
- **user_prompt_uuids**: JSON array linking to CTO prompts (traceability)
- **persistent_task_id**: UUID of parent persistent task
- **strict_infra_guidance, demo_involved**: specialized prompt injection flags
- Timestamps: created_at, started_at, completed_at (ISO), created_timestamp (Unix seconds for sorting)

**Key Files** —
- `packages/mcp-servers/src/todo-db/server.ts` (2,444 lines) — 38 MCP tools
- `packages/mcp-servers/src/todo-db/types.ts` (562 lines) — Zod schemas
- `.claude/hooks/lib/task-category.js` (375 lines) — Category resolution, prompt building
- `.claude/hooks/task-gate-spawner.js` (197 lines) — Gate agent spawning
- `.claude/hooks/urgent-task-spawner.js` (660 lines) — Immediate spawn for urgent/CTO tasks
- `.claude/hooks/universal-audit-spawner.js` (223 lines) — Audit gate spawning
- `.claude/hooks/lib/auditor-prompt.js` (101 lines) — Auditor prompt builder

**MCP Tools** (38 total on todo-db) —
- Core CRUD: `list_tasks`, `get_task`, `create_task`, `start_task`, `complete_task`, `delete_task`
- Gate: `gate_approve_task`, `gate_kill_task`, `gate_escalate_task`, `update_task_gate`, `confirm_task_gate`, `check_task_audit`, `task_audit_pass`, `task_audit_fail`
- Categories: `list_categories`, `get_category`, `create_category`, `update_category`, `delete_category`
- Analytics: `get_summary`, `get_worklog`, `get_completed_since`, `summarize_work`

**Hooks** —
- **task-gate-spawner.js** (PostToolUse on create_task): Spawns Haiku gate agent when status=pending_review
- **urgent-task-spawner.js** (PostToolUse on create_task): Immediate spawn for urgent/CTO tasks
- **universal-audit-spawner.js** (PostToolUse on complete_task): Spawns auditor when status=pending_audit

**Integration Points** — session-queue (enqueues task-runner/gate/auditor agents), persistent-task (sub-tasks link via persistent_task_id), plan-orchestrator (plan tasks reference todo tasks), user-feedback (feature stability locks)

**Configuration** — Gate bypass creators (7), urgency-authorized creators (7), gate-exempt categories (triage, project-management, workstream-management), gate TTL 10 min, audit TTL 8 min

**Test Coverage** — `packages/mcp-servers/src/todo-db/__tests__/todo-db.test.ts` (128 test cases): CRUD, validation, gate transitions, category resolution, audit workflows. Framework: Vitest with in-memory SQLite.

**Failure Modes & Recovery** — Gate timeout (>10 min): auto-approval. Auditor timeout (8 min): session revival re-enqueues. Category not found: defers to hourly automation.

---

### 6.2 Task Categories (Replaces legacy sections)

**Purpose** — Define multi-agent pipelines per task type with sequenced orchestration and specialization guards.

**Architecture** — Database-driven category system. Each category specifies: ordered agent sequence, prompt template with variable interpolation, creator restrictions, force-followup toggle, urgency authorization, deprecated section mapping.

**Data Model** — SQLite table `task_categories` in `.claude/todo.db`:
- **id**: TEXT PK (slug), **name**: display name, **description**: TEXT
- **sequence**: JSON array of `{agent_type, label, optional}` objects
- **prompt_template**: TEXT (custom prompt with variable interpolation) or NULL
- **model**: enum[opus|sonnet|haiku], **creator_restrictions**: JSON array or null
- **force_followup**: BOOLEAN, **urgency_authorized**: BOOLEAN, **is_default**: BOOLEAN
- **deprecated_section**: TEXT (legacy backward-compat lookup)

**Key Files** — `.claude/hooks/lib/task-category.js` (375 lines): `resolveCategory()`, `getPipelineStages()`, `buildSequenceList()`, `buildPromptFromCategory()`

**Configuration** — 8 seeded categories:
1. **standard** (investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager; sonnet)
2. **deep-investigation** (investigator-only; sonnet)
3. **test-suite** (test-writer → code-reviewer → project-manager; sonnet)
4. **triage** (deputy-cto-only; sonnet)
5. **demo-design** (demo-manager-only; sonnet)
6. **project-management** (project-manager-only; haiku)
7. **product-analysis** (product-manager-only; sonnet)
8. **workstream-management** (workstream-manager-only; haiku)

**Failure Modes & Recovery** — Category not found: resolveCategory returns null, falls back to hardcoded mapping or defers to hourly. Resolution priority: category_id → deprecated_section → is_default=1.

---

### 6.3 Universal Audit Gate

**Purpose** — Independent post-completion verification that task claims match reality.

**Architecture** — Two-phase: (1) Agent calls complete_task with gate_success_criteria → enters pending_audit; (2) Haiku auditor spawned in 'audit' lane (signal-excluded, 8-min TTL) verifies criteria via Bash/Read/Grep; calls task_audit_pass or task_audit_fail.

**Data Model** — Tasks table fields: gate_success_criteria (measurable outcome), gate_verification_method (executable steps), gate_status (NULL|draft|active)

**Key Files** — `.claude/hooks/lib/auditor-prompt.js` (101 lines): `buildAuditorSessionSpec()`, `resolveAuditTools()` (routes: todo → task_audit_pass/fail, persistent → pt_audit_pass/fail, plan → verification_audit_pass/fail)

**MCP Tools** — `update_task_gate`, `confirm_task_gate`, `check_task_audit`, `task_audit_pass({task_id, evidence})`, `task_audit_fail({task_id, failure_reason, evidence})`

**Hooks** — universal-audit-spawner.js (PostToolUse on complete_task when status=pending_audit); session-queue Step 1b.5 (revival for crashed auditors)

**Configuration** — TTL: 8 min. Model: Haiku. Exempt categories: triage, project-management, workstream-management.

**Failure Modes & Recovery** — Auditor timeout: task remains pending_audit; session revival re-enqueues. Criteria too vague: auditor fails with "not measurable". DB offline: spawner skips audit (task stays pending_audit).

---

### 6.4 Task Gate System

**Purpose** — Real-time duplicate prevention, feature stability enforcement, and CTO intent alignment before execution.

**Architecture** — Gate checks for pending_review tasks: (1) duplicate detection via list_tasks similarity; (2) feature stability via check_feature_stability(); (3) CTO intent via search_cto_sessions(). Decisions: APPROVE → pending, KILL → delete, ESCALATE → approve + deputy-CTO report.

**Key Files** — `.claude/hooks/task-gate-spawner.js` (197 lines): Fires on create_task when status=pending_review; spawns Haiku gate agent in 'gate' lane (limit 5).

**Configuration** — Gate lane limit: 5 concurrent. Stale timeout: 10 min → auto-approve. Demo checks: blocks secret_run_command+playwright, "main tree" mentions; escalates wrong-category demo tasks.

**Failure Modes & Recovery** — Gate agent crash: stale auto-approve at 10 min. Check failures (DB offline, stability check unavailable): gate continues with remaining checks (non-blocking).

---

### 6.5 Urgency & Priority

**Purpose** — Enable CTO priority escalation and immediate task dispatch while preventing privilege escalation.

**Architecture** — Two-tier: (1) Normal: queued FIFO, picked up by hourly automation (240-min cooldown); (2) Urgent: bypassed to in_progress, immediate spawn via urgent-task-spawner (memory pressure check only). CTO/human tasks spawn with 'cto' queue priority (preemption-eligible).

**Key Files** — `.claude/hooks/urgent-task-spawner.js` (660 lines): Authorization check, atomic markTaskInProgress, memory pressure gating, CTO preemption

**MCP Tools** — `create_task({priority: 'urgent'|'normal', assigned_by})` — server-side auto-downgrade for unauthorized urgent

**Configuration** — Urgency-authorized creators: deputy-cto, cto, human, pr-reviewer, system-followup, demo, self-heal-system. Memory pressure gates all spawns (fail-closed).

**Failure Modes & Recovery** — Unauthorized urgent: auto-downgraded to normal (silent). Memory exhaustion: task reset to pending, hourly retries. CTO at capacity: preempts lowest-priority (SIGTSTP).

---

## 7. Persistent Task System

The Persistent Task System orchestrates long-running, amendment-driven monitoring sessions that execute complex multi-step objectives delegated by the CTO. A persistent monitor (Opus-tier) oversees work through a skepticism protocol, never modifying code itself but delegating all implementation to sub-agents via the task queue.

---

### 7.1 Lifecycle & State Machine

**Purpose** — Long-running task execution with amendment-driven scope adjustments and explicit completion gates.

**Architecture** — State machine: `draft → active → paused ⇆ active → completed/cancelled/failed`. Activation spawns persistent-monitor agent. Amendment system enables CTO to modify scope without restart. Auto-resume on amendment when paused. Plan-manager variant spawns persistent tasks for plan steps.

**Data Model** — `.claude/state/persistent-tasks.db` (SQLite, WAL):
- **persistent_tasks**: id, title, prompt, status, parent_todo_task_id, monitor_agent_id, monitor_pid, monitor_session_id, last_heartbeat, cycle_count, outcome_criteria, gate_success_criteria, gate_verification_method, gate_status, last_summary, metadata (JSON: demo_involved, strict_infra_guidance, plan_task_id, plan_id, is_plan_manager, releaseId, do_not_auto_resume, hard_kill_minutes)
- **amendments**: id, persistent_task_id (FK), content, amendment_type (addendum|correction|scope_change|priority_shift), created_at, delivered_at, acknowledged_at
- **sub_tasks**: persistent_task_id, todo_task_id (composite PK), linked_at, linked_by
- **events**: id, persistent_task_id (FK), event_type, details (JSON), created_at
- **pt_audits**: id, persistent_task_id, success_criteria, verification_method, verdict, evidence, failure_reason, attempt_number
- **blocker_diagnosis**: id, persistent_task_id, error_type, is_transient, diagnosis_details (JSON), fix_attempts, max_fix_attempts, fix_task_ids (JSON), status, cooldown_until

**Key Files** —
- `packages/mcp-servers/src/persistent-task/server.ts` (1,303 lines) — 18 MCP tools
- `packages/mcp-servers/src/persistent-task/types.ts` (212 lines) — Zod schemas
- `.claude/hooks/persistent-task-spawner.js` (345 lines) — Spawner hook
- `.claude/hooks/persistent-task-briefing.js` (400 lines) — Briefing injection
- `.claude/hooks/persistent-task-linker.js` (255 lines) — Auto-linking

**MCP Tools** (18 total) — `create_persistent_task`, `activate_persistent_task`, `get_persistent_task`, `list_persistent_tasks`, `amend_persistent_task`, `acknowledge_amendment`, `pause_persistent_task`, `resume_persistent_task`, `cancel_persistent_task`, `complete_persistent_task`, `link_subtask`, `get_persistent_task_summary`, `inspect_persistent_task`, `update_pt_gate`, `confirm_pt_gate`, `check_pt_audit`, `pt_audit_pass`, `pt_audit_fail`

**Hooks** —
- **persistent-task-spawner.js** (PostToolUse on activate/resume/amend/pause/cancel): Enqueues monitor in persistent lane at critical priority; auto-activates 2 reserved slots
- **persistent-task-briefing.js** (PostToolUse every tool call): Updates heartbeat/cycle_count; injects amendments, sub-task status, gate criteria, plan context
- **persistent-task-linker.js** (PostToolUse on create_task): Auto-links tasks with persistent_task_id

**Integration Points** — todo-db (parent task, sub-tasks), session-queue (persistent lane, no limit), plan-orchestrator (plan_task_id links), pause-propagation (cascades to plan), session-signals (directive amendments), bypass-requests (escalation)

**Configuration** — Amendment auto-resume: paused→active on amend. Heartbeat: updated every tool call. Metadata extensibility via JSON (demo_involved, strict_infra_guidance, hard_kill_minutes override).

**Test Coverage** — `.claude/hooks/__tests__/blocker-auto-heal.test.js` (953 lines, 165 tests): fast-path returns, fix spawning, backoff, dedup, idempotency, graceful degradation. Framework: node:test.

**Failure Modes & Recovery** — Monitor dies: revival via requeueDeadPersistentMonitor (immediate, circuit-breaker protected). Gate not confirmed: complete rejected until gate_status=active. Audit fails: reverts to active with failure_reason injected.

---

### 7.2 Persistent Monitor Agent

**Purpose** — Opus-tier orchestrator that manages complex objectives without editing code directly.

**Architecture** — Single long-running session per active task. Briefing injection every tool call maintains context. Skepticism protocol: verifies child claims via peek_session, demands evidence. Amendment handling: reads signals, acknowledges, adapts. Zombie kill: after 2 failed directives, kills stuck child.

**Key Files** — `agents/persistent-monitor.md` (467 lines) — 12 rules, 8 tool categories, startup protocol, monitoring loop, zombie protocol, bypass request rules

**MCP Tools (allowed)** — Task creation/completion, signal I/O, force_spawn_tasks, session inspection, heartbeat/summary. **Disallowed**: Edit, Write, NotebookEdit (enforced via extraArgs).

**Integration Points** — todo-db (create_task with persistent_task_id), agent-tracker (inspect_persistent_task, peek_session, kill_session, send_session_signal), session-signals (receive amendments via directives)

**Configuration** — Demo involved: receives demo validation instructions. Strict infra: child agents get MCP-only instructions. Plan manager variant: uses get_spawn_ready_tasks for plan steps.

**Failure Modes & Recovery** — Crashes: revival prompt built from last_summary + amendments + child status + blocker_diagnosis. Deadlock (all children stuck): submits bypass_request to escalate. Amendment not acknowledged: briefing warns until acknowledged.

---

### 7.3 Self-Healing System (Blocker Auto-Heal)

**Purpose** — Automatic diagnosis and repair of persistent monitor failures without CTO intervention.

**Architecture** — Decision tree on monitor death: (1) rate_limit → cooldown + retry (no fix task); (2) auth_error/crash → spawn fix task (max 3 attempts); (3) fix attempts exhausted → escalate via bypass_request. Blocker_diagnosis table tracks: error_type, fix_attempts, fix_task_ids, status (active|fix_in_progress|cooling_down|escalated|resolved).

**Key Files** — `.claude/hooks/lib/blocker-auto-heal.js` (423 lines): handleBlocker(), diagnoseCrash(), spawnFixTask(), escalateToBypass()

**Data Model** — blocker_diagnosis table: persistent_task_id, error_type, is_transient, diagnosis_details (JSON), fix_attempts, max_fix_attempts (3), fix_task_ids (JSON array), status, cooldown_until, resolved_at

**Configuration** — `self_heal_max_fix_attempts` (default 3). Backoff: 5→10→20→60 min. Fix tasks created as Deep Investigation category, assigned_by='self-heal-system', priority='urgent'.

**Test Coverage** — `.claude/hooks/__tests__/blocker-auto-heal.test.js` (953 lines, 165 tests): fast-path (5), fix spawning (6), backoff (5), dedup (4), idempotency (2), degradation (4), tracking (2). Framework: node:test.

**Failure Modes & Recovery** — Fix doesn't work: fix_attempts incremented, next revival spawns new fix or applies backoff. All 3 fail: status→escalated, bypass_request created. DB unavailable: fails gracefully (log-only, no throw).

---

### 7.4 Crash-Loop Circuit Breaker

**Purpose** — Prevent infinite restart cycles for persistently broken monitors.

**Architecture** — Dual-layer: (1) In-memory: 3 hard revivals per task in 10 min; (2) DB-based: max 5 revivals per hour. When limit exceeded: persistent task auto-paused with do_not_auto_resume flag. CTO must manually resolve.

**Key Files** — `.claude/hooks/lib/session-queue.js` (in-memory rate limiter), `.claude/state/session-queue.db` (revival history)

**Configuration** — Hard-coded: 3/10min (in-memory), 5/hour (DB). Backoff: 5→10→20→60 min exponential. Heartbeat-stale revivals excluded from crash counter.

**Failure Modes & Recovery** — Trips: auto-pauses task. CTO amends to resume: monitor revived. False positive (transient issue): CTO can resume_persistent_task directly.

---

### 7.5 CTO Bypass Request System

**Purpose** — Escalate blockers requiring human decision-making to the CTO with structured context.

**Architecture** — Agent calls submit_bypass_request → stored in bypass-requests.db → pauses task → propagates to plan → CTO sees in briefing → resolve_bypass_request(approved|rejected, context) → task resumes with context injected into revival prompt.

**Data Model** — `.claude/state/bypass-requests.db`:
- **bypass_requests**: id, task_type (persistent|todo), task_id, task_title, agent_id, category (infrastructure|secrets|scope|access), summary, details, status (pending|approved|rejected|cancelled), resolution_context, resolved_at
- **blocking_queue**: id, bypass_request_id, source_task_type/id, persistent_task_id, plan_task_id, plan_id, blocking_level (task|persistent_task|plan), impact_assessment (JSON), summary, status (active|resolved|superseded)

**Key Files** — `.claude/hooks/lib/bypass-guard.js` (88 lines): checkBypassBlock(), getBypassResolutionContext()

**MCP Tools** — `submit_bypass_request` (agent-facing, pauses task), `resolve_bypass_request` (CTO-facing, approves/rejects; **spawned-session guard** blocks `CLAUDE_SPAWNED_SESSION=true` server-side — only the CTO interactive session can resolve), `list_bypass_requests` (by status, auto-cancels stale), `check_deferred_action` (poll deferred protected action status: pending/approved/executing/completed/failed)

**Integration Points** — session-queue (blocks revival when pending), session-briefing (displays to CTO), persistent-task-spawner (resume triggers propagateResumeToPlan), cto-notification-hook (status line shows N BLOCKING)

**Configuration** — Dedup: one pending per (task_type, task_id). Auto-cancel: requests for gone/completed tasks.

**Failure Modes & Recovery** — CTO slow: task stays paused until resolved. Rejected: context injected, monitor takes alternative approach. DB unavailable: checkBypassBlock() fails-open (never blocks revival).

---

## 8. Plan Orchestrator

### 8.1 Plan Lifecycle & Structure

**Purpose** — Manage structured execution plans with hierarchical phases, tasks, substeps, and dependency-aware auto-advancement.

**Architecture** — Tier 2 MCP server (per-session stdio, WAL-mode SQLite). Plans are hierarchically structured: Plan → Phase → Task → Substep. Status transitions are event-driven and cascaded through transactions. Core flow: create_plan → update_plan_status(active) → plan-manager spawned → task completion cascades phase/plan auto-completion.

**Data Model** — `.claude/state/plans.db` (7 tables):
- **plans**: id, title, description, status (draft|active|paused|completed|archived|cancelled), persistent_task_id, manager_agent_id, manager_pid, last_heartbeat, timestamps
- **phases**: id, plan_id (FK), title, phase_order, status, required (boolean), gate (boolean — blocks task skip)
- **plan_tasks**: id, phase_id (FK), title, task_order, status (pending|blocked|ready|in_progress|paused|pending_audit|completed|skipped), verification_strategy (mandatory), persistent_task_id, pr_number, pr_merged, category_id, todo_task_id
- **substeps**: id, task_id (FK), description, status (pending|completed), completed_at
- **dependencies**: blocker_type/id → blocked_type/id (DFS cycle detection)
- **state_changes**: append-only audit log of all entity status transitions
- **plan_audits**: task_id, verification_strategy, verdict (pass|fail|null), evidence, failure_reason, attempt_number

**Key Files** —
- `packages/mcp-servers/src/plan-orchestrator/server.ts` (2,413 lines)
- `packages/mcp-servers/src/plan-orchestrator/types.ts` (376 lines)
- `.claude/hooks/plan-activation-spawner.js` (350 lines)
- `.claude/hooks/plan-persistent-sync.js` (336 lines)
- `.claude/hooks/plan-merge-tracker.js` (256 lines)
- `.claude/hooks/plan-audit-spawner.js` (183 lines)
- `.claude/hooks/plan-briefing.js` — SessionStart briefing
- `.claude/hooks/lib/pause-propagation.js` (471 lines)

**MCP Tools** (22 total) — `create_plan`, `get_plan`, `list_plans`, `update_plan_status`, `add_phase`, `update_phase`, `add_plan_task`, `update_task_progress`, `retry_plan_task`, `link_task`, `add_substeps`, `complete_substep`, `add_dependency`, `get_spawn_ready_tasks`, `plan_dashboard`, `plan_timeline`, `plan_audit`, `plan_sessions`, `force_close_plan`, `check_verification_audit`, `verification_audit_pass`, `verification_audit_fail`, `get_plan_blocking_status`

**Hooks** —
- **plan-activation-spawner.js** (PostToolUse on update_plan_status): Creates plan-manager persistent task, links atomically, enqueues in persistent lane
- **plan-persistent-sync.js** (PostToolUse on complete_persistent_task): Routes task to pending_audit or completed; cascades phase→plan
- **plan-merge-tracker.js** (PostToolUse on Bash `gh pr merge`): Auto-marks linked plan tasks completed
- **plan-audit-spawner.js** (PostToolUse on update_task_progress): Spawns plan-auditor when task→pending_audit
- **plan-briefing.js** (SessionStart): Briefs agents on active plan state

**Integration Points** — persistent-task (plan tasks become persistent tasks), todo-db (optional todo_task_id link), release-ledger (release plans), bypass-requests (blocking_queue), session-queue (persistent+audit lanes)

**Configuration** — Mandatory verification_strategy on all plan tasks. Phase gate=true prevents skip. Phase required=true blocks plan completion if skipped. Auto-completion: phase completes when all tasks resolved; plan completes when all phases resolved with no required phases skipped.

**Test Coverage** — `.claude/hooks/__tests__/retry-plan-task.test.js` (547 lines, 12 tests): retry transitions, phase/plan reset cascades, state_changes recording. Framework: node:test with better-sqlite3.

**Failure Modes & Recovery** — Activation without persistent task: plan stalls (orphan detection revives in 10 min). Cascaded completion fails: manual update_phase/update_plan_status. Required phase skipped: CTO force_complete with completion_note.

---

### 8.2 Plan-Manager Agent

**Purpose** — Opus-tier orchestrator that drives plan execution by spawning persistent tasks for each ready step and monitoring completion.

**Architecture** — Spawned as persistent task when plan activates. Loop: poll get_spawn_ready_tasks → create+activate persistent tasks → link via update_task_progress → monitor via inspect_persistent_task → detect blocking via get_plan_blocking_status → add precursor tasks and wire dependencies for failures → continue until all phases complete.

**Key Files** — `agents/plan-manager.md` (200+ lines): role, spawn logic, blocking detection, gate retry, auto sign-off, CI/coverage gates

**MCP Tools (uses)** — get_spawn_ready_tasks, create_persistent_task, activate_persistent_task, update_task_progress, inspect_persistent_task, get_plan_blocking_status, retry_plan_task, add_plan_task, add_dependency

**Integration Points** — persistent-task (creates/monitors child tasks), release-ledger (auto sign-off for automated tier), session-queue (persistent lane), bypass-requests (escalation)

**Failure Modes & Recovery** — Crashes: orphan detection creates new plan-manager in 10 min. Blocking: adds precursor task + wires dependency + retries. Auto sign-off fails: submits bypass request to CTO.

---

### 8.3 Dependency Management & Task Readiness

**Purpose** — DAG of phase/task dependencies with cycle detection, computing ready-to-execute tasks.

**Architecture** — Dependencies: blocker_type ∈ {phase,task} → blocked_type ∈ {phase,task}. `areDependenciesMet()` walks recursively (only completed|skipped satisfy). `get_spawn_ready_tasks` returns ready tasks without persistent_task_id. DFS cycle detection on add_dependency.

**MCP Tools** — `add_dependency({blocker_type, blocker_id, blocked_type, blocked_id})`, `get_spawn_ready_tasks({plan_id})`

**Configuration** — Status transitions: pending→blocked (unmet deps)→ready (deps met)→in_progress→pending_audit|completed|skipped. Paused tasks do NOT satisfy dependencies.

**Failure Modes & Recovery** — Cycle detected: add_dependency rejects. Dangling dependency (blocker deleted): blocked task never becomes ready; remove orphan dependency manually.

---

### 8.4 Verification Audit Gate (Plan-Level)

**Purpose** — Independent auditor verifies task completion claims against verification_strategy before allowing plan progression.

**Architecture** — Task marked completed → routes to pending_audit (if verification_strategy set) → plan-audit-spawner enqueues plan-auditor (Sonnet, audit lane, 5-min TTL, signal-excluded) → auditor reads verification_strategy, executes checks → verification_audit_pass|fail → pass triggers completion cascade; fail awaits plan-manager retry.

**Key Files** — `.claude/hooks/plan-audit-spawner.js` (183 lines), `agents/plan-auditor.md`

**MCP Tools** — `check_verification_audit({task_id})`, `verification_audit_pass({task_id, evidence})`, `verification_audit_fail({task_id, failure_reason, evidence})`

**Configuration** — verification_strategy mandatory on all plan tasks. Auditor TTL: 5 min. Model: Haiku. Allowed tools: Read, Glob, Grep, Bash (read-only). Signal-excluded (cannot receive messages from plan-manager).

**Failure Modes & Recovery** — Timeout: task stays pending_audit; plan-manager retries via retry_plan_task. False pass: downstream failure catches. CTO force_complete bypasses audit.

---

### 8.5 Hierarchical Pause Propagation

**Purpose** — Cascade pause/resume between persistent tasks and plans, creating CTO-visible blocking queue entries.

**Architecture** — `propagatePauseToPlan()`: persistent task paused → finds linked plan_task → sets plan_task status=paused → assesses downstream impact (blocked tasks, gate phase, parallel work) → determines blocking_level (task|persistent_task|plan) → auto-pauses plan if fully blocked → creates blocking_queue entry. `propagateResumeToPlan()`: persistent task resumed → plan_task→in_progress → checks other paused tasks → resumes plan if none remain → resolves blocking_queue.

**Key Files** — `.claude/hooks/lib/pause-propagation.js` (471 lines): propagatePauseToPlan, propagateResumeToPlan, assessPlanBlocking

**MCP Tools** — `get_plan_blocking_status({plan_id})` — Returns paused tasks, blocked descendants, parallel work, blocking_queue items

**Integration Points** — persistent-task-spawner (pause handler calls propagatePauseToPlan), submit_bypass_request/resolve_bypass_request (triggers propagation), session-briefing (shows WORK BLOCKED section)

---

### 8.6 Plan Orphan Detection

**Purpose** — Detect active plans with no live plan-manager and revive them.

**Architecture** — 10-min cycle in hourly automation. Queries plans.db for active plans whose persistent_task_id is missing, dead, or terminal. Three revivable scenarios each create new plan-manager persistent task + enqueue at critical priority. Non-revivable: paused with do_not_auto_resume → auto-pauses plan instead.

**Configuration** — 10-min cooldown. TOCTOU-safe linking via `UPDATE ... WHERE persistent_task_id IS NULL`. Emits plan_manager_revived audit event.

**Failure Modes & Recovery** — Zombie proliferation (permanent crash loop): non-revivable path auto-pauses plan. CTO must resolve the blocked persistent task before plan resumes.

---

## 9. Production Release Pipeline

### 9.1 Release Ledger Server (Evidence Chain)

**Purpose** — Central SQLite database and MCP server tracking releases from staging lock through CTO sign-off with full evidence chain.

**Architecture** — Tier 2 stateful stdio MCP server using better-sqlite3 WAL. Coordinates with release-orchestrator and release-report-generator modules. Supports atomic version auto-generation with collision detection.

**Data Model** — `.claude/state/release-ledger.db` (5 tables):
- **releases**: id, version (v{YYYY}.{MM}.{DD} with collision suffix), status (in_progress|signed_off|cancelled), plan_id, persistent_task_id, staging_lock_at, staging_unlock_at, signed_off_at, signed_off_by, report_path, artifact_dir, metadata
- **release_prs**: release_id (FK), pr_number, pr_title, pr_url, author, merged_at, review_status (pending|in_review|passed|failed), review_plan_task_id
- **release_sessions**: release_id (FK), queue_id, session_type, phase, target_pr, status, summary
- **release_reports**: release_id (FK), report_id, report_type, tier, title, outcome
- **release_tasks**: release_id (FK), task_id, task_type, phase, status

**Key Files** —
- `packages/mcp-servers/src/release-ledger/server.ts` (1,746 lines) — 21 MCP tools
- `packages/mcp-servers/src/release-ledger/types.ts` (252 lines)
- `.claude/hooks/lib/release-orchestrator.js` (677 lines) — Artifact collection utilities
- `.claude/hooks/lib/release-report-generator.js` (1,069 lines) — Report assembly
- `.claude/hooks/lib/cto-approval-proof.js` (253 lines) — Cryptographic proof
- `.claude/hooks/release-artifact-collector.js` (159 lines) — Session transcript archiving
- `.claude/hooks/release-completion-hook.js` (311 lines) — Final orchestration

**MCP Tools** (21) — `create_release`, `get_release`, `list_releases`, `update_release`, `sign_off_release`, `cancel_release`, `add_release_pr`, `update_release_pr_status`, `add_release_session`, `add_release_report`, `add_release_task`, `get_release_evidence`, `generate_release_report`, `open_release_report`, `get_release_report_section`, `lock_staging`, `unlock_staging`, `present_release_summary`, `record_cto_approval`

**Integration Points** — plans.db (plan_id link), persistent-tasks.db (task metadata), session-queue.db (running sessions), cto-reports.db (triage), deputy-cto.db (decisions), staging-lock.js (lock state), protection-key (HMAC proof)

**Failure Modes & Recovery** — DB corrupt: restore from backup. Staging lock stuck: manually clear JSON. Approval quote not found: CTO retypes. Protection key missing: generate with openssl.

---

### 9.2 Eight Release Phases

**Purpose** — The ONLY path to production, ensuring comprehensive quality validation before merge.

| Phase | Name | Gate | Description |
|-------|------|------|-------------|
| 1 | Per-PR Quality Review | Yes | Persistent task per PR: antipattern, code-review, user-alignment, spec-enforcement |
| 2 | Initial Triage | No | Deputy-CTO triages Phase 1 findings |
| 3 | Meta-Review | Yes | Cross-PR consistency check across all changes |
| 4 | Test & Demo Execution | Yes | All tests + all demo scenarios; verify_demo_completeness must return complete:true |
| 5 | Demo Coverage Audit | Yes | Verify every new feature has demo coverage with screenshot proof |
| 6 | Final Triage | No | Pre-release readiness check |
| 7 | CTO Sign-off | Yes | CTO reviews and explicitly approves (cryptographic proof) |
| 8 | Release Report | No | Merge staging→main, generate report, create GitHub Release |

**Architecture** — `/promote-to-prod` slash command: enumerates PRs → locks staging → creates release plan (8 phases) → plan-manager drives advancement → CTO signs off → staging merges to main → report generated → staging unlocked.

---

### 9.3 Staging Lock Mechanism

**Purpose** — Prevents staging merges during active production releases.

**Architecture** — JSON state file at `.claude/state/staging-lock.json` + PreToolUse hook + optional GitHub branch protection.

**Key Files** — `.claude/hooks/lib/staging-lock.js` (271 lines): getStagingLockState(), isStagingLocked(), lockStaging(), unlockStaging(). `.claude/hooks/staging-lock-guard.js` (405 lines): shell-aware tokenizer, blocks `gh pr merge --base staging`, `git push origin staging`, `git merge staging`.

**Configuration** — Fast-exit: GENTYR_PROMOTION_PIPELINE=true bypasses. Fail-closed: corrupted file = assume locked. GitHub protection: best-effort via `gh api`.

---

### 9.4 CTO Approval Cryptographic Proof

**Purpose** — Bind CTO verbal approval to release with HMAC-SHA256, preventing forgery or replay.

**Architecture** — `record_cto_approval`: (1) copies live JSONL to snapshot (TOCTOU defense), (2) verifies quote in archived copy line-by-line, (3) computes SHA-256 file hash, (4) signs tuple `[releaseId|sessionId|approvalText|fileHash|cto-release-approval]` with protection-key, (5) writes proof JSON.

**Key Files** — `.claude/hooks/lib/cto-approval-proof.js` (253 lines): loadProtectionKey, computeFileHash, computeApprovalHmac, verifyApprovalHmac, verifyQuoteInJsonl, findCurrentSessionJsonl

**Configuration** — Three approval tiers (services.json `releaseApprovalTier`): cto (interactive only, HMAC proof), deputy (CTO or deputy), automated (plan-manager auto-sign, no HMAC). Domain separator: 'cto-release-approval'. Spawned-session guard blocks non-interactive sessions. Constant-time comparison.

---

### 9.5 Release Artifacts & Report

**Purpose** — Collect evidence chain and generate structured release report.

**Architecture** — Artifact directory: `.claude/releases/{release_id}/` with subdirs (prs/, sessions/, reports/). release-orchestrator.js collects PR lists, session transcripts, demo screenshots, triage artifacts. release-report-generator.js fills 11-section template, converts to PDF via Chromium.

**Key Files** — `.claude/hooks/lib/release-orchestrator.js` (677 lines): enumerateReleasePRs, getArtifactDir, collectSessionArtifact, collectDemoArtifacts, collectTriageArtifacts, createGitHubRelease. `.claude/hooks/lib/release-report-generator.js` (1,069 lines): generateStructuredReport, convertToPdf.

**Report sections** (11): Overview, Changes, Customer Changelog (LLM-generated), QA Summary (per-PR reviews, tests, demos, coverage), Issues Discovered, CTO Decisions, Evidence Chain, Screenshots, CTO Approval, Promotion History, Deployment Verification.

---

### 9.6 Release Completion Hook

**Purpose** — PostToolUse hook firing when release plan-manager completes, orchestrating unlock→report→GitHub Release→broadcast.

**Key Files** — `.claude/hooks/release-completion-hook.js` (311 lines)

**Architecture** — Fires on complete_persistent_task with releaseId in metadata. Steps: (1) validate release exists, (2) unlockStaging(), (3) generateStructuredReport(), (4) createGitHubRelease() with git tag, (5) update release-ledger.db, (6) emit audit event, (7) broadcast completion signal to all sessions. Non-blocking: always exits 0.

---

### 9.7 Canary Deployment (Optional)

**Purpose** — Progressive rollout with automatic rollback on error threshold.

**Architecture** — Vercel-specific via `npx vercel promote`. Requires `canary.enabled=true` in services.json. Default: 10% traffic, 15-min monitoring window, 5% error threshold. Auto-rollback if threshold exceeded.

**Key Files** — `.claude/hooks/lib/canary-deploy.js`, `.claude/hooks/lib/auto-rollback.js`

---

## 10. Merge Chain & Git Workflow

### 10.1 4-Stage Merge Chain (Target Projects)

**Purpose** — Enforce strict linear promotion pipeline preventing unstable code from reaching production.

**Architecture** — Multi-layer defense: git wrapper (PATH injection), PreToolUse hooks, husky shell guards, GitHub Actions CI. All layers must agree. Target projects use `feature/* → preview → staging → main`; base branch auto-detected via `origin/preview` existence.

**Data Model** — Protected branches: main, staging, preview. Feature prefixes: feature/, fix/, refactor/, docs/. Bypass: GENTYR_PROMOTION_PIPELINE=true.

**Key Files** —
- `.claude/hooks/git-wrappers/git` (318 lines) — PATH-injected wrapper (Layer 1)
- `.claude/hooks/branch-checkout-guard.js` (349 lines) — PreToolUse (Layer 2)
- `.claude/hooks/main-tree-commit-guard.js` (467 lines) — PreToolUse (Layer 3)
- `.claude/hooks/lib/feature-branch-helper.js` (148 lines) — Branch detection utilities
- `husky/pre-commit` (166 lines) — Shell guard (Layer 4)
- `templates/github/workflows/merge-chain-check.yml.template` (43 lines) — CI (Layer 5)

**Test Coverage** — `branch-checkout-guard.test.js` (457 lines), `main-tree-commit-guard.test.js` (833 lines), `branch-protection-hardening.test.js` (943 lines), `pre-commit-branch-guard.test.js` (80 lines). Framework: node:test.

---

### 10.2 Feature Branch Self-Merge Flow

**Purpose** — Automated agent workflow from code completion through CI validation and merge without human intervention.

**Architecture** — 7-step flow: (1) push, (2) create PR to preview/main, (3) poll CI via `gh pr checks --watch`, (4) detect pass/fail, (5) fix loop (max 5 iterations), (6) self-merge (squash+delete-branch), (7) clean up worktree.

**Key Files** — `.claude/hooks/pr-auto-merge-nudge.js` (66 lines): PostToolUse reminder after `gh pr create`. `agents/project-manager.md`: commit, push, create PR, self-merge, cleanup responsibilities.

**Hooks** — pr-auto-merge-nudge.js (fires after PR creation), plan-merge-tracker.js (auto-completes plan tasks on merge)

**Failure Modes & Recovery** — CI stuck: agent closes PR, restarts on new branch. Max iterations exceeded: escalates to CTO. Worktree cleanup fails: hourly reaper removes after 4h.

---

### 10.3 Branch Protection Layers

**Purpose** — Five independent defense layers preventing commits to protected branches.

| Layer | Mechanism | Scope | Can Bypass? |
|-------|-----------|-------|-------------|
| 1 | Git wrapper (PATH) | Spawned agents | GENTYR_PROMOTION_PIPELINE=true |
| 2 | branch-checkout-guard.js (PreToolUse) | All sessions | GENTYR_PROMOTION_PIPELINE=true |
| 3 | main-tree-commit-guard.js (PreToolUse) | Spawned agents | GENTYR_PROMOTION_PIPELINE=true |
| 4 | Husky pre-commit shell guard | All sessions | GENTYR_PROMOTION_PIPELINE=true |
| 5 | GitHub Actions CI | All PRs | Never (merge blocked) |

**Architecture** — Each layer validates independently. Worktree operations bypass (`.git` is a file). CTO bypass via HMAC approval token (one-time use, 5-min expiry).

**Failure Modes & Recovery** — Layer 1 not in PATH: Layer 2 catches. Layer 2/3 missing: Layer 4 catches. Layer 4 deleted: Layer 5 enforces at merge time. Layer 5 disabled: CRITICAL — re-enable immediately.

---

### 10.4 Branch Age Guard

**Purpose** — Warn about stale feature branches to ensure regular CI validation and reduce merge debt.

**Architecture** — Soft check (warning, not block) on UserPromptSubmit. Detects branch age via `git log -1 --format=%aI`. If >4h since last commit: emits systemMessage warning. First commits always allowed. Merge resolution commits exempt.

**Configuration** — Threshold: 4 hours (configurable via `branch_age_limit_hours` in automation-config.json). Cooldown: 30 min per session.

---

### 10.5 Gentyr Repo Workflow (Different)

**Purpose** — Simplified two-tier model for the GENTYR framework repo itself.

**Architecture** — `feature/* → main` (no preview/staging). Base branch detection returns `main` when `origin/preview` doesn't exist. Same self-merge flow but targets main directly. Same protection layers apply (only main is protected).

**Configuration** — Auto-detected: `detectBaseBranch()` in lib/feature-branch-helper.js checks `origin/preview`; if absent, returns `main`.

---

## 11. Worktree System

### 11.1 Worktree Provisioning

**Purpose** — Create isolated git worktrees with symlinked GENTYR config, provisioned dependencies, and optional build artifacts.

**Architecture** — `createWorktree(branchName, baseBranch)`: detect base branch → fetch with timeout → `git worktree add` → `provisionWorktree()` (symlinks config, rewrites .mcp.json with absolute paths + port env, copies artifacts, installs deps, runs build if health check fails) → verify freshness.

**Data Model** — `.claude/worktrees/<sanitized-branch>/` (worktree root), `.claude/state/port-allocations.json` (port blocks), per-worktree `.mcp.json` with absolute CLAUDE_PROJECT_DIR paths.

**Key Files** — `.claude/hooks/lib/worktree-manager.js` (1,162 lines): createWorktree, provisionWorktree, removeWorktree, syncWorktreeDeps, cleanupMergedWorktrees. `.claude/hooks/lib/port-allocator.js` (232 lines): allocatePortBlock (O_EXCL atomic), releasePortBlock.

**Configuration** — `services.json`: worktreeArtifactCopy (glob patterns), worktreeInstallTimeout (default 120s), worktreeBuildCommand, worktreeBuildHealthCheck, worktreeProvisioningMode (strict|lenient).

**Failure Modes & Recovery** — Fetch timeout: non-fatal. Install failure: lenient=warning, strict=abort+remove. Port allocation exhausted (50 max): cleanup needed.

---

### 11.2 Worktree Freshness (Multi-Layer)

**Purpose** — Keep worktrees current with base branch via 6 detection/sync layers.

**Architecture** — Layer 0: preview-watcher daemon (30s poll, auto-merge clean worktrees, syncWorktreeDeps after merge). Layer 1: worktree-freshness-check.js PostToolUse (2-min cooldown nag). Layer 2: plan-merge-tracker.js broadcasts on PR merge. Layer 3: run_demo hard gate (auto-sync or block). Layer 4: session-briefing.js reports freshness. Layer 5: createWorktree() verifies after fetch.

**Key Files** — `scripts/preview-watcher.js` (328 lines): 30s poll, listManagedWorktrees, detectBaseBranch, writeWorktreeState. `.claude/hooks/worktree-freshness-check.js`: PostToolUse, counts commits behind base.

**Data Model** — `.claude/state/preview-head.json` (SHA, branch, sync results), `.claude/state/worktree-freshness/<basename>.json` (needsMerge, behindBy, dirty, conflict).

**Failure Modes & Recovery** — Merge conflict: marked conflict=true, agent must resolve. Dirty worktree: can't auto-merge, agent notified. Offline: cycle skipped.

---

### 11.3 Worktree Cleanup & Maintenance

**Purpose** — Periodically remove merged/stale worktrees and release ports.

**Architecture** — `cleanupMergedWorktrees()` (preview-watcher, every 5 min): detect merged branches → session-queue guard (skip if active session) → lsof check (fail-closed) → dirty check → removeWorktree(force:true). Stale reaper (hourly, >4h clean worktrees). Abandoned rescue (hourly, 15 min, uncommitted+no agent → spawn project-manager).

**Configuration** — Cleanup interval: 5 min. Stale threshold: 4h. Rescue threshold: 15 min. Lsof timeout: 5s (fail-closed). All safety checks: session-queue cross-check + lsof + dirty check.

---

### 11.4 Worktree Safety Guards

**Purpose** — Prevent agents from operating on deleted worktrees or writing outside worktree boundary.

**Architecture** — Two PreToolUse hooks: (1) worktree-cwd-guard.js (125 lines): blocks Bash when CWD doesn't exist, allows `cd` recovery. (2) worktree-path-guard.js (188 lines): in worktree context, blocks Write/Edit to paths outside worktree root (exceptions: /tmp, ~/.claude/).

**Test Coverage** — `worktree-cwd-guard.test.js`, `worktree-path-guard.test.js`. Framework: node:test.

---

### 11.5 Worktree Removal & Session Exclusivity

**Purpose** — 4-layer defense preventing agents from destroying each other's worktrees (Bug #6).

**Architecture** —
- **Layer 1**: enqueueSession() worktree dedup — blocks spawn if another active session uses same worktree
- **Layer 2**: removeWorktree() session-queue guard — checks for active sessions before removal (force:true bypasses)
- **Layer 3**: worktree-remove-guard.js PreToolUse — intercepts `git worktree remove`, queries session-queue.db
- **Layer 4**: Rescue prompt hardening — pre-enqueue dedup + "Do NOT remove the worktree" instruction

**Key Files** — `.claude/hooks/worktree-remove-guard.js` (334 lines), session-queue.js (exclusivity checks), worktree-manager.js (removeWorktree guard).

**Test Coverage** — `worktree-exclusivity.test.js`: verifies all 4 layers structurally.

---

### 11.6 Sub-Agent Worktree Isolation

**Purpose** — Ensure code-modifying sub-agents operate in isolated worktrees, not the main tree.

**Architecture** — Code-modifying agents (code-writer, test-writer, code-reviewer) MUST use `isolation: "worktree"`. Read-only agents exempt (Explore, Plan, investigator). Enforcement: git wrapper blocks git add/commit in main tree for spawned agents; main-tree-commit-guard.js PreToolUse blocks destructive ops.

**Configuration** — Base branch auto-detected: origin/preview → use preview; else main. Creates NEW unique branch (e.g., feature/code-review-abc) from detected base.

---

## 12. Hook System (89 JS files)

The hook system is GENTYR's synchronous event-driven enforcement layer. Hooks intercept Claude Code tool execution at five lifecycle points and run Node.js scripts that can block actions, inject context, spawn agents, or log audit events. Agents cannot bypass hooks.

### 12.1 PreToolUse Hooks (17) — Block Dangerous Actions

**Purpose** — Synchronously deny tool calls before execution. Fail-closed: parse errors → automatic deny.

**Architecture** — Input (stdin): JSON with tool_name, tool_input, cwd, env. Output (stdout): `{ hookSpecificOutput: { permissionDecision: 'deny'|'allow', permissionDecisionReason } }`. First deny blocks. Timeout (3-5s) = deny.

**Key Files** (most critical): interactive-lockdown-guard.js (CTO session file-edit block), block-no-verify.js (303 lines, detects --no-verify/gpg-sign/lint weakening), credential-file-guard.js (280 lines, blocks credential file access), protected-action-gate.js (195 lines, blocks MCP actions requiring approval), staging-lock-guard.js (405 lines, blocks staging merges during release)

**Registration** — settings.json.template PreToolUse entries with matchers: `""` (all tools), `"Bash"`, `"Write,Edit,NotebookEdit"`, `"mcp__*"`, specific tool names.

**Full list**: interactive-lockdown-guard, block-no-verify, credential-file-guard, playwright-cli-guard, branch-checkout-guard, main-tree-commit-guard, worktree-cwd-guard, worktree-path-guard, worktree-remove-guard, interactive-agent-guard, block-team-tools, secret-profile-gate, protected-action-gate, staging-lock-guard, worktree-sync-guard, gate-confirmation-enforcer, signal-compliance-gate

---

### 12.2 PostToolUse Hooks (36) — React, Inject Context, Spawn

**Purpose** — Execute after tool completes. Inject additionalContext into model, spawn agents, update state. Never blocks.

**Architecture** — Input (stdin): JSON with tool_name, tool_output. Output (stdout): `{ hookSpecificOutput: { additionalContext: "..." } }` or empty. Timeout (3-15s) = log warning, continue.

**Key Files** (most critical): signal-reader.js (reads inter-agent signals every tool call), urgent-task-spawner.js (660 lines, immediate spawn for urgent tasks), persistent-task-briefing.js (400 lines, injects task state every tool call), context-pressure-hook.js (291 lines, monitors token count/age), universal-audit-spawner.js (223 lines, spawns auditor on task completion)

**Full list**: signal-reader, worktree-freshness-check, agent-comms-reminder, alignment-reminder, persistent-task-briefing, progress-tracker, monitor-reminder, uncommitted-change-monitor, pr-auto-merge-nudge, plan-merge-tracker, strict-infra-nudge-hook, urgent-task-spawner, task-gate-spawner, workstream-spawner, persistent-task-linker, orchestration-guidance-hook, project-manager-reminder, worktree-cleanup-gate, plan-work-tracker, session-completion-gate, workstream-dep-satisfier, demo-failure-spawner, demo-remote-enforcement, long-command-warning, persistent-task-spawner, plan-persistent-sync, plan-activation-spawner, plan-audit-spawner, screenshot-reminder, context-pressure-hook, release-artifact-collector, release-completion-hook, universal-audit-spawner, alignment-monitor-briefing, bypass-request-router

---

### 12.3 SessionStart Hooks (9) — Set Initial Context

**Purpose** — Run once per session at login for health checks, briefing, and recovery. MUST NOT write to stderr.

**Architecture** — Output: `{ continue: true, systemMessage: "..." }`. No timeout enforcement. Skipped for spawned sessions where appropriate.

**Full list**: gentyr-splash (branding), gentyr-sync (280 lines, config rebuild), todo-maintenance (task cleanup), dead-agent-recovery (detect/revive), crash-loop-resume (resume circuit-breaker paused tasks), credential-health-check (1Password connectivity), playwright-health-check (browser availability), plan-briefing (active plan state), session-briefing (comprehensive context dump)

---

### 12.4 UserPromptSubmit Hooks (12) — Process Input

**Purpose** — Monitor CTO messages for approval codes, secret patterns, and special commands. Run before AI processes message.

**Architecture** — Input: user message text. Output: `{ continue: true, systemMessage: "...", hookSpecificOutput: { additionalContext: "..." } }`. systemMessage = terminal only; additionalContext = reaches model.

**Full list**: cto-notification-hook (status line + bypass injection), secret-leak-detector (API key patterns), bypass-approval-hook (APPROVE BYPASS detection), protected-action-approval-hook (APPROVE phrase code), slash-command-prefetch (data preload), branch-drift-check (30-min cooldown), comms-notifier (pending signals), workstream-notifier (updates), cto-prompt-detector (CTO intent broadcast), secrets-local-health (missing credentials), mcp-guidance-hook (MCP server guidance), pending-sync-notifier (pending config files)

---

### 12.5 Stop Hook (1) — Gate Session Termination

**Purpose** — Validate completion state and prevent premature termination.

**Key File** — `stop-continue-hook.js`: Checks plan-manager incomplete tasks (BLOCK), persistent-monitor active task (BLOCK), uncommitted changes (BLOCK, spawn project-manager), first stop on clean worktree (guidance). Plan-manager escape hatch: if task paused/completed/cancelled → allow exit.

---

### 12.6 Shared Hook Libraries (35 modules in hooks/lib/)

**Top 10 by importance/size:**

| Module | Lines | Primary Exports |
|--------|-------|-----------------|
| session-queue.js | 2,334 | enqueueSession, drainQueue, spawnQueueItem, preemptLowestPriority |
| worktree-manager.js | 1,162 | createWorktree, provisionWorktree, removeWorktree, syncWorktreeDeps |
| resource-lock.js | 1,135 | acquireResource, releaseResource, renewResource, forceAcquire, checkAndExpire |
| session-reaper.js | 1,085 | reapSyncPass, reapAsyncPass, diagnoseSessionFailure, reconcileTodo |
| release-report-generator.js | 1,069 | generateStructuredReport, convertToPdf |
| release-orchestrator.js | 677 | enumerateReleasePRs, collectSessionArtifact, createGitHubRelease |
| session-signals.js | 560 | sendSignal, readPendingSignals, broadcastSignal, acknowledgeSignal |
| pause-propagation.js | 471 | propagatePauseToPlan, propagateResumeToPlan, assessPlanBlocking |
| blocker-auto-heal.js | 423 | handleBlocker (decision tree: classify → cooldown/fix/escalate) |
| deferred-action-executor.js | 399 | executeAction, executeMcpTool, verifyActionHmac |

**Other domains:** task-category.js (375), compact-session.js (335), staging-lock.js (271), memory-pressure.js (256), port-allocator.js (232), process-tree.js (290), cto-approval-proof.js (253), feature-branch-helper.js (148), session-audit.js (119), auditor-prompt.js (101), bypass-guard.js (88)

**Test Coverage** — 76 test files across `.claude/hooks/__tests__/`. Framework: node:test (built-in). Coverage: security guards, session management, automation, deployment, worktree isolation.

---

## 13. Automation & Daemons

### 13.1 Persistent Daemons (6 services)

**1. MCP Shared Daemon** (`scripts/mcp-server-daemon.js`, 532 lines)
- **Purpose**: Single HTTP server hosting 15 Tier 1 MCP servers, saving ~750MB RAM per agent
- **Architecture**: Two-phase startup (HTTP first → credentials resolve in parallel). Port 18090, 127.0.0.1 only. Health: GET /health (starting|ok). Secrets cache: 5-min TTL, audit to op-cache-audit.jsonl.
- **Config**: launchd `com.local.gentyr-mcp-daemon` (KeepAlive). Env: CLAUDE_PROJECT_DIR, OP_SERVICE_ACCOUNT_TOKEN.
- **Failure**: Credential timeout → servers unavailable but daemon alive. Cache flush: POST /secrets/flush.

**2. Revival Daemon** (`scripts/revival-daemon.js`, 472 lines)
- **Purpose**: Sub-second crash detection via fs.watch + 10s polling fallback
- **Architecture**: Watches agent-tracker-history.json (500ms debounce). Checks PID liveness, spawns `claude --resume`. In-memory revival tracking (1h TTL). Escalating backoff (5→10→20→30 min, max 5 attempts).
- **Config**: launchd `com.local.gentyr-revival-daemon` (KeepAlive). Max agent age: 1h. Polling: 10s.
- **Failure**: fs.watch unavailable → 10s polling fallback. Memory pressure → delay spawn. Suspended agents → skip.

**3. Preview Watcher** (`scripts/preview-watcher.js`, 328 lines)
- **Purpose**: Auto-sync worktrees with base branch every 30s; cleanup merged worktrees every 5 min
- **Architecture**: Fetch base branch → count commits behind → auto-merge clean worktrees → broadcast signal → syncWorktreeDeps (reinstall if lockfile changed) → cleanup merged.
- **Config**: launchd `com.local.gentyr-preview-watcher` (KeepAlive). Fetch timeout: 15s. Merge timeout: 30s.
- **Failure**: Offline → skip cycle. Merge conflict → mark conflict=true, agent resolves.

**4. Session Activity Broadcaster** (`scripts/session-activity-broadcaster.js`, 634 lines)
- **Purpose**: Every 5 min, summarize running sessions via Haiku LLM, deliver via subscriptions + selective relevance
- **Architecture**: Read JSONL tails (16KB) → per-session LLM summaries → super-summary → broadcast. Steps 8-10: auto-subscribe monitors to children, deliver subscriptions, LLM-driven selective delivery.
- **Config**: launchd `com.local.gentyr-session-activity-broadcaster` (KeepAlive). DB: session-activity.db (WAL). Model: haiku.
- **Failure**: LLM timeout → fallback concatenation. DB locked → 5s busy_timeout. Concurrent guard prevents overlapping.

**5. Live Feed Daemon** (`scripts/live-feed-daemon.js`, 570 lines)
- **Purpose**: Every 60s (when activity detected), generate AI commentary for CTO dashboard Page 5
- **Architecture**: Fingerprint activity (sessions, plans, JSONL mtimes) → skip if unchanged → spawn `claude -p --model haiku --output-format stream-json` → stream to live-feed-streaming.json → append to live-feed.db (max 500 entries).
- **Config**: launchd `com.local.gentyr-live-feed-daemon` (KeepAlive). Tail: 8KB per session.
- **Failure**: Unchanged fingerprint → no LLM call. Stream timeout → skip entry. DB: 500 entry cap.

**6. Hourly Automation** (`.claude/hooks/hourly-automation.js`, 5,767 lines)
- **Purpose**: 10-min timer service running 36 automation blocks with CTO gate and cooldown management
- **Architecture**: Load config → check CTO gate (24h briefing required) → run gate-exempt blocks → check gate → run gate-required blocks → finalize. Each block: `runIfDue(key, cooldown)` checks `hourly-automation-state.json`.
- **Config**: launchd `com.local.plan-executor` (StartInterval: 600s). Cooldowns from `config-reader.js` (181 lines, 50+ defaults).
- **Failure**: Config corruption → disable automation. CTO gate closed → skip spawns. Cycle timeout → systemd/launchd kills.

---

### 13.2 Hourly Automation Blocks (Gate-Exempt — always run)

| Block | Cooldown | Purpose |
|-------|----------|---------|
| session_reviver | 10 min | Revive dead sessions (max 3/cycle) |
| session_reaper | 5 min | Async pass: hard-kill stuck sessions |
| persistent_monitor_health | 15 min | Detect stale heartbeats, restart monitors |
| persistent_stale_pause_resume | 5 min | Resume tasks paused >30 min |
| rate_limit_cooldown_check | 2 min | Clear expired rate-limit cooldowns |
| self_heal_fix_check | 5 min | Check fix task completion, resolve/escalate |
| deferred_action_resume | 5 min | Auto-resolve bypass requests when linked deferred action completes; cancel stale protected_action bypasses whose parent is done |
| paused_task_triage | 10 min | Spawn deputy-cto to evaluate paused persistent tasks: resume if safe, escalate if needs CTO |
| global_monitor_health | 5 min | Auto-create/revive global deputy-CTO monitor persistent task (opt-out via globalMonitorEnabled toggle) |
| plan_orphan_detection | 10 min | Revive active plans with dead managers |
| report_auto_resolve | 2 min | Match merged PRs to pending reports |
| report_dedup | 30 min | Deduplicate similar reports |
| triage_check | 30 min | Spawn triage agents for pending reports |

Plus: staging reactive review (60 min), preview promotion (30 min), health monitors, PR sweep, deploy event monitor, DORA metrics, security audit, bypass staleness check, orphan process reaper, screenshot cleanup, Fly stale machine cleanup, stale work detector, antipattern hunter, compliance checker, user feedback, demo validation, daily feedback.

---

### 13.3 Hourly Automation Blocks (Gate-Required — CTO briefing within 24h)

| Block | Cooldown | Purpose |
|-------|----------|---------|
| task_runner | 240 min | Spawn up to 3 pending tasks per cycle |
| task_gate_stale_cleanup | every cycle | Auto-approve pending_review tasks >10 min |
| abandoned_worktree_rescue | 30 min | Spawn project-manager for orphaned dirty worktrees |
| worktree_cleanup | 5 min | Remove merged worktrees |
| stale_worktree_reaper | 20 min | Remove clean worktrees >4h old |
| stale_task_cleanup | varies | Reset in_progress tasks stuck >30 min |

**CTO Activity Gate**: Reads `lastCtoBriefing` from autonomous-mode.json. Missing/invalid/>=24h → gate CLOSED (monitoring only). <24h → gate OPEN. Updated by: /deputy-cto sessions, interactive session starts.

---

### 13.4 Launchd/Systemd Services

| Service | Label | Type | Restart |
|---------|-------|------|---------|
| Automation | com.local.plan-executor | 10-min timer (oneshot) | On timer fire |
| Revival Daemon | com.local.gentyr-revival-daemon | KeepAlive (persistent) | Restart=always, 5s |
| MCP Daemon | com.local.gentyr-mcp-daemon | KeepAlive (persistent) | Restart=always, 5s |
| Preview Watcher | com.local.gentyr-preview-watcher | KeepAlive (persistent) | Restart=always, 5s |
| Activity Broadcaster | com.local.gentyr-session-activity-broadcaster | KeepAlive (persistent) | Restart=always, 5s |
| Live Feed Daemon | com.local.gentyr-live-feed-daemon | KeepAlive (persistent) | Restart=always, 5s |

**Installation**: `scripts/setup-automation-service.sh setup --path /project [--op-token TOKEN]`. macOS: plists in `~/Library/LaunchAgents/`. Linux: systemd user services. OP token preservation: existing token carried forward on regeneration.

**Health Checks**: `curl http://localhost:18090/health` (MCP daemon). `launchctl list com.local.SERVICE` (macOS). Log files in `.claude/` for all services.

---

## 14. Agent Definitions (25 agents)

**Purpose** — Role-based AI behavior via .md files encoding model tier, tool restrictions, workflow protocols, and spawn conventions.

**Architecture** — Each agent is `agents/<name>.md` with YAML frontmatter (name, description, model, allowedTools/disallowedTools) + markdown body (instructions). Loaded via `--agent <name>` CLI flag during spawn.

### 14.1 Complete Agent Inventory

| Agent | Lines | Model | Key Constraint | Primary Role |
|-------|-------|-------|----------------|--------------|
| code-writer | 131 | opus | Worktree-required; no commits | Implementation |
| code-reviewer | 138 | opus | Read-only; no commits | Code analysis |
| persistent-monitor | 466 | sonnet | Never edits files; spawns via tasks | Orchestration |
| project-manager | 362 | sonnet | ONLY agent that commits/pushes | Git operations |
| deputy-cto | 364 | sonnet | Read-only; spawns urgent tasks | Triage/escalation |
| demo-manager | 346 | sonnet | ONLY agent modifying .demo.ts | Demo lifecycle |
| test-writer | 448 | sonnet | Worktree-required; no commits | Test creation |
| secret-manager | 329 | sonnet | No Edit/Write/Bash | Credential lifecycle |
| product-manager | 315 | sonnet | External research only | PMF analysis |
| preview-promoter | 271 | sonnet-4-6 | Read-only; spawns code-writer | Deployment promotion |
| icon-finder | 257 | sonnet | SVG processing pipeline | Icon sourcing |
| investigator | 240 | sonnet | No code edits; creates tasks | Problem analysis |
| plan-manager | 229 | inherited | Spawns persistent tasks per step | Plan execution |
| antipattern-hunter | 183 | sonnet | Read-only; spawns code-reviewer | Anti-pattern detection |
| feedback-agent | 160 | sonnet | No source code access | User persona testing |
| cicd-manager | 133 | sonnet-4-6 | No file edits | Deployment/promotion |
| universal-auditor | 115 | inherited | Read-only; 8-min TTL | Task verification |
| workstream-manager | 96 | sonnet | Read-only | Queue dependency analysis |
| staging-reviewer | 88 | sonnet | Read-only; spawns code-writer | Staging quality review |
| user-alignment | 71 | sonnet | Read-only auditor | Intent verification |
| incident-responder | 61 | sonnet-4-6 | Auto-spawned on rollback | Root cause diagnosis |
| repo-hygiene-expert | 631 | sonnet | Read-only (largest definition) | Monorepo analysis |
| plan-auditor | 50 | inherited | Independent; signal-excluded | Plan task verification |
| plan-updater | 46 | sonnet | Lightweight (<30s) | Substep sync |
| security-auditor | 50 | sonnet-4-6 | Read-only; weekly | Security scanning |

### 14.2 Agent Interaction Model

**Commit Rule**: ONLY project-manager commits/pushes. All other agents write code but leave git ops to project-manager.

**Standard 6-Step Pipeline**: Investigator → Code-Writer → Test-Writer → Code-Reviewer → User-Alignment → Project-Manager

**Spawn Mechanisms**: (1) Direct Agent tool with `isolation: "worktree"` for sub-agents. (2) Task creation via `create_task` for queue-based dispatch.

### 14.3 Agent Separation

- **Shared agents** (`agents/`): 25 universal templates, symlinked into target projects
- **Repo-specific overrides** (`.claude/agents/`): Currently 2 in gentyr repo (deputy-cto, project-manager) with repo-specific behavior
- **Override precedence**: `.claude/agents/X.md` takes priority over `agents/X.md`

### 14.4 Model Tiers

- **Opus** (2): code-writer, code-reviewer — critical code analysis/writing
- **Sonnet 4.6** (4): cicd-manager, incident-responder, preview-promoter, security-auditor — complex reasoning
- **Sonnet** (15): Default for most work — versatile, cost-efficient
- **Inherited** (4): plan-auditor, plan-manager, plan-updater, universal-auditor — use parent model

---

## 15. Slash Commands (42 commands)

**Purpose** — Interactive control interface for the deputy-CTO workflow. All commands resolve framework path via: `GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"`

**Key Files** — `.claude/commands/*.md` (42 files, ~5.5K lines total)

### 15.1 Demo Commands (8)
demo, demo-all, demo-interactive, demo-autonomous, demo-bulk, demo-session, demo-validate, replay

### 15.2 Task & Agent Commands (5)
spawn-tasks, persistent-task, persistent-tasks, task-queue, session-queue

### 15.3 Monitoring Commands (4)
monitor (continuous loop), status (one-shot), triage, global-monitor (toggle always-on deputy-CTO alignment monitor)

### 15.4 Plan Commands (5)
plan, plan-progress, plan-timeline, plan-audit, plan-sessions

### 15.5 Configuration Commands (8)
automation-rate, concurrent-sessions, configure-personas, focus-mode (deprecated alias), lockdown, local-mode, setup-gentyr, toggle-automation-gentyr, toggle-product-manager

### 15.6 Operations Commands (6)
cto-dashboard, deputy-cto, promote-to-prod, show, workstream, overdrive-gentyr

### 15.7 Infrastructure Commands (4)
hotfix, push-migrations, push-secrets, setup-fly

### 15.8 Analysis & Feedback Commands (3)
persona-feedback, product-manager, run-feedback

---

## 16. CTO Interaction Model

**Purpose** — Transform interactive Claude Code session into deputy-CTO console with controlled tool access, real-time notifications, and session integrity.

### 16.1 Interactive Session Lockdown

**Architecture** — `interactive-lockdown-guard.js` (393 lines) PreToolUse hook. Blocks Edit/Write/NotebookEdit and code-modifying Agent spawns. Allows Read/Glob/Grep/Bash (read-only). MCP prefix whitelist: agent-tracker, todo-db, user-feedback, playwright, release-ledger. Whitelists: .claude/plans/ writes, ~/.claude/projects/*/memory/ writes, claude-sessions tools, 1Password tools (6 specific). HMAC token required to disable via `/lockdown off`.

### 16.2 CTO Bypass System

**Architecture** — 6-char code generated server-side (stored in deputy-cto.db). CTO types `APPROVE BYPASS <code>`. `bypass-approval-hook.js` (416 lines) reads code, computes HMAC-SHA256 with `.claude/protection-key` (root-owned), writes signed token. Token: one-time use, 5-min expiry. Spawned sessions CANNOT use bypass (server-side guard fires first).

### 16.3 Session Briefing (at login)

**Architecture** — `session-briefing.js` (1,219 lines) SessionStart hook. Injects: queue state, CTO bypass requests, blocking queue, active persona profile, automation rate (prominent when `none`), paused task breakdown, branch drift, deferred protected actions, plans progress, persistent task health. For spawned agents: task context, git activity, worktree layout, freshness.

### 16.4 CTO Notification Hook (every prompt)

**Architecture** — `cto-notification-hook.js` (1,011 lines) UserPromptSubmit hook. Multi-line status: git branch, quota bars (5h/7d), context window %, tokens, sessions, TODOs, plans (active count, %, ready tasks), persistent (active, dead monitors), staging drift, N BLOCKING prefix. 3s time budget with incremental caching.

### 16.5 CTO Dashboard (5 pages)

**Architecture** — `packages/cto-dashboard-live/` (real-time Ink/React TUI, polls 3s). Page 1: Observe (sessions + activity stream). Page 2: Demos & Tests (scenarios, branch selector, launch/stop, display lock preemption). Page 3: Plans (phases, tasks, audit info, progress bars). Page 4: Specs (category navigator). Page 5: Feed (AI commentary from live-feed.db).

### 16.6 Token Usage Tracking (Per-Agent-Type)

**Purpose** — Track and display how many tokens different automated session types consume, enabling cost visibility and optimization.

**Architecture** — Two layers in `packages/cto-dashboard/src/utils/`:
- **Global usage** (`data-reader.ts:getTokenUsage(hours)`) — Sums input/output/cache_read/cache_creation tokens across ALL sessions in last N hours. Parses session JSONL `message.usage` fields. Displayed as QuotaBars (5h/7d) + cache hit rate on CTO Dashboard Page 1 and in the CTO notification hook status line.
- **Per-agent-type usage** (`automated-instances.ts:getAutomationTokenUsage()`) — Scans session JSONL files modified in last 24h. Extracts `[Automation][agent-type]` or `[Task][agent-type]` prefix from first user message to classify the session. Sums all `message.usage` token fields (input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens) per session. Rolls up raw agent types into display names via `INSTANCE_DEFINITIONS` map. Returns `Record<string, number>` (display name → total tokens).

**Supported Types (22 INSTANCE_DEFINITIONS):**

| Display Name | Agent Types (JSONL prefix) | Trigger |
|---|---|---|
| Pre-Commit Hook | `deputy-cto-review` | commit |
| Test Suite | `test-failure-jest`, `test-failure-vitest`, `test-failure-playwright` | failure |
| Demo Repair | `task-runner-demo-manager` | failure |
| Compliance (Hook) | `compliance-global`, `compliance-local`, `compliance-mapping-fix`, `compliance-mapping-review` | file-change |
| Todo Maintenance | `todo-processing`, `todo-syntax-fix` | file-change |
| Triage Check | *(hook only)* | scheduled |
| Lint Checker | `lint-fixer` | scheduled |
| CLAUDE.md Refactor | `claudemd-refactor` | scheduled |
| Task Runner | `task-runner-code-reviewer`, `task-runner-investigator`, `task-runner-test-writer`, `task-runner-project-manager` | scheduled |
| Production Health | `production-health-monitor` | scheduled |
| Compliance (Sched.) | `standalone-compliance-checker` | scheduled |
| User Feedback | `feedback-orchestrator` | scheduled |
| Antipattern Hunter | `antipattern-hunter`, `antipattern-hunter-repo`, `antipattern-hunter-commit`, `standalone-antipattern-hunter` | scheduled |
| Staging Health | `staging-health-monitor` | scheduled |
| Staging Review | `staging-reviewer`, `staging-reactive-reviewer` | scheduled |
| Preview Promotion | `preview-promotion` | scheduled |
| Staging Promotion | `staging-promotion` | scheduled |
| Persistent Monitor | `persistent-monitor`, `persistent-task-monitor` | spawn |
| Universal Auditor | `universal-auditor` | spawn |
| Plan Auditor | `plan-auditor` | spawn |
| Task Gate | `task-gate` | spawn |
| Session Revival | `session-revived` | spawn |

Trigger types: `commit` (git hook), `failure` (test/demo failure), `file-change` (fs watch), `scheduled` (hourly automation cooldown), `spawn` (session queue on-demand).

Persistent Monitor and Staging Review include two agent type strings because the JSONL prompt prefix differs from the agent-tracker-history type — both paths feed into token counting vs run counting.

**Display** — `AutomatedInstances` component on CTO Dashboard Page 1 renders `tokensByType` as a horizontal bar chart showing relative token consumption by agent type (e.g., "Task Runner: 48K", "Lint Checker: 7.2K"). Sorted descending by token count.

**Key Files** — `packages/cto-dashboard/src/utils/automated-instances.ts` (getAutomationTokenUsage + INSTANCE_DEFINITIONS), `packages/cto-dashboard/src/utils/data-reader.ts` (getTokenUsage), `packages/cto-dashboard/src/components/AutomatedInstances.tsx` (bar chart rendering), `packages/cto-dashboard/src/components/QuotaBar.tsx` (progress bar widget).

**Test Coverage** — `automated-instances.test.ts`: 66 tests (spawn trigger behavior, scheduled fallback, token rollup, JSONL parsing). `AutomatedInstances.test.tsx`: 12 tests for token bar chart rendering (empty state, entries, sorting, tip text).

---

## 17. Enforcement Doctrine

**Purpose** — Three-layer defense ensuring critical behaviors are infrastructure-enforced, not agent-compliance-dependent.

### 17.1 Three Enforcement Layers

| Layer | Mechanism | Can Agent Bypass? | Example |
|-------|-----------|:-:|---------|
| Guidance (soft) | Agent defs, CLAUDE.md, briefing | Yes | "Use project-manager for git ops" |
| Orchestration (medium) | PostToolUse reminders, gates | Technically | uncommitted-change-monitor, worktree-cleanup-gate |
| Enforcement (hard) | PreToolUse DENY, root-owned files | **No** | staging-lock-guard, main-tree-commit-guard |

### 17.2 Root-Owned Critical Hooks

**Architecture** — `npx gentyr protect` makes 8 hooks + protection-key root-owned (chmod 755, sudo required to modify). Tamper detection: symlink target verification + ownership checks at commit-time and session-start.

Files: staging-lock-guard.js, main-tree-commit-guard.js, interactive-lockdown-guard.js, credential-file-guard.js, branch-checkout-guard.js, block-no-verify.js, gate-confirmation-enforcer.js, signal-compliance-gate.js, `.claude/protection-key`

### 17.3 Unified CTO Decision System

**Architecture** — Agent presents decision via AskUserQuestion → CTO types natural language → agent calls `record_cto_decision` (verifies CTO typed it by scanning session JSONL, computes HMAC with protection-key) → downstream action tools call `consumeCtoDecision()` to verify + consume the one-time proof. 5 decision types: bypass_request, protected_action, lockdown_toggle, release_signoff, staging_override. Spawned sessions blocked from `record_cto_decision` AND `resolve_bypass_request`. Legacy `APPROVE BYPASS <code>` pattern preserved as fallback during transition. See Section 51 for full architecture.

### 17.4 Deferred Protected Actions

**Architecture** — Spawned agents hit protected-action-gate.js → tool call (server, tool, args) stored in bypass-requests.db with HMAC signatures → agent told to pause (submit_bypass_request) or poll (check_deferred_action) → CTO sees in briefing → types `APPROVE <phrase> <code>` → protected-action-approval-hook.js verifies both HMACs → executes via HTTP POST to MCP daemon → deferred_action_resume automation (5-min cycle) auto-resolves linked bypass request → task re-spawns. Tier 1 only. Domain separation ('deferred-pending'/'deferred-approved'). Timing-safe comparison. args_hash binding prevents bait-and-switch. `resolve_bypass_request` has server-side spawned-session guard (CLAUDE_SPAWNED_SESSION=true blocked).

---

## 18. Demo & Testing System

A unified framework for recording scripted demos, validating features via E2E testing, and managing remote execution across Fly.io and Steel.dev.

### 18.1 Demo Execution Model

**Purpose** — Execute scripted demos with progress tracking, artifact collection, and local/remote routing.

**Architecture** — `run_demo` → DemoRunState (in-memory, keyed by PID) → `check_demo_result` polling → artifacts. Execution-target resolver (4 tiers): Tier 0 Steel stealth → Tier 1 forced local → Tier 2 forced remote → Tier 3 auto-routing. Stall detection kills after 45s (local) or 300s (remote) of no output.

**Data Model** — DemoRunState: status, progress JSONL path, exit code, failure summary, screenshots (3s intervals), recording (.mp4), run_id (dr-{scenarioId}-{ts}-{hex}). Artifacts: video, traces, screenshots, stdout/stderr, exit-code sentinel.

**Key Files** — `packages/mcp-servers/src/playwright/server.ts` (8,660 lines), `types.ts` (772 lines), `execution-target.ts` (403 lines), `artifact-storage.ts` (287 lines)

**MCP Tools** — `run_demo` (launch), `check_demo_result` (poll status/artifacts), `stop_demo` (kill), `run_demo_batch` (concurrent), `check_demo_batch_result` (batch poll), `get_demo_screenshot` (retrieve by timestamp), `extract_video_frames` (ffprobe+ffmpeg)

**Configuration** — services.json: fly.enabled/appName/region/machineRam, steel.enabled/apiKey/sessionLimit. Scenario DB flags: remote_eligible, headed, stealth_required, telemetry.

**Batch lifecycle** — `run_demo_batch` runs scenarios sequentially in batches (partitioned by `batch_size`). No polling requirement — batches run to completion independently. Agents call `check_demo_batch_result` to read progress, and `stop_demo_batch` for manual stop. Fly.io machines have `auto_destroy: true` and manage their own lifecycle. Formerly had a 2-minute poll-or-die auto-kill timer (`DEMO_BATCH_AUTO_KILL_MS`) that killed entire batches if the monitoring agent died — removed (PR #601) because it caused cascading failures when agents hit quota limits.

---

### 18.2 Remote Execution (Fly.io)

**Purpose** — Ephemeral machines for parallelized headless/headed demos without local resource contention.

**Architecture** — Fly Machines API: create machine → inject env (git ref, test file, secrets, Tigris URLs) → remote-runner.sh (clone → install → prerequisites → devserver → Playwright → artifacts → 60s grace). Headed mode: Xvfb + ffmpeg recording. Negative PIDs signal remote.

**Key Files** — `packages/mcp-servers/src/playwright/fly-runner.ts` (150+ lines), `infra/fly-playwright/Dockerfile` (base image), `infra/fly-playwright/Dockerfile.project` (project-specific), `infra/fly-playwright/remote-runner.sh` (32KB orchestration), `infra/fly-playwright/provision-app.sh` (6KB app provisioning)

**MCP Tools** — `get_fly_status` (health), `deploy_fly_image` (build+push Docker), `set_fly_machine_ram` (per-mode config), `get_fly_machine_ram`

**Configuration** — fly.appName, fly.region (e.g., sjc), fly.machineRam (headless: 2048MB, headed: 4096MB), fly.maxConcurrentMachines (default 3)

---

### 18.3 Stealth Execution (Steel.dev)

**Purpose** — Cloud browser for anti-bot scenarios and dual-instance parallel execution.

**Architecture** — Steel API: create session → inject extensions → run actions → fetch recording. Dual-instance: both Fly.io (orchestration) + Steel (stealth browser) in parallel. Fail-closed: if Steel not configured/healthy, run_demo errors (no silent fallback).

**Key Files** — `packages/mcp-servers/src/playwright/steel-runner.ts` (333 lines)

**MCP Tools** — `steel_health_check`, `upload_steel_extension`

---

### 18.4 Prerequisites & Auth

**Purpose** — Register/execute prerequisite commands (dev server, auth, seeding) with health-check skip logic.

**Architecture** — demo_prerequisites table (user-feedback.db): 3 scopes (global, persona, scenario), sort_order, health_check (exit 0 = skip setup), run_as_background (nohup for dev servers). Auth state: .auth/*.json (StorageState), 4h staleness threshold.

**MCP Tools** — `run_prerequisites` (auto-called by run_demo), `run_auth_setup` (refresh .auth/), `preflight_check` (validate everything), `register_prerequisite`, `update_prerequisite`, `delete_prerequisite`, `list_prerequisites`

---

### 18.5 Chrome-Bridge Server (44 tools)

**Purpose** — Browser automation via Chrome extension socket + React/accessibility helpers.

**Architecture** — 17 socket-based tools (via Claude for Chrome extension Unix domain socket), 4 convenience tools (accessibility tree parsing), 4 React automation (controlled components via native-setter pattern), 2 AppleScript (extension management), diagnostics (health_check). Auto-screenshot after mutations.

**Key Files** — `tools/chrome-extension/` (extension source), `tools/chrome-extension/native-host/host.js` (native messaging bridge), `packages/chrome-actions/` (TypeScript bindings)

---

### 18.6 Automated Demo Validation

**Purpose** — 6-hour automated cycle running all scenarios headless; spawns repair agents for failures.

**Architecture** — Opt-in (demoValidationEnabled: true). Flow: query enabled scenarios → run prerequisites → execute each headless → persist results to demo-validation-history.json → spawn demo-manager repair agents (max 3 concurrent, isolated worktrees) → report to deputy-CTO.

**Configuration** — Cooldown: demo_validation (default 360 min). ADK scenarios skipped. Repair prompts include prerequisite context from user-feedback.db.

---

## 19. AI User Feedback System

**Purpose** — Personas test features and report UX/quality feedback, guiding product prioritization and stability.

### 19.1 Five Consumption Modes

| Mode | Tools | Use Case |
|------|-------|----------|
| GUI | Playwright browser | Web UI testing as real user |
| CLI | programmatic-feedback | Command-line tool testing |
| API | programmatic-feedback | REST/GraphQL API testing |
| SDK | Claude Code + Playwright + docs portal | Developer SDK testing |
| ADK | Claude Code + docs-feedback MCP | AI agent SDK testing |

### 19.2 Persona Configuration

**Architecture** — user-feedback.db (SQLite) stores personas, features, mappings, sessions, feedback. MCP server (`packages/mcp-servers/src/user-feedback/server.ts`, 2,987 lines) exposes 40 tools.

**Paths**: /configure-personas (manual interactive), product-manager agent (automated post-analysis, fill-gaps or full-rebuild modes).

### 19.3 Persona Profiles

**Purpose** — Named snapshots of persona/market config with guiding strategic prompt for instant market-target switching.

**MCP Tools** (6): create_persona_profile, archive_persona_profile, switch_persona_profile, list_persona_profiles, get_persona_profile, delete_persona_profile

### 19.4 Feature Stability Registry

**Purpose** — CTO-gated lock/unlock preventing endless agent nitpick chains on solid features.

**MCP Tools** (4): lock_feature (CTO-only), unlock_feature, list_stable_features, check_feature_stability (used by gate agent to auto-kill tasks targeting locked features)

---

## 20. Product Manager System

**Purpose** — Six-section PMF analysis pipeline with CTO approval gates and pain-point-to-persona compliance.

### 20.1 6-Section PMF Pipeline

**Architecture** — `packages/mcp-servers/src/product-manager/server.ts` (1,012 lines). DB: `.claude/state/product-manager.db`. Sequential lock enforces ordering.

| Section | Topic |
|---------|-------|
| 1 | Market Space (TAM, maturity, landscape) |
| 2 | Buyer Personas (decision makers, pain points) |
| 3 | Competitor Differentiation (strengths, moats) |
| 4 | Pricing Models (unit economics, tiers) |
| 5 | Niche Strengths (vertical focus, defensibility) |
| 6 | User Sentiment (testimonials, NPS, satisfaction) |

**Status**: not_started → pending_approval → approved → in_progress → completed. All sections are external market research (never reference local project).

### 20.2 Post-Analysis Persona Creation

After Section 6 completion: Fill gaps only (idempotent backfill) vs Full rebuild (create everything fresh). Auto-detects dev server URL and framework from package.json. Creates/updates personas with consumption modes, maps to features, sets docs endpoints.

---

## 21. Shared Resource Coordination

**Purpose** — Multi-resource lock registry with TTL auto-expiry, priority queue, and dead-agent sweep.

### 21.1 Built-in Resources

| Resource | TTL | Purpose |
|----------|-----|---------|
| display | 15 min | Headed browser / ScreenCaptureKit |
| chrome-bridge | 15 min | Real Chrome via extension |
| main-dev-server | 30 min | Port 3000 dev server |
| Custom | configurable | via register_shared_resource |

### 21.2 Lock Semantics

**Architecture** — `.claude/hooks/lib/resource-lock.js` (1,136 lines). DB: `.claude/state/display-lock.db`. Tables: resource_locks (holder, expires_at, protected_by), resource_queue (priority, status), resource_registry.

**Operations**: acquireResource (free=lock, held=enqueue), releaseResource (promotes next waiter), renewResource (reset TTL), forceReleaseResource (CTO override, blocked for spawned agents), forceAcquireResource (atomic displace+re-enqueue). Dead holder detection via PID liveness check. checkAndExpireResources() in every drain cycle.

**MCP Tools** (6): acquire_shared_resource, release_shared_resource, renew_shared_resource, get_shared_resource_status, register_shared_resource, force_release_shared_resource

---

## 22. Inter-Agent Communication

**Purpose** — File-based signal system enabling CTO directives, agent-to-agent notes, and broadcast messaging with compliance gating.

### 22.1 Signal System

**Architecture** — `.claude/hooks/lib/session-signals.js` (561 lines). File-based: `.claude/state/session-signals/<agent-id>-<ts>-<id>.json`. Three tiers: note (FYI), instruction (urgent, acknowledge), directive (mandatory, blocks completion). Atomic write (tmp+rename). Comms log: `.claude/state/session-comms.log` (24h retention).

**Hooks**: signal-reader.js (PostToolUse, reads/injects on every tool call), signal-compliance-gate.js (PreToolUse, blocks complete_task if unacknowledged directives exist). Throttling: max 1 signal per agent per 30 min.

**MCP Tools** (5): send_session_signal, broadcast_signal, get_session_signals, acknowledge_signal, get_comms_log

### 22.2 Session Activity Broadcasting

**Architecture** — `scripts/session-activity-broadcaster.js` (634 lines, 5-min daemon). Reads JSONL tails → per-session Haiku summaries → super-summary → broadcast. Step 8: auto-subscribe monitors to children (verbatim). Step 9: deliver subscriptions. Step 10: LLM-driven selective delivery (detects overlapping files, dependent features, merge conflict risk).

**MCP Tools** (3): subscribe_session_summaries (short/detailed/verbatim), unsubscribe_session_summaries, list_summary_subscriptions

### 22.3 User Prompt References

**Architecture** — FTS5 virtual table in agent-tracker DB indexes user messages from session JSONL. UUIDs: `up-{sessionId[0:8]}-{hash}-{lineNumber}`. Tasks carry `user_prompt_uuids` linking to original CTO prompts. `user-alignment` agent verifies implementations match intent.

**MCP Tools** (3): get_user_prompt, search_user_prompts, list_user_prompts

### 22.4 Structured HOLD/UNBLOCK Signals (PRs #595, #597, #598)

**Purpose** — Automated agent coordination: plan managers send structured HOLD signals referencing a blocker task; the system auto-UNBLOCKs when the blocker completes or is superseded — no CTO intervention needed.

**Solution 1 — Structured signal metadata**: Signals carry a typed `metadata` field. `resolveHoldSignals()` and `findActiveHolds()` exports in session-signals.js. When a HOLD's referenced blocker task completes, the system auto-sends an UNBLOCK signal to the held agent. `signal-reader.js` formats HOLD/UNBLOCK signals distinctly in injected context.

**Solution 2 — Task supersessions**: `task_supersessions` table in `workstream.db`. MCP tools: `register_supersession` (declare that task B supersedes task A), `list_supersessions`. `workstream-dep-satisfier.js` PostToolUse hook auto-resolves holds when the blocker task is superseded (not just completed).

**Solution 3 — Stale wait watchdog**: `stale-wait-watchdog.js` PostToolUse hook detects agents stuck waiting too long (no stage change + high tool call count since last stage change). Uses `lastStageChangeAt` and `toolCallsSinceStageChange` fields added to `progress-tracker.js`. Configurable thresholds via `automation-config.json`.

---

## 23. Observability & Monitoring

**Purpose** — Centralized logging, performance metrics, and operational visibility across all components.

### 23.1 Elastic Cloud Integration

**Architecture** — Index pattern `{prefix}-{service}-{date}`. Ingests from Vercel, Render, Fly.io, local. MCP tools: `query_logs` (Lucene syntax), `get_log_stats`, `verify_logging_config`. Demo telemetry: console, network, JS errors, performance, system metrics → `logs-demo-telemetry-{date}` index.

**Configuration** — services.json `elastic` section: apiKey (op://), cloudId or endpoint, queryApiKey, indexPrefix.

### 23.2 DORA Metrics

**Architecture** — `.claude/hooks/lib/dora-metrics.js`: Deployment Frequency (PRs/day), Lead Time (PR→merged hours), Change Failure Rate (rollbacks/deploys %), MTTR (alert resolution minutes). Rated: elite/high/medium/low per 2024 benchmarks.

### 23.3 Session Activity Summaries

Daemon generates per-session LLM summaries (Haiku) every 5 min. Stored in session-activity.db. Cross-session relevance delivery (Step 10). See Section 22.2.

### 23.4 CTO Dashboard Live Feed

60s daemon generates Reuters-style AI commentary (max 30 words/sentence, no markdown). Fingerprint-based skip (no LLM call if unchanged). Stored in live-feed.db (max 500 entries). See Section 13.1.5.

---

## 24. Target Project Integration (Full Stack)

### 24.1 Frontend
- Next.js 14 + React 18 + Tailwind + Stripe.js
- Hosted on Vercel (staging + production)
- Browser Extension (Chrome/Firefox, esbuild)

### 24.2 Backend
- Hono 4 (Node.js) + TypeScript
- Hosted on Render (staging + production, auto-scaling)
- Routes: vendor, customer, integration, billing, audit, logs, agent

### 24.3 Database
- Supabase PostgreSQL 17
- Git-based branching (main, staging, preview/pr-*)
- 60 migrations, RLS enforced
- Local Docker-based dev

### 24.4 Auth
- Supabase GoTrue (JWT + session validation)
- Credential encryption: AES-256 at rest

### 24.5 Email
- Resend (transactional)
- Local: Inbucket test server

### 24.6 Payments
- Stripe (metering, webhooks, billing portal)

### 24.7 Agent Compute
- Fly.io (WebSocket bridge, 30-min sessions, 20 concurrent)

### 24.8 DNS
- Cloudflare (stealth mode active — launch-ready)

### 24.9 Logging
- Elastic Cloud (correlation IDs, structured logging)

### 24.10 CI/CD
- GitHub Actions (9 workflows)
- 100% coverage gate

### 24.11 E2E Testing
- Playwright 1.58 (49+ tests, 3 personas, demo scenarios)

---

## 25. Gap Analysis: Initial Setup Guidance

### 25.1 What GENTYR Guides Well
- Framework installation (npx gentyr init)
- Credential inventory (setup-check.js)
- 1Password token entry (secure read -rs)
- Vault mapping creation
- MCP server configuration
- Automation service setup
- Branch protection setup
- Local prototyping mode

### 25.2 What's Missing: Account Creation Automation
- No chrome-bridge guided flow for creating vendor accounts
- User must manually: create GitHub account/org, create Render account, create Vercel account, create Cloudflare account/zone, create Supabase project, create Elastic Cloud deployment, create Resend account, create 1Password vault, create Codecov account, create Fly.io org
- After account creation, user must manually navigate to API key pages and copy tokens

### 25.3 Proposed Gap: Guided Chrome-Bridge Setup
- Step-by-step browser automation for each vendor
- Navigate to API key creation page
- Guide user through creation flow
- Extract key and store directly in 1Password
- Validate key works before proceeding

### 25.4 What's Missing: Project Scaffold to Production
- No guided path from `npx gentyr scaffold` through first deploy
- No automated Supabase project creation
- No automated Render/Vercel project linking
- No automated DNS zone setup
- No automated Fly.io app creation (partially: /setup-fly exists)

### 25.5 What's Missing: Vendor Account Health Monitoring
- No periodic check that API keys are still valid
- No alert when keys expire or quotas are hit
- credential-health-check only verifies 1Password connectivity

---

## 26. Configuration Files

### 26.1 services.json Schema
- worktreeBuildCommand, worktreeBuildHealthCheck, worktreeInstallTimeout
- worktreeProvisioningMode (strict/lenient)
- worktreeArtifactCopy (glob patterns)
- testScopes, activeTestScope
- devServices (dev server config)
- demoDevModeEnv
- fly (Fly.io config)
- steel (Steel.dev config)
- elastic (Elastic Cloud config)
- environments (URL-based remote envs)
- secrets, secrets.local (op:// refs)
- releaseApprovalTier (cto/deputy/automated)
- canary (traffic split config)

### 26.2 automation-config.json
- Cooldowns for all automation blocks
- Context pressure thresholds
- Session hard kill minutes
- Branch age limit hours
- Self-heal max fix attempts

### 26.3 autonomous-mode.json
- 18 automation feature toggles

### 26.4 .mcp.json
- All MCP server definitions
- HTTP vs stdio transport
- Environment variable injection
- Project-local server preservation

---

## 27. Test Infrastructure

### 27.1 Test Scope Profiles
- Named vertical slices of tests
- Scoped unit/integration commands
- Pre-push hook: scoped pass = push allowed with warning
- Promotion pipeline awareness

### 27.2 100% Coverage Gate
- CI template includes test:coverage:check
- Preview-promoter self-healing loop (3 iterations)
- Plan-manager gate: blocks phase advancement on failing CI
- test-writer mandate: treats 100% as non-negotiable

---

## 28. Protection & Security

### 28.1 Root-Owned File Protection
- `npx gentyr protect` — makes critical hooks root-owned
- Tamper detection: symlink target verification + ownership checks
- protection-state.json tracks critical hooks list

### 28.2 Credential File Guard
- Blocks Read/Write/Grep/Glob on credential files
- .mcp.json, services.json secrets, protection-key

### 28.3 Secret Leak Detector
- UserPromptSubmit hook scans for leaked secrets

### 28.4 Multi-Layer Enforcement Architecture
- Guidance → Orchestration → Enforcement progression
- Each behavior has all three layers

---

## 29. Plugin System

### 29.1 Architecture
- plugins/ directory (gitignored)
- config.json + src/server.ts per plugin
- Auto-discovered and registered in .mcp.json

### 29.2 Notion Plugin
- Syncs 4 data sources to Notion databases
- 60-second launchd daemon
- 5 MCP tools

---

## 30. Staging Reactive Review

**Purpose** — Automated 4-stream code review of staging commits before production promotion.

### 30.1 4 Review Streams
- **antipattern** — G001-G019 framework violations
- **code-quality** — security, correctness, performance, maintainability
- **user-alignment** — matches user intent from original prompts
- **spec-compliance** — adheres to project specifications

### 30.2 Automated 60-Minute Cycle

**Architecture** — `stagingReactiveReviewEnabled: true` in automation-config.json. Fetches origin/staging and origin/main → lists commits staging has ahead → skips if SHA unchanged since last review → spawns 4 concurrent `staging-reviewer` sessions (one per focus). Reports tagged `tier: 'staging'` via GENTYR_REPORT_TIER env injection. Max 3 reports per session. Only critical issues escalated.

---

## 31. Report & Triage System

**Purpose** — Unified system for capturing, de-duplicating, and resolving agent reports with tier-based triage.

### 31.1 Two-Tier Triage
- **Preview tier**: Cannot escalate to CTO (self-resolve, dismiss, or create task)
- **Staging tier**: Can escalate (blocking production promotion)
- Tier injection: GENTYR_REPORT_TIER set based on worktree base branch

### 31.2 Report Auto-Resolution

**Architecture** — `.claude/hooks/lib/report-auto-resolver.js`: Polls merged PRs every 2 min (`runReportAutoResolve`). Feeds PR diffs + pending reports to Haiku via `callLLMStructured`. Auto-resolves confirmed fixes (triage_status='self_handled'). Dedup pass every 30 min (`runReportDedup`, skips if <3 pending). Fast-exit: 0 pending or 0 new PRs → no LLM call.

### 31.3 Deputy-CTO Agent
- Investigation-before-escalation pattern (spawns investigator first)
- Outcomes: self_handled, dismissed, task-created, escalated
- Auto-escalation rules (no discretion): G002 violations, security vulns, bypass requests

---

## 32. Workstream Management

**Purpose** — Track and enforce queue dependencies between sessions to prevent race conditions.

### 32.1 Queue Dependency System

**Architecture** — workstream.db: queue_dependencies table. Blocks spawning until dependencies satisfied. workstream-manager agent (Haiku-tier, read-only) analyzes queue for conflicts, adds/removes dependencies, reorders items. 8 MCP tools on agent-tracker: add_dependency, remove_dependency, list_dependencies, get_queue_context, reorder_item, record_assessment.

---

## 33. Release Automation Summary

**Purpose** — End-to-end orchestration from feature branch to production with quality gates and CTO sign-off.

### 33.1 Complete Flow (10 Steps)

```
1. Developer works on feature branch (in worktree)
2. Project-manager commits, pushes, creates PR to preview
3. CI passes → self-merge to preview
4. Preview-promoter: 6-step quality gates → promotes to staging
5. Staging reactive review (4 streams, 60-min cycle)
6. CTO initiates /promote-to-prod
7. 8-phase release pipeline (per-PR review, triage, meta-review, tests+demos, demo coverage, final triage, CTO sign-off, report)
8. CTO cryptographic sign-off (HMAC-SHA256 proof)
9. Merge staging → main, staging unlocked
10. Report generated (.md + .pdf), GitHub Release created, artifacts archived
```

**Key Systems**: release-ledger.db (evidence), staging-lock.json (lock), plan-orchestrator (8-phase plan), cto-approval-proof.js (HMAC), release-report-generator.js (report)

---

## 34. Settings.json & Hook Registration

**Purpose** — Define and register all framework hooks via template-based settings merge with project-local preservation.

### 34.1 Template-Based Hook Registration

**Architecture** — `templates/config/settings.json.template` (679 lines) defines 99 hook entries across 5 types. Each entry: `{ "type": "command", "command": "node ${CLAUDE_PROJECT_DIR}/.claude/hooks/<name>.js", "timeout": N }`. Matchers: `""` (all tools), `"Bash"`, `"Write,Edit"`, `"mcp__*"`, specific tool names.

### 34.2 .mcp.json Generation

**Architecture** — `cli/lib/config-gen.js` orchestrates: template substitution (${FRAMEWORK_PATH}), daemon detection (plist/systemd → HTTP entries), local mode filtering, project-local server preservation (extractProjectServers/mergeProjectServers), plugin discovery, OP token injection. See Section 4.2.

### 34.3 Settings Merge Logic

**Architecture** — `merge-settings.cjs` does non-destructive merge. GENTYR hooks identified by `.claude/hooks/` path. Install: removes old GENTYR hooks atomically, inserts new from template. Preserves all project hooks and non-hook settings. Deduplicates by command within each matcher. Uninstall: strips all `.claude/hooks/` entries.

---

## 35. Inter-Agent Communication System

### 35.1 Signal Types & Priority Tiers
- note: Agent→Agent, informational, use discretion
- instruction: Deputy-CTO→Agent, urgent, must acknowledge
- directive: CTO→Agent, mandatory override, blocks completion

### 35.2 Signal Storage & Delivery
- File-based: `.claude/state/session-signals/<agent-id>-<ts>-<sig-id>.json`
- Atomic JSON writes (tmp+rename for corruption prevention)
- Communication log: `.claude/state/session-comms.log` (JSON-lines, 24h retention)
- Worktree-aware: resolves main project tree for signal storage

### 35.3 Signal Reader Hook (PostToolUse)
- Fast path: readdir count only (no file I/O if 0 signals)
- Slow path: reads files, formats by tier, injects into additionalContext
- Only fires for spawned sessions (CLAUDE_AGENT_ID present)

### 35.4 Signal Compliance Gate (PreToolUse)
- Blocks complete_task/summarize_work when unacknowledged directives exist
- Only gates spawned sessions
- Fail-open if signal system unavailable

### 35.5 Broadcast Signals
- broadcastSignal() queries session-queue.db for active agents
- Excludes gate/audit lane agents from broadcasts
- Used by preview-watcher, plan-merge-tracker, activity broadcaster

### 35.6 Signal Throttling
- Global monitor: max 1 signal per agent per 30 min
- Self-pause if >5 signals/hour (diagnostic escalation)

---

## 36. Session Briefing System

### 36.1 Interactive (CTO) Session Briefing
- Queue state (running/queued/suspended counts)
- CTO bypass requests awaiting decision
- Blocking queue items (grouped by severity)
- Active persona profile (name + guiding prompt)
- Focus mode status
- Paused task breakdown (crash-loop/bypass-request/manual)
- Branch drift warnings (main ahead of staging)
- Deferred protected actions awaiting approval
- Plans progress summary
- Persistent task health

### 36.2 Spawned Agent Briefing
- Current task details from todo.db
- Active sessions in queue (context awareness)
- Recent CTO directives (last 2h)
- Blocking items (drift, bypass requests)
- Persistent task state
- Git activity (recent commits)

### 36.3 CTO Notification Hook (Every Prompt)
- Multi-line status: git branch, quota bars (5h/7d), context window
- Usage metrics: tokens, sessions, TODOs, deputy status
- Plans: active count, overall %, ready to spawn, running agents
- Persistent: active count, dead monitors
- Staging drift: commits behind preview
- Blocking items and pending bypass requests injected into model context
- 3s time budget with incremental caching

---

## 37. Stop-Continue Hook (Session Exit Gating)

### 37.1 Gating Conditions
- Plan manager with incomplete tasks → BLOCK
- Persistent monitor with active task → BLOCK
- Task session with uncommitted changes → BLOCK (spawn project-manager)
- Task session first stop, clean worktree → BLOCK (guidance)
- Task session second+ stop → APPROVE
- Session preempted (suspended) → APPROVE

### 37.2 Plan Manager Escape Hatch
- If persistent task paused/completed/cancelled → allow exit
- Prevents infinite pressure loop on blocked monitors

### 37.3 Worktree Cleanup Gate
- Blocks if worktree still exists and required sub-agents not run
- Required: user-alignment + project-manager

---

## 38. Spawn Environment

### 38.1 Injected Environment Variables
- CLAUDE_PROJECT_DIR — project root
- CLAUDE_SPAWNED_SESSION — 'true'
- CLAUDE_AGENT_ID — unique agent identifier
- CLAUDE_WORKTREE_DIR — worktree path (if applicable)
- CLAUDE_QUEUE_ID — session queue entry ID
- PATH — git-wrappers prepended (guarded git operations)
- GENTYR_PROMOTION_PIPELINE — for promotion agents
- GENTYR_PERSISTENT_TASK_ID — for persistent monitors
- GENTYR_PLAN_MANAGER — for plan managers
- GENTYR_PLAN_ID — for plan managers
- GENTYR_DEPUTY_CTO_MONITOR — for global alignment monitor
- GENTYR_REPORT_TIER — preview/staging tier for reports
- GENTYR_STRICT_INFRA_GUIDANCE — for infrastructure guidance
- GENTYR_RELEASE_ID — for release artifact collection

---

## 39. Packages (Beyond MCP Servers)

**Purpose** — TypeScript libraries and CLIs for Chrome automation, Playwright helpers, and real-time dashboarding.

### 39.1 @gentyr/chrome-actions
TypeScript bindings for Chrome Extension socket protocol. ChromeActions class: 17 socket tools + 4 React automation methods (reactFillInput, clickAndWait, pageDiagnostic, inspectInput) + waitForUrl helper. Unix domain socket communication via ChromeSocketClient. Tab management, element interaction, GIF recording, accessibility tree parsing.

### 39.2 @gentyr/playwright-helpers
Shared utilities for demo scenarios. Persona overlay injection (visual badge). LiveCodes editor tab (type code, run, get output). xterm terminal tab (type commands, wait for output). Demo interrupt (Escape key mechanism: isInterrupted, throwIfInterrupted, getInterruptPromise). Cursor highlight animation.

### 39.3 @gentyr/cto-dashboard (Static CLI)
Ink-based React TUI with timeline view. Sections: quota, usage, deployments, testing, infra, worklog, plans. 18+ data reader utility modules (SQLite/JSON). Mock data support. CLI: `gentyr-dashboard --hours 8 --section deployments`.

### 39.4 @gentyr/cto-dashboard-live (Interactive TUI)
Real-time Ink/React TUI polling every 3s. 5 pages: Observe (sessions + activity), Demos & Tests (scenarios + branch selector + launch), Plans (phases + audit), Specs (navigator), Feed (AI commentary). Live data reader (74KB, reads all DBs + JSONL). Signal delivery, demo launch with display lock preemption, process runner with live output tailing.

---

## 40. Infrastructure (Fly.io)

### 40.1 infra/fly-playwright/ Directory
- fly.toml: App config (iad region, shared-cpu-2x, 2GB RAM, 5GB volume)
- fly.toml.template: Configurable template (APP_NAME, REGION, MACHINE_SIZE)
- Dockerfile: Base image (Node 22, Playwright deps, Xvfb, ffmpeg)
- Dockerfile.project: Pre-built project image (skip clone/install)
- remote-runner.sh: Full orchestration (clone, install, prereqs, dev server, test, record, collect artifacts)
- provision-app.sh: Automated Fly.io app creation

### 40.2 Remote Runner Lifecycle
1. Git clone + pnpm install (or skip if project image)
2. Environment validation
3. Prerequisite execution (JSON-configured)
4. Dev server startup with health polling
5. Xvfb + ffmpeg recording (headed mode only)
6. System metrics collection (telemetry)
7. Playwright test execution with stall detection
8. Recording trim (demo_first_action/demo_last_action markers)
9. Artifact collection
10. 60s grace period for MCP artifact retrieval

### 40.3 Two-Tier Image Strategy
- Base image: Universal Playwright runner (~2 min startup with clone+install)
- Project image: Pre-built with deps (~30s startup, skip install)
- deploy_fly_image MCP tool builds and pushes via /setup-fly

---

## 41. Git Wrappers

**Purpose** — PATH-injected wrapper protecting main tree from accidental branch switches and destructive git operations.

### 41.1 git-wrappers/git (318 lines)
Finds real git binary by searching PATH (skips wrapper dir). Fast-path passthrough for safe commands (log, status, diff, show, blame, branch, remote, fetch, ls-remote).

### 41.2 Layer 1: Branch-Change Blocks (ALL sessions, main tree)
Blocks: `git checkout <branch>`, `git switch <branch>`. Exceptions: `git checkout main` (recovery), file restore with `--`.

### 41.3 Layer 2: Destructive Ops Blocks (spawned agents only, main tree)
Blocks: `git add`, `git commit`, `git reset --hard`, `git stash`, `git clean`, `git pull`. Allowed: soft/mixed reset, stash list/show (read-only).

### 41.4 Exceptions
Worktrees (.git is a file) → all operations allowed. GENTYR_PROMOTION_PIPELINE=true → all operations allowed.

---

## 42. Husky Git Hooks

**Purpose** — Enforce framework security, code quality, and commit review at the git operation level.

### 42.1 pre-commit (166 lines)
Security: root-ownership verification of `.claude/hooks/`. Symlink integrity check. core.hooksPath poisoning defense. Fast branch guard: blocks commits to protected branches. lint-staged enforcement. Deputy-CTO commit review (G020) via pre-commit-review.js.

### 42.2 post-commit (fire-and-forget)
compliance-checker.js (2h cooldown, background). antipattern-hunter-hook.js (6h cooldown, background). Both non-blocking.

### 42.3 pre-push (207 lines)
Worktree: only build health check (CI verifies on merge). Main tree: full test suite enforcement. Scope-aware: GENTYR_TEST_SCOPE env var filters tests. Repo hygiene: fire-and-forget, non-blocking.

---

## 43. Test Infrastructure

### 43.1 Hook Tests (67 files in .claude/hooks/__tests__/)
- Framework: Node.js built-in `node:test` runner
- Philosophy: validate structure, fail loudly, G001 compliance
- Coverage: security guards, session management, automation, deployment

### 43.2 MCP Server Tests (~17 __tests__ directories)
- Framework: Vitest with V8 coverage
- Custom reporter: TestFailureReporter spawns Claude on failures
- Fixtures: factory functions for all data types (639-line fixtures.ts)
- Coverage: every server has tests for handler logic

### 43.3 Script Tests (scripts/__tests__/)
- Framework: Node.js built-in `node:test`
- Coverage: setup-check, setup-validate, mcp-launcher, credential-cache, readme, revival-daemon

### 43.4 E2E Tests (tests/)
- Integration: in-memory SQLite + McpTestClient (fast, seconds)
- E2E: real Claude agent sessions (5-min timeout)
- Toy app fixture: web (9 bugs), CLI (1 bug), SDK (6 bugs)
- Tests all 5 consumption modes simultaneously

### 43.5 AI-Powered Test Fixing
- TestFailureReporter spawns Claude Code on failure
- Per-suite cooldown: 60 min between spawns
- Content-based deduplication (SHA-256, 12h expiry)
- Fire-and-forget (doesn't block test completion)

### 43.6 CI Templates for Target Projects (4 workflows)
- ci.yml: lint, typecheck, unit (100% coverage), build, E2E, security
- dependency-review.yml: weekly pnpm audit + issue creation
- merge-chain-check.yml: feature→preview→staging→main enforcement
- security-scan.yml: CodeQL + TruffleHog secret scanning

---

## 44. Documentation System

### 44.1 docs/ Directory (15+ files)
- CLAUDE-REFERENCE.md (110.7KB) — comprehensive reference
- SETUP-GUIDE.md — 9-phase credential setup
- DEPLOYMENT-FLOW.md — CI/CD pipeline
- CTO-DASHBOARD.md — dashboard features
- AUTOMATION-SYSTEMS.md — automation frameworks
- TESTING.md — test infrastructure
- STACK.md — technology overview
- CHANGELOG.md (213.3KB) — complete version history
- BINARY-PATCHING.md — clawd/node patching
- SECRET-PATHS.md — op:// reference paths
- Executive.md — strategic overview

### 44.2 Case Study (docs/case-study-aws-demo/)
- 8-part post-mortem analysis
- Failure taxonomy, root cause, task scoping, CTO intervention
- Multi-layer prevention strategy

### 44.3 Specs System (specs-browser MCP, 12 tools)
- Framework specs: CORE-INVARIANTS.md (F001-F005)
- Pattern specs: AGENT-PATTERNS.md, MCP-SERVER-PATTERNS.md, HOOK-PATTERNS.md
- Project specs: local/, global/, reference/ categories
- Suite management: group related specs with directory patterns
- File mapping: get_specs_for_file (glob-based)

---

## 45. Binary Patching (Advanced)

### 45.1 patch-clawd.py (28.3KB)
- Patches Claude CLI binary
- Credential interception, MCP hardening, session tracking

### 45.2 patch-credential-cache.py (13.0KB)
- Patches system credential cache
- Prevents credential leakage to spawned agents

### 45.3 resign-node.sh
- Re-signs Node.js binary for macOS notarization
- Required after binary patching

---

## 46. Report Templates

### 46.1 release-report-template.md (11 sections)
- Release overview, changes, customer changelog
- QA summary (per-PR, tests, demos, coverage)
- Issues discovered, CTO decisions, evidence chain
- Screenshots, CTO approval, promotion history, deploy verification

### 46.2 promotion-report-template.md (7 sections)
- Changes promoted, quality review, pre-merge tests
- Test results, demo results, post-deploy verification
- SHA tracking, deployment status

---

## 47. Overdrive Mode

**Purpose** — Temporarily maximize automation frequency for rapid iteration with automatic reversion.

### 47.1 /overdrive-gentyr
Maxes all automation cooldowns to minimum (5-10 min range) for 1 hour. State stored in automation-config.json with expiry timestamp. Auto-reverts after timer expires (fail-safe). Used for bulk refactoring, demo prep, release pushes.

---

## 48. Automation Rate System (replaces Focus Mode)

**Purpose** — Control how aggressively background automations run via 4 static presets.

### 48.1 Architecture
State: `.claude/state/automation-rate.json` (`{ rate, set_at, set_by }`). Default: `low`. The rate multiplier is applied inside `getCooldown()` in `config-reader.js` to all non-infrastructure cooldown keys. Infrastructure keys (session_reviver, worktree_cleanup, persistent_heartbeat_stale_minutes, report_auto_resolve, etc. — 28 keys in `INFRASTRUCTURE_KEYS` set) pass through unmodified.

### 48.2 Rate Levels

| Rate | Multiplier | Effect |
|------|-----------|--------|
| `none` | Blocked | No automated agents spawn — gate in `enqueueSession()` returns `{ blocked: 'automation_rate_none' }` |
| `low` | 5x | **DEFAULT** — Conservative automation (e.g., task_runner every 20h instead of 4h) |
| `medium` | 2x | Moderate (e.g., task_runner every 8h) |
| `high` | 1x | Baseline rates (original behavior) |

### 48.3 What Passes Through `none`
Same allowlist as the former focus mode: priority cto/critical, lanes persistent/gate/audit/revival, sources force-spawn-tasks/persistent-task-spawner/stop-continue-hook/session-queue-reaper/sync-recycle, items with metadata.persistentTaskId.

### 48.4 MCP Tools & Slash Command
`set_automation_rate({ rate })` and `get_automation_rate()` on agent-tracker server. `set_focus_mode` / `get_focus_mode` preserved as backward-compat aliases (enabled=true → none, enabled=false → low). Slash command: `/automation-rate [none|low|medium|high]`. `/focus-mode` redirects to `/automation-rate`.

---

## 49. Workstream System

**Purpose** — Track and enforce queue dependencies between sessions to prevent race conditions.

### 49.1 Queue Dependencies
workstream.db: queue_dependencies table. Blocks spawning until dependencies satisfied. Checked in drainQueue Step 5 spawn loop.

### 49.2 Workstream Manager Agent (Haiku-tier)
Analyzes active queue for file-path conflicts. Adds/removes dependencies. Reorders items. Records assessments.

### 49.3 Workstream Tools (8)
add_dependency, remove_dependency, list_dependencies, get_queue_context, reorder_item, record_assessment, get_workstream_status, clear_resolved_dependencies

---

## 50. Protected Actions System

**Purpose** — Require CTO approval for destructive/irreversible/external-visible operations before execution.

### 50.1 protected-actions.json
Defines which MCP tool calls require approval. Per-server, per-tool granularity. Categories: destructive, external-visible, irreversible.

### 50.2 Protected Action Gate (PreToolUse)
`protected-action-gate.js` (195 lines) intercepts MCP calls matching config. Interactive: prompts synchronously. Spawned: stores as deferred action with HMAC signatures, blocks the tool call, and presents two options: (A) call `submit_bypass_request` with category `protected_action` to pause the task and wait for CTO approval, or (B) poll `check_deferred_action` every 30 seconds (for persistent monitors). Agents are instructed NOT to exit silently.

### 50.3 Deferred Protected Actions
DB: deferred_actions table in bypass-requests.db. Lifecycle: pending→approved→executing→completed/failed. Tier 1 only (HTTP execution via daemon). HMAC domain separation: 'deferred-pending'/'deferred-approved'. args_hash binding. CTO sees in briefing, types `APPROVE <phrase> <code>`. `deferred-action-executor.js` (399 lines) handles MCP HTTP execution with timing-safe comparison.

### 50.4 Deferred Action Auto-Resume (Hourly Automation)
`deferred_action_resume` block in `hourly-automation.js` (5-minute cooldown, gate-exempt). Two functions: (1) When a deferred action reaches `completed` or `failed` status, auto-resolves the linked `pending` bypass request so the paused task can re-spawn naturally. (2) Cancels stale `protected_action` bypass requests older than 5 minutes whose parent persistent task is already `completed`/`cancelled`/`failed`. Reads from bypass-requests.db (deferred_actions JOIN bypass_requests) and cross-checks persistent-tasks.db for parent status.

### 50.5 check_deferred_action MCP Tool
Agent-tracker server tool for polling deferred action status. Returns: id, server, tool, status, execution_result (parsed JSON), execution_error, timestamps, and a `hint` field with next-step guidance per status. Used by spawned agents waiting for CTO approval of protected actions. Reads from bypass-requests.db deferred_actions table.

---

## 51. Unified CTO Decision System

**Purpose** — One pattern for all CTO approvals: agent presents → CTO types natural language → `record_cto_decision` verifies the CTO actually typed it → downstream action proceeds. Eliminates 6 separate approval mechanisms.

### 51.1 Core Security Architecture
- `.claude/protection-key` — root-owned, base64-encoded 256-bit HMAC signing key
- Agents CANNOT read this file (credential-file-guard blocks access)
- `record_cto_decision` and hook processes are the only readers
- Constant-time comparison (crypto.timingSafeEqual) throughout
- Domain separator: `'cto-decision'` + `decision_type` prevents cross-context replay

### 51.2 Decision Flow (Universal)
1. Agent presents decision to CTO via `AskUserQuestion` (with Approve/Reject options)
2. CTO types natural language response (e.g., "approved, ship it")
3. Agent calls `record_cto_decision({ decision_type, reference_id, verbatim_text })`
4. Tool finds session JSONL via `cto-approval-proof.js:findCurrentSessionJsonl()`
5. TOCTOU defense: JSONL snapshotted before verification
6. `verifyQuoteInJsonl(snapshot, verbatim_text)` — scans for exact substring in human messages
7. HMAC-SHA256 computed with protection-key + domain separator + decision_type
8. Inserted into `cto_decisions` table (status: `verified`)
9. Agent calls downstream action (e.g., `resolve_bypass_request`)
10. Downstream calls `consumeCtoDecision(type, reference_id)` — verifies HMAC, transitions to `consumed` (one-time use)

### 51.3 Decision Types

| Type | What needs approval | Consumer tool | Cascade |
|------|---------------------|---------------|---------|
| `bypass_request` | Agent blocked, needs CTO authorization | `resolve_bypass_request` | Persistent task resumed → plan task + plan auto-resumed |
| `protected_action` | Protected MCP tool call (deploy, SQL) | `protected-action-approval-hook.js` | Deferred action auto-executed |
| `lockdown_toggle` | Disable interactive lockdown | `set_lockdown_mode` | Lockdown disabled |
| `release_signoff` | Production release CTO approval | `record_cto_approval` (release-ledger) | Release proceeds |
| `staging_override` | Override staging lock during release | `create_promotion_bypass` | Staging merge allowed |

### 51.4 Server-Side Enforcement
- `record_cto_decision` — blocks `CLAUDE_SPAWNED_SESSION=true` (only interactive CTO)
- `resolve_bypass_request` — blocks spawned sessions AND requires `consumeCtoDecision('bypass_request', request_id)` before processing; returns 3-step instructions on failure
- `cto-notification-hook.js` — injects MANDATORY AskUserQuestion instruction into model context when pending decisions exist

### 51.5 What's Protected (Enforcement Hooks)
- staging-lock-guard.js — blocks staging merges unless GENTYR_PROMOTION_PIPELINE=true
- interactive-lockdown-guard.js — blocks file edits in CTO sessions
- main-tree-commit-guard.js — blocks git ops on protected branches
- credential-file-guard.js — blocks reading credential files
- gate-confirmation-enforcer.js — blocks task completion during audit
- signal-compliance-gate.js — blocks malformed inter-agent signals
- branch-checkout-guard.js — blocks branch switching in main tree
- block-no-verify.js — blocks --no-verify on git commands

### 51.6 Deferred Protected Action Execution (Async)
- For spawned agents that can't wait interactively
- Tool call (server, tool, args) stored with HMAC signatures
- CTO approves hours later → system executes via HTTP POST to MCP daemon
- args_hash binding prevents bait-and-switch
- pending_hmac / approved_hmac verified before execution
- Tier 1 only (shared daemon, HTTP transport)
- `deferred_action_resume` automation (5-min cycle) auto-resolves linked bypass requests

### 51.7 Release-Level Cryptographic Approval
- record_cto_approval: only interactive CTO sessions can sign off
- HMAC-SHA256 = hash(releaseId | sessionId | approvalText | fileHash | "cto-release-approval")
- TOCTOU defense: JSONL archived before verification
- Three tiers: cto (HMAC), deputy (HMAC), automated (no HMAC)

### 51.8 Legacy Compatibility (Transition Period)
- Old `APPROVE BYPASS <6-char-code>` pattern still works via `bypass-approval-hook.js`
- Will be deprecated once unified system is validated
- Both paths coexist — old codes consume tokens directly, new path requires `record_cto_decision`

### 51.9 Data Model
- **cto_decisions** table (in bypass-requests.db): id, decision_type, reference_id, verbatim_text, session_id, session_jsonl_hash, hmac, status (verified|consumed|expired), consumed_at, created_at
- **Key files**: `packages/mcp-servers/src/agent-tracker/server.ts` (record_cto_decision, check_cto_decision, consumeCtoDecision), `.claude/hooks/lib/cto-approval-proof.js` (verifyQuoteInJsonl, findCurrentSessionJsonl, computeFileHash), `.claude/hooks/cto-notification-hook.js` (presentation layer)

### 51.10 Paused Task Triage (Deputy-CTO Automation)
`paused_task_triage` block in `hourly-automation.js` — gate-exempt, 10-minute cooldown. Queries paused persistent tasks (excluding `do_not_auto_resume` flag). Spawns deputy-cto agent to evaluate each: resume if the blocking condition cleared, escalate to CTO if human decision needed. Deputy-CTO gains `resume_persistent_task` + `cancel_persistent_task` tools for this authority.

**Pause hierarchy** (3 levels, 1 root):
```
Plan (paused) → Plan Task (paused) → Persistent Task (paused) ← ROOT
                                        └── Todo Task (pending + bypass guard)
```
Triage targets persistent tasks because resuming them cascades via `propagateResumeToPlan()`:
- Plan task: paused → in_progress
- Blocking queue entries: active → resolved
- Plan: paused → active (if no other paused tasks remain)
- Monitor re-enqueued at critical priority

---

## 52. Inter-Agent Signal System (Complete)

### 52.1 Signal Tiers
| Tier | Source | Authority | Acknowledgment Required | Blocks Completion |
|------|--------|-----------|------------------------|-------------------|
| note | Agent→Agent | Informational | No | No |
| instruction | Deputy-CTO→Agent | Urgent | Yes (must call acknowledge_signal) | No |
| directive | CTO→Agent | Mandatory override | Yes (must acknowledge) | YES — blocks complete_task/summarize_work |

### 52.2 Storage & Delivery Mechanism
- File-based: `.claude/state/session-signals/<agent-id>-<ts>-<sig-id>.json`
- Atomic writes (tmp+rename prevents corruption)
- Worktree-aware: resolves main project tree (not worktree dir)
- Communication log: `.claude/state/session-comms.log` (JSON-lines, 24h retention)

### 52.3 Signal Delivery (PostToolUse: signal-reader.js)
- Fires on EVERY tool call for spawned sessions
- Fast path: readdir count only (zero I/O if no signals)
- When signals exist: reads files, marks as read, formats by tier
- Injects formatted signal into `additionalContext` (model sees it)
- Interactive CTO sessions skip signal reader

### 52.4 Signal Compliance Gate (PreToolUse: signal-compliance-gate.js)
- Blocks complete_task and summarize_work when unacknowledged DIRECTIVES exist
- Only gates spawned sessions
- Fail-open if signal system unavailable (never blocks on infra failure)

### 52.5 Broadcast Signals
- `broadcastSignal()` queries session-queue.db for all active agents
- Excludes gate/audit lane agents
- Used by: preview-watcher (freshness), plan-merge-tracker (PR merges), activity broadcaster

### 52.6 Signal Throttling (Global Monitor)
- Max 1 signal per agent per 30 min
- If >5 signals/hour → monitor self-pauses + diagnostic escalation to CTO

### 52.7 MCP Tools for Signals (on agent-tracker)
- `send_session_signal` — point-to-point signal
- `broadcast_signal` — multicast to all active agents
- `get_session_signals` — read signal history
- `get_comms_log` — full communication audit trail
- `acknowledge_signal` — mark signal acknowledged (required for instructions/directives)

---

## 53. Session Activity Broadcasting & LLM-Driven Delivery (Complete)

### 53.1 Architecture
- Daemon: `scripts/session-activity-broadcaster.js` (launchd KeepAlive)
- Polls every 5 minutes
- Reads running session JSONL tails
- Generates per-session summaries via `claude -p --model haiku`
- Creates unified super-summary of all activity
- Stores in `.claude/state/session-activity.db`

### 53.2 Three Delivery Steps (per poll cycle)

**Step 8 — Auto-Subscribe Persistent Monitors to Children**
- For each persistent task with running child sessions:
- Auto-subscribes the monitor to `verbatim` tier summaries of its children
- Keyed by `persistentTaskId` in session metadata
- Monitors get near-complete visibility of child agent work

**Step 9 — Deliver Pending Subscriptions**
- Processes subscription queue (summary_subscriptions table)
- Three delivery tiers:
  - `short` — 2-4 sentence summary
  - `detailed` — full summary + agent type context
  - `verbatim` — full summary + raw recent session messages
- Delivers via `sendSignal` (file-based, appears on next tool call)

**Step 10 — LLM-Driven Selective Delivery (the "smart" step)**
- Spawns `claude -p --model haiku --output-format json --json-schema <schema>`
- LLM analyzes ALL running sessions and their summaries
- Detects cross-session relevance:
  - Overlapping file paths being edited
  - Dependent features being worked on simultaneously
  - Merge conflict risk between parallel branches
  - Shared resource contention
- Delivers targeted summaries ONLY to sessions that would benefit
- Skips sessions already covered by Step 9 (no duplicates)

### 53.3 Subscription Management (3 MCP tools on agent-tracker)
- `subscribe_session_summaries` — subscribe to another session (short/detailed/verbatim)
- `unsubscribe_session_summaries` — remove subscription
- `list_summary_subscriptions` — shows both outgoing and incoming relationships

### 53.4 Database Schema (session-activity.db)
- `session_summaries` — per-session LLM-generated summaries
- `project_summaries` — unified super-summaries
- `summary_subscriptions` — subscriber/target/tier relationships

### 53.5 Is This Feature Active?
- YES — the daemon is a KeepAlive launchd service (`com.local.gentyr-session-activity-broadcaster`)
- Runs automatically as long as the automation service is installed
- No opt-in toggle needed (always-on infrastructure)
- The LLM-driven selective delivery (Step 10) runs every cycle
- Summaries are stored long-term (no DB cleanup)

---

## 53b. Global Deputy-CTO Monitor

**Purpose** — Always-on persistent session that continuously monitors all agent activity for alignment drift, zombie sessions, and stuck audit gates. Opt-out (enabled by default).

### 53b.1 Architecture
- **Auto-spawn**: `global_monitor_health` block in `hourly-automation.js` (gate-exempt, 5-minute cooldown). Creates a persistent task with `metadata: { task_type: "global_monitor", do_not_complete: true }` if none exists. Re-enqueues if the task is `active` but has no running/queued monitor. Respects CTO decisions (skips if paused/cancelled/completed).
- **Persistent across restarts**: Uses the persistent task system — `requeueDeadPersistentMonitor()`, crash-loop circuit breaker, heartbeat-stale detection, and the revival daemon all apply automatically.
- **Agent**: `deputy-cto` agent in Global Monitor Mode (triggered by `GENTYR_DEPUTY_CTO_MONITOR=true` env var). Runs in the `persistent` lane at `critical` priority.

### 53b.2 Monitor Cycle (every 5 minutes)
1. **Bypass request triage** (HIGHEST PRIORITY): Handle `BYPASS_REQUEST` directive signals delivered by `bypass-request-router.js`. Auto-approve (~40%), auto-reject (~10%), or escalate to CTO (~50%) via the 3 exclusive deputy tools. Monitor has ~5 minutes before the CTO sees unescalated requests.
2. **Orient**: `list_project_summaries` for global agent activity overview
3. **Enumerate**: `list_tasks(in_progress)` + `list_persistent_tasks(active)` for all active work
4. **Alignment dispatch**: Search user prompts for CTO intent, spawn `user-alignment` sub-agents in `alignment` lane (max 3 concurrent) for unchecked work
5. **Read alignment results**: Misalignment → send corrective signal. Significant drift → `submit_bypass_request` on the affected task
6. **Zombie detection**: Sessions >2h with no recent tool calls → kill
7. **Audit gate oversight**: Tasks stuck in `pending_audit` >10 min → auditor may have died
8. **Heartbeat and sleep**

### 53b.3 Configuration & Control
- **Toggle**: `globalMonitorEnabled` in `autonomous-mode.json` (default: `true`). Set via `set_automation_toggle({ feature: 'globalMonitorEnabled', enabled: false })` or `/global-monitor off`.
- **Slash command**: `/global-monitor [on|off]` — bare shows status, `on` enables + activates task, `off` disables + pauses task.
- **Session briefing**: Shows "Global monitor: ACTIVE (pid XXXX, last heartbeat Xm ago)" or "DISABLED" in CTO login briefing.

### 53b.4 Bypass Request Routing

**Purpose** — Route bypass requests to the global monitor BEFORE the CTO sees them, giving the monitor a 5-minute triage window.

**Architecture**:
- `bypass-request-router.js` (PostToolUse on `submit_bypass_request`): Checks if the global monitor is active (persistent-tasks.db + session-queue.db + PID liveness). If active, sends a `BYPASS_REQUEST` directive signal to the monitor's agent ID via `sendSignal()`. If not active, does nothing (CTO sees immediately).
- `session-briefing.js`: `getPendingBypassRequests()` applies a 5-minute grace period when the global monitor is active — hides requests younger than 5 minutes UNLESS `deputy_escalated = 1`.
- `cto-notification-hook.js`: `getPendingBypassRequests()` applies the same grace period filter. `isGlobalMonitorActive()` helper checks persistent-tasks.db + PID liveness.
- The monitor receives bypass requests passively via `signal-reader.js` (injected on the next tool call) — no polling needed.

**Flow**: Agent calls `submit_bypass_request` → hook sends directive signal to monitor → monitor triages (approve/reject/escalate) → if unresolved after 5 minutes, CTO sees it.

### 53b.5 Key Files
- `.claude/hooks/hourly-automation.js` — `global_monitor_health` runIfDue block
- `.claude/hooks/bypass-request-router.js` — PostToolUse hook routing bypass requests to monitor
- `agents/deputy-cto.md` — Global Monitor Mode section
- `.claude/hooks/alignment-monitor-briefing.js` — PostToolUse hook: 3-layer alignment enforcement (v2.0). Tracks alignment task creation via state file. Nudges at 1 cycle overdue, warns at 3+ cycles with exact MCP tool calls. Full 8-step cycle briefing every 5 tool calls. Fires only for `GENTYR_DEPUTY_CTO_MONITOR=true` sessions.
- `.claude/hooks/session-briefing.js` — `getGlobalMonitorState()` for CTO display + grace period filtering
- `.claude/hooks/cto-notification-hook.js` — `isGlobalMonitorActive()` + grace period filtering
- `.claude/commands/global-monitor.md` — slash command

### 53b.6 Multi-Layer Alignment Enforcement

Three-layer approach ensures the monitor dispatches user-alignment checks rather than skipping them:

| Layer | Mechanism | What it does |
|-------|-----------|-------------|
| **1. Agent definition** | `agents/deputy-cto.md` Global Monitor Mode | Step 4 marked MANDATORY with exact MCP tool calls. "You MUST create at least one alignment check task per cycle." |
| **2. Recurring hook** | `alignment-monitor-briefing.js` (PostToolUse, env-gated) | Tracks `cyclesSinceAlignment` via state file. Credits `search_user_prompts` and alignment task creation. Warns at 1 cycle, escalates at 3+ cycles with full tool call instructions. |
| **3. Tool restriction** | Agent def `disallowedTools` + `spawnQueueItem()` | `Edit, Write, NotebookEdit, Task` blocked in agent def. `--disallowedTools Edit,Write,NotebookEdit` injected at spawn time. Forces all changes through `create_task` + `force_spawn_tasks`. |

### 53b.7 Escalation Framework
- Minor drift (~50%): corrective signal to the drifting agent
- Moderate misalignment (~35%): self-created correction task
- Significant drift (~15%): `submit_bypass_request` on the affected task for CTO attention
- Signal throttling: max 1 signal per agent per 30 minutes; self-pauses if >5 signals/hour

### 53b.8 Deputy Bypass Resolution (3 exclusive MCP tools)

The global monitor can approve bypass requests and deferred actions WITHOUT CTO intervention, acting as a delegated authority for routine decisions.

**3-layer identity verification** (`verifyGlobalMonitorIdentity()`):
1. `process.env.GENTYR_DEPUTY_CTO_MONITOR === 'true'` — env var injected at spawn
2. `process.env.CLAUDE_QUEUE_ID` → session-queue.db → verify `metadata.task_type === 'global_monitor'`
3. Queue item's `metadata.persistentTaskId` → persistent-tasks.db → verify persistent task has `task_type: 'global_monitor'`

All 3 layers must pass. No other session — not even another deputy-cto sub-agent — can call these tools.

**Tools (on agent-tracker server):**

| Tool | Purpose | Restrictions |
|------|---------|-------------|
| `deputy_resolve_bypass_request` | Approve/reject bypass requests without CTO | Records `resolved_by: 'deputy-cto-monitor'`. Same downstream cascade as CTO resolution (resume persistent task, propagate to plan). |
| `deputy_approve_deferred_action` | Approve + execute deferred protected actions | Blocked for CTO-only servers/tools: `release-ledger`, `set_lockdown_mode`, `sign_off_release`, `cancel_release`, `record_cto_approval`, tools with "staging" in name. |
| `deputy_escalate_to_cto` | Explicitly mark a request as needing CTO | Sets `deputy_escalated=1`, `escalation_reason`, `escalation_urgency` (routine/important/critical). Shows prominently in CTO briefing. |

**CTO-only actions** (deputy CANNOT approve):
- Any action on the `release-ledger` server
- `set_lockdown_mode`, `sign_off_release`, `cancel_release`, `record_cto_approval`
- Any tool with "staging" in the name

**DB columns** (auto-migrated in bypass-requests.db):
- `deputy_escalated` INTEGER DEFAULT 0
- `escalation_reason` TEXT
- `escalation_urgency` TEXT

---

## 54. Deputy-CTO Server (34 Tools — Complete)

### 54.1 Question Management (10 tools)
- add_question, answer_question, clear_question, read_question
- update_question, resolve_question, list_questions
- get_pending_count, search_cleared_items

### 54.2 Commit Control (3 tools)
- approve_commit, reject_commit, get_commit_decision

### 54.3 Automation Control (4 tools)
- record_cto_briefing — refreshes 24h automation gate
- get_autonomous_mode_status, toggle_autonomous_mode, set_automation_mode

### 54.4 System Bypass (7 tools)
- request_bypass, execute_bypass
- request_preapproved_bypass, activate_preapproved_bypass, list_preapproved_bypasses
- create_promotion_bypass (CTO-only: time-window for commits)

### 54.5 Protected Action Approval (5 tools)
- list_pending_action_requests, get_protected_action_request
- approve_protected_action, deny_protected_action
- check_deferred_action (agent-facing: poll status of deferred action pending CTO approval)

### 54.6 System Operations (6 tools)
- list_protections, get_merge_chain_status
- request_hotfix_promotion, execute_hotfix_promotion
- review_blocking_items, cleanup_old_records
- get_automation_config

### 54.7 Database Tables
- questions (main CTO queue: type, status, title, description, answer, recommendation)
- commit_decisions (approval/rejection with rationale)
- cleared_questions (archived)
- hotfix_requests (time-limited emergency promotions)
- spawned_tasks (audit trail)

---

## 55. Investigation-Log Server (6 tools)

### 55.1 Purpose
- Tracks hypotheses tested and solutions proven across sessions
- Prevents redundant re-investigation of same issues
- FTS5 full-text search across all logged knowledge

### 55.2 Tools
- log_hypothesis (symptom, hypothesis, test, result, conclusion: confirmed/eliminated/inconclusive)
- search_hypotheses (full-text)
- log_solution (problem, solution, files, pr_number, root_cause_tag)
- search_solutions (full-text)
- get_investigation_context (related hypotheses + solutions for current work)

---

## 56. CLAUDE.md.gentyr-section (Managed Injection)

### 56.1 Mechanism
- Template: `/CLAUDE.md.gentyr-section` (435 lines)
- Markers: `<!-- GENTYR-FRAMEWORK-START -->` / `<!-- GENTYR-FRAMEWORK-END -->`
- Injection: gentyr-sync.js (SessionStart) + cli/commands/sync.js
- Fast-path: SHA256 hash comparison against gentyr-state.json (skips if unchanged)

### 56.2 Content Injected into Target Projects
- Interactive session identity (deputy-CTO console)
- 7 golden rules for agent coordination
- Standard 7-phase development workflow
- CTO reporting guidelines
- Task priority semantics
- Protected action approval flow
- Deployment flow (merge chain)
- Slash command reference
- 19 automation toggles (including globalMonitorEnabled)
- Persona profiles
- Playwright/demo best practices
- Shared resource registry
- GENTYR-controlled file list
- Persistent tasks, audit gates, session broadcasting

### 56.3 Local Mode Transformation
- When local-mode.json enabled: strips remote service descriptions
- Prepends `[LOCAL MODE ACTIVE]` header

---

## 58. Hourly Automation — Complete Block Inventory (36 blocks)

### 58.1 Gate-Exempt Blocks (29 + 6 non-cooldown checks)
| Block | Cooldown | Feature Toggle |
|-------|----------|----------------|
| session_reviver | 10 min | — |
| session_reaper | 5 min | — |
| persistent_monitor_health | 15 min | — |
| persistent_stale_pause_resume | 5 min | — |
| rate_limit_cooldown_check | 2 min | — |
| self_heal_fix_check | 5 min | — |
| deferred_action_resume | 5 min | — |
| paused_task_triage | 10 min | — |
| global_monitor_health | 5 min | globalMonitorEnabled (default: true) |
| plan_orphan_detection | 10 min | — |
| version_watch | 5 min | — |
| triage_check | 30 min | — |
| staging_reactive_review | 60 min | stagingReactiveReviewEnabled |
| staging_health_monitor | 480 min | stagingHealthMonitorEnabled |
| production_health_monitor | 240 min | productionHealthMonitorEnabled |
| preview_promotion | 30 min | previewPromotionEnabled |
| pr_sweep | 60 min | — |
| report_auto_resolve | 2 min | — |
| report_dedup | 30 min | — |
| deploy_event_monitor | 5 min | — |
| dora_metrics_collection | 1440 min | — |
| security_audit | 10080 min | — |
| bypass_request_staleness_check | 5 min | — |
| orphan_process_reaper | varies | orphanProcessReaperEnabled |
| screenshot_cleanup | 1440 min | — |
| fly_stale_machine_cleanup | varies | — |
| stale_work_detector | 2880 min | staleWorkDetectorEnabled |
| standalone_antipattern_hunter | 1440 min | standaloneAntipatternHunterEnabled |
| standalone_compliance_checker | 720 min | standaloneComplianceCheckerEnabled |
| user_feedback | 120 min | userFeedbackEnabled |
| demo_validation | 1440 min | demoValidationEnabled |
| daily_feedback | 2880 min | dailyFeedbackEnabled |
| Non-cooldown: CI monitoring, merge chain gap, preview→staging drift, persistent alerts, urgent task dispatch, task gate stale cleanup | every cycle | — |

### 58.2 Gate-Required Blocks (6 — code-modifying work)
| Block | Cooldown | Feature Toggle |
|-------|----------|----------------|
| lint_checker | 180 min | lintCheckerEnabled |
| task_runner | 240 min | taskRunnerEnabled |
| abandoned_worktree_rescue | 30 min | abandonedWorktreeRescueEnabled |
| worktree_cleanup | 5 min | worktreeCleanupEnabled |
| stale_worktree_reaper | 20 min | staleWorktreeReaperEnabled |
| stale_task_cleanup | varies | staleTaskCleanupEnabled |

### 58.3 CTO Activity Gate
- Reads `lastCtoBriefing` from autonomous-mode.json
- If missing/invalid/>=24h old: gate CLOSED (monitoring only)
- If <24h: gate OPEN (all blocks run)
- Updated by: /deputy-cto sessions, interactive session starts
- Fail-closed: missing timestamp = gate closed

### 58.4 getCooldown() Resolution Priority
1. `automation-config.json` → `effective[key]` (dynamically adjusted)
2. `automation-config.json` → `defaults[key]` (user-configured)
3. `fallbackMinutes` parameter (per-block default)
4. Hardcoded DEFAULTS table (config-reader.js)
5. Ultimate fallback: 55 minutes

### 58.5 Execution Sequence
1. Drain session queue
2. Load config (autonomous-mode.json)
3. Check CTO gate
4. Check local mode
5. Load state (hourly-automation-state.json)
6. Recovery phase (reviver, reaper) — always runs
7. Gate-exempt phase (29 blocks)
8. CTO gate check → EXIT if closed
9. Gate-required phase (6 blocks)
10. Finalization (heartbeat audit event)

---

## 59. Deployment & Verification Systems

### 59.1 deploy-verifier.js — Post-Deploy Smoke Tests
- Polls Vercel/Render APIs for deployment completion (5 min, 15s intervals)
- HTTP health check against /api/health endpoint
- Returns: verified status, deploy ID/URL, response time

### 59.2 canary-deploy.js — Progressive Rollout (Opt-In)
- Requires canary.enabled=true in services.json
- Vercel-specific: uses `npx vercel promote` for traffic split
- Default: 10% traffic, 15-min monitoring window, 5% error threshold
- Auto-rollback if threshold exceeded

### 59.3 auto-rollback.js — Autonomous Rollback
- Triggers: deploy <5 min old + 3+ consecutive health failures + known-good deploy exists
- Vercel: `npx vercel rollback`; Render: POST deploy API
- State: deploy-tracking.json (lastKnownGood, recentDeploys, rollbackHistory)

### 59.4 dora-metrics.js — Performance Benchmarking
- Deployment Frequency (PRs merged/day)
- Lead Time (PR created → merged, hours)
- Change Failure Rate (rollbacks / deploys, %)
- MTTR (alert resolution time, minutes)
- Rating: elite/high/medium/low per 2024 benchmarks

### 59.5 environment-parity.js — Drift Detection
- Compares env var NAMES between staging/production (Vercel)
- Compares service configs (plan, region, instances) on Render
- Returns: drift array + parity boolean

### 59.6 migration-safety.js — Backward-Compatible Enforcement
- BLOCKED: DROP TABLE/COLUMN, RENAME, SET NOT NULL, ALTER TYPE
- WARNING: CREATE INDEX without CONCURRENTLY
- LLM verification (optional double-check)
- Expand/contract remediation guidance

### 59.7 vulnerability-scanner.js — Dependency Security
- Runs pnpm audit --json
- Filters by allowlist (with expiration dates)
- Returns actionable HIGH/CRITICAL vulnerabilities

### 59.8 ai-changelog.js — LLM-Generated Release Notes
- Developer changelog (technical, files/APIs)
- User changelog (plain language, features/fixes)
- Haiku-first with regex-grouping fallback

### 59.9 test-coverage-analyzer.js — Coverage Gap Analysis
- Maps source files to test files
- Risk assessment: critical (auth/payment), high (API/SQL), medium, low
- Returns gaps sorted by risk + coverage percentage

---

## 60. Preview → Staging Promotion Pipeline

### 60.1 Trigger
- `/promote-to-staging` command OR automated 30-min cycle (previewPromotionEnabled)
- Agent: preview-promoter (claude-sonnet-4-6)
- Env: GENTYR_PROMOTION_PIPELINE=true (only this agent gets this)

### 60.2 Six-Step Pipeline
1. **Assess Scope** — count commits/files; abort if >3000 lines or >80 files
2. **Migration Safety** (BLOCKS) — static analysis for destructive SQL patterns
3. **Quality Review** (BLOCKS) — hardcoded secrets, mass-disabled tests
4. **Run Tests** — full suite + 100% coverage gate (self-healing loop × 3)
5. **Run Related Demos** — feature→scenario matching by file patterns
6. **Promote** — create PR, wait CI, merge, post-deploy verify

### 60.3 100% Coverage Self-Healing Loop
- Parse uncovered files/functions from coverage report
- Create urgent task → spawn test-writer → wait completion → re-check
- Max 3 iterations; escalates to CTO after exhaustion

### 60.4 Promotion Artifacts
- Directory: `.claude/promotions/{promo-YYYYMMDD-HHmmss}/`
- Files: manifest.json, quality-review.json, test-results.json, demo-results.json, migration-safety.json, coverage-report.json, pr-details.json, report.md

---

## 61. Additional PostToolUse Hooks (Previously Uncovered)

### 61.1 ai-pr-review-hook.js
- Triggers on `gh pr create` success
- Spawns Haiku AI reviewer for security/logic/performance analysis
- Posts findings as PR comments; 5-min cooldown per PR

### 61.2 stale-demo-warning.js
- Warns when running demos haven't been polled for >2 min
- Lists stale PIDs with duration; nudges to poll or stop

### 61.3 remote-demo-hint.js
- After local headless demo: hints to drop the `local: true` flag so default Fly.io routing applies
- After display lock contention: suggests remote execution

### 61.4 demo-remote-enforcement.js
- Spawned agents with Fly.io configured: CRITICAL error if local run detected
- 2+ sequential run_demo in 10 min → enforces run_demo_batch
- Chrome-bridge scenarios exempt

### 61.5 orchestration-guidance-hook.js
- Fires on create_task; detects complexity signals (3+ conjunctions, >800 chars, etc.)
- Nudges CTO toward /plan, persistent-task, or parallel tasks
- CTO-only (spawned agents skip)

### 61.6 cto-prompt-detector.js
- On CTO prompt: writes cto-prompt-signal.json
- Finds related in-progress tasks by keyword
- Broadcasts signal to running agents (best-effort)

### 61.7 alignment-reminder.js / agent-comms-reminder.js / monitor-reminder.js
- alignment-reminder: every 20 tool calls → reminds to run user-alignment
- agent-comms-reminder: every 10 tool calls → reminds to coordinate
- monitor-reminder: every 10/30 tool calls → compact/full protocol dump

---

## 62. Show MCP Server (22 Dashboard Tools)

### 62.1 Architecture
- Spawns CTO dashboard binary with --section flag
- Renders individual metrics sections on demand
- 100-char column width for terminal display

### 62.2 Available Sections
- show_quota, show_accounts, show_deputy_cto, show_usage
- show_automations, show_testing, show_deployments, show_worktrees
- show_infra, show_logging, show_timeline, show_tasks
- show_product_market_fit, show_worklog
- show_plans, show_plan_progress, show_plan_timeline, show_plan_audit, show_plan_sessions
- show_session_queue, show_persistent_tasks, show_persistent_task_monitor

---

## 63. Plugin Manager Server (5 Tools)

### 63.1 Scope
- Only available in the gentyr repo itself (not target projects)
- Manages local plugins in plugins/ directory (gitignored)

### 63.2 Tools
- list_plugins — installed plugins with enabled status
- get_plugin_config — read plugin's config.json
- set_plugin_config — write (replace) config
- add_plugin_mapping — add per-project mapping (upsert)
- remove_plugin_mapping — remove per-project mapping

---

## 64. Total System Statistics

### 64.1 Scale
- ~38 MCP servers
- ~730+ MCP tools across all servers
- 87 hook JavaScript files
- 35 shared hook library modules
- 25 agent definitions
- 47 slash commands
- 6 persistent daemons (launchd KeepAlive)
- 36 automation blocks (29 gate-exempt + 6 gate-required + 1 hourly tasks)
- 18 feature toggles
- 16+ SQLite databases
- 25+ JSON state files
- 4 CI/CD workflow templates
- 8 root-owned enforcement hooks
- 67 hook unit tests
- ~17 MCP server test suites

---

## 65. Hierarchical Pause Propagation (Complete Chain)

### 65.1 The Full Pause Chain (Agent → Task → Persistent Task → Plan)

```
Agent calls submit_bypass_request(task_type, task_id, category, summary, details)
  │
  ▼
agent-tracker handler (server.ts):
  1. Validates task exists (persistent-tasks.db or todo.db)
  2. Creates bypass_request record in bypass-requests.db
  3. Pauses the task:
     - Persistent task: status → 'paused', event: reason='cto_bypass_request'
     - Todo task: status → 'pending' (blocks spawning via bypass guard)
  4. Calls propagatePauseToPlan(task_id, summary, requestId)
  5. Returns instructions: "summarize_work and exit immediately"
  │
  ▼
propagatePauseToPlan() (lib/pause-propagation.js):
  1. Reads persistent task metadata for plan_task_id + plan_id
  2. Updates plan_tasks row: status → 'paused'
  3. Records state_change in plans.db
  4. Assesses impact:
     - Downstream dependencies blocked?
     - Is this in a gate phase?
     - Parallel work still available?
  5. Determines blocking_level: 'task' | 'persistent_task' | 'plan'
  6. If blocking_level='plan': auto-pauses entire plan
  7. Creates blocking_queue entry (CTO visibility):
     - blocking_level, impact_assessment, summary, status='active'
  │
  ▼
persistent-task-spawner.js detects pause event:
  1. Calls propagatePauseToPlan() again (belt-and-suspenders)
  2. Does NOT spawn new monitor session
  3. Emits persistent_task_paused audit event
  │
  ▼
stop-continue-hook.js (when agent tries to stop):
  1. Checks persistent task status
  2. If task paused → guides agent: "use submit_bypass_request, then summarize_work"
  3. Plan-manager escape hatch: if task paused/completed/cancelled → allow exit
  │
  ▼
persistent-monitor (if already running for this task):
  1. Calls inspect_persistent_task() on each cycle
  2. Sees status='paused'
  3. Stops spawning new child tasks
  4. Monitors existing in-progress children until they complete
  │
  ▼
plan-manager (if running for the parent plan):
  1. Calls get_plan_blocking_status() on each cycle
  2. Returns: fully_blocked, partially_blocked, paused_tasks, parallel_work
  3. If fully_blocked: waits for CTO resolution
  4. If partially_blocked: continues unblocked parallel work
```

### 65.2 The Resume Chain (CTO Resolves → Cascade Down)

```
CTO calls resolve_bypass_request(request_id, decision='approved', context='...')
  │
  ▼
agent-tracker handler:
  1. Updates bypass_request: status → 'approved', resolution_context
  2. For persistent tasks: status → 'active'
  3. Enqueues new monitor at 'critical' priority with CTO context
  │
  ▼
persistent-task-spawner.js fires on resume:
  1. Calls propagateResumeToPlan(persistentTaskId)
  2. Enqueues monitor session in persistent lane
  │
  ▼
propagateResumeToPlan() (lib/pause-propagation.js):
  1. Updates plan_task: status → 'in_progress'
  2. Checks if other plan tasks still paused
  3. If none paused → resumes plan (status → 'active')
  4. Resolves blocking_queue entries (status → 'resolved')
  │
  ▼
New monitor spawns with CTO approval context injected into prompt
```

### 65.3 Where the CTO Sees Blocking State
- **Session briefing**: `=== WORK BLOCKED — CTO ACTION REQUIRED ===` section
- **cto-notification-hook**: Status line shows `N BLOCKING` prefix
- **Bypass requests section**: `=== CTO BYPASS REQUESTS AWAITING DECISION ===`
- **/monitor** command: Shows blocking state in real-time
- **CTO Dashboard Page 3**: Plan view shows paused tasks with audit info

---

## 66. CTO Escalation Paths (4 Independent Mechanisms)

### 66.1 Path 1: submit_bypass_request (Agent → CTO Direct)
- **Who calls it**: Any agent blocked by access, authorization, or resource constraints
- **What it does**: Pauses task + propagates to plan + creates blocking_queue entry
- **CTO action**: `resolve_bypass_request(id, decision, context)`
- **Effect of approval**: Task resumes, monitor re-enqueues at critical priority

### 66.2 Path 2: report_to_deputy_cto (Agent → Triage → Maybe CTO)
- **Who calls it**: Any agent discovering an issue (code quality, security, architecture)
- **What it does**: Creates report in cto-reports.db (triage_status='pending')
- **Deputy-CTO triage decisions**:
  - `self_handled` → spawns fix task (no CTO involvement)
  - `dismissed` → archived, no action
  - `escalated` → adds question to deputy-cto.db CTO queue
- **Auto-escalation rules** (no deputy discretion):
  - G002 violations (stub code, placeholders)
  - Security vulnerabilities
  - Bypass requests
- **CTO action**: `answer_question(id, answer)` + `clear_question(id)`

### 66.3 Path 3: Deputy-CTO Question Queue (Deputy → CTO)
- **Types**: escalation, decision, approval, rejection, question, bypass-request, protected-action-request
- **Deputy-CTO can create questions directly** via `add_question()`
- **Questions block**: pending questions can block commits (G020 pre-commit check)
- **CTO action**: answer + clear

### 66.4 Path 4: Protected Action Deferred Approval (System → CTO)
- **Who triggers**: protected-action-gate.js PreToolUse hook (spawned agents)
- **What it does**: Stores exact tool call (server, tool, args) with HMAC signatures
- **CTO sees**: `=== DEFERRED PROTECTED ACTIONS AWAITING APPROVAL ===` in briefing
- **CTO action**: Types `APPROVE <phrase> <code>` → system executes tool call via MCP daemon

### 66.5 Decision Framework (Deputy-CTO Triage)
| Condition | Decision |
|-----------|----------|
| G002 violation (stubs/placeholders) | AUTO-ESCALATE |
| Security vulnerability | AUTO-ESCALATE |
| Bypass request | AUTO-ESCALATE |
| <70% confident + high-severity | ESCALATE |
| >70% confident + not high-severity | SELF-HANDLE |
| Already resolved / duplicate / low-impact | DISMISS |

---

## 67. Agent Self-Pause Mechanisms (3 Ways to Pause)

### 67.1 submit_bypass_request (Recommended)
- Agent calls when genuinely blocked (access, authorization, resources)
- Pauses task, propagates to plan, creates blocking_queue
- Agent MUST then summarize_work and exit
- CTO resolves → task resumes with context

### 67.2 pause_persistent_task (Direct, Monitor Only)
- Persistent monitors can call directly
- Triggers persistent-task-spawner.js → propagatePauseToPlan()
- Does NOT create bypass request (CTO visibility is lower)
- Used for self-pause when monitor determines it cannot proceed

### 67.3 Self-Pause Circuit Breaker (Automatic)
- If monitor pauses 2+ times in 2 hours → do_not_auto_resume flag set
- Prevents infinite wake-pause-wake loop
- CTO must manually resolve

### 67.4 Supersession Protocol (cancel, not pause)
- When scope_change amendment indicates task is superseded
- Monitor must call cancel_persistent_task (not pause)
- Pausing a superseded task creates infinite cycle (stale-pause auto-resume keeps waking it)

---

### 64.2 Vendor Integrations (12)
GitHub, Cloudflare, Supabase, Vercel, Render, Codecov, Resend, Elastic Cloud, 1Password, Fly.io, Steel.dev, Stripe (via target project)

### 64.3 Key Metrics
- Session concurrency: configurable 1-50 (default 10)
- Priority levels: 5 (cto > critical > urgent > normal > low)
- Session lanes: 6 (standard, persistent, gate, audit, alignment, revival)
- Enforcement layers: 3 (guidance, orchestration, enforcement)
- Release phases: 8 (with 4 mandatory gates)
- Promotion steps: 6 (with migration safety + 100% coverage gates)
- Revival mechanisms: 8 (overlapping for redundancy)
- Circuit breaker: dual-layer (in-memory 3/10min + DB 5/hour)

---

## 57. State Files Inventory (Complete)

### 57.1 SQLite Databases (10+)
- todo.db — task lifecycle, categories, worklog
- deputy-cto.db — questions, commit decisions, bypasses
- cto-reports.db — agent report triage queue
- user-feedback.db — personas, features, scenarios, prerequisites, profiles, demo_results
- session-queue.db — centralized session queue
- session-activity.db — LLM-generated session summaries
- session-events.db — MCP tool call audit trail
- display-lock.db — shared resource locks
- live-feed.db — AI commentary entries
- bypass-requests.db — bypass requests + blocking queue + deferred actions
- persistent-tasks.db — persistent task state + blocker_diagnosis
- plans.db — plan orchestrator state
- workstream.db — queue dependencies
- release-ledger.db — production release evidence
- product-manager.db — PMF analysis state
- worklog.db — task execution metrics

### 57.2 JSON State Files (25+)
- autonomous-mode.json — 18 feature toggles
- automation-config.json — 55+ cooldown parameters
- hourly-automation-state.json — last-run timestamps
- automation-rate.json — automation rate preset (none/low/medium/high, default: low)
- focus-mode.json — DEPRECATED (automation-rate.json supersedes)
- local-mode.json — local prototyping mode
- staging-lock.json — production release lock
- port-allocations.json — per-worktree port blocks
- gentyr-state.json — version, config hash, CLAUDE.md hash
- fly-machine-config.json — per-mode RAM settings
- protection-state.json — critical hooks list
- sync-state.json — last sync timestamp + version
- agent-progress/<agent-id>.json — pipeline stage tracking
- session-comms.log — inter-agent signal audit trail
- session-audit.log — session lifecycle events
- compact-tracker.json — compaction event tracking

---
