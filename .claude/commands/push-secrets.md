# /push-secrets - Push 1Password Secrets to Render & Vercel

Sync secrets from 1Password to Render and Vercel environment variables using the `secret-sync` MCP server. Secret values never pass through the agent's context window.

## Security Notes

- The `secret-sync` MCP server handles all secret reading and pushing internally
- Secret values are NEVER exposed to the agent — only key names and sync status are returned
- Each sync operation is protected by GENTYR CTO gates
- Requires `OP_SERVICE_ACCOUNT_TOKEN`, `RENDER_API_KEY`, and/or `VERCEL_TOKEN` configured via `/setup-gentyr`

## Push Flow

### Step 0: Check Configuration

1. Call `mcp__secret-sync__list_mappings` to verify services.json exists and has mappings
2. If no mappings are configured, inform the user:
   - "No secret mappings found in `.claude/config/services.json`"
   - "Configure mappings first, then run `/push-secrets` again"
   - Show the expected services.json structure with op:// references
3. If mappings exist, display the mapping table (key names and op:// references, no values)

### Step 1: Choose Target

Use `AskUserQuestion` to ask:

**Question:** "Which services should receive secrets from 1Password?"

**Header:** "Target"

**Options (multiSelect: true):**
- Option 1: "Render Production" — Push to production backend
- Option 2: "Render Staging" — Push to staging backend
- Option 3: "Vercel" — Push to frontend project
- Option 4: "All services" — Push to everything

### Step 2: Confirm

Based on the selection, show the user how many secrets will be synced.

Use `AskUserQuestion`:

**Question:** "This will sync {N} secrets to {services}. Proceed?"

**Header:** "Confirm"

**Options:**
- Option 1: "Yes, sync secrets" — Proceed
- Option 2: "Show mapping first" — Call `mcp__secret-sync__list_mappings` and display
- Option 3: "Cancel" — Abort

### Step 3: Sync

For each selected target, call `mcp__secret-sync__sync_secrets`:

```
mcp__secret-sync__sync_secrets({ target: "render-production" })
mcp__secret-sync__sync_secrets({ target: "render-staging" })
mcp__secret-sync__sync_secrets({ target: "vercel" })
```

Or for all at once:
```
mcp__secret-sync__sync_secrets({ target: "all" })
```

### Step 4: Report Results

Display the results from `sync_secrets`:
- List each key and whether it was created, updated, or errored
- If there were errors, show which keys failed and the error messages
- If there are manual entries in `services.json`, remind the user about them

### Step 5: Verify (optional)

Ask the user if they want to verify:

Use `AskUserQuestion`:

**Question:** "Verify that all secrets exist on target services?"

**Header:** "Verify"

**Options:**
- Option 1: "Yes, verify" — Call `mcp__secret-sync__verify_secrets` and display results
- Option 2: "No, done" — Skip verification

## Important

- NEVER attempt to read secrets directly via `mcp__onepassword__read_secret` — use `secret-sync` instead
- NEVER log, echo, or display secret values — only show key names and sync status
- If sync fails partway through, the `secret-sync` server reports which keys succeeded and which failed
- To update existing secrets (rotation), run this command again — it will overwrite existing values
- Run `/setup-gentyr` first to configure credentials if `secret-sync` server is not available
