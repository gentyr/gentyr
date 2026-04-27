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
> You can optionally provide a version string (e.g., "2.1.0"). If left blank, one will be auto-generated.

Record the CTO's response. If they provide a version string, use it. Otherwise, auto-generate as `v{YYYY}.{MM}.{DD}` from today's date.

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

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
node -e "
import { lockStaging } from './${GENTYR_DIR}/.claude/hooks/lib/staging-lock.js';
const result = await lockStaging('RELEASE_ID');
console.log(JSON.stringify({ locked: true }));
" --input-type=module
```

Replace `RELEASE_ID` with the actual release ID from Step 3.

Verify the lock by reading the state file:

```bash
cat .claude/state/staging-lock.json
```

Confirm it shows `"locked": true` and the correct `release_id`.

Then update the release record with the lock timestamp:

```
mcp__release-ledger__update_release({
  release_id: "<release_id>",
  staging_lock_at: "<ISO timestamp>"
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

5. **Phase 5** — "Demo Coverage Audit"
   - `plan_id`, `title: "Demo Coverage Audit"`, `gate: true`

6. **Phase 6** — "Final Triage"
   - `plan_id`, `title: "Final Triage"`

7. **Phase 7** — "CTO Sign-off"
   - `plan_id`, `title: "CTO Sign-off"`, `gate: true`

8. **Phase 8** — "Release Report"
   - `plan_id`, `title: "Release Report"`

Record each phase ID.

### 5c. Add tasks to Phase 1

For EACH PR from Step 2, add a plan task:

```
mcp__plan-orchestrator__add_plan_task({
  plan_id: "<plan_id>",
  phase_id: "<phase_1_id>",
  title: "Review PR #<number>: <title>",
  description: "Run antipattern-hunter, code-reviewer, user-alignment, and spec-compliance checks on PR #<number>.",
  verification_strategy: "All 4 review agents completed with no unresolved critical findings"
})
```

### 5d. Add tasks to Phases 2-8

Add one task per phase:

**Phase 2 task**: "Initial Triage — Review Phase 1 findings"
- Description: "Deputy-CTO triages all Phase 1 findings. Creates fix tasks for critical issues. Escalates blockers to CTO."

**Phase 3 task**: "Meta-Review — Cross-PR consistency check"
- Description: "Holistic review across all PRs for API consistency, cross-cutting concerns, migration safety, and dependency conflicts."
- verification_strategy: "Meta-review report generated with no unresolved cross-cutting issues"

**Phase 4 task**: "Run full test suite and all demo scenarios"
- Description: "Execute unit tests, integration tests, and all registered demo scenarios. ALL demos MUST run remotely on Fly.io with video recording (use run_demo_batch — recorded: true and remote: true are the defaults, meaning headed + Xvfb + ffmpeg on Fly.io). Use run_demo_batch for concurrent execution across multiple Fly.io machines. Collect test-results.json and demo-results.json in the release artifact directory."
- verification_strategy: "All tests pass, all demo scenarios pass with video recordings captured"

**Phase 5 task**: "Demo Coverage Audit"
- Description: "Review all PRs in this release and verify every user-facing feature has a demo scenario. Create missing demos via demo-manager. Run all new demos remotely on Fly.io with recording (run_demo with recorded: true, remote: true). Gate: screenshot proof from demos covering new features — use get_demo_screenshot and extract_video_frames to collect visual evidence."
- verification_strategy: "All changed features have passing demo scenarios with screenshot evidence in the release artifact directory"

**Phase 6 task**: "Final Triage — Pre-release readiness check"
- Description: "Deputy-CTO reviews all test/demo results, outstanding issues, and Phase 3 meta-review findings. Makes go/no-go recommendation."

**Phase 7 task**: "CTO Sign-off"
- Description: "CTO reviews the release report, confirms all quality gates have passed, and authorizes the release. This is a manual sign-off — the CTO must explicitly approve."
- verification_strategy: "CTO has explicitly approved the release via sign_off_release"

**Phase 8 task**: "Generate Release Report"
- Description: "Collect all artifacts, generate the structured release report, and persist to the release ledger."

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
  5. Demo Coverage Audit
  6. Final Triage
  7. CTO Sign-off (requires your explicit approval)
  8. Release Report

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
| `mcp__release-ledger__update_release` | Link plan, set artifact dir, update timestamps |
| `mcp__release-ledger__list_releases` | List releases by status |
| `mcp__release-ledger__sign_off_release` | CTO sign-off on the release |
| `mcp__release-ledger__cancel_release` | Cancel an active release |
| `mcp__plan-orchestrator__create_plan` | Create the release plan |
| `mcp__plan-orchestrator__add_phase` | Add phases to the plan |
| `mcp__plan-orchestrator__add_plan_task` | Add tasks to phases |
| `mcp__plan-orchestrator__add_dependency` | Set phase dependencies |
| `mcp__plan-orchestrator__update_plan_status` | Activate the plan |
