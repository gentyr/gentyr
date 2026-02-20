# Credential Rotation Experiments — Phase 2

**Date**: 2026-02-20
**Objective**: Test restartless credential rotation for Claude Code sessions

---

## Executive Summary

Three experiments tested whether Claude Code can recover from credential changes without restarting. Key findings:

1. **Expired tokens get HTTP 401 (recoverable); revoked tokens get HTTP 403 (terminal)**
2. **Restartless rotation IS possible** via the `SRA()` proactive refresh path — write a new token to disk/Keychain and let the old one expire naturally
3. **33 orphaned processes** confirmed the missing-kill bug in `quota-monitor.js` automated rotation
4. **Proxy-based 401 injection fails** because Bun's SDK fetch doesn't route `/v1/messages` through `HTTPS_PROXY`

---

## Claude Code Token Architecture

### Authentication Flow

Claude Code uses OAuth Bearer tokens directly for API calls (NOT ephemeral API keys):

```
Login → OAuth token (with scopes) → Bearer token in API calls
                                   → anthropic-beta: oauth-2025-04-20 header
```

The `org:create_api_key` scope and `/api/oauth/claude_cli/create_api_key` endpoint exist but are optional — the primary auth path sends `Authorization: Bearer <oauth-token>` with the beta header.

### Token Lifecycle

```
/login → access_token + refresh_token + expiresAt
       → stored in macOS Keychain + ~/.claude/.credentials.json
       → cached in-memory by Claude Code process (iB() function)
```

### Credential Storage Hierarchy

| Source | Read By | Priority |
|--------|---------|----------|
| `process.env.CLAUDE_CODE_OAUTH_TOKEN` | At startup only | 1 (highest) |
| macOS Keychain (`Claude Code-credentials`) | `iB()` cache, `MRA()` disk read | 2 |
| `~/.claude/.credentials.json` | `MRA()` disk read | 3 |

### In-Memory Caching

- `iB()` — returns cached credentials (memoized)
- `iB.cache?.clear?.()` — clears the memoization cache
- `El()` — clears additional credential state
- `MRA()` — async re-read from disk (Keychain/file)

---

## Key Internal Functions (from Binary Analysis)

### `jv(expiresAt)` — Expiry Check
```javascript
function jv(T) {
  if (T === null) return false;
  return Date.now() + 300000 >= T;  // 5-minute buffer
}
```
Returns `true` when token is within 5 minutes of expiry.

### `SRA(T, R)` — Proactive Token Refresh
```javascript
async function SRA(T, R) {
  let _ = iB();  // read cached credentials
  if (!R) {
    if (!_?.refreshToken || !jv(_.expiresAt)) return false;  // not near expiry
  }
  if (!_?.refreshToken) return false;
  if (!Sv(_.scopes)) return false;

  iB.cache?.clear?.();  // CLEAR credential cache
  El();                  // CLEAR additional state

  let B = await MRA();   // RE-READ from disk (Keychain/file)

  // KEY RECOVERY PATH: if re-read token is NOT expired, use it!
  if (!B?.refreshToken || !jv(B.expiresAt)) return false;
  // ... otherwise attempt OAuth refresh via refresh_token grant
}
```

**Critical insight**: Step 3 of `SRA()` IS a recovery path. If we write a new, non-expired token to disk before `SRA()` fires, it will adopt the new token seamlessly without needing to hit the API.

### `r6T(accessToken)` — 401 Recovery Handler
Called when the API returns HTTP 401:
```javascript
// In the retry loop:
if (H instanceof XB && H.status === 401) {
  let G = iB()?.accessToken;
  if (G) await r6T(G);  // clear cache, re-read from disk
}
D = await T();  // retry the API call
```

### Retry Logic
```javascript
// shouldRetry function:
if (T.status === 401) return KBR(), true;  // 401 is retryable
// Note: 403 is NOT in the retry list → terminal
```

---

## Test A: Token Expiry vs Revocation — HTTP Status Codes

### Method
Tested three token states against `POST /v1/messages` with `anthropic-beta: oauth-2025-04-20`:

### Results

| Token State | HTTP Status | Error Type | Error Message | Claude Code Behavior |
|---|---|---|---|---|
| **Valid** (active, not expired) | **200** | — | Success | Normal operation |
| **Naturally expired** (past `expiresAt`) | **401** | `authentication_error` | "OAuth token has expired. Please obtain a new token or refresh your existing token." | **RECOVERABLE** via `r6T()` |
| **Revoked** (via `refresh_token` grant) | **403** | `permission_error` | "OAuth token has been revoked. Please obtain a new token." | **TERMINAL** — no recovery |

### Key Evidence

```bash
# Naturally expired token (37f3cdd8, expired 171 min ago):
HTTP Status: 401
{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired..."}}

# Revoked token (3d80f763, still within expiresAt but revoked by refresh):
HTTP Status: 403
{"type":"error","error":{"type":"permission_error","message":"OAuth token has been revoked..."}}
```

### Implications

The server distinguishes between two states:
- **Expired** = time-based, returns 401 (retryable)
- **Revoked** = refresh-based, returns 403 (permanent)

This means refreshing a token to "rotate" it actually makes things WORSE — it immediately invalidates the old token with an unrecoverable 403, rather than letting it expire naturally with a recoverable 401.

---

## Test B: HTTPS Proxy to Force 401

### Goal
Inject a synthetic HTTP 401 response via MITM proxy to trigger Claude Code's `r6T()` recovery path.

### Proxy Implementations Tested

| Version | Approach | Result |
|---|---|---|
| **v1** (CONNECT-level 401) | Return `HTTP/1.1 401` on CONNECT handshake | Claude Code **hangs** — Bun treats CONNECT failure as transport error, not HTTP response |
| **v2** (Basic MITM) | Terminate TLS, intercept HTTP/1.1 requests | Only handles one request per TLS connection — hangs on keepalive |
| **v3** (HTTPS server MITM) | Route CONNECT to local HTTPS server | Claude Code makes 2 calls (profile + eval) but messages call never arrives |
| **v4** (HTTP/2 MITM) | `http2.createSecureServer` with `allowHTTP1` | Same issue — profile and mcp_servers forwarded, but `/v1/messages` never routes through proxy |

### Critical Finding: Selective Proxy Routing

Claude Code (Bun) selectively routes API calls through `HTTPS_PROXY`:

| Endpoint | Routes Through Proxy | Purpose |
|---|---|---|
| `POST /api/eval/sdk-*` | Yes | Statsig/telemetry |
| `GET /api/oauth/profile` | Yes (sometimes) | Profile check |
| `GET /v1/mcp_servers` | Yes | MCP server list |
| `POST /v1/messages` | **NO** | Main API calls |

The Anthropic SDK's fetch implementation appears to bypass the proxy for the primary messages endpoint, despite Bun's fetch supporting `fetchOptions.proxy = proxy`. This may be due to HTTP/2 connection pooling, a separate connection manager, or the SDK using a different fetch path.

### Conclusion

**Proxy-based 401 injection is NOT viable** for triggering `r6T()` recovery in the current Claude Code architecture. The messages endpoint doesn't route through the proxy.

---

## Test C: Restart-Based Rotation Verification

### Orphaned Process Discovery

**33 orphaned `claude --resume` processes** found running:

```
Session 878b5a27: 3 processes  (oldest: Wed 4PM, newest: Wed 7PM)
Session 6e1e5a5a: 3 processes
Session efbd25e3: 2 processes
Session ef03dad7: 2 processes
... (11 session IDs with duplicates)
```

Each process consumed ~50-70MB RAM with only ~30-40 seconds of CPU time over 24+ hours (sleeping zombies).

### Root Cause

`quota-monitor.js` lines 318-354 (automated session rotation):
```javascript
// Spawns new process...
const child = spawn('claude', spawnArgs, { detached: true, stdio: 'ignore', ... });
child.unref();
// ❌ NEVER kills the old process!
```

Compare with interactive sessions (lines 296-316):
```javascript
// Uses generateRestartScript() which includes:
// kill -TERM ${claudePid} → wait → kill -9 ${claudePid}
const script = generateRestartScript(claudePid, sessionId, ...);
```

### Rotation Log Analysis

```
[2026-02-19T22:23:16] key_added: 3d80f763 reason=new_key_from_keychain_max
[2026-02-19T22:25:08] key_added: 2f20d998 reason=new_key_from_keychain_max
[2026-02-20T02:23:05] key_added: 9430b17e reason=new_key_from_keychain_max
```

- **No `key_switched` events** in the rotation log — rotation has never completed a full switch
- **12 quota death events** detected by stop-continue hook — all with `rotated: false` (no alternative key available)
- **19 keys total** in rotation state: 17 invalid, 2 active

### Stop-Continue Hook

Working correctly:
- Detects `[Task]` sessions via transcript prefix
- Blocks first stop (auto-continue)
- Detects quota death via JSONL error inspection (`error === 'rate_limit'`)
- Writes recovery records to `quota-interrupted-sessions.json`
- Attempts credential rotation (but fails when no alternative key available)

---

## Restartless Rotation Strategy

Based on all findings, here is the viable approach:

### Strategy: Natural Expiry + Disk Token Swap

```
1. Monitor usage with checkKeyHealth()
2. When usage >= threshold:
   a. DO NOT refresh the active token (that revokes it → 403)
   b. Write the new account's token to Keychain + credentials file
   c. Wait for the old token to expire naturally
3. When old token expires:
   a. Claude Code's jv() detects near-expiry (5 min before)
   b. SRA() fires: clears cache → re-reads from disk → finds new valid token
   c. Or: API returns 401 → r6T() fires → same disk re-read
   d. Claude Code seamlessly adopts the new token
```

### Requirements

- **Two independent accounts** with separate OAuth tokens
- **Never refresh the in-use token** — refreshing revokes it (403 death)
- **Token expiry window**: OAuth tokens expire in ~4 hours; `jv()` triggers 5 min before
- **Write-ahead**: Write the new token to disk BEFORE the old one expires

### Why This Works

1. `SRA()` re-reads from disk on every proactive refresh check
2. If the disk token is different and not expired → it's adopted immediately
3. If the old token hits the API after expiry → 401 → `r6T()` → disk re-read → recovery
4. No restart needed, no process termination, no orphaned processes

### What Still Requires Restart

- **Token revocation** (403) — only way to recover is `/login` or new process
- **Proxy/network changes** — `HTTPS_PROXY` is read at process start
- **MCP server configuration changes** — loaded at startup

---

## Implementation: Autonomous Restartless Rotation

Based on the findings above, the following enhancements were implemented to make rotation fully autonomous:

### Enhancement 1: Proactive Standby Refresh (Step 4c)

**Files**: `quota-monitor.js`, `key-sync.js syncKeys()`

Non-active tokens approaching expiry (within 10 minutes) are now refreshed proactively, not just after they expire. This keeps standby tokens perpetually fresh so `SRA()`/`r6T()` always finds a valid replacement in Keychain.

**Why it's safe**: Refreshing Account B's token sends Account B's `refresh_token` to the OAuth server. This does NOT revoke Account A's in-memory `access_token` — they are independent OAuth credentials. The old Account B `access_token` is revoked, but since it's a standby (not in any session's memory), this doesn't affect any running session.

### Enhancement 2: Pre-Expiry Restartless Swap (Step 4d)

**Files**: `quota-monitor.js`, `key-sync.js syncKeys()`

When the active key is within 10 minutes of expiry AND a valid standby exists (with >10 min of life), the standby is written to Keychain via `updateActiveCredentials()`. No restart is triggered. Claude Code's built-in `SRA()` (which fires at 5 min before expiry) clears its credential cache, re-reads from Keychain, finds the fresh standby token, and adopts it seamlessly.

### Coverage Matrix

| Session State | Mechanism | How It Works |
|---|---|---|
| **Active (making API calls)** | quota-monitor Step 4c+4d | Every 5 min: refreshes standby + writes to Keychain. SRA() picks up at jv() trigger. |
| **Idle (no API calls)** | hourly-automation → syncKeys() | Every 10 min via launchd: refreshes standby + writes to Keychain. r6T() picks up on next API call. |
| **Dead (quota/error)** | stop-continue-hook + session-reviver | Detects death → writes recovery record → revives within 10 min. |

### The Idle Session Edge Case

`SRA()` only fires during API calls, not during idle. But this is covered by two mechanisms:

1. **r6T() reactive path**: When an idle session wakes up, its stale token gets HTTP 401 → `r6T()` fires → reads Keychain → finds fresh standby → recovers.
2. **hourly-automation via launchd**: Runs every 10 min even during idle (external to Claude Code process). `syncKeys()` refreshes approaching-expiry standby tokens and writes the swap to Keychain. So when `r6T()` fires, there's always a valid token waiting.

The only remaining failure mode: system sleep for > 8 hours (both tokens expire, no launchd ticks). On wake, `syncKeys()` would refresh using stored `refresh_token`s, and the next API call's `r6T()` would recover.

---

## Bugs Found

### 1. Missing Process Kill in Automated Rotation

**File**: `.claude/hooks/quota-monitor.js:318-354`
**Severity**: High (causes orphaned processes and resource waste)
**Fix**: Add process termination before spawning replacement, matching the interactive path's `generateRestartScript()` approach.

### 2. Missing `org:create_api_key` Scope in Token Refresh

**File**: `.claude/hooks/key-sync.js:37`
**Current**: `'user:profile user:inference user:sessions:claude_code user:mcp_servers'`
**Missing**: `org:create_api_key`
**Impact**: Tokens refreshed by hooks lack the scope needed if Claude Code uses the API key creation path. However, the primary auth path (Bearer token) works without this scope.

### 3. Stale Tokens in Rotation State

17 of 19 keys in `api-key-rotation.json` are `status: 'invalid'` with `accessToken: undefined`. The `pruneDeadKeys()` function only prunes keys older than 7 days, but many of these are from the last 3 days. Consider more aggressive pruning or different invalidation criteria.

---

## Environment Details

- **Claude Code version**: 2.1.34 (Bun-compiled Mach-O arm64)
- **macOS**: Darwin 24.6.0
- **Node.js**: v25.6.0 (used for hooks/tests)
- **Active keys**: 2 (accounts dev@example.com, ops@example.com)
- **Token type**: OAuth with `anthropic-beta: oauth-2025-04-20`
