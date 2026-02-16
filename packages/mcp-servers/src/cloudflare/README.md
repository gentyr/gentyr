# Cloudflare MCP Server

MCP server for managing Cloudflare DNS records via the Cloudflare API v4.

## Features

- List DNS records with filtering and pagination
- Get details of specific DNS records
- Create new DNS records (A, AAAA, CNAME, TXT, MX, NS, SRV, CAA, PTR)
- Update existing DNS records
- Delete DNS records
- Get zone information

## Environment Variables

Required environment variables:

- `CLOUDFLARE_API_TOKEN` - Cloudflare API token with DNS edit permissions
- `CLOUDFLARE_ZONE_ID` - Zone ID for DNS operations

### Getting Your Credentials

1. **API Token**:
   - Go to https://dash.cloudflare.com/profile/api-tokens
   - Create a new token with `Zone.DNS.Edit` permissions
   - Copy the token value

2. **Zone ID**:
   - Go to your domain overview page
   - Scroll down to the "API" section
   - Copy the "Zone ID" value

## Installation

Add to your Claude Code MCP settings:

```bash
# After building the package
claude mcp add cloudflare-dns node /path/to/gentyr/packages/mcp-servers/dist/cloudflare/server.js
```

Or add to `.claude/mcp.json` manually:

```json
{
  "mcpServers": {
    "cloudflare-dns": {
      "command": "node",
      "args": ["/path/to/gentyr/packages/mcp-servers/dist/cloudflare/server.js"],
      "env": {
        "CLOUDFLARE_API_TOKEN": "your-api-token",
        "CLOUDFLARE_ZONE_ID": "your-zone-id"
      }
    }
  }
}
```

## Available Tools

### cloudflare_list_dns_records

List all DNS records for the configured zone with optional filtering.

**Arguments:**
- `type` (optional): Filter by DNS record type (A, AAAA, CNAME, TXT, etc.)
- `name` (optional): Filter by DNS record name
- `content` (optional): Filter by DNS record content
- `page` (optional): Page number for pagination (default: 1)
- `per_page` (optional): Number of records per page (default: 100)

**Example:**
```json
{
  "type": "A",
  "page": 1,
  "per_page": 50
}
```

### cloudflare_get_dns_record

Get details of a specific DNS record by ID.

**Arguments:**
- `recordId` (required): DNS record identifier

### cloudflare_create_dns_record

Create a new DNS record in the zone.

**Arguments:**
- `type` (required): DNS record type (A, AAAA, CNAME, TXT, MX, NS, SRV, CAA, PTR)
- `name` (required): DNS record name (e.g., example.com or subdomain.example.com)
- `content` (required): DNS record content (e.g., IP address, CNAME target)
- `ttl` (optional): Time to live in seconds (default: 1 = automatic)
- `proxied` (optional): Whether to proxy through Cloudflare (default: false)
- `priority` (optional): Priority for MX and SRV records
- `comment` (optional): Comments or notes about the DNS record

**Example:**
```json
{
  "type": "A",
  "name": "api.example.com",
  "content": "192.0.2.1",
  "proxied": true,
  "ttl": 1,
  "comment": "API server"
}
```

### cloudflare_update_dns_record

Update an existing DNS record. Only provided fields will be updated.

**Arguments:**
- `recordId` (required): DNS record identifier
- `type` (optional): DNS record type
- `name` (optional): DNS record name
- `content` (optional): DNS record content
- `ttl` (optional): Time to live
- `proxied` (optional): Whether to proxy through Cloudflare
- `priority` (optional): Priority for MX and SRV records
- `comment` (optional): Comments or notes

**Example:**
```json
{
  "recordId": "abc123",
  "content": "192.0.2.2",
  "comment": "Updated API server IP"
}
```

### cloudflare_delete_dns_record

Delete a DNS record from the zone.

**Arguments:**
- `recordId` (required): DNS record identifier

### cloudflare_get_zone

Get details of the configured zone including name servers and status.

**Arguments:** None

## Security Compliance

This MCP server follows the project's security specifications:

- **G001**: Fail-closed error handling - all errors are thrown, never silently caught
- **G003**: Input validation - all tool arguments are validated with Zod schemas
- **G004**: No hardcoded credentials - uses environment variables only

## Development

Build the server:

```bash
cd packages/mcp-servers
pnpm build
```

The compiled JavaScript will be in `dist/cloudflare/server.js`.

## API Reference

This server uses the Cloudflare API v4. For more details, see:
https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-list-dns-records
