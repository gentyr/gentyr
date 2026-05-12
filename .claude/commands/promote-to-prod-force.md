# Force Promote Staging to Production

Emergency direct promotion of staging to main, bypassing all quality gates.
Gated by CTO authorization system — the MCP tool verifies a CTO decision exists before executing.

## Steps

### Step 1: Fetch and Check Drift

```bash
git fetch origin staging main --quiet
```

```bash
git log --oneline origin/main..origin/staging
```

If the output is empty: Show "Staging and main are in sync. Nothing to promote." and stop.

### Step 2: Show Summary

Show the commit count and changed files:

```bash
git diff --stat origin/main..origin/staging | tail -3
```

### Step 3: CTO Confirmation

Ask the CTO:

> **FORCE PRODUCTION PROMOTION**
>
> This will merge **{N} commits** from staging to main **WITHOUT quality gates** (no tests, no demos, no code review, no migration safety check).
>
> Type "FORCE PROMOTE" to confirm.

Wait for the CTO to type their confirmation. Do NOT proceed until they respond.

### Step 4: Record CTO Decision

Generate a unique decision ID: `force-prod-{Date.now()}`

Call:

```
mcp__agent-tracker__record_cto_decision({
  decision_type: "force_prod_promotion",
  decision_id: "<generated decision ID>",
  verbatim_text: "<CTO's exact words from Step 3>"
})
```

If the decision is not verified (status is not `verified`), show the error and stop.

### Step 5: Execute Force Promotion

Call:

```
mcp__deputy-cto__force_promote_to_prod({ decision_id: "<decision ID from Step 4>" })
```

The tool verifies the CTO decision exists, then creates a PR from staging to main, merges it, and returns the result.

If the tool returns an error about "audit still pending", wait 30 seconds and retry once. The authorization auditor needs time to verify.

### Step 6: Show Result

Show the CTO the result from the tool:

> **Production promotion complete.**
>
> PR: {pr_url}
> Commits promoted: {commits_promoted}
> Decision ID: {decision_id}
