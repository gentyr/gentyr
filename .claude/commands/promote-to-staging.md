# Promote Preview to Staging

Manually promote changes from preview to staging.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Steps

### Step 1: Fetch Latest Branches

```bash
git fetch origin preview staging --quiet 2>/dev/null || true
```

### Step 2: Check Staging Lock

Check whether staging is currently locked for a production release:

```bash
node --input-type=module -e "
import { isStagingLocked, getStagingLockState } from './.claude/hooks/lib/staging-lock.js';
const locked = isStagingLocked(process.cwd());
if (locked) {
  const state = getStagingLockState(process.cwd());
  console.log('LOCKED|' + (state.release_id || 'unknown') + '|' + (state.reason || 'Production release in progress'));
} else {
  console.log('UNLOCKED');
}
"
```

If the output starts with `LOCKED`: Show the following message and stop:

> Staging is locked for production release **{release_id}**: {reason}.
>
> Wait for `/promote-to-prod` to complete, or cancel the release via `mcp__release-ledger__cancel_release`.

### Step 3: Check Drift

```bash
git log --oneline origin/staging..origin/preview
```

If the output is empty: Show "Preview and staging are in sync. Nothing to promote." and stop.

### Step 4: Show Drift Summary

Show the user:

1. The number of commits to be promoted (count the lines from Step 3).

2. The changed files summary:

```bash
git diff --stat origin/staging..origin/preview
```

### Step 5: Ask the User Which Mode

Present two options:

- **Quick promote**: The CTO is the quality gate. Create the PR and merge immediately without running quality checks, tests, or demos.
- **Full promote**: Spawn the `preview-promoter` agent to run all quality gates (quality scan, tests, related demos) before merging. Artifacts and a report are collected.

### Step 6: Quick Promote

If the user chose Quick promote:

Create the PR:

```bash
gh pr create --base staging --head preview --title "Promote preview → staging (manual)" --body "CTO-initiated manual promotion."
```

Wait for CI checks:

```bash
gh pr checks {number} --watch --fail-on-fail
```

If CI fails: show the failures and stop. Do not merge.

Merge the PR:

```bash
gh pr merge {number} --merge
```

Show the PR URL and confirm success:

> Preview promoted to staging via PR #{number}: {url}

### Step 7: Full Promote

If the user chose Full promote:

Generate a promotion ID: `promo-{YYYYMMDD}-{HHmmss}`

Spawn the preview-promoter agent by calling `mcp__agent-tracker__force_spawn_tasks` or by creating a task with `mcp__todo-db__create_task`:
- Title: "Preview → Staging Promotion: {promotion_id}"
- Description: Include the commit list and promotion ID
- Set `assigned_by: "cto"` to bypass the task gate
- Set `priority: "urgent"`

The agent will be queued and can be monitored via `/status` or `/monitor`.

Show the user:

> Full promotion agent has been queued with promotion ID **{promotion_id}**.
>
> Monitor progress: `/status` or `/monitor`
>
> Artifacts will be collected at `.claude/promotions/{promotion_id}/`
