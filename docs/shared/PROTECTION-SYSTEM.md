# GENTYR Protection System

Multi-layered defense-in-depth architecture protecting the development pipeline from accidental and adversarial misuse by AI agents.

## Overview

GENTYR uses root-owned critical hook files to prevent agent tampering with core safety checks. Tamper detection runs at commit time and session start.

## Threat Model

### What GENTYR Protects Against

| Threat | Description |
|--------|-------------|
| Hook tampering | Agent deleting or modifying git hooks or Claude Code hooks to remove safety checks |
| Audit gate bypass | Agent attempting to complete tasks while `pending_audit` is active |
| Git hook bypass | Agent using `--no-verify`, `-n`, or `core.hooksPath` to skip pre-commit review |
| Lint weakening | Agent suppressing ESLint warnings or errors via flags or config file changes |

### Trust Boundaries

| Principal | Trust Level | Capabilities |
|-----------|-------------|-------------|
| CTO (human) | Full trust | Reviews commits, manages secrets, signs off releases |
| deputy-cto agent | Elevated trust | Reviews commits, triages reports |
| Other agents | Standard | Follow agent definitions and guidance; cannot tamper with root-owned hooks |

## Layer 1: Root Ownership

**Command**: `npx gentyr protect`

OS-level access control that prevents agents from modifying critical files, even with shell access.

### What Gets Protected

**Directories** (root-owned, sticky bit `1755`):
- `.husky/` -- git hook infrastructure

Note: `.claude/` and `.claude/hooks/` are intentionally **not** root-owned as directories. Git requires write access to these paths for atomic file operations (`git stash`, `git checkout`, `git merge`). Root-owning `.claude/` blocked runtime file creation (databases, state files) and broke tracked git operations. Symlink target verification (described below) replaces directory ownership as the anti-tampering mechanism.

**Files** (root-owned, `644`):
- Hook scripts: `pre-commit-review.js`, `block-no-verify.js`, `gate-confirmation-enforcer.js`, `signal-compliance-gate.js`
- Configuration: `.claude/settings.json`, `.mcp.json`, `eslint.config.js`, `package.json`
- Git hooks: `.husky/pre-commit` (`755`, executable)

**Copy-on-protect for linked projects** (npm link / legacy symlink installs):

When `.claude/hooks` is a symlink (linked project), root-owning the 8 critical hook files at the symlink target would modify the framework source — breaking any edit, git operation, or agent session in the gentyr repo itself. To avoid this, `npx gentyr protect` in a linked project copies the critical files to a local `.claude/hooks-protected/` directory and root-owns the copies there instead.

- Source of record: `protection-state.json` field `hooksProtectedDir: ".claude/hooks-protected"` — set only for linked projects
- Ownership checks (commit-time and SessionStart) use `.claude/hooks-protected/` when the field is present
- A missing `hooks-protected/` directory when `hooksProtectedDir` is set is treated as tampering
- `npx gentyr unprotect` unprotects the files in `hooks-protected/` and removes the directory
- `.claude/hooks-protected/` is gitignored (added by `updateGitignore()` in `config-gen.js`)

### Tamper Detection

Because neither `.claude/` nor `.claude/hooks/` is root-owned as a directory, an agent could theoretically unlink and recreate files, or replace the hooks symlink. Two complementary layers close this gap:

**Symlink target verification** (`husky/pre-commit` + `gentyr-sync.js`):
- Verifies that `.claude/hooks` is a symlink whose resolved grandparent directory contains `version.json` (the GENTYR framework marker)
- A regular directory is only allowed in the framework repo itself (where `version.json` is in the working directory)
- If `.claude/hooks` is missing entirely, the commit is blocked
- This check runs before the file ownership check and is the primary anti-tampering mechanism for `.claude/`

**File ownership check** (`husky/pre-commit` + `gentyr-sync.js`):
- Uses `stat` to verify 8 critical hook files are still root-owned (uid 0)
- Checks `.claude/hooks-protected/` when it exists (linked projects with copy-on-protect); falls back to `.claude/hooks/` for direct installs
- Blocks the commit if any files are not root-owned
- `gentyr-sync.js` `tamperCheck()` runs the same checks at every interactive session start; when `protection-state.json` contains `hooksProtectedDir`, checks that directory instead of the symlink target; a missing `hooks-protected/` directory is treated as tampering; emits a `systemMessage` warning if any check fails
- `protection-state.json` records `criticalHooks` as an array and, for linked projects, `hooksProtectedDir: ".claude/hooks-protected"` so both checks read the same source of truth

**Trustworthiness**: The `husky/pre-commit` script performing these checks lives in the root-owned `.husky/` directory, making it tamper-resistant.

### Attack Vectors Prevented

- Agent cannot `rm` or `Edit` hook files to disable safety checks (root-owned)
- Agent cannot replace `.claude/hooks` symlink with a pointer to a different directory (symlink target verification)
- Agent cannot modify `.mcp.json` to add unvetted MCP servers (root-owned)
- Agent cannot weaken ESLint config or package.json scripts (root-owned)

### Protection State

Written to `.claude/protection-state.json`. Direct installs (framework repo):
```json
{
  "protected": true,
  "timestamp": "2026-02-20T12:00:00-08:00",
  "modified_by": "original_user",
  "criticalHooks": [
    "pre-commit-review.js",
    "block-no-verify.js",
    "gate-confirmation-enforcer.js",
    "signal-compliance-gate.js"
  ]
}
```

Linked project installs (npm link / legacy symlink) also include `hooksProtectedDir`:
```json
{
  "protected": true,
  "timestamp": "2026-02-20T12:00:00-08:00",
  "modified_by": "original_user",
  "criticalHooks": ["pre-commit-review.js", "..."],
  "hooksProtectedDir": ".claude/hooks-protected"
}
```

The `criticalHooks` array is the single source of truth for both the commit-time tamper check and the SessionStart tamper check. `hooksProtectedDir` redirects both checks to the local copy directory for linked projects.

## Layer 2: Bash Command Blocking

**File**: `.claude/hooks/block-no-verify.js`

Pre-tool-use hook that intercepts Bash commands and blocks dangerous patterns.

### Blocked Categories

**Hook bypass attempts**:
- `--no-verify` flag (and `-n` shorthand)
- `--no-gpg-sign` / `--gpg-sign`
- `git config core.hooksPath` (redirecting hook directory)
- `rm -rf .husky` or `rm -rf .claude/hooks` (deleting hook infrastructure)

**Lint weakening attempts**:
- `eslint --quiet` (suppresses warnings)
- `eslint --max-warnings N` where N > 0 (violates zero-tolerance policy)
- `eslint --no-error-on-unmatched-pattern` (silently skips linting)

## Layer 3: Deputy-CTO Commit Review

**File**: `.claude/hooks/pre-commit-review.js` (v4.0 — PR-Based Review)

Lint and security gate at commit time. Full code review by the deputy-CTO agent at PR time.

### Universal Fast Path (v4.0)

All commits — feature branches and promotion pipeline alike — pass through after lint and security checks only. No deputy-CTO review is spawned at commit time. This eliminates commit-time latency while preserving full review coverage at the PR gate.

**Commit-time checks** (unbypassable for all branches):
1. Lint config integrity — blocks forbidden override files
2. Git `core.hooksPath` tamper check — blocks if redirected
3. Strict ESLint (`--max-warnings 0`) on staged `.ts`/`.tsx` files
4. Protected branch guard — blocks direct commits to `main`, `staging`, `preview` unless `GENTYR_PROMOTION_PIPELINE=true`
5. Pending CTO items check — blocks commits to `main` if questions or triage items are pending (G020)

**Post-commit flow** (feature branches):
1. Agent pushes and creates a PR to `preview`
2. Agent creates an urgent DEPUTY-CTO task: `assigned_by: "pr-reviewer"`
3. Deputy-CTO reviews the PR diff via `gh pr diff`, then approves+merges or requests changes

**Deputy-CTO PR Review** (`Bash` access enabled for `gh` commands):
- `gh pr diff <number>` — review changes
- `gh pr review <number> --approve` or `--request-changes` — decision
- `gh pr merge <number> --merge --delete-branch` — merge and trigger worktree cleanup
- `gh pr edit <number> --add-label "deputy-cto-reviewed"` — always applied

### Pending Questions Block Commits

**G020 compliance**: Commits to `main` are blocked if ANY pending CTO items exist:
- Pending questions: `SELECT COUNT(*) FROM questions WHERE status = 'pending'`
- Pending triage reports: `SELECT COUNT(*) FROM reports WHERE triage_status = 'pending'`

Branch behavior:
- `main` or unknown → **hard block** (exit 1)
- `staging` or `develop` → warn only
- Feature branches (`feature/*`, `fix/*`, etc.) → no check; exits immediately after lint (fast path)

**G001**: If the database read fails, the hook assumes pending items exist and blocks the commit.

### Unbypassable Checks

These run before any bypass logic and cannot be circumvented:
1. **Lint config integrity** -- blocks if forbidden files exist (`.eslintignore`, `.eslintrc.*`, `.lintstagedrc.*`, `.huskyrc.*`)
2. **Git hooksPath validation** -- blocks if `core.hooksPath` is not `.husky` or empty
3. **Strict ESLint** -- runs `eslint --max-warnings 0` on staged `.ts`/`.tsx` files

## Layer 4: Secret Isolation

**File**: `packages/mcp-servers/src/secret-sync/server.ts`

Architectural guarantee that secret values never enter agent context. All credential resolution happens inside the MCP server process.

### Data Flow

```
Agent                    MCP Server (secret-sync)         1Password
  │                           │                              │
  ├─ sync_secrets ───────────►│                              │
  │  (key names only)         ├─ op read op://vault/item ───►│
  │                           │◄─ actual secret value ───────┤
  │                           ├─ POST to Render/Vercel API ──►
  │◄─ status: "synced" ──────┤  (value in request body)
  │  (NO values returned)     │
```

### Design Principles

- `opRead()` calls the 1Password CLI inside the server process; the return value stays in server memory
- `resolveLocalSecrets()` builds an env object for child process injection; values never serialized to agent
- `secret_sync_secrets` pushes to hosting providers and returns only sync status
- `secret_list_mappings` returns key names and `op://` references, never resolved values
- `secret_verify_secrets` returns existence booleans, never values
- `secret_dev_server_start` spawns a child process with resolved env vars and returns only PIDs/ports; infrastructure credentials (`OP_SERVICE_ACCOUNT_TOKEN`, `RENDER_API_KEY`, `VERCEL_TOKEN`, etc.) are excluded from the child env

### Why This Matters

Even if all other layers were compromised, an agent cannot extract secret values because:
1. The MCP protocol only returns what the server's tool handlers explicitly return
2. The server handlers are designed to return status information, never credential values
3. The 1Password CLI runs in the server's process space, not the agent's

## Layer 5: Agent Capability Restrictions

**File**: `.claude/agents/*.md`

Each agent definition can specify tool restrictions that limit what the agent can do.

### Enforcement Model

Agent tool restrictions operate at two levels:

Agent definitions use `allowedTools`/`disallowedTools` to specify tool restrictions. Examples:
- `secret-manager`: Cannot use Edit, Write, Bash, or Task — restricted to read-only operations and MCP tools
- `investigator`: Investigation-only agent that must not edit code or write files
- `code-reviewer`: Cannot use deputy-cto MCP tools (reserved for the deputy-cto agent)
- `feedback-agent`: Cannot use Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, or Task

## How Layers Interact

### Example: Agent Attempts to Bypass Commit Review

1. **Layer 3** (Commit Review): Agent commits code; pre-commit hook runs lint + security checks. No deputy-CTO spawn at commit time.
2. **Layer 1** (Root Ownership): Agent tries to modify a hook file to remove checks — the file is root-owned.
3. **Layer 2** (Bash Blocking): Agent tries to use `--no-verify` to bypass hooks — blocked by `block-no-verify.js`.

## Managing Protection

### Enable Protection
```bash
npx gentyr protect
```
Sets root ownership and sticky bits on critical files and directories.

### Disable Protection
```bash
npx gentyr unprotect
```
Removes root ownership. Use before making manual changes to protected files.

### Re-enable After Changes
```bash
npx gentyr protect
```
Re-applies root ownership without reinstalling the framework.

### Verify Protection
```bash
# Critical hook files should be root-owned in .claude/hooks/ (direct installs) or .claude/hooks-protected/ (npm link)
ls -la /path/to/project/.claude/hooks/gate-confirmation-enforcer.js
# Should show root:wheel ownership

# .husky/ directory should be root-owned with sticky bit
stat -f '%p' /path/to/project/.husky/
# Should show 41755 (sticky bit set)

# .claude/ directory should be user-owned (git needs write access)
stat -f '%Su' /path/to/project/.claude/
# Should show your username, NOT root

# .claude/hooks should be a symlink to a GENTYR framework directory
readlink /path/to/project/.claude/hooks
# Should resolve to a path containing version.json at grandparent level
```
