<!-- HOOK:GENTYR:hotfix -->
# Emergency Hotfix Promotion

Use this command when production is broken and a fix has already landed on staging.

## Prerequisites

- The fix must already be merged to staging
- You must be the CTO running this interactively (record_cto_decision is gated to interactive sessions only)

## Steps

1. **Gather commits** — Run these in Bash:
   ```bash
   git fetch origin staging main
   git log origin/main..origin/staging --oneline
   ```
   If the second command returns nothing, tell the user "nothing to hotfix — staging is even with main" and stop.

2. **Check the staging lock**:
   ```bash
   cat .claude/state/staging-lock.json 2>/dev/null
   ```
   If the file exists and `locked` is `true`, stop and tell the user: "Hotfix blocked — staging is locked for an active production release. Complete or cancel the release via /promote-to-prod first."

3. **Show the commits to the CTO and ask for approval in their own words.** Example phrasing:

   > Found N commits on staging ahead of main:
   > ```
   > abc1234 fix(auth): patch jwt verifier
   > def5678 chore(deps): bump ws to 8.16.0
   > ```
   > Should I emergency-promote these to main? This bypasses the 24-hour stability gate and the midnight deployment window. Please reply with an explicit approval (e.g. "yes, ship it") or hold off.

   Wait for the CTO's response. The auditor will fail the approval if the verbatim text is ambiguous (questions, hesitations, casual "sure") — capture an unambiguous reply.

4. **Call execute_hotfix_promotion** with the exact commit lines from step 1:
   ```
   mcp__deputy-cto__execute_hotfix_promotion({ commits: ["abc1234 fix(auth): patch jwt verifier", "def5678 chore(deps): bump ws to 8.16.0"] })
   ```
   The `protected-action-gate` will intercept this and return a denial that contains a `deferred_action_id`. Extract that ID — that's what record_cto_decision needs.

5. **Record the CTO's verbatim approval**:
   ```
   mcp__agent-tracker__record_cto_decision({
     decision_type: "hotfix_promotion",
     decision_id: "<deferred_action_id from step 4>",
     verbatim_text: "<CTO's exact reply word-for-word>"
   })
   ```
   `record_cto_decision` will verify the verbatim text appears in this session's JSONL and HMAC-bind the decision.

6. **Report and exit.** Tell the user:
   - The decision is recorded
   - An `authorization-auditor` is being spawned in the audit lane
   - It will verify (a) commits were shown verbatim before approval, (b) the approval is unambiguous, (c) `args.commits` still matches `origin/main..origin/staging`, and (d) staging is not locked
   - On audit pass, a `hotfix-promotion` agent auto-spawns at `critical` priority and merges staging→main
   - Watch progress with `/monitor` or `mcp__agent-tracker__get_session_queue_status`

## What Happens

- staging→main promotion runs immediately, bypassing:
  - The 24-hour stability requirement
  - The midnight deployment window
- Code review still runs (the hotfix-promotion agent spawns a code-reviewer sub-agent first)
- The promotion uses an isolated worktree to avoid disrupting other work

## Safety

- The CTO approves in their own words — no codes, no phrase matching, no token files
- The verbatim approval text is verified to exist in the CTO's session JSONL (`record_cto_decision`)
- An independent `authorization-auditor` re-runs `git log` and verifies the commits the CTO approved match the current staging state — if staging moved between approval and audit, the audit fails and the CTO must re-approve against the new commit set
- The deferred action's args are SHA256-hashed at creation time — agents cannot bait-and-switch the commits between approval and execution
