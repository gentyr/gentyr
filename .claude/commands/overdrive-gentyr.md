<!-- HOOK:GENTYR:overdrive -->
# /overdrive-gentyr - GENTYR Overdrive Mode

Activates overdrive mode for 1 hour, maxing out all automation frequencies for rapid iteration. The usage optimizer is paused during overdrive to prevent it from scaling frequencies back.

The prefetch hook has pre-gathered the current automation config and injected it as a `[PREFETCH:overdrive]` systemMessage above. Use that data for Step 1 instead of reading the file. If the prefetch data is missing, read the file directly.

## What This Does

Overdrive temporarily sets all automation cooldowns to their minimum useful values:

| Automation | Default | Overdrive |
|-----------|---------|-----------|
| hourly_tasks | 55 min | 10 min |
| lint_checker | 30 min | 10 min |
| task_runner | 60 min | 10 min |
| todo_maintenance | 15 min | 5 min |
| antipattern_hunter | 360 min | 60 min |
| standalone_antipattern_hunter | 180 min | 60 min |
| standalone_compliance_checker | 60 min | 15 min |
| preview_promotion | 360 min | 60 min |
| staging_health_monitor | 180 min | 30 min |
| production_health_monitor | 60 min | 15 min |
| user_feedback | 120 min | 30 min |
| schema_mapper | 1440 min | 120 min |
| triage_per_item | 60 min | 15 min |
| test_failure_reporter | 120 min | 30 min |
| compliance_checker_file | 10080 min | 1440 min |
| compliance_checker_spec | 10080 min | 1440 min |

**Unchanged (at floor or stability-gated):**
- `triage_check`: 5 min (already at floor)
- `pre_commit_review`: 5 min (already at floor)
- `staging_promotion`: 1200 min (24h stability gate)

**Concurrency:** MAX_CONCURRENT_AGENTS raised from 5 to 8.

## What This Preserves

- CTO activity gate (24h briefing requirement) - NOT bypassed
- `enabled: false` automation toggle - NOT bypassed
- Staging-to-production promotion 24h stability gate - NOT changed

## Flow

### Step 1: Read Current State

Read `.claude/state/automation-config.json` and check if `overdrive` section exists and is active.

### Step 2: Handle Current State

**If overdrive is active and NOT expired:**

Display current overdrive status:
```
OVERDRIVE MODE: ACTIVE
Activated: {activated_at}
Expires: {expires_at} ({minutes remaining} min remaining)
Concurrency: {max_concurrent_override} agents
Factor frozen at: {previous_state.factor}
```

Use `AskUserQuestion`:
- **Question:** "Overdrive is currently active. What would you like to do?"
- **Header:** "Overdrive"
- **Options:**
  - "Extend +60 minutes" - Push expiry forward by 1 hour
  - "Deactivate now" - Revert to previous state immediately
  - "Show status only" - Just display current state

If "Extend +60 minutes":
- Read the config, update `overdrive.expires_at` to current `expires_at` + 60 minutes
- Write the config back
- Display new expiry time

If "Deactivate now":
- Read the config
- Restore `config.effective = config.overdrive.previous_state.effective`
- Restore `config.adjustment.factor = config.overdrive.previous_state.factor`
- Set `config.overdrive.active = false`
- Write config
- Display "Overdrive deactivated. Previous cooldowns restored."

**If overdrive is active but EXPIRED:**

Display: "Overdrive was active but has expired. It will be auto-reverted on the next optimizer cycle."
Then treat as inactive (offer activation).

**If overdrive is inactive (or no overdrive section):**

Display current automation state summary, then use `AskUserQuestion`:
- **Question:** "Activate overdrive mode? All automation frequencies will be maxed for 1 hour."
- **Header:** "Overdrive"
- **Options:**
  - "Activate overdrive (1 hour)" (Recommended)
  - "Cancel"

### Step 3: Activate Overdrive

If user confirms activation:

1. Read `.claude/state/automation-config.json`
2. Save current state:
   ```json
   {
     "overdrive": {
       "active": true,
       "activated_at": "<ISO now>",
       "expires_at": "<ISO now + 1 hour>",
       "previous_state": {
         "factor": "<current config.adjustment.factor or 1.0>",
         "effective": "<current config.effective or {}>"
       },
       "max_concurrent_override": 8,
       "overdrive_effective": {
         "triage_check": 5,
         "hourly_tasks": 10,
         "lint_checker": 10,
         "task_runner": 10,
         "todo_maintenance": 5,
         "antipattern_hunter": 60,
         "standalone_antipattern_hunter": 60,
         "standalone_compliance_checker": 15,
         "preview_promotion": 60,
         "staging_promotion": 1200,
         "staging_health_monitor": 30,
         "production_health_monitor": 15,
         "user_feedback": 30,
         "schema_mapper": 120,
         "triage_per_item": 15,
         "test_failure_reporter": 30,
         "pre_commit_review": 5,
         "compliance_checker_file": 1440,
         "compliance_checker_spec": 1440
       }
     }
   }
   ```
3. Set `config.effective` to the overdrive values
4. Write the config

### Step 4: Display Summary

```
OVERDRIVE ACTIVATED

Duration: 1 hour (expires at {expires_at})
Concurrency: 5 -> 8 agents
Previous factor: {factor} (will be restored on expiry)

Key changes:
  hourly_tasks:    55 min -> 10 min
  task_runner:     60 min -> 10 min
  antipattern:    360 min -> 60 min
  compliance:   10080 min -> 1440 min

The usage optimizer will NOT adjust cooldowns during overdrive.
Overdrive will auto-revert when it expires.
To deactivate early: /overdrive-gentyr
```

## Implementation Notes

- The config file is at `.claude/state/automation-config.json`
- Use `fs.readFileSync` and `fs.writeFileSync` to read/write
- Always ensure the `version: 1` field is preserved in the config
- If config file doesn't exist, create it with version: 1 and the overdrive section
