<!-- HOOK:GENTYR:promote-to-prod -->
# /promote-to-prod - Orchestrate Production Release

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Overview

Orchestrates the full production release pipeline: enumerates staging PRs, creates a release record, locks staging, builds a release plan with 8 phases, and activates a plan-manager to drive the release to completion.

## Step 1: Prerequisites Check

Before anything else, verify the environment is ready for a production release.

### 1a. Verify branches exist

```bash
git rev-parse --verify origin/staging
git rev-parse --verify origin/main
```

If either branch does not exist, stop and inform the CTO: "Cannot proceed — both `origin/staging` and `origin/main` branches are required."

### 1b. Check for active releases

Call `mcp__release-ledger__list_releases` with `status: 'in_progress'`.

If any active release exists, display it and stop:

> A release is already in progress:
>
> Release ID: {id}
> Version: {version}
> Created: {created_at}
>
> Complete or cancel the existing release before starting a new one.
> Use `mcp__release-ledger__cancel_release` to cancel if needed.

### 1c. Fetch latest

```bash
git fetch origin staging main
```

## Step 2: Enumerate PRs

### 2a. Get merge commits

```bash
git log --oneline --merges origin/main..origin/staging
```

### 2b. Get structured PR data

```bash
gh pr list --state merged --base staging --limit 100 --json number,title,author,mergedAt,url
```

### 2c. Display and confirm

Present the PR list to the CTO in a formatted table:

```
## PRs included in this release

| # | Title | Author | Merged |
|---|-------|--------|--------|
| 42 | feat: add SSO login | @alice | 2026-04-25 |
| 43 | fix: session timeout | @bob | 2026-04-26 |

Total: N PRs
```

Use `AskUserQuestion` to ask:

> Ready to create a production release with these {N} PRs?
>
> You can optionally provide a version string (e.g., "2.1.0"). If left blank, the release ledger auto-generates a date-based version (v{YYYY}.{MM}.{DD}) with collision handling for same-day releases.

Record the CTO's response. If they provide a version string, pass it to `create_release`. Otherwise, omit the `version` field — the server handles auto-generation with collision detection (v{YYYY}.{MM}.{DD}, then .1, .2, etc.).

If the CTO says no or cancels, stop immediately.

## Step 3: Create Release

Call `mcp__release-ledger__create_release`:

```
mcp__release-ledger__create_release({
  version: "<version from Step 2c>"
})
```

Record the returned `release_id`.

Then register each PR:

```
mcp__release-ledger__add_release_pr({
  release_id: "<release_id>",
  pr_number: <number>,
  pr_title: "<title>",
  pr_url: "<url>",
  author: "<author>",
  merged_at: "<mergedAt>"
})
```

## Step 4: Lock Staging

Lock staging to prevent new merges from contaminating the release candidate.

```
mcp__release-ledger__lock_staging({
  release_id: "<release_id from Step 3>"
})
```

The tool writes `.claude/state/staging-lock.json` and sets GitHub branch protection (best-effort).

**CRITICAL**: Verify the response shows `locked: true`. If the lock fails, DO NOT proceed — stop and report the error to the CTO. The staging lock is a prerequisite for the release plan.

Then update the release record with the lock timestamp from the response:

```
mcp__release-ledger__update_release({
  release_id: "<release_id>",
  staging_lock_at: "<locked_at from lock response>"
})
```

## Step 5: Create Release Plan

### 5a. Create the plan

```
mcp__plan-orchestrator__create_plan({
  title: "Production Release: <version>",
  description: "CTO-initiated release with <N> PRs from staging"
})
```

Record the returned `plan_id`.

> **IMPORTANT**: All plan tasks MUST be created with `create_todo: true` so the plan-manager
> can spawn agents automatically via `get_spawn_ready_tasks`. If using inline task creation in
> `create_plan`, include `"create_todo": true` in each task object. Without this, the plan-manager
> will find no spawnable tasks and the pipeline will stall. When a task has a `verification_strategy`,
> the `gate_success_criteria` is automatically propagated to the linked todo-db task.

### 5b. Add 8 phases

Create each phase in order using `mcp__plan-orchestrator__add_phase`:

1. **Phase 1** — "Per-PR Quality Review"
   - `plan_id`, `title: "Per-PR Quality Review"`, `gate: true`

2. **Phase 2** — "Initial Triage"
   - `plan_id`, `title: "Initial Triage"`

3. **Phase 3** — "Meta-Review"
   - `plan_id`, `title: "Meta-Review"`, `gate: true`

4. **Phase 4** — "Test & Demo Execution"
   - `plan_id`, `title: "Test & Demo Execution"`, `gate: true`

4b. **Phase 4.5** — "Migration Pre-Flight" (conditional — only if `services.json.environments.production.supabase.projectRef` is set)
   - `plan_id`, `title: "Migration Pre-Flight"`, `gate: true`

4c. **Phase 4.6** — "Canary Verification" (conditional — only if `services.json.canary.enabled` is true; section 5d-canary adds this between Phase 4.5 and Phase 5)
   - `plan_id`, `title: "Canary Verification"`, `gate: true`

5. **Phase 5** — "Demo Coverage Audit"
   - `plan_id`, `title: "Demo Coverage Audit"`, `gate: true`

6. **Phase 6** — "Final Triage"
   - `plan_id`, `title: "Final Triage"`

7. **Phase 7** — "CTO Sign-off"
   - `plan_id`, `title: "CTO Sign-off"`, `gate: true`

8. **Phase 8** — "Release Report"
   - `plan_id`, `title: "Release Report"`

8b. **Phase 8.5** — "Deploy Trigger" (conditional — only if `services.json.environments.production.deployTarget` is set; section 5d-deploy adds this after Phase 8)
   - `plan_id`, `title: "Deploy Trigger"`, `gate: true`

8c. **Phase 8.7** — "Post-Deploy Health Gate" (conditional — only if `deployTarget` is set; section 5d-deploy adds this after Phase 8.5; auto-rollback on failure)
   - `plan_id`, `title: "Post-Deploy Health Gate"`, `gate: true`

Record each phase ID.

### 5c. Add tasks to Phase 1

For EACH PR from Step 2, add a plan task:

```
mcp__plan-orchestrator__add_plan_task({
  plan_id: "<plan_id>",
  phase_id: "<phase_1_id>",
  title: "Review PR #<number>: <title>",
  description: "Run antipattern-hunter, code-reviewer, user-alignment, and spec-compliance checks on PR #<number>.",
  verification_strategy: "All 4 review agents completed with no unresolved critical findings",
  create_todo: true,
  todo_section: "CODE-REVIEWER"
})
```

### 5d. Add tasks to Phases 2-8

Add one task per phase. ALL tasks MUST include `create_todo: true` and the appropriate `todo_section`:

**Phase 2 task**: "Initial Triage — Review Phase 1 findings"
- Description: "Deputy-CTO triages all Phase 1 findings. Creates fix tasks for critical issues. Escalates blockers to CTO."
- create_todo: true, todo_section: "DEPUTY-CTO"

**Phase 3 task**: "Meta-Review — Cross-PR consistency check"
- Description: "Holistic review across all PRs for API consistency, cross-cutting concerns, migration safety, and dependency conflicts."
- verification_strategy: "Meta-review report generated with no unresolved cross-cutting issues"
- create_todo: true, todo_section: "CODE-REVIEWER"

**Phase 4 task**: "Run full test suite and all demo scenarios"
- Description: "Execute unit tests, integration tests, and all registered demo scenarios. COVERAGE REQUIREMENT: The test suite MUST achieve 100% coverage on all metrics (lines, statements, functions, branches). Run pnpm run test:coverage:check — if it exits non-zero, coverage is below 100% and this phase CANNOT be marked complete. Spawn test-writer agents to fill coverage gaps before proceeding.\n\nPRE-DEMO INFRASTRUCTURE VERIFICATION (mandatory before any demo runs):\n1. Call get_fly_status — verify imageDeployed: true, imageStale: false\n2. Call deploy_project_image({ git_ref: 'staging' }) — ALWAYS build from staging during a release\n3. Poll get_fly_status until projectImageDeployed: true and projectImageGitRef matches staging HEAD\n4. Call preflight_check to verify all prerequisites pass\n5. Run ONE trial scenario (simplest/fastest) via run_demo as a smoke test\n6. Verify the trial result appears in verify_demo_completeness({ since: '<release_created_at>', branch: 'staging' }) — confirms result persistence works\n7. Only proceed to full batch after trial passes\n\nDEMO BATCH EXECUTION (single-batch mandate):\n- Call list_scenarios({ enabled: true, remote_eligible: true }) to get ALL scenario IDs\n- Run ALL scenarios in a SINGLE run_demo_batch call — do NOT split into multiple calls\n- Calculate batch_timeout: Math.max(1800000, scenario_count * 720000) (12 min per scenario, minimum 30 min)\n- Do NOT spawn separate todo tasks for individual scenario subsets — the machine pool handles parallelism automatically\n- recorded: true is the default (headed + Xvfb + ffmpeg recording); routing defaults to Fly.io with no flag needed\n\nCollect test-results.json, coverage-report.json, and demo-results.json in the release artifact directory. After all demos complete, call mcp__user-feedback__verify_demo_completeness({ since: '<release_created_at>', branch: 'staging' }) and confirm complete: true before marking this task done.\n\nSELF-HEALING LOOPS (mandatory):\n- Test Failure Loop: If tests fail, parse error output, create urgent 'Test Suite Work' task targeting the failures, spawn immediately, wait for completion (max 30 min), re-run tests. Max 3 iterations before escalating to plan-manager.\n- Coverage Loop: If coverage < 100%, create urgent 'Test Suite Work' task for uncovered code, spawn, wait, re-check. Max 3 iterations.\n- Demo Failure Loop: After a demo fix lands, VERIFY BEFORE RETRY: (1) rebuild project image via deploy_project_image({ git_ref: 'staging' }), (2) run preflight_check, (3) run ONE trial scenario to smoke-test the fix, (4) only launch full batch after trial passes AND result is confirmed in verify_demo_completeness. Max 3 iterations.\n- CI Failure Loop: If CI fails on the release PR, diagnose via gh run view --log-failed, create urgent 'Standard Development' task with failure context, spawn, wait, re-check CI. Max 3 iterations."
- verification_strategy: "All tests pass AND pnpm run test:coverage:check exits 0 (100% coverage on lines, statements, functions, branches) AND mcp__user-feedback__verify_demo_completeness({ since: '<release_created_at>', branch: 'staging' }) returns complete: true with 0 scenarios_missing_pass and 0 scenarios_missing_recording"
- create_todo: true, todo_section: "GENERAL"

### 5d-migrations. Conditional Migration Pre-Flight Phase (only when `services.json.environments.production.supabase.projectRef` is set)

When the production environment has a Supabase project configured, insert Phase 4.5 between Phase 4 and Phase 5. This phase applies pending Supabase migrations to production via the Management API — replacing the old out-of-band `/push-migrations` ceremony with an in-band, gated, evidence-recorded step.

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
node -e "
import fs from 'fs';
const configPath = './services.json';
if (fs.existsSync(configPath)) {
  const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const prodSupabase = c.environments?.production?.supabase?.projectRef;
  console.log(JSON.stringify({ enabled: !!prodSupabase, projectRef: prodSupabase || null }));
} else { console.log(JSON.stringify({ enabled: false })); }
" --input-type=module
```

When `enabled: true`, add the Phase 4.5 task:

```
mcp__plan-orchestrator__add_plan_task({
  plan_id: "<plan_id>",
  phase_id: "<phase_4_5_id>",
  title: "Apply Supabase migrations to production",
  description: "Run migration-runner.js against the production Supabase project. Steps: (1) Resolve SUPABASE_ACCESS_TOKEN from 1Password via mcp__secret-sync__secret_run_command with profile 'supabase-prod' (or environmentScope: 'production'). (2) Diff supabase/migrations/ against schema_migrations via diffMigrations(). (3) Run migration-safety.checkMigrationSafety on the pending set. If safe=false (BLOCKED ops without @expand-contract-verified annotation), halt and file a bypass request. (4) Call applyMigrations({ accessToken, projectRef, migrationsDir }). (5) Reload PostgREST cache. (6) Call mcp__release-ledger__record_migration_status({ release_id, environment: 'production', applied, skipped, pending, failure_reason }). On non-empty pending[], halt the release.",
  verification_strategy: "applyMigrations() returned ok: true AND record_migration_status was called AND releases.migration_status.failure_reason is null AND len(pending) == 0",
  create_todo: true,
  todo_section: "GENERAL"
})
```

Add dependency: Phase 4.5 depends on Phase 4 (`add_dependency`), and Phase 5 (Demo Coverage Audit) depends on Phase 4.5.

**Safety doctrine**: the migration runner blocks destructive ops by default. Engineers must either (a) refactor the migration to expand/contract, or (b) add `-- @expand-contract-verified: <reason explaining why the contract step is safe>` to the migration file header. The annotation is recorded in the release report so future post-mortems can audit acknowledged destructive operations. There is no platform-level "approve destructive migration" button — gentyr's authorization-audit chain is the only override (file a bypass request from the migration agent).

### 5d-canary. Conditional Canary Phase (only when `canary.enabled: true` in services.json)

Before adding Phase 5 and beyond, check services.json for canary configuration:

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
node -e "
import fs from 'fs';
import path from 'path';
const configPath = path.join(process.cwd(), '.claude', 'config', 'services.json');
if (fs.existsSync(configPath)) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(JSON.stringify({
    canaryEnabled: !!config.canary?.enabled,
    trafficPercentage: config.canary?.trafficPercentage || 10,
    monitoringWindowMinutes: config.canary?.monitoringWindowMinutes || 15,
    errorRateThreshold: config.canary?.errorRateThreshold || 5,
    releaseApprovalTier: config.releaseApprovalTier || 'cto'
  }));
} else { console.log(JSON.stringify({ canaryEnabled: false, releaseApprovalTier: 'cto' })); }
" --input-type=module
```

**If `canaryEnabled` is `true`**: Insert an additional phase between Phase 4 and Phase 5.

Add a new phase: `title: "Canary Verification"`, `gate: true`, `required: true`

Add a task to that phase:

```
mcp__plan-orchestrator__add_plan_task({
  plan_id: "<plan_id>",
  phase_id: "<canary_phase_id>",
  title: "Deploy canary and monitor error rate",
  description: "Deploy the staging build to production at <trafficPercentage>% traffic. Monitor error rates for <monitoringWindowMinutes> minutes using the canary-deploy module. If error rate exceeds <errorRateThreshold>%, auto-rollback and fail the phase. Use deployCanary(), monitorCanary(), and rollbackCanary() from .claude/hooks/lib/canary-deploy.js.",
  verification_strategy: "Error rate below <errorRateThreshold>% for <monitoringWindowMinutes> minutes. Canary monitoring report shows healthy: true.",
  create_todo: true,
  todo_section: "GENERAL"
})
```

Substitute the actual values from the canary config into the description and verification_strategy.

Add phase dependencies so the canary phase depends on Phase 4, and Phase 5 (Demo Coverage Audit) depends on the canary phase.

**If `canaryEnabled` is `false`**: Skip this step entirely. Do not add the canary phase to the plan.

**Phase 5 task**: "Demo Coverage Audit"
- Description: "Review all PRs in this release and verify every user-facing feature has a demo scenario. Create missing demos via demo-manager. Run all new demos remotely on Fly.io with recording (run_demo with recorded: true — Fly.io is the default routing target; no execution flag needed). Gate: screenshot proof from demos covering new features — use get_demo_screenshot and extract_video_frames to collect visual evidence."
- verification_strategy: "All changed features have passing demo scenarios with screenshot evidence in the release artifact directory"
- create_todo: true, todo_section: "CODE-REVIEWER"

**Phase 6 task**: "Final Triage — Pre-release readiness check"
- Description: "Deputy-CTO reviews all test/demo results, outstanding issues, and Phase 3 meta-review findings. Makes go/no-go recommendation."
- create_todo: true, todo_section: "DEPUTY-CTO"

**Phase 7 prerequisites (enforced by plan-manager):**
- ALL CI checks on the staging→main PR must be passing (0 failures)
- If any checks are failing, Phase 7 CANNOT start — return to Phase 4 to fix CI issues first

**Phase 7 task**: "CTO Sign-off"
- Description depends on `releaseApprovalTier` from the canary config check above:
  - **If `releaseApprovalTier` is `"automated"`**: "All gate phases have passed. The Phase 7 monitor must: (1) Generate the pre-signoff report via mcp__release-ledger__present_release_summary({ release_id }). (2) Call mcp__release-ledger__record_cto_approval({ release_id }) — the automated tier allows the plan-manager to sign off directly without CTO intervention. (3) Verify release status is 'signed_off'."
  - **If `releaseApprovalTier` is `"deputy"`**: "Awaiting CTO or deputy-CTO review and approval. The Phase 7 monitor must: (1) Generate the pre-signoff report via mcp__release-ledger__present_release_summary({ release_id }). (2) Submit a bypass request to the CTO or deputy-CTO: 'Production release ready — review report and artifacts, then state your approval.' (3) Poll mcp__release-ledger__get_release({ release_id }) every 30s and complete when status === 'signed_off'."
  - **Otherwise (default `"cto"`)**: "Awaiting CTO review and approval. The Phase 7 monitor must: (1) Generate the pre-signoff report via mcp__release-ledger__present_release_summary({ release_id }). (2) Submit a bypass request to the CTO: 'Production release ready — review report and artifacts, then state your approval.' (3) Poll mcp__release-ledger__get_release({ release_id }) every 30s and complete when status === 'signed_off'. The CTO's interactive session agent handles the approval flow: calls present_release_summary to show the report, waits for verbal CTO approval, then calls record_cto_approval with the verbatim quote."
- verification_strategy: "Release status is 'signed_off' AND cto-approval.json exists in the release artifact directory"
- create_todo: true, todo_section: "DEPUTY-CTO"

**Phase 8 task**: "Generate Release Report and Merge to Main"
- Description: "Merge staging to main, collect all artifacts, generate the structured release report, and persist to the release ledger. After the report is generated, a GitHub Release is automatically created with a git tag and the report as release notes (handled by release-completion-hook.js — no manual action needed)."
- create_todo: true, todo_section: "PROJECT-MANAGER"

### 5d-deploy. Conditional Deploy Trigger + Health Gate (only when `services.json.environments.production.deployTarget` OR `deployTargets[]` is set)

When the production environment has in-band deploy targets configured, insert two phases AFTER Phase 8 (so the merge has landed before we deploy). This replaces the prior "trust the platform's auto-deploy webhook" model with an explicit, audited, CTO-gated deploy that gates release sign-off on health-probe success.

**Multi-target releases**: A single release can deploy to multiple platforms in parallel — e.g. backend on Render, web on Vercel, marketing on Vercel. Configure via `deployTargets[]` (canonical) or `deployTarget` singular (backward-compat shorthand). Both shapes are auto-resolved by `wait_for_health_probe` and the task templates below.

```bash
node -e "
import fs from 'fs';
const c = JSON.parse(fs.readFileSync('./services.json', 'utf8'));
const env = c.environments?.production ?? {};
let targets = Array.isArray(env.deployTargets) && env.deployTargets.length > 0 ? env.deployTargets : (env.deployTarget ? [env.deployTarget] : []);
console.log(JSON.stringify({ enabled: targets.length > 0, count: targets.length, targets: targets.map(t => ({ platform: t.platform, serviceId: t.serviceId, label: t.label ?? null })) }));
" --input-type=module
```

When `enabled: true`, add Phase 8.5:

```
mcp__plan-orchestrator__add_plan_task({
  plan_id: "<plan_id>",
  phase_id: "<phase_8_5_id>",
  title: "Trigger production deploy(s) via platform API",
  description: "Read services.json#environments.production.deployTargets (or wrap deployTarget singular into a one-element array). For EACH target in parallel: (1) Call the platform-specific deploy tool — mcp__render__render_trigger_deploy({ service_id }) for Render, mcp__vercel__vercel_promote_deployment for Vercel, mcp__fly__deploy_machine for Fly. (2) Record the platform deploy ID via mcp__release-ledger__record_deploy_artifact({ release_id, platform, service_id, deploy_id, target_label, status: 'triggered' }) — set target_label to the target.label from services.json so multi-platform releases stay distinguishable on the ledger. (3) Call trackDeployment(environment, deploy_id, platform, { target_label, serviceId }) from .claude/hooks/lib/auto-rollback.js so the per-target rollback state file knows about this deploy. (4) Poll the platform API until the deploy reaches 'live' (or 'failed'). (5) Call record_deploy_artifact again with status: 'live' once confirmed AND call recordHealthy(environment, deploy_id, platform, { target_label, serviceId }) so Phase 8.7 has a per-target lastKnownGood baseline for rollback. ALL targets must reach 'live' before the phase completes. On ANY target's 'failed' state → file a bypass request and halt; the merge has succeeded, the CTO can retry the failed target manually.",
  verification_strategy: "For every target in deployTargets[]: release.deploy_artifacts contains a row with status === 'live' AND deploy-tracking.json has a per-target lastKnownGood entry within 10 minutes",
  create_todo: true,
  todo_section: "GENERAL"
})
```

And Phase 8.7:

```
mcp__plan-orchestrator__add_plan_task({
  plan_id: "<plan_id>",
  phase_id: "<phase_8_7_id>",
  title: "Post-deploy health gate (multi-target)",
  description: "Call mcp__release-ledger__wait_for_health_probe({ release_id, environment: 'production', duration_seconds: 300, min_consecutive_passes: 6, interval_seconds: 10 }). The tool returns probe_specs[] — one entry per deployTarget, each with its resolved base_url (target.baseUrlOverride OR env.baseUrl) and health_checks (target.healthChecks OR env.healthChecks OR default). For each probe_spec: poll {base_url}{health_check.path} every interval_seconds; require min_consecutive_passes consecutive successes (status matches expectStatus AND body contains expectBodyContains if set). The phase passes when EVERY probe_spec hits its threshold within duration_seconds. On ANY probe_spec's failure: (1) Read services.json#environments.production.deployTargets[] to find the failing target's rollbackGroup. (2) Call resolveRollbackTargets(failingTarget, allTargets) from .claude/hooks/lib/auto-rollback.js to compute the cascade set — targets sharing a rollbackGroup cascade together; isolated targets do not. (3) For EACH target in the rollback set, call triggerInBandRollback({ release_id, environment, target_label, platform, serviceId, reason: 'Cascading rollback from group <group>: <failingTarget.label> failed health probe' }). (4) Call mcp__release-ledger__cancel_release with a reason listing every rolled-back target_label. (5) Notify the deputy-CTO via report_to_deputy_cto (staging tier) with the full cascading report. If any target in the rollback set has no lastKnownGood entry, escalate to CTO without auto-rollback — that target may be down without a recovery path.",
  verification_strategy: "wait_for_health_probe.probe_specs.every(spec => 6 consecutive successful probes recorded against spec.base_url + each spec.health_checks[].path) AND release status is NOT cancelled",
  create_todo: true,
  todo_section: "GENERAL"
})
```

Add dependencies: Phase 8.5 depends on Phase 8 (`add_dependency`), Phase 8.7 depends on Phase 8.5.

**Failure handling**:
- Phase 8.5 failure (any target's deploy never reaches live) → file bypass request, do NOT cancel the release yet — the merge has succeeded; that specific target can be retried by the CTO via the platform's deploy tool manually.
- Phase 8.7 failure (any probe_spec never reaches min_consecutive_passes) → cascading AUTO-ROLLBACK via `resolveRollbackTargets` + `triggerInBandRollback` for every target in the failing target's rollbackGroup, then `cancel_release`. This is the only path in gentyr's promotion plan that auto-cancels a signed-off release.
- Cascading rollback semantics: targets sharing a `rollbackGroup` string in services.json revert together (e.g., `backend` + `web` both tagged `'api-contract'` → backend probe fails → web also reverts). Isolated targets (no rollbackGroup, or distinct values) stay live when sibling targets fail.
- Multi-target partial rollback (when no rollbackGroup is set): gentyr rolls back EACH failing target independently using its platform's rollback API. A mixed-platform release (Render + Vercel) where Vercel's probes fail rolls back only the Vercel target; the Render deploy stays live. CTO is notified via `report_to_deputy_cto` (staging tier).

**When `enabled: false`**: Skip both phases entirely. The release falls back to the legacy webhook-trusting model — no behavior change for projects that haven't opted in.

### 5e. Add phase dependencies

Each phase depends on the previous one completing. Add dependencies:

```
mcp__plan-orchestrator__add_dependency({
  plan_id: "<plan_id>",
  blocker_type: "phase",
  blocker_id: "<phase_N_id>",
  blocked_type: "phase",
  blocked_id: "<phase_N+1_id>"
})
```

## Step 6: Link Release to Plan

```
mcp__release-ledger__update_release({
  release_id: "<release_id>",
  plan_id: "<plan_id>",
  artifact_dir: ".claude/releases/<release_id>"
})
```

## Step 7: Activate Plan

```
mcp__plan-orchestrator__update_plan_status({
  plan_id: "<plan_id>",
  status: "active"
})
```

The `plan-activation-spawner.js` hook will automatically create a persistent task for the plan-manager and enqueue it.

## Step 8: Display Status

Show a summary:

```
## Production Release Initiated

Release ID:   <release_id>
Version:      <version>
Plan ID:      <plan_id>
PRs included: <N>
Staging:      LOCKED

The release plan has 8 phases:
  1. Per-PR Quality Review (N review tasks)
  2. Initial Triage
  3. Meta-Review
  4. Test & Demo Execution
  4.5. Migration Pre-Flight (only when services.json.environments.production.supabase is set)
  5. Demo Coverage Audit
  6. Final Triage
  7. CTO Sign-off (requires your explicit approval)
  8. Release Report + Merge to Main
  8.5. Deploy Trigger (only when services.json.environments.production.deployTarget is set)
  8.7. Post-Deploy Health Gate (only when deployTarget is set; auto-rolls back on failure)

A plan-manager has been spawned to drive the release through all phases.

## Monitoring
- /plan-progress — view phase-by-phase progress
- /monitor — watch running agents
- /persistent-tasks — manage the release plan-manager

## When Phase 7 is reached
You will be notified to review and approve. Use:
  mcp__release-ledger__sign_off_release({ release_id: "<release_id>", signed_off_by: "cto" })
```

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `mcp__release-ledger__create_release` | Create a release record |
| `mcp__release-ledger__add_release_pr` | Register a PR in the release |
| `mcp__release-ledger__lock_staging` | Lock staging branch for the release |
| `mcp__release-ledger__unlock_staging` | Unlock staging branch after release |
| `mcp__release-ledger__update_release` | Link plan, set artifact dir, update timestamps |
| `mcp__release-ledger__list_releases` | List releases by status |
| `mcp__release-ledger__sign_off_release` | CTO sign-off on the release |
| `mcp__release-ledger__cancel_release` | Cancel an active release |
| `mcp__plan-orchestrator__create_plan` | Create the release plan |
| `mcp__plan-orchestrator__add_phase` | Add phases to the plan |
| `mcp__plan-orchestrator__add_plan_task` | Add tasks to phases |
| `mcp__plan-orchestrator__add_dependency` | Set phase dependencies |
| `mcp__plan-orchestrator__update_plan_status` | Activate the plan |
