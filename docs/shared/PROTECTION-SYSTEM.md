# GENTYR Protection System

Multi-layered defense-in-depth architecture protecting the development pipeline from accidental and adversarial misuse by AI agents.

## Overview

GENTYR enforces a **fail-closed** security model (invariant G001): when any check encounters an error, ambiguity, or missing configuration, it **blocks** the action rather than allowing it through. Seven protection layers operate independently so that compromising one layer does not defeat the others.

## Threat Model

### What GENTYR Protects Against

| Threat | Description |
|--------|-------------|
| Hook tampering | Agent deleting or modifying git hooks or Claude Code hooks to remove safety checks |
| Credential access | Agent reading secrets from files, environment variables, or CLI tools |
| Unauthorized infra changes | Agent modifying production infrastructure (Render, Vercel, Supabase, etc.) without CTO approval |
| Git hook bypass | Agent using `--no-verify`, `-n`, or `core.hooksPath` to skip pre-commit review |
| Approval forgery | Agent writing fake approval tokens to bypass deputy-CTO commit review or protected action gates |
| MCP aliasing | Agent connecting to an unknown MCP server that shadows a protected server's tool names |
| Lint weakening | Agent suppressing ESLint warnings or errors via flags or config file changes |
| Secret leakage | User accidentally pasting credentials into chat, or agent extracting secrets from tool output |

### Trust Boundaries

| Principal | Trust Level | Capabilities |
|-----------|-------------|-------------|
| CTO (human) | Full trust | Approves protected actions, reviews commits, manages secrets |
| deputy-cto agent | Elevated trust | Reviews commits, triages reports, but cannot self-approve |
| Other agents | Restricted | Cannot access secrets, modify infrastructure, or bypass hooks |
| MCP servers | Scoped trust | Only allowlisted servers may be called; protected servers require approval |

## Layer 1: Root Ownership

**Command**: `npx gentyr protect`

OS-level access control that prevents agents from modifying critical files, even with shell access.

### What Gets Protected

**Directories** (root-owned, sticky bit `1755`):
- `.husky/` -- git hook infrastructure

Note: `.claude/` and `.claude/hooks/` are intentionally **not** root-owned as directories. Git requires write access to these paths for atomic file operations (`git stash`, `git checkout`, `git merge`). Root-owning `.claude/` blocked runtime file creation (databases, state files) and broke tracked git operations. Symlink target verification (described below) replaces directory ownership as the anti-tampering mechanism.

**Files** (root-owned, `644`):
- Hook scripts: `pre-commit-review.js`, `bypass-approval-hook.js`, `block-no-verify.js`, `protected-action-gate.js`, `protected-action-approval-hook.js`, `credential-file-guard.js`, `secret-leak-detector.js`
- Configuration: `protected-actions.json`, `.claude/settings.json`, `.claude/protection-key`, `.mcp.json`, `eslint.config.js`, `package.json`
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
- Agent cannot tamper with the HMAC protection key used for approval verification (root-owned)

### Protection State

Written to `.claude/protection-state.json`. Direct installs (framework repo):
```json
{
  "protected": true,
  "timestamp": "2026-02-20T12:00:00-08:00",
  "modified_by": "original_user",
  "criticalHooks": [
    "pre-commit-review.js",
    "bypass-approval-hook.js",
    "block-no-verify.js",
    "protected-action-gate.js",
    "protected-action-approval-hook.js",
    "credential-file-guard.js",
    "secret-leak-detector.js",
    "protected-actions.json"
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

## Layer 2: Protected Action Gate

**File**: `.claude/hooks/protected-action-gate.js`

HMAC-signed approval codes that prevent agents from authorizing their own actions on protected MCP servers.

### Protected Servers

Configured in `.claude/hooks/protected-actions.json`. Each entry specifies:
- `tools`: `"*"` (all tools) or an array of specific tool names
- `phrase`: CTO approval phrase (e.g., `"APPROVE SYNC"`, `"APPROVE VAULT"`)
- `protection`: `"approval-only"` or `"deputy-cto-approval"`
- `credentialKeys`: environment variable names guarded by the credential file guard

Typical protected servers include Supabase (prod/staging), Render (prod/staging), Vercel, GitHub, Resend, 1Password, secret-sync, and deputy-cto.

### HMAC Mechanism

1. Agent calls a protected MCP tool
2. Gate generates a **6-character alphanumeric code** (charset excludes confusable characters: `0/O`, `1/I/L`)
3. Gate writes a pending approval with `pending_hmac` = HMAC-SHA256 over `code|server|tool|argsHash|expiry`
4. CTO types the approval phrase + code (e.g., `APPROVE SYNC A7KX3N`)
5. Approval hook verifies HMAC, writes `approved_hmac` adding `"approved"` to the binding
6. Gate verifies `approved_hmac`, consumes the approval (one-time use), allows the action

**Anti-forgery**: The `argsHash` (SHA256 of tool arguments) binds the approval to the exact call, preventing bait-and-switch where an agent requests approval for a safe call then substitutes dangerous arguments.

**Expiry**: Codes expire after 5 minutes.

### MCP Server Allowlist

To prevent **MCP aliasing attacks** (an unknown server registering tools with the same names as protected tools):

- **Known servers** listed in config → allowed
- **Framework servers** in `allowedUnprotectedServers` (e.g., `todo-db`, `agent-tracker`, `specs-browser`, `session-events`) → allowed
- **Unknown servers** → **BLOCKED** (exit 1)

### Fail-Closed Behaviors (G001)

| Condition | Result |
|-----------|--------|
| Config file missing | Block ALL MCP actions |
| Config file corrupted | Block ALL MCP actions |
| Protection key missing | Block protected actions |
| HMAC verification fails | Delete forged approval, continue checking |
| File lock timeout | Block action |

## Layer 3: Bash Command Blocking

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

**Credential CLI access**:
- All 1Password CLI (`op`) subcommands: `run`, `read`, `item`, `inject`, `signin`, `signout`, `whoami`, `vault`, `document`, `connect`, `account`, `group`, `user`, `service-account`, `events-api`, `plugin`
- `op --*` global flags

### Bypass Mechanism

For legitimate emergencies:
1. Agent requests bypass via `mcp__deputy-cto__request_bypass({ reason, reporting_agent, blocked_by })`
2. CTO types `APPROVE BYPASS <CODE>` in chat
3. HMAC-signed token written to `.claude/bypass-approval-token.json`
4. Token verified, consumed (one-time use), expires after 5 minutes

## Layer 4: Deputy-CTO Commit Review

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

## Layer 5: Secret Isolation

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

## Layer 6: Credential Guards

Two complementary hooks that block credential access at different points.

### Credential File Guard

**File**: `.claude/hooks/credential-file-guard.js`

Blocks file access tools (Read, Write, Edit, Bash, Grep, Glob) from touching credential files. Uses tiered protection with HMAC-signed CTO approval for configuration files.

**Tiered Protection**:

1. **Always-blocked files** (no escape hatch):
   - `.env`, `.env.local`, `.env.production`, `.env.staging`, `.env.development`, `.env.test`, `.credentials.json`
   - `.claude/protection-key`
   - `.claude/protected-action-approvals.json`
   - `.claude/bypass-approval-token.json`
   - `.claude/commit-approval-token.json`

2. **CTO-approvable files** (HMAC-signed approval):
   - `.claude/config/services.json` (phrase: `APPROVE CONFIG`)
   - `.mcp.json` (phrase: `APPROVE MCP`)
   - `.claude/api-key-rotation.json` (phrase: `APPROVE ROTATION`)
   - `.claude/credential-provider.json` (phrase: `APPROVE CREDENTIAL`)
   - `.claude/vault-mappings.json` (phrase: `APPROVE VAULT MAP`)

**Approval flow**: When an agent attempts to access a CTO-approvable file, the hook creates an HMAC-signed request via `approval-utils.js`. The deputy-CTO generates a one-time code. The CTO types the phrase + code (e.g., `APPROVE CONFIG A7KX3N`). The hook validates HMAC + expiry and grants one-time access.

**Protected patterns**: `/\.env(\.[a-z]+)?$/i`

**Bash analysis**: Tokenizes commands respecting quotes, scans all arguments (not just known file-position args), checks redirection targets, performs raw substring scan for blocked path suffixes, and blocks environment variable references (`$KEY`, `${KEY}`, `printenv KEY`) for keys listed in `protected-actions.json`.

### Secret Leak Detector

**File**: `.claude/hooks/secret-leak-detector.js`

Scans user messages for accidentally pasted credentials.

**Detected patterns**: 1Password service account tokens (`ops_`), GitHub PATs (`ghp_`, `github_pat_`), Render API keys (`rnd_`), Resend keys (`re_`), Supabase/JWT tokens (`eyJ...`), AWS access keys (`AKIA`), private keys (`-----BEGIN`), Stripe keys (`sk_live_`/`sk_test_`), OpenAI keys (`sk-...T3BlbkFJ`), Anthropic keys (`sk-ant-`), Slack tokens (`xox[bporas]-`), and context-dependent patterns for Vercel, Elastic, and Cloudflare tokens.

**Behavior**: Emits a warning message with provider-specific rotation instructions. Does not block the message (the credential is already in context at detection time; the goal is to prompt immediate rotation).

## Layer 7: Agent Capability Restrictions

**File**: `.claude/agents/*.md`

Each agent definition can specify tool restrictions that limit what the agent can do.

### Enforcement Model

Agent tool restrictions operate at two levels:

1. **Agent-level** (`.claude/agents/*.md`): Instructions and `allowedTools`/`disallowedTools` fields tell the agent what it should and should not do. Examples:
   - `secret-manager`: Cannot use Edit, Write, Bash, or Task -- restricted to read-only operations and MCP tools
   - `investigator`: Investigation-only agent that must not edit code or write files
   - `code-reviewer`: Cannot use deputy-cto MCP tools (reserved for the deputy-cto agent)
   - `feedback-agent`: Cannot use Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, or Task

2. **Hook-level** (Layers 2-6): Even if an agent attempts to exceed its restrictions, the pre-tool-use hooks enforce hard boundaries. An agent that tries to read `.env` files hits the credential file guard regardless of its declared capabilities.

The combination means agent restrictions are **defense-in-depth**: the agent definition is the first line of defense, and the hook system is the backstop.

## How Layers Interact

### Example 1: Agent Attempts to Read a Production Secret

1. **Layer 7** (Agent Restrictions): If the agent is `secret-manager`, it cannot use `Read` or `Bash` tools at all
2. **Layer 6** (Credential File Guard): If a general agent tries `Read` on `.env.production`, the hook blocks it
3. **Layer 1** (Root Ownership): If an agent tries to circumvent hooks by modifying `credential-file-guard.js`, the file is root-owned and cannot be changed
4. **Layer 3** (Bash Blocking): If an agent tries `op read op://vault/item/field`, the `op` command is blocked
5. **Layer 5** (Secret Isolation): Even through the secret-sync MCP server, values are resolved in-process and never returned to the agent

All five layers must be defeated to extract a secret value. Compromising any single layer is insufficient.

### Example 2: Agent Attempts to Bypass Commit Review

The commit-time approval token system for commits has been removed in v4.0 (PR-Based Review). Code review now happens at PR time via the deputy-CTO agent. The relevant attack surface is now bypassing the PR-level gate:

1. **Layer 4** (Commit Review): Agent commits code; pre-commit hook runs lint + security checks. No deputy-CTO spawn at commit time.
2. **Layer 2** (Protected Action Gate): Agent tries to call `mcp__deputy-cto__approve_commit` directly to forge a PR approval — this is a protected action requiring CTO approval code
3. **Layer 2** (HMAC Verification): Agent tries to write a fake protected-action approval — the token requires a valid HMAC that only the protected-action-gate can produce
4. **Layer 6** (Credential File Guard): Agent tries to read `.claude/protection-key` to compute the HMAC — the credential file guard blocks access
5. **Layer 1** (Root Ownership): Agent tries to modify the credential file guard to remove the block — the hook file is root-owned

The approval chain is cryptographically bound: code → HMAC → protection key → root ownership. Breaking any link blocks the attack.

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
# For direct installs — critical hook files should be root-owned in .claude/hooks/
ls -la /path/to/project/.claude/hooks/protected-action-gate.js
# Should show root:wheel ownership

# For linked projects (npm link) — root-owned copies are in hooks-protected/
ls -la /path/to/project/.claude/hooks-protected/protected-action-gate.js
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
