/**
 * Strict infrastructure guidance block injected into persistent monitor prompts
 * when the persistent task has strict_infra_guidance: true.
 *
 * Instructs the monitor to propagate the flag to child tasks that touch
 * builds, demos, dev servers, or secrets.
 *
 * Shared between persistent-task-spawner.js, hourly-automation.js,
 * and session-queue.js (requeueDeadPersistentMonitor).
 *
 * @module lib/persistent-monitor-strict-infra-instructions
 */

/**
 * Build strict infrastructure guidance instructions for the persistent monitor prompt.
 * @returns {string} Markdown instruction block
 */
export function buildPersistentMonitorStrictInfraInstructions() {
  return `

## Strict Infrastructure Guidance (Child Task Propagation)

This persistent task has strict infrastructure guidance enabled. You MUST set \`strict_infra_guidance: true\` on
ALL child tasks that touch infrastructure (builds, demos, dev servers, secrets).

\`\`\`
mcp__todo-db__create_task({
  category_id: 'standard',
  title: 'Implement and verify feature X',
  description: '... Use MCP tools for builds (secret_run_command) and demos (run_demo). Do NOT use Bash for infrastructure.',
  assigned_by: 'persistent-monitor',
  persistent_task_id: '<your task ID>',
  strict_infra_guidance: true
})
\`\`\`

### Demo Verification Pipeline
Child agents run demos directly in their worktrees on isolated ports.
No merge needed between fix→test iterations. Merge only when the demo passes.

1. **Code-writer** edits code in worktree, verifies compilation via \`secret_run_command\`
2. **Demo-manager** runs demos via \`mcp__playwright__run_demo\` — tests worktree code directly
3. If demos fail → create a fix task → iterate from step 1
4. When demos pass → **Project-manager** commits, pushes, creates PR, self-merges

**Child agent iteration rule:** When a child agent's task fails, the child MUST
diagnose the error and retry at least once before reporting blocked. Only create
a NEW fix task if the child confirmed the issue is in the code, not infrastructure.
Infrastructure failures (secrets, builds, dev servers) should be debugged in-place.

### Demo Verification Tasks
When creating demo-verification tasks, be explicit about the MCP workflow:
\`\`\`
mcp__todo-db__create_task({
  category_id: 'demo-design',
  title: 'Verify demos pass for <feature>',
  description: 'Run preflight_check, then run_demo for scenarios X, Y, Z. Use check_demo_result to verify. If headed, extract_video_frames at key moments for visual verification. Report results.',
  assigned_by: 'persistent-monitor',
  persistent_task_id: '<your task ID>',
  strict_infra_guidance: true
})
\`\`\`

### When to set strict_infra_guidance: true
- ANY task involving: demos, builds, dev servers, secrets, integration tests
### When to leave it false
- Pure code-only changes with no infrastructure interaction
- Investigation/research that only reads files`;
}
