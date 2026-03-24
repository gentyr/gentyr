# CLAUDE_CONFIG_DIR Multi-Account Strategy

## Status: Research Complete — Not Implemented

This document captures research and architectural analysis for potentially replacing GENTYR's rotation proxy with Claude Code's native `CLAUDE_CONFIG_DIR` mechanism for multi-account management.

---

## What is CLAUDE_CONFIG_DIR?

`CLAUDE_CONFIG_DIR` is an officially supported environment variable that redirects Claude Code's config/data storage from `~/.claude/` to a custom directory. Each directory acts as a fully isolated profile with separate credentials, sessions, settings, and history.

Anthropic engineer `levpopov` provided this as the supported mechanism for multi-account usage in [GitHub issue #261](https://github.com/anthropics/claude-code/issues/261).

### What Gets Isolated Per Profile

| Isolated | Not Isolated |
|----------|-------------|
| `.credentials.json` (OAuth tokens) | Project-level `.claude/` dirs |
| `settings.json` (user settings) | IDE extension state (VS Code/JetBrains always read `~/.claude/`) |
| `projects/` (session JSONL history) | |
| `.claude.json` (account identity) | |
| `debug/`, `statsig/`, `history.jsonl` | |

### macOS Keychain

Each `CLAUDE_CONFIG_DIR` gets a namespaced Keychain entry (fixed in v2.1.50+):

```
Claude Code-credentials              # default (~/.claude/)
Claude Code-credentials-85be987d     # sha256("/path/to/profile")[:8]
```

Some users report needing to re-login after reboot due to Keychain ACL issues (tracked in [issue #19456](https://github.com/anthropics/claude-code/issues/19456)).

---

## Anthropic Policy on Multiple Accounts

- **Multiple accounts are allowed.** Anthropic employee Thariq stated (Feb 2026): "It's not against ToS to have multiple MAX accounts."
- **What IS banned:** Using multiple accounts to circumvent guardrails/rate limits, evade bans, share accounts, or use third-party harnesses with subscription OAuth.
- **CLAUDE_CONFIG_DIR is the blessed approach** for running multiple accounts in Claude Code.
- **Risk:** "Coordinated activity across multiple accounts to circumvent guardrails" is the AUP language. Automated rotation to dodge rate limits could be interpreted as this.

Sources:
- [Anthropic Consumer ToS](https://www.anthropic.com/legal/consumer-terms)
- [Anthropic AUP](https://www.anthropic.com/legal/aup)
- [PiunikaWeb — Multiple MAX accounts allowed](https://piunikaweb.com/2026/02/19/anthropic-claude-max-ban-agent-sdk-clarification/)

---

## Current GENTYR Approach (Rotation Proxy)

- Single `~/.claude/` config dir for all sessions
- MITM proxy on `localhost:18080` intercepts `api.anthropic.com` traffic
- Swaps Authorization headers between accounts stored in `api-key-rotation.json`
- All sessions (interactive + spawned) route through the same proxy
- On 429, proxy auto-rotates to next account — session never knows
- Components: `rotation-proxy.js`, cert generation, launchd service, proxy health checks, `buildSpawnEnv()` injects `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`

---

## Proposed Alternative: CLAUDE_CONFIG_DIR Approach

### How It Would Work

1. Pre-authenticate N accounts, each in its own config dir (`~/.claude-account-1/`, `~/.claude-account-2/`, etc.)
2. Account pool manager tracks config dirs, their account status, and usage levels
3. At spawn time, `buildSpawnEnv()` sets `CLAUDE_CONFIG_DIR` to the least-loaded account
4. Each spawned agent runs natively against its assigned account — no proxy
5. If an agent hits limits, session reaper cleans it up, task re-queues on a different account

### What Would Work Well

- **Agent spawning is a natural fit.** Session queue already assigns work — adding account assignment is straightforward
- **Eliminates the entire proxy stack** — no MITM, no certs, no launchd service, no proxy health checks, no tunnel management
- **Zero policy risk** — officially blessed by Anthropic engineering
- **Simpler architecture** — significant complexity reduction
- **Per-account rate limits operate independently** — each session has its own usage pool

### Downsides

#### 1. No mid-session rotation (the killer problem)

The proxy transparently swaps auth on 429 — the session never knows. With `CLAUDE_CONFIG_DIR`, a session is locked to one account for its lifetime.

- **Interactive (CTO) session:** Hit rate limit mid-conversation → session stalls. Must restart in new terminal with different account, losing conversation context.
- **Spawned agents:** Less painful (retryable tasks), but long-running agents that hit limits mid-work must be killed and re-queued.

#### 2. Session resume breaks across accounts

`claude --resume <session-id>` reads from the config dir's `projects/` folder. Can't resume a session with a different `CLAUDE_CONFIG_DIR` — the session file isn't there. Revival can only retry on the same (possibly still rate-limited) account.

#### 3. Session history fragmentation

GENTYR tooling scans `~/.claude/projects/` for user prompt indexing, CTO session search, dead agent detection, and session audit. With N config dirs, all scanners must search N locations.

#### 4. No mid-session failover

If an account's refresh token is revoked mid-session, the proxy currently rotates to another key. With `CLAUDE_CONFIG_DIR`, that session is dead.

#### 5. Account pool management

New module needed to: track config dirs and account status, health-check all accounts before each spawn, balance load (usage API calls per account), handle all-accounts-exhausted state.

---

## Architecture Comparison

| Dimension | Rotation Proxy | CLAUDE_CONFIG_DIR |
|-----------|---------------|-------------------|
| Mid-session rotation | Transparent, automatic | Not possible |
| Session resume | Works (proxy handles auth) | Only on same account |
| Policy risk | Medium-High (MITM + coordinated rotation) | None (blessed approach) |
| Infrastructure | Proxy process + certs + launchd service | Config dirs on disk |
| Complexity | High (proxy, certs, tunnel mgmt) | Low (env var per session) |
| Interactive UX | Seamless rotation | Must restart on limit hit |
| Agent spawning | All share one pipe | Each gets own account |
| Session history | Single location | Fragmented across N dirs |
| Failover | Automatic | Kill + re-queue |

---

## Verdict

**For spawned agents:** Works well. Agents are short-lived, retryable, assigned at spawn time. If one hits limits, reaper cleans up and task re-queues on a different account.

**For interactive sessions:** UX downgrade. Transparent mid-session rotation is the core value of the proxy for the CTO session.

**Hybrid (both systems):** Worst of both worlds — doubles maintenance complexity.

**Key question:** Does Max 20x provide enough headroom that mid-session rotation rarely fires? If so, the simpler `CLAUDE_CONFIG_DIR` approach may be sufficient, accepting occasional manual restarts.

---

## If Implementing

Changes required:

- New account pool manager module (track config dirs, usage levels, assignment)
- Modify `buildSpawnEnv()` to set `CLAUDE_CONFIG_DIR` instead of proxy vars
- Modify session history scanners to check N config dirs
- Modify session revival to handle per-account config dirs
- Remove or deprecate: `rotation-proxy.js`, proxy cert generation, proxy launchd service, proxy health checks
- Initial setup: `/login` once per config dir to authenticate each account

---

## No Higher Tier Available

As of March 2026, the Max 20x plan ($200/mo) is the highest individual tier. No "50x" or unlimited plan has been announced. Options beyond Max 20x: overflow billing at API rates, Team/Enterprise plans, or direct API with pay-as-you-go.

**Current promotion (March 13-27, 2026):** Usage limits doubled during off-peak hours. Extra usage doesn't count toward weekly caps.
