# the full report

The README shows a summary. This shows everything.

Every metric, every triage decision, every deployment, every log anomaly, every agent spawn. One command generates both views from the same data. The summary tells you whether to look closer. This page is what closer looks like.

Run `/cto-report` in any GENTYR-managed project to see the live version.

<!-- FULL_CTO_DASHBOARD_START -->
```
❯ /cto-report
     UserPromptSubmit says: Quota (2 accounts): 5h ██████░░░░░░░░░░ 35% | 7d ██████████████░░ 88%
     Accounts: dev@acme.io (33% 5h) | ops@acme.io (2% 5h)
     Usage (30d): 2371.0M tokens | 318 task / 279 user sessions | TODOs: 278 queued, 2 active | Deputy: ON (ready)
     Pending: 5 CTO decision(s)

⏺ Bash(node packages/cto-dashboard/dist/index.js)
     ╭──────────────────────────────────────────────────────────────────────────────╮
     │ GENTYR CTO DASHBOARD                                        Period: Last 24h │
     │ Generated: 2026-02-21 10:58                                                  │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ QUOTA & CAPACITY (2 keys) ─────────╮ ╭─ SYSTEM STATUS ──────────────────────╮
     │ 5-hour   ██████░░░░░░░░░░  35%      │ │ Deputy CTO: ENABLED                  │
     │ 7-day    ██████████████░░  88%      │ │   Runs every 50m | Next: 11:02AM (3… │
     │ Rotations (24h): 2                  │ │ Protection: PROTECTED                │
     │                                     │ │ Commits:    BLOCKED                  │
     ╰─────────────────────────────────────╯ ╰──────────────────────────────────────╯
     
     ╭─ ACCOUNT OVERVIEW (3 accounts | 2 rotations 24h) ────────────────────────────╮
     │ * dev@gentyr.io             active    valid    available  5h: 35%  7d: 88%   │
     │   backup@gentyr.io          active    valid    available  5h: 12%  7d: 45%   │
     │   ops@gentyr.io             exhausted valid    exhausted  5h:100%  7d:100%   │
     │                                                                              │
     │   Per-account quota bars in USAGE TRAJECTORY below.                          │
     │                                                                              │
     │   EVENT HISTORY (last 24h)                                                   │
     │  10:20AM  Switched to a3f8d21c... (quota_monitor_95pct)                      │
     │   9:46AM  Account b7c4e92f... exhausted                                      │
     │   8:28AM  Token refreshed for a3f8d21c...                                    │
     │   6:52AM  Switched to b7c4e92f... (switched_from_c9d5f13a)                   │
     │   5:10AM  New account added: c9d5f13a...                                     │
     │   2:40AM  Token expired for d2e6a47b...                                      │
     │  11:16PM  Switched to a3f8d21c... (scheduled_rotation)                       │
     │   8:46PM  Token refreshed for b7c4e92f...                                    │
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
     │ Per-Account Quota  (* = active)                                              │
     │                                                                              │
     │ 5-Hour                                                                       │
     │  Total                  ██████░░░░░░░░░░  35%                                │
     │  dev@gentyr.io *        ██████░░░░░░░░░░  35%                                │
     │  ops@gentyr.io          ████████████████ 100%                                │
     │  backup@gentyr.io       ██░░░░░░░░░░░░░░  12%                                │
     │                                                                              │
     │ 7-Day                                                                        │
     │  Total                  ██████████████░░  88%                                │
     │  dev@gentyr.io *        ██████████████░░  88%                                │
     │  ops@gentyr.io          ████████████████ 100%                                │
     │  backup@gentyr.io       ███████░░░░░░░░░  45%                                │
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
     │ 10:55  o  SESSION   User session started — CTO dashboard review              │
     │                     └─ task-triggered via autonomous mode                    │
     │                                                                              │
     │ 10:51  *  HOOK      PreCommit review passed — packages/api/src/auth/token.ts │
     │                     └─ No violations detected by deputy-cto-review agent     │
     │                                                                              │
     │ 10:44  !  REPORT    Hardcoded JWT secret detected in auth middleware [CRITI… │
     │                     └─Spec G004 violation — credential must be in env or     │
     │                       Vault                                                  │
     │                                                                              │
     │ 10:37  +  TASK      Completed: Add Zod validation to /api/webhooks route ha… │
     │                     └─ task-runner-code-reviewer — 8 files changed           │
     │                                                                              │
     │ 10:30  ?  QUESTION  Should oauth tokens be stored in Supabase Vault or OS k… │
     │                     └─ Awaiting CTO decision                                 │
     │                                                                              │
     │ 10:22  *  HOOK      PostToolUse: Write blocked — attempt to modify .claude/… │
     │                     └─ Protected path enforcement triggered                  │
     │                                                                              │
     │ 10:14  !  REPORT    Missing RLS policy on user_sessions table [HIGH]         │
     │                     └─Supabase row-level security gap — G003 compliance risk │
     │                                                                              │
     │                                                                              │
     │ 10:06  o  SESSION   Lint fixer session — packages/frontend/src/components/   │
     │                     └─ 12 ESLint errors resolved across 5 files              │
     │                                                                              │
     │ 09:57  +  TASK      Started: Refactor CLAUDE.md to remove duplicate spec re… │
     │                     └─ claudemd-refactor agent                               │
     │                                                                              │
     │ 09:47  *  HOOK      PreCommit: ESLint failure — 3 errors in webhook.ts       │
     │                     └─ Commit blocked — lint-fixer spawned automatically     │
     │                                                                              │
     │ 09:36  !  REPORT    Antipattern scan: silent catch in payment processing fl… │
     │                     └─ G001 violation — silent failure must be converted to  │
     │                        loud failure                                          │
     │                                                                              │
     │ 09:25  ?  QUESTION  Approve relaxing CSP to allow inline styles for chart t… │
     │                     └─Architecture question — deputy CTO recommends          │
     │                       rejection                                              │
     │                                                                              │
     │ 09:13  o  SESSION   Staging health monitor — all checks passed               │
     │                     └─ staging-health-monitor agent — 6 services healthy     │
     │                                                                              │
     │ 09:00  +  TASK      Completed: Enable TypeScript strict mode in packages/api │
     │                     └─ task-runner-code-reviewer — 14 type errors fixed      │
     │                                                                              │
     │ 08:46  !  REPORT    CORS wildcard on production endpoints — policy violatio… │
     │                     └─Escalated to CTO for explicit origin allowlist         │
     │                       decision                                               │
     │                                                                              │
     │ 08:30  *  HOOK      Compliance check triggered — 3 files changed in package… │
     │                     └─ compliance-global agent: all G001–G011 specs verified │
     │                                                                              │
     │ 08:15  ?  QUESTION  Should the triage pipeline use a dedicated queue or sta… │
     │                     └─Scale threshold discussion — recommendation: stay      │
     │                       SQLite until 5k/day                                    │
     │                                                                              │
     │ 07:59  o  SESSION   Investigator session — tracing API latency spike in pro… │
     │                     └─ task-runner-investigator — root cause: N+1 query in   │
     │                        reports endpoint                                      │
     │                                                                              │
     │ 07:41  +  TASK      Completed: Rotate leaked service account credential      │
     │                     └─security task — Supabase service role key revoked and  │
     │                       replaced                                               │
     │                                                                              │
     │ 07:24  !  REPORT    Dependency audit: lodash prototype pollution CVE resolv… │
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
<!-- FULL_CTO_DASHBOARD_END -->

This dashboard is auto-generated from mock data. To refresh:

```bash
npm run generate:readme
```
