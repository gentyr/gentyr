/**
 * Bridge instructions injected into persistent monitor prompts
 * when the persistent task has bridge_main_tree: true.
 *
 * Shared between persistent-task-spawner.js, hourly-automation.js,
 * and session-queue.js (requeueDeadPersistentMonitor).
 *
 * @module lib/persistent-monitor-bridge-instructions
 */

/**
 * Build bridge-mode instructions for the persistent monitor prompt.
 * @returns {string} Markdown instruction block
 */
export function buildPersistentMonitorBridgeInstructions() {
  return `

## Infrastructure Bridge Mode (STRICT)

This persistent task has bridge mode enabled. You MUST set \`bridge_main_tree: true\` on
ALL child tasks that touch infrastructure (builds, demos, dev servers, secrets).

\`\`\`
mcp__todo-db__create_task({
  section: 'CODE-REVIEWER',
  title: 'Implement and verify feature X',
  description: '... Use MCP tools for builds (secret_run_command) and demos (run_demo). Do NOT use Bash for infrastructure.',
  assigned_by: 'persistent-monitor',
  persistent_task_id: '<your task ID>',
  bridge_main_tree: true
})
\`\`\`

### Merge-First Verification Pipeline (NON-NEGOTIABLE)
When child agents make code changes that need demo/integration verification, the pipeline is STRICTLY:
1. **Code-writer** edits code in worktree, verifies compilation via \`secret_run_command\`
2. **Project-manager** commits, pushes, creates PR, self-merges to base branch
3. **Demo-manager** runs demos via \`mcp__playwright__run_demo\` (now testing merged code)
4. If demos fail → create a fix task → iterate from step 1

**CRITICAL**: NEVER instruct child agents to run demos before merging. Demos test the main
tree. Worktree code is INVISIBLE to demos until merged. Running demos before merge tests
STALE CODE and wastes an entire agent cycle.

### Demo Verification Tasks
When creating demo-verification tasks, be explicit about the MCP workflow:
\`\`\`
mcp__todo-db__create_task({
  section: 'DEMO-MANAGER',
  title: 'Verify demos pass after <feature> merge',
  description: 'Run preflight_check, then run_demo for scenarios X, Y, Z. Use check_demo_result to verify. If headed, extract_video_frames at key moments for visual verification. Report results.',
  assigned_by: 'persistent-monitor',
  persistent_task_id: '<your task ID>',
  bridge_main_tree: true
})
\`\`\`

### When to set bridge_main_tree: true
- ANY task involving: demos, builds, dev servers, secrets, integration tests
### When to leave it false
- Pure code-only changes with no infrastructure interaction
- Investigation/research that only reads files`;
}
