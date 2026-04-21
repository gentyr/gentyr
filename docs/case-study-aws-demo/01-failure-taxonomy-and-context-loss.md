# Part 1: Failure Pattern Taxonomy & Context Loss

## 1.1 Failure Categories

Based on analysis of 268 commits, 597 failed queue items, 10 cancelled persistent tasks, and 8 CTO amendments, failures cluster into **10 distinct root cause categories**. Several were discovered multiple times by different agents across different sessions.

### Category A: Content Security Policy (CSP) Blocking
- **First observed**: Mar 25 (PR #1532)
- **Correctly diagnosed**: Mar 25
- **Fix shipped**: Mar 26 (PR #1534 — domCommand system)
- **Time to resolution**: ~24 hours
- **Re-occurrences**: Mar 30 (PR #1581 — CSP blocks new Function() in ChromeActions), Apr 15 (PR #1812 — CSP blocks executeJs on signin page)
- **Repeat investigations**: At least 3. Agents repeatedly tried executeJs on CSP-protected pages despite the domCommand system being designed precisely to avoid this.
- **GENTYR gap**: No mechanism to record "this page blocks eval()" as a persistent fact that survives across sessions.

### Category B: React Controlled Input State Mismatch
- **First observed**: Mar 29 (PR #1553 — native setValue setter)
- **Correctly diagnosed**: Mar 29
- **First fix shipped**: Mar 29 (PR #1555)
- **Complete fix shipped**: Apr 2 (PR #1611 — _valueTracker reset in setValue handler)
- **Time to complete resolution**: 4 days
- **Re-discovered**: Apr 9 (PR #1662 — reactFillBySelector helper), Apr 15 (PR #1844 — selectRadioByLabel needs React hack), Apr 20 (PR #1911 — verification code silent rejection), Apr 20 (PR #1914 — invoke React onChange in MAIN world)
- **Repeat investigations**: **At least 6.** This was the single most re-investigated root cause. Despite being understood on day 4, agents continued re-discovering it through day 26.
- **GENTYR gap**: The solution (native setter + tracker reset + onChange call) was proven on day 4 but not encapsulated as a reusable tool until day 27 (GENTYR PRs #358-#360). For 23 days, every agent that needed to fill a React input had to either find the existing helper code or re-derive the solution.

### Category C: Chrome MV3 Service Worker Lifecycle
- **First observed**: Apr 5 (PR #1632 — port-based keepalive)
- **Correctly diagnosed**: Apr 5
- **Fixes shipped**: Apr 5 (PR #1632), Apr 10 (PR #1674 — keepalive port injection), Apr 12 (PR #1719 — server-side keepalive pings), Apr 15 (PR #1824 — SW wake-up logic)
- **Time to resolution**: 10 days (intermittent, required multiple fixes)
- **Re-investigated**: At least 4 times across different persistent tasks
- **GENTYR gap**: No framework-level understanding that MV3 service workers have a ~30s lifetime without keepalive. Each agent rediscovered this constraint independently.

### Category D: 1Password Credential Resolution
- **First observed**: Apr 5 (PR #1633 — about:blank guard)
- **Correctly diagnosed**: Apr 5
- **Fixes shipped**: Apr 5-6 (3 PRs fixing credential propagation to Playwright subprocesses)
- **Time to resolution**: 2 days
- **Re-investigated**: Apr 18 (Amendment #1 — services.json deleted, credentials inaccessible)
- **GENTYR gap**: credential-file-guard + secrets key restriction created a situation where agents couldn't recreate services.json even when they knew what it should contain. The CTO had to manually provide the op:// paths.

### Category E: IAM OAuth / PKCE Redirect Loop
- **First observed**: Apr 8 (PR #1646 — IAM detection)
- **Correctly diagnosed**: ~Apr 14 (after many failed approaches)
- **First fix**: Apr 8 (PR #1646)
- **Correct fix**: Apr 14 (PR #1801 — navigate with iam_user=false)
- **Complete fix**: Apr 17 (PR #1869 — isAwsPkceStuck regex fix)
- **Time to resolution**: 9 days
- **Failed approaches before correct diagnosis**: At least 12 PRs (#1714, #1717, #1758, #1761, #1764, #1767, #1780, #1781, #1785, #1786, #1787, #1798, #1801, #1802, #1804)
- **Repeat investigations**: This root cause had the HIGHEST ratio of failed fixes to successful fixes. Agents tried clearing cookies, rewriting URLs, clicking different buttons, adding redirect recovery, adding PKCE URL rewrite — 12+ distinct strategies before landing on the correct one.
- **GENTYR gap**: No mechanism for agents to record "I tried X and it didn't work because Y" in a durable, searchable way. Each new attempt was made without systematic access to prior attempt results. The CTO had to observe the pattern externally.

### Category F: Cross-Origin Fetch CORS in MV3 Service Worker
- **First observed**: Apr 10 (PR #1677 — route through SW to bypass CORS)
- **Misdiagnosed initially**: Apr 10 (PR #1684 — credentials:'include' added, actually made it worse)
- **Correctly diagnosed**: Apr 17 (PR #1877 — credentials:'omit' fix)
- **Time to resolution**: 7 days
- **Key detail**: PR #1684 (Apr 10) added `credentials:'include'` to cross-origin fetch, which was the OPPOSITE of the correct fix. The plan-driven forensic investigation on Apr 17-18 correctly identified credentials:'omit' as the solution.
- **GENTYR gap**: No A/B testing mechanism for agents to compare before/after behavior of a code change. The incorrect fix in PR #1684 wasn't detected because there was no systematic way to measure whether it helped or hurt.

### Category G: Null Guard Crashes
- **First observed**: Apr 11 (PR #1687)
- **Peak**: Apr 12-13 (PRs #1706, #1713, #1715, #1716, #1720, #1721)
- **Cluster**: 12 PRs in 2 days adding `.includes()` null guards
- **Root cause**: Bridge operations returning undefined instead of expected strings
- **GENTYR gap**: These were symptoms of upstream failures (bridge disconnection, stale tabs) being surfaced as TypeError crashes. A defensive coding pattern guide or automated null-safety linting could have caught these in bulk rather than one-at-a-time.

### Category H: Stale Compiled Artifacts (dist-proxy-chrome)
- **First observed**: Unknown (implicit from the beginning)
- **Explicitly identified**: Apr 21 (Amendment #6)
- **Impact**: "Wasted attempts #28-#50" per CTO amendment
- **Duration of impact**: At least 22 demo attempts (~3+ days of wall clock time)
- **GENTYR gap**: **This is the single highest-impact gap.** The framework had no mechanism to detect that a compiled artifact (.js file) did not contain expected code. Agents rebuilt dist-proxy-chrome but Chrome continued using its cached copy. No agent in 22 attempts thought to verify that the running code matched the source code. A simple post-build verification step (grep for expected function names in the loaded extension) would have caught this immediately.

### Category I: Tab ID Replacement During Navigation
- **First observed**: Apr 20 (PR #1907 — wrap executeJs in withTabRetry)
- **Diagnosed**: Apr 21 (PR #1920 — track chrome tab ID replacement)
- **Fix**: Apr 21 (PR #1920)
- **GENTYR gap**: Chrome's tab replacement behavior during cross-process navigations is a platform-specific detail. No mechanism to teach agents about browser-specific behaviors.

### Category J: Wrong Test File Execution
- **First observed**: Apr 20 (Amendment #4)
- **Impact**: Unknown number of wasted attempts
- **Root cause**: Task prompt or agent confusion about which .demo.ts file to run
- **GENTYR gap**: The demo_scenario system has the correct file path, but agents were running a different file. No guardrail to verify the correct file is being executed.

## 1.2 Failure Repetition Analysis

| Root Cause | Times Discovered | Times Re-discovered | Days to Complete Fix | Wasted Attempts |
|-----------|-----------------|--------------------|--------------------|-----------------|
| A: CSP Blocking | Day 1 | 2 | 1 | Low |
| B: React _valueTracker | Day 4 | 6+ | 26 (to tool) | Very High |
| C: MV3 SW Lifecycle | Day 11 | 4 | 10 | Medium |
| D: Credential Resolution | Day 11 | 1 | 2 | Low |
| E: PKCE Redirect | Day 14 | 12+ | 9 | Very High |
| F: CORS in SW | Day 16 | 1 | 7 | High |
| G: Null Guards | Day 17 | 0 (but 12 PRs) | 2 | Medium |
| H: Stale Artifacts | Day 27 | 0 (but 22 attempts) | Still open | Extreme |
| I: Tab ID Replace | Day 26 | 0 | 2 | Low |
| J: Wrong Test File | Day 26 | Unknown | 1 | Unknown |

**Key finding**: Categories B and E had the highest repetition rates. Category H had the highest total wasted effort despite being identified only once — because it silently corrupted every demo attempt for 3+ days.

## 1.3 Context Loss Analysis

### Monitor Revival Patterns

The primary task (d37c968f) had its monitor revived approximately every 15-30 minutes based on session summary timestamps. Each revival produced a session summary. Analysis of 40 recent summaries reveals:

**Context recovery quality**: Session summaries consistently described the high-level situation ("MFA auth failure", "10-step pass needed") but lost specific technical details:
- Which specific PRs had been merged in the current attempt
- Which hypotheses had been tested and eliminated
- What diagnostic data showed in the last attempt

**Orientation time**: Most revival summaries show the monitor immediately checking sub-task status and recent amendments — suggesting the `last_summary` field and amendment system work well for high-level orientation. However, the monitor then spawns an investigator to "assess" the situation, which takes 5-15 minutes before productive work begins.

**The compaction boundary problem**: Long-running monitors hit context compaction, losing diagnostic details from earlier in the session. The monitor then asks child agents to re-investigate things it already knew 30 minutes ago.

### Amendment Delivery Effectiveness

All 8 amendments were acknowledged within 0.5-33 minutes of creation:
| Amendment # | Created | Acknowledged | Lag |
|------------|---------|-------------|-----|
| 1 (services.json workaround) | 23:00 | 23:01 | 38s |
| 2 (no 24h cooldown) | 08:12 | 08:12 | 33s |
| 3 (screenshot audit) | 08:13 | 08:14 | 30s |
| 4 (attempt #28 post-mortem) | 13:27 | 14:02 | 35m |
| 5 (new GENTYR tools) | 15:30 | 15:32 | 2m |
| 6 (stale dist mandate) | 05:23 | 05:24 | 73s |
| 7 (chrome-actions fixed) | 09:49 | 09:51 | 73s |
| 8 (extension reload mandate) | 11:57 | 11:58 | 33s |

**Amendment #4 had a 35-minute lag**, during which the agent was likely mid-execution on a demo attempt. This is acceptable — the agent shouldn't interrupt a running test to check for amendments.

**However**: Acknowledging an amendment does NOT mean acting on it. Amendment #6 (mandatory dist rebuild) was acknowledged at 05:24 but the session summaries show the same stale-artifact issue persisting through attempt #50, reaching Amendment #8 (extension reload mandate) at 11:57 — 6.5 hours later. The monitor acknowledged the instruction but either didn't propagate it to child agents effectively, or child agents ignored it.

### Key Finding: Knowledge Decay Across Persistent Task Boundaries

When persistent tasks were cancelled and replaced with new ones, diagnostic knowledge was lost:
- **7d2cb0f9** (cancelled after 126h) → **5439cfd4** (clean restart): The restart explicitly discarded all knowledge from the 5-day investigation.
- **6f23901c** (cancelled after 58h) → **125f4240**: Same domain, but the new task started from scratch on the login chain.
- **91f1a6c5** (cancelled after 87h) → Plan-driven tasks: The plan-driven approach (Apr 16-18) was much more effective, but only because the CTO directed the investigation strategy.

**Pattern**: Cancelling and recreating persistent tasks acts as a "reset" that discards not just stale state but also diagnostic findings. GENTYR has no mechanism to preserve "lessons learned" from a cancelled task into its successor.

## 1.4 Findings Summary

### The Three Most Costly Gaps

1. **No "tried-and-failed" registry** (Categories B, E): Agents re-investigated the same root causes because there was no searchable record of "agent X tried approach Y on date Z and it failed because W." The CTO amendments partially filled this role, but only when the CTO happened to observe the pattern.

2. **No build artifact verification** (Category H): 22+ demo attempts were wasted because compiled code didn't match source. A post-build verification step (or runtime assertion) would have caught this in attempt #1.

3. **No solution encapsulation pipeline** (Category B): A proven solution (React native setter hack) existed for 23 days as a helper function in one file before being promoted to a framework-level tool. During that time, agents in at least 6 different sessions re-derived the same solution or copied the same code.

### The Most Effective Pattern

The **plan-driven forensic investigation** (Apr 17-18, Plans 2-5) was dramatically more effective than the iterative trial-and-error approach:
- Plan 2 resolved the SW CORS root cause in 2 hours (vs 7 days of unfocused attempts)
- The 5-phase structure (read → instrument → observe → diagnose → verify) prevented premature "fix" attempts
- Each phase had clear deliverables, preventing scope creep

This suggests GENTYR should offer structured investigation templates for complex multi-session debugging campaigns.
