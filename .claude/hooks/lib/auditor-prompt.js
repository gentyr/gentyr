/**
 * Shared auditor prompt builder for the universal audit gate system.
 * Single source of truth — consumed by universal-audit-spawner.js (first spawn)
 * and session-queue.js Step 1b.5 (revival spawn).
 *
 * Supports three task types:
 *   - 'todo'       → task_audit_pass / task_audit_fail (on todo-db server)
 *   - 'persistent' → pt_audit_pass / pt_audit_fail (on persistent-task server)
 *   - 'plan'       → verification_audit_pass / verification_audit_fail (on plan-orchestrator server)
 *
 * @module lib/auditor-prompt
 */

/**
 * Resolve the pass/fail MCP tool names and agent definition for a given task type.
 * @param {'todo'|'persistent'|'plan'} taskType
 * @returns {{ passTool: string, failTool: string, agent: string, idParam: string }}
 */
function resolveAuditTools(taskType) {
  if (taskType === 'plan') {
    return {
      passTool: 'mcp__plan-orchestrator__verification_audit_pass',
      failTool: 'mcp__plan-orchestrator__verification_audit_fail',
      agent: 'plan-auditor',
      idParam: 'task_id',
    };
  }
  if (taskType === 'persistent') {
    return {
      passTool: 'mcp__persistent-task__pt_audit_pass',
      failTool: 'mcp__persistent-task__pt_audit_fail',
      agent: 'universal-auditor',
      idParam: 'id',
    };
  }
  // Default: todo
  return {
    passTool: 'mcp__todo-db__task_audit_pass',
    failTool: 'mcp__todo-db__task_audit_fail',
    agent: 'universal-auditor',
    idParam: 'task_id',
  };
}

/**
 * Build the auditor session spec (everything needed for enqueueSession except source).
 * @param {{ taskId: string, taskType: 'todo'|'persistent'|'plan', taskTitle: string, criteria: string, method: string }} opts
 * @param {string} projectDir
 * @returns {object} Partial enqueueSession spec (title, agentType, hookType, tagContext, model, agent, lane, priority, ttlMs, projectDir, metadata, buildPrompt)
 */
export function buildAuditorSessionSpec({ taskId, taskType, taskTitle, criteria, method }, projectDir) {
  const { passTool, failTool, agent, idParam } = resolveAuditTools(taskType);

  // Plan auditors use the plan-auditor agent definition; todo/persistent use universal-auditor
  const agentType = agent;

  return {
    agentType,
    hookType: agentType,
    tagContext: agentType,
    model: 'claude-haiku-4-5-20251001',
    agent,
    lane: 'audit',
    priority: 'normal',
    ttlMs: 8 * 60 * 1000,
    projectDir,
    metadata: { taskId, taskType },
    buildPrompt: (agentId) => {
      return `[Automation][${agentType}][AGENT:${agentId}] Audit ${taskType} task ${taskId}.

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
- PASS: ${passTool}({ ${idParam}: "${taskId}", evidence: "<what you found>" })
- FAIL: ${failTool}({ ${idParam}: "${taskId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 8 minutes. Be efficient. If you cannot verify (external system unavailable, ambiguous criteria), FAIL with reason.`;
    },
  };
}
