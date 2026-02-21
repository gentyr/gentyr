# GENTYR

GENTYR is not a tool you micromanage. It is a team you direct.

Eleven agents work. A deputy CTO triages. You make the decisions that count.

**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

GENTYR turns Claude Code into an autonomous engineering team. It installs as a framework of agents, hooks, servers, and guards that govern how AI writes, tests, reviews, and ships code. You point it at a new SaaS project. It builds. You steer.

## who this is for

Solo founders building new SaaS products from scratch. You want a full engineering team without hiring one. You are willing to adopt a locked stack and let the framework make infrastructure decisions for you. This is not for existing codebases. GENTYR builds from the ground up.

## the stack

GENTYR chose managed services so every agent, hook, and server is purpose-built for exactly these tools. No abstraction layers. No configuration matrices. No "bring your own database."

TypeScript in strict mode is the only language. Next.js deploys to Vercel for the frontend. Hono deploys to Render for the backend API. Supabase provides PostgreSQL, auth, storage, and row-level security through a single API. Zod validates every payload at runtime. The compliance checker enforces this.

A pnpm monorepo organizes the project. GitHub Actions run CI/CD. 1Password resolves every secret at runtime through `op://` references. Cloudflare manages DNS. Elastic Cloud aggregates logs. Resend handles transactional email. Codecov tracks test coverage. Vitest runs unit tests. Playwright runs end-to-end tests.

This stack is not configurable. Thirty MCP servers are built for these exact tools. If you want a different database or hosting provider, this is not for you.

See [docs/STACK.md](docs/STACK.md) for technical details and MCP server mappings.

## core primitives

### agents

Eleven specialized roles. Fixed sequence: investigate, plan, write, test, review, analyze. Each agent has restricted tool access and a single responsibility. The investigator cannot edit files. The code writer cannot deploy. The test writer cannot approve commits. The product manager cannot modify code. No general-purpose fallback exists.

### hooks

Thirty automation hooks triggered by session events, commits, timers, and failures. They run without being asked. Quota rotation, credential sync, test failure response, stale work detection, merge chain enforcement, compliance checking, antipattern scanning, secret leak detection. Hooks govern what agents can and cannot do.

### servers

Thirty protocol servers connecting agents to external systems. Deployment platforms, secret vaults, task databases, log aggregators, feedback pipelines, coverage reporters. Agents never touch raw APIs. Every external interaction goes through a typed MCP server with a schema and a handler.

### the merge chain

Four stages: feature, preview, staging, main. Enforced locally by root-owned hooks that agents cannot modify. Preview requires passing tests. Staging requires deputy-CTO approval. Main requires CTO sign-off. Stale work is detected and reported automatically.

### the deputy

An autonomous Opus agent that reviews every commit, triages reports, spawns urgent tasks, and escalates decisions to you. Runs on a background timer. You interact through one command: `/deputy-cto`.

## how it runs

Tasks enter the database. The task runner assigns agents on a timer. Agents work in isolated git worktrees. Code flows through the merge chain. The deputy reviews every commit. Hooks enforce compliance on every file change. The quota monitor rotates credentials when usage hits 95%. Dead sessions revive automatically. The usage optimizer scales all cooldowns to target 90% API utilization.

You make the decisions that matter. Automation handles everything else.

## quick start

```bash
git clone git@github.com:gentyr/gentyr.git
sudo gentyr/scripts/setup.sh --path /path/to/project --protect
```

Start Claude Code in your project, run `/setup-gentyr` to configure credentials, then `/restart-session`. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for details.

## the CTO report

This is what the CTO sees.

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
     ╭─ QUOTA & CAPACITY (2 keys) ─────────╮ ╭─ SYSTEM STATUS ──────────────────────╮
     │ 5-hour   ██████░░░░░░░░░░  35%      │ │ Deputy CTO: ENABLED                  │
     │ 7-day    ██████████████░░  88%      │ │   Runs every 50m | Next: 1:15PM (3m… │
     │ Rotations (24h): 2                  │ │ Protection: PROTECTED                │
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

See [docs/CTO-DASHBOARD.md](docs/CTO-DASHBOARD.md) for the full report.

The dashboard is auto-generated. To refresh:

```bash
npm run generate:readme
```

## the automation layer

Thirty hooks and background timers keep the system running without human triggers.

### quota and credentials

Multi-account rotation with restartless token swap. The quota monitor checks every five minutes. At 95% utilization it rotates to the lowest-usage account. Tokens refresh proactively before expiry. The swap writes to Keychain and Claude Code picks it up without restart. No session interruption. No lost work.

### session recovery

Three modes. Quota-interrupted sessions resume automatically via `--resume`. Dead agents are detected by cross-referencing the tracker database with running processes. Paused sessions wait for account recovery then re-spawn. Maximum three revivals per cycle. Seven-day historical scan window.

### task orchestration

A background timer spawns agents for pending tasks every cycle. Concurrency capped at five simultaneous agents. The usage optimizer targets 90% API quota utilization by scaling all nineteen automation cooldowns through a single factor. When projected usage is low, agents spawn faster. When quota is tight, everything slows down.

### code quality

The compliance checker validates against framework specifications on every file change. The antipattern hunter scans for silent catches, hardcoded secrets, and disabled tests. Test failures auto-spawn the test-writer agent. Lint runs on every cycle. Every commit is reviewed by the deputy CTO before it lands.

### deployment pipeline

The merge chain promotes code through four stages on configurable timers. The stale work detector flags uncommitted changes and unpushed branches. Feedback agents spawn on staging changes to test the product as real users across GUI, CLI, API, and SDK modes.

### protection

Critical files are root-owned. Agents cannot modify the hooks, guards, or specs that govern them. The credential file guard blocks agents from reading `.mcp.json`. Secret leak detection scans every diff. Protected path enforcement triggers on any write attempt to `.claude/hooks/`.

See [docs/AUTOMATION-SYSTEMS.md](docs/AUTOMATION-SYSTEMS.md) for implementation details.

## the feedback loop

AI personas test the product as real users. Four modes: GUI, CLI, API, SDK. No source code access. Personas interact with the running application and report findings. Those findings go to the deputy-CTO triage pipeline. Not testing code. Testing product.

## secret management

Zero secrets on disk. Zero secrets in agent context. 1Password is the single source of truth. Agents request secrets by name. The server resolves `op://` references internally. Output is sanitized to replace accidentally leaked values with `[REDACTED]`. The executable allowlist prevents arbitrary command injection.

## components

30 MCP servers. 11 agents. 30 hooks. 11 commands. CLI dashboard.

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
scripts/setup.sh --path /your/project --protect
```

## license

[MIT](LICENSE)
