# Promote Preview to Staging

Manually promote changes from preview to staging.

## Steps

### Step 1: Fetch Latest Branches

```bash
git fetch origin preview staging --quiet 2>/dev/null || true
```

### Step 2: Check Staging Lock

```bash
cat .claude/state/staging-lock.json 2>/dev/null || echo '{"locked":false}'
```

Parse the JSON output. If `locked` is `true`: Show the following message and stop:

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

### Step 5: Trigger the Preview-Promoter

All promotions go through the preview-promoter agent with full quality gates. Direct staging merges are blocked by the staging-lock-guard hook.

**Call the MCP tool — do NOT create a task or use `force_spawn_tasks`:**

```
mcp__deputy-cto__trigger_preview_promotion()
```

This spawns the preview-promoter agent directly with:
- The correct agent definition (`agents/preview-promoter.md`)
- `GENTYR_PROMOTION_PIPELINE=true` env var (required by staging-lock-guard)
- A dedicated promotion worktree
- Full quality gates: migration safety, quality review, tests, coverage, related demos

**IMPORTANT:** Do NOT use `create_task`, `force_spawn_tasks`, or any task-based spawning for staging promotion. The task system routes through category-based agent resolution, which does NOT load the preview-promoter agent definition. Only `trigger_preview_promotion` ensures the correct agent runs with the correct permissions.

### Step 6: Monitor Progress

The agent will be queued and can be monitored via `/status` or `/monitor`.

Show the user the returned `promotionId` and `queueId`:

> Preview-promoter agent has been queued with promotion ID **{promotionId}**.
>
> Monitor progress: `/status` or `/monitor`
>
> Artifacts will be collected at `.claude/promotions/{promotionId}/`
