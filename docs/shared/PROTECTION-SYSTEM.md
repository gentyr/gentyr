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

**File**: `scripts/setup.sh --protect`

OS-level access control that prevents agents from modifying critical files, even with shell access.

### What Gets Protected

**Directories** (root-owned, sticky bit `1755`):
- `.husky/` -- git hook infrastructure
- `.claude/` -- framework configuration root
- Resolved hooks directory (symlink target)

The **sticky bit** (`chmod 1755`) prevents non-root users from deleting files within these directories, even if they have write permission on the parent.

**Files** (root-owned, `644`):
- Hook scripts: `pre-commit-review.js`, `bypass-approval-hook.js`, `block-no-verify.js`, `protected-action-gate.js`, `protected-action-approval-hook.js`, `credential-file-guard.js`, `secret-leak-detector.js`
- Configuration: `protected-actions.json`, `.claude/settings.json`, `.claude/protection-key`, `.mcp.json`, `eslint.config.js`, `package.json`
- Git hooks: `.husky/pre-commit` (`755`, executable)

### Attack Vectors Prevented

- Agent cannot `rm` or `Edit` hook files to disable safety checks
- Agent cannot modify `.mcp.json` to add unvetted MCP servers
- Agent cannot weaken ESLint config or package.json scripts
- Agent cannot tamper with the HMAC protection key used for approval verification

### Protection State

Written to `.claude/protection-state.json`:
```json
{
  "protected": true,
  "timestamp": "2026-02-20T12:00:00-08:00",
  "modified_by": "original_user"
}
```

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

**File**: `.claude/hooks/pre-commit-review.js`

Mandatory code review by the deputy-cto agent before any commit reaches the repository.

### APPROVE / REJECT Flow

**First commit attempt**:
1. Hook computes `diffHash` = SHA256 of `git diff --cached` (first 16 chars)
2. Checks for a valid approval token matching this `diffHash`
3. No token found → spawns deputy-cto agent with the full diff for review
4. Exits with code 1 (commit blocked)

**Deputy-CTO review**:
- `mcp__deputy-cto__approve_commit({ rationale })` → writes approval token
- `mcp__deputy-cto__reject_commit({ title, description })` → creates blocking question in deputy-cto.db

**Second commit attempt**:
1. Reads approval token, verifies `diffHash` matches current staged changes
2. Verifies token not expired (5-minute window)
3. Consumes token (deletes file), exits with code 0 (commit allowed)

### Diff-Hash-Bound Tokens

Approval tokens in `.claude/commit-approval-token.json` are bound to the exact diff hash. If the staged changes are modified between approval and commit, the hash won't match and the commit is blocked. This prevents an agent from getting approval for a safe diff, then staging additional changes before committing.

### Pending Questions Block Commits

**G020 compliance**: Commits to `main` are blocked if ANY pending CTO items exist:
- Pending questions: `SELECT COUNT(*) FROM questions WHERE status = 'pending'`
- Pending triage reports: `SELECT COUNT(*) FROM reports WHERE triage_status = 'pending'`

Branch behavior:
- `main` or unknown → **hard block** (exit 1)
- `staging` or `develop` → warn only
- Feature branches → no check

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

Blocks file access tools (Read, Write, Edit, Bash, Grep, Glob) from touching credential files.

**Protected basenames**: `.env`, `.env.local`, `.env.production`, `.env.staging`, `.env.development`, `.env.test`, `.credentials.json`

**Protected path suffixes**: `.claude/protection-key`, `.claude/api-key-rotation.json`, `.claude/bypass-approval-token.json`, `.claude/commit-approval-token.json`, `.claude/credential-provider.json`, `.claude/protected-action-approvals.json`, `.claude/vault-mappings.json`, `.claude/config/services.json`, `.mcp.json`

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

### Example 2: Agent Attempts to Self-Approve a Commit

1. **Layer 4** (Commit Review): Agent commits code; pre-commit hook requires deputy-cto approval
2. **Layer 2** (Protected Action Gate): Agent tries to call `mcp__deputy-cto__approve_commit` directly -- this is a protected action requiring CTO approval code
3. **Layer 2** (HMAC Verification): Agent tries to write a fake approval token to `.claude/commit-approval-token.json` -- the token requires a valid HMAC that only the protected-action-gate can produce
4. **Layer 6** (Credential File Guard): Agent tries to read `.claude/protection-key` to compute the HMAC -- the credential file guard blocks access
5. **Layer 1** (Root Ownership): Agent tries to modify the credential file guard to remove the block -- the hook file is root-owned

The approval chain is cryptographically bound: code → HMAC → protection key → root ownership. Breaking any link blocks the attack.

## Managing Protection

### Enable Protection
```bash
sudo scripts/setup.sh --path /path/to/project --protect
```
Sets root ownership and sticky bits on critical files and directories.

### Disable Protection
```bash
sudo scripts/setup.sh --path /path/to/project --unprotect-only
```
Removes root ownership. Use before making manual changes to protected files.

### Re-enable After Changes
```bash
sudo scripts/setup.sh --path /path/to/project --protect-only
```
Re-applies root ownership without reinstalling the framework.

### Verify Protection
```bash
ls -la /path/to/project/.claude/hooks/protected-action-gate.js
# Should show root:wheel ownership
stat -f '%p' /path/to/project/.claude/
# Should show 41755 (sticky bit set)
```
