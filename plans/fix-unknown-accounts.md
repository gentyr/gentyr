# Fix: "unknown" Accounts in Quota Status Line

## Problem

Two accounts show as "unknown" in the CTO notification status line because:
1. `syncKeys()` adds new keys with `account_uuid: null` / `account_email: null`
2. Profile resolution only happens in `api-key-watcher.js` on interactive `SessionStart` (skipped for spawned sessions)
3. Keys added by hourly automation or token refresh never get profiles resolved
4. `deduplicateKeys()` skips null-UUID keys entirely, so orphaned duplicates persist

## Fix (3 files, minimal changes)

### 1. `key-sync.js` — Move `fetchAccountProfile()` here and call it in `syncKeys()`

**a)** Add `fetchAccountProfile()` function (moved from `api-key-watcher.js`), exported.

**b)** In `syncKeys()`, after the token refresh loop (line ~460) and before deduplication (line ~473), add a loop that iterates over all keys where `account_uuid === null` and `status` is `active` or `exhausted`. For each, call `fetchAccountProfile()` with the key's `accessToken`. On success, set `account_uuid` and `account_email`. This ensures every `syncKeys()` call (SessionStart, hourly automation, credential-sync) resolves profiles.

**c)** In `deduplicateKeys()` — no structural change needed. Once profiles are resolved by the loop above, the existing UUID-based dedup handles merging correctly. The `if (!uuid) continue` at line 748 is correct defensive behavior — null-UUID keys should be rare after Fix 1b and aren't safe to merge without identity confirmation.

### 2. `api-key-watcher.js` — Import from `key-sync.js` instead of local function

Replace the local `fetchAccountProfile()` definition (lines 87-112) with an import from `key-sync.js`. The health-check loop (lines 200-207) already calls it correctly — just change the reference.

### 3. `cto-notification-hook.js` — Cross-match null-UUID keys in `getAggregateQuota()`

In `getAggregateQuota()` (line ~404-416), after building the initial `accountMap`, add a second pass: for entries with fingerprint-based dedup keys (those starting with `fp:`), check if any UUID-bearing entry in the map has matching `seven_day` AND `seven_day_sonnet` values. If found, merge the fingerprint entry into the UUID entry (take the higher `fiveHour` value). Then delete the fingerprint entry.

This is a defensive fallback — after Fix 1b, null-UUID keys should be rare, but this prevents "unknown" from appearing even if the profile API is temporarily down.

### 4. `slash-command-prefetch.js` — Same defensive cross-match

At line ~576, the dedup uses `k.account_uuid || id`. Add the same fingerprint cross-match as Fix 3: after the initial loop, check null-UUID entries against UUID-bearing entries with matching usage values. Merge matches.

## Files Changed

| File | Change |
|---|---|
| `.claude/hooks/key-sync.js` | Add exported `fetchAccountProfile()`, call it in `syncKeys()` for null-UUID keys |
| `.claude/hooks/api-key-watcher.js` | Import `fetchAccountProfile` from `key-sync.js`, remove local copy |
| `.claude/hooks/cto-notification-hook.js` | Add fingerprint cross-match in `getAggregateQuota()` |
| `.claude/hooks/slash-command-prefetch.js` | Add fingerprint cross-match in dedup logic |

## Tests

Update `.claude/hooks/__tests__/key-sync-deduplication.test.js`:
- Add test: `syncKeys()` code structure includes `fetchAccountProfile` call for null-UUID keys
- Add test: `fetchAccountProfile` is exported from `key-sync.js`

No new test files needed.
