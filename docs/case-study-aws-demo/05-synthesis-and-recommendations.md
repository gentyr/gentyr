# Part 5: Synthesis & Prioritized Recommendations

## Executive Summary

The AWS demo automation campaign consumed 28 days, 268 commits, 44 persistent tasks, 4,143+ session queue items, and ~45 billion input tokens. The campaign was ultimately partially successful — the core root causes were identified and many were fixed — but analysis reveals that **50-70% of the effort was wasted on repeated investigation, stale artifacts, and communication failures**.

The single highest-impact finding: **agents running the same broken code for 22+ consecutive attempts** because no tool verified that compiled artifacts matched source code or that Chrome was loading the current build.

## Cross-Cutting Themes

### Theme 1: Diagnostic Assumptions Go Unchallenged
Agents assumed source code matched runtime code. Agents assumed Chrome loaded updated extensions after rebuild. Agents assumed a fix that was merged was also deployed (compiled). None of these assumptions were challenged by any framework mechanism.

**Impact**: Root causes H (stale artifacts) and F (CORS wrong fix) persisted for days because agents didn't verify their assumptions.

### Theme 2: Solutions Stay Local, Problems Stay Global
The React native setter hack was known on day 4 but not available as a framework tool until day 27. Each new agent that needed the solution either found it (lucky) or re-derived it (wasteful). The solution lived in one file in one project; the problem was global.

**Impact**: Root cause B was re-investigated 6+ times across 23 days.

### Theme 3: Broad Scope Causes Sub-Task Explosion
Tasks scoped as "make the whole thing work" accumulated 88-140 sub-tasks. Monitors spent more time managing sub-task state than making diagnostic progress. Well-scoped tasks (single root cause, single component) completed in under 2 hours.

**Impact**: 3 persistent tasks with broad scope ran for 60-126 hours before being cancelled.

### Theme 4: Plans Beat Iteration for Investigation
The shift from "try things and see" to "read → instrument → observe → diagnose → verify" produced a 5x improvement in investigation efficiency. The plan-driven approach prevented premature fix attempts and ensured systematic elimination of hypotheses.

**Impact**: The CORS root cause took 7 days of iteration but only 2 hours of plan-driven investigation.

### Theme 5: CTO as Communication Bridge
75% of CTO amendments contained information that the framework could have provided automatically. The CTO's unique value was cross-session visibility, platform domain knowledge, and strategic direction — not the operational details that dominated amendments.

## Prioritized Recommendations

### Priority 1 (Extreme Impact): Build Artifact Verification System
**Problem**: 22+ demo attempts wasted on stale compiled code
**Solution**: Three components:
1. **Pre-demo dist freshness check**: Compare source mtime vs dist mtime before `run_demo`. If source is newer, force rebuild. This becomes a built-in `run_demo` prerequisite, not a registered user prerequisite.
2. **Post-build content verification**: After `npm run build` or dist rebuild, grep the output for expected function signatures (configurable per project in services.json). Fail if expected patterns are missing.
3. **Chrome extension reload**: When chrome-bridge is used in a demo, auto-call `reload_chrome_extension` after any dist rebuild. This should be in `run_demo`'s chrome-bridge initialization path.

**Effort**: Medium (2-3 PRs to GENTYR)
**Expected savings**: Would have saved 3+ days of wall-clock time in this campaign alone

### Priority 2 (High Impact): Investigation Log / Hypothesis Tracker
**Problem**: Agents re-investigated eliminated hypotheses because no record existed of prior attempts
**Solution**: A new MCP tool (or extension to persistent-task tools) that records:
- Hypothesis text
- Test performed
- Result observed
- Conclusion (confirmed/eliminated/inconclusive)
- Linked to persistent task and/or demo scenario

This becomes searchable by symptom description. When a new agent observes a symptom, it can search for prior investigations of similar symptoms.

**Effort**: Medium-High (new MCP server or extension to persistent-task server)
**Expected savings**: Would have prevented 6+ re-investigations of React _valueTracker and 12+ re-attempts at PKCE redirect

### Priority 3 (High Impact): Solution Promotion Pipeline
**Problem**: Proven solutions stayed trapped in one file for weeks
**Solution**: Two mechanisms:
1. **Auto-detection**: When 2+ agents in different sessions copy or re-derive the same code pattern (detected via similarity analysis of git diffs), flag the pattern for framework promotion.
2. **Manual flagging**: An MCP tool `flag_for_framework_promotion` that agents call when they create a helper that seems generally useful. The CTO reviews flagged items and decides what to promote.

**Effort**: High (requires code similarity analysis or manual flagging workflow)
**Expected savings**: Would have promoted the React fill hack to a GENTYR tool weeks earlier

### Priority 4 (High Impact): Structured Investigation Plan Templates
**Problem**: Agents defaulted to trial-and-error instead of systematic investigation
**Solution**: When a persistent task accumulates N failures (configurable, default 5), auto-generate an investigation plan using the template:
1. **Freeze**: Stop retry attempts
2. **Read**: Gather all failure artifacts (logs, screenshots, error messages)
3. **Instrument**: Add diagnostic logging to specific components
4. **Observe**: Run one instrumented attempt and collect data
5. **Diagnose**: Analyze data, produce ranked hypothesis list
6. **Verify**: Test the top hypothesis with a minimal change
7. **Rollback if wrong**: Revert and try next hypothesis

This could be a plan template that the persistent monitor automatically activates, or a CTO prompt delivered via amendment.

**Effort**: Medium (plan template + auto-escalation logic)
**Expected savings**: Would have shortened the PKCE and CORS investigations by days

### Priority 5 (Medium Impact): Cross-Repo Tool Changelog
**Problem**: Agents in linked projects didn't know about new GENTYR tools
**Solution**: `npx gentyr sync` generates a tool changelog (diff of MCP tool definitions between current and previous build). The session briefing includes new tools relevant to active work. Specifically:
- Compare tool definitions before and after build
- Emit new/changed tool names in session briefing
- If the briefing detects active work keywords (e.g., "React input", "AWS login") matching new tool descriptions, highlight them prominently

**Effort**: Low-Medium (changelog generation + briefing integration)
**Expected savings**: Would have eliminated CTO amendments #5 and #7

### Priority 6 (Medium Impact): Demo Run Deduplication
**Problem**: Agents ran the same demo with the same code multiple times
**Solution**: `run_demo` records a hash of all compiled artifacts used in each attempt. Before running, compare with the hash from the last failed attempt on the same scenario. If identical, warn: "No code changes since the last failed attempt. Running again is unlikely to produce a different result. Consider investigating the failure first."

**Effort**: Low (hash computation + comparison in run_demo)
**Expected savings**: Would have prevented repetitive retry cycles

### Priority 7 (Medium Impact): Auto-Scope Escalation for Persistent Tasks
**Problem**: Broad-scope tasks ran for 60-126 hours before being cancelled
**Solution**: When a persistent task accumulates >30 sub-tasks with <20% completion rate, auto-pause and escalate to the CTO with a scope analysis: "This task has 88 sub-tasks with 12% completion. Consider decomposing into smaller, focused tasks." The monitor should not be allowed to spawn unlimited sub-tasks without CTO review.

**Effort**: Low (threshold check in persistent-task-briefing hook)
**Expected savings**: Would have triggered earlier scope resets

### Priority 8 (Low Impact): Credential Recovery Flow
**Problem**: services.json deletion left agents stuck with no way to access credentials
**Solution**: When credential-file-guard detects a missing services.json, instead of just blocking, emit a recovery path: "services.json is missing. Use `mcp__onepassword__read_secret` to resolve credentials directly, or use `secret_run_command` with explicit env vars."

**Effort**: Low (hint message in credential-file-guard hook)
**Expected savings**: Would have eliminated CTO amendment #1

### Priority 9 (Low Impact): Page State Diagnostic Auto-Capture
**Problem**: Agents didn't know what state an AWS page was in after a navigation or click
**Solution**: The `click_and_wait` tool already returns `finalUrl` and can check for text/element conditions. Enhance `run_demo` to auto-capture `page_diagnostic` output after each test.step() failure, so the agent immediately knows the page state without a manual investigation step.

**Effort**: Low (diagnostic capture in test step failure path)
**Expected savings**: Moderate — saves the ~10 minutes per failure that agents spend running ad-hoc diagnostics

### Priority 10 (Research): Multi-Session Diagnostic State Sharing
**Problem**: Child agents couldn't access other children's findings
**Solution**: A shared diagnostic context (beyond session summaries) that carries structured technical findings:
- "PR #1684 made CORS worse (before: 5 CDN failures, after: 12 CDN failures)"
- "The running extension code doesn't contain `evaluateViaCDP` — dist is stale"
- "Email verification code is rejected when entered more than 3 minutes after receipt"

This is the hardest problem to solve well because it requires structured representation of diagnostic findings. Could start with a simple key-value store attached to the persistent task.

**Effort**: High (requires design for structured diagnostic representation)
**Expected savings**: Potentially significant — prevents the "opposite fix" anti-pattern and redundant investigation

## Implementation Backlog

| Priority | Recommendation | Effort | Files to Modify |
|----------|---------------|--------|----------------|
| P1 | Build artifact verification | Medium | playwright/server.ts, run_demo handler |
| P2 | Investigation log / hypothesis tracker | Medium-High | New MCP server or persistent-task extension |
| P3 | Solution promotion pipeline | High | New workflow, git diff analysis |
| P4 | Investigation plan templates | Medium | plan-orchestrator, persistent-task-spawner |
| P5 | Cross-repo tool changelog | Low-Medium | sync.js, session-briefing.js |
| P6 | Demo run deduplication | Low | playwright/server.ts, run_demo handler |
| P7 | Auto-scope escalation | Low | persistent-task-briefing.js |
| P8 | Credential recovery flow | Low | credential-file-guard hook |
| P9 | Page state auto-capture | Low | click_and_wait handler, run_demo |
| P10 | Multi-session diagnostic sharing | High | New system design needed |

## Metric Projections

If P1-P4 had been in place from the start:
- **Stale artifact waste**: 22 attempts → 0 (P1)
- **Re-investigation of known root causes**: 18+ sessions → ~3 (P2)
- **Time to React tool encapsulation**: 23 days → ~5 days (P3)
- **PKCE investigation duration**: 9 days → ~2 days (P4)
- **Total campaign duration**: 28 days → estimated 10-14 days (50-65% reduction)
- **Token consumption**: ~45B → estimated 15-20B (55-65% reduction)

## What Worked Well (Preserve These)

1. **Persistent task amendment system**: Reliable, fast delivery of CTO guidance
2. **Plan orchestrator**: Dramatically improved investigation discipline
3. **Worktree isolation**: Prevented concurrent agent conflicts
4. **Session queue priority system**: Critical work always got capacity
5. **Demo recording system**: Video evidence was invaluable for diagnosis
6. **Shared resource registry**: Serialized display/chrome-bridge access without conflicts
7. **Session reaper**: Cleaned up stuck sessions and freed capacity
8. **Revival system**: Persistent monitors recovered from crashes automatically

## Open Questions for Future Investigation

1. Did the session activity broadcaster deliver useful information to any agent during this campaign? (Suspected: no, based on summary content analysis)
2. What percentage of the 384 hard-killed sessions were actually making progress vs genuinely stuck?
3. How many of the 179 "spawn returned no PID" failures were due to memory pressure vs system load?
4. Would a shorter hard-kill timeout (30 min instead of 60 min) have improved throughput by freeing slots faster?
5. How effective was the skepticism protocol at catching false success claims? (No data found in this analysis)
