# Render MCP Server

MCP server for managing Render services, deployments, and environment variables.

## Setup

1. Get your Render API key from https://dashboard.render.com/account/api-keys

2. Set the environment variable:
```bash
export RENDER_API_KEY="rnd_xxxxxxxxxxxxx"
```

3. Add to your MCP settings:
```json
{
  "mcpServers": {
    "render": {
      "command": "node",
      "args": ["/path/to/packages/mcp-servers/dist/render/server.js"],
      "env": {
        "RENDER_API_KEY": "rnd_xxxxxxxxxxxxx"
      }
    }
  }
}
```

## Available Tools

### Service Management

- `render_list_services` - List all services in your account
- `render_get_service` - Get detailed service information
- `render_create_service` - Create a new service
- `render_update_service` - Update service settings (requires CTO approval via GENTYR)
- `render_delete_service` - Delete a service (requires CTO approval via GENTYR)
- `render_suspend_service` - Suspend a service (requires CTO approval via GENTYR)
- `render_resume_service` - Resume a suspended service

### Deployment Management

- `render_list_deploys` - List deployments for a service
- `render_get_deploy` - Get deployment details
- `render_trigger_deploy` - Trigger a new deployment (requires CTO approval via GENTYR)

### Environment Variables

- `render_list_env_vars` - List environment variables
- `render_create_env_var` - Create an environment variable (requires CTO approval via GENTYR)
- `render_update_env_var` - Update an environment variable (requires CTO approval via GENTYR)
- `render_delete_env_var` - Delete an environment variable (requires CTO approval via GENTYR)

## Examples

### List all services
```typescript
await mcp.call('render_list_services', { limit: 20 });
```

### Get service details
```typescript
await mcp.call('render_get_service', {
  serviceId: 'srv-xxxxxxxxxxxxx'
});
```

### Trigger a deployment
```typescript
await mcp.call('render_trigger_deploy', {
  serviceId: 'srv-xxxxxxxxxxxxx',
  clearCache: true
});
```

### Create environment variable
```typescript
await mcp.call('render_create_env_var', {
  serviceId: 'srv-xxxxxxxxxxxxx',
  key: 'DATABASE_URL',
  value: 'postgresql://...'
});
```

## API Reference

Based on [Render API Documentation](https://api-docs.render.com/reference)

## Security

- **G001**: Fails closed on errors (never fails open)
- **G003**: All inputs validated with Zod schemas
- **G004**: No hardcoded credentials (requires RENDER_API_KEY env var)
- **GENTYR Protection**: Sensitive operations require CTO approval:
  - `render_trigger_deploy` - Triggering production deployments
  - `render_delete_service` - Deleting services
  - `render_suspend_service` - Suspending services
  - `render_update_service` - Updating service configuration
  - `render_create_env_var` - Creating environment variables
  - `render_update_env_var` - Updating environment variables
  - `render_delete_env_var` - Deleting environment variables
- Uses Bearer token authentication
- HTTPS only (api.render.com)

## Error Handling

The server follows fail-closed principles:
- Missing `RENDER_API_KEY` causes immediate exit with error code 1
- Invalid API responses throw detailed errors with HTTP status and Render error messages
- All input is validated with Zod schemas before processing
- 204 No Content responses handled gracefully
- Network errors are propagated with clear error messages
