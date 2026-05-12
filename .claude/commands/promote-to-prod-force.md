# Force Promote Staging to Production

Emergency direct promotion of staging to main, bypassing all quality gates.
Gated by CTO approval system for audit trail.

## Steps

### Step 1: Fetch Latest Branches

```bash
git fetch origin staging main --quiet
```

### Step 2: Check Drift

```bash
git log --oneline origin/main..origin/staging
```

If the output is empty: Show "Staging and main are in sync. Nothing to promote." and stop.

### Step 3: Show Summary

Count the commits from Step 2 and show the changed files summary:

```bash
git diff --stat origin/main..origin/staging | tail -3
```

### Step 4: CTO Confirmation

Ask the CTO:

> **FORCE PRODUCTION PROMOTION**
>
> This will merge **{N} commits** from staging to main **WITHOUT quality gates** (no tests, no demos, no code review, no migration safety check).
>
> Type "FORCE PROMOTE" to confirm.

Wait for the CTO to type their confirmation. Do NOT proceed until the CTO responds.

### Step 5: Record CTO Decision

Generate a unique decision ID using the format: `force-prod-{timestamp}` (e.g., `force-prod-1778512110189`).

Call:

```
mcp__agent-tracker__record_cto_decision({
  decision_type: "force_prod_promotion",
  decision_id: "<generated decision ID>",
  verbatim_text: "<CTO's exact words from Step 4>"
})
```

If the decision is not verified (status is not `verified`), show the error and stop.

### Step 6: Create and Merge PR

Create the PR:

```bash
gh pr create --base main --head staging --title "FORCE: promote staging → main ({N} commits)" --body "CTO-authorized force promotion. No quality gates applied. Decision ID: {decision_id}."
```

Extract the PR number from the output, then merge:

```bash
gh pr merge {number} --merge
```

If merge fails due to required status checks, retry with admin bypass:

```bash
gh pr merge {number} --merge --admin
```

### Step 7: Show Result

After the merge completes, fetch the PR URL:

```bash
gh pr view {number} --json url -q .url
```

Show the CTO:

> **Production promotion complete.**
>
> PR: {url}
> Commits promoted: {N}
> Decision ID: {decision_id}
