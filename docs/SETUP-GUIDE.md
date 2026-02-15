# GENTYR Setup Guide

<!-- CREDENTIAL-PHASE-MAP
GITHUB_TOKEN: Phase 2: GitHub Token
GITHUB_PAT: Phase 2: GitHub Token
RENDER_API_KEY: Phase 3: Render API Key
VERCEL_TOKEN: Phase 4: Vercel Token
CLOUDFLARE_API_TOKEN: Phase 5: Cloudflare API Token
CLOUDFLARE_ZONE_ID: Phase 5: Cloudflare API Token
SUPABASE_SERVICE_ROLE_KEY: Phase 6: Supabase Credentials
SUPABASE_URL: Phase 6: Supabase Credentials
SUPABASE_ANON_KEY: Phase 6: Supabase Credentials
SUPABASE_ACCESS_TOKEN: Phase 6: Supabase Credentials
ELASTIC_API_KEY: Phase 7: Elastic Cloud Credentials
ELASTIC_CLOUD_ID: Phase 7: Elastic Cloud Credentials
RESEND_API_KEY: Phase 8: Resend API Key
CODECOV_TOKEN: Phase 9: Codecov Token
OP_CONNECT_TOKEN: Phase 1: 1Password Service Account
-->

This guide walks through setting up credentials for each service in the GENTYR stack.

## Prerequisites

- Node.js 20+
- pnpm 8+
- 1Password CLI (`op`) installed: `brew install --cask 1password-cli`
- Claude Code installed

## Phase 1: 1Password Service Account

1. Open 1Password Desktop app
2. Go to **Settings > Integrations > Service Accounts**
3. Click **Create Service Account**
4. Name it "Claude Code MCP"
5. Grant access to: Production, Staging, Preview vaults
6. Copy the service account token
7. The setup command will inject this into your MCP config

## Phase 2: GitHub Token

1. Go to https://github.com/settings/tokens
2. Click **Generate new token (fine-grained)**
3. Name: "GENTYR - {project-name}"
4. Repository access: Select your repository
5. Permissions (all required for GENTYR MCP tools):
   - **Actions**: Read and Write (workflow runs, re-runs, cancellation)
   - **Contents**: Read and Write (file read/write via GitHub API)
   - **Issues**: Read and Write (issue creation, comments)
   - **Pull requests**: Read and Write (PR creation, merge, file listing)
   - **Secrets**: Read and Write (repository and environment secrets)
   - **Environments**: Read and Write (deployment environment management)
6. Copy the token

**Validation:** setup-validate probes each permission endpoint. Missing permissions appear as warnings with direct links to fix.

**1Password Storage:**
- Vault: **Production**
- Item title: **GitHub**
- Item type: Login
- Fields:
  - `token` = [paste the token]
- Predefined path: `op://Production/GitHub/token`

## Phase 3: Render API Key

1. Go to https://dashboard.render.com/account/api-keys
2. Click **Create API Key**
3. Name: "GENTYR - {project-name}"
4. Copy the API key

**1Password Storage:**
- Vault: **Production**
- Item title: **Render**
- Item type: Login
- Fields:
  - `api-key` = [paste the API key]
- Predefined path: `op://Production/Render/api-key`

## Phase 4: Vercel Token

1. Go to https://vercel.com/account/tokens
2. Click **Create Token**
3. Name: "GENTYR - {project-name}"
4. Scope: **Full Account** (required for deployments, projects, env vars, domains)
5. Copy the token

**1Password Storage:**
- Vault: **Production**
- Item title: **Vercel**
- Item type: Login
- Fields:
  - `token` = [paste the token]
- Predefined path: `op://Production/Vercel/token`

To find your Team ID:
1. Go to https://vercel.com/teams
2. Click your team
3. Go to **Settings > General**
4. Copy the Team ID

## Phase 5: Cloudflare API Token

1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click **Create Token**
3. Use template: **Edit zone DNS** (required for DNS record management)
4. Zone Resources: Include > Specific zone > your domain
5. Copy the token

**1Password Storage:**
- Vault: **Production**
- Item title: **Cloudflare**
- Item type: Login
- Fields:
  - `api-token` = [paste the API token]
- Predefined path: `op://Production/Cloudflare/api-token`

To find your Zone ID:
1. Go to your domain's overview page in Cloudflare
2. The Zone ID is in the right sidebar under **API**

**Non-secret (share in chat during /setup-gentyr):**
- Cloudflare Zone ID (32-character hex string)
  - Find at: Cloudflare Dashboard > your domain > right sidebar under "API"

## Phase 6: Supabase Credentials

### Service Role Key (secret)
1. Go to your Supabase project dashboard
2. Navigate to **Project Settings > API**
3. Copy the **service_role** key (secret — never expose in frontend)

**1Password Storage:**
- Vault: **Production**
- Item title: **Supabase**
- Item type: Login
- Fields:
  - `service-role-key` = [paste service role key]
- Predefined path: `op://Production/Supabase/service-role-key`

### Non-secret identifiers (share in chat during /setup-gentyr)
- **Supabase URL** (e.g., `https://abcdefghijklmnop.supabase.co`)
  - Find at: Supabase Dashboard > Project Settings > API > URL
- **Supabase Anon Key** (public API key, embedded in frontend code)
  - Find at: Supabase Dashboard > Project Settings > API > anon (public)

### Management Access Token
1. Go to https://supabase.com/dashboard/account/tokens
2. Click **Generate new token**
3. Name: "GENTYR - {project-name}"
4. Copy the token

**1Password Storage:**
- Vault: **Production**
- Item: **Supabase** (same item as service-role-key)
- Fields:
  - `access-token` = [paste management token]
- Predefined path: `op://Production/Supabase/access-token`

**What this enables:** `supabase_sql`, `supabase_push_migration`, `supabase_list_migrations`, `supabase_get_project` MCP tools. Without it, `supabase_list_tables` and `supabase_describe_table` use a PostgREST fallback with slightly less detail.

## Phase 7: Elastic Cloud Credentials

### API Keys

#### For Hosted Deployments
1. Go to https://cloud.elastic.co
2. Open your deployment
3. Click **Manage** > **Security** > **Create API Key**
4. Create two keys:
   - "Ingest" key (for backend logging): Index privileges on `logs-*`
   - "Query" key (for Claude Code): Read privileges on `logs-*`

#### For Serverless Projects
1. Go to https://cloud.elastic.co/serverless
2. Open your project
3. Go to **Project Settings** > **Management** > **API Keys**
4. Create two keys:
   - "Ingest" key (for backend logging): Index privileges on `logs-*`
   - "Query" key (for Claude Code): Read privileges on `logs-*`

**1Password Storage:**
- Vault: **Production**
- Item title: **Elastic**
- Item type: Login
- Fields:
  - `api-key` = [paste ingest API key]
  - `api-key-query` = [paste query API key]
- Predefined paths:
  - `op://Production/Elastic/api-key` (ingest)
  - `op://Production/Elastic/api-key-query` (query)

### Connection Identifier

Provide **one** of the following (not both):

**Non-secret (share in chat during /setup-gentyr):**

**Option A — Hosted Deployment (Cloud ID):**
- Elastic Cloud ID (e.g., `my-deployment:dXMtY2VudH...`)
  - Find at: Elastic Cloud > Deployments > your deployment > Cloud ID
  - Stored as: `ELASTIC_CLOUD_ID` in vault-mappings.json

**Option B — Serverless Project (Endpoint URL):**
- Elasticsearch endpoint URL (e.g., `https://my-project-abc123.es.us-central1.gcp.elastic.cloud`)
  - Find at: Elastic Cloud > Serverless > your project > Endpoints
  - Stored as: `ELASTIC_ENDPOINT` in vault-mappings.json

## Phase 8: Resend API Key

1. Go to https://resend.com/api-keys
2. Click **Create API Key**
3. Name: "GENTYR - {project-name}"
4. Permission: **Full access** (recommended)
   - "Full access" enables domain management, API key listing, and all MCP tools
   - "Sending access" is sufficient if you only need email sending (setup-validate will warn about limited tools)
5. Domain: your domain (or leave blank for all domains)
6. Copy the API key

**1Password Storage:**
- Vault: **Production**
- Item title: **Resend**
- Item type: Login
- Fields:
  - `api-key` = [paste the API key]
- Predefined path: `op://Production/Resend/api-key`

## Phase 9: Codecov Token

1. Go to https://app.codecov.io
2. Navigate to your repository settings
3. Copy the **Upload Token**

**1Password Storage:**
- Vault: **Production**
- Item title: **Codecov**
- Item type: Login
- Fields:
  - `token` = [paste the upload token]
- Predefined path: `op://Production/Codecov/token`

## How Credentials Work

After creating each credential in your service provider, store it in 1Password:

1. Open 1Password Desktop app
2. Navigate to the **Production** vault
3. Create a new item with the exact title and field names specified in each phase above
4. Run `/setup-gentyr` — it verifies these exist and writes `op://` references to `.claude/vault-mappings.json`
5. The MCP launcher resolves these at server startup — credentials exist only in process memory

**Non-secret identifiers** (URLs, zone IDs, cloud IDs) don't need 1Password. Share them in chat during `/setup-gentyr` and they'll be written directly to `vault-mappings.json`.

## Phase 10: Branch Protection & Deployment Pipeline

GENTYR enforces a strict merge chain: `feature/* -> preview -> staging -> main (production)`.

### Why the Merge Chain Matters

- **Feature branches** can only merge into `preview` (no approval needed)
- **Preview** can only merge into `staging` (deputy-CTO approval)
- **Staging** can only merge into `main` (CTO approval)
- Direct merges from feature branches to staging/main are **forbidden**

### CI Enforcement

GitHub has no native rule to restrict which source branch a PR comes from. GENTYR includes a `merge-chain-check.yml` CI workflow that enforces this. It must be added as a **required status check** on all protected branches.

The workflow template is at: `.claude-framework/templates/config/merge-chain-check.yml.template`

Copy it to `.github/workflows/merge-chain-check.yml` in your project.

### Branch Protection (GitHub Teams)

Go to: Repository > Settings > Branches > Add branch protection rule

**For each branch (`preview`, `staging`, `main`):**
1. Require a pull request before merging
2. Require status checks to pass (include `Validate Merge Chain`)
3. Block force pushes
4. Do not allow bypassing settings

**Additional for `staging`:** Require 1 approving review (deputy-CTO)
**Additional for `main`:** Require 1 approving review (CTO) + Security Scan check

See `.claude-framework/docs/DEPLOYMENT-FLOW.md` for complete branch protection instructions.

### GitHub Enterprise Cloud

If on Enterprise Cloud, also configure:
- Organization Rulesets for cross-repo enforcement
- Deployment Protection Rules for staging/production environments
- Merge Queue for the `main` branch

### `gh` CLI Authentication

The automated promotion pipelines use `gh` CLI for PR operations. Ensure it's authenticated:

```bash
gh auth login
gh auth status
```

### Automated Promotion

Once branch protection is configured, GENTYR's hourly automation handles promotion:

- **Preview -> Staging**: Every 6 hours, reviews new commits and promotes if stable (24h or bug-fix)
- **Staging -> Main**: Nightly at midnight, promotes if staging is 24h+ stable (requires CTO approval)

### Health Monitoring

GENTYR monitors deployed environments:

- **Staging**: Every 3 hours -- checks Render, Vercel, Elasticsearch, Codecov
- **Production**: Every 1 hour -- same checks + CTO escalation for issues

Enable/disable via `.claude/autonomous-mode.json`:
```json
{
  "previewPromotionEnabled": true,
  "stagingPromotionEnabled": true,
  "stagingHealthMonitorEnabled": true,
  "productionHealthMonitorEnabled": true
}
```

## Permission Validation

After completing setup, run permission validation to verify all credentials work and have correct permissions:

```bash
node .claude-framework/scripts/setup-validate.js
```

This makes **read-only** API calls to each service and reports:

| Status | Meaning |
|--------|---------|
| **pass** | Credential works with correct permissions |
| **warn** | Credential works but with limited permissions (some MCP tools may not function) |
| **fail** | Credential is invalid, expired, or lacks required permissions |
| **skip** | Credential not configured |

Each failure includes specific **remediation instructions** with URLs to fix the issue.

### Required API Permissions by Service

| Service | Required Permissions | Key Type |
|---------|---------------------|----------|
| **Vercel** | Full Account scope | Personal token |
| **Render** | Full API access | API key (not scoped) |
| **GitHub** | Actions R/W, Contents R/W, Issues R/W, PRs R/W, Secrets R/W, Environments R/W | Fine-grained PAT |
| **Cloudflare** | Zone DNS Edit (for specific zone) | API token (Edit zone DNS template) |
| **Supabase** | Service role key (admin), anon key (public) | Project API keys |
| **Resend** | Full access (recommended) or Sending access (limited) | API key |
| **Elastic** | Read-only on `logs-*` indices | API key |
| **Codecov** | Any valid token (read-only API) | Upload token |
| **1Password** | Service account with vault access | Service account token |
