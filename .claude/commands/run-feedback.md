<!-- HOOK:GENTYR:run-feedback -->
# /run-feedback - On-Demand Persona Feedback Launcher

On-demand persona feedback launcher. Select specific personas to spawn feedback sessions immediately.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Available Tools

- `mcp__user-feedback__list_personas` - List all configured personas
- `mcp__user-feedback__start_feedback_run` - Start a feedback run for selected personas

---

## Step 1: Load Personas

Call `mcp__user-feedback__list_personas()` to get all configured personas.

If no personas exist, inform the user:
> No personas configured. Run `/configure-personas` to set up feedback personas first.

And stop.

## Step 2: Select Personas

Use `AskUserQuestion` with `multiSelect: true` to let the user pick which personas to run.

Build options:
- First option: **"All personas"** — run feedback for every enabled persona
- Then one option per persona, showing `display_name` (or `name` if `display_name` is empty) and `consumption_mode` in the description

If the user selects nothing or cancels, stop.

## Step 3: Start Feedback Run

Determine the selected persona IDs:
- If "All personas" was chosen: collect all persona IDs where `enabled: true`
- Otherwise: collect the IDs of the individually selected personas

Call:
```
mcp__user-feedback__start_feedback_run({
  trigger_type: "manual",
  persona_ids: <selected_ids_array>,
  max_concurrent: 3
})
```

## Step 4: Confirmation

Display:

```
Feedback run started!
  Run ID: {run_id}
  Personas selected: {count}
  Personas: {comma-separated list of persona names}

Sessions are fire-and-forget. Findings will appear in the deputy-CTO triage pipeline.
Monitor progress with: /persona-feedback
```

Stop after confirmation.

---

## Communication Style

- Be concise — show data in structured format, not prose
- After starting the run, clearly state it runs in the background (fire-and-forget)
- If no enabled personas exist after filtering, inform the user and stop
