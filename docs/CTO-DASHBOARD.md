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
     │ Generated: 2026-02-22 21:16                                                  │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ QUOTA & CAPACITY (2 keys) ─────────╮ ╭─ SYSTEM STATUS ──────────────────────╮
     │ 5-hour   ██████░░░░░░░░░░  35%      │ │ Deputy CTO: ENABLED                  │
     │ 7-day    ██████████████░░  88%      │ │   Runs every 50m | Next: 9:19PM (3m… │
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
     │   8:38PM  Account selected: dev@gentyr.io                                    │
     │   8:04PM  Account fully depleted: ops@gentyr.io                              │
     │   6:46PM  Account nearly depleted: ops@gentyr.io                             │
     │   5:10PM  Account selected: ops@gentyr.io                                    │
     │   3:28PM  New account added: backup@gentyr.io                                │
     │  12:58PM  Account quota refreshed: dev@gentyr.io                             │
     │   9:34AM  Account selected: dev@gentyr.io                                    │
     │   7:04AM  Account can no longer auth: old@gentyr.io                          │
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
     │  Total                  ████████░░░░░░░░  49%                                │
     │  dev@gentyr.io *        ██████░░░░░░░░░░  35%                                │
     │  ops@gentyr.io          ████████████████ 100%                                │
     │  backup@gentyr.io       ██░░░░░░░░░░░░░░  12%                                │
     │                                                                              │
     │ 7-Day                                                                        │
     │  Total                  ████████████░░░░  78%                                │
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
     │ Local Dev           Production          Staging            Preview           │
     │ 3 branches          ● healthy           ● failing          ● healthy         │
     │                     22m ago via render  1h ago via render  4h ago via vercel │
     │                                                                              │
     │                     5 deploys           3 deploys          3 deploys         │
     │                                                                              │
     │ Pipelinelocal dev (3 →preview  → staging   → production (24h     Last:5h ago │
     │                                              gate)                           │
     │                                                                              │
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
     │ Preview Deploys                                                              │
     │ 4h      ●  gentyr-web-preview     vercel   ready    feat: add OAuth2 flow    │
     │ 1h      ●  gentyr-api-preview     render   building fix: resolve race        │
     │                                                     condi…                   │
     │ 6h      ●  gentyr-web-preview     vercel   ready    feat: dashboard          │
     │                                                     setting…                 │
     │                                                                              │
     │ Deploys (24h): 8   Success: 50%   Failed: 1   Freq: 0.3/hr                   │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ WORKTREES ──────────────────────────────────────────────────────────────────╮
     │ 5 worktrees (2 active, 1 idle, 2 merged, 2 system)                           │
     │                                                                              │
     │ Branch                 Agent        Stage      Age  Commit                   │
     │ feature/auth-redesign  code-writer  Local      2h   feat: add OAuth2 PKCE    │
     │                                                     f…                       │
     │ feature/api-refactor   investigator Preview    5h   fix: resolve             │
     │                                                     connection…              │
     │ automation/preview-pro (system)     Preview    3h   Merge branch             │
     │ …                                                   feature/au…              │
     │ feature/dashboard-v2   —            Staging    1d   feat: CTO dashboard      │
     │                                                     wor…                     │
     │ automation/staging-pro (system)     Staging    1d   Merge branch preview     │
     │ …                                                   in…                      │
     │                                                                              │
     │ ● Local        1 branch                                                      │
     │ ● Preview      2 branches                                                    │
     │ ● Staging      2 branches                                                    │
     │ ● Production   0 branches                                                    │
     │                                                                              │
     │ 2 merged worktrees ready for removal                                         │
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
     │ ╭──────────────╮ ╭────────────╮ ╭────────────╮ ╭──────────────╮              │
     │ │ V.Satisfied  │ │ Satisfied  │ │ Neutral    │ │ Dissatisfied │              │
     │ │ 22           │ │ 31         │ │ 18         │ │ 9            │              │
     │ ╰──────────────╯ ╰────────────╯ ╰────────────╯ ╰──────────────╯              │
     │                                                                              │
     │ ╭────────────────╮                                                           │
     │ │ V.Dissatisfied │                                                           │
     │ │ 4              │                                                           │
     │ ╰────────────────╯                                                           │
     │                                                                              │
     │ GUI Developer (gui) active | 28 sessions | satisfied | 14 findings           │
     │   ◆    Login button unresponsive on mo…  high      escalated   2h ago        │
     │   ◆    Dashboard chart tooltip clips a…  normal    handled     5h ago        │
     │   ◆    Missing loading spinner on sett…  low       dismissed   9h ago        │
     │                                                                              │
     │ CLI Power User (cli) active | 19 sessions | very satisfied | 8 findings      │
     │   ◆    Exit code 0 returned on validat…  critical  escalated   1h ago        │
     │   ◆    Help text missing for --format …  low       pending     6h ago        │
     │                                                                              │
     │ API Integrator (api) active | 22 sessions | neutral | 11 findings            │
     │   ◆    PUT /users returns 500 when ema…  high      in progress 48m ago       │
     │   ◆    Rate limit header X-RateLimit-R…  normal    handled     4h ago        │
     │   ◆    Pagination cursor breaks on spe…  high      pending     8h ago        │
     │                                                                              │
     │ SDK Automation (sdk) active | 15 sessions | satisfied | 6 findings           │
     │   No recent reports                                                          │
     │                                                                              │
     │ Total: 84 sessions, 39 findings                                              │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ PRODUCT-MARKET FIT (4/6) ───────────────────────────────────────────────────╮
     │ Status: IN PROGRESS                                                          │
     │                                                                              │
     │ ✓ Market Space & Players                                                     │
     │ ✓ Buyer Personas (4 entries)                                                 │
     │ ✓ Competitor Differentiation                                                 │
     │ ✓ Pricing Models                                                             │
     │ ○ Niche Strengths & Weaknesses                                               │
     │ ○ User Sentiment (0 entries)                                                 │
     ╰──────────────────────────────────────────────────────────────────────────────╯
     
     ╭─ TIMELINE (24h) ─────────────────────────────────────────────────────────────╮
     │ 21:13  o  SESSION   User session started — CTO dashboard review              │
     │                     └─ task-triggered via autonomous mode                    │
     │                                                                              │
     │ 21:09  *  HOOK      PreCommit review passed — packages/api/src/auth/token.ts │
     │                     └─ No violations detected by deputy-cto-review agent     │
     │                                                                              │
     │ 21:02  !  REPORT    Hardcoded JWT secret detected in auth middleware [CRITI… │
     │                     └─Spec G004 violation — credential must be in env or     │
     │                       Vault                                                  │
     │                                                                              │
     │ 20:55  +  TASK      Completed: Add Zod validation to /api/webhooks route ha… │
     │                     └─ task-runner-code-reviewer — 8 files changed           │
     │                                                                              │
     │ 20:48  ?  QUESTION  Should oauth tokens be stored in Supabase Vault or OS k… │
     │                     └─ Awaiting CTO decision                                 │
     │                                                                              │
     │ 20:40  *  HOOK      PostToolUse: Write blocked — attempt to modify .claude/… │
     │                     └─ Protected path enforcement triggered                  │
     │                                                                              │
     │ 20:32  !  REPORT    Missing RLS policy on user_sessions table [HIGH]         │
     │                     └─Supabase row-level security gap — G003 compliance risk │
     │                                                                              │
     │                                                                              │
     │ 20:24  o  SESSION   Lint fixer session — packages/frontend/src/components/   │
     │                     └─ 12 ESLint errors resolved across 5 files              │
     │                                                                              │
     │ 20:15  +  TASK      Started: Refactor CLAUDE.md to remove duplicate spec re… │
     │                     └─ claudemd-refactor agent                               │
     │                                                                              │
     │ 20:05  *  HOOK      PreCommit: ESLint failure — 3 errors in webhook.ts       │
     │                     └─ Commit blocked — lint-fixer spawned automatically     │
     │                                                                              │
     │ 19:54  !  REPORT    Antipattern scan: silent catch in payment processing fl… │
     │                     └─ G001 violation — silent failure must be converted to  │
     │                        loud failure                                          │
     │                                                                              │
     │ 19:43  ?  QUESTION  Approve relaxing CSP to allow inline styles for chart t… │
     │                     └─Architecture question — deputy CTO recommends          │
     │                       rejection                                              │
     │                                                                              │
     │ 19:31  o  SESSION   Staging health monitor — all checks passed               │
     │                     └─ staging-health-monitor agent — 6 services healthy     │
     │                                                                              │
     │ 19:18  +  TASK      Completed: Enable TypeScript strict mode in packages/api │
     │                     └─ task-runner-code-reviewer — 14 type errors fixed      │
     │                                                                              │
     │ 19:04  !  REPORT    CORS wildcard on production endpoints — policy violatio… │
     │                     └─Escalated to CTO for explicit origin allowlist         │
     │                       decision                                               │
     │                                                                              │
     │ 18:48  *  HOOK      Compliance check triggered — 3 files changed in package… │
     │                     └─ compliance-global agent: all G001–G011 specs verified │
     │                                                                              │
     │ 18:33  ?  QUESTION  Should the triage pipeline use a dedicated queue or sta… │
     │                     └─Scale threshold discussion — recommendation: stay      │
     │                       SQLite until 5k/day                                    │
     │                                                                              │
     │ 18:17  o  SESSION   Investigator session — tracing API latency spike in pro… │
     │                     └─ task-runner-investigator — root cause: N+1 query in   │
     │                        reports endpoint                                      │
     │                                                                              │
     │ 17:59  +  TASK      Completed: Rotate leaked service account credential      │
     │                     └─security task — Supabase service role key revoked and  │
     │                       replaced                                               │
     │                                                                              │
     │ 17:42  !  REPORT    Dependency audit: lodash prototype pollution CVE resolv… │
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
