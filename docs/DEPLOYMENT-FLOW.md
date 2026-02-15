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

## Feature Branch Workflow

### Creating Feature Branches

All work should be organized into descriptive feature branches:

```bash
# Create from latest preview
git checkout preview
git pull origin preview
git checkout -b feature/add-user-auth
```

### Branch Naming

- `feature/<description>` -- New functionality
- `fix/<description>` -- Bug fixes
- `refactor/<description>` -- Code refactoring
- `docs/<description>` -- Documentation changes

### Merging to Preview

When the feature is complete and CI passes:

```bash
# Push feature branch
git push -u origin feature/add-user-auth

# Create PR to preview
gh pr create --base preview --title "Add user authentication" --body "..."

# Merge after CI passes (no approval needed)
gh pr merge --merge
```

### When to Merge

- CI passes (lint, type check, unit tests, build)
- Code review complete
- No blocking issues
- Feature is functionally complete

### When NOT to Merge

- Tests failing
- Unresolved code review issues
- Incomplete feature
- Blocked by dependencies

## Automated Promotion Pipelines

### Preview -> Staging (6-hour cycle)

The hourly automation checks every 6 hours for new commits on `preview` not yet in `staging`.

**Conditions:**
1. New commits exist on `preview` not in `staging`
2. >= 24 hours since last staging merge (unless bug-fix commits detected)
3. Bug-fix fast-track: Commits with keywords `fix`, `bug`, `hotfix`, `patch`, `critical` bypass the 24h wait

**Pipeline:**
1. Spawn code-reviewer agent to review commits
2. Spawn test-writer agent to assess test quality
3. If both pass, deputy-CTO makes the merge decision
4. Deputy-CTO creates PR: `gh pr create --base staging --head preview`
5. Wait for CI to pass, then merge

### Staging -> Production (midnight cycle)

Checked once nightly during the midnight window (00:00-00:30).

**Conditions:**
1. New commits exist on `staging` not in `main`
2. Staging has been stable >= 24 hours (no bypass)
3. Midnight time window

**Pipeline:**
1. Same review pipeline (code-reviewer + test-writer)
2. Deputy-CTO creates PR: `gh pr create --base main --head staging`
3. Deputy-CTO creates CTO decision task via `add_question`
4. CTO approves via `/deputy-cto` slash command
5. Merge executed after CTO approval

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

**Reporting:** Issues are reported to deputy-CTO via `mcp__cto-reports__report_to_cto` and fixer agents are spawned via `spawn_implementation_task`.

### Production Health Monitor (1-hour cycle)

Same checks as staging (targeting production services), plus:

| Additional Action | MCP Tool | Purpose |
|-------------------|----------|---------|
| CTO escalation | `mcp__deputy-cto__add_question` | Creates CTO decision task |
| Deputy-CTO report | `mcp__cto-reports__report_to_cto` | Health report for triage |
| Fixer spawn | `mcp__deputy-cto__spawn_implementation_task` | Agents to address issues |

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

1. Automated pipeline creates PR: `preview` -> `staging` (every 6h)
2. Code review + test assessment
3. Deputy-CTO approves
4. CI runs
5. Merge
6. Vercel deploys staging
7. Render deploys staging

### Stage 4: Production

1. Automated pipeline creates PR: `staging` -> `main` (nightly)
2. Code review + test assessment
3. Deputy-CTO creates CTO decision task
4. **CTO approves** via `/deputy-cto`
5. CI runs (includes security scan)
6. Merge
7. Vercel deploys production
8. Render deploys production

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

| Tool | Action | Approval |
|------|--------|----------|
| `mcp__vercel__vercel_list_deployments` | List deployments | None |
| `mcp__vercel__vercel_promote_deployment` | Promote deployment | `APPROVE DEPLOY` |
| `mcp__vercel__vercel_rollback` | Rollback deployment | `APPROVE DEPLOY` |
| `mcp__vercel__vercel_create_env_var` | Set environment variable | `APPROVE DEPLOY` |
| `mcp__render__render_list_services` | List services | None |
| `mcp__render__render_get_service` | Get service details | None |
| `mcp__render__render_trigger_deploy` | Trigger deployment | `APPROVE INFRA` |
| `mcp__render__render_update_service` | Update service config | `APPROVE INFRA` |
| `mcp__render__render_create_env_var` | Set environment variable | `APPROVE INFRA` |
| `mcp__supabase__supabase_sql` | Execute SQL | `APPROVE DATABASE` |
| `mcp__github__github_merge_pull_request` | Merge PR | `APPROVE GIT` |
| `mcp__github__github_create_pull_request` | Create PR | `APPROVE GIT` |
| `mcp__elastic-logs__query_logs` | Query logs | None |
| `mcp__elastic-logs__get_log_stats` | Log statistics | None |

## GENTYR Approval Gates

| Phrase | Scope | When Required |
|--------|-------|---------------|
| `APPROVE GIT` | GitHub: merges, secrets, branch protection | Production merges, secret management |
| `APPROVE DEPLOY` | Vercel: promotions, env vars, rollbacks | Frontend deployment changes |
| `APPROVE INFRA` | Render: deploys, service changes, env vars | Backend infrastructure changes |
| `APPROVE DATABASE` | Supabase: SQL, migrations, deletions | Database operations on production |
| `APPROVE DNS` | Cloudflare: DNS record changes | DNS configuration |
| `APPROVE VAULT` | 1Password: service account creation | Secret management infrastructure |
| `APPROVE EMAIL` | Resend: API key management | Email service configuration |
| `APPROVE BYPASS` | Deputy-CTO: emergency bypass | Bypassing automated protections |

## Rollback Procedures

### Frontend (Vercel)

```bash
# List recent deployments
mcp__vercel__vercel_list_deployments

# Rollback to previous deployment (requires APPROVE DEPLOY)
mcp__vercel__vercel_rollback
```

### Backend (Render)

```bash
# View recent deploys
mcp__render__render_list_deploys

# Trigger redeploy of last known good commit (requires APPROVE INFRA)
mcp__render__render_trigger_deploy
```

### Database (Supabase)

```bash
# Check migration status (requires APPROVE DATABASE for production)
mcp__supabase__supabase_sql

# Rollback migration (requires APPROVE DATABASE)
# Run the down migration SQL
```

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
