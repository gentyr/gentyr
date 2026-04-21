# Case Study Data Appendix: AWS Demo Automation Campaign

## Campaign Overview

| Metric | Value |
|--------|-------|
| Date range | 2026-03-25 to 2026-04-21 (28 days) |
| Total AWS-related commits | 268 |
| Persistent tasks created | 44 (33 completed, 10 cancelled, 1 active) |
| Formal plans created | 6 (38 plan tasks total) |
| Session queue items (AWS-related) | 4,143+ |
| Failed queue items | 597+ |
| CTO amendments (primary task) | 8 |
| Session summaries in DB | 1,816 |
| Audit log entries | 956 |
| Input tokens consumed (all sessions) | ~45 billion |
| PR range | #1517 to #1930 (413 PRs in range, 268 AWS-related) |

## Persistent Task Timeline

### Phase 1: Initial Attempts (Mar 25-27)
| ID | Title | Status | Duration | Amendments |
|----|-------|--------|----------|------------|
| d714dbff | Run AWS one-click demo E2E and fix until passing | cancelled | <1 day | 0 |
| b47ce0f5 | Fix proxy-network-request to use content-script fetch | cancelled | <1 day | 0 |
| 27bc3b4c | Route proxy-network-request through content-script fetch | completed | 1.5h | 0 |
| 6b3bf259 | Get AWS one-click demo passing E2E with video recording | cancelled | <1 day | 1 |

### Phase 2: Long-Running Monitor (Mar 27 - Apr 1)
| ID | Title | Status | Duration | Amendments |
|----|-------|--------|----------|------------|
| 7d2cb0f9 | Get AWS one-click demo passing E2E with video recording | cancelled | 126h 26m (5.3 days) | 32 |

**Key stats**: 10/102 sub-tasks done. This single task accumulated 32 amendments, making it the most-amended task in the campaign. It was eventually cancelled.

### Phase 3: Reset and Focused Attacks (Apr 1 - Apr 5)
| ID | Title | Status | Duration |
|----|-------|--------|----------|
| 5439cfd4 | Get ext-aws-one-click demo passing E2E (clean restart) | completed | 3h 49m |
| b33e3760 | AWS one-click demo E2E — Gatekeeper cleared, run demo | completed | 49h 45m |
| 5c2961bd | Fix 1Password credential resolution in worktrees | completed | 44m |
| 1d560673 | Fix MV3 service worker instability | completed | 1h 58m |
| 33b0a57a | Fix worktree lifecycle gap | completed | 41m |
| 1db600d9 | Fix GENTYR run_demo op:// credential resolution | completed | 3h 11m |

### Phase 4: MFA and Credential Issues (Apr 5 - Apr 11)
| ID | Title | Status | Duration |
|----|-------|--------|----------|
| 827da5c8 | AWS demo end-to-end: fix MFA skip on about:blank | completed | 26h 53m |
| 4b4af59e | Investigate: Why OP_SERVICE_ACCOUNT_TOKEN is missing | completed | 6h 36m |
| 295c5284 | Diagnose and fix: run_demo env vars not reaching Playwright | completed | 22m |

### Phase 5: Deep Investigation (Apr 9 - Apr 12)
| ID | Title | Status | Duration |
|----|-------|--------|----------|
| 6f23901c | AWS Real Chrome Login: Verify isolated to E2E | cancelled | 58h 26m |
| 125f4240 | AWS Login Chain: Real Chrome + Bridged Playwright | completed | 7h 28m |
| 1bc96ee4 | AWS Demo Scenarios: All 5 demos working | cancelled | 14h 1m |
| 85a0b582 | AWS test/demo observability: fix diagnostic gaps | completed | 21m |
| 8b56f555 | AWS Login Chain + Demo Scenarios | cancelled | 3h 17m |

### Phase 6: Focused E2E (Apr 12 - Apr 16)
| ID | Title | Status | Duration |
|----|-------|--------|----------|
| 27ddd9ef | AWS One-Click Demo: run and perfect | completed | 14h 45m |
| 91f1a6c5 | AWS Demo Suite: verify all AWS tests pass | cancelled | 87h 48m (3.7 days) |

### Phase 7: Plan-Driven (Apr 16 - Apr 18)
| ID | Title | Status | Duration |
|----|-------|--------|----------|
| c975f335 | Plan Manager: Fix PKCE False Positive | completed | 1h 17m |
| 65e27a94 | Plan Manager: Split-Browser Proxy Investigation | completed | 1h 44m |
| 8ddac118 | Plan Manager: AWS Proxy Fix Verification | completed | 2h 3m |
| 6ffe0ad7 | Plan Manager: AWS Proxy Fix Verification v2 | completed | 1h 23m |
| 28bcc3a2 | Plan Manager: AWS Demo Deep Telemetry | completed | 1h 11m |

### Phase 8: Primary Task (Apr 18 - Present)
| ID | Title | Status | Duration |
|----|-------|--------|----------|
| d37c968f | AWS Demo End-to-End: Fix MFA auth failure | active | 61h 56m+ |

**Key stats**: 12/88 sub-tasks done, 8 CTO amendments, 5,116 monitor cycles.

## CTO Amendments on Primary Task (d37c968f)

1. **Correction (Apr 18 23:00)**: Workaround for missing services.json — use 1Password MCP directly instead of services.json for credential resolution. Full op:// paths provided.

2. **Correction (Apr 20 08:12)**: "Do NOT wait for a 24h cooldown" — MFA codes don't have 24h rate limits. Run the demo NOW and retry every 30 minutes. Maximum 5 attempts per monitor session.

3. **Addendum (Apr 20 08:13)**: Screenshot & telemetry audit — take MORE screenshots at every checkpoint. Audit existing coverage. Report findings for GENTYR improvement.

4. **Correction (Apr 20 13:27)**: Post-mortem of attempt #28 — 5 specific hypotheses for why AWS silently rejects verification code. Also flagged that task-runner was running the WRONG test file.

5. **Correction (Apr 20 15:30)**: New GENTYR chrome-bridge MCP tools available (react_fill_input, click_and_wait, page_diagnostic, inspect_input). Use these instead of manual hacks.

6. **Correction (Apr 21 05:23)**: Stale dist-proxy-chrome (3rd time wasting attempts). Mandatory rebuild before every demo. "This has wasted attempts #28-#37 and now #43-#44."

7. **Correction (Apr 21 09:49)**: GENTYR chrome-actions package fixed — use reactFillInput() etc. directly from TypeScript bindings.

8. **Correction (Apr 21 11:57)**: Mandatory extension reload before every demo. "Chrome caches extensions. Rebuilding dist-proxy-chrome does NOT make Chrome load the new code. This has wasted attempts #28-#50."

## Session Queue Statistics

### Daily Volume (AWS-related sessions spawned)
| Date | Persistent | Standard | Revival | Failed |
|------|-----------|----------|---------|--------|
| Mar 25 | 7 | 134 | - | 48 |
| Mar 29 | 121 | 69 | - | 28 |
| Mar 30 | 149 | 41 | - | 23 |
| Apr 1 | 48 | 44 | - | 22 |
| Apr 5 | 58 | 15 | - | 3 |
| Apr 9 | 37 | 34 | 83 | 5 |
| Apr 14 | 98 | 74 | 18 | 3 |
| Apr 15 | 182 | 65 | 34 | 8 |
| Apr 16 | 174 | 64 | 24 | 0 |
| Apr 19 | 118 | 20 | 6 | 1 |
| Apr 20 | 77 | 41 | 6 | 1 |
| Apr 21 | 27 | 26 | 4 | 0 |

### Failure Breakdown
| Error Type | Count |
|-----------|-------|
| hard_kill_timeout | 384 |
| spawn returned no PID | 179 |
| stale_heartbeat_killed | 13 |
| concurrent drain race | 11 |
| spawn_zombie | 1 |

### Duration by Lane/Priority
| Status | Lane | Priority | Count | Avg Duration (s) |
|--------|------|----------|-------|-------------------|
| completed | persistent | critical | 1518 | 896 (15 min) |
| completed | standard | urgent | 597 | 1344 (22 min) |
| completed | standard | normal | 572 | 1602 (27 min) |
| failed | standard | normal | 415 | 2464 (41 min) |
| completed | revival | urgent | 195 | 348 (6 min) |
| completed | standard | cto | 182 | 1260 (21 min) |
| failed | standard | urgent | 98 | 3505 (58 min) |
| failed | standard | cto | 54 | 1934 (32 min) |
| failed | persistent | critical | 15 | 1212 (20 min) |

**Key observation**: 384 sessions were hard-killed after timeout. Failed sessions ran 41-58 minutes on average before being killed — indicating they were stuck, not crashing.

## Plan Execution Timeline

### Plan 1: PKCE False Positive Fix (Apr 16-17)
- 6 tasks, 5 completed, 1 skipped
- Duration: ~22 hours
- **Successful** — well-scoped, systematic

### Plan 2: Split-Browser Proxy Root Cause (Apr 17-18)
- 8 tasks, 5 completed, 3 skipped
- Duration: ~2 hours
- **Successful** — 5-phase forensic investigation identified credentials:'omit' fix

### Plan 3: AWS Proxy Fix Verification (Apr 18)
- 5 tasks, 2 completed, 3 skipped
- Duration: ~2 hours
- **Partially successful** — verified fix but didn't run remaining demos

### Plan 4: AWS Proxy Fix Verification v2 (Apr 18)
- 4 tasks, 2 completed, 2 skipped
- Duration: ~1.5 hours
- **Partially successful** — scoped to get a Step 4 verdict

### Plan 5: AWS Demo Deep Telemetry (Apr 18)
- 3 tasks, all completed
- Duration: ~1 hour
- **Successful** — produced definitive diagnostic report

### Plan 6: Bridge Infrastructure Auto-Start (Apr 21)
- 12 tasks, 3 completed, 4 skipped, 5 ready/in_progress
- Duration: ~1 hour (plan manager)
- **Completed prematurely** — investigation done, implementation tasks left as ready

## Git Commit Categories (268 AWS-related commits)

Rough categorization from commit messages:
- **fix(aws-demo/e2e)**: ~120 commits — direct demo/test fixes
- **fix(extension)**: ~40 commits — Chrome extension bugs
- **fix(browser-proxy/proxy)**: ~35 commits — proxy chain fixes
- **fix(bridge)**: ~15 commits — bridge server fixes
- **fix(demo)**: ~30 commits — demo infrastructure
- **docs**: ~20 commits — documentation and post-mortems
- **feat/test**: ~8 commits — new capabilities and tests

## Notable Root Causes (from commit messages)

1. **CSP blocking** (Mar 25-30): new Function() blocked by AWS CSP → domCommand system
2. **React _valueTracker** (Mar 29 - Apr 20): Native setter hack required for controlled inputs
3. **MV3 service worker death** (Apr 5 - Apr 15): Chrome kills SW, bridge drops
4. **1Password credential resolution** (Apr 5-6): Missing OP tokens in subprocesses
5. **IAM OAuth redirect** (Apr 8 - Apr 15): PKCE flow redirects disrupting login
6. **PKCE false positive** (Apr 13 - Apr 17): isAwsPkceStuck regex matching code_challenge_method
7. **Cross-origin SW fetch CORS** (Apr 17-18): credentials:'include' triggers CORS in MV3 SW
8. **Stale compiled artifacts** (Apr 21): dist-proxy-chrome not reloaded by Chrome after rebuild
9. **Null guard crashes** (Apr 11-13): .includes() on undefined across multiple files
10. **Tab ID replacement** (Apr 20-21): Cross-process navigations change Chrome tab IDs
