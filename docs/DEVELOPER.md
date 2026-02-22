# GENTYR Developer Guide

Local development from the cloned gentyr source repository.

## Prerequisites

- Node.js 20+
- pnpm 8+
- Claude Code CLI

## Setup: Link gentyr to a target project

```bash
cd ~/git/my-project                    # your target project
pnpm link ~/git/gentyr                 # creates node_modules/gentyr -> ~/git/gentyr
npx gentyr init --op-token TOKEN       # first-time setup (configs, symlinks, services)
sudo npx gentyr protect                # optional: enable root-owned file protection
```

`pnpm link` creates a symlink from `node_modules/gentyr` to your local gentyr working tree. All framework changes propagate automatically through this symlink.

## Propagation model

After linking, editing anything in `~/git/gentyr` takes effect:

| What you edit | When it takes effect | Mechanism |
|---|---|---|
| Hook JS code (`.claude/hooks/`) | Immediate | Directory symlink |
| Command MDs (`.claude/commands/`) | Immediate | Directory symlink |
| Agent definitions (`.claude/agents/*.md`) | Immediate | File symlinks |
| MCP docs (`.claude/docs/`) | Immediate | Directory symlink |
| MCP server dist JS | Immediate (after TS build) | Referenced via node_modules/gentyr in .mcp.json |
| `settings.json.template` | Next Claude Code session | SessionStart re-merges on config hash change |
| `.mcp.json.template` | Next Claude Code session | SessionStart regenerates on config hash change |
| MCP TypeScript source | Next Claude Code session | Auto-rebuild attempted; build explicitly after edits |
| Husky hooks (`husky/`) | Next Claude Code session | Auto-sync compares and re-copies |
| `CLAUDE.md.gentyr-section` | Next Claude Code session | SessionStart replaces managed section |
| New agent definitions | Next Claude Code session | SessionStart symlinks on version change |
| `rotation-proxy.js` | Next service restart | Launchd plist uses resolved path |
| `hourly-automation.js` | Next 10-min trigger | Launchd plist uses symlink path |
| Launchd plist config | `npx gentyr sync` in target project | Developer responsibility (rare) |

No manual copy steps are needed. Everything auto-propagates through symlinks or the SessionStart sync hook.

## Migrate an existing project

If the target project was previously installed via `.claude-framework`:

```bash
cd ~/git/my-project
pnpm link ~/git/gentyr                 # creates node_modules/gentyr
npx gentyr migrate                     # converts symlinks, regenerates .mcp.json
```

## Common development tasks

### Edit a hook

Edit the file directly in `~/git/gentyr/.claude/hooks/`. Changes are visible immediately in any linked project (directory symlink).

### Edit an MCP server

Edit TypeScript in `~/git/gentyr/packages/mcp-servers/src/`. The next Claude Code session will auto-rebuild when it detects `src/` is newer than `dist/`. Or rebuild manually:

```bash
cd ~/git/gentyr/packages/mcp-servers && npm run build
```

### Edit settings.json.template

Edit `~/git/gentyr/.claude/settings.json.template`. The next Claude Code session detects the config hash change and re-merges into the target project's `settings.json`.

### Edit husky hooks

Edit files in `~/git/gentyr/husky/`. The next Claude Code session compares content and re-copies any changed hooks to `.husky/` in the target project.

### Edit CLAUDE.md section

Edit `~/git/gentyr/CLAUDE.md.gentyr-section`. The next Claude Code session replaces the managed section (between `<!-- GENTYR-FRAMEWORK-START -->` and `<!-- GENTYR-FRAMEWORK-END -->` markers) in the target project's `CLAUDE.md`.

### Force sync everything

```bash
cd ~/git/my-project && npx gentyr sync
```

Rebuilds MCP servers, re-merges settings.json, regenerates .mcp.json, syncs husky hooks, and regenerates launchd plists.

## Protection

Root-owned file protection prevents agent self-modification of critical framework files:

```bash
sudo npx gentyr protect                # enable protection
sudo npx gentyr unprotect              # disable (required before editing protected files)
```

When protection is active, `.claude/hooks/` is root-owned. You must unprotect before creating new files there.

## Verify installation

```bash
cd ~/git/my-project && npx gentyr status
cd ~/git/my-project && claude mcp list   # verify all MCP servers start
```

## For published package users

Non-developers install from npm:

```bash
pnpm add gentyr
npx gentyr init --op-token TOKEN
```

Updates require `pnpm update gentyr`.
