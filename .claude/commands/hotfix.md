<!-- HOOK:GENTYR:hotfix -->
# Emergency Hotfix Promotion

Use this command when production is broken and a fix has already landed on staging.

## Prerequisites

- The fix must already be merged to staging
- You must be the CTO or have CTO-level authorization

## Steps

1. Call `mcp__deputy-cto__request_hotfix_promotion` to validate staging has unreleased commits and get an approval code
2. Present the approval code to the user and tell them to type: `APPROVE HOTFIX <code>`
3. Wait for the user to type the approval
4. After approval, call `mcp__deputy-cto__execute_hotfix_promotion` to trigger the immediate staging→main promotion
5. Report the result to the user

## What Happens

- The staging→main promotion runs immediately, bypassing:
  - The 24-hour stability requirement
  - The midnight deployment window
- Code review and deputy-CTO approval still apply (via the spawned promotion agent)
- The promotion uses an isolated worktree to avoid disrupting other work

## Safety

- Approval codes expire after 5 minutes
- Each code can only be used once (HMAC-signed, consumed on use)
- Only the CTO can approve (requires typing in the terminal — agents cannot trigger UserPromptSubmit hooks)
