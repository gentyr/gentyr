# the stack

GENTYR chose managed services so every agent, hook, and server is purpose-built for exactly these tools. No abstraction layers. No configuration matrices. No "bring your own database."

Every technology below exists for one reason: it removes a decision that agents would otherwise need a human to make. Supabase provides auth, storage, and a database behind a single API. Vercel deploys frontend on push. Render deploys backend on push. 1Password resolves secrets without exposing values. The stack is not configurable because configurability is the enemy of autonomous operation.

Thirty MCP servers connect agents to these services. Each server speaks one protocol to one provider. When an agent needs to deploy, it talks to the Render server. When it needs a secret, it talks to the 1Password server. When it needs to query logs, it talks to the Elastic server. No adapters. No middleware. No indirection.

This is the stack. Learn it or choose a different framework.

---

## Application Layer

**TypeScript (strict, ESM)** is the only language. Strict mode catches type errors before agents write tests. ESM modules mean consistent import semantics across frontend, backend, and tooling. Every package in the monorepo shares the same language, the same compiler, the same rules.

**Next.js on Vercel** handles the frontend. Vercel's zero-config deployment means agents push code and it goes live. No Dockerfile, no build pipeline to maintain, no CDN to configure. The MCP server (`vercel`) manages deployments, environment variables, and project settings through Vercel's API.

**Hono on Render** runs the backend API. Hono is lightweight, TypeScript-native, and fast. Render provides persistent web services with health checks, auto-deploy from git, and managed TLS. The MCP server (`render`) handles service management, deploy triggers, and environment configuration.

**Supabase** provides PostgreSQL, authentication, file storage, and row-level security through a single dashboard and API. Agents interact through the MCP server (`supabase`) for schema management and through the Supabase client SDK for runtime queries. RLS policies are enforced at the database level, which means security doesn't depend on application code.

**Zod** handles runtime validation. Every API endpoint, every webhook handler, every configuration file gets a Zod schema. The compliance checker verifies this. Silent JSON parsing without validation is a spec violation.

## Infrastructure Layer

**pnpm monorepo** organizes the project. A single `pnpm-workspace.yaml` defines the package graph. Shared types live in `packages/shared`. The logger lives in `packages/logger`. Build and test commands run from the root.

**GitHub + Actions** handles source control and CI/CD. The merge chain (`feature -> preview -> staging -> main`) is enforced locally by hooks and remotely by branch protection rules. Actions run tests, lint, and type-checking on every push.

**1Password** is the single source of truth for secrets. Every credential is an `op://` reference. The MCP server (`onepassword`) resolves references at runtime. The secret-sync server pushes secrets to deployment platforms. Nothing is stored on disk. Nothing passes through agent context.

**Cloudflare** manages DNS. The MCP server (`cloudflare`) handles record creation and verification. Free tier is sufficient for most projects.

**Elastic Cloud** provides centralized logging. Application logs ship in ECS format from the structured logger (`packages/logger`). The MCP server (`elastic-logs`) queries Elasticsearch for error patterns, warning trends, and service health. The CTO dashboard aggregates log metrics from this source.

**Resend** handles transactional email. The MCP server (`resend`) sends emails and checks delivery status. Simple API, reliable delivery, no SMTP configuration.

**Codecov** reports test coverage. The MCP server (`codecov`) fetches coverage data for the CTO dashboard. Coverage trends are tracked over time and displayed in the testing section.

## Testing Layer

**Vitest** runs unit and integration tests. Fast, TypeScript-native, compatible with the monorepo structure. Test failures trigger automatic agent spawns via the test-failure-reporter hook.

**Playwright** runs end-to-end and browser tests. The MCP server (`playwright`) and feedback MCP servers (`playwright-feedback`, `programmatic-feedback`) enable AI personas to test the product as real users. No headless browser configuration needed.

---

## MCP Server Mappings

Each infrastructure service maps to one or more MCP servers that give agents programmatic access:

| Service | MCP Server(s) | Capabilities |
|---------|--------------|--------------|
| 1Password | `onepassword`, `secret-sync` | Resolve `op://` refs, sync to platforms, run with injected secrets |
| Render | `render` | Service management, deploys, environment variables, logs |
| Vercel | `vercel` | Project management, deploys, environment variables |
| Supabase | `supabase` | Schema management, migrations, RLS policies |
| GitHub | `github` | PRs, issues, Actions, branch management |
| Cloudflare | `cloudflare` | DNS records, zone management |
| Elastic Cloud | `elastic-logs` | Log queries, error analysis, volume metrics |
| Resend | `resend` | Email sending, delivery status |
| Codecov | `codecov` | Coverage data, trends |
| Chrome | `chrome-bridge` | Browser automation, page interaction, debugging |

Internal MCP servers (not tied to external providers):

| Server | Purpose |
|--------|---------|
| `todo-db` | Task database (SQLite) |
| `deputy-cto` | Triage pipeline, commit review, CTO questions |
| `agent-tracker` | Agent lifecycle, spawn/reap tracking |
| `agent-reports` | Report submission and query |
| `cto-reports`, `cto-report` | Dashboard data aggregation |
| `review-queue` | Commit review queue |
| `session-events` | Session lifecycle events |
| `session-restart` | Session restart coordination |
| `feedback-reporter`, `feedback-explorer`, `user-feedback` | Feedback pipeline |
| `playwright-feedback`, `programmatic-feedback` | AI persona testing |
| `specs-browser` | Specification document access |
| `setup-helper` | Installation and configuration |
| `makerkit-docs` | MakerKit documentation reference |
| `shared` | Shared utilities across servers |

---

## Monorepo Structure

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
