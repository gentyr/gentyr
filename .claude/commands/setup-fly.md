# /setup-fly - Configure Fly.io Remote Playwright Execution

Sets up Fly.io as a remote execution target for headless Playwright demos. When configured,
headless demos auto-route to Fly.io machines, freeing local display resources and enabling
parallel execution across multiple machines.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Step 1: Check Current Configuration

Read services.json to determine if Fly.io is already configured:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const servicesPath = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'config', 'services.json');
try {
  const config = JSON.parse(fs.readFileSync(servicesPath, 'utf8'));
  console.log(JSON.stringify({ exists: true, fly: config.fly || null }));
} catch {
  console.log(JSON.stringify({ exists: false, fly: null }));
}
"
```

### If already configured (`fly.enabled !== false` and `fly.appName` is set):

Call `mcp__playwright__get_fly_status()` and display the result:

```
Fly.io Remote Execution Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  App name:      {fly.appName}
  Region:        {fly.region}
  Machine count: {status.machineCount}
  Status:        {status.healthy ? "Healthy" : "Degraded"}

  {status.machines[].id}: {state} in {region}
```

If the status shows `healthy: true`, report that Fly.io is configured and working, then stop.

If the status shows errors or `healthy: false`, continue to the troubleshooting section at the end of this command.

### If not configured (or services.json missing):

Continue to Step 2.

## Step 2: Check flyctl Installation

```bash
which flyctl 2>/dev/null || echo "NOT_FOUND"
```

If `NOT_FOUND`:

Inform the user:

> **flyctl is not installed.** Install it first:
>
> ```bash
> brew install flyctl
> ```
>
> Or via the official installer:
> ```bash
> curl -L https://fly.io/install.sh | sh
> ```
>
> After installing, re-run `/setup-fly`.

Stop here until flyctl is installed.

## Step 3: Check Fly.io Account

```bash
flyctl auth whoami 2>/dev/null || echo "NOT_AUTHENTICATED"
```

### If authenticated:

Display the current account email and continue to Step 4.

### If `NOT_AUTHENTICATED`:

Ask the user:

> **You are not logged in to Fly.io.** Do you have a Fly.io account?

Use `AskUserQuestion`:
- Option 1: "Yes, I have an account — log me in"
- Option 2: "No, I need to create an account"
- Option 3: "Cancel setup"

**If Option 1 (existing account):**

Instruct: "Run `flyctl auth login` in your terminal. This opens your browser to authenticate."
Wait for user to confirm they've logged in, then re-check:
```bash
flyctl auth whoami 2>/dev/null || echo "NOT_AUTHENTICATED"
```
If still `NOT_AUTHENTICATED`, prompt the user to try again and stop.

**If Option 2 (new account):**

Inform the user:

> **Creating a Fly.io account via browser.** You can sign up at https://fly.io/app/sign-up
> or run `flyctl auth signup` in your terminal.
>
> After creating your account, run `flyctl auth login` to authenticate, then re-run `/setup-fly`.

Stop here. The user must complete signup externally.

**If Option 3 (cancel):**

Stop without making changes.

## Step 4: Collect Configuration

Use `AskUserQuestion` to collect the app name:

**Question:** "What name should the Fly.io app have? This becomes the DNS hostname: {name}.fly.dev"

**Header:** "App Name"

Suggest a default based on the project directory name (lowercase, hyphens only, e.g. `my-project-playwright`).

Then ask for the primary region:

**Question:** "Which Fly.io region should host the Playwright machines? (Choose the closest to your location.)"

**Header:** "Primary Region"

**Options:**
- `iad` — Northern Virginia, USA (us-east)
- `lax` — Los Angeles, USA (us-west)
- `ord` — Chicago, USA (us-central)
- `ams` — Amsterdam, Netherlands (eu-west)
- `fra` — Frankfurt, Germany (eu-central)
- `nrt` — Tokyo, Japan (ap-northeast)
- `syd` — Sydney, Australia (ap-southeast)
- Other — I'll type a region code

If "Other": ask for the region code directly.

## Step 5: Discover 1Password Token Reference

Look up the Fly.io API token in 1Password via the MCP tool:

```
mcp__onepassword__op_vault_map()
```

Search the returned map for items containing "fly" (case-insensitive) in the vault name or item title. Look for fields named `token`, `api-key`, `api_key`, or `credential`.

Present the matching `op://` references to the user:

```
Found potential Fly.io token references in 1Password:
  op://Vault/Item/field
  op://Vault/Item/field
```

If none found, inform the user:

> No Fly.io token found in 1Password. You will need to:
> 1. Create a Fly.io API token at https://fly.io/user/personal_access_tokens
> 2. Store it in 1Password (any vault, any item, any field name)
> 3. Re-run `/setup-fly` to pick it up automatically

Ask which `op://` reference to use (or if they want to add it to 1Password first):

**Question:** "Which 1Password reference holds your Fly.io API token?"

**Header:** "Fly.io Token"

**Options:** (list the found references) + "None of these — I'll add it to 1Password first"

If they choose to add it to 1Password first, instruct them and stop. They can re-run `/setup-fly` after.

## Step 6: Register the Token as a Secret

Call `mcp__secret-sync__populate_secrets_local` to register the token reference:

```
mcp__secret-sync__populate_secrets_local({
  entries: {
    "FLY_API_TOKEN": "<the selected op:// reference>"
  }
})
```

This stores the `op://` reference (not the value) in `services.json`. The MCP launcher resolves it at runtime.

## Step 7: Update services.json with Fly Configuration

Read the current services.json:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const p = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'config', 'services.json');
try { console.log(fs.readFileSync(p, 'utf8')); } catch { console.log('{}'); }
"
```

Add the `fly` section via `mcp__secret-sync__update_services_config`:

```
mcp__secret-sync__update_services_config({
  fly: {
    enabled: true,
    appName: "<the app name from Step 4>",
    region: "<the region from Step 4>",
    machineCount: 3,
    imageRef: "ghcr.io/playwright/playwright:latest"
  }
})
```

If `update_services_config` is unavailable (EACCES, root-owned file), inform the user that the change will be staged and applied on the next `npx gentyr sync`.

## Step 8: Provision the Fly.io App

Run the provisioning steps:

### 8a: Create the app (if it doesn't exist)

```bash
flyctl apps list 2>/dev/null | grep -q "<app-name>" || flyctl apps create "<app-name>" --machines-ready-timeout 60
```

### 8b: Set the Fly.io API token as a secret on the app

```bash
flyctl secrets set FLY_API_TOKEN="$(flyctl tokens create deploy -x 8760h 2>/dev/null)" --app "<app-name>"
```

Note: This uses `flyctl tokens create deploy` to create a deploy-scoped token with 1-year expiry. The token is set as an app secret so Playwright machines can authenticate.

### 8c: Verify the app is ready

```bash
flyctl status --app "<app-name>" 2>/dev/null
```

If the app does not appear in `flyctl apps list` after creation, inform the user and ask them to verify their Fly.io account permissions.

## Step 9: Verify End-to-End

Call `mcp__playwright__get_fly_status()` to confirm the integration is working:

- If `healthy: true`: setup is complete
- If `healthy: false` or error: show the error message and proceed to Troubleshooting

Display the final status:

```
Fly.io Remote Execution — Configured
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  App name:    <app-name>.fly.dev
  Region:      <region>
  Machines:    {machineCount} available

  Headless demos will now auto-route to Fly.io.
  Headed demos (video recording) still run locally.

  Test it:
    run_demo({ scenario_id: "<any scenario>", headless: true })

  Force remote explicitly:
    run_demo({ scenario_id: "<any scenario>", remote: true })
```

## Troubleshooting

If `get_fly_status` returns errors or `healthy: false`:

| Error | Remedy |
|---|---|
| `FLY_API_TOKEN not set` | Re-run `/setup-fly` — the token was not written to `secrets.local` |
| `app not found` | Run `flyctl apps create <app-name> --machines-ready-timeout 60` |
| `authentication failed` | Run `flyctl auth login` then re-run `/setup-fly` |
| `no machines available` | Fly.io auto-scales — wait 30 seconds and retry |
| `region not available` | Choose a different region in services.json via `update_services_config` |

## Notes

- **Secret values never pass through agent context.** The `FLY_API_TOKEN` `op://` reference is stored; the MCP launcher resolves it at runtime.
- **Headless-only routing.** Only headless demos route to Fly.io. Headed demos (video recording, ScreenCaptureKit) always run locally — they require the display lock.
- **`npx gentyr sync` after changes.** If services.json was staged (EACCES), run `npx gentyr sync` to apply the change and restart your Claude Code session.
