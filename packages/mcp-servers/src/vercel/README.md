# Vercel MCP Server

MCP server for managing Vercel deployments, projects, domains, and environment variables.

## Setup

### Environment Variables

Required:
- `VERCEL_TOKEN`: Vercel API token (personal or team token)

Optional:
- `VERCEL_TEAM_ID`: Team ID for team accounts (auto-appended to API requests)

### Getting Your Vercel Token

1. Go to [Vercel Account Settings → Tokens](https://vercel.com/account/tokens)
2. Click "Create Token"
3. Give it a name (e.g., "Claude Code MCP Server")
4. Select appropriate scope:
   - For personal projects: Full Access
   - For team projects: Select specific team
5. Set expiration (recommended: 90 days)
6. Copy the token immediately (it won't be shown again)

### Installation

After building the package:

```bash
cd packages/mcp-servers
pnpm build
```

Add to Claude Code config:

```bash
# Using node directly
claude mcp add vercel node /path/to/packages/mcp-servers/dist/vercel/server.js
```

Add environment variable:
```bash
export VERCEL_TOKEN="vercel_token_xxxxxxxxxxxxx"
export VERCEL_TEAM_ID="team_xxxxxxxxxxxxx"  # Optional, for team accounts
```

Or add to your MCP settings file:
```json
{
  "mcpServers": {
    "vercel": {
      "command": "node",
      "args": ["/path/to/packages/mcp-servers/dist/vercel/server.js"],
      "env": {
        "VERCEL_TOKEN": "vercel_token_xxxxxxxxxxxxx",
        "VERCEL_TEAM_ID": "team_xxxxxxxxxxxxx"
      }
    }
  }
}
```

## Available Tools

### Deployment Management

#### `vercel_list_deployments`
List recent deployments with filtering options.

Arguments:
- `limit` (number, optional): Maximum number of deployments to return (default: 10)
- `projectId` (string, optional): Filter by project ID
- `state` (enum, optional): Filter by state ("BUILDING", "ERROR", "INITIALIZING", "QUEUED", "READY", "CANCELED")

Example:
```typescript
await mcp.call('vercel_list_deployments', {
  limit: 20,
  projectId: 'prj_xxxxxxxxxxxxx',
  state: 'READY'
});
```

#### `vercel_get_deployment`
Get detailed information about a specific deployment.

Arguments:
- `idOrUrl` (string): Deployment ID or URL

Example:
```typescript
await mcp.call('vercel_get_deployment', {
  idOrUrl: 'dpl_xxxxxxxxxxxxx'
});
```

#### `vercel_get_deployment_events`
Get build logs/events for a deployment (stdout/stderr).

Arguments:
- `deploymentId` (string): Deployment ID

Example:
```typescript
await mcp.call('vercel_get_deployment_events', {
  deploymentId: 'dpl_xxxxxxxxxxxxx'
});
```

#### `vercel_cancel_deployment`
Cancel a deployment that is currently building.

Arguments:
- `deploymentId` (string): Deployment ID

#### `vercel_redeploy`
Trigger a redeployment of an existing deployment.

Arguments:
- `deploymentId` (string): Deployment ID to redeploy
- `target` (enum, optional): Deployment target ("production" or "preview", default: "production")

#### `vercel_promote_deployment`
Promote a preview deployment to production.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `projectId` (string): Project ID
- `deploymentId` (string): Deployment ID to promote

#### `vercel_rollback`
Rollback to a previous deployment.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `projectId` (string): Project ID
- `deploymentId` (string): Deployment ID to rollback to

### Project Management

#### `vercel_list_projects`
List all projects in the account/team.

Arguments:
- `limit` (number, optional): Maximum number of projects to return (default: 20)

Example:
```typescript
await mcp.call('vercel_list_projects', { limit: 50 });
```

#### `vercel_get_project`
Get detailed information about a specific project.

Arguments:
- `projectId` (string): Project ID

Example:
```typescript
await mcp.call('vercel_get_project', {
  projectId: 'prj_xxxxxxxxxxxxx'
});
```

### Environment Variables

#### `vercel_list_env_vars`
List all environment variables for a project.

Arguments:
- `projectId` (string): Project ID

Example:
```typescript
await mcp.call('vercel_list_env_vars', {
  projectId: 'prj_xxxxxxxxxxxxx'
});
```

#### `vercel_create_env_var`
Create or update an environment variable.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `projectId` (string): Project ID
- `key` (string): Environment variable key (e.g., "DATABASE_URL")
- `value` (string): Environment variable value
- `target` (array, optional): Target environments (default: ["production", "preview", "development"])
  - Possible values: "production", "preview", "development"
- `type` (enum, optional): Variable type (default: "encrypted")
  - "plain": Visible in UI and logs
  - "secret": Hidden in UI, visible in deployments
  - "encrypted": Encrypted at rest and in transit

Example:
```typescript
await mcp.call('vercel_create_env_var', {
  projectId: 'prj_xxxxxxxxxxxxx',
  key: 'DATABASE_URL',
  value: 'postgresql://user:pass@host:5432/db',
  target: ['production', 'preview'],
  type: 'encrypted'
});
```

#### `vercel_delete_env_var`
Delete an environment variable.

**Note:** Requires CTO approval via GENTYR protection.

Arguments:
- `projectId` (string): Project ID
- `envId` (string): Environment variable ID (from list_env_vars)

Example:
```typescript
await mcp.call('vercel_delete_env_var', {
  projectId: 'prj_xxxxxxxxxxxxx',
  envId: 'env_xxxxxxxxxxxxx'
});
```

### Domain Management

#### `vercel_list_domains`
List all domains for a project.

Arguments:
- `projectId` (string): Project ID

Example:
```typescript
await mcp.call('vercel_list_domains', {
  projectId: 'prj_xxxxxxxxxxxxx'
});
```

#### `vercel_add_domain`
Add a custom domain to a project.

Arguments:
- `projectId` (string): Project ID
- `domain` (string): Domain name (e.g., "example.com")

Example:
```typescript
await mcp.call('vercel_add_domain', {
  projectId: 'prj_xxxxxxxxxxxxx',
  domain: 'example.com'
});
```

#### `vercel_remove_domain`
Remove a domain from a project.

Arguments:
- `projectId` (string): Project ID
- `domain` (string): Domain name to remove

Example:
```typescript
await mcp.call('vercel_remove_domain', {
  projectId: 'prj_xxxxxxxxxxxxx',
  domain: 'example.com'
});
```

## Examples

### Deploy and promote workflow

```typescript
// List recent deployments
const deployments = await mcp.call('vercel_list_deployments', {
  projectId: 'prj_xxxxxxxxxxxxx',
  state: 'READY',
  limit: 5
});

// Get deployment details
const deployment = await mcp.call('vercel_get_deployment', {
  idOrUrl: deployments[0].id
});

// Promote preview to production (requires CTO approval)
await mcp.call('vercel_promote_deployment', {
  projectId: 'prj_xxxxxxxxxxxxx',
  deploymentId: deployments[0].id
});
```

### Environment variable management

```typescript
// List all environment variables
const envVars = await mcp.call('vercel_list_env_vars', {
  projectId: 'prj_xxxxxxxxxxxxx'
});

// Create a new encrypted secret (requires CTO approval)
await mcp.call('vercel_create_env_var', {
  projectId: 'prj_xxxxxxxxxxxxx',
  key: 'API_SECRET_KEY',
  value: 'sk_live_xxxxxxxxxxxxx',
  target: ['production'],
  type: 'encrypted'
});

// Delete an environment variable (requires CTO approval)
await mcp.call('vercel_delete_env_var', {
  projectId: 'prj_xxxxxxxxxxxxx',
  envId: 'env_xxxxxxxxxxxxx'
});
```

### Check deployment logs

```typescript
// Get build logs for a deployment
const logs = await mcp.call('vercel_get_deployment_events', {
  deploymentId: 'dpl_xxxxxxxxxxxxx'
});

console.log(logs); // stdout/stderr combined
```

## API Reference

Based on [Vercel API Documentation](https://vercel.com/docs/rest-api)

- Deployments API: `/v6/deployments`, `/v13/deployments`
- Projects API: `/v9/projects`, `/v10/projects`
- Domains API: `/v9/projects/{projectId}/domains`, `/v10/projects/{projectId}/domains`
- Environment Variables API: `/v9/projects/{projectId}/env`, `/v10/projects/{projectId}/env`

## Security

- **G001**: Fails closed on errors (never fails open)
- **G003**: All inputs validated with Zod schemas
- **G004**: No hardcoded credentials (requires VERCEL_TOKEN env var)
- **GENTYR Protection**: Sensitive operations require CTO approval:
  - `vercel_promote_deployment` - Promoting to production
  - `vercel_rollback` - Rolling back production
  - `vercel_create_env_var` - Creating/updating environment variables
  - `vercel_delete_env_var` - Deleting environment variables
- Uses Bearer token authentication
- HTTPS only (api.vercel.com)
- Team ID automatically appended to requests if `VERCEL_TEAM_ID` is set

## Error Handling

The server follows fail-closed principles:
- Missing `VERCEL_TOKEN` causes immediate exit with error code 1
- Invalid API responses throw detailed errors with HTTP status and Vercel error messages
- All input is validated with Zod schemas before processing
- Network errors are propagated with clear error messages

## Notes

- Environment variables created with `type: "encrypted"` are encrypted at rest and in transit
- Deleting an environment variable requires the `envId`, not just the key name
- Team accounts require `VERCEL_TEAM_ID` to be set for proper API access
- Deployment promotion and rollback operations are irreversible without further deployments
