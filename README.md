# GENTYR - Godlike Entity, Not Technically Your Replacement

A modular automation framework for Claude Code that provides MCP servers, specialized agents, git hooks, and task management.

## Features

- **19 MCP Servers**: 9 core (task tracking, specs, reviews, reporting) + 10 infrastructure (Render, Vercel, GitHub, Supabase, Cloudflare, Resend, Elasticsearch, 1Password, Codecov, secret-sync)
- **8 Framework Agents**: Code reviewer, test writer, investigator, deputy-CTO, etc. (projects can add their own)
- **4 Slash Commands**: `/cto-report`, `/deputy-cto`, `/setup-gentyr`, `/push-secrets`
- **11 Automation Hooks**: Pre-commit review, antipattern detection, API key rotation, usage optimization
- **Git Integration**: Husky hooks for pre-commit, post-commit, and pre-push
- **Project Scaffolding**: `setup.sh --scaffold` creates new projects from templates with the full stack

## Setup

All commands run from the framework directory. `--path` specifies the target project.

### Scaffold a New Project

```bash
scripts/setup.sh --scaffold --path /path/to/new-project
```

Creates a new project from templates with pnpm workspace, TypeScript config, backend boilerplate, shared packages, and directory structure. After scaffolding, install GENTYR with the command below.

### Install

```bash
sudo scripts/reinstall.sh --path /path/to/project
```

This is the recommended single command for installing GENTYR. It handles everything:

1. **Unprotects** existing files (safe on fresh installs)
2. **Installs** framework — symlinks, configs, husky hooks, MCP server build, automation service
3. **Protects** critical files — makes them root-owned so agents cannot bypass security mechanisms

After installation:

1. **Start a new Claude Code session**
2. **Run `/setup-gentyr`** to configure credentials interactively
   - Discovers your 1Password vaults
   - Maps credential keys to `op://` references (no secrets on disk)
   - Writes `.claude/vault-mappings.json` with only vault references
3. **Restart Claude Code** to activate MCP servers with credentials

**Protected files** (root-owned after install):

- `.claude/hooks/pre-commit-review.js` — commit approval gate
- `.claude/hooks/bypass-approval-hook.js` — CTO bypass mechanism
- `.claude/hooks/block-no-verify.js` — prevents `--no-verify`
- `.claude/hooks/protected-action-gate.js` — MCP action approval gate (with `--protect-mcp`)
- `.claude/hooks/protected-action-approval-hook.js` — MCP approval processor (with `--protect-mcp`)
- `.claude/hooks/protected-actions.json` — MCP action protection config (with `--protect-mcp`)
- `.claude/protected-action-approvals.json` — MCP approval state (with `--protect-mcp`)
- `.claude/settings.json` — hook configuration
- `.claude/protection-key` — HMAC key for approval signing
- `.mcp.json` — MCP server config (launcher references, no credentials)
- `.husky/pre-commit` — git hook entry point
- `eslint.config.js` — lint rules
- `package.json` — lint-staged config

Multiple projects can share the same framework — each gets its own runtime state in its own `.claude/` directory.

To install without protection (development/testing only):

```bash
scripts/setup.sh --path /path/to/project
```

### Uninstall

```bash
sudo scripts/setup.sh --path /path/to/project --uninstall
```

Automatically removes protection, then removes symlinks, generated configs, and husky hooks. Runtime state (`.claude/*.db`) is preserved.

### Protect / Unprotect (standalone)

```bash
sudo scripts/setup.sh --path /path/to/project --protect-only
sudo scripts/setup.sh --path /path/to/project --unprotect-only
sudo scripts/setup.sh --path /path/to/project --protect-mcp  # MCP action protection only
```

Toggle protection without reinstalling. Use `--unprotect-only` before making manual changes to protected files, then `--protect-only` to re-lock. Use `--protect-mcp` to protect only MCP action configuration files.

### Verify

```bash
cd /path/to/project && claude mcp list
```

## What You Get

Once installed, the framework runs automatically. Here's what it looks like in practice:

### CTO Dashboard (every prompt)

On each user prompt, a status bar displays live metrics:

**Single API key:**
```
Quota: 5-hour ████████░░ 78% (resets 2h) | 7-day ██████░░░░ 58% (resets 4d)
Usage (30d): 12.4M tokens | 47 task / 12 user sessions | TODOs: 3 queued, 1 active | Deputy: ON (32min)
Pending: 2 CTO decision(s), 1 unread report(s)
```

**Multiple API keys (aggregate quota):**
```
Quota (3 keys): 5h ██████░░ 45% avg (135% total) | 7d ██████░░░░ 60% avg (179% total)
Usage (30d): 12.4M tokens | 47 task / 12 user sessions | TODOs: 3 queued, 1 active | Deputy: ON (32min)
Pending: 2 CTO decision(s), 1 unread report(s)
```

When CTO rejections are blocking commits:

```
COMMITS BLOCKED: 1 rejection(s) | Quota (3k): 5h 45%avg 7d 60%avg | 8.2M tokens | Deputy: ON. Use /deputy-cto to address.
```

### Pre-Commit Review Gate

Every commit is reviewed by the deputy-cto agent before it lands. The hook runs lint-staged, checks for pending CTO decisions, and blocks commits with untriaged agent reports:

```
$ git commit -m "add auth module"
  ✓ lint-staged passed
  ✓ No untriaged agent reports
  ✗ 1 pending CTO question — commit blocked
  Use /deputy-cto to review and answer pending questions.
```

### Agent Reports

Agents can escalate issues to the CTO queue during their work:

```typescript
mcp__agent-reports__report_to_deputy_cto({
  reporting_agent: "code-reviewer",
  title: "Potential SQL injection in user query",
  summary: "Raw string interpolation used in DB query at src/db.ts:42",
  category: "security",
  priority: "high"
})
```

### CTO Commands

- **`/cto-report`** — Full metrics dashboard: token usage, session history, agent activity, task status, quota utilization
- **`/deputy-cto`** — Review and answer pending CTO decisions, triage agent reports, manage autonomous mode

### Autonomous Mode

Autonomous mode is **enabled by default** when GENTYR is installed. The `setup.sh` script pre-populates `autonomous-mode.json` with all automations active. To disable:

```typescript
mcp__deputy-cto__toggle_autonomous_mode({ enabled: false })
```

### CTO Approval System for MCP Actions

Protect critical MCP actions (production deployments, database migrations, API key rotation) behind CTO approval gates. When an agent attempts a protected action:

1. **Action blocked** - Agent receives message: "Action blocked. CTO must type: APPROVE PROD A7X9K2"
2. **CTO approves** - User types the approval phrase in chat
3. **Action executes** - Agent retries, action succeeds (one-time use, 5-minute expiry)

**Setup:**

```bash
# Create protected-actions.json config
cp .claude-framework/.claude/hooks/protected-actions.json.template .claude/hooks/protected-actions.json

# Encrypt credential for approval phrase
node .claude-framework/scripts/encrypt-credential.js

# Generate spec file (optional, for agent reference)
node .claude-framework/scripts/generate-protected-actions-spec.js

# Enable protection (makes config root-owned)
sudo scripts/setup.sh --path /path/to/project --protect-mcp
```

**Check protected actions:**

```typescript
// List all protected MCP actions
mcp__deputy-cto__list_protections()

// Get details of pending approval request
mcp__deputy-cto__get_protected_action_request({ code: "A7X9K2" })
```

**Security features:**
- Fail-closed design (blocks on any error)
- One-time use approval tokens
- 5-minute expiration
- AES-256-GCM encrypted credentials
- Cryptographically secure random codes

### Persistent Automation Service

A 10-minute timer service drives all background automation. Individual tasks have their own cooldowns, so each invocation only runs what's due.

**CTO Activity Gate (24-Hour Requirement):**
All automation requires the CTO to have run `/deputy-cto` within the past 24 hours. This fail-closed safety mechanism prevents runaway automation when the CTO is not actively engaged with the project. If the gate is closed, the hourly service logs the reason and exits without running any automations.

**What it does (in order):**
1. **Usage optimizer** - Fetches API quota, projects usage trajectory, adjusts spawn rates to target 90% utilization at reset
2. **Report triage** - Checks for pending CTO reports (5-min cooldown)
3. **Lint checker** - Runs ESLint and fixes errors (30-min cooldown)
4. **Task runner** - Spawns a separate Claude session for every pending TODO item >1h old (1h cooldown)
5. **Preview/staging promotion** - Automated PR creation for environment promotion (6h/midnight cooldowns)
6. **Health monitors** - Staging (3h) and production (1h) infrastructure health checks
7. **Standalone antipattern hunter** - Repo-wide spec violation scan (3h cooldown, independent of git hooks)
8. **Standalone compliance checker** - Random spec compliance audit (1h cooldown, picks one spec per run)
9. **CLAUDE.md refactoring** - Refactors CLAUDE.md when it exceeds 25K characters (55-min cooldown)

**Configuration files:**
- `autonomous-mode.json` - Master config with per-feature toggles (all enabled by default)
- `.claude/state/automation-config.json` - Cooldown defaults + dynamic adjustments
- `.claude/state/usage-snapshots.json` - API usage history (7-day retention)

**Service management:**
```bash
scripts/setup-automation-service.sh status --path /project  # Check service status
scripts/setup-automation-service.sh remove --path /project  # Remove service
scripts/setup-automation-service.sh run --path /project     # Manual run
```

The service is automatically installed/removed by `setup.sh`.

### Task Runner

The task runner automatically spawns agents to process pending tasks from the TODO database (todo.db). Every 15 minutes, it:

1. Queries for the oldest pending task per section
2. Excludes sections that already have in_progress tasks
3. Skips tasks created less than 2 minutes ago (prevents chain reactions)
4. Spawns agents in fire-and-forget mode (detached process)

**Rate limiting:**
- 1 task per section per 15-minute cycle
- Maximum 4 concurrent spawns (code-reviewer, investigator, test-writer, project-manager)

**Agent mapping:**
- CODE-REVIEWER → code-reviewer agent
- INVESTIGATOR & PLANNER → investigator agent
- TEST-WRITER → test-writer agent
- PROJECT-MANAGER → project-manager agent

**Stale task cleanup:**
Tasks stuck in_progress for more than 30 minutes are automatically reset to pending by the todo-maintenance hook.

**Configuration:**
Enable/disable in `autonomous-mode.json`:
```json
{
  "taskRunnerEnabled": true
}
```

Adjust cooldown in `.claude/state/automation-config.json`:
```json
{
  "defaults": {
    "task_runner": 15
  }
}
```

### Antipattern Detection

Post-commit hook spawns the antipattern-hunter agent (with 6-hour cooldown) to scan for spec violations. Results feed into the agent-reports queue for CTO triage.

### Specification Enforcement

Project specs in `specs/` are browsable by all agents and enforced during code review. The specs-browser MCP server now supports spec suites for scoped enforcement:

```typescript
// Browse specifications
mcp__specs-browser__get_spec({ spec_id: "G001" })
// → "Fail-Closed Error Handling: All error handling must fail-closed. Never fail-open."

// Manage spec suites (scope specs to file patterns)
mcp__specs-browser__listSuites()
mcp__specs-browser__createSuite({
  suite_id: "integration-frontend",
  description: "Frontend connector specs",
  scope: "integrations/*/frontend-connector/**",
  global: {
    specsDir: "specs/integrations",
    pattern: "INT-FRONTEND-*.md"
  },
  enabled: true,
  priority: 10
})

// Create and edit specs
mcp__specs-browser__createSpec({
  spec_id: "INT-001",
  title: "Integration API Standards",
  category: "integrations",
  content: "# INT-001: Integration API Standards\n\n..."
})
```

**Spec Suites**: Group specifications that apply to specific directory patterns. For example, integration-specific specs only check integration files, reducing enforcement noise.

## Directory Structure

```
.claude-framework/
├── .claude/
│   ├── agents/                 # 8 framework agent definitions (.md)
│   │   ├── antipattern-hunter.md
│   │   ├── code-reviewer.md
│   │   ├── code-writer.md
│   │   ├── deputy-cto.md
│   │   ├── investigator.md
│   │   ├── project-manager.md
│   │   ├── repo-hygiene-expert.md
│   │   └── test-writer.md
│   ├── commands/               # 4 slash commands (.md)
│   │   ├── cto-report.md
│   │   ├── deputy-cto.md
│   │   ├── setup-gentyr.md
│   │   └── push-secrets.md
│   ├── hooks/                  # 11 hooks + 5 utility modules (.js)
│   │   ├── pre-commit-review.js
│   │   ├── antipattern-hunter-hook.js
│   │   ├── api-key-watcher.js
│   │   ├── config-reader.js
│   │   ├── usage-optimizer.js
│   │   ├── __tests__/
│   │   └── prompts/
│   ├── mcp/                    # MCP documentation
│   └── settings.json.template
├── packages/
│   ├── mcp-servers/            # 19 TypeScript MCP servers
│   │   ├── src/
│   │   │   ├── agent-tracker/  # Core servers
│   │   │   ├── todo-db/
│   │   │   ├── specs-browser/
│   │   │   ├── session-events/
│   │   │   ├── review-queue/
│   │   │   ├── agent-reports/
│   │   │   ├── deputy-cto/
│   │   │   ├── cto-report/
│   │   │   ├── cto-reports/
│   │   │   ├── render/         # Infrastructure servers
│   │   │   ├── vercel/
│   │   │   ├── github/
│   │   │   ├── cloudflare/
│   │   │   ├── supabase/
│   │   │   ├── resend/
│   │   │   ├── elastic-logs/
│   │   │   ├── onepassword/
│   │   │   ├── codecov/
│   │   │   └── secret-sync/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── cto-dashboard/          # Ink-based CLI dashboard (invoked by /cto-report)
│       ├── src/
│       │   ├── components/
│       │   ├── utils/
│       │   └── App.tsx
│       ├── package.json
│       └── tsconfig.json
├── husky/                      # Git hook templates
│   ├── pre-commit
│   ├── post-commit
│   └── pre-push
├── templates/                  # Project scaffolding templates
│   ├── config/                 # Config files (package.json, tsconfig, etc.)
│   └── scaffold/               # Project structure (packages, products, specs)
├── docs/                       # Stack reference docs
│   ├── STACK.md                # Official stack definition
│   ├── SECRET-PATHS.md         # Canonical 1Password op:// paths
│   └── SETUP-GUIDE.md          # Step-by-step credential setup
├── scripts/
│   ├── setup.sh                # Install/uninstall/scaffold script
│   ├── mcp-launcher.js         # Runtime credential resolver (1Password → env vars)
│   ├── hooks/                  # Staged hooks (deployed to .claude/hooks/ during install)
│   │   └── credential-health-check.js
│   └── setup-automation-service.sh  # 10-min timer service
├── .mcp.json.template          # MCP config template (19 servers)
├── version.json                # Framework version
└── README.md
```

## What Gets Installed

When you run `setup.sh`, the following happens:

1. **Symlinks created in `.claude/`**:
   - `.claude/agents/*.md` → individual symlinks for 8 framework agents (preserves project-specific agents)
   - `.claude/commands` → `.claude-framework/.claude/commands`
   - `.claude/hooks` → `.claude-framework/.claude/hooks`
   - `.claude/mcp` → `.claude-framework/.claude/mcp`

2. **Settings copied** (if not exists):
   - `.claude/settings.json` from template

3. **MCP config generated**:
   - `.mcp.json` from template with correct paths (infrastructure servers routed through launcher)

4. **Vault mappings created** (if not exists):
   - `.claude/vault-mappings.json` — empty template, populated by `/setup-gentyr`

5. **Husky hooks installed**:
   - `.husky/pre-commit`
   - `.husky/post-commit`
   - `.husky/pre-push`

6. **MCP servers built**:
   - `npm install && npm run build` in `packages/mcp-servers/`

7. **Staged hooks deployed**:
   - Copies hooks from `scripts/hooks/` to `.claude/hooks/`

8. **Gitignore updated**:
   - Runtime files excluded (`.db`, `*-state.json`, etc.)

## MCP Servers

### Core Servers (project-local state)

| Server | Purpose |
|--------|---------|
| `todo-db` | Task tracking with SQLite |
| `specs-browser` | Manage project specifications and spec suites (CRUD) |
| `agent-tracker` | Track spawned agent sessions |
| `session-events` | Log session events |
| `review-queue` | Schema mapping review queue |
| `agent-reports` | Agent report triage queue |
| `deputy-cto` | Deputy-CTO decision management |
| `cto-report` | CTO metrics and status (data aggregation) |
| `cto-reports` | Historical report storage and retrieval |

### Infrastructure Servers (opinionated stack)

| Server | Purpose | Env Vars |
|--------|---------|----------|
| `render` | Render service management | `RENDER_API_KEY` |
| `vercel` | Vercel deployment management | `VERCEL_TOKEN`, `VERCEL_TEAM_ID` |
| `github` | GitHub repository and workflow management | `GITHUB_TOKEN` |
| `cloudflare` | Cloudflare DNS management | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` |
| `supabase` | Supabase project management | `SUPABASE_ACCESS_TOKEN` |
| `resend` | Resend email service | `RESEND_API_KEY` |
| `elastic-logs` | Elasticsearch log querying | `ELASTIC_CLOUD_ID`, `ELASTIC_API_KEY` |
| `onepassword` | 1Password vault management | `OP_SERVICE_ACCOUNT_TOKEN` |
| `codecov` | Codecov coverage management | `CODECOV_TOKEN` |
| `secret-sync` | Sync secrets from 1Password to Render/Vercel (values never reach agent) | `OP_SERVICE_ACCOUNT_TOKEN`, `RENDER_API_KEY`, `VERCEL_TOKEN` |

Infrastructure server credentials are resolved at runtime by the **MCP Launcher** from 1Password vault mappings. Servers launch without credentials and fail gracefully until configured via `/setup-gentyr`.

### MCP Launcher (Runtime Credential Resolution)

Infrastructure MCP servers are started through `scripts/mcp-launcher.js`, which resolves credentials from 1Password at runtime:

1. Reads `.claude/vault-mappings.json` for `op://` references
2. Reads `.claude/hooks/protected-actions.json` for which keys each server needs
3. Resolves each credential via `op read` (1Password CLI)
4. Sets credentials as environment variables in the server process
5. Imports and runs the actual MCP server

**Credentials only exist in process memory — never written to disk.**

`.claude/vault-mappings.json` contains only `op://` vault references (not secrets):
```json
{
  "provider": "1password",
  "mappings": {
    "GITHUB_TOKEN": "op://Production/GitHub/token",
    "RENDER_API_KEY": "op://Production/Render/api-key"
  }
}
```

This file is populated interactively by `/setup-gentyr` and is NOT blocked by credential-file-guard (it contains no secrets). Core servers (todo-db, specs-browser, etc.) run directly without the launcher since they need no external credentials.

### Using MCP Tools

```typescript
// Task management
mcp__todo-db__create_task({ section: "CODE-REVIEWER", title: "Review PR #42" })
mcp__todo-db__start_task({ id: "uuid" })
mcp__todo-db__complete_task({ id: "uuid" })

// Manage specifications and suites
mcp__specs-browser__list_specs()
mcp__specs-browser__get_spec({ spec_id: "G001" })
mcp__specs-browser__get_specs_for_file({ file_path: "src/auth.ts" })
// → { specs: [{ spec_id: "G001", file: "specs/global/G001.md" }], subspecs: [...] }
mcp__specs-browser__createSpec({ spec_id: "G020", title: "...", content: "..." })
mcp__specs-browser__listSuites()
mcp__specs-browser__createSuite({ suite_id: "...", scope: "**/*.ts", ... })

// Report to deputy-cto
mcp__agent-reports__report_to_deputy_cto({
  reporting_agent: "code-reviewer",
  title: "Security concern in auth module",
  summary: "Found potential XSS vulnerability...",
  category: "security",
  priority: "high"
})
```

## Framework Agents

The framework provides 8 core agents (installed as individual symlinks):

| Agent | Role |
|-------|------|
| `investigator` | Research and planning |
| `code-writer` | Implementation |
| `code-reviewer` | Code review and commits |
| `test-writer` | Test creation |
| `project-manager` | Documentation and cleanup |
| `deputy-cto` | CTO's executive assistant |
| `antipattern-hunter` | Spec violation detection |
| `repo-hygiene-expert` | Repository structure |

Projects can define additional project-specific agents by adding `.md` files directly to `.claude/agents/`. The setup script preserves these files and only manages framework agent symlinks.

## Git Hooks

### Pre-commit
1. Runs lint-staged
2. Spawns deputy-cto for commit review
3. Blocks if CTO questions pending or untriaged reports exist

### Post-commit (fire-and-forget)
1. Runs compliance checker
2. Spawns antipattern hunter (6-hour cooldown)

### Pre-push
1. Runs full test suite (unit + integration)
2. Spawns repo-hygiene-expert for structure review

## Customization

### Project-Specific Settings

Create `.claude/settings.local.json` for project-specific overrides:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "echo 'Custom hook!'"
          }
        ]
      }
    ]
  }
}
```

### Project Specifications

Create a `specs/` directory in your project root:

```
specs/
├── global/           # System-wide invariants
│   └── CORE-INVARIANTS.md
├── local/            # Component specs
└── reference/        # Development guides
```

### CLAUDE.md Agent Instructions

The setup script automatically manages `CLAUDE.md` in target projects:

**Install behavior:**
- Creates `CLAUDE.md` if it doesn't exist (using framework template)
- Appends GENTYR agent workflow section if file exists
- Replaces existing GENTYR section on re-installs (no duplicates)
- Section is marked with `<!-- GENTYR-FRAMEWORK-START/END -->` comments

**Uninstall behavior:**
- Removes GENTYR section from `CLAUDE.md`
- Deletes `CLAUDE.md` if it becomes empty after removal
- Preserves project-specific content above/below the GENTYR section

**Template location:** `.claude-framework/CLAUDE.md.gentyr-section`

The injected section provides agents with:
- Golden rules for agent workflow
- Standard development sequence (investigator → code-writer → test-writer → code-reviewer → project-manager)
- CTO reporting guidelines
- Available slash commands (`/cto-report`, `/deputy-cto`)

Projects can add their own project-specific instructions above or below the GENTYR section.

## Requirements

- Node.js 18+
- Claude Code CLI

## Troubleshooting

### MCP servers not showing

```bash
# Verify .mcp.json exists and has correct paths
cat .mcp.json

# Rebuild MCP servers
cd .claude-framework/packages/mcp-servers
npm run build
```

### MCP servers missing credentials

If you see "GENTYR: X credential mapping(s) not configured" on session start:

```
Run /setup-gentyr to configure credentials via 1Password discovery.
Then restart Claude Code to activate MCP servers.
```

### Symlinks broken or need to update

```bash
sudo scripts/reinstall.sh --path /path/to/project
```

### Permission denied errors

Protection is active. Reinstall handles unprotect/protect automatically:

```bash
sudo scripts/reinstall.sh --path /path/to/project
```

For one-off manual changes, unprotect first then re-protect:

```bash
sudo scripts/setup.sh --path /path/to/project --unprotect-only
# ... make changes ...
sudo scripts/setup.sh --path /path/to/project --protect-only
```

## Version History

- **2.1.0**: MCP Launcher architecture. Credentials resolved from 1Password at runtime via `mcp-launcher.js` — no secrets on disk. Interactive `/setup-gentyr` with 1Password vault auto-discovery. SessionStart health check for missing credentials. Removed `--with-credentials` flag (all credential config happens in-session).
- **2.0.0**: Opinionated stack framework. Added 10 infrastructure MCP servers (Render, Vercel, GitHub, Cloudflare, Supabase, Resend, Elasticsearch, 1Password, Codecov, secret-sync). Added `/setup-gentyr` and `/push-secrets` commands. Added project scaffolding (`--scaffold`). Added stack reference docs. Secret values never reach agent context.
- **1.1.0**: Changed agent installation from directory symlink to individual file symlinks. Framework now provides 8 core agents; projects can add their own without conflicts.
- **1.0.0**: Initial release with 9 MCP servers, 8 framework agents, 15 hooks

## License

MIT

See [TESTING.md](./TESTING.md) for the comprehensive end-to-end test plan. This file is copied into each project's `.claude/TESTING.md` during installation.
