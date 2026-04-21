# Part 2: Root Cause Convergence Speed & Inter-Agent Communication

## 2.1 Root Cause Convergence Timeline

For each distinct technical root cause, this section tracks: first symptom, first correct diagnosis, first correct fix, and the intervening "red herring" investigations.

### Root Cause 1: CSP Blocking eval() on AWS Pages
```
Day 1 (Mar 25) — First symptom: executeInProxyChrome fails on signin.aws.amazon.com
Day 1 (Mar 25) — Correct diagnosis: AWS CSP blocks new Function() and eval()
Day 2 (Mar 26) — Correct fix: domCommand system (PR #1534)
Red herrings: 0
Convergence time: 24 hours
```
**Assessment**: Fast convergence. The error message was clear ("Refused to evaluate a string as JavaScript") and pointed directly to the root cause.

### Root Cause 2: React Controlled Input Bypass
```
Day 4 (Mar 29) — First symptom: fillInput sets DOM value but form submits empty
Day 4 (Mar 29) — Correct diagnosis: React _valueTracker not updated
Day 4 (Mar 29) — First partial fix: native setValue setter (PR #1553)
Day 8 (Apr 2) — Complete fix: _valueTracker reset in setValue handler (PR #1611)
Day 15 (Apr 9) — Helper function created: reactFillBySelector (PR #1662)
Day 21 (Apr 15) — Re-discovered for radio buttons (PR #1844)
Day 26 (Apr 20) — Re-discovered for verification code (PR #1911)
Day 27 (Apr 21) — Encapsulated as GENTYR tool (PRs #358-360)
Red herrings: ~6 sessions that tried alternative approaches before using the native setter
Convergence time: 4 days to correct fix, 23 days to tool encapsulation
```
**Assessment**: The diagnosis was fast, but knowledge propagation was slow. The fix existed in one file but wasn't discoverable by agents working in other files. Six separate sessions re-derived the same solution because:
1. The helper was in `e2e/demo/helpers/react-input-fill.ts` — agents working on `aws-login-via-bridge.ts` didn't know to look there
2. No framework-level tool existed until day 27
3. Agents don't search for "how did a previous session solve this?" — they search for "how do I fill a React input?"

### Root Cause 3: MV3 Service Worker 30-Second Death
```
Day 11 (Apr 5) — First symptom: bridge connection drops mid-flow
Day 11 (Apr 5) — Correct diagnosis: Chrome kills MV3 SW after ~30s inactivity
Day 11 (Apr 5) — First fix: port-based keepalive (PR #1632)
Day 16 (Apr 10) — Recurrence: content script keepalive port injection (PR #1674)
Day 18 (Apr 12) — Recurrence: server-side keepalive pings (PR #1719)
Day 21 (Apr 15) — Recurrence: SW wake-up logic for reconnect (PR #1824)
Red herrings: Multiple sessions investigated "bridge server crash" before realizing the SW was being killed
Convergence time: 1 day to first fix, 10 days to comprehensive fix
```
**Assessment**: The root cause was diagnosed quickly, but the fix required multiple complementary layers (keepalive from server, from content script, from alarm handler, plus reconnection logic). Each layer was discovered when a previous layer proved insufficient in a specific scenario.

### Root Cause 4: IAM OAuth / PKCE Redirect
```
Day 14 (Apr 8) — First symptom: after root user login, page redirects to IAM OAuth
Day 14 (Apr 8) — First attempted fix: IAM detection + redirect (PR #1646)
Day 17 (Apr 11) — Cookie clearing attempt (PR #1690)
Day 18 (Apr 12) — OAuth redirect recovery in polling loops (PRs #1712-#1717)
Day 19 (Apr 13) — Let OAuth chain complete (PR #1742)
Day 19 (Apr 13) — Clear OIDC cookies (PR #1758)
Day 20 (Apr 14) — Click root user link (PR #1767)
Day 20 (Apr 14) — Navigate with iam_user=false (PR #1801)
Day 20 (Apr 14) — Avoid PKCE by adding iam_user=false to URL (PR #1801)
Day 22 (Apr 16) — resolving_id URL param bypass (PR #1844)
Day 23 (Apr 17) — isAwsPkceStuck regex fix (PR #1869)
Red herrings: 12+ PRs with incorrect fixes
Convergence time: 9 days
```
**Assessment**: This was the worst convergence. The root cause was actually MULTIPLE interacting issues:
1. AWS added IAM OAuth to root user flow (environmental change, not a bug)
2. The PKCE detection regex had a false positive (code_challenge_method matched code_challenge)
3. Cookie state from previous sessions triggered different OAuth flows

Agents couldn't converge because they were treating symptoms of different issues as the same bug. **GENTYR gap**: No mechanism for agents to decompose a compound problem into independent sub-issues and track each separately.

### Root Cause 5: Cross-Origin CORS in MV3 Service Worker
```
Day 16 (Apr 10) — First symptom: CDN assets fail to load through proxy
Day 16 (Apr 10) — Misdiagnosis: added credentials:'include' (PR #1684, WRONG)
Day 23 (Apr 17) — Correct diagnosis via forensic plan: credentials:'include' triggers CORS
Day 24 (Apr 18) — Correct fix: credentials:'omit' (PR #1877)
Red herrings: 1 (the opposite fix was applied first)
Convergence time: 7 days (but only 2 hours of focused investigation)
```
**Assessment**: The initial misdiagnosis (adding credentials:'include') was the exact opposite of the correct fix. This went undetected for 7 days because no agent had a mechanism to measure whether PR #1684 helped or hurt. The plan-driven investigation on Apr 17-18 resolved this in 2 hours because it followed a structured read → instrument → diagnose methodology.

### Root Cause 6: Stale Chrome Extension Cache
```
Day 27? (ongoing since at least Apr 14) — First symptom: runtime errors don't match source
Day 27 (Apr 21) — Correct diagnosis by CTO: Chrome caches extension code
Attempts wasted before diagnosis: 22+ (per CTO amendment)
Convergence time: Unknown start — at least 7 days of silent impact
```
**Assessment**: This root cause was invisible to agents because there was no symptom that said "you're running stale code." The error messages corresponded to bugs that had been fixed in source — but agents assumed the fixes hadn't been merged, not that Chrome was ignoring the merged code. **This is a class of failure where the diagnostic assumption ("source matches runtime") is wrong, and no tool challenged that assumption.**

## 2.2 Convergence Patterns

### Fast Convergence (< 2 days)
- CSP blocking: Clear error message pointed to root cause
- Credential resolution: Clear error message (missing env var)
- Tab ID replacement: Error message mentioned "No tab with id"

**Pattern**: Problems with clear, specific error messages converge fast.

### Slow Convergence (> 5 days)
- PKCE redirect: Multiple interacting causes, no clear error
- CORS in SW: Wrong fix applied first, no regression detection
- Stale artifacts: No error — the wrong code silently executed

**Pattern**: Problems that are silent, compound, or produce misleading diagnostics converge slowly.

### The "Opposite Fix" Anti-Pattern
PR #1684 applied `credentials:'include'` when the correct fix was `credentials:'omit'`. PR #1609 navigated to `/console/home` (later reverted to `/iam/home` in PR #1612). This pattern occurred at least 3 times — agents applied a change, observed no improvement, and moved on to other hypotheses without reverting the wrong change. The wrong changes accumulated, making the system state harder to reason about.

**GENTYR gap**: No mechanism for agents to track "what I changed in this attempt vs the baseline." A/B testing or change-revert discipline could prevent wrong fixes from accumulating.

## 2.3 Inter-Agent Communication Effectiveness

### Amendment Delivery (CTO → Monitor → Child)
Amendments were the primary knowledge transfer mechanism. They were delivered reliably (38s median acknowledgment time). However:

**Propagation depth**: The monitor acknowledged amendments but propagation to child agents was inconsistent. Amendment #6 (mandatory rebuild) was acknowledged at 05:24 but child agents continued running without rebuilding for 6+ hours. This suggests the monitor acknowledged the amendment but didn't inject it into child agent prompts effectively.

**Volume overload**: Task 7d2cb0f9 accumulated 32 amendments over 5.3 days. By the time it was cancelled, the amendment history was a wall of text that new agents struggled to parse.

### Session Activity Broadcaster
The session activity broadcaster generated summaries, but analysis of the summaries shows they were high-level status reports ("agent is running demo", "investigating MFA failure") rather than technical findings. They didn't carry diagnostic data like "PR #1684 made CORS worse" or "the running extension code doesn't match dist-proxy-chrome."

### Monitor → Child Communication
The persistent task monitor spawned child agents with task descriptions that included context. However:

1. **Context truncation**: Task prompts have size limits. The monitor's accumulated knowledge from 88 sub-tasks couldn't fit into a single task prompt.
2. **No shared diagnostic state**: Child agents couldn't access other children's findings except through the monitor's summary. If Child A discovered that `credentials:'include'` was wrong, Child B (spawned later) might not learn this unless the monitor explicitly included it in Child B's prompt.
3. **Stale prompt context**: Child agents received a snapshot of knowledge at spawn time. If new information arrived (via amendment or another child's findings), the already-running child agent couldn't receive it.

### CTO as Primary Knowledge Router
Analysis of the 8 amendments reveals the CTO served as the primary knowledge router:
- Amendment #1: CTO provided credential resolution workaround that agents couldn't derive (credential-file-guard blocked them)
- Amendment #4: CTO synthesized findings from multiple sources into 5 hypotheses
- Amendment #5: CTO notified agents of new GENTYR tools (agents couldn't discover these on their own since they were in a different repo)
- Amendment #6: CTO identified stale artifact pattern from external observation
- Amendment #8: CTO identified Chrome caching from understanding platform behavior

**Finding**: 5 of 8 amendments contained information that the framework should have provided automatically:
- #1: The credential paths should have been in a discoverable location
- #4: The hypothesis list could have been auto-generated from failure logs
- #5: New GENTYR tools should have been announced to running agents automatically
- #6 & #8: Post-build verification should be a framework capability

Only amendments #2 (don't wait for cooldown) and #3 (screenshot audit directive) contained CTO judgment that couldn't be automated.

## 2.4 Findings Summary

### Convergence Speed Correlates
1. **Error message clarity** → fastest convergence
2. **Single root cause** → fast convergence
3. **Compound root causes** → slow convergence
4. **Silent failures** → slowest convergence (or no convergence without CTO)

### Communication Gaps
1. **No "tried and failed" registry**: Agents re-investigated eliminated hypotheses
2. **No cross-repo tool discovery**: New GENTYR tools required CTO notification
3. **Monitor → child propagation failure**: Amendments acknowledged but not propagated
4. **No shared diagnostic state**: Children couldn't see other children's findings
5. **CTO as bottleneck**: 62.5% of amendments contained automatable information
