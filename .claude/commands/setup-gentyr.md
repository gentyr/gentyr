<!-- HOOK:GENTYR:setup-gentyr -->
# /setup-gentyr - GENTYR Framework Setup

One command for full GENTYR project setup. Runs a programmatic check script, displays results, guides through missing credentials using the setup documentation, and writes vault mappings for the MCP launcher to resolve at runtime.

The prefetch hook has pre-run `setup-check.js` and injected its JSON output as `[PREFETCH:setup-gentyr]` context above. Use that data for Phase 1 instead of running the script. If the prefetch data is missing, run the script directly.

## Security Architecture

- **No credentials on disk.** Vault mappings (`.claude/vault-mappings.json`) contain only `op://` references and non-secret identifiers, not actual secret values.
- **Runtime resolution.** The MCP launcher (`scripts/mcp-launcher.js`) resolves credentials from 1Password when each MCP server starts.
- **Credentials in memory only.** Secret values exist only in the MCP server process memory.
- **credential-file-guard.js** blocks agents from reading `.mcp.json` (defense-in-depth, since `.mcp.json` contains no credentials with the launcher architecture).
- **OP_SERVICE_ACCOUNT_TOKEN** is injected into `.mcp.json` by the install script (`--op-token` arg), not stored in vault-mappings.json.

## Credential Classification

The `setup-check.js` script is the authoritative source for credential classification. The table below is for human reference.

| Key | Type | Predefined Path |
|-----|------|----------------|
| GITHUB_TOKEN | secret | op://Production/GitHub/token |
| GITHUB_PAT | secret | op://Production/GitHub/token |
| RENDER_API_KEY | secret | op://Production/Render/api-key |
| VERCEL_TOKEN | secret | op://Production/Vercel/token |
| CLOUDFLARE_API_TOKEN | secret | op://Production/Cloudflare/api-token |
| CLOUDFLARE_ZONE_ID | identifier | (direct value) |
| SUPABASE_SERVICE_ROLE_KEY | secret | op://Production/Supabase/service-role-key |
| SUPABASE_ANON_KEY | identifier | (direct value — public key, no protected actions) |
| SUPABASE_URL | identifier | (direct value) |
| RESEND_API_KEY | secret | op://Production/Resend/api-key |
| ELASTIC_API_KEY | secret | op://Production/Elastic/api-key-query |
| ELASTIC_CLOUD_ID | identifier | (direct value — hosted deployments) |
| ELASTIC_ENDPOINT | identifier | (direct value — Serverless projects, alternative to ELASTIC_CLOUD_ID) |
| CODECOV_TOKEN | secret | op://Production/Codecov/token |
| OP_CONNECT_TOKEN | secret | op://Production/1Password/connect-token |
| SUPABASE_ACCESS_TOKEN | secret | op://Production/Supabase/access-token |
| OP_SERVICE_ACCOUNT_TOKEN | special | (injected via setup.sh --op-token, not in vault-mappings) |

## Setup Flow

**Output Format:** All status output MUST use the exact format templates in this document. Generate dynamically from JSON data — do NOT ad-lib or freestyle formatting. Use ✓ for pass/configured, ✗ for fail/missing, ⚠ for warn, ○ for skip.

### Phase 1: Run Setup Check

Run the programmatic setup-check script to get complete project state in one call:

```bash
node node_modules/gentyr/scripts/setup-check.js 2>/dev/null
```

Parse the JSON output. This single call determines everything — do NOT run individual `op` commands to check credentials. The script checks:
- GENTYR installation
- 1Password CLI availability and authentication
- Vault-mappings.json current state
- Each secret's existence at its predefined `op://` path in 1Password
- Each identifier's presence in vault-mappings.json

**Decision tree based on JSON output:**

1. If `gentyrInstalled === false`:
   - Inform the user: "GENTYR is not installed."
   - Provide: `sudo node_modules/gentyr/scripts/reinstall.sh --path $(pwd) --op-token <token>`
   - Stop and wait for user to complete this step and restart their Claude Code session.

2. If `opCliAvailable === false`:
   - Inform the user: "1Password CLI (`op`) is not installed."
   - Provide: `brew install --cask 1password-cli`
   - Then: "Connect to your 1Password account and re-run `/setup-gentyr`"
   - Stop here.

3. If `opAuthenticated === false` and secrets have `existsInOp === null`:
   - Inform the user: "1Password is not authenticated."
   - Provide: `op signin` or "Set OP_SERVICE_ACCOUNT_TOKEN"
   - Stop here and wait for user to authenticate, then re-run `/setup-gentyr`.

4. Display the credential status table from the `credentials` object. Format:
   ```
   Credential Status (X of Y configured):

   Secrets (1Password):
     [check/x] GITHUB_TOKEN — exists in 1Password / MISSING from 1Password
     [check/x] RENDER_API_KEY — ...
     ...

   Identifiers (direct values):
     [check/x] CLOUDFLARE_ZONE_ID — configured / not configured
     [check/x] SUPABASE_URL — configured / not configured
     ...
   ```

5. If everything is configured (`summary.secretsMissing === 0` and `summary.identifiersMissing === 0`), skip to Phase 5 (Write Vault Mappings).

6. Otherwise, proceed to Phase 2 (account inventory), Phase 3 (missing secrets), and Phase 4 (missing identifiers).

### Phase 2: Claude Account Inventory

The prefetch hook injected account inventory data in `[PREFETCH:setup-gentyr]`.

1. **Display current account inventory** from `gathered.accountInventory`:
   ```
   Claude Accounts ({N} detected):

     ✓ user@example.com — active (5h: 45%, 7d: 30%) [Max plan]
     ✗ user2@example.com — expired (last seen 2d ago)
     ○ (no other accounts)

   Active key: a1b2c3d4... | Available quota headroom: ~55%
   ```

   If `gathered.accountInventory` is null, display: "No account rotation state found. Run `/login` to authenticate your first Claude account."

   For accounts where `email` is null (profile not yet fetched), show the `keyId` prefix instead.

2. **Ask if user wants to add another account**:
   Use `AskUserQuestion`:
   - "Do you want to add another Claude account for quota rotation?"
   - Options: "Yes, add an account" / "No, continue setup"

3. **If yes — guide through login**:
   a. Instruct: "Run `/login` now. This will open your browser to authenticate with a different Claude account."
   b. Wait for user to confirm they've completed the login.
   c. **Detect the new account** by running:
      ```bash
      node --input-type=module -e "
      import { syncKeys, readRotationState, checkKeyHealth } from './.claude/hooks/key-sync.js';
      const sync = await syncKeys(console.error);
      const state = readRotationState();
      const accounts = new Map();
      for (const [id, k] of Object.entries(state.keys)) {
        if (k.status === 'invalid') continue;
        const key = k.account_uuid || id;
        if (!accounts.has(key)) accounts.set(key, { ...k, keyId: id });
      }
      console.log(JSON.stringify({
        keysAdded: sync.keysAdded,
        tokensRefreshed: sync.tokensRefreshed,
        totalKeys: Object.keys(state.keys).length,
        accounts: [...accounts.values()].map(a => ({
          email: a.account_email, status: a.status,
          usage: a.last_usage, subscription: a.subscriptionType,
        })),
      }));
      "
      ```
   d. **Parse output and confirm to user**:
      - If `keysAdded > 0`: "New account detected! {email}" + updated inventory table
      - If `keysAdded === 0` but `tokensRefreshed > 0`: "Account token refreshed for {email}"
      - If neither: "No new account found. Make sure you logged in with a different account."
   e. **Loop back to step 2** — ask if they want to add another account.

4. **When done** (user says "No, continue setup"), proceed to Phase 3 (Missing Secrets).

### Phase 3: Guide User Through Missing Secrets

For each credential in the JSON output where `type === "secret"` AND (`existsInOp === false` OR `mappedInVault === false`):

1. **Group by `setupGuidePhase`** — deduplicate so you show each guide section only once. For example, GITHUB_TOKEN and GITHUB_PAT share `"Phase 2: GitHub Token"`, so show that section once.

2. **Read** `node_modules/gentyr/docs/SETUP-GUIDE.md`.

3. For each unique `setupGuidePhase` value (e.g., `"Phase 5: Cloudflare API Token"`):
   a. Find the section matching the heading `## {setupGuidePhase}` in SETUP-GUIDE.md.
   b. Extract the content from that heading until the next `## Phase` heading (or end of file).
   c. **Present the section's instructions to the user nearly verbatim.** Include both the service creation steps AND the "1Password Storage" block (vault, item title, field names, predefined path).
   d. List which credential keys from the JSON output this section covers.

4. After presenting instructions for a missing secret, wait for the user to confirm they've created the 1Password item.

5. **Re-run the setup-check script** to verify the item was created:
   ```bash
   node node_modules/gentyr/scripts/setup-check.js 2>/dev/null
   ```
   Check the updated `existsInOp` value. If still `false`, inform the user and offer to skip.

6. If the user wants to skip a credential, note it and move on. They can re-run `/setup-gentyr` later.

**IMPORTANT:** NEVER read the actual secret value. The setup-check script only checks existence (never reads values). You should only display the credential name and its `op://` reference.

### Phase 4: Collect Non-Secret Identifiers

For each credential in the JSON output where `type === "identifier"` AND `mappedInVault === false`:

1. **Read** `node_modules/gentyr/docs/SETUP-GUIDE.md`.

2. Find the `setupGuidePhase` section and locate the **"Non-secret (share in chat during /setup-gentyr):"** subsection within it.

3. **Present the non-secret instructions to the user nearly verbatim.** This tells them where to find the value (e.g., "Cloudflare Dashboard > your domain > right sidebar under API").

4. Use `AskUserQuestion` to collect the value:
   - **Question:** Based on the SETUP-GUIDE.md description (e.g., "What is your Cloudflare Zone ID? (32-character hex string from Cloudflare Dashboard > your domain > API sidebar)")
   - **Header:** The credential name (e.g., "Zone ID")
   - **Options:** "I'll provide it" + "Skip for now"

5. If the user provides a value, note it for Phase 5 (vault-mappings write). These are NOT `op://` references — they are stored as direct values.

### Phase 5: Write Vault Mappings

Write `.claude/vault-mappings.json` with:
- `op://` references for all secrets whose `existsInOp === true` (use the `opPath` from the JSON output)
- Direct values for non-secret identifiers collected in Phase 4
- Preserve any existing mappings that are still valid

File: `.claude/vault-mappings.json`
```json
{
  "provider": "1password",
  "mappings": {
    "GITHUB_TOKEN": "op://Production/GitHub/token",
    "GITHUB_PAT": "op://Production/GitHub/token",
    "RENDER_API_KEY": "op://Production/Render/api-key",
    "VERCEL_TOKEN": "op://Production/Vercel/token",
    "CLOUDFLARE_API_TOKEN": "op://Production/Cloudflare/api-token",
    "CLOUDFLARE_ZONE_ID": "abc123def456...",
    "SUPABASE_SERVICE_ROLE_KEY": "op://Production/Supabase/service-role-key",
    "SUPABASE_URL": "https://abcdefghijklmnop.supabase.co",
    "SUPABASE_ANON_KEY": "eyJhbGci...",
    "RESEND_API_KEY": "op://Production/Resend/api-key",
    "ELASTIC_API_KEY": "op://Production/Elastic/api-key-query",
    "ELASTIC_CLOUD_ID": "my-deployment:dXMtY2VudH...",
    "CODECOV_TOKEN": "op://Production/Codecov/token",
    "OP_CONNECT_TOKEN": "op://Production/1Password/connect-token",
    "SUPABASE_ACCESS_TOKEN": "op://Production/Supabase/access-token"
  }
}
```

**Note:** For Elastic Serverless projects, use `ELASTIC_ENDPOINT` instead of `ELASTIC_CLOUD_ID`:
```json
    "ELASTIC_ENDPOINT": "https://my-project-abc123.es.us-central1.gcp.elastic.cloud"
```
Only one of `ELASTIC_CLOUD_ID` or `ELASTIC_ENDPOINT` should be present. The setup-check.js `altKey` mechanism treats them as alternatives.

This file is NOT blocked by credential-file-guard (it contains only `op://` references and non-secret identifiers).

**Credential-to-server mapping reference:**

| Credential | Server(s) | Env Var |
|-----------|-----------|---------|
| GitHub Token | `github` | `GITHUB_TOKEN` |
| GitHub PAT | `github` | `GITHUB_PAT` |
| Render API Key | `render`, `secret-sync` | `RENDER_API_KEY` |
| Vercel Token | `vercel`, `secret-sync` | `VERCEL_TOKEN` |
| Cloudflare Token | `cloudflare` | `CLOUDFLARE_API_TOKEN` |
| Cloudflare Zone ID | `cloudflare` | `CLOUDFLARE_ZONE_ID` |
| Supabase URL | `supabase` | `SUPABASE_URL` |
| Supabase Service Role Key | `supabase` | `SUPABASE_SERVICE_ROLE_KEY` |
| Supabase Anon Key | `supabase` | `SUPABASE_ANON_KEY` |
| Supabase Access Token | `supabase` | `SUPABASE_ACCESS_TOKEN` |
| 1Password Connect Token | `onepassword` | `OP_CONNECT_TOKEN` |
| Elastic API Key | `elastic-logs` | `ELASTIC_API_KEY` |
| Elastic Cloud ID | `elastic-logs` | `ELASTIC_CLOUD_ID` (hosted) |
| Elastic Endpoint | `elastic-logs` | `ELASTIC_ENDPOINT` (Serverless, alternative to Cloud ID) |
| Resend API Key | `resend` | `RESEND_API_KEY` |
| Codecov Token | `codecov` | `CODECOV_TOKEN` |

### Phase 6: Service Config

If `.claude/config/services.json` does not exist:

1. Use `AskUserQuestion` to collect:
   - Render Production service ID (e.g., `srv-xxx`)
   - Render Staging service ID (e.g., `srv-yyy`)
   - Vercel project ID (e.g., `prj_xxx`)
2. Create `.claude/config/services.json` with the provided values and empty secret mappings
3. Inform the user they can populate the `secrets` section later for `/push-secrets` to use

### Phase 7: Verify & Validate

This phase is **mandatory** — always run both scripts, never ask the user if they want validation.

1. **Re-run setup-check** to confirm final credential state:
   ```bash
   node node_modules/gentyr/scripts/setup-check.js 2>/dev/null
   ```

2. **Run permission validation** (always — do NOT offer this as optional):
   ```bash
   node node_modules/gentyr/scripts/setup-validate.js 2>/dev/null
   ```

3. **Display combined results** using this exact format (dynamically populated from the two JSON outputs):

   ```
   ═══════════════════════════════════════════════════
   GENTYR Setup Status
   ═══════════════════════════════════════════════════

   Credential Mapping ({secretsConfigured + identifiersConfigured} of {totalCredentials}):

   Secrets (1Password):
   ✓ {KEY} → {opPath}
   ✗ {KEY} — MISSING

   Identifiers:
   ✓ {KEY} → configured
   ✗ {KEY} — not configured

   Permission Validation ({passed} of {totalServices} services):
   ✓ {service} — {message}
   ⚠ {service} — {message}
   ✗ {service} — {message}
   ○ {service} — {message}
   ```

   Use ✓ for pass/configured, ✗ for fail/missing, ⚠ for warn, ○ for skip. Populate dynamically from JSON — every credential and every service must appear.

4. **For any missing credentials** (`existsInOp === false` OR `mappedInVault === false`):
   - Read `node_modules/gentyr/docs/SETUP-GUIDE.md`
   - Find the section matching the credential's `setupGuidePhase` heading (e.g., `## Phase 6: Supabase Credentials`)
   - **Output the entire section verbatim** — from the `## Phase N` heading through to the next `## Phase` heading (or end of file). Do NOT paraphrase, summarize, or reformat.
   - List which credential keys from the JSON output this section covers
   - Wait for the user to confirm they've completed the step
   - Re-run `setup-check.js` to verify the item was created

5. **For any failed validations** (status: `fail`):
   - Output the `remediation` text from the validation JSON
   - Also read and output the relevant `node_modules/gentyr/docs/SETUP-GUIDE.md` section for context
   - Wait for user to fix, then re-run `setup-validate.js`

6. **Warnings** (status: `warn`) are informational, not blocking. Display the `remediation` text but proceed.

7. **Proceed to Phase 8** when:
   - All credentials are mapped (`secretsMissing === 0` and `identifiersMissing === 0`)
   - No validation failures (warns are acceptable)

8. Remind the user: **"Restart Claude Code to activate the updated credential mappings."**

### Phase 8: Branch Protection & Deployment Pipeline

After verifying MCP servers, set up the deployment pipeline:

1. **Create branches** (if missing):
```bash
# Check if preview and staging branches exist
git rev-parse --verify origin/preview 2>/dev/null || (git branch preview && git push -u origin preview)
git rev-parse --verify origin/staging 2>/dev/null || (git branch staging && git push -u origin staging)
```

2. **Install merge-chain-check workflow**:
   - Check if `.github/workflows/merge-chain-check.yml` exists
   - If missing, copy from GENTYR template: `${FRAMEWORK_PATH}/templates/config/merge-chain-check.yml.template`
   - This workflow enforces the merge chain: `feature/* -> preview -> staging -> main`

3. **Verify `gh` CLI**:
```bash
gh auth status
```
   - If not authenticated, inform the user to run `gh auth login`

4. **Branch protection setup**:
   - Use `AskUserQuestion` to ask: "Which GitHub plan are you on?"
     - Option 1: "Teams" -- Show Teams-compatible branch protection instructions
     - Option 2: "Enterprise Cloud" -- Show Enterprise instructions with additional features
   - Display the branch protection instructions from `node_modules/gentyr/docs/DEPLOYMENT-FLOW.md` (Branch Protection Setup section)
   - Use `AskUserQuestion`: "Have you configured branch protection rules for preview, staging, and main?"
     - Option 1: "Yes, all configured"
     - Option 2: "I'll do it later"

5. **Enable automated promotion**:
   - Read `.claude/autonomous-mode.json`
   - Add/update flags:
     - `previewPromotionEnabled: true`
     - `stagingPromotionEnabled: true`
     - `stagingHealthMonitorEnabled: true`
     - `productionHealthMonitorEnabled: true`
   - Write back to `.claude/autonomous-mode.json`

6. **Update summary** to include:
   ```
   Deployment Pipeline:
   + preview branch exists
   + staging branch exists
   + merge-chain-check.yml installed
   + gh CLI authenticated
   o Branch protection (configure manually in GitHub Settings)
   + Automated promotion enabled
   + Health monitoring enabled

   Merge chain: feature/* -> preview -> staging -> main
   Promotion: preview->staging (6h), staging->main (nightly)
   Health: staging (3h), production (1h)
   ```

## Important

- NEVER echo, log, or display resolved credential values -- only show the credential name and `op://` reference
- NEVER store actual credential values in any file -- only `op://` references and non-secret identifiers go in `vault-mappings.json`
- If a user skips a credential, note it and move on -- they can run `/setup-gentyr` again later
- Re-running `/setup-gentyr` is safe -- it reads existing mappings and only prompts for missing ones
- All infrastructure MCP servers are designed to fail gracefully if credentials are missing
- The MCP launcher resolves credentials from 1Password at server startup time
- Non-secret identifiers (URLs, zone IDs) are stored directly in vault-mappings.json without 1Password
- OP_SERVICE_ACCOUNT_TOKEN is handled by the install script, not this command
- Always use `setup-check.js` for evaluation -- do NOT run individual `op` commands
- Always read SETUP-GUIDE.md and present instructions nearly verbatim -- do NOT paraphrase or summarize
