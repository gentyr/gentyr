# GENTYR - Godlike Entity, Not Technically Your Replacement

A modular automation framework for Claude Code that provides MCP servers, specialized agents, git hooks, and task management.

## Features

- **9 MCP Servers**: Task tracking, specifications, session events, reviews, reporting, and more
- **8 Framework Agents**: Code reviewer, test writer, investigator, deputy-CTO, etc. (projects can add their own)
- **2 Slash Commands**: `/cto-report`, `/deputy-cto`
- **11 Automation Hooks**: Pre-commit review, antipattern detection, API key rotation, usage optimization
- **Git Integration**: Husky hooks for pre-commit, post-commit, and pre-push

## Setup

All commands run from the framework directory. `--path` specifies the target project.

### Install

```bash
sudo scripts/setup.sh --path /path/to/project --protect
```

This creates a `.claude-framework` symlink in the target project, sets up `.claude/` symlinks, generates configs, installs husky hooks, builds MCP servers, and **makes critical files root-owned** so agents cannot bypass security mechanisms.

Protection is the default way to use this framework. Without it, agents can modify their own hook scripts, settings, and eslint config — defeating the point of the guardrails. Protected files:

- `.claude/hooks/pre-commit-review.js` — commit approval gate
- `.claude/hooks/bypass-approval-hook.js` — CTO bypass mechanism
- `.claude/hooks/block-no-verify.js` — prevents `--no-verify`
- `.claude/settings.json` — hook configuration
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
```

Toggle protection without reinstalling. Use `--unprotect-only` before making manual changes to protected files, then `--protect-only` to re-lock.

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

The deputy-cto can run autonomously, triaging reports and handling routine decisions without user intervention:

```typescript
mcp__deputy-cto__toggle_autonomous({ enabled: true })
```

### Persistent Automation Service

A 10-minute timer service drives all background automation. Individual tasks have their own cooldowns, so each invocation only runs what's due.

**What it does (in order):**
1. **Usage optimizer** - Fetches API quota, projects usage trajectory, adjusts spawn rates to target 90% utilization at reset
2. **Report triage** - Checks for pending CTO reports (5-min cooldown)
3. **Lint checker** - Runs ESLint and fixes errors (30-min cooldown)
4. **Task runner** - Spawns agents for pending TODO tasks (15-min cooldown, 1 per section, max 4 concurrent)
5. **Hourly tasks** - Plan executor, CLAUDE.md refactoring (55-min cooldown)

**Configuration files:**
- `autonomous-mode.json` - Master switch (`enabled: true/false`)
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

Project specs in `specs/` are browsable by all agents and enforced during code review:

```typescript
mcp__specs-browser__get_spec({ spec_id: "G001" })
// → "Fail-Closed Error Handling: All error handling must fail-closed. Never fail-open."
```

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
│   ├── commands/               # 2 slash commands (.md)
│   │   ├── cto-report.md
│   │   └── deputy-cto.md
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
│   ├── mcp-servers/            # 9 TypeScript MCP servers
│   │   ├── src/
│   │   │   ├── agent-tracker/
│   │   │   ├── todo-db/
│   │   │   ├── specs-browser/
│   │   │   ├── session-events/
│   │   │   ├── review-queue/
│   │   │   ├── agent-reports/
│   │   │   ├── deputy-cto/
│   │   │   ├── cto-report/
│   │   │   └── cto-reports/
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
├── scripts/
│   ├── setup.sh                # Install/uninstall script
│   └── setup-automation-service.sh  # 10-min timer service
├── .mcp.json.template          # MCP config template
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
   - `.mcp.json` from template with correct paths

4. **Husky hooks installed**:
   - `.husky/pre-commit`
   - `.husky/post-commit`
   - `.husky/pre-push`

5. **MCP servers built**:
   - `npm install && npm run build` in `packages/mcp-servers/`

6. **Gitignore updated**:
   - Runtime files excluded (`.db`, `*-state.json`, etc.)

## MCP Servers

| Server | Purpose |
|--------|---------|
| `todo-db` | Task tracking with SQLite |
| `specs-browser` | Read project specifications |
| `agent-tracker` | Track spawned agent sessions |
| `session-events` | Log session events |
| `review-queue` | Schema mapping review queue |
| `agent-reports` | Agent report triage queue |
| `deputy-cto` | Deputy-CTO decision management |
| `cto-report` | CTO metrics and status (data aggregation) |
| `cto-reports` | Historical report storage and retrieval |

### Using MCP Tools

```typescript
// Task management
mcp__todo-db__create_task({ section: "CODE-REVIEWER", title: "Review PR #42" })
mcp__todo-db__start_task({ id: "uuid" })
mcp__todo-db__complete_task({ id: "uuid" })

// Read specifications
mcp__specs-browser__list_specs()
mcp__specs-browser__get_spec({ spec_id: "G001" })

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

### Custom CLAUDE.md

Each project should have its own `CLAUDE.md` at the project root with project-specific instructions.

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

### Symlinks broken

```bash
scripts/setup.sh --path /path/to/project
```

### Permission denied errors

Protection is active. Either use `sudo` or unprotect first:

```bash
sudo scripts/setup.sh --path /path/to/project --unprotect-only
```

## Version History

- **1.1.0**: Changed agent installation from directory symlink to individual file symlinks. Framework now provides 8 core agents; projects can add their own without conflicts.
- **1.0.0**: Initial release with 9 MCP servers, 8 framework agents, 15 hooks

## License

MIT

See [TESTING.md](./TESTING.md) for the comprehensive end-to-end test plan. This file is copied into each project's `.claude/TESTING.md` during installation.
