# Part 4: CTO Intervention Analysis

## 4.1 Amendment Classification

Each CTO amendment is classified as either **Domain Knowledge** (information the CTO has that agents fundamentally cannot derive) or **Automatable Guidance** (information the framework should have provided).

### Amendment #1: services.json Workaround
**Type**: Automatable Guidance (with caveats)
**Content**: Provided all op:// credential paths and a workaround for deleted services.json
**Why the CTO intervened**: The credential-file-guard hook blocked agents from creating services.json, and the secrets key restriction blocked writing credentials to it. The agents were stuck in a Catch-22.
**What should have been automated**:
- The credential paths existed in 1Password; agents could have discovered them via `op item list` but didn't know to look
- The workaround (pass env vars directly to CLI) is a pattern that could be documented in a GENTYR troubleshooting guide
- The root issue (services.json deletion) should have triggered a recovery flow, not a dead end

**Framework improvement**: When credential-file-guard detects a missing services.json, it should emit a recovery hint rather than just blocking. The hint should include the `secret_run_command` workaround pattern.

### Amendment #2: No 24h Cooldown
**Type**: Domain Knowledge
**Content**: AWS MFA codes don't have a 24h rate limit. Stop waiting, retry now.
**Why the CTO intervened**: The agent assumed (incorrectly) that AWS rate-limits MFA email codes with a 24h cooldown. The agent entered a passive waiting state.
**What should have been automated**: This is genuine domain knowledge about AWS behavior. An agent cannot know AWS's rate limiting policy without documentation or experimentation.

**Framework improvement**: None directly. However, a GENTYR "stale-pause detector" already exists — it should be more aggressive about preventing monitors from entering passive waiting states without justification. A monitor that pauses "to wait for a cooldown" should be challenged with "did you confirm this cooldown exists?"

### Amendment #3: Screenshot & Telemetry Audit
**Type**: CTO Strategic Direction
**Content**: Take more screenshots, audit coverage, report findings for GENTYR improvement
**Why the CTO intervened**: The CTO wanted to use this as an opportunity to improve GENTYR's automatic screenshot capture. This was proactive improvement, not reactive debugging.
**What should have been automated**: N/A — this was a deliberate request for analysis, not a gap.

### Amendment #4: Attempt #28 Post-Mortem with 5 Hypotheses
**Type**: Partially Automatable
**Content**: Identified that AWS silently rejects the verification code. Listed 5 hypotheses (code timing, stale code, code format, React state, rate limiting). Also flagged wrong test file.
**Why the CTO intervened**: The agent had been retrying without systematically testing hypotheses. The CTO synthesized observations into a prioritized investigation plan.
**What should have been automated**:
- The observation "page doesn't transition after verify click" could have been captured by `click_and_wait` timeout diagnostics
- The 5 hypotheses are domain-specific but could have been generated from a structured debugging template
- The wrong test file detection is clearly automatable — the demo scenario ID maps to a specific file

**Framework improvement**:
1. When a demo step fails with "no transition," `click_and_wait` should return structured diagnostics (before/after URL, before/after page text, elapsed time)
2. When a task prompt mentions a specific demo scenario, the runner should verify it's running the correct file
3. After N consecutive failures with the same symptom, GENTYR should auto-generate a hypothesis list based on the failure pattern

### Amendment #5: New GENTYR Tools Available
**Type**: Automatable Guidance
**Content**: Announced 4 new chrome-bridge MCP tools (react_fill_input, click_and_wait, page_diagnostic, inspect_input) and the TypeScript bindings
**Why the CTO intervened**: Agents in the target project couldn't know that new tools were added in the gentyr repo
**What should have been automated**: Cross-repo tool discovery. When GENTYR ships new MCP tools, running agents in linked projects should receive notification.

**Framework improvement**: `npx gentyr sync` should generate a tool changelog. The session briefing should highlight new tools relevant to active work. Specifically, if an agent is working on React input fills and a `react_fill_input` tool becomes available, this should be proactively announced.

### Amendment #6: Mandatory Dist Rebuild (Stale Artifacts)
**Type**: Automatable Guidance
**Content**: dist-proxy-chrome must be rebuilt before every demo. "This has wasted attempts #28-#37 and now #43-#44."
**Why the CTO intervened**: The CTO observed that error messages in the runtime didn't match the current source code and deduced the compiled artifacts were stale.
**What should have been automated**:
- Post-build verification (grep compiled output for expected function signatures)
- A `run_demo` prerequisite that validates dist freshness (source mtime > dist mtime → rebuild)
- The demo runner should hash the dist and compare with the previous attempt — if unchanged after a "fix" PR, warn

**Framework improvement**: This is the highest-value single improvement from the entire case study. A dist-freshness prerequisite would have saved 22+ demo attempts across 3+ days.

### Amendment #7: Chrome-Actions Package Fixed
**Type**: Automatable Guidance
**Content**: The TypeScript bindings were fixed (PRs #358-360) — now use executeJs() directly instead of forwarding to non-existent MCP tools
**Why the CTO intervened**: Same as #5 — cross-repo update notification
**What should have been automated**: Same as #5 — tool/package changelog in session briefing

### Amendment #8: Mandatory Extension Reload
**Type**: Automatable Guidance
**Content**: Chrome caches extensions. Rebuilding doesn't make Chrome load new code. Must use reload_chrome_extension or fresh user-data-dir.
**Why the CTO intervened**: This is platform-specific knowledge about Chrome extension caching that agents repeatedly failed to discover through normal investigation.
**What should have been automated**:
- The extension reload could be a mandatory step in the demo prerequisite chain
- `run_demo` should call `reload_chrome_extension` before every headed demo that uses the chrome-bridge
- A "runtime version check" tool that reads the running extension's version and compares with the compiled version

**Framework improvement**: Add extension reload as a built-in step when chrome-bridge tools are used after a dist rebuild.

## 4.2 Classification Summary

| Amendment | Type | Automatable? | Impact |
|-----------|------|-------------|--------|
| #1 services.json | Automatable | Yes — recovery hint | High |
| #2 No 24h cooldown | Domain Knowledge | No | Medium |
| #3 Screenshot audit | CTO Direction | N/A | Low (proactive) |
| #4 Post-mortem hypotheses | Partially Automatable | Partially | High |
| #5 New GENTYR tools | Automatable | Yes — tool changelog | High |
| #6 Stale artifacts | Automatable | Yes — dist verification | Extreme |
| #7 Chrome-actions fixed | Automatable | Yes — tool changelog | High |
| #8 Extension reload | Automatable | Yes — auto-reload step | Extreme |

**6 of 8 amendments (75%) contained fully or partially automatable information.**

## 4.3 CTO Interactive Session Patterns

Beyond amendments, the CTO intervened through:

1. **Task cancellation and recreation**: The CTO cancelled broadly-scoped tasks (7d2cb0f9, 91f1a6c5) and created more focused replacements. This "scope reset" was necessary because the agents couldn't self-correct their scope.

2. **Plan creation**: The CTO initiated the plan-driven approach (Apr 16-18) that proved 5x more effective. Agents didn't spontaneously adopt structured investigation plans.

3. **Cross-session synthesis**: The CTO read multiple agent sessions, identified patterns (stale artifacts, wrong test file), and pushed corrections. No agent had visibility across all concurrent sessions.

4. **New tool development**: The CTO directly commissioned the 4 new chrome-bridge MCP tools (this session) based on observing agents repeatedly struggling with React inputs.

## 4.4 What the CTO Should NOT Have to Do

Based on this analysis, the following CTO interventions could be eliminated:

1. **Notify agents about new framework tools** → Auto-announce in session briefing
2. **Identify stale compiled artifacts** → Build verification prerequisite
3. **Identify Chrome caching** → Auto-reload in demo fixtures
4. **Provide credential paths when services.json is deleted** → Recovery flow
5. **Cancel and recreate poorly-scoped tasks** → Auto-escalate when sub-task count exceeds threshold
6. **Identify that the wrong test file is running** → Validate file against scenario ID
7. **Synthesize hypotheses from multiple failed attempts** → Hypothesis tracker with auto-generation

## 4.5 What the CTO SHOULD Still Do

1. **Provide domain knowledge** (AWS behavior, browser platform quirks)
2. **Set strategic direction** (screenshot audit, investigation methodology)
3. **Commission new framework capabilities** (React tools, diagnostic tools)
4. **Make judgment calls** (when to cancel vs persist, when to change approach)
