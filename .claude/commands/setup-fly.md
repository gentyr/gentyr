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

## Step 5: Discover or Create 1Password Token

### 5a: Check for existing token

Look up the Fly.io API token in 1Password:

```
mcp__onepassword__op_vault_map()
```

Search the returned map for items containing "fly" (case-insensitive) in the vault name or item title. Look for fields named `token`, `api-key`, `api_key`, or `credential`.

### 5b: If existing token found

Present the matching `op://` references and ask which to use:

**Question:** "Which 1Password reference holds your Fly.io API token?"

**Header:** "Fly.io Token"

**Options:** (list the found references) + "Create a new token instead"

### 5c: If no token found OR user chose "Create a new token"

Create a deploy token via `flyctl` and store it directly in 1Password using the `create_item` MCP tool:

```bash
# Generate a deploy-scoped token with 1-year expiry
flyctl tokens create deploy -x 8760h 2>/dev/null
```

Capture the output (the token string), then store it in 1Password:

```
mcp__onepassword__create_item({
  title: "Fly.io Playwright (<app-name>)",
  category: "API Credential",
  vault: "Automation",
  fields: [
    { field: "credential", value: "<the token from flyctl>", type: "concealed" }
  ],
  notes: "Deploy token for Fly.io remote Playwright execution. App: <app-name>. Region: <region>. Created by /setup-fly."
})
```

The response returns the `op://` reference (e.g., `op://Automation/Fly.io Playwright (<app-name>)/credential`). **The token value never enters the conversation context** — it goes directly from `flyctl` output to `create_item` via the MCP server.

If the `Automation` vault doesn't exist, use whichever vault is available (e.g., `Preview`, `Production`).

## Step 6: Register the Token as a Secret

Using the `op://` reference from Step 5 (either found or newly created):

```
mcp__secret-sync__populate_secrets_local({
  entries: {
    "FLY_API_TOKEN": "<the op:// reference>"
  }
})
```

This stores the `op://` reference (not the value) in `services.json` `secrets.local`.

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

Add the `fly` section via `mcp__secret-sync__update_services_config`. **IMPORTANT**: The `apiToken` field MUST be the `op://` reference from Step 5 (the same one registered in `secrets.local`). The server reads `apiToken` from the `fly` section directly — without it, `get_fly_status` returns `configured: false`.

```
mcp__secret-sync__update_services_config({
  fly: {
    enabled: true,
    apiToken: "<the op:// reference from Step 5>",
    appName: "<the app name from Step 4>",
    region: "<the region from Step 4>",
    maxConcurrentMachines: 3
  }
})
```

Field names must match the schema exactly: `apiToken` (op:// reference), `appName`, `region`, `maxConcurrentMachines` (1-10), `machineSize` (optional, default "shared-cpu-2x"), `machineRam` (optional, default 2048 MB).

If `update_services_config` returns an error about EACCES or root-owned file, inform the user that the change will be staged and applied on the next `npx gentyr sync`.

**If `update_services_config` rejects the `fly` field** (e.g., unknown field error), the field may not be in the schema yet. In that case, fall back to direct file editing:

```bash
node -e "
const fs = require('fs');
const p = require('path').join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'config', 'services.json');
const config = JSON.parse(fs.readFileSync(p, 'utf8'));
config.fly = { enabled: true, apiToken: '<op:// reference>', appName: '<app-name>', region: '<region>', maxConcurrentMachines: 3 };
fs.writeFileSync(p, JSON.stringify(config, null, 2));
console.log('fly section written to services.json');
"
```

## Step 8: Deploy the Playwright Docker Image

Deploy the Docker image that runs demos on Fly.io machines:

```
mcp__playwright__deploy_fly_image()
```

This builds and pushes the Playwright container image in the background (3-10 minutes for the remote Docker build). The image includes Playwright browsers, pnpm, Xvfb for display recording, ffmpeg for video capture, and the remote-runner entrypoint.

The tool returns a `logFile` path for deployment progress. Poll `get_fly_status()` to check when `imageDeployed` becomes `true`.

**CRITICAL: Without the image, remote execution will fail.** The `spawnRemoteMachine` call requires `registry.fly.io/<app-name>` to have a pushed image.

Under the hood, `deploy_fly_image` runs `infra/fly-playwright/provision-app.sh` which:
1. Creates the Fly.io app (skips if it already exists)
2. Creates a 5GB `playwright_cache` volume for dependency caching (skips if exists)
3. Builds and deploys the Playwright Docker image via `flyctl deploy --remote-only`

### If deploy_fly_image fails

| Error | Fix |
|---|---|
| `flyctl is not installed` | Install flyctl (see Step 2) |
| `Fly.io not configured` | Complete Steps 4-7 first |
| `Could not find provision-app.sh` | Run `npx gentyr sync` to ensure GENTYR is properly installed |
| Billing / payment error | Fly.io requires a payment method to build. See Troubleshooting below. |
| Build timeout | Call `deploy_fly_image({ force: true })` to retry |

### Verify the image is deployed

Poll `get_fly_status()` until `imageDeployed: true`. If it stays `false` after 10 minutes, check the deploy log file returned by `deploy_fly_image`.

## Step 9: Verify End-to-End

Call `mcp__playwright__get_fly_status()` to confirm the integration is working:

- If `healthy: true` AND `imageDeployed: true`: setup is complete
- If `imageDeployed: false`: the Docker image was not deployed. Call `deploy_fly_image()` again. Check `imageMessage` for details.
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
| `configured: false` | The `fly` section in `services.json` is missing or malformed. Verify `fly.apiToken` (must be `op://` reference) and `fly.appName` are both present. Re-run Step 7. |
| `imageDeployed: false` | The Fly app exists but no Docker image has been deployed. Remote execution cannot work. Call `deploy_fly_image()` to build and push the image. If it fails, check the deploy log for errors. |
| `FLY_API_TOKEN resolution failed` | The `op://` reference in `fly.apiToken` can't be resolved. Verify the 1Password item exists via `op_vault_map`. |
| `app not found` or 404 | Run `flyctl apps create <app-name> --machines-ready-timeout 60` |
| `authentication failed` / 401 | The API token is invalid or expired. Create a new token: `flyctl tokens create deploy -x 8760h`, store in 1Password, update the `op://` reference. |
| `no machines available` | Fly.io auto-scales — wait 30 seconds and retry |
| `region not available` | Choose a different region via `update_services_config({ fly: { region: "lax" } })` |
| `could not create machine` / billing error | **Fly.io requires a paid plan to create machines.** The free Hobby plan works but requires a credit card on file. Ask the user to check their billing at https://fly.io/dashboard/personal/billing |

### Paid Plan Requirement

Fly.io Machines API requires the account to have a payment method on file. If machine creation fails with billing-related errors:

1. **Offer to help via chrome-bridge**: If chrome-bridge MCP is available, offer to navigate the user to the Fly.io billing page:
   ```
   mcp__chrome-bridge__navigate({ url: "https://fly.io/dashboard/personal/billing" })
   ```
   Then guide them through adding a payment method using `click_by_text` and `fill_input` tools.

2. **Manual path**: Direct the user to https://fly.io/dashboard/personal/billing to add a credit card. The Hobby plan ($5/mo with $5 free credit) is sufficient for ephemeral Playwright machines.

After adding payment, re-run `flyctl apps create <app-name>` and continue from Step 8.

## Notes

- **Secret values never pass through agent context.** The `FLY_API_TOKEN` `op://` reference is stored; the MCP launcher resolves it at runtime.
- **Headless-only routing.** Only headless demos route to Fly.io. Headed demos (video recording, ScreenCaptureKit) always run locally — they require the display lock.
- **`npx gentyr sync` after changes.** If services.json was staged (EACCES), run `npx gentyr sync` to apply the change and restart your Claude Code session.
