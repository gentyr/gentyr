<!-- HOOK:GENTYR:toggle-auth-proxy -->
# /toggle-auth-proxy - Toggle Rotation Proxy State

Toggles the GENTYR rotation proxy from its current state (enabled → disabled, or disabled → enabled). Requires explicit CTO bypass confirmation before proceeding, so agents cannot disable the proxy unilaterally.

**Security note**: The rotation proxy is critical infrastructure. Disabling it means all Claude sessions connect directly to `api.anthropic.com` without credential rotation. Only the CTO should run this command.

## Framework Path Resolution

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

## Step 1: Check Current Proxy State

Read the proxy state file directly:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.env.HOME, '.claude', 'proxy-disabled.json');
try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(JSON.stringify(state));
} catch {
  console.log(JSON.stringify({ disabled: false }));
}
"
```

Parse the JSON output:
- `disabled: true` → proxy is currently **DISABLED**
- `disabled: false` or file missing → proxy is currently **ENABLED**

## Step 2: Determine Toggle Direction

Based on the current state, determine what action will be taken:

- If currently **ENABLED** → action is **DISABLE** (proxy will stop intercepting requests)
- If currently **DISABLED** → action is **ENABLE** (proxy will resume intercepting requests)

## Step 3: Show State and Ask for CTO Confirmation

Display the current state and the intended action clearly, then ask for confirmation using AskUserQuestion:

If currently **ENABLED** (about to disable):
```
Rotation Proxy: ENABLED
Intended action: DISABLE

WARNING: Disabling the rotation proxy means all Claude sessions will connect directly
to api.anthropic.com. Credential rotation on 429/401 responses will stop working.
Spawned agents will bypass the proxy unless HTTPS_PROXY is manually unset.

This requires CTO bypass confirmation.
```

If currently **DISABLED** (about to enable):
```
Rotation Proxy: DISABLED
Intended action: ENABLE

This will restart the proxy service and restore shell integration.
New shells and spawned agents will route through localhost:18080.

This requires CTO bypass confirmation.
```

Use AskUserQuestion with:
- Question: "Type 'confirm' to proceed with toggling the proxy, or 'cancel' to abort."
- Options: `["confirm", "cancel"]`

If the user selects or types "cancel" → print "Aborted. Proxy state unchanged." and stop.
If the user selects or types "confirm" → proceed to Step 4.

## Step 4: Execute the Toggle

Resolve GENTYR_DIR first:

```bash
GENTYR_DIR="$([ -d node_modules/gentyr ] && echo node_modules/gentyr || { [ -d .claude-framework ] && echo .claude-framework || echo .; })"
```

Then run the appropriate command:

**If toggling to DISABLE:**
```bash
node "${GENTYR_DIR}/cli/index.js" proxy disable
```

**If toggling to ENABLE:**
```bash
node "${GENTYR_DIR}/cli/index.js" proxy enable
```

## Step 5: Show Result

Display the output from the CLI command verbatim, then confirm the final state by reading the state file again:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const statePath = path.join(process.env.HOME, '.claude', 'proxy-disabled.json');
try {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  console.log(JSON.stringify(state));
} catch {
  console.log(JSON.stringify({ disabled: false }));
}
"
```

Print a final status line:
- If `disabled: true` → "Rotation proxy is now DISABLED."
- If `disabled: false` → "Rotation proxy is now ENABLED."

If the enable action was taken, also remind the user:
```
Note: Open a new shell to pick up HTTPS_PROXY, or run:
  export HTTPS_PROXY=http://localhost:18080 HTTP_PROXY=http://localhost:18080 NO_PROXY=localhost,127.0.0.1
```

If the disable action was taken, also remind the user:
```
Note: Already-running shells still have HTTPS_PROXY set. Open a new shell or unset it:
  unset HTTPS_PROXY HTTP_PROXY NO_PROXY NODE_EXTRA_CA_CERTS
```
