/**
 * Shared auditor prompt builder for the universal audit gate system.
 * Single source of truth — consumed by universal-audit-spawner.js (first spawn)
 * and session-queue.js Step 1b.5 (revival spawn).
 *
 * @module lib/auditor-prompt
 */

/**
 * Build the auditor session spec (everything needed for enqueueSession except source).
 * @param {{ taskId: string, taskType: 'todo'|'persistent', taskTitle: string, criteria: string, method: string }} opts
 * @param {string} projectDir
 * @returns {object} Partial enqueueSession spec (title, agentType, hookType, tagContext, model, agent, lane, priority, ttlMs, projectDir, metadata, buildPrompt)
 */
export function buildAuditorSessionSpec({ taskId, taskType, taskTitle, criteria, method }, projectDir) {
  const passTool = taskType === 'todo'
    ? 'mcp__todo-db__task_audit_pass'
    : 'mcp__persistent-task__pt_audit_pass';
  const failTool = taskType === 'todo'
    ? 'mcp__todo-db__task_audit_fail'
    : 'mcp__persistent-task__pt_audit_fail';

  return {
    agentType: 'universal-auditor',
    hookType: 'universal-auditor',
    tagContext: 'universal-auditor',
    model: 'claude-haiku-4-5-20251001',
    agent: 'universal-auditor',
    lane: 'audit',
    priority: 'normal',
    ttlMs: 8 * 60 * 1000,
    projectDir,
    metadata: { taskId, taskType },
    buildPrompt: (agentId) => {
      return `[Automation][universal-auditor][AGENT:${agentId}] Audit ${taskType} task ${taskId}.

## Task
"${taskTitle}"

## Success Criteria
${criteria || '(none provided)'}

## Verification Method
${method || '(none provided)'}

## Your Job
You are an INDEPENDENT auditor. Verify the success criteria and verification method against actual artifacts.
Do NOT trust the agent's claims — check actual files, test results, PR status, directory contents, etc.

## Process
1. Read the success criteria and verification method above carefully
2. Use Read, Glob, Grep, Bash to check each claim against reality:
   - If criteria mention tests: run them or check recent test output
   - If criteria mention files/directories: verify they exist with expected content
   - If criteria mention PRs: check PR status via \`gh pr view\`
   - If criteria mention counts: verify actual counts match
3. Render exactly ONE verdict with concrete evidence

## Verdict (pick ONE, then exit immediately)
- PASS: ${passTool}({ task_id: "${taskId}", evidence: "<what you found>" })
- FAIL: ${failTool}({ task_id: "${taskId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 8 minutes. Be efficient. If you cannot verify (external system unavailable, ambiguous criteria), FAIL with reason.`;
    },
  };
}
