# Resend MCP Server

MCP (Model Context Protocol) server for managing emails, domains, and API keys via [Resend](https://resend.com).

## Features

- **Email Management**: Send, retrieve, and list emails
- **Domain Management**: Add, verify, and manage sending domains
- **API Key Management**: Create and manage API keys
- **Full Type Safety**: Zod validation and TypeScript types
- **G003 Compliant**: All inputs validated with Zod schemas

## Installation

```bash
# Build the MCP servers package
cd packages/mcp-servers
pnpm build
```

## Configuration

Set the required environment variable:

```bash
export RESEND_API_KEY="re_..."
```

Get your API key from: https://resend.com/api-keys

## Usage

Add to your Claude Code MCP configuration:

```bash
claude mcp add resend node /path/to/packages/mcp-servers/dist/resend/server.js
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "resend": {
      "command": "node",
      "args": ["/path/to/packages/mcp-servers/dist/resend/server.js"],
      "env": {
        "RESEND_API_KEY": "re_..."
      }
    }
  }
}
```

## Available Tools

### Email Tools

#### `resend_send_email`
Send an email via Resend.

```typescript
{
  from: "sender@example.com",
  to: "recipient@example.com", // or ["email1@example.com", "email2@example.com"]
  subject: "Email subject",
  html?: "<p>HTML content</p>",
  text?: "Plain text content",
  cc?: "cc@example.com",
  bcc?: "bcc@example.com",
  reply_to?: "reply@example.com",
  attachments?: [{
    filename: "document.pdf",
    content: "base64_encoded_content",
    content_type?: "application/pdf"
  }],
  tags?: [{ name: "campaign", value: "newsletter" }]
}
```

#### `resend_get_email`
Get details of a specific email.

```typescript
{
  emailId: "email-123"
}
```

#### `resend_list_emails`
List sent emails with pagination.

```typescript
{
  limit?: 10,  // max 100
  offset?: 0
}
```

### Domain Tools

#### `resend_list_domains`
List all domains configured in Resend.

```typescript
{}
```

#### `resend_add_domain`
Add a new domain. Returns DNS records that must be configured.

```typescript
{
  name: "example.com",
  region?: "us-east-1" | "eu-west-1" | "sa-east-1"  // default: us-east-1
}
```

#### `resend_get_domain`
Get domain details including DNS records.

```typescript
{
  domainId: "domain-123"
}
```

#### `resend_verify_domain`
Verify a domain after DNS records are configured.

```typescript
{
  domainId: "domain-123"
}
```

#### `resend_delete_domain`
Delete a domain from Resend.

```typescript
{
  domainId: "domain-123"
}
```

### API Key Tools

#### `resend_list_api_keys`
List all API keys for the account.

```typescript
{}
```

#### `resend_create_api_key`
Create a new API key.

```typescript
{
  name: "API Key Name",
  permission?: "full_access" | "sending_access",  // default: full_access
  domain_id?: "domain-123"  // optional: restrict to specific domain
}
```

#### `resend_delete_api_key`
Delete an API key.

```typescript
{
  apiKeyId: "key-123"
}
```

## Example Workflows

### Sending a Simple Email

```typescript
// Send a plain text email
resend_send_email({
  from: "onboarding@resend.dev",
  to: "user@example.com",
  subject: "Welcome!",
  text: "Thanks for signing up!"
})
```

### Sending an HTML Email with Attachments

```typescript
resend_send_email({
  from: "reports@example.com",
  to: ["user1@example.com", "user2@example.com"],
  subject: "Monthly Report",
  html: "<h1>Report</h1><p>See attachment</p>",
  attachments: [{
    filename: "report.pdf",
    content: "base64_content_here",
    content_type: "application/pdf"
  }],
  tags: [
    { name: "category", value: "monthly-report" },
    { name: "priority", value: "high" }
  ]
})
```

### Setting Up a New Domain

```typescript
// Step 1: Add domain
const domain = resend_add_domain({
  name: "mail.example.com",
  region: "us-east-1"
})

// Step 2: Configure DNS records (shown in domain.records)
// SPF, DKIM, DMARC records must be added to your DNS provider

// Step 3: Verify domain after DNS propagation
resend_verify_domain({
  domainId: domain.id
})

// Step 4: Check verification status
resend_get_domain({
  domainId: domain.id
})
```

### Creating a Domain-Specific API Key

```typescript
// Create API key restricted to a specific domain
resend_create_api_key({
  name: "Marketing Emails Key",
  permission: "sending_access",
  domain_id: "domain-123"
})
```

## Error Handling

All tools follow G001 (fail-closed) and return errors in a consistent format:

```typescript
{
  error: "Error message from Resend API"
}
```

## Security (G004, G017)

- **Never commit** `RESEND_API_KEY` to version control
- Store API key in environment variables or secure vault
- Use domain-specific API keys to limit scope
- Prefer `sending_access` permission for keys used only for sending

## Testing

```bash
cd packages/mcp-servers
pnpm test src/resend/__tests__/resend.test.ts
```

## API Reference

Full Resend API documentation: https://resend.com/docs/api-reference

## Type Safety

All inputs are validated using Zod schemas (G003 compliance). TypeScript types are exported from `types.ts`:

```typescript
import {
  type SendEmailArgs,
  type EmailDetails,
  type DomainDetails,
  type ApiKeyDetails,
} from './types.js';
```
