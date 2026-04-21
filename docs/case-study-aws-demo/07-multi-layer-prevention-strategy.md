# Multi-Layer Prevention Strategy

## Design Principle

Every failure category from the case study should be intercepted by **at least 2 independent layers** across different control surface categories. No single point of failure should allow an agent to waste significant effort on a known-solvable problem.

The strategy maps each case study failure to specific GENTYR control surfaces, then designs interventions at the most natural interception point.

---

## Layer 1: KNOWLEDGE PERSISTENCE (preventing re-investigation)

### Problem Addressed
Root causes B (React _valueTracker) and E (PKCE redirect) were re-investigated 6+ and 12+ times respectively because knowledge from one session didn't survive to the next.

### Control Surfaces Used
- **New MCP Server**: `investigation-log` (or extension to `persistent-task`)
- **PostToolUse Hook**: `investigation-log-nudge.js`
- **Agent Definition**: Updates to `investigator.md`, `persistent-monitor.md`
- **Prompt Template**: Updates to `buildPromptFromCategory()`
- **CLAUDE.md Section**: New investigation protocol

### Design

#### 1a. Investigation Log MCP Server (NEW)

A lightweight MCP server (`packages/mcp-servers/src/investigation-log/`) backed by `.claude/state/investigation-log.db` with these tools:

| Tool | Purpose |
|------|---------|
| `log_hypothesis` | Record a hypothesis with symptom, test performed, result, conclusion (confirmed/eliminated/inconclusive) |
| `search_hypotheses` | Search by symptom text, root cause category, or project area |
| `log_solution` | Record a proven solution with: problem description, solution code/pattern, files involved, PR number |
| `search_solutions` | Search by problem description or code pattern |
| `get_investigation_context` | For a given symptom, return all prior hypotheses + solutions (used by prompt template) |

**Schema**:
```sql
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY,
  persistent_task_id TEXT,
  symptom TEXT NOT NULL,        -- "fillInput sets DOM value but form submits empty"
  hypothesis TEXT NOT NULL,     -- "React _valueTracker not updated"
  test_performed TEXT,          -- "Checked el._valueTracker after fill — still has old value"
  result TEXT,                  -- "Confirmed: tracker.getValue() returns pre-fill value"
  conclusion TEXT NOT NULL,     -- confirmed | eliminated | inconclusive
  root_cause_tag TEXT,          -- "react-controlled-input" (groupable)
  created_at TEXT,
  agent_id TEXT,
  session_id TEXT
);

CREATE TABLE solutions (
  id TEXT PRIMARY KEY,
  problem TEXT NOT NULL,        -- "React controlled input doesn't register programmatic value change"
  solution TEXT NOT NULL,       -- "Use Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set..."
  files TEXT,                   -- JSON array of file paths involved
  pr_number INTEGER,
  root_cause_tag TEXT,          -- links to hypotheses
  verified_count INTEGER DEFAULT 1,  -- incremented each time this solution is re-used successfully
  promoted_to_tool TEXT,        -- "react_fill_input" once promoted to framework tool
  created_at TEXT
);

CREATE VIRTUAL TABLE hypotheses_fts USING fts5(symptom, hypothesis, result, content=hypotheses);
CREATE VIRTUAL TABLE solutions_fts USING fts5(problem, solution, content=solutions);
```

**Key behavior**: `search_solutions` returns results ranked by `verified_count` (most-proven solutions first) and includes `promoted_to_tool` when applicable (so agents know a framework tool exists).

#### 1b. Investigation Log Nudge Hook (NEW PostToolUse)

**File**: `investigation-log-nudge.js`
**Matcher**: `mcp__playwright__check_demo_result`, `mcp__playwright__run_demo`
**Trigger**: When a demo fails OR when an agent calls `run_demo` on a scenario that has previously failed

**Behavior**:
1. On demo failure: Query `investigation-log.db` for hypotheses and solutions matching the scenario ID or failure text
2. If prior investigations exist: Inject into `additionalContext`:
   ```
   PRIOR INVESTIGATION DATA for this scenario:
   - 3 hypotheses tested, 2 eliminated, 1 confirmed
   - Confirmed root cause: "React _valueTracker not updated" (tag: react-controlled-input)
   - Proven solution: "Use react_fill_input tool" (verified 4 times, promoted to MCP tool)
   DO NOT re-investigate eliminated hypotheses. Start from the confirmed root cause.
   ```
3. If NO prior investigations exist: Inject a nudge:
   ```
   No prior investigation data found. After diagnosing, call log_hypothesis to record your findings for future agents.
   ```

#### 1c. Agent Definition Updates

**investigator.md** — Add to behavioral instructions:
```
Before investigating any failure:
1. Call search_hypotheses with the symptom description
2. Call search_solutions with the problem description
3. If confirmed root causes exist, START from those — do not re-investigate from scratch
4. After each investigation, call log_hypothesis with your findings
5. After confirming a solution works, call log_solution
```

**persistent-monitor.md** — Add to sub-task creation guidance:
```
When creating investigation sub-tasks, include in the prompt:
- Any relevant hypotheses from search_hypotheses
- Any relevant solutions from search_solutions
- The specific hypothesis to test (not "investigate why X fails")
```

#### 1d. Prompt Template Update

In `buildPromptFromCategory()` for the investigator step, prepend:
```
## Prior Investigation Context
{output of get_investigation_context(symptom_from_task_description)}
```

This ensures every investigator spawned for a known problem area sees what's already been tried.

---

## Layer 2: BUILD ARTIFACT VERIFICATION (preventing stale code execution)

### Problem Addressed
Root cause H (stale artifacts): 22+ demo attempts ran stale compiled code because no tool verified source-to-dist freshness or that Chrome loaded the current build.

### Control Surfaces Used
- **MCP Tool Enhancement**: `run_demo` in playwright server
- **New Prerequisite**: Built-in (not user-registered) dist verification
- **PostToolUse Hook Enhancement**: `demo-failure-spawner.js`
- **CLAUDE.md Section**: Build verification protocol

### Design

#### 2a. Built-in Dist Verification in run_demo

In `packages/mcp-servers/src/playwright/server.ts`, add a pre-flight step to `run_demo`:

```typescript
// After prerequisite execution, before Playwright launch:
async function verifyDistFreshness(projectDir: string, servicesConfig: ServicesConfig): Promise<string[]> {
  const warnings: string[] = [];
  const distChecks = servicesConfig.distVerification; // NEW config field

  if (!distChecks) return warnings;

  for (const check of distChecks) {
    // check = { srcGlob: "apps/extension/src/**", distPath: "apps/extension/dist-proxy-chrome/background.js", expectedPatterns: ["evaluateViaCDP", "Runtime.evaluate"] }

    const srcMtime = await getNewestMtime(check.srcGlob, projectDir);
    const distMtime = await getMtime(check.distPath, projectDir);

    if (srcMtime > distMtime) {
      warnings.push(`STALE DIST: ${check.distPath} is older than source (${check.srcGlob}). Rebuild required.`);
    }

    if (check.expectedPatterns) {
      const distContent = await readFile(path.join(projectDir, check.distPath), 'utf-8');
      for (const pattern of check.expectedPatterns) {
        if (!distContent.includes(pattern)) {
          warnings.push(`MISSING PATTERN: "${pattern}" not found in ${check.distPath}. The compiled artifact may not contain recent fixes.`);
        }
      }
    }
  }

  return warnings;
}
```

If warnings are non-empty, `run_demo` returns immediately with an error:
```
Demo blocked: stale build artifacts detected.
- STALE DIST: dist-proxy-chrome/background.js is older than source
- MISSING PATTERN: "evaluateViaCDP" not found in dist-proxy-chrome/background.js
Run the build command and try again.
```

#### 2b. Chrome Extension Reload in Demo Fixtures

When `run_demo` detects that chrome-bridge tools are being used (scenario uses bridge), auto-call `reload_chrome_extension` MCP tool after any dist rebuild. Add to the existing chrome-bridge initialization in the demo pipeline.

#### 2c. Demo Run Deduplication

In `run_demo`, compute a hash of all dist artifacts used. Store in `DemoRunState`. On next `run_demo` for the same scenario:
```
if (currentDistHash === lastFailedDistHash) {
  return {
    status: 'blocked',
    reason: 'No code changes since last failed attempt. Hash: ' + currentDistHash,
    hint: 'Rebuild dist artifacts or investigate the failure before retrying.'
  };
}
```

#### 2d. services.json Config Extension

Add `distVerification` field to `ServicesConfigSchema`:
```typescript
distVerification: z.array(z.object({
  srcGlob: z.string(),           // "apps/extension/src/**"
  distPath: z.string(),           // "apps/extension/dist-proxy-chrome/background.js"
  buildCommand: z.string().optional(), // "npx tsx scripts/build.ts"
  expectedPatterns: z.array(z.string()).optional(),
})).optional()
```

Configurable via `update_services_config` MCP tool — agents can set this up once and it persists.

---

## Layer 3: STRUCTURED INVESTIGATION ESCALATION (preventing trial-and-error spiral)

### Problem Addressed
Root cause E (PKCE) had 12+ failed fix attempts. Agents defaulted to trial-and-error instead of systematic diagnosis.

### Control Surfaces Used
- **PostToolUse Hook**: Enhancement to `demo-failure-spawner.js`
- **Persistent Task Briefing Hook**: Enhancement to `persistent-task-briefing.js`
- **New Prompt Template**: `buildInvestigationPlanPrompt()`
- **Plan Orchestrator**: Auto-create investigation plan after N failures

### Design

#### 3a. Failure Count Escalation in demo-failure-spawner.js

Track consecutive failure count per scenario in `DemoRunState` or `user-feedback.db`:

```javascript
const failureCount = getConsecutiveFailures(scenarioId);

if (failureCount >= 5 && !hasActiveInvestigationPlan(scenarioId)) {
  // Instead of spawning another repair agent, create an investigation plan
  const plan = await createInvestigationPlan(scenarioId, {
    phases: [
      { title: 'Freeze — Stop all retry attempts', tasks: ['Pause related persistent tasks'] },
      { title: 'Read — Gather all failure artifacts', tasks: ['Collect last 5 failure logs, screenshots, error messages'] },
      { title: 'Instrument — Add targeted diagnostics', tasks: ['Add diagnostic logging to suspected components'] },
      { title: 'Observe — Run one instrumented attempt', tasks: ['Single demo run with full telemetry'] },
      { title: 'Diagnose — Analyze data and produce hypothesis list', tasks: ['Ranked hypothesis list with evidence'] },
      { title: 'Verify — Test top hypothesis with minimal change', tasks: ['Single-variable change, verify'] },
    ]
  });

  // Emit to agent context
  return {
    additionalContext: `INVESTIGATION ESCALATION: This scenario has failed ${failureCount} consecutive times. ` +
      `A structured investigation plan has been created (${plan.id}). ` +
      `DO NOT spawn more repair agents. Follow the investigation plan methodology.`
  };
}
```

#### 3b. Persistent Task Scope Guard in persistent-task-briefing.js

Add a check to the existing persistent-task-briefing hook:

```javascript
const subTaskCount = task.sub_tasks_total;
const completionRate = task.sub_tasks_done / subTaskCount;

if (subTaskCount > 30 && completionRate < 0.20) {
  context += `\n\nSCOPE WARNING: This task has ${subTaskCount} sub-tasks with ${Math.round(completionRate * 100)}% completion. ` +
    `Consider requesting CTO scope review via submit_bypass_request with category: 'scope'. ` +
    `The current approach may need decomposition into smaller, focused tasks.`;
}
```

#### 3c. Hypothesis-Driven Sub-Task Prompts

When a persistent monitor creates investigation sub-tasks, the prompt template should enforce:

```
INVESTIGATION PROTOCOL:
You are testing ONE specific hypothesis: "{hypothesis_text}"
Prior eliminated hypotheses (DO NOT re-test): {eliminated_list}

Steps:
1. Design a test that would CONFIRM or ELIMINATE this hypothesis
2. Execute the test
3. Record the result via log_hypothesis
4. If confirmed: proceed to solution
5. If eliminated: report back — do NOT pivot to a different hypothesis
```

---

## Layer 4: CROSS-SESSION SOLUTION DISCOVERY (preventing solution silos)

### Problem Addressed
Root cause B (React hack) existed as a helper for 23 days before becoming a framework tool. Agents in different files/sessions couldn't discover it.

### Control Surfaces Used
- **SessionStart Hook**: Enhancement to `session-briefing.js`
- **New MCP Tool**: On `agent-tracker` server
- **CLAUDE.md Section**: Solution discovery protocol
- **Automation Script**: Enhancement to `gentyr-sync.js`

### Design

#### 4a. Tool Changelog in Session Briefing

When `gentyr-sync.js` rebuilds MCP servers, compute a tool diff:

```javascript
// In gentyr-sync.js, after MCP rebuild:
const prevTools = JSON.parse(readFileSync('.claude/state/mcp-tool-manifest.json'));
const currTools = extractToolManifest(); // parse all server.ts files
const newTools = currTools.filter(t => !prevTools.find(p => p.name === t.name));
const changedTools = currTools.filter(t => {
  const prev = prevTools.find(p => p.name === t.name);
  return prev && prev.description !== t.description;
});
writeFileSync('.claude/state/mcp-tool-manifest.json', JSON.stringify(currTools));
writeFileSync('.claude/state/mcp-tool-changelog.json', JSON.stringify({ newTools, changedTools, timestamp: new Date() }));
```

In `session-briefing.js`, if a changelog exists and is <24h old:

```
NEW GENTYR TOOLS AVAILABLE:
- react_fill_input (chrome-bridge): Fill React controlled inputs using native setter + _valueTracker reset
- click_and_wait (chrome-bridge): Atomic click + page transition wait
- page_diagnostic (chrome-bridge): Dump all inputs/forms/buttons with React state
- inspect_input (chrome-bridge): Deep inspection of single input DOM + React state
```

#### 4b. Solution Search at Task Spawn

In `buildPromptFromCategory()`, when building the investigator step prompt, auto-search `investigation-log.db` for solutions matching the task title/description:

```javascript
const solutions = searchSolutions(task.title + ' ' + task.description);
if (solutions.length > 0) {
  prompt += '\n\n## Known Solutions from Prior Investigations\n';
  for (const s of solutions) {
    prompt += `- **${s.problem}**: ${s.solution}`;
    if (s.promoted_to_tool) prompt += ` (available as MCP tool: ${s.promoted_to_tool})`;
    prompt += ` (verified ${s.verified_count} times)\n`;
  }
}
```

#### 4c. Solution Promotion Detection in hourly-automation.js

Add a periodic check (24h cooldown):

```javascript
// Find solutions verified 3+ times that haven't been promoted
const unpromoted = db.prepare(
  `SELECT * FROM solutions WHERE verified_count >= 3 AND promoted_to_tool IS NULL`
).all();

if (unpromoted.length > 0) {
  // Create a deputy-CTO report
  createReport({
    title: 'Solutions ready for framework promotion',
    body: unpromoted.map(s => `- "${s.problem}": verified ${s.verified_count} times, files: ${s.files}`).join('\n'),
    recommendation: 'Review these for inclusion as GENTYR MCP tools or built-in helpers'
  });
}
```

---

## Layer 5: AMENDMENT PROPAGATION ENFORCEMENT (preventing acknowledged-but-ignored amendments)

### Problem Addressed
CTO Amendment #6 was acknowledged but not effectively propagated to child agents for 6+ hours.

### Control Surfaces Used
- **PostToolUse Hook**: Enhancement to `persistent-task-briefing.js`
- **Prompt Template**: Enhancement to `buildPromptFromCategory()`
- **MCP Tool**: Enhancement to `create_task` on todo-db

### Design

#### 5a. Amendment Injection into Child Task Prompts

When a persistent monitor creates a sub-task via `create_task`, the `persistent-task-linker.js` hook already fires. Enhance it:

```javascript
// After linking the task, inject recent unacted amendments
const amendments = getRecentAmendments(persistentTaskId, { since: '24h', unactedOnly: true });
if (amendments.length > 0) {
  // Append to the task's prompt (via task metadata or a signal)
  const amendmentBlock = amendments.map(a =>
    `CTO AMENDMENT (${a.amendment_type}, ${a.created_at}): ${a.content.substring(0, 500)}`
  ).join('\n\n');

  // Write a signal to the newly spawned agent
  sendSignalToTask(taskId, {
    type: 'directive',
    content: `MANDATORY CTO DIRECTIVES (from parent persistent task):\n${amendmentBlock}`
  });
}
```

#### 5b. Amendment Compliance Check

In `persistent-task-briefing.js`, add an amendment compliance check:

```javascript
// Every 10 tool calls, check if recent amendments have been acted on
const recentAmendments = getAmendments(taskId, { since: '6h' });
for (const amendment of recentAmendments) {
  if (amendment.amendment_type === 'correction') {
    // Check if any sub-task since the amendment addresses it
    const actedOn = getSubTasksSince(taskId, amendment.created_at)
      .some(t => t.title.toLowerCase().includes(amendment.content.substring(0, 50).toLowerCase()));

    if (!actedOn) {
      context += `\nUNACTED AMENDMENT WARNING: Correction from ${amendment.created_at} has not been addressed by any sub-task: "${amendment.content.substring(0, 200)}..."`;
    }
  }
}
```

---

## Layer 6: RUNTIME ASSUMPTION VERIFICATION (preventing invisible failures)

### Problem Addressed
Root causes H (stale artifacts) and F (wrong fix undetected) stem from agents making assumptions that go unchallenged.

### Control Surfaces Used
- **New MCP Tool**: `verify_assumption` on agent-tracker
- **Agent Definition**: Updates to `investigator.md`, `code-writer.md`
- **CLAUDE.md Section**: Assumption verification protocol

### Design

#### 6a. Assumption Verification Nudge

In the investigator agent definition, add a mandatory checklist:

```markdown
## Before Concluding an Investigation

Verify these assumptions explicitly (do not skip):
1. Is the code running in the browser the same as the source code? (Check dist timestamps or grep compiled output)
2. Is the test running the correct file? (Compare scenario file path with actual Playwright command)
3. Has the fix from the last PR actually been compiled and deployed to the runtime? (Check dist for expected patterns)
4. Are you observing the actual failure, or a cached/stale version of it? (Clear state, fresh run)

If ANY assumption cannot be verified, report it as a blocker before proceeding.
```

#### 6b. Demo Pre-Flight Assumptions Check

Add to `run_demo`'s preflight (already exists but enhance):

```typescript
// After prerequisites, before launch:
const assumptions = [
  { name: 'dist freshness', check: () => verifyDistFreshness(projectDir, config) },
  { name: 'correct test file', check: () => verifyTestFile(scenarioId, testFilePath) },
  { name: 'extension loaded', check: () => verifyExtensionVersion(extensionDir) },
];

const failures = [];
for (const a of assumptions) {
  try {
    const result = await a.check();
    if (!result.ok) failures.push(`${a.name}: ${result.reason}`);
  } catch (e) {
    failures.push(`${a.name}: check failed — ${e.message}`);
  }
}

if (failures.length > 0) {
  return { status: 'blocked', reason: 'Pre-flight assumption checks failed', failures };
}
```

---

## Layer 7: AGENT WORKFLOW OPTIMIZATION (preventing overhead on simple fixes)

### Problem Addressed
The standard 6-step pipeline (investigator → code-writer → test-writer → code-reviewer → user-alignment → project-manager) added overhead for one-line fixes.

### Control Surfaces Used
- **Task Category System**: New lightweight categories
- **Prompt Template**: Category-specific pipeline
- **Agent Definition**: Demo-specific fast path

### Design

#### 7a. "Quick Fix" Task Category

Add to seeded categories in `task_categories`:

```javascript
{
  name: 'Quick Fix',
  description: 'Single-file, obvious fixes (null guards, config changes, one-liner patches)',
  sequence: [
    { agent_type: 'code-writer', label: 'Implement fix' },
    { agent_type: 'project-manager', label: 'Commit and merge' }
  ],
  model: 'sonnet'
}
```

This skips investigator (already diagnosed), test-writer (test exists), code-reviewer (trivial change), and user-alignment (no intent ambiguity).

#### 7b. Demo Iteration Category

```javascript
{
  name: 'Demo Iteration',
  description: 'Fix a demo scenario failure based on diagnostic data',
  sequence: [
    { agent_type: 'code-writer', label: 'Implement fix' },
    { agent_type: 'demo-manager', label: 'Verify demo passes' },
    { agent_type: 'project-manager', label: 'Commit and merge' }
  ],
  model: 'sonnet'
}
```

The demo-manager runs the demo to verify before the project-manager commits, creating a tight fix-verify loop.

---

## Implementation Priority Matrix

| Layer | Effort | Impact | Control Surfaces Modified |
|-------|--------|--------|--------------------------|
| L2: Build Artifact Verification | Medium | **Extreme** | playwright server, services.json schema, run_demo |
| L1: Knowledge Persistence | Medium-High | **Very High** | New MCP server, hook, agent defs, prompt template |
| L3: Investigation Escalation | Medium | **High** | demo-failure-spawner, persistent-task-briefing, plan orchestrator |
| L5: Amendment Propagation | Low | **High** | persistent-task-briefing, persistent-task-linker |
| L4: Cross-Session Discovery | Medium | **High** | session-briefing, gentyr-sync, hourly-automation |
| L6: Assumption Verification | Low | **Medium-High** | investigator.md, run_demo preflight |
| L7: Workflow Optimization | Low | **Medium** | task_categories seeds, category prompt templates |

## Expected Outcome

If all 7 layers had been in place during the AWS campaign:

| Failure Category | Without Strategy | With Strategy |
|-----------------|-----------------|---------------|
| B: React _valueTracker (23 days to tool) | 6+ re-investigations | 0 re-investigations (L1 solution search at spawn) |
| E: PKCE redirect (12+ failed fixes) | 9 days | ~2 days (L3 escalation after 5 failures, L1 hypothesis tracking) |
| H: Stale artifacts (22+ wasted attempts) | 3+ days | 0 wasted attempts (L2 dist verification blocks run) |
| F: Wrong CORS fix (7 days undetected) | 7 days | <1 day (L6 assumption verification, L2 regression detection) |
| Amendment #6 ignored for 6h | 6 hours | <30 min (L5 mandatory injection into child prompts) |
| New GENTYR tools unknown to agents | CTO amendment required | Auto-discovered (L4 tool changelog in briefing) |

**Estimated total campaign reduction: 28 days → 8-12 days (57-71% reduction)**
