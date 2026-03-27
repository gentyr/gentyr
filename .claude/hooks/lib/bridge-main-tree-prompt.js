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
Do NOT proceed if pre-flight fails — fix the issue first.

**Step 2: Run demos**
\`\`\`
mcp__playwright__run_demo({ scenario_id: "<scenario>", headless: false })
\`\`\`
For batch: \`mcp__playwright__run_demo_batch({ scenario_ids: ["..."], headless: true })\`

**Step 3: Check results**
\`\`\`
mcp__playwright__check_demo_result({ pid: <pid_from_step_2> })
\`\`\`
Returns pass/fail, recording path, screenshot hints, and analysis guidance.
You MUST follow the \`analysis_guidance\` instructions to visually verify results.

**Step 4: Visual verification (when headed)**
\`\`\`
mcp__playwright__extract_video_frames({ scenario_id: "<id>", timestamp_seconds: <N> })
\`\`\`
Extract frames at critical moments. Use the Read tool to view extracted images.
A programmatic pass with wrong UI state is a FAILURE.

**Step 5: Debug failures**
\`\`\`
mcp__playwright__get_demo_screenshot({ scenario_id: "<id>", timestamp_seconds: <N> })
\`\`\`
Retrieve screenshots at the failure timestamp for diagnosis.

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
| \`npm run dev\` / \`pnpm dev\` | \`mcp__secret-sync__secret_dev_server_start({})\` |
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

### Integration Tests & Demos (MERGE FIRST — NON-NEGOTIABLE)
Demos and integration tests run against the MAIN TREE, not your worktree.
Your code changes are INVISIBLE to demos until merged. The pipeline is:
1. Spawn project-manager → commit, push, PR, self-merge your changes
2. THEN run demos/integration tests (they now test your merged code)
3. If demos fail, create a fix task and iterate

**NEVER run demos before merging. You will be testing stale code.**

### Dev Server Management
- Check health: \`mcp__secret-sync__secret_dev_server_status({})\`
- Start with secrets: \`mcp__secret-sync__secret_dev_server_start({})\`
- Stop: \`mcp__secret-sync__secret_dev_server_stop({})\`
${demoSection}
### Allowed Bash Operations
You MAY use Bash for:
- Git operations (status, diff, log — but NOT commit/push, which is project-manager's job)
- File inspection (ls, cat — but prefer Read/Glob/Grep tools)
- \`curl localhost:<port>\` for quick health diagnostics (CWD-independent)
`;
}
