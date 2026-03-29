/**
 * MCP-first infrastructure instructions for bridge-enabled agents.
 * Injected into task runner prompts when bridge_main_tree is set.
 * Language is intentionally strict/prohibitive to force correct tool usage.
 *
 * @module lib/bridge-main-tree-prompt
 */

/**
 * Build MCP-first infrastructure prompt for bridge-enabled agents.
 * @param {string} worktreePath - Absolute path to the agent's worktree
 * @param {boolean} [demoInvolved=false] - Whether demo scenarios are involved
 * @returns {string} Markdown instruction block
 */
export function buildBridgeMainTreePrompt(worktreePath, demoInvolved = false) {
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

**PROHIBITED demo operations (will trigger nudge hook):**
- \`npx playwright test\` via Bash
- \`pnpm test:e2e\` via Bash
- \`npm run test\` via Bash for E2E tests
- Any direct Playwright CLI invocation
` : '';

  return `
## Infrastructure Access (STRICT MCP-ONLY)

You are in a worktree at \`${worktreePath}\` for git isolation. The main project has running
dev servers, built artifacts, and Chrome infrastructure.

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
${demoSection}
### Allowed Bash Operations
You MAY use Bash for:
- Git operations (status, diff, log — but NOT commit/push, which is project-manager's job)
- File inspection (ls, cat — but prefer Read/Glob/Grep tools)
- \`curl localhost:<port>\` for quick health diagnostics (CWD-independent)
`;
}
