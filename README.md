# GENTYR

**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

An opinionated AI engineering team for solo CTOs.

GENTYR turns Claude Code into a full engineering team that builds new SaaS products from scratch on a fixed TypeScript stack. You make the product decisions. Claude Code writes the code, tests it, reviews it, and ships it — governed by automation so the AI stays on rails and you stay in control.

## Who This Is For

- Solo founder or CTO building a new SaaS product
- Going from zero to production without hiring an engineering team
- Willing to adopt an opinionated, non-negotiable stack (see below)
- Want Claude Code as an engineering team, not just autocomplete
- **Not** for adopting into existing codebases — GENTYR builds new projects from the ground up

## The Stack

### Application

| Technology | Role |
|---|---|
| TypeScript (strict, ESM) | Language |
| Next.js on Vercel | Frontend |
| Hono on Render | Backend API |
| Supabase | PostgreSQL + Auth + Storage + RLS |
| Zod | Runtime validation |

### Infrastructure

| Technology | Role |
|---|---|
| pnpm monorepo | Package management |
| GitHub + Actions | Source control + CI/CD |
| 1Password | Secrets (`op://` references, zero on disk) |
| Cloudflare | DNS |
| Elastic Cloud | Centralized logging |
| Resend | Transactional email |
| Codecov | Coverage reporting |

### Testing

| Technology | Role |
|---|---|
| Vitest | Unit + integration tests |
| Playwright | E2E + browser tests |

This stack is not configurable. GENTYR's 30 MCP servers, 9 agents, and 32 hooks are built specifically for these tools. If you want a different database or hosting provider, this is not for you.

## Quick Start

```bash
git clone git@github.com:gentyr/gentyr.git
sudo gentyr/scripts/setup.sh --path /path/to/project --protect
```

Start Claude Code in your project, run `/setup-gentyr` to configure credentials, then `/restart-session`. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for details.

## What You Get

GENTYR replaces an engineering team with specialized AI agents — investigators, code writers, test writers, reviewers, and a deputy CTO — all governed by automation so you only step in for the decisions that matter.

- **Commit approval gate** -- every commit reviewed by deputy-CTO agent before it lands
- **Specialized agents** -- 9 agents in a fixed workflow: investigate, write, test, review, ship
- **Zero secrets on disk** -- credentials resolve from 1Password at runtime; only `op://` references stored
- **Background task runner** -- spawns agents for pending TODOs on a timer; you set direction, agents execute
- **AI user feedback** -- persona-based testing (GUI/CLI/API/SDK) triggered by staging changes
- **Usage optimizer** -- dynamically adjusts spawn rates to target 90% API quota utilization
- **Automatic session recovery** -- quota-interrupted sessions auto-resume after credential rotation; no lost work
- **Real-time dashboard** -- CLI status bar and VS Code extension with quota, agents, and infrastructure health
- **Protection model** -- critical files root-owned; agents cannot modify the rules they operate under

## How It Works

```
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│      GENTYR FRAMEWORK            │      │       YOUR PROJECT               │
│      (central repo)              │      │       (any repo)                 │
│                                  │      │                                  │
│  packages/                       │      │  src/                            │
│   └─ mcp-servers/                │      │  tests/                          │
│       ├─ todo-db                 │      │  specs/                          │
│       ├─ deputy-cto              │      │  CLAUDE.md                       │
│       └─ ...                     │      │                                  │
│                                  │      │  .claude/                        │
│  .claude/                        │      │   ├─ agents/ ←──────────────────┼── symlink
│   ├─ agents/   ──────────────────────────┼──→                              │
│   ├─ hooks/    ──────────────────────────┼──→ hooks/ ←────────────────────┼── symlink
│   └─ skills/   ──────────────────────────┼──→ skills/ ←───────────────────┼── symlink
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

GENTYR installs as symlinks into your project's `.claude/` directory. The framework code is shared across projects; runtime state (databases, config) is isolated per project. One installation serves many repositories.

The agent workflow follows a fixed sequence: investigator, code-writer, test-writer, code-reviewer, project-manager. Each agent has domain-specific prompts and restricted tool access. The deputy-CTO agent gates commits and escalates ambiguous decisions to you.

## CTO Dashboard

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
     ╭──────────────────────────────────────────────────────────────────────────────╮
     │ GENTYR CTO DASHBOARD                                        Period: Last 24h │
     │ Generated: 2026-02-18 16:01                                                  │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ QUOTA & CAPACITY (1 key) ──────────╮ ╭─ SYSTEM STATUS ──────────────────────╮
     │ 5-hour   ██████░░░░░░░░░░  35%      │ │ Deputy CTO: ENABLED                  │
     │ 7-day    ██████████████░░  88%      │ │   Runs every 50m | Next4:04P (3m30s) │
     │ Rotations (24h): 2                  │ │                                      │
     │                                     │ │ Protection: PROTECTED                │
     │                                     │ │ Commits:    BLOCKED                  │
     ╰─────────────────────────────────────╯ ╰──────────────────────────────────────╯
     
     ╭─ ACCOUNT OVERVIEW (3 accounts | 2 rotations 24h) ────────────────────────────╮
     │ * a3f8d21c...  active     claude_max   dev@gentyr.io  Exp: 2026-02-19        │
     │   5h     ████░░░░░░░  35    7d     ██████████░  88   7d-son ██░░░░░░░░░  17% │
     │                                                                              │
     │   b7c4e92f...  exhausted  claude_max   ops@gentyr.io  Exp: 2026-02-21        │
     │   5h     ███████████ 100    7d     ███████████ 100   7d-son ███░░░░░░░░  22% │
     │                                                                              │
     │   c9d5f13a...  active     claude_max   backup@gentyr.io  Exp: 2026-02-23     │
     │   5h     █░░░░░░░░░░  12    7d     █████░░░░░░  45   7d-son █░░░░░░░░░░   8% │
     │                                                                              │
     │                                                                              │
     │   EVENT HISTORY (last 24h)                                                   │
     │   3:23PM  Switched to a3f8d21c... (quota_monitor_95pct)                      │
     │   2:49PM  Account b7c4e92f... exhausted                                      │
     │   1:31PM  Token refreshed for a3f8d21c...                                    │
     │  11:55AM  Switched to b7c4e92f... (switched_from_c9d5f13a)                   │
     │  10:13AM  New account added: c9d5f13a...                                     │
     │   7:43AM  Token expired for d2e6a47b...                                      │
     │   4:19AM  Switched to a3f8d21c... (scheduled_rotation)                       │
     │   1:49AM  Token refreshed for b7c4e92f...                                    │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
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
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ USAGE TRENDS ───────────────────────────────────────────────────────────────╮
     │ 5-Hour Usage (1019 snapshots, 1d ago to now)                                 │
     │ 100│    ⎽─⎻─⎽                                                                │
     │  75│  ⎽⎻     ⎺⎻⎽                ⎽⎼⎼⎼⎽     ⎽⎼⎼                                │
     │  50│─⎻          ⎺⎼⎽          ⎼─⎻     ⎺⎻──⎻   ⎺⎻⎽                             │
     │  25│               ⎻⎼⎽     ⎼⎺                   ─⎼──⎼⎼⎼─⎼⎼⎼───⎼─⎼─⎼⎼⎼───     │
     │   0│                  ─⎼⎽⎼⎻                                                  │
     │ Current: 29%  Min: 0%  Max: 100%                                             │
     │                                                                              │
     │ 7-Day Usage                                                                  │
     │ 100│                                           ⎽⎽⎽⎽⎼⎼⎼⎼⎼⎼───────────────     │
     │  75│                                ⎽⎽⎽⎼⎼──⎻⎻⎻⎺                              │
     │  50│──⎼⎼⎽ ⎽                 ⎽⎽⎼⎼──⎻⎻                                         │
     │  25│     ⎺ ⎺⎻⎻──⎼───⎼───⎻⎻⎺⎺                                                 │
     │   0│                                                                         │
     │ Current: 92%  Min: 26%  Max: 93%                                             │
     │                                                                              │
     │ 5-Hour Forecast (history → projection)                                       │
     │ 100│──⎽⎻⎽───────────────────────────────────────────────────────────────     │
     │  75│ ⎽   ⎻        ⎽⎼⎽  ⎽⎼                                                    │
     │  50│─     ⎺⎽    ⎽─   ⎻─  ⎻                                                   │
     │  25│        ⎼             ──⎼─⎼⎼⎼⎼⎼⎼⎼─────────────────────────⎻⎻⎻⎻⎻⎻⎻⎻⎻⎻     │
     │   0│         ─⎽⎻                                                             │
     │    └────────────────────────────────────────────────────────────────────     │
     │     1d ago                           now                   reset: 1h 40m     │
     │ ━ 5h usage  ━ 90% target    │  left: history  │  right: projected            │
     │                                                                              │
     │ 7-Day Forecast (history → projection)                                        │
     │ 100│──────────────────────⎽⎽⎼⎼⎼─────────────────────────────────────────     │
     │  75│                 ⎽⎼⎻⎻⎺                                                   │
     │  50│─⎼⎽⎽        ⎽⎼─⎻⎺                                                        │
     │  25│    ⎻─⎼─⎼─⎻⎺                                                             │
     │   0│                                                                         │
     │    └────────────────────────────────────────────────────────────────────     │
     │     1d ago                           now                   reset: 1h 40m     │
     │ ━ 7d usage  ━ 90% target    │  left: history  │  right: projected            │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ USAGE TRAJECTORY ───────────────────────────────────────────────────────────╮
     │ 5-Hour Window                       7-Day Window                             │
     │  ├─ Current:     29%                 ├─ Current:     92%                     │
     │  ├─ At Reset:    31% ↑               ├─ At Reset:    91%                     │
     │  ├─ Reset In:    1h 40m              ├─ Reset In:    4d 14h                  │
     │  └─ Trend:       +2.2%/hr ↑          └─ Trend:       +0.0%/day →             │
     │                                                                              │
     │ Projection Method: Linear regression on last 30 snapshots                    │
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
     │ ───────────────────────────────────────────────────────────────────          │
     │ Pre-Commit Hook       18          on commit     +80% slower                  │
     │ Test Suite            5           on failure    +80% slower                  │
     │ Compliance (Hook)     11          on change     baseline                     │
     │ Todo Maintenance      7           on change     +80% slower                  │
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
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ TESTING ────────────────────────────────────────────────────────────────────╮
     │ Failing Suites (5)                                                           │
     │   ✗ packages/api/src/__tests__/webho… 14h ago   vitest     ●●●●● 5           │
     │   ✗ packages/frontend/src/__tests__/… 9h ago    vitest     ●●●○○ 3           │
     │   ✗ e2e/tests/checkout-flow.spec.ts   6h ago    playwright ●●○○○ 2           │
     │   ✗ packages/worker/src/__tests__/qu… 4h ago    jest       ●○○○○ 1           │
     │   ✗ packages/shared/src/__tests__/va… 2h ago    vitest     ○○○○○ 0           │
     │                                                                              │
     │ Agents (24h):   14    Vitest:   7    Playwright:   3    Writer:   2          │
     │ Resolved: 3 suites   Unique failures: 8                                      │
     │                                                                              │
     │ Test Agent Activity (7d)                                                     │
     │ 5│                                               ⎻              ──           │
     │  │                                 ⎽─           ⎻ ⎼     ⎽⎻─    ─  ⎺   ⎼⎺     │
     │  │             ⎽⎼           ─⎺    ⎽  ─  ⎽⎺⎼    ─       ─   ⎼  ⎼    ⎻⎼⎻       │
     │  │      ⎽⎺⎼      ⎼  ─⎻⎽   ⎼⎺  ⎻       ⎻⎽   ⎼  ⎼    ⎺⎼⎼⎺     ─⎽               │
     │ 0│⎽⎽⎼⎺⎻⎽   ⎻⎽⎽─   ─⎼   ⎻⎽⎻     ⎺⎼⎺          ⎽⎻                               │
     │                                                                              │
     │ Coverage: 73%   7d trend: ███████                                            │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ DEPLOYMENTS ────────────────────────────────────────────────────────────────╮
     │ Production                Staging                    Preview                 │
     │ ● healthy                 ● failing                  ● no data               │
     │ 22m ago via render        1h ago via render          0 deploys               │
     │ 5 deploys                 3 deploys                                          │
     │                                                                              │
     │ Pipeline: preview ✓ → staging ✓ → production (24h gate)  Last: 5h ago        │
     │                                                                              │
     │ Production Deploys                                                           │
     │ 22m     ●  gentyr-api             render   live     fix: resolve N+1 query   │
     │                                                     …                        │
     │ 3h      ●  gentyr-api             render   live     feat: add webhook        │
     │                                                     signa…                   │
     │ 5h      ●  gentyr-web             vercel   ready    feat: CTO dashboard      │
     │                                                     tra…                     │
     │ 8h      ●  gentyr-web             vercel   ready    chore: bump lodash to    │
     │                                                     4…                       │
     │ 11h     ●  gentyr-worker          render   live     fix: queue processor     │
     │                                                     cr…                      │
     │                                                                              │
     │ Staging Deploys                                                              │
     │ 1h      ●  gentyr-api-staging     render   failed   wip: experimental        │
     │                                                     rate-…                   │
     │ 2h      ●  gentyr-web-staging     vercel   ready    feat: inline styles      │
     │                                                     rep…                     │
     │ 7h      ●  gentyr-api-staging     render   live     fix: RLS policy added    │
     │                                                     t…                       │
     │                                                                              │
     │ Deploys (24h): 8   Success: 50%   Failed: 1   Freq: 0.3/hr                   │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ INFRASTRUCTURE ─────────────────────────────────────────────────────────────╮
     │ Provider        Status        Detail              Extra                      │
     │ Render          ● 2 svc       0 suspended         deploy 22m ago             │
     │ Vercel          ● 1 proj      2 err (24h)                                    │
     │ Supabase        ● healthy                                                    │
     │ Elastic         ○ unavailable                                                │
     │ Cloudflare      ● active      Free Website        NS: 2                      │
     │                                                                              │
     │ Render Events                                                                │
     │ 22m     gentyr-api              live                                         │
     │ 3h      gentyr-api              live                                         │
     │ 11h     gentyr-worker           live                                         │
     │                                                                              │
     │ Vercel Events                                                                │
     │ 5h      gentyr-web              ready                                        │
     │ 8h      gentyr-web              ready                                        │
     │ 2h      gentyr-web-staging      ready                                        │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ LOGGING ────────────────────────────────────────────────────────────────────╮
     │ Log Volume (24h)                                 Total: 44.6K                │
     │                     ⎼─⎻⎻⎺⎺⎺⎻⎻⎻──⎼⎼⎽              1h: 2.5K                    │
     │                                                  Errors: 1.8K                │
     │                  ⎽─⎺               ⎺⎻─⎼⎽         Warnings: 5.5K              │
     │                                                                              │
     │                 ─                       ⎻─⎼                                  │
     │                                                                              │
     │ ⎽             ─⎺                                                             │
     │ ⎺⎻─⎼⎼⎽                                                                       │
     │  ⎺⎻──⎼⎼⎽⎽⎽⎽⎼─⎺                                                               │
     │  ⎺                                                                           │
     │                                                                              │
     │ By Level                               By Service                            │
     │ info  ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆ 36.8K    api        ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆ 18.3K   │
     │ warn  ▆▆▆                      5.5K    worker     ▆▆▆▆▆▆▆▆▆▆▆        11.3K   │
     │ error ▆                        1.8K    auth       ▆▆▆▆▆▆▆             7.2K   │
     │ debug ▆                         490    deployment ▆▆▆▆                4.8K   │
     │                                        cron       ▆▆                  3.0K   │
     │                                                                              │
     │ Top Errors (24h)                                                             │
     │  ✗ ZodError: Required field "schema_versi… api             412               │
     │  ✗ ETIMEDOUT: Connection timed out reachi… worker          287               │
     │  ✗ UnhandledPromiseRejection: Token verif… auth            194               │
     │  ✗ RenderBuildError: Exit code 1 in packa… deployment      88                │
     │  ✗ CronJobError: Payment reconciliation j… cron            43                │
     │                                                                              │
     │ Top Warnings (24h)                                                           │
     │  ⚠ Slow query detected: reports.find() to… api             831               │
     │  ⚠ Rate limit approaching: 92% of Anthrop… worker          614               │
     │  ⚠ Deprecated field "userId" still in use… api             488               │
     │  ⚠ Session token within 5 minutes of expi… auth            327               │
     │  ⚠ Cache miss rate elevated: 68% on repor… worker          219               │
     │                                                                              │
     │ Source Coverage                                                              │
     │ ● api ● worker ● deployment ○ ci-cd ● testing ○ database ○ cdn ● auth ● cron │
     │                                                                              │
     │ Storage: ~0.0 GB/day   Est. Monthly: ~$0.16   Indices: 7                     │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ FEEDBACK PERSONAS (4) ──────────────────────────────────────────────────────╮
     │ Name                Mode  Status    Sessions  Satisfaction      Findings     │
     │ GUI Developer       gui   active    28        satisfied         14           │
     │ CLI Power User      cli   active    19        very satisfied    8            │
     │ API Integrator      api   active    22        neutral           11           │
     │ SDK Automation      sdk   active    15        satisfied         6            │
     │                                                                              │
     │ Total: 84 sessions, 39 findings                                              │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ TIMELINE (24h) ─────────────────────────────────────────────────────────────╮
     │ 15:58  o  SESSION   User session started — CTO dashboard review              │
     │                     └─ task-triggered via autonomous mode                    │
     │                                                                              │
     │ 15:54  *  HOOK      PreCommit review passed — packages/api/src/auth/token.ts │
     │                     └─ No violations detected by deputy-cto-review agent     │
     │                                                                              │
     │ 15:47  !  REPORT    Hardcoded JWT secret detected in auth middleware [CRITI… │
     │                     └─Spec G004 violation — credential must be in env or     │
     │                       Vault                                                  │
     │                                                                              │
     │ 15:40  +  TASK      Completed: Add Zod validation to /api/webhooks route ha… │
     │                     └─ task-runner-code-reviewer — 8 files changed           │
     │                                                                              │
     │ 15:33  ?  QUESTION  Should oauth tokens be stored in Supabase Vault or OS k… │
     │                     └─ Awaiting CTO decision                                 │
     │                                                                              │
     │ 15:25  *  HOOK      PostToolUse: Write blocked — attempt to modify .claude/… │
     │                     └─ Protected path enforcement triggered                  │
     │                                                                              │
     │ 15:17  !  REPORT    Missing RLS policy on user_sessions table [HIGH]         │
     │                     └─Supabase row-level security gap — G003 compliance risk │
     │                                                                              │
     │                                                                              │
     │ 15:09  o  SESSION   Lint fixer session — packages/frontend/src/components/   │
     │                     └─ 12 ESLint errors resolved across 5 files              │
     │                                                                              │
     │ 15:00  +  TASK      Started: Refactor CLAUDE.md to remove duplicate spec re… │
     │                     └─ claudemd-refactor agent                               │
     │                                                                              │
     │ 14:50  *  HOOK      PreCommit: ESLint failure — 3 errors in webhook.ts       │
     │                     └─ Commit blocked — lint-fixer spawned automatically     │
     │                                                                              │
     │ 14:39  !  REPORT    Antipattern scan: silent catch in payment processing fl… │
     │                     └─ G001 violation — silent failure must be converted to  │
     │                        loud failure                                          │
     │                                                                              │
     │ 14:28  ?  QUESTION  Approve relaxing CSP to allow inline styles for chart t… │
     │                     └─Architecture question — deputy CTO recommends          │
     │                       rejection                                              │
     │                                                                              │
     │ 14:16  o  SESSION   Staging health monitor — all checks passed               │
     │                     └─ staging-health-monitor agent — 6 services healthy     │
     │                                                                              │
     │ 14:03  +  TASK      Completed: Enable TypeScript strict mode in packages/api │
     │                     └─ task-runner-code-reviewer — 14 type errors fixed      │
     │                                                                              │
     │ 13:49  !  REPORT    CORS wildcard on production endpoints — policy violatio… │
     │                     └─Escalated to CTO for explicit origin allowlist         │
     │                       decision                                               │
     │                                                                              │
     │ 13:33  *  HOOK      Compliance check triggered — 3 files changed in package… │
     │                     └─ compliance-global agent: all G001–G011 specs verified │
     │                                                                              │
     │ 13:18  ?  QUESTION  Should the triage pipeline use a dedicated queue or sta… │
     │                     └─Scale threshold discussion — recommendation: stay      │
     │                       SQLite until 5k/day                                    │
     │                                                                              │
     │ 13:02  o  SESSION   Investigator session — tracing API latency spike in pro… │
     │                     └─ task-runner-investigator — root cause: N+1 query in   │
     │                        reports endpoint                                      │
     │                                                                              │
     │ 12:44  +  TASK      Completed: Rotate leaked service account credential      │
     │                     └─security task — Supabase service role key revoked and  │
     │                       replaced                                               │
     │                                                                              │
     │ 12:27  !  REPORT    Dependency audit: lodash prototype pollution CVE resolv… │
     │                     └─ Self-handled by deputy CTO — bumped to 4.17.21        │
     │                                                                              │
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
     ╰──────────────────────────────────────────────────────────────────────────────╯
──────────────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on · PR #9 · ctrl+t to hide tasks
```
<!-- CTO_DASHBOARD_END -->

The dashboard section above is auto-generated. To refresh it:

```bash
npm run generate:readme
```

This runs the dashboard with `--mock` data at `COLUMNS=80` and rewrites the content between the HTML comment markers.

## Components

- 30 MCP servers
- 9 specialized agents
- 32 automation hooks
- 10 slash commands
- VS Code extension + CLI dashboard

## Documentation

- [Setup Guide](docs/SETUP-GUIDE.md) -- installation, credentials, protection, troubleshooting
- [Executive Overview](docs/Executive.md) -- architecture, capability inventory, dashboard reference
- [Deployment Flow](docs/DEPLOYMENT-FLOW.md) -- preview, staging, production promotion pipeline
- [Stack](docs/STACK.md) -- infrastructure providers and service configuration
- [Credential Detection](docs/CREDENTIAL-DETECTION.md) -- multi-layer API key detection architecture
- [Secret Paths](docs/SECRET-PATHS.md) -- canonical 1Password `op://` references
- [Testing](docs/TESTING.md) -- AI user feedback system and end-to-end test plan
- [Changelog](docs/CHANGELOG.md) -- version history

## Requirements

- Node.js 20+
- pnpm 8+
- Claude Code CLI
- Claude Max subscription (Opus 4.6)
- 1Password CLI (optional, for infrastructure credentials)

## License

[MIT](LICENSE)
