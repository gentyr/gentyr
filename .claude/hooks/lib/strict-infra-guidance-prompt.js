/**
 * MCP-first infrastructure instructions for strict-infra tasks.
 * Injected when `strict_infra_guidance` is set on a task.
 *
 * Worktrees already have per-worktree port isolation (base 3100, +100 per worktree),
 * so demos and dev servers run directly from the worktree — no merge needed.
 * This block enforces MCP-only usage for infrastructure operations and adds
 * shared resource coordination guidance.
 *
 * @module lib/strict-infra-guidance-prompt
 */

/**
 * Build MCP-first infrastructure prompt for strict-infra agents.
 * @param {string} worktreePath - Absolute path to the agent's worktree
 * @param {boolean} [demoInvolved=false] - Whether demo scenarios are involved
 * @returns {string} Markdown instruction block
 */
export function buildStrictInfraGuidancePrompt(worktreePath, demoInvolved = false) {
  const demoSection = demoInvolved ? `

### Demo Execution (MANDATORY MCP WORKFLOW)

You are PROHIBITED from running demos, Playwright, or test commands via Bash.
ALL demo operations MUST use MCP tools. The nudge hook will catch violations.

**Step 1: Pre-flight check**
\`\`\`
mcp__playwright__preflight_check({})
\`\`\`
Verifies config, browsers, dependencies, dev server health, and runs prerequisites.
If pre-flight fails, diagnose the error before escalating:
- Secret resolution failure → verify dev server running via \`mcp__secret-sync__secret_dev_server_status\`, start if needed
- Missing dependencies → run \`mcp__secret-sync__secret_run_command({ command: "pnpm install" })\`
- Browser not found → report to monitor, this requires human setup
Do NOT give up on the first failure — diagnose and fix before escalating.

**Step 2: Acquire display lock (headed demos only)**
\`\`\`
mcp__playwright__acquire_display_lock({ title: "<brief description>" })
\`\`\`
Required before any \`run_demo\` with \`headless: false\`. If \`acquired: false\` is returned,
poll \`mcp__playwright__get_display_queue_status({})\` every 30s until the lock is yours.
Headless demos (\`headless: true\`) do NOT need the display lock — skip this step for batch runs.

**Step 3: Run demos**
\`\`\`
mcp__playwright__run_demo({ scenario_id: "<scenario>", headless: false })
\`\`\`
For batch: \`mcp__playwright__run_demo_batch({ scenario_ids: ["..."], headless: true })\`

**Step 4: Check results**
\`\`\`
mcp__playwright__check_demo_result({ pid: <pid_from_step_3> })
\`\`\`
Returns pass/fail, recording path, screenshot hints, and analysis guidance.
You MUST follow the \`analysis_guidance\` instructions to visually verify results.

**Step 5: Visual verification (when headed)**
\`\`\`
mcp__playwright__extract_video_frames({ scenario_id: "<id>", timestamp_seconds: <N> })
\`\`\`
Extract frames at critical moments. Use the Read tool to view extracted images.
A programmatic pass with wrong UI state is a FAILURE.

**Step 6: Debug failures**
\`\`\`
mcp__playwright__get_demo_screenshot({ scenario_id: "<id>", timestamp_seconds: <N> })
\`\`\`
Retrieve screenshots at the failure timestamp for diagnosis.

**Step 7: Release display lock (headed demos only)**
\`\`\`
mcp__playwright__release_display_lock({})
\`\`\`
ALWAYS call this after the demo completes — whether it passed or failed.
Failure to release blocks other agents waiting for display access.

**Step 8: Report Visual Findings (MANDATORY)**
After the demo completes (pass or fail), you MUST report what you SAW:
- Use the Read tool to view screenshots/frames from \`check_demo_result\` (you are multimodal — you can see images)
- If \`failure_frames\` were returned, Read each frame image and describe the browser state
- If no failure_frames, call \`get_demo_screenshot\` at the failure timestamp and view it
- Describe: what page was showing, what elements were visible/missing, any error messages on screen
- Include screenshot file paths in your report so the monitor can verify independently
- "The demo failed with a timeout" is NOT an acceptable report — describe the visual state

**PROHIBITED demo operations (will trigger nudge hook):**
- \`npx playwright test\` via Bash
- \`pnpm test:e2e\` via Bash
- \`npm run test\` via Bash for E2E tests
- Any direct Playwright CLI invocation
` : '';

  return `
## Infrastructure Access (STRICT MCP-ONLY)

You are in a worktree at \`${worktreePath}\`. Your worktree has isolated ports (3100+) for dev
servers and demos — you can test your changes directly without merging first.

**ALL infrastructure operations MUST use MCP tools. Using Bash for infrastructure is PROHIBITED.**
A nudge hook monitors your Bash commands and will flag violations.

### PROHIBITED Bash Operations
You MUST NOT run these via Bash. Use the MCP equivalent:

| PROHIBITED Bash Command | REQUIRED MCP Tool |
|---|---|
| \`npm run dev\` / \`pnpm dev\` | Handled automatically by \`run_demo\` — do not call manually |
| \`npm run build\` / \`pnpm build\` | \`mcp__secret-sync__secret_run_command({ command: ["pnpm", "build"], cwd: "${worktreePath}" })\` |
| \`npx playwright test\` | \`mcp__playwright__run_demo\` or \`mcp__playwright__run_tests\` |
| \`op read\` / \`op run\` | \`mcp__onepassword__readSecret\` or \`mcp__secret-sync__secret_run_command\` |
| \`npm install\` / \`pnpm install\` | \`mcp__secret-sync__secret_run_command({ command: ["pnpm", "install"], cwd: "${worktreePath}" })\` |

### Builds & Tests (in your worktree)
Use \`secret_run_command\` with your worktree path. Secrets are auto-injected, output sanitized:
\`\`\`
mcp__secret-sync__secret_run_command({
  command: ["pnpm", "build"],
  cwd: "${worktreePath}"
})
\`\`\`
Unit tests: \`command: ["pnpm", "test"], cwd: "${worktreePath}"\`

### Integration Tests & Demos (WORKTREE-LOCAL)
Demos and dev servers run from your worktree automatically on isolated ports.
MCP tools detect your worktree and use it as the project directory.

- \`run_demo\`, \`run_tests\`, \`preflight_check\` all execute in your worktree
- Dev server starts via \`secret_dev_server_start\` using your worktree as CWD
- No need to merge first — test your changes directly
- When done, spawn project-manager to commit, push, PR, self-merge

### Dev Server Management (AUTOMATED)
\`run_demo\` and \`preflight_check\` automatically start the dev server from services.json config.
You do NOT need to manually call \`secret_dev_server_start\` before running demos — it handles
this automatically. If the auto-start fails, register a prerequisite:
\`\`\`
mcp__user-feedback__register_prerequisite({
  command: "pnpm dev",
  scope: "global",
  run_as_background: true,
  health_check: "curl -sf http://localhost:\${PORT:-3000}"
})
\`\`\`

For manual control (non-demo contexts only):
- Status: \`mcp__secret-sync__secret_dev_server_status({})\`
- Start: \`mcp__secret-sync__secret_dev_server_start({})\`
- Stop: \`mcp__secret-sync__secret_dev_server_stop({})\`
${demoSection}### Allowed Bash Operations
You MAY use Bash for:
- Git operations (status, diff, log — but NOT commit/push, which is project-manager's job)
- File inspection (ls, cat — but prefer Read/Glob/Grep tools)
- \`curl localhost:<port>\` for quick health diagnostics (CWD-independent)

### Shared Resource Coordination

Your worktree has isolated ports, but some resources are shared across all agents:

| Resource | What It Is | When to Acquire |
|---|---|---|
| \`display\` | Headed browser rendering + video capture | Before \`run_demo\` with \`headless: false\` (auto-acquired by run_demo) |
| \`chrome-bridge\` | Real Chrome window via extension (port 8765) | Before ANY chrome-bridge tool usage |
| \`main-dev-server\` | Main-tree dev server (port 3000) | When Chrome extension has compiled-in URLs pointing to port 3000 |

**Acquire before use:**
\`\`\`
mcp__agent-tracker__acquire_shared_resource({ resource_id: "chrome-bridge", title: "AWS login demo" })
\`\`\`

**Release when done:**
\`\`\`
mcp__agent-tracker__release_shared_resource({ resource_id: "chrome-bridge" })
\`\`\`

**If resource is held by another agent:** You'll get \`{ acquired: false, position: N }\`. Poll \`get_shared_resource_status\` every 30s until your position is 0, then retry acquire.

**Renew for long sessions:** Call \`renew_shared_resource\` every 5 minutes to prevent auto-expiry.

**ALWAYS release before completing your task.** Failure to release blocks other agents.

Your worktree's isolated dev server (your allocated port, 3100+) does NOT require the \`main-dev-server\` lock.
Only acquire it when you specifically need the main-tree server at port 3000 (e.g., Chrome extension with compiled-in URLs).
`;
}
