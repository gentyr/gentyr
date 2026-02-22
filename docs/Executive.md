# GENTYR: Autonomous AI Engineering Team
**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

## The Problem

AI coding agents hallucinate, cut corners, and make autonomous decisions that undermine code quality. Without governance, they'll disable tests, leave placeholder code, and drift from requirements—all while appearing to work. GENTYR transforms Claude from an unreliable assistant into a managed engineering team with human oversight.

---

## 6 Key Challenges & Solutions

### 1. Hallucinated Code
- **Problem**: AI writes code that appears functional but contains stubs, mocks, or random number generators masquerading as real implementations.
- **Solution**: Spec enforcement prohibits placeholder code; commit review gate and code reviewer agent reject incomplete implementations.

### 2. Quality Sabotage
- **Problem**: To achieve goals faster, AI disables tests, weakens linting rules, or skips verification steps.
- **Solution**: Critical config files are root-owned (immutable to agents); hooks block any attempt to bypass verification.

### 3. Context Fragmentation
- **Problem**: Different tasks require different expertise, but a single agent can't be expert at everything.
- **Solution**: 8 specialized agents with domain-optimized prompts; task routing sends work to the right specialist.

### 4. Specification Drift
- **Problem**: Without persistent requirements tracking, features drift from intent over multiple sessions.
- **Solution**: Specs directory persists across sessions; all agents query specs before implementing; compliance checker enforces mappings.

### 5. Attention Bandwidth
- **Problem**: Human can only actively monitor 2-3 sessions while background issues accumulate.
- **Solution**: Hourly automation handles routine tasks; CTO notification hook shows status on every prompt; issues queue for batch review.

### 6. Autonomous Overreach
- **Problem**: Background agents making critical decisions without human input creates risk.
- **Solution**: Deputy-CTO escalates ambiguous cases; critical decisions wait for human input; only humans can authorize emergency bypasses.

---

## Capability Inventory

| Capability | What It Does & Why It Matters |
|------------|-------------------------------|
| **Commit Approval Gate** | Every commit requires deputy-cto review before merge, preventing broken or malicious code from entering the codebase. |
| **Specification Enforcement** | Antipattern hunters scan code against project specs, catching violations before they compound. |
| **Multi-Agent Specialization** | 8 specialized agents ensure each task gets domain expertise rather than generalist guessing. |
| **Task Orchestration** | Cross-agent todo system coordinates work across sessions, preventing duplicate effort and dropped tasks. |
| **CTO Escalation Queue** | Agents bubble up questions and decisions to human CTO rather than guessing wrong. |
| **Emergency Bypass** | Human-only approval mechanism for urgent situations, cryptographically tied to user input. |
| **Background Automation** | Hourly task runner handles lint fixes, report triage, and plan execution without human prompting. |
| **API Quota Management** | Multi-key rotation and usage optimization prevents quota exhaustion mid-task. |
| **Audit Trail** | Every agent spawn, decision, and task completion is logged for accountability. |
| **Framework Separation** | GENTYR installs as symlinks, keeping framework code separate from project code. |

---

## Architecture

```
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│      GENTYR FRAMEWORK            │      │       YOUR PROJECT               │
│      (central repo)              │      │       (any repo)                 │
│                                  │      │                                  │
│  packages/                       │      │  src/                            │
│   └─ mcp-servers/                │      │  tests/                          │
│       ├─ todo-db                 │      │  specs/                          │
│       ├─ deputy-cto              │      │  CLAUDE.md                       │
│       ├─ specs-browser           │      │                                  │
│       └─ ...                     │      │  .claude/                        │
│                                  │      │   ├─ agents/ ←───────────────────┼──── symlink
│  .claude/                        │      │   ├─ hooks/ ←────────────────────┼──── symlink
│   ├─ agents/   ─────────────────────────┼───→                              │
│   ├─ hooks/    ─────────────────────────┼───→                              │
│   └─ skills/   ─────────────────────────┼───→ skills/ ←────────────────────┼──── symlink
│                                  │      │   │                              │
│                                  │      │   └─ LOCAL DATA (not symlinked)  │
│                                  │      │       ├─ todo.db                 │
│                                  │      │       ├─ deputy-cto.db           │
│                                  │      │       └─ reports.db              │
└──────────────────────────────────┘      └──────────────────────────────────┘

         SHARED CODE                              PROJECT STATE
    (update once, all projects                (isolated per project,
     get changes automatically)                never shared)
```

**How it works:**
1. Install GENTYR once on your machine
2. Run install script in any project → creates symlinks to GENTYR's agents, hooks, and skills
3. Claude Code in that project now uses GENTYR's governance
4. Each project maintains its own databases (tasks, decisions, reports)

### MCP Servers (9 Tool APIs)
- **todo-db** - Task tracking and cross-agent coordination
- **deputy-cto** - Decision queue and approval management
- **agent-reports** - Escalation and issue reporting
- **specs-browser** - Specification lookup and compliance queries
- **review-queue** - Code review tracking and status
- **agent-tracker** - Agent spawn monitoring and audit trail
- **session-events** - Session lifecycle and state management
- **cto-report** - Executive status dashboard and metrics
- **cto-reports** - Historical report storage and retrieval

### Specialized Agents (8 Domain Experts)
- **investigator** - Root cause analysis and debugging
- **code-writer** - Implementation with spec compliance
- **test-writer** - Test coverage and validation
- **code-reviewer** - Pre-commit quality review
- **project-manager** - Task coordination and prioritization
- **deputy-cto** - Escalation filtering and CTO briefings
- **antipattern-hunter** - Spec violation detection
- **repo-hygiene-expert** - Architecture and dead code analysis

### Automation Hooks (15 Event Handlers)
- **pre-commit-review** - Triggers deputy-cto review before commits
- **block-no-verify** - Prevents git hook bypass attempts
- **compliance-checker** - Scans code against spec mappings
- **antipattern-hunter-hook** - Detects spec violations on file changes
- **cto-notification-hook** - Displays status on every prompt
- **hourly-automation** - Background task execution
- **api-key-watcher** - Quota monitoring and key rotation
- **usage-optimizer** - API cost optimization
- **agent-tracker** - Logs all agent spawns
- **plan-executor** - Runs approved implementation plans
- **todo-maintenance** - Task list cleanup and updates
- **bypass-approval-hook** - Emergency bypass authorization
- **mapping-validator** - Spec-to-code mapping verification
- **schema-mapper-hook** - Automatic spec mapping suggestions
- **config-reader** - Centralized configuration access

---

## Protection Model

Critical hooks are root-owned, making them immutable to AI agents. Only human CTO can:

- Approve emergency bypasses
- Modify commit review logic
- Disable protections

This creates a trust hierarchy where agents operate within boundaries they cannot modify.

---

## CTO Status Dashboard (`/cto-report`)

The `/cto-report` command launches an Ink-based (React for CLIs) dashboard that provides real-time visibility into the entire GENTYR system. Features include:

- **Rounded corner containers** using Ink's `borderStyle: 'round'`
- **Color-coded quota bars** (green/yellow/red based on usage)
- **Account overview section** with per-account quota bars (5h, 7d, 7d-sonnet), status indicators, subscription types, and 24h rotation event timeline
- **Usage trend line graphs** showing 5h and 7d history with trajectory forecast overlay
- **Usage trajectory projections** with linear regression
- **Testing health section** with 42-bucket activity graph (4h resolution), Codecov sparkline, agent framework breakdown
- **Deployments section** with 3-stage pipeline header, per-platform deploy tables (Render/Vercel, 5 entries each), combined deploy timeline, and DeployStats footer (success rate, failure count, frequency)
- **Infrastructure health section** with 5-provider status dots (Render, Vercel, Supabase, Elasticsearch, Cloudflare), per-platform event tables, Cloudflare nameservers, and load metrics
- **Logging section** with Elasticsearch log volume timeseries graph, level/service bar charts, top errors/warnings tables, source coverage assessment dots, and storage estimates
- **Automated instances table** with 24h run counts, time-until-next, frequency adjustments, and token usage bar chart by automation type
- **Chronological timeline** of all system activity
- **Metrics summary grid** with nested boxes

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ GENTYR CTO DASHBOARD                                        Period: Last 24h │
│ Generated: 2026-01-23 16:45                                                  │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────╮ ╭──────────────────────────────────╮
│ QUOTA & CAPACITY (3 keys)        │ │ SYSTEM STATUS                    │
│ 5-hour   ████████░░░░░░░░  45%   │ │ Deputy CTO: ENABLED  (in 15m)    │
│ 7-day    ██████░░░░░░░░░░  38%   │ │ Protection: PROTECTED            │
│ Rotations (24h): 2               │ │ Commits:    ALLOWED              │
╰──────────────────────────────────╯ ╰──────────────────────────────────╯

╭────────────────────────────────────────────────────╮
│ USAGE TRENDS                                       │
│ 5-Hour Usage (30 snapshots, 5h ago to now)         │
│                          ▁▁▁▁▁▁▁▃▃▃▃▃▃▆▆▆▆▆▆██████ │
│              ▁▁▁▁▁▁▄▄▄▄▄▄█████████████████████████ │
│        ▃▃▃▃▃▃█████████████████████████████████████ │
│ Current: 45%  Min: 12%  Max: 45%                   │
│                                                    │
│ 7-Day Usage                                        │
│                                 ▁▁▁▁▁▁▅▅▅▅▅▅██████ │
│                    ▂▂▂▂▂▂▆▆▆▆▆▆▆██████████████████ │
│        ▃▃▃▃▃▃▇▇▇▇▇▇███████████████████████████████ │
│ Current: 38%  Min: 8%  Max: 38%                    │
╰────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────╮
│ USAGE TRAJECTORY                                                     │
│ 5-Hour Window                       7-Day Window                     │
│  ├─ Current:     45%                 ├─ Current:     38%             │
│  ├─ At Reset:    72% ↑               ├─ At Reset:    52% ↑           │
│  ├─ Reset In:    2h 15m              ├─ Reset In:    3d 4h           │
│  └─ Trend:       +5.4%/hr ↑          └─ Trend:       +2.1%/day ↑     │
│                                                                      │
│ Projection Method: Linear regression on last 30 snapshots            │
╰──────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ AUTOMATED INSTANCES                                                          │
│ Type                  Runs (24h)  Next Run      Delta       Freq Adj         │
│ ──────────────────────────────────────────────────────────────────────────── │
│ CLAUDE.md Refactor    3           in 42m       +5m34s      +15% slower       │
│ Todo Maintenance      8           in 18m       -2m10s      -10% faster       │
│ Plan Executor         2           in 1h 05m    +12m00s     +25% slower       │
│ Antipattern Hunter    4           in 55m        —          baseline          │
│ Triage Check          24          in 3m         —          baseline          │
│ Lint Checker          6           in 12m        —          baseline          │
│ ──────────────────────────────────────────────────────────────────────────── │
│ Pre-Commit Hook       12          on commit     —           —                │
│ Test Suite            1           on failure    —           —                │
│ Compliance Checker    5           on change     —           —                │
│                                                                              │
│ Usage Target: 90%  |  Current Projected: 87%  |  Adjusting: ↑ intervals      │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ TIMELINE (24h)                                                               │
│ 16:42  ● HOOK  pre-commit-review                                             │
│         └─ deputy-cto-review: "Review commit abc123"                         │
│                                                                              │
│ 16:30  ◆ REPORT  Security concern [HIGH]                                     │
│         └─ From: code-reviewer | Status: escalated                           │
│                                                                              │
│ 16:15  ○ SESSION  5b420f2c...                                                │
│         └─ User session (manual)                                             │
│                                                                              │
│ 15:45  ■ TASK  Implement login flow                                          │
│         └─ Section: CODE-REVIEWER                                            │
╰──────────────────────────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────────────────────╮
│ METRICS SUMMARY                                                              │
│ ╭──────────────╮ ╭──────────────╮ ╭──────────────╮ ╭──────────────╮          │
│ │ Tokens       │ │ Sessions     │ │ Agents       │ │ Tasks        │          │
│ │ In: 2.4M     │ │ Task: 47     │ │ Spawns: 12   │ │ Pending: 3   │          │
│ │ Out: 890K    │ │ User: 12     │ │ Types: 5     │ │ Active: 1    │          │
│ │ Cache: 83%   │ │ Total: 59    │ │              │ │ Done: 28     │          │
│ ╰──────────────╯ ╰──────────────╯ ╰──────────────╯ ╰──────────────╯          │
│                                                                              │
│ ╭───────────────╮ ╭──────────────╮ ╭───────────────╮ ╭──────────────╮        │
│ │ Hooks (24h)   │ │ Triage       │ │ CTO Queue     │ │ Cooldowns    │        │
│ │ Total: 156    │ │ Pending: 0   │ │ Questions: 2  │ │ Factor: 1.2x │        │
│ │ Success: 94%  │ │ Handled: 12  │ │ Rejections: 1 │ │ Target: 90%  │        │
│ │ Failures: 2   │ │ Escalated: 3 │ │ Triage: 0     │ │ Proj: 87%    │        │
│ ╰───────────────╯ ╰──────────────╯ ╰───────────────╯ ╰──────────────╯        │
╰──────────────────────────────────────────────────────────────────────────────╯
```

### Timeline Event Icons

| Icon | Type | Source |
|------|------|--------|
| ● | HOOK | Agent spawned by hook (agent-tracker) |
| ◆ | REPORT | CTO report submitted (cto-reports.db) |
| ◇ | QUESTION | CTO question created (deputy-cto.db) |
| ■ | TASK | Task completed (todo.db) |
| ○ | SESSION | Claude Code session (JSONL files) |

### Dashboard Sections Explained

#### Account Overview
- **Purpose**: Per-account credential health monitoring and rotation event tracking
- **Shows**:
  - Per-account table with truncated key IDs, status (active/exhausted/expired/invalid), subscription type, email, and expiry date
  - Current account marked with `*` prefix and cyan highlighting
  - Per-key quota bars: 5h, 7d, and conditional 7d-sonnet (only displayed if >10pp difference from 7d aggregate)
  - Event timeline (last 24h, max 20 events) with color-coded event types: key_switched (cyan), key_exhausted (red), key_added (green), key_removed (yellow)
  - Rotation count in section title
- **Data Source**: `~/.claude/api-key-rotation.json` (maintained by key-sync.js)
- **Key Features**:
  - Accounts sorted: current first, then by status priority, then by added date (newest first)
  - Event descriptions auto-generated from rotation log entries (key_added, key_switched, key_exhausted, key_removed, token_refreshed)
  - Noisy health_check events filtered from timeline
  - 7d-sonnet quota bar conditional rendering reduces clutter when Sonnet usage closely matches aggregate
- **Graceful Degradation**: Section hidden when api-key-rotation.json missing or empty

#### Usage Trends
- **Purpose**: Visualize API quota consumption history using high-resolution line graphs
- **Data Source**: `.claude/state/usage-snapshots.json` (collected by usage-optimizer every 10 minutes)
- **Shows**:
  - **5-Hour Usage Chart**: Historical line graph with current, min, and max values
  - **7-Day Usage Chart**: Historical line graph with current, min, and max values
  - **Trajectory Forecast Chart**: Combined visualization showing history (left side) transitioning to linear projections (right side) for both windows, with 90% target line overlay
- **X-Axis Labels**: Forecast chart displays "[timeAgo] → now → reset: Xh" to visually separate historical data from projections
- **Graceful Degradation**: Section hides when no snapshot data available; forecast chart only renders when projection data exists

#### Usage Trajectory
- **Purpose**: Project future API usage at reset time using trend analysis
- **Algorithm**: Linear regression on last 30 snapshots
- **Shows**:
  - Current % - Current aggregate usage across all keys
  - At Reset % - Projected usage when quota resets (with trend arrow)
  - Reset In - Time remaining until quota reset
  - Trend - Rate of change (% per hour for 5h, % per day for 7d)
- **Note**: This text-based projection section complements the visual Trajectory Forecast chart in Usage Trends

#### Testing Health
- **Purpose**: Monitor test suite health, agent coverage, and activity trends
- **Shows**:
  - Failing suites with fix attempt counts and resolution status
  - Agent breakdown by test framework (jest, vitest, playwright)
  - **42-bucket activity graph** (4h resolution, ~7-day window) rendered as LineGraph — replaces old 7-day sparkline
  - Codecov coverage sparkline (when credentials available)
  - Unique failure count and resolved suites in last 24h
- **Data Source**: `testing-reader.ts` — aggregates test failure events from agent-tracker database and Codecov API

#### Deployments
- **Purpose**: Live deployment status for Render and Vercel platforms with pipeline visibility
- **Shows**:
  - PipelineDetail header: 3-stage pipeline (preview → staging → production) with timestamps for each stage
  - Per-platform deploy tables: Render and Vercel each show 5 most recent deploys (service, status, age, commit message)
  - Combined recent deploy timeline (newest first, up to 8 entries from both platforms, with platform badge)
  - DeployStats footer: total deploys, success rate, failure count, and deploy frequency
  - Pipeline promotion state: last preview/staging check and last promotion timestamp
- **Data Source**: `deployments-reader.ts` — parallel Render and Vercel API calls, all via `Promise.allSettled` with 10s timeouts; `lastPreviewCheck`, `lastStagingCheck`, and stats computed from deploy history
- **Graceful Degradation**: Section hidden when neither `RENDER_API_KEY` nor `VERCEL_TOKEN` available

#### Infrastructure Health
- **Purpose**: At-a-glance operational status across 5 infrastructure providers with event-level detail
- **Providers**: Render, Vercel, Supabase, Elasticsearch, Cloudflare — each independently degradable
- **Shows**:
  - Per-provider status dot (green = healthy, red = unavailable)
  - Render: service count, suspended count, and last deploy timestamp
  - Vercel: project count, error deploy count (24h), and currently-building count
  - Supabase: API reachability health check
  - Cloudflare: plan name, zone status, and nameserver list
  - Per-platform event tables (Render deploy events, Vercel deployment events)
  - Note: Elasticsearch log detail moved to dedicated LOGGING section
- **Data Source**: `infra-reader.ts` — 5 concurrent provider queries, independent failure isolation; accepts optional `deployments` prop to avoid duplicate API calls
- **Credential fix**: `CF_API_TOKEN` corrected to `CLOUDFLARE_API_TOKEN`
- **Graceful Degradation**: Section hidden when no providers return data

#### Logging
- **Purpose**: Centralized log observability from Elasticsearch covering volume, errors, coverage, and cost
- **Shows**:
  - Log volume timeseries line graph (24 hourly data points)
  - Summary stats: total logs (24h and 1h), error count, warning count
  - By Level bar chart: breakdown of log levels (error, warn, info, debug) with color coding
  - By Service bar chart: top 8 services by log volume
  - Top Errors table: 5 most frequent error messages with service attribution and occurrence count
  - Top Warnings table: 5 most frequent warning messages with service attribution and occurrence count
  - Source Coverage dots: 9 expected sources (api, worker, deployment, ci-cd, testing, database, cdn, auth, cron) assessed as active (green), low-volume (yellow), or missing (gray)
  - Storage footer: estimated daily GB, monthly cost estimate, and index count
- **Data Source**: `logging-reader.ts` — Elasticsearch queries for volume timeseries, level/service/source breakdowns, top errors/warnings, and `_cat/indices` for storage; `ELASTIC_API_KEY` credential required; endpoint resolved via `resolveElasticEndpoint()` which tries `ELASTIC_ENDPOINT` first then decodes `ELASTIC_CLOUD_ID` (base64 Cloud ID format) as fallback
- **Field Mapping Note**: All terms aggregations use `.keyword` suffix (e.g., `level.keyword`, `service.keyword`) to support Elastic Serverless deployments where these fields are mapped as `text` type
- **Storage Fallback**: When `_cat/indices` returns 403 (read-only API key lacks monitor privilege), storage is estimated from document count instead
- **Graceful Degradation**: Section hidden when no log data available (`hasData: false`)

#### Automated Instances
- **Purpose**: Monitor all automated Claude triggers with frequency adjustment visibility
- **Columns**:
  - Type - Automation name (Pre-Commit Hook, CLAUDE.md Refactor, etc.)
  - Runs (24h) - Execution count from agent-tracker
  - Next Run - Countdown or trigger type ("on commit", "on failure")
  - Delta - Difference from baseline interval (+5m34s, -2m10s)
  - Freq Adj - Percentage slower/faster from usage optimizer (+15% slower)
- **Footer**: Shows usage target, current projected %, and adjusting direction (↑↓→)

### Key Metrics Explained

- **Quota & Capacity** - Aggregate usage across all API keys; shows rotation count if using multi-key
- **System Status** - Deputy CTO mode, file protection status, commit gate status
- **Timeline** - Chronological view of the 20 most recent events across all data sources
- **Tokens** - Input/output token counts with cache hit rate (higher = better context reuse)
- **Sessions** - Task-triggered (automated) vs user-triggered (manual) session counts
- **Agents** - Specialized agent spawn counts by type
- **Tasks** - Cross-session task pipeline status
- **Hooks** - Automation hook execution success rate
- **Triage** - Deputy-CTO triage activity (self-handled vs escalated)
- **CTO Queue** - Items awaiting human decision (blocks commits when non-empty)
- **Cooldowns** - Usage projection and dynamic cooldown factor
