<!-- HOOK:GENTYR:spawn-tasks -->
# /spawn-tasks - Force-Spawn Pending TODO Tasks

On-demand command to **force-spawn all pending tasks immediately**, bypassing the hourly automation's age filter, batch limit, cooldowns, and CTO activity gate.

The prefetch hook has pre-gathered pending task counts and running agent info and injected them as a `[PREFETCH:spawn-tasks]` systemMessage above. Use that data for Step 1.

## Step 1: Display Current State

From the prefetch data, display a summary table:

| Section | Pending Tasks |
|---------|--------------|
| CODE-REVIEWER | N |
| INVESTIGATOR & PLANNER | N |
| TEST-WRITER | N |
| PROJECT-MANAGER | N |
| DEPUTY-CTO | N |
| **Total** | **N** |

Also show: **Running agents**: N

If there are **0 pending tasks**, inform the user and stop — nothing to spawn.

## Step 2: Ask Which Sections to Spawn

Use AskUserQuestion with multiSelect: true and these options:

- **"Implementation agents"** — Spawns CODE-REVIEWER, TEST-WRITER, and INVESTIGATOR & PLANNER tasks
- **"Management agents"** — Spawns PROJECT-MANAGER and DEPUTY-CTO tasks
- **"All sections"** — Spawns tasks from all 5 sections
- **"Cancel"** — Do nothing

The user can also type a custom selection via "Other" (e.g., specific section names).

## Step 3: Map Selection and Run

Map the user's selection to section names:

- "Implementation agents" → `CODE-REVIEWER,INVESTIGATOR & PLANNER,TEST-WRITER`
- "Management agents" → `PROJECT-MANAGER,DEPUTY-CTO`
- "All sections" → `CODE-REVIEWER,INVESTIGATOR & PLANNER,TEST-WRITER,PROJECT-MANAGER,DEPUTY-CTO`
- "Cancel" → stop, do nothing

If the user chose "Other" and typed specific section names, use those directly.

Then resolve the GENTYR framework path and run:

```bash
PROJECT_ROOT=$(d=$(pwd); while [ "$d" != "/" ] && [ ! -f "$d/.claude/commands/spawn-tasks.md" ]; do d=$(dirname "$d"); done; echo "$d")
GENTYR_PATH=$(dirname $(dirname $(dirname $(readlink -f "$PROJECT_ROOT/.claude/commands/spawn-tasks.md" 2>/dev/null || echo "$PROJECT_ROOT"))))
CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node "$GENTYR_PATH/scripts/force-spawn-tasks.js" --sections "<SECTIONS>" --project-dir "$PROJECT_ROOT"
```

Replace `<SECTIONS>` with the comma-separated section names from the mapping above.

## Step 4: Display Results

The script outputs JSON: `{ spawned: [...], skipped: [...], errors: [...] }`

Display a summary:

- **Spawned** (N): list each task title + agent type
- **Skipped** (N): list each with reason (e.g., "concurrency limit reached")
- **Errors** (N): list each with error message

## What This Bypasses

- Automation enabled flag (`autonomous-mode.json`)
- CTO activity gate (24h briefing requirement)
- Task runner cooldown (1h between cycles)
- Task age filter (1h minimum age)
- MAX_TASKS_PER_CYCLE (3 per cycle)

## What This Preserves

- Concurrency guard (default max 10, configurable via `--max-concurrent`)
- Task status tracking (marks in_progress, resets on failure)
- Agent tracker registration (spawned agents appear in `/cto-report`)
- Tasks already in_progress are excluded
