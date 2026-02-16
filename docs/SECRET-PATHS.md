# 1Password Secret Reference Paths

Canonical op:// paths for all secrets in the GENTYR stack.

## Credential Types

**Secrets** (MUST be in 1Password, resolved via `op://` at runtime):
All items in the tables below except those marked as "identifier".

**Non-secret identifiers** (can be stored as direct values in vault-mappings.json):
- `CLOUDFLARE_ZONE_ID` — Zone identifier (32-character hex string)
- `SUPABASE_URL` — Database URL (publicly embedded in frontend)
- `SUPABASE_ANON_KEY` — Public API key (embedded in frontend as NEXT_PUBLIC_SUPABASE_ANON_KEY, doesn't enable protected actions)
- `ELASTIC_CLOUD_ID` — Deployment identifier

These are not sensitive. They can optionally be in 1Password OR provided directly in chat during `/setup-gentyr`.

## Production Vault

| Secret | Reference | Used By |
|--------|-----------|---------|
| Supabase URL | `op://Production/Supabase/url` | Backend, Vercel |
| Supabase Anon Key | `op://Production/Supabase/anon-key` | Frontend, Backend |
| Supabase Service Role Key | `op://Production/Supabase/service-role-key` | Backend |
| Supabase Management Token | `op://Production/Supabase/management-token` | CI/CD, MCP |
| Vercel Token | `op://Production/Vercel/token` | CI/CD, MCP |
| Vercel Team ID | `op://Production/Vercel/team-id` | CI/CD, MCP |
| Render API Key | `op://Production/Render/api-key` | CI/CD, MCP |
| Resend API Key | `op://Production/Resend/api-key` | Backend |
| Elastic Cloud ID | `op://Production/Elastic/cloud-id` | Backend, MCP |
| Elastic API Key (Ingest) | `op://Production/Elastic/api-key` | Backend |
| Elastic API Key (Query) | `op://Production/Elastic/api-key-query` | MCP |
| Cloudflare API Token | `op://Production/Cloudflare/api-token` | MCP |
| Cloudflare Zone ID | `op://Production/Cloudflare/zone-id` | MCP |
| Cloudflare Account ID | `op://Production/Cloudflare/account-id` | MCP |
| GitHub Token | `op://Production/GitHub/token` | CI/CD, MCP |
| Codecov Token | `op://Production/Codecov/token` | CI/CD |
| Backend Encryption Key | `op://Production/Backend/encryption-key` | Backend |

## Staging Vault

| Secret | Reference | Used By |
|--------|-----------|---------|
| Supabase URL | `op://Staging/Supabase/url` | Backend |
| Supabase Anon Key | `op://Staging/Supabase/anon-key` | Frontend, Backend |
| Supabase Service Role Key | `op://Staging/Supabase/service-role-key` | Backend |
| Resend API Key | `op://Staging/Resend/api-key` | Backend |

## Preview Vault

| Secret | Reference | Used By |
|--------|-----------|---------|
| Supabase Service Role Key | `op://Preview/Supabase/service-role-key` | Backend |

## services.json Mapping

Use these references in `.claude/config/services.json` under the `secrets` key:

> **Note:** `ELASTIC_API_KEY` maps to different 1Password fields depending on context:
> the backend (Render) uses the **ingest** key (`api-key`), while the MCP `elastic-logs`
> server uses the **read-only query** key (`api-key-query`). See the table above for details.

```json
{
  "secrets": {
    "renderProduction": {
      "SUPABASE_URL": "op://Production/Supabase/url",
      "SUPABASE_ANON_KEY": "op://Production/Supabase/anon-key",
      "SUPABASE_SERVICE_ROLE_KEY": "op://Production/Supabase/service-role-key",
      "RESEND_API_KEY": "op://Production/Resend/api-key",
      "ELASTIC_CLOUD_ID": "op://Production/Elastic/cloud-id",
      "ELASTIC_API_KEY": "op://Production/Elastic/api-key",
      "ENCRYPTION_KEY": "MANUAL"
    }
  }
}
```
