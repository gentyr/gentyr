# GENTYR Deployment Flow Reference

Complete deployment pipeline reference for GENTYR-managed projects.

## Infrastructure Architecture

```
Vercel (Frontend)  <-->  Render (Backend API)  <-->  Supabase (Database)
      |                        |
Cloudflare (DNS)          1Password (Secrets)
      |                        |
GitHub Actions (CI/CD)    Elastic Cloud (Logs)
                               |
                          Resend (Email)
```

## 4 Environments

| Environment | Branch | Frontend | Backend | Database | CTO Protection |
|-------------|--------|----------|---------|----------|----------------|
| **Development** | `feature/*` | localhost | localhost | Supabase preview branch | None |
| **Preview** | `preview` | Vercel preview | Render staging | Supabase preview branch | None |
| **Staging** | `staging` | Vercel staging | Render staging | Supabase staging branch | Optional |
| **Production** | `main` | Vercel production | Render production | Supabase main branch | **Required** |

## Branch Strategy & Merge Chain

### Canonical Chain

```
feature/* --PR--> preview --PR--> staging --PR--> main (production)
   |                |                |               |
   |  No approval   |  Deputy-CTO    |  CTO          |
   |                |  approval      |  approval     |
   v                v                v               v
CI only         Vercel preview   Vercel staging   Vercel prod
                Render staging   Render staging   Render prod
                Supabase preview Supabase staging Supabase main
```

### Merge Rules (ENFORCED)

| Source | Target | Allowed | Approval |
|--------|--------|---------|----------|
| `feature/*` | `preview` | YES | None (agent autonomous) |
| `preview` | `staging` | YES | Deputy-CTO |
| `staging` | `main` | YES | **CTO** |
| `feature/*` | `staging` | **FORBIDDEN** | - |
| `feature/*` | `main` | **FORBIDDEN** | - |
| `preview` | `main` | **FORBIDDEN** | - |

Enforcement: `merge-chain-check.yml` CI workflow (required status check) + agent instructions.

**Why CI enforcement?** GitHub has NO native rule on any plan (Teams or Enterprise) to restrict which source branch a PR comes from. The `merge-chain-check.yml` workflow fills this gap.

## Local Branch Protection

### Pre-Commit Guard (Unbypassable)

GENTYR enforces branch protection at the local level via pre-commit and pre-push hooks. Direct commits to protected branches (`main`, `staging`, `preview`) are blocked:

```
COMMIT BLOCKED: Direct commits to 'main' are forbidden.

Merge chain: feature/* -> preview -> staging -> main

Create a feature branch:
  git checkout -b feature/<name> preview
```

The guard is enforced by `.claude/hooks/pre-commit-review.js` and cannot be bypassed with `--no-verify` (blocked by `block-no-verify.js`).

**Exception**: Promotion pipeline agents with `GENTYR_PROMOTION_PIPELINE=true` are allowed to merge PRs to protected branches.

### Pre-Push Guard

The pre-push hook (`templates/config/husky/pre-push.template`) blocks direct pushes to protected branches:

```bash
PUSH BLOCKED: Direct pushes to 'main' are forbidden.

Merge chain: feature/* -> preview -> staging -> main
Push to your feature branch instead, then create a PR to preview.
```

This provides immediate local feedback before any attempt to push to a protected branch.

## Git Worktrees for Concurrent Agents

GENTYR uses git worktrees to enable multiple agents to work concurrently on separate feature branches without checkout conflicts. Each agent gets an isolated working directory.

**Worktree lifecycle:**
1. Task agent spawns → worktree manager creates `.claude/worktrees/<branch-name>/`
2. Worktree provisioned with symlinks to `.claude/agents/`, `.claude/hooks/`, `.husky/`
3. Worktree-specific `.mcp.json` generated with `CLAUDE_PROJECT_DIR` pointing to main project
4. Agent works in isolation, commits to feature branch (lint + security only — no deputy-CTO review gate at commit time)
5. Agent pushes branch, creates PR to `preview`, and creates an urgent DEPUTY-CTO task for PR review
6. After branch merged to preview → worktree cleanup (30-minute cycle)

**State isolation:** SQLite databases (todo.db, deputy-cto.db, agent-tracker.db) remain in main project directory, shared via `CLAUDE_PROJECT_DIR` environment variable.

**Modules:**
- `.claude/hooks/lib/worktree-manager.js` - Worktree lifecycle (create, provision, cleanup)
- `.claude/hooks/lib/feature-branch-helper.js` - Branch naming and protection checks

## Feature Branch Workflow

### Creating Feature Branches

All work should be organized into descriptive feature branches:

```bash
# Create from latest preview
git checkout preview
git pull origin preview
git checkout -b feature/add-user-auth
```

**Automated creation:** When task agents spawn, the worktree manager automatically creates feature branches from `preview` if they don't exist.

### Branch Naming

- `feature/<description>` -- New functionality
- `fix/<description>` -- Bug fixes
- `refactor/<description>` -- Code refactoring
- `docs/<description>` -- Documentation changes

### Merging to Preview

When the feature is complete, the agent pushes the branch, creates a PR, and requests deputy-CTO review:

```bash
# Push feature branch
git push -u origin feature/add-user-auth

# Create PR to preview
gh pr create --base preview --title "Add user authentication" --body "..."
```

After creating the PR, the agent creates an urgent DEPUTY-CTO task to trigger immediate review:

```javascript
mcp__todo-db__create_task({
  category_id: "triage",
  title: "Review PR: <feature-title>",
  description: "Review and merge the PR from feature branch to preview. Run gh pr diff, review for security/architecture/quality, then approve+merge or request changes.",
  assigned_by: "pr-reviewer",
  priority: "urgent"
})
```

The deputy-CTO agent uses `gh pr diff`, `gh pr review --approve` or `gh pr review --request-changes`, and `gh pr merge --merge --delete-branch` (which also triggers worktree cleanup). The `deputy-cto-reviewed` label is always applied.

### When to Merge

- CI passes (lint, type check, unit tests, build)
- Deputy-CTO code review approved (at PR time, not commit time)
- No blocking security or architecture issues
- Feature is functionally complete

### When NOT to Merge

- Tests failing
- Unresolved code review issues
- Incomplete feature
- Blocked by dependencies

## Emergency Hotfix Pathway

When production is broken and a fix has already landed on staging, the CTO can trigger immediate promotion bypassing the standard `/promote-to-prod` 8-phase release plan.

**Prerequisites:**
- Fix must be merged to staging
- CTO authorization required

**Workflow:**
1. CTO runs `/promote-to-prod-force` in an interactive session
2. The command shows current staging drift and asks for explicit confirmation
3. CTO types the confirmation; the agent calls `mcp__agent-tracker__record_cto_decision` with `decision_type: "force_prod_promotion"` and the CTO's verbatim approval text
4. `authorization-audit-spawner.js` enqueues an `authorization-auditor` in the `audit` lane, which reads the CTO's session JSONL via `peek_session` and verifies the context match
5. On audit pass, `mcp__deputy-cto__force_promote_to_prod({ decision_id })` is executed — creates (or reuses) a PR from `staging` to `main` and merges with `--admin` CI bypass
6. The decision is marked consumed (one-time use)

**Notes:**
- `force_promote_to_prod` is registered in `protected-actions.json` — spawned agents are blocked by `protected-action-gate.js`. Only interactive CTO sessions can invoke the tool.
- See [The Unified CTO Authorization System](CLAUDE-REFERENCE.md#the-unified-cto-authorization-system) in `CLAUDE.md` for the full architecture of the deferred-action + record_cto_decision + auditor chain.

**When to use:** Production incidents where the full `/promote-to-prod` quality pipeline cannot complete in time. Not for routine promotion.

### `/hotfix` — emergency staging→main promotion

The `/hotfix` slash command is the path for emergency promotions when production is broken and the fix has landed on staging. It now uses the same deferred-action flow as every other protected action:

1. The agent runs `git fetch origin staging main && git log origin/main..origin/staging --oneline` via Bash and verifies staging is not locked (`.claude/state/staging-lock.json`)
2. The agent shows the commit list to the CTO and asks for verbatim approval
3. The agent calls `mcp__deputy-cto__execute_hotfix_promotion({ commits: [...] })` — `protected-action-gate.js` intercepts, captures `{commits}` in a deferred action (SHA256-hashed to freeze the commit set), returns a denial with the `deferred_action_id`
4. The agent calls `mcp__agent-tracker__record_cto_decision({ decision_type: 'hotfix_promotion', decision_id, verbatim_text })` with the CTO's exact words
5. `authorization-audit-spawner.js` enqueues an `authorization-auditor` in the `audit` lane
6. The auditor uses `peek_session({ session_id })` to verify (a) the commits were shown verbatim BEFORE the approval, (b) the approval is unambiguous, (c) re-runs `git log origin/main..origin/staging` and confirms the commit set still matches (rejects on drift — the CTO must re-approve against the new set), (d) confirms staging is not locked
7. On pass, `deferred-action-audit-executor.js` invokes `spawnHotfixPromoter()` (`.claude/hooks/lib/hotfix-spawn.js`) which enqueues the `hotfix-promotion` agent at `critical` priority with `GENTYR_PROMOTION_PIPELINE=true`. The agent runs a code-reviewer sub-agent, then opens and merges the staging→main PR

The 24-hour stability gate and midnight deployment window are bypassed; code review still runs. See `.claude/commands/hotfix.md` for the operator-facing details.

The previous typed-code system (`APPROVE HOTFIX <6-char-code>` matched by a `UserPromptSubmit` hook with an HMAC token file) has been removed.

## Promotion Pipelines

Promotions (preview→staging and staging→main) are **not automated by the hourly automation**. They are driven by the release pipeline agents (`staging-reactive-reviewer`, `release-reviewer`, `release-plan-manager`) and CTO-directed processes. The hourly automation no longer spawns preview or staging promotion agents, and there is no midnight window or staging freeze logic.

### Preview -> Staging (manual / reactive)

Triggered by the CTO or a release-plan-manager agent when preview has accumulated sufficient changes.

**Pipeline:**
1. Create PR: `gh pr create --base staging --head preview`
2. Deputy-CTO reviews via `/deputy-cto`
3. CI runs
4. Merge on deputy-CTO approval

### Staging -> Production (`/promote-to-prod`)

The ONLY path to production. Run `/promote-to-prod` in a CTO interactive session to initiate an 8-phase release plan orchestrated by the plan-manager. Staging must be unlocked before starting a new release.

**8 Phases:**

| Phase | Name | Gate | Description |
|-------|------|------|-------------|
| 1 | Per-PR Quality Review | Yes | Persistent task per PR: antipattern, code-review, user-alignment, spec-enforcement |
| 2 | Initial Triage | No | Deputy-CTO triages Phase 1 findings |
| 3 | Meta-Review | Yes | Cross-PR consistency check across all changes |
| 4 | Test & Demo Execution | Yes | All unit/integration/playwright tests + all demo scenarios via Fly.io |
| 5 | Demo Coverage Audit | Yes | Verify every new feature has demo coverage with screenshot proof |
| 6 | Final Triage | No | Pre-release readiness check |
| 7 | CTO Sign-off | Yes | CTO reviews and explicitly approves the release via `sign_off_release` |
| 8 | Release Report | No | 8-section structured report generated (.md + .pdf) |

**Flow:** `/promote-to-prod` → enumerate PRs → lock staging (GitHub API + `staging-lock-guard.js`) → create release plan → plan-manager drives phases → CTO approves Phase 7 → staging merges to main → report generated → staging unlocked.

**Monitoring:** `/plan-progress`, `/monitor`, `/persistent-tasks`

**Staging Lock:** During a release, all merges to staging are blocked (`staging-lock-guard.js` PreToolUse hook + GitHub branch protection). `GENTYR_PROMOTION_PIPELINE=true` agents are exempt.

**Release Artifacts:** `.claude/releases/{release-id}/` — JSONL transcripts, session summaries, screenshots, test/demo results, triage actions, CTO decisions.

**Release Ledger:** `release-ledger` MCP server tracks PRs, sessions, reports, and tasks per release for post-mortem traceability.

## Stale Work Detection

GENTYR automatically detects stale branches and uncommitted work via `.claude/hooks/stale-work-detector.js`.

**Detection categories:**
1. **Uncommitted changes** - `git status --porcelain` in project directory
2. **Unpushed commits** - `git log origin/<branch>..HEAD --oneline` for each local branch
3. **Stale feature branches** - Remote feature branches with no PR activity in 3+ days

**Integration:**
- Runs every 24 hours via hourly automation
- Reports via `mcp__agent-reports__report_to_deputy_cto` with category `git-hygiene`
- Surfaced in `/deputy-cto` briefing under "Merge Chain Status"
- Deputy-CTO either auto-handles (spawns cleanup task) or escalates to CTO

**Deputy-CTO MCP tool:** `get_merge_chain_status` returns structured merge chain state for briefing.

## Health Monitoring

### Staging Health Monitor (3-hour cycle)

Runs every 3 hours when the `staging` branch exists and has been deployed.

**Checks:**
| Check | MCP Tool | What to Look For |
|-------|----------|-----------------|
| Render service status | `mcp__render__render_get_service` | Service health, deploy failures |
| Render recent deploys | `mcp__render__render_list_deploys` | Failed or stuck deploys |
| Vercel deployments | `mcp__vercel__vercel_list_deployments` | Build failures, error states |
| Elasticsearch errors | `mcp__elastic-logs__query_logs` | `level:error` in last 3h |
| Error rate stats | `mcp__elastic-logs__get_log_stats` | Error count grouped by service |
| Supabase health | Supabase MCP tools | Migration issues, connectivity |

**Reporting:** Issues are reported to deputy-CTO via `mcp__cto-reports__report_to_cto` and fixer tasks are created via `create_task` with `priority: 'urgent'`.

### Production Health Monitor (1-hour cycle)

Same checks as staging (targeting production services), plus:

| Additional Action | MCP Tool | Purpose |
|-------------------|----------|---------|
| CTO escalation | `mcp__deputy-cto__add_question` | Creates CTO decision task |
| Deputy-CTO report | `mcp__cto-reports__report_to_cto` | Health report for triage |
| Fixer task | `mcp__todo-db__create_task` (priority: urgent) | Tasks to address issues |

Production issues use `priority: "critical"` for reporting and escalation.

### Service IDs

Health monitors read service IDs from `.claude/config/services.json`:

```json
{
  "render": {
    "production": "srv-xxx",
    "staging": "srv-yyy"
  },
  "vercel": {
    "projectId": "prj_xxx"
  }
}
```

This file is created during `/setup-gentyr` Phase 4.

## Deployment Pipeline

### Stage 1: Feature Development

1. Create feature branch from `preview`
2. Develop and test locally
3. CI runs: lint, type check, unit tests, build
4. Push to feature branch

### Stage 2: Preview

1. Create PR: `feature/*` -> `preview`
2. CI runs (merge-chain-check, lint, tests, build)
3. Merge (no approval needed)
4. Vercel deploys preview
5. Supabase preview branch active

### Stage 3: Staging

1. CTO or release-plan-manager triggers PR: `preview` -> `staging`
2. Code review + test assessment
3. Deputy-CTO approves
4. CI runs
5. Merge
6. Vercel deploys staging
7. Render deploys staging

### Stage 4: Production

1. CTO or release-plan-manager triggers PR: `staging` -> `main`
2. Code review + test assessment
3. **CTO approves** via `/deputy-cto`
4. CI runs (includes security scan)
5. Merge
6. Vercel deploys production
7. Render deploys production

## CI Pipeline

```
Merge Chain Check ─────────────────────────────────────────────
                                                               |
Lint & Type Check ──> Unit Tests ──> Security Scan ──> Build ──|
                          |                                    |
                     Integration Tests ──> E2E Tests           |
                                                               |
Deploy (per branch target) <───────────────────────────────────
```

**Required status checks per branch:**

| Branch | Required Checks |
|--------|----------------|
| `preview` | Validate Merge Chain, Lint & Type Check, Unit Tests, Build |
| `staging` | Validate Merge Chain, Lint & Type Check, Unit Tests, Build |
| `main` | Validate Merge Chain, Lint & Type Check, Unit Tests, Build, Security Scan |

## MCP Tools for Deployment & Monitoring

Read-only tools are always available. Mutating tools on deployment, database, and secret infrastructure are **protected actions** — `protected-action-gate.js` blocks them by default and routes them through the Unified CTO Authorization System.

| Tool | Action | Protected? |
|------|--------|------------|
| `mcp__vercel__vercel_list_deployments` | List deployments | No (read-only) |
| `mcp__vercel__vercel_promote_deployment` | Promote deployment | Yes |
| `mcp__vercel__vercel_rollback` | Rollback deployment | Yes |
| `mcp__vercel__vercel_create_env_var` | Set environment variable | Yes |
| `mcp__render__render_list_services` | List services | No (read-only) |
| `mcp__render__render_get_service` | Get service details | No (read-only) |
| `mcp__render__render_trigger_deploy` | Trigger deployment | Yes |
| `mcp__render__render_update_service` | Update service config | Yes |
| `mcp__render__render_create_env_var` | Set environment variable | Yes |
| `mcp__supabase__supabase_sql` | Execute SQL on production | Yes |
| `mcp__supabase__supabase_push_migration` | Apply migration to staging/main | Yes |
| `mcp__github__github_merge_pull_request` | Merge PR to protected branch | Yes (production only) |
| `mcp__github__github_create_pull_request` | Create PR | No (target-dependent) |
| `mcp__elastic-logs__query_logs` | Query logs | No (read-only) |
| `mcp__elastic-logs__get_log_stats` | Log statistics | No (read-only) |

### CTO Approval Flow (Unified CTO Authorization System)

When an agent calls a protected action:

1. **Block.** `protected-action-gate.js` (PreToolUse) denies the tool call and creates a `deferred_actions` row in `bypass-requests.db` storing the exact `server + tool + args`. The denial response includes the deferred-action ID.
2. **Spawned agents.** The denial response also tells the agent to file a `submit_bypass_request` and exit. The agent does NOT retry and does NOT wait — it summarizes its work and stops. The bypass request appears in the CTO's session briefing.
3. **Interactive (CTO) sessions.** The agent presents the deferred-action ID to the CTO and asks for verbatim approval. No phrase, no code — the CTO replies in natural language ("yes, push that migration", "go ahead", etc.).
4. **Record decision.** The agent calls `mcp__agent-tracker__record_cto_decision` with the CTO's verbatim text, the `deferred_action_id`, and the appropriate `decision_type` (`deferred_action`, `force_prod_promotion`, `lockdown_toggle`, `local_mode_toggle`, etc.). The tool scans the session JSONL for the verbatim quote and computes an HMAC-signed proof.
5. **Audit.** `authorization-audit-spawner.js` enqueues an `authorization-auditor` in the `audit` lane. The auditor reads the CTO's session JSONL via `peek_session` and verifies the context match. (For `lockdown_toggle` / `local_mode_toggle`, execution is inline — no separate auditor is spawned because interactive sessions have no `agent_id`/`queue_id`.)
6. **Execute.** On audit pass, `deferred-action-audit-executor.js` runs the original tool call autonomously via the MCP shared daemon (Tier 1 servers) or Bash (Tier 2 / inline state changes). The requesting agent does not need to be alive.

**Agents must never tell the CTO they will receive a 6-character code.** That pattern is only used by the legacy `/hotfix` command (see Emergency Hotfix Pathway above) and is being phased out.

**Security properties:** CTO approval is recorded verbatim and hashed in `cto_decisions`. An independent auditor verifies context accuracy from the actual session JSONL — not from agent claims. The deferred action is bound by `args_hash` so approved args must match stored args (no bait-and-switch). Fail-closed: if the auditor cannot find the session file or verify the quote, the verdict is FAIL.

See [The Unified CTO Authorization System](CLAUDE-REFERENCE.md#the-unified-cto-authorization-system) for the full architecture, and [Deferred Protected Actions](CLAUDE-REFERENCE.md#deferred-protected-actions) for the DB schema and lifecycle.

## Rollback Procedures

All mutating rollback tools below are protected actions — they route through the deferred-action + `record_cto_decision` flow described in [CTO Approval Flow](#cto-approval-flow-unified-cto-authorization-system).

### Frontend (Vercel)

```text
# List recent deployments (read-only — no approval)
mcp__vercel__vercel_list_deployments

# Rollback to previous deployment (protected action)
mcp__vercel__vercel_rollback
```

### Backend (Render)

```text
# View recent deploys (read-only)
mcp__render__render_list_deploys

# Trigger redeploy of last known good commit (protected action)
mcp__render__render_trigger_deploy
```

### Database (Supabase)

```text
# Check migration status (read-only)
mcp__supabase__supabase_sql        # SELECT statements pass; DDL/DML is protected

# Apply or roll back a migration (protected action)
mcp__supabase__supabase_push_migration
```

For production database rollbacks, prefer running a forward "down" migration (additive, expand/contract pattern) via `supabase_push_migration` rather than mutating `supabase_sql` directly. See `migration-safety.js` for the static + LLM-powered safety analyzer that gates promotion-time migrations.

### Full Rollback

For critical production issues:
1. Rollback frontend (Vercel) -- immediate
2. Rollback backend (Render) -- redeploy previous commit
3. Rollback database -- run down migration if applicable
4. Verify health via production health monitor

## Branch Protection Setup

### GitHub Teams Plan (Branch Protection Rules)

Go to: Repository > Settings > Branches > Add branch protection rule

#### `preview` branch

- Branch name pattern: `preview`
- Require a pull request before merging: YES
  - Required approving reviews: `0` (feature -> preview is autonomous)
  - Dismiss stale pull request approvals: YES
- Require status checks to pass: YES
  - Required checks: `Validate Merge Chain`, `Lint & Type Check`, `Unit Tests`, `Build`
  - Require branches to be up to date: YES
- Block force pushes: YES
- Do not allow bypassing the above settings: YES

#### `staging` branch

- Branch name pattern: `staging`
- Require a pull request before merging: YES
  - Required approving reviews: `1` (deputy-CTO review)
  - Dismiss stale pull request approvals: YES
- Require status checks to pass: YES
  - Required checks: `Validate Merge Chain`, `Lint & Type Check`, `Unit Tests`, `Build`
  - Require branches to be up to date: YES
- Block force pushes: YES
- Do not allow bypassing the above settings: YES

#### `main` branch

- Branch name pattern: `main`
- Require a pull request before merging: YES
  - Required approving reviews: `1` (CTO review)
  - Dismiss stale pull request approvals: YES
- Require status checks to pass: YES
  - Required checks: `Validate Merge Chain`, `Lint & Type Check`, `Unit Tests`, `Build`, `Security Scan`
  - Require branches to be up to date: YES
- Block force pushes: YES
- Do not allow bypassing the above settings: YES
- Restrict who can push: (optional, restrict to admins only)

### GitHub Enterprise Cloud (Additional Features)

If on Enterprise Cloud, also configure:
- **Organization Rulesets** (Settings > Rules > Rulesets): Apply merge chain rules across all repos
- **Deployment Protection Rules**: Require manual approval for `staging` and `production` environments
- **Merge Queue** for `main`: Automatically rebase and test PRs before merging
- **Required Team Reviews**: Use rulesets to require specific team approvals

## Prerequisites

- `gh` CLI installed and authenticated: `gh auth login`
- Branch protection configured per above
- `.claude/config/services.json` populated with service IDs
- All MCP servers configured via `/setup-gentyr`
- `merge-chain-check.yml` in `.github/workflows/` (copied from GENTYR template)
