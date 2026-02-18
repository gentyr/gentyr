# GENTYR

**G**odlike **E**ntity, **N**ot **T**echnically **Y**our **R**eplacement

A governance framework for Claude Code.

AI agents hallucinate, cut corners, and make autonomous decisions that undermine code quality. Without governance, you have an unsupervised intern with root access. GENTYR adds specialized agents, approval gates, and continuous automation to Claude Code. Problems get caught and handled without you thinking about them.

## Quick Start

```bash
sudo scripts/reinstall.sh --path /path/to/project
```

Start Claude Code in your project, run `/setup-gentyr` to configure credentials, then restart. See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for details.

## What You Get

- **Commit approval gate** -- every commit reviewed by deputy-CTO agent before it lands
- **Specialized agents** -- 9 agents in a fixed workflow: investigate, write, test, review, ship
- **Zero secrets on disk** -- credentials resolve from 1Password at runtime; only `op://` references stored
- **Background task runner** -- spawns agents for pending TODOs on a timer; you set direction, agents execute
- **AI user feedback** -- persona-based testing (GUI/CLI/API/SDK) triggered by staging changes
- **Usage optimizer** -- dynamically adjusts spawn rates to target 90% API quota utilization
- **Real-time dashboard** -- CLI status bar and VS Code extension with quota, agents, and infrastructure health
- **Protection model** -- critical files root-owned; agents cannot modify the rules they operate under

## How It Works

```
┌──────────────────────────────────┐      ┌──────────────────────────────────┐
│      GENTYR FRAMEWORK            │      │       YOUR PROJECT               │
│      (central repo)              │      │       (any repo)                 │
│                                  │      │                                  │
│  packages/                       │      │  src/                            │
│   └─ mcp-servers/                │      │  tests/                          │
│       ├─ todo-db                 │      │  specs/                          │
│       ├─ deputy-cto              │      │  CLAUDE.md                       │
│       └─ ...                     │      │                                  │
│                                  │      │  .claude/                        │
│  .claude/                        │      │   ├─ agents/ ←──────────────────┼── symlink
│   ├─ agents/   ──────────────────────────┼──→                              │
│   ├─ hooks/    ──────────────────────────┼──→ hooks/ ←────────────────────┼── symlink
│   └─ skills/   ──────────────────────────┼──→ skills/ ←───────────────────┼── symlink
│                                  │      │   │                              │
│                                  │      │   └─ LOCAL DATA (not symlinked)  │
│                                  │      │       ├─ todo.db                 │
│                                  │      │       ├─ deputy-cto.db           │
│                                  │      │       └─ reports.db              │
└──────────────────────────────────┘      └──────────────────────────────────┘
         SHARED CODE                              PROJECT STATE
    (update once, all projects                (isolated per project,
     get changes automatically)                never shared)
```

GENTYR installs as symlinks into your project's `.claude/` directory. The framework code is shared across projects; runtime state (databases, config) is isolated per project. One installation serves many repositories.

The agent workflow follows a fixed sequence: investigator, code-writer, test-writer, code-reviewer, project-manager. Each agent has domain-specific prompts and restricted tool access. The deputy-CTO agent gates commits and escalates ambiguous decisions to you.

## Components

- 25 MCP servers (9 core + 10 infrastructure + 5 feedback + 1 browser)
- 9 specialized agents
- 13 automation hooks
- 9 slash commands
- VS Code extension + CLI dashboard

## Documentation

- [Setup Guide](docs/SETUP-GUIDE.md) -- installation, credentials, protection, troubleshooting
- [Executive Overview](docs/Executive.md) -- architecture, capability inventory, dashboard reference
- [Deployment Flow](docs/DEPLOYMENT-FLOW.md) -- preview, staging, production promotion pipeline
- [Stack](docs/STACK.md) -- infrastructure providers and service configuration
- [Credential Detection](docs/CREDENTIAL-DETECTION.md) -- multi-layer API key detection architecture
- [Secret Paths](docs/SECRET-PATHS.md) -- canonical 1Password `op://` references
- [Testing](docs/TESTING.md) -- AI user feedback system and end-to-end test plan
- [Changelog](docs/CHANGELOG.md) -- version history

## Requirements

- Node.js 18+
- Claude Code CLI
- 1Password CLI (optional, for infrastructure credentials)

## License

[MIT](LICENSE)
