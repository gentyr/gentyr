# GENTYR Stack Reference

GENTYR is an opinionated Claude Code framework for a specific tech stack. All services below are expected.

## Services

| Service | Purpose | MCP Server |
|---------|---------|------------|
| **1Password** | Secret management (single source of truth) | `onepassword` |
| **Render** | Backend hosting (Node.js web services) | `render` |
| **Vercel** | Frontend hosting (Next.js) | `vercel` |
| **Supabase** | Database (PostgreSQL + Auth + Storage) | `supabase` |
| **GitHub** | Source control + CI/CD (Actions) | `github` |
| **Cloudflare** | DNS management | `cloudflare` |
| **Elastic Cloud** | Centralized logging (Elasticsearch + Kibana) | `elastic-logs` |
| **Resend** | Transactional email | `resend` |
| **Codecov** | Code coverage reporting | `codecov` |

## Architecture Pattern

```
Vercel (Frontend) <-> Render (Backend API) <-> Supabase (Database)
      |                    |
Cloudflare (DNS)     1Password (Secrets)
      |                    |
GitHub Actions (CI/CD)  Elastic Cloud (Logs)
                          |
                      Resend (Email)
```

## Monorepo Structure

GENTYR expects a pnpm monorepo with this layout:

```
project-root/
├── .claude-framework/          # GENTYR (symlinked)
├── .claude/config/services.json # Project-specific service IDs
├── products/
│   └── {product-name}/
│       └── apps/
│           ├── backend/        # Hono on Render
│           ├── web/            # Next.js on Vercel (MakerKit)
│           └── extension/      # Browser extension (optional)
├── packages/
│   ├── shared/                 # Shared types and utilities
│   └── logger/                 # Structured logger (ECS format)
├── integrations/               # Platform connectors
├── specs/
│   ├── global/                 # System-wide invariants
│   ├── local/                  # Component specifications
│   └── reference/              # Development guides
├── render.yaml                 # Render blueprint
├── pnpm-workspace.yaml         # Monorepo config
└── .github/workflows/ci.yml    # CI pipeline
```
