# Part 3: Task Decomposition & Tooling Gaps

## 3.1 Task Scoping Analysis

### Scope Spectrum of Persistent Tasks

The 44 persistent tasks range from extremely broad to surgically narrow:

**Overly Broad Tasks** (created problems):
| Task | Scope | Sub-tasks | Outcome |
|------|-------|-----------|---------|
| 7d2cb0f9 "Get AWS demo passing E2E with video" | Entire demo pipeline | 10/102 done | Cancelled after 126h |
| 91f1a6c5 "verify all AWS tests pass E2E then record all demos" | All AWS tests + all demos | 4/140 done | Cancelled after 87h |
| d37c968f "Fix MFA auth failure and achieve verified 10-step pass" | Full login flow | 12/88 done | Still active after 61h |

**Pattern**: Tasks with scope "make everything work" accumulated unbounded sub-tasks (102, 140, 88). These became management overhead — the monitor spent more time tracking sub-task state than making progress.

**Well-Scoped Tasks** (executed efficiently):
| Task | Scope | Sub-tasks | Outcome |
|------|-------|-----------|---------|
| 5c2961bd "Fix 1Password credential resolution in worktrees" | Single infrastructure issue | 2/2 | Completed in 44m |
| 1d560673 "Fix MV3 service worker instability" | Single component | 5/5 | Completed in 1h 58m |
| 85a0b582 "AWS test/demo observability: fix diagnostic gaps" | Diagnostics only | 4/4 | Completed in 21m |

**Pattern**: Tasks targeting a single component or single root cause completed in hours, not days.

### Plan-Driven vs Unplanned Execution

**Before plans (Mar 25 - Apr 16)**: 28 persistent tasks, iterative trial-and-error
- 7 cancelled, 14 completed
- Average effective task: ~15 hours
- Approach: "try it, if it fails, spawn another sub-task"

**After plans introduced (Apr 16 - Apr 21)**: 6 plans, phased execution
- 5 completed plans, 1 partially completed
- Average plan completion: ~3 hours
- Approach: "read → instrument → observe → diagnose → verify"

**The plan-driven approach was 5x faster for investigation work.** Plan 2 (Split-Browser Proxy Root Cause) resolved the CORS issue in 2 hours using a 5-phase forensic methodology, compared to 7 days of unguided attempts.

### The Sub-Task Explosion Problem

Task d37c968f accumulated 88 sub-tasks. Examining the titles reveals:
- ~30 sub-tasks are "AWS demo attempt #N" — sequential retry attempts
- ~15 sub-tasks are "Fix [specific bug]" — actual code fixes
- ~20 sub-tasks are "Investigate [symptom]" — diagnostic sessions
- ~10 sub-tasks are "Run demo after PR #XXXX" — verification runs
- ~13 sub-tasks are implementation of amendments

**The monitor used sub-tasks for both tracking AND execution.** Every retry, investigation, and verification was a separate sub-task. This made the sub-task list unmanageable as a status report (88 items, 12 completed, 75 pending/active).

**GENTYR gap**: No distinction between "tracking items" (attempts, verifications) and "work items" (actual code changes). A run-and-verify cycle should be ONE sub-task, not three.

## 3.2 Tooling Gap Inventory

### Gap 1: Post-Build Artifact Verification
**What agents lacked**: A tool to verify that compiled artifacts contain expected code
**When it was needed**: Every demo attempt from Apr 14-21 (22+ attempts)
**Proposed solution**: `verify_build_artifacts` tool that greps compiled output for expected function signatures after every build step

### Gap 2: Runtime Code Verification
**What agents lacked**: A tool to verify that code actually running in Chrome matches the compiled artifacts
**When it was needed**: Attempts #28-50 (stale Chrome extension cache)
**Proposed solution**: Extension version/hash check tool, or mandatory extension reload in demo fixtures

### Gap 3: Hypothesis Tracking / "Tried and Failed" Registry
**What agents lacked**: A searchable database of "attempted approach X, result was Y, because Z"
**When it was needed**: Every time an agent re-investigated React _valueTracker (6+ times), PKCE redirect (12+ times)
**Proposed solution**: Investigation log tool that records hypotheses, tests, and results per root cause. Could be attached to persistent tasks or demo scenarios.

### Gap 4: Regression Detection for Code Changes
**What agents lacked**: A/B comparison of before/after behavior when a fix is applied
**When it was needed**: PR #1684 (credentials:'include' made CORS worse, went undetected for 7 days)
**Proposed solution**: Post-fix verification step that compares specific metrics (error count, success rate) before and after a code change

### Gap 5: Solution Promotion Pipeline
**What agents lacked**: A mechanism to promote a proven solution from "helper function in one file" to "framework-level reusable tool"
**When it was needed**: The React native setter hack existed as a 66-line helper for 23 days before being promoted to a GENTYR tool
**Proposed solution**: When a helper function is used successfully by 2+ agents/sessions, auto-flag it for framework promotion review

### Gap 6: Cross-Repo Tool Discovery
**What agents lacked**: Awareness that new GENTYR tools were available after a framework update
**When it was needed**: Amendment #5 (CTO had to manually notify about new chrome-bridge tools)
**Proposed solution**: On `npx gentyr sync`, emit a changelog of new/changed MCP tools. Include in session briefing when tools relevant to active work are added.

### Gap 7: Page State Fingerprinting
**What agents lacked**: A tool to quickly determine "what state is this AWS page in?"
**When it was needed**: Every demo attempt that hit an unexpected page state (IAM redirect, MFA prompt, CAPTCHA, marketing page, error page)
**Proposed solution**: `page_diagnostic` tool (now implemented in GENTYR #358). Before this existed, agents used ad-hoc executeJs calls to check page state, each constructing the diagnostic from scratch.

### Gap 8: Demo Attempt Deduplication
**What agents lacked**: A mechanism to prevent running the same demo with the same (stale) code multiple times
**When it was needed**: Attempts #28-50 all ran with the same stale extension
**Proposed solution**: Demo run tool should record a hash of the compiled artifacts used in each attempt. If the hash matches the previous failed attempt, warn the agent that nothing has changed.

### Gap 9: Structured Investigation Templates
**What agents lacked**: A methodology guide for multi-session debugging campaigns
**When it was needed**: Days 1-16 (before plans were introduced)
**Proposed solution**: Investigation plan templates triggered when a persistent task fails N times. Template: isolate variables → instrument → observe → hypothesis → verify → rollback if wrong.

### Gap 10: Screenshot/Video Evidence at Step Boundaries
**What agents lacked**: Automatic screenshot capture at meaningful moments (form fill, button click, page load, error)
**When it was needed**: Amendment #3 (CTO requested manual screenshot audit)
**Proposed solution**: Enhance `run_demo` to auto-capture screenshots at test.step() boundaries, on navigation events, and on error detection. This was partially addressed by the screenshot capture system but needed more granularity.

## 3.3 Tool Usage Patterns That Worked

### What DID work well:
1. **run_demo MCP tool**: Auto-handled dev server startup, prerequisites, recording
2. **check_demo_result**: Provided structured pass/fail with failure details
3. **page_diagnostic (once created)**: Gave immediate visibility into React state
4. **Plan orchestrator**: Enforced phased investigation discipline
5. **Persistent task amendments**: Reliable CTO → monitor communication
6. **Session queue priority system**: CTO and critical tasks always spawned
7. **Worktree isolation**: Concurrent agents didn't conflict

### What didn't help as much as expected:
1. **Session activity broadcaster**: Produced high-level summaries that didn't carry diagnostic detail
2. **Demo failure auto-repair**: Spawned repair agents that lacked the context to understand compound failures
3. **Standard 6-step pipeline** (investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager): Added overhead for simple one-line fixes. A demo fix that was just "add `credentials:'omit'`" went through all 6 steps.

## 3.4 Findings Summary

1. **Task scope inversely correlates with success**: Narrow, single-issue tasks completed in hours. Broad "make it all work" tasks ran for days and were eventually cancelled.

2. **Plans dramatically improved investigation efficiency**: 5x faster root cause identification when a structured plan was used vs unguided iteration.

3. **10 specific tooling gaps identified**: The highest-impact gaps are artifact verification (#1, #2), hypothesis tracking (#3), and regression detection (#4). These three alone could have prevented the majority of wasted effort.

4. **Sub-task tracking conflates execution with bookkeeping**: The 88-sub-task task was unmanageable because demo attempts and verifications were tracked as separate sub-tasks alongside actual code fixes.
