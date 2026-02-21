# Secret Sync MCP Server

Orchestrates syncing secrets from 1Password to Render and Vercel WITHOUT exposing secret values to Claude Code.

## Features

- **Zero secret exposure**: Secret values never pass through the agent's context window
- **Multi-platform**: Supports Render (production/staging) and Vercel
- **Secure workflow**: Reads from 1Password via `op` CLI, pushes directly to platform APIs
- **Atomic operations**: Creates or updates environment variables as needed
- **Verification**: Check if secrets exist on target platforms without revealing values

## Architecture

```
1Password Vault
    ↓ (op CLI - values stay in-process)
Secret Sync MCP Server
    ↓ (platform APIs)
Render/Vercel Services
```

**Security model:**
- Agent calls `secret_sync_secrets` with only the target platform name
- Server reads `services.json` to get op:// references
- Server calls `op read` internally (values never returned to agent)
- Server pushes values directly to platform APIs
- Agent receives only success/failure status and key names

## Configuration

### 1. Environment Variables

```bash
# Required for all operations
CLAUDE_PROJECT_DIR=/path/to/your-project

# Required for 1Password
OP_SERVICE_ACCOUNT_TOKEN=ops_xxxxx

# Required for Render targets
RENDER_API_KEY=rnd_xxxxx

# Required for Vercel targets
VERCEL_TOKEN=xxxxx
VERCEL_TEAM_ID=team_xxxxx  # Optional, for team accounts
```

### 2. Services Config

Create `.claude/config/services.json` in your project directory:

```json
{
  "render": {
    "production": { "serviceId": "srv-xxxxx" },
    "staging": { "serviceId": "srv-yyyyy" }
  },
  "vercel": {
    "projectId": "prj_xxxxx"
  },
  "secrets": {
    "renderProduction": {
      "SUPABASE_URL": "op://Production/Supabase/url",
      "SUPABASE_ANON_KEY": "op://Production/Supabase/anon_key",
      "ENCRYPTION_KEY": "op://Production/Encryption/key"
    },
    "renderStaging": {
      "SUPABASE_URL": "op://Staging/Supabase/url",
      "SUPABASE_ANON_KEY": "op://Staging/Supabase/anon_key",
      "ENCRYPTION_KEY": "op://Staging/Encryption/key"
    },
    "vercel": {
      "SUPABASE_URL": {
        "ref": "op://Production/Supabase/url",
        "target": ["production"],
        "type": "encrypted"
      },
      "NEXT_PUBLIC_SUPABASE_URL": {
        "ref": "op://Production/Supabase/url",
        "target": ["production", "preview", "development"],
        "type": "plain"
      }
    },
    "manual": [
      {
        "service": "Render Production",
        "key": "SENSITIVE_KEY",
        "notes": "Must be set manually via Render dashboard"
      }
    ]
  }
}
```

## MCP Tools

### `secret_sync_secrets`

Sync secrets from 1Password to target platform(s).

**Input:**
```typescript
{
  target: "render-production" | "render-staging" | "vercel" | "all"
}
```

**Output:**
```typescript
{
  synced: [
    { key: "SUPABASE_URL", service: "render-production", status: "created" },
    { key: "ENCRYPTION_KEY", service: "render-production", status: "updated" }
  ],
  errors: [
    { key: "BAD_KEY", service: "vercel", error: "1Password reference not found" }
  ],
  manual: [
    { service: "Render Production", key: "SENSITIVE_KEY", notes: "Set manually" }
  ]
}
```

**Note:** Secret values are NEVER included in the output.

---

### `secret_list_mappings`

List configured secret mappings (key names and 1Password references only).

**Input:**
```typescript
{
  target?: "render-production" | "render-staging" | "vercel" | "all"
}
```

**Output:**
```typescript
{
  mappings: [
    { key: "SUPABASE_URL", reference: "op://Production/Supabase/url", service: "render-production" },
    { key: "ENCRYPTION_KEY", reference: "op://Production/Encryption/key", service: "vercel" }
  ],
  manual: [
    { service: "Render Production", key: "SENSITIVE_KEY", notes: "Set manually" }
  ]
}
```

**Note:** Shows references (op:// paths) but NOT actual secret values.

---

### `secret_verify_secrets`

Verify that secrets exist on target platform(s) without revealing values.

**Input:**
```typescript
{
  target: "render-production" | "render-staging" | "vercel" | "all"
}
```

**Output:**
```typescript
{
  verified: [
    { key: "SUPABASE_URL", service: "render-production", exists: true },
    { key: "MISSING_KEY", service: "vercel", exists: false }
  ]
}
```

**Note:** Only checks existence, never returns secret values.

---

### `secret_run_command`

Run an arbitrary command with 1Password secrets injected into environment variables. Secret values are resolved in MCP server memory, injected into the child process, and never returned to the agent. Output is sanitized to redact any accidentally leaked secret values.

**Security model:**
- Executable must be in allowlist: `pnpm`, `npx`, `node`, `tsx`, `playwright`, `prisma`, `drizzle-kit`, `vitest`
- No shell interpretation — command is an argv array (`shell: false`)
- Inline eval args blocked: `-e`, `--eval`, `-c`, `--print`, `-p`
- Infrastructure credentials (`OP_SERVICE_ACCOUNT_TOKEN`, `RENDER_API_KEY`, etc.) filtered from child env
- All output sanitized: secret values replaced with `[REDACTED:KEY_NAME]`

**Input:**
```typescript
{
  command: string[],          // argv array, e.g. ["npx", "playwright", "test"]
  background?: boolean,       // default false — if true, returns PID only
  cwd?: string,              // working dir (must be within PROJECT_DIR)
  timeout?: number,          // ms, default 120000, max 600000 (foreground only)
  secretKeys?: string[],     // subset of secrets.local keys to inject (omit = all)
  outputLines?: number,      // max output lines, default 100 (foreground only)
  label?: string,            // label for background process tracking
}
```

**Output (foreground):**
```typescript
{
  mode: "foreground",
  exitCode: 0,
  signal: null,
  timedOut: false,
  output: ["PASS  tests/login.spec.ts", "  2 passed"],
  outputTruncated: false,
  secretsResolved: 5,
  secretsFailed: [],
  durationMs: 12340
}
```

**Output (background):**
```typescript
{
  mode: "background",
  pid: 12345,
  label: "playwright",
  secretsResolved: 5,
  secretsFailed: []
}
```

Background processes are tracked alongside dev servers — use `secret_dev_server_status` to check and `secret_dev_server_stop` to terminate.

**Note:** All output is sanitized. Secret values that appear in stdout/stderr are replaced with `[REDACTED:KEY_NAME]`.

## Usage Examples

### Sync all secrets to production

```typescript
mcp__secret-sync__secret_sync_secrets({
  target: "all"
})
```

### Verify secrets exist on Vercel

```typescript
mcp__secret-sync__secret_verify_secrets({
  target: "vercel"
})
```

### List mappings for staging

```typescript
mcp__secret-sync__secret_list_mappings({
  target: "render-staging"
})
```

### Run Playwright tests with secrets

```typescript
mcp__secret-sync__secret_run_command({
  command: ["npx", "playwright", "test", "--project=demo"]
})
```

### Run database seed with secrets

```typescript
mcp__secret-sync__secret_run_command({
  command: ["npx", "prisma", "db", "seed"],
  timeout: 300000
})
```

## Platform-Specific Behavior

### Render

- **Create**: `POST /services/{serviceId}/env-vars`
- **Update**: If 409 conflict, uses `PUT /services/{serviceId}/env-vars/{key}`
- **Verify**: `GET /services/{serviceId}/env-vars` (returns only key names)

### Vercel

- **Create**: `POST /v10/projects/{projectId}/env`
- **Update**: Deletes existing env var, then creates new one (Vercel has no update endpoint)
- **Verify**: `GET /v9/projects/{projectId}/env` (returns only key names)
- **Team ID**: Automatically appends `?teamId={VERCEL_TEAM_ID}` if configured

## Security Guarantees

1. **No secret leakage to agent context**: Values read from 1Password are kept in-process and never returned to the agent
2. **Validated inputs**: All tool inputs validated with Zod (G003 compliance)
3. **Fail-closed**: Missing API keys or config errors fail loudly (G001 compliance)
4. **Audit trail**: All operations logged to stderr with timestamps
5. **Separation of concerns**: Agent sees only metadata (key names, status), never values

## Error Handling

The server follows G001 (fail-closed) principles:

- **Missing config file**: Throws error immediately
- **Invalid config schema**: Throws error with Zod validation details
- **Missing API keys**: Individual tools return friendly errors (not fatal exit)
- **1Password errors**: Included in `errors` array with `op` CLI error message
- **Platform API errors**: Included in `errors` array with HTTP error details

## Installation

```bash
# Install the MCP server
cd packages/mcp-servers
pnpm build

# Add to Claude Code config (~/.config/claude-code/claude_desktop_config.json)
{
  "mcpServers": {
    "secret-sync": {
      "command": "node",
      "args": ["/path/to/your-project/packages/mcp-servers/dist/secret-sync/server.js"],
      "env": {
        "OP_SERVICE_ACCOUNT_TOKEN": "ops_xxxxx",
        "RENDER_API_KEY": "rnd_xxxxx",
        "VERCEL_TOKEN": "xxxxx",
        "VERCEL_TEAM_ID": "team_xxxxx",
        "CLAUDE_PROJECT_DIR": "/path/to/your-project"
      }
    }
  }
}
```

## Related Documentation

- [G001 - Fail-Closed Error Handling](../../../specs/global/G001-fail-closed.md)
- [G003 - Input Validation Required](../../../specs/global/G003-input-validation.md)
- [G004 - No Hardcoded Credentials](../../../specs/global/G004-no-hardcoded-credentials.md)
- [G017 - Credential Encryption Required](../../../specs/global/G017-credential-encryption.md)
- [G025 - 1Password Integration](../../../specs/global/G025-1password-integration.md)
