# GENTYR

**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

A governance framework for Claude Code.

AI agents hallucinate, cut corners, and make autonomous decisions that undermine code quality. Without governance, you have an unsupervised intern with root access. GENTYR adds specialized agents, approval gates, and continuous automation to Claude Code. Problems get caught and handled without you thinking about them.

## Quick Start

```bash
git clone git@github.com:gentyr/gentyr.git
sudo gentyr/scripts/setup.sh --path /path/to/project --protect
```

Start Claude Code in your project, run `/setup-gentyr` to configure credentials, then `/restart-session`. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for details.

## What You Get

- **Commit approval gate** -- every commit reviewed by deputy-CTO agent before it lands
- **Specialized agents** -- 9 agents in a fixed workflow: investigate, write, test, review, ship
- **Zero secrets on disk** -- credentials resolve from 1Password at runtime; only `op://` references stored
- **Background task runner** -- spawns agents for pending TODOs on a timer; you set direction, agents execute
- **AI user feedback** -- persona-based testing (GUI/CLI/API/SDK) triggered by staging changes
- **Usage optimizer** -- dynamically adjusts spawn rates to target 90% API quota utilization
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

<img src="docs/assets/claude-logo.svg" width="28" align="left" style="margin-right: 8px;">

&nbsp; **Claude Code** v2.1.34<br>
&nbsp; Opus 4.6 · Claude Max<br>
&nbsp; `~/git/my-project`

---

```

  ⎿  UserPromptSubmit says: Quota: 5-hour ██░░░░░░ 27% (resets 2h) | 7-day ███████░ 91% (resets 5d)
     Usage (30d): 2344.4M tokens | 311 task / 262 user sessions | TODOs: 361 queued, 1 active | Deputy: ON (ready)
     Pending: 6 CTO decision(s)                                                                                                                                                                                                                      
                                                                                                                                                                                                                                                     
⏺ Let me run the CTO dashboard for you.                                                                                                                                                                             08:18 PM  claude-opus-4-6        
                                                                                                                                                                                                                                                     
⏺ Bash(PROJECT_ROOT=$(d=$(pwd); while [ "$d" != "/" ] && [ ! -f "$d/.claude/commands/cto-report.md" ]; do d=$(dirname "$d"); done; echo "$d") && GENTYR_PATH=$(dirname $(dirname $(dirname $(readlink -f                                             
      "$PROJECT_ROOT/.claude/commands/cto-report.md" 2>/dev/null || echo "$PROJECT_ROOT")))) && CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node "$GENTYR_PATH/packages/cto-dashboard/dist/index.js")                                                         
  ⎿  ╭──────────────────────────────────────────────────────────────────────────────╮                                                                                                                                                                
     │ GENTYR CTO DASHBOARD                                        Period: Last 24h │                                                                                                                                                                
     │ Generated: 2026-02-17 20:18                                                  │                                                                                                                                                                
     ╰──────────────────────────────────────────────────────────────────────────────╯
                                                                                                                                                                                                                                                     
     ╭─ QUOTA & CAPACITY (1 key) ──────────── ╭─ SYSTEM STATUS ───────────────────────                                                                                                                                                             
     ───────────────────────────────────────╮ ───────────────────────────────────────╮                                                                                                                                                               
                                                                                                                                                                                                                                                     
     │ 5-hour   ████░░░░░░░░░░░░  28%       │ │ Deputy CTO: ENABLED                 │                                                                                                                                                                
     │ 7-day    ███████████████░  91%       │ │   Runs every 55m | Next:7:54PM (0s) │                                                                                                                                                                
     │ Rotations (24h): 3                   │ │                                     │                                                                                                                                                                
     ╰──────────────────────────────────────╯ │ Protection: PROTECTED               │                                                                                                                                                                
                                              │ Commits:    BLOCKED                 │                                                                                                                                                                
                                              ╰─────────────────────────────────────╯                                                                                                                                                                
                                                                                                                                                                                                                                                   
     ╭─ DEPUTY CTO ─────────────────────────────────────────────────────────────────╮
     │ ╭────────────╮ ╭────────────╮ ╭────────────╮ ╭─────────────╮                 │
     │ │ Untriaged  │ │ Escalated  │ │ Pending Q  │ │ 24h Handled │                 │
     │ │ 0          │ │ 5          │ │ 6          │ │ 5           │                 │
     │ ╰────────────╯ ╰────────────╯ ╰────────────╯ ╰─────────────╯                 │
     │                                                                              │
     │ ╭───────────────╮ ╭───────────────╮                                          │
     │ │ 24h Escalated │ │ 24h Dismissed │                                          │
     │ │ 17            │ │ 29            │                                          │
     │ ╰───────────────╯ ╰───────────────╯                                          │
     │                                                                              │
     │ ▲ ESCALATED                                                                  │
     │    Title                              Priority  Time                         │
     │ ────────────────────────────────────────────────────────────                 │
     │ ◆  Security Review: Email service D…  normal    1h ago                       │
     │ ◆  G009 RLS Compliance: Team member…  normal    1h ago                       │
     │ ◆  Staging Health Issue: Render bac…  high      1h ago                       │
     │ ◆  PAGE-OBSERVER/BROWSER-PROXY secu…  normal    5h ago                       │
     │ ◆  Periodic Antipattern Scan: 4 iss…  normal    8h ago                       │
     │                                                                              │
     │ ? PENDING QUESTIONS (6)                                                      │
     │    Title                              Type      Time                         │
     │ ────────────────────────────────────────────────────────────                 │
     │ ?  Security: Email service DEV_MODE…  escalation1h ago                       │
     │    └─ Fix both: (1) Redact OTP codes from DEV_…                              │
     │ ?  G009 Security: RLS policies inco…  escalation1h ago                       │
     │    └─ Create a single migration (010) that rep…                              │
     │ ?  Staging Render backend has NEVER…  escalation1h ago                       │
     │    └─ Investigate the Render staging build log…                              │
     │ ?  Bypass Request: Fix CI build fai…  bypass-req1h ago                       │
     │                                       uest                                   │
     │ ?  Architecture decision: WebSocket…  decision  5h ago                       │
     │    └─ Option A: Integrate into backend. Plan 0…                              │
     │ ?  BROWSER-PROXY spec gap: auth tok…  escalation5h ago                       │
     │    └─ Update the BROWSER-PROXY spec (specs/loc…                              │
     │                                                                              │
     │ ────────────────────────────────────────────────────────────                 │
     │                                                                              │
     │ ○ Recently Triaged                                                           │
     │    Title                              Priority  Outcome     Time             │
     │ ────────────────────────────────────────────────────────────────────────     │
     │ ◆  Security Review: Email service D…  normal    ↑ Escalated 1h ago           │
     │ ◆  G009 RLS Compliance: Team member…  normal    ↑ Escalated 1h ago           │
     │ ◆  Staging Health Issue: Render bac…  high      ↑ Escalated 1h ago           │
     │ ◆  Antipattern Hunt: Systemic G001 …  normal    ✕ Dismissed 1h ago           │
     │ ◆  CLAUDE.md refactored: 25,676 → 1…  low       ✕ Dismissed 2h ago           │
     │ ◆  Lint fix: prefer-destructuring i…  low       ✕ Dismissed 3h ago           │
     │ ◆  Fixed 2 lint errors in extension…  low       ✕ Dismissed 4h ago           │
     │ ◆  Gap 6 Operator Panel: Decomposed…  low       ✕ Dismissed 5h ago           │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ USAGE TRENDS ───────────────────────────────────────────────────────────────╮
     │ 5-Hour Usage (1019 snapshots, 1d ago to now)                                 │
     │ 100│ ⎽⎼⎼⎼─⎻⎻⎻                                                                │
     │  75│                     ⎻⎺   ⎼⎼⎼───       ⎼⎼                                │
     │  50│⎽        ⎻    ─⎻       ⎽─⎻                                               │
     │  25│          ──⎺⎺     ⎽─           ⎽⎽⎽⎽─⎻⎻   ⎽⎼⎼⎼⎼⎼⎼⎼⎼⎼⎼⎼─⎼⎼⎼⎼⎼⎼⎼⎼⎼⎼⎼⎼─     │
     │   0│                ──⎻                      ⎺                               │
     │ Current: 28%  Min: 0%  Max: 100%                                             │
     │                                                                              │
     │ 7-Day Usage                                                                  │
     │ 100│                                           ⎽⎽⎽⎽⎽⎽⎽⎽⎽⎽⎽⎽─────────────     │
     │  75│                       ⎽⎼⎼⎼⎼⎼⎼⎼⎼────⎻⎻⎻⎺⎺⎺⎺                              │
     │  50│─⎻⎺⎺⎺⎺⎺⎺⎺            ⎼⎼                                                  │
     │  25│         ⎻⎻⎻⎻⎻⎻⎺⎺⎺───                                                    │
     │   0│                                                                         │
     │ Current: 91%  Min: 28%  Max: 91%                                             │
     │                                                                              │
     │ 5-Hour Forecast (history → projection)                                       │
     │ 100│─⎼⎼⎻⎻───────────────────────────────────────────────────────────────     │
     │  75│           ⎺ ⎼⎼─    ⎼                                                    │
     │  50│⎽      ─    ─                                                            │
     │  25│     ─⎺   ⎻     ⎽⎽─⎻ ⎽⎼⎼⎼⎼⎼─⎼⎼⎼⎼⎼⎼─────────────────────────────⎻⎻⎻⎻⎻     │
     │   0│        ─⎻                                                               │
     │    └────────────────────────────────────────────────────────────────────     │
     │     1d ago                           now                   reset: 1h 41m     │
     │ ━ 5h usage  ━ 90% target    │  left: history  │  right: projected            │
     │                                                                              │
     │ 7-Day Forecast (history → projection)                                        │
     │ 100│──────────────────────⎽⎽⎽⎽⎽⎽────────────────────────────────────────     │
     │  75│            ⎼⎼⎼⎼──⎻⎻⎺⎺                                                   │
     │  50│─⎺⎺⎺⎺      ⎼                                                             │
     │  25│     ⎻⎻⎻⎺──                                                              │
     │   0│                                                                         │
     │    └────────────────────────────────────────────────────────────────────     │
     │     1d ago                           now                   reset: 1h 41m     │
     │ ━ 7d usage  ━ 90% target    │  left: history  │  right: projected            │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ USAGE TRAJECTORY ───────────────────────────────────────────────────────────╮
     │ 5-Hour Window                       7-Day Window                             │
     │  ├─ Current:     28%                 ├─ Current:     91%                     │
     │  ├─ At Reset:    31% ↑               ├─ At Reset:    91%                     │
     │  ├─ Reset In:    1h 41m              ├─ Reset In:    4d 15h                  │
     │  └─ Trend:       +2.2%/hr ↑          └─ Trend:       +0.0%/day →             │
     │                                                                              │
     │ Projection Method: Linear regression on last 30 snapshots                    │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ AUTOMATED INSTANCES ────────────────────────────────────────────────────────╮
     │ Type                  Runs (24h)  Until Next    Freq Adj                     │
     │ ───────────────────────────────────────────────────────────────────          │
     │ Triage Check          0           9m            +100% slower                 │
     │ Lint Checker          2           39m           +100% slower                 │
     │ CLAUDE.md Refactor    1           now           +100% slower                 │
     │ Task Runner           12          28m           +100% slower                 │
     │ Production Health     4           28m           +100% slower                 │
     │ Compliance (Sched.)   4           28m           +100% slower                 │
     │ User Feedback         0           pending       +100% slower                 │
     │ Antipattern Hunter    2           4h28m         +100% slower                 │
     │ Staging Health        2           4h28m         +100% slower                 │
     │ Preview Promotion     0           11h6m         +100% slower                 │
     │ Staging Promotion     0           19h48m        +100% slower                 │
     │ ───────────────────────────────────────────────────────────────────          │
     │ Pre-Commit Hook       11          on commit     +100% slower                 │
     │ Test Suite            0           on failure    +100% slower                 │
     │ Compliance (Hook)     0           on change     +100% slower                 │
     │ Todo Maintenance      0           on change     +100% slower                 │
     │                                                                              │
     │ Usage Target: 90%  |  Current Projected: 150%  |  Adjusting: ↑ intervals     │
     │                                                                              │
     │ Token Usage by Automation (24h)                                              │
     │ Task Runner            ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆ 90.4M │
     │ Compliance (Sched.)    ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆                       48.7M │
     │ Antipattern Hunter     ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆                               33.8M │
     │ report-triage          ▆▆▆▆▆▆▆▆▆▆▆▆▆▆▆                                 29.0M │
     │ task-runner-deputy-cto ▆▆▆▆▆▆▆▆▆▆▆▆                                    23.5M │
     │ Test Suite             ▆▆▆▆▆▆▆▆▆                                       17.9M │
     │ Pre-Commit Hook        ▆▆▆▆▆▆▆▆                                        16.8M │
     │ Production Health      ▆▆▆▆▆                                           11.4M │
     │ Lint Checker           ▆▆▆▆                                             8.3M │
     │ Staging Health         ▆▆                                               5.0M │
     │ CLAUDE.md Refactor     ▆                                                2.3M │
     │                                                                              │
     │ Tip: Ask Claude Code to adjust frequency or switch modes (load balanced /    │
     │ static).                                                                     │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ TESTING ────────────────────────────────────────────────────────────────────╮
     │ Failing Suites (6)                                                           │
     │   ✗ client.idempotency.test.ts        1d ago    -          ○○○○○ 0           │
     │   ✗ client.test.ts                    21h ago   -          ○○○○○ 0           │
     │   ✗ route.test.ts                     18h ago   -          ○○○○○ 0           │
     │   ✗ notification-center.test.tsx      18h ago   -          ○○○○○ 0           │
     │   ✗ backend-client.test.ts            18h ago   -          ○○○○○ 0           │
     │   ✗ auth.setup.ts                     17h ago   -          ○○○○○ 0           │
     │                                                                              │
     │ Agents (24h):   0                                                            │
     │ Unique failures: 6                                                           │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ DEPLOYMENTS ────────────────────────────────────────────────────────────────╮
     │ Production                Staging                    Preview                 │
     │ ● healthy                 ● failing                  ● no data               │
     │ 6h ago via vercel         9d ago via render          0 deploys               │
     │ 5 deploys                 3 deploys                                          │
     │                                                                              │
     │ Pipeline: preview – → staging – → production (24h gate)                      │
     │                                                                              │
     │ Production Deploys                                                           │
     │ 6h      ●  xy                     vercel   ready    feat: Elastic log        │
     │                                                     pipel…                   │
     │ 16h     ●  xy                     vercel   ready    fix: add force-dynamic   │
     │                                                     …                        │
     │ 16h     ●  xy                     vercel   ready    fix: use lazy backend    │
     │                                                     U…                       │
     │ 16h     ●  xy                     vercel   ready    fix: cast invoicesData   │
     │                                                     …                        │
     │ 16h     ●  xy                     vercel   failed   fix: cast                │
     │                                                     subscriptionD…           │
     │                                                                              │
     │ Staging Deploys                                                              │
     │ 9d      ●  projecty-api-staging   render   failed   Fix web app test         │
     │                                                     failur…                  │
     │ 9d      ●  projecty-api-staging   render   failed   Fix web app test         │
     │                                                     failur…                  │
     │ 9d      ●  projecty-api-staging   render   failed   Fix web app test         │
     │                                                     failur…                  │
     │                                                                              │
     │ Deploys (24h): 10   Success: 40%   Failed: 6   Freq: 0.4/hr                  │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ INFRASTRUCTURE ─────────────────────────────────────────────────────────────╮
     │ Provider        Status        Detail              Extra                      │
     │ Render          ● 2 svc       0 suspended         deploy 1d ago              │
     │ Vercel          ● 1 proj      5 err (24h)                                    │
     │ Supabase        ● healthy                                                    │
     │ Elastic         ○ unavailable                                                │
     │ Cloudflare      ● active      Free Website        NS: 2                      │
     │                                                                              │
     │ Render Events                                                                │
     │ 9d      projecty-api-staging    failed                                       │
     │ 9d      projecty-api-staging    failed                                       │
     │ 9d      projecty-api-staging    failed                                       │
     │                                                                              │
     │ Vercel Events                                                                │
     │ 6h      xy                      ready                                        │
     │ 16h     xy                      ready                                        │
     │ 16h     xy                      ready                                        │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ TIMELINE (24h) ─────────────────────────────────────────────────────────────╮
     │ 20:17  o  SESSION   3448fd3c...                                              │
     │                     └─ User session (manual)                                 │
     │                                                                              │
     │ 19:04  o  SESSION   7b68562c...                                              │
     │                     └─ User session (manual)                                 │
     │                                                                              │
     │ 19:01  ?  QUESTION  Security: Email service DEV_MODE logs OTP codes to cons… │
     │                     └─ Type: escalation | Status: pending                    │
     │                                                                              │
     │ 19:01  ?  QUESTION  G009 Security: RLS policies inconsistent — migrations 0… │
     │                     └─ Type: escalation | Status: pending                    │
     │                                                                              │
     │ 19:00  ?  QUESTION  Staging Render backend has NEVER successfully deployed … │
     │                     └─ Type: escalation | Status: pending                    │
     │                                                                              │
     │ 19:00  o  SESSION   33716641...                                              │
     │                     └─ Task: report-triage                                   │
     │                                                                              │
     │ 18:59  *  HOOK      hourly-automation                                        │
     │                     └─ deputy-cto-review: "Triaging pending CTO reports"     │
     │                                                                              │
     │ 18:55  ?  QUESTION  Bypass Request: Fix CI build failure: createLogger stri… │
     │                     └─ Type: bypass-request | Status: pending                │
     │                                                                              │
     │ 18:49  o  SESSION   bf7f74e5...                                              │
     │                     └─ User session (manual)                                 │
     │                                                                              │
     │ 18:49  !  REPORT    Security Review: Email service DEV_MODE logs OTP codes … │
     │                     └─From: standalone-antipattern-hunter | Status:          │
     │                       escalated                                              │
     │                                                                              │
     │ 18:49  !  REPORT    Antipattern Hunt: Systemic G001 || [] violations across… │
     │                     └─From: standalone-antipattern-hunter | Status:          │
     │                       dismissed                                              │
     │                                                                              │
     │ 18:48  !  REPORT    G009 RLS Compliance: Team member access inconsistency a… │
     │                     └─From: standalone-compliance-checker | Status:          │
     │                       escalated                                              │
     │                                                                              │
     │ 18:48  +  TASK      G002/G017: TODO in execute.ts - Decryption not implemen… │
     │                     └─ Assignee: CODE-REVIEWER                               │
     │                                                                              │
     │ 18:47  +  TASK      G010: Logs API route has NO auth validation - /api/logs… │
     │                     └─ Assignee: CODE-REVIEWER                               │
     │                                                                              │
     │ 18:47  !  REPORT    Staging Health Issue: Render backend has never suc[HIGH] │
     │                                                                              │
     │                     └─ From: staging-health-monitor | Status: escalated      │
     │                                                                              │
     │ 18:47  +  TASK      Fix G001 violation: dashboard/page.tsx partially fixed … │
     │                     └─ Assignee: INVESTIGATOR & PLANNER                      │
     │                                                                              │
     │ 18:46  o  SESSION   88bc9be3...                                              │
     │                     └─ Task: staging-health-monitor                          │
     │                                                                              │
     │ 18:46  o  SESSION   82b48d7d...                                              │
     │                     └─ Task: task-runner-investigator                        │
     │                                                                              │
     │ 18:46  o  SESSION   b579aec1...                                              │
     │                     └─ Task: standalone-antipattern-hunter                   │
     │                                                                              │
     │ 18:46  o  SESSION   0eac06de...                                              │
     │                     └─ Task: task-runner-code-reviewer                       │
     │                                                                              │
     ╰──────────────────────────────────────────────────────────────────────────────╯

     ╭─ METRICS SUMMARY ────────────────────────────────────────────────────────────╮
     │ ╭─ Tokens                                                                    │
     │ ─────────────────────────────────────────────────────────────────────╮       │
     │ │ In: 129.0K                                                         │       │
     │ │ Out: 137.1K                                                        │       │
     │ │ Cache: 100%                                                        │       │
     │ ╰────────────────────────────────────────────────────────────────────╯       │
     │                                                                              │
     │ ╭─ Sessions                                                                  │
     │ ───────────────────────────────────────────────────────────────────╮         │
     │ │ Task: 183                                                        │         │
     │ │ User: 46                                                         │         │
     │ │ Total: 229                                                       │         │
     │ ╰──────────────────────────────────────────────────────────────────╯         │
     │                                                                              │
     │ ╭─ Agents                                                                    │
     │ ─────────────────────────────────────────────────────────────────────╮       │
     │ │ Spawns: 48                                                         │       │
     │ │ Types: 10                                                          │       │
     │ ╰────────────────────────────────────────────────────────────────────╯       │
     │                                                                              │
     │ ╭─ Tasks                                                                     │
     │ ──────────────────────────────────────────────────────────────────────╮      │
     │ │ Pending: 361                                                        │      │
     │ │ Active: 1                                                           │      │
     │ │ Done: 25                                                            │      │
     │ ╰─────────────────────────────────────────────────────────────────────╯      │
     │                                                                              │
     │ ╭─ Hooks (24h)                                                               │
     │ ────────────────────────────────────────────────────────────────╮            │
     │ │ Total: 518                                                    │            │
     │ │ Success: 100%                                                 │            │
     │ │ Skipped: 59                                                   │            │
     │ │ Failures: 0                                                   │            │
     │ ╰───────────────────────────────────────────────────────────────╯            │
     │                                                                              │
     │ ╭─ Triage                                                                    │
     │ ─────────────────────────────────────────────────────────────────────╮       │
     │ │ Pending: 0                                                         │       │
     │ │ Handled: 5                                                         │       │
     │ │ Escalated: 17                                                      │       │
     │ ╰────────────────────────────────────────────────────────────────────╯       │
     │                                                                              │
     │ ╭─ CTO Queue                                                                 │
     │ ──────────────────────────────────────────────────────────────────╮          │
     │ │ Questions: 6                                                    │          │
     │ │ Rejections: 0                                                   │          │
     │ │ Triage: 0                                                       │          │
     │ ╰─────────────────────────────────────────────────────────────────╯          │
     │                                                                              │
     │ ╭─ Cooldowns                                                                 │
     │ ──────────────────────────────────────────────────────────────────╮          │
     │ │ Factor: 0.5x                                                    │          │
     │ │ Target: 90%                                                     │          │
     │ │ Proj: 1.5%                                                      │          │
     │ ╰─────────────────────────────────────────────────────────────────╯          │
     ╰──────────────────────────────────────────────────────────────────────────────╯
```

## Components

- 25 MCP servers (9 core + 10 infrastructure + 5 feedback + 1 browser)
- 9 specialized agents
- 13 automation hooks
- 9 slash commands
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

- Node.js 18+
- Claude Code CLI
- 1Password CLI (optional, for infrastructure credentials)

## License

[MIT](LICENSE)
