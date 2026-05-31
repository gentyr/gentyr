/**
 * Shared auditor prompt builder for the universal audit gate system.
 * Single source of truth — consumed by universal-audit-spawner.js (first spawn)
 * and session-queue.js Step 1b.5 (revival spawn).
 *
 * Supports three task types:
 *   - 'todo'          → task_audit_pass / task_audit_fail (on todo-db server)
 *   - 'persistent'    → pt_audit_pass / pt_audit_fail (on persistent-task server)
 *   - 'plan'          → verification_audit_pass / verification_audit_fail (on plan-orchestrator server)
 *
 * @module lib/auditor-prompt
 */

/**
 * Set of agent_type strings for every auditor variant. Used by revival paths
 * (revival-daemon, drain-step-1d) to detect when a dead session was an auditor
 * — those deaths are handled by reapSyncPass Step 1b.5, not by the generic
 * task-runner revival paths.
 */
export const AUDITOR_AGENT_TYPES = new Set([
  'universal-auditor',
  'plan-auditor',
]);

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
 * Build an authorization auditor session spec for verifying CTO decisions.
 * @param {{ decisionId: string, decisionType: string, verbatimText: string, decisionContext: string, sessionId: string }} opts
 * @param {string} projectDir
 * @returns {object} Partial enqueueSession spec
 */
export function buildAuthorizationAuditorSessionSpec({ decisionId, decisionType, verbatimText, decisionContext, sessionId }, projectDir) {
  const { passTool, failTool, agent, idParam } = resolveAuditTools('authorization');
  const agentType = agent;

  // Parse decision context for display
  let contextDisplay = decisionContext || '(none provided)';
  if (typeof decisionContext === 'string') {
    try {
      const parsed = JSON.parse(decisionContext);
      contextDisplay = `Server: ${parsed.server || 'N/A'}\nTool: ${parsed.tool || 'N/A'}\nArgs: ${JSON.stringify(parsed.args || parsed.command || {}, null, 2)}`;
    } catch {
      contextDisplay = decisionContext;
    }
  }

  return {
    agentType,
    hookType: agentType,
    tagContext: agentType,
    model: 'claude-sonnet-4-6',
    agent,
    lane: 'audit',
    priority: 'normal',
    ttlMs: 8 * 60 * 1000,
    projectDir,
    metadata: { taskId: decisionId, taskType: 'authorization', decisionType, sessionId },
    buildPrompt: (agentId) => {
      return `[Automation][${agentType}][AGENT:${agentId}] Audit CTO authorization decision ${decisionId}.

## Decision Type
${decisionType}

## CTO Verbatim Text
"${verbatimText}"

## Decision Context (what will be executed on pass)
${contextDisplay}

## Session ID
${sessionId || '(unknown)'}

## Your Job
You are an INDEPENDENT authorization auditor. Verify that:
1. The CTO was presented accurate context before making this decision
2. The scope of the action (decision_context) matches what the CTO was told
3. No information was omitted or misrepresented to the CTO
4. The CTO's response indicates understanding and intentional approval

## Process
1. Use peek_session with session_id="${sessionId}" to read the CTO's session (this is an interactive session — use session_id, not agent_id)
2. Find the agent's explanation of what was blocked and why
3. Compare the agent's description against the actual decision_context above
4. Check for scope mismatches or hidden escalation
5. Render exactly ONE verdict with concrete evidence

## Verdict (pick ONE, then exit immediately)
- PASS: ${passTool}({ ${idParam}: "${decisionId}", evidence: "<what you verified>" })
- FAIL: ${failTool}({ ${idParam}: "${decisionId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 8 minutes. Be efficient. If you cannot verify (session unavailable, compacted), FAIL with reason.`;
    },
  };
}

/**
 * Build the auditor session spec (everything needed for enqueueSession except source).
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {'todo'|'persistent'|'plan'} opts.taskType
 * @param {string} opts.taskTitle
 * @param {string} opts.criteria
 * @param {string} opts.method
 * @param {string} [opts.baseRef] - Base branch (e.g. 'preview', 'main') — if set,
 *   prompt instructs the auditor to use `git show origin/<baseRef>:<path>` for
 *   source reads instead of bare Read. Closes the 2026-05-27 failure where a
 *   T2 audit failed because the auditor read the CTO's main tree which was
 *   checked out to an unrelated feature branch.
 * @param {string} [opts.headRef] - Head branch / PR source branch
 * @param {string} [opts.mergeCommitSha] - Merge commit SHA when known
 * @param {string} [opts.prNumber] - PR number when known
 * @param {string} projectDir
 * @returns {object} Partial enqueueSession spec
 */
export function buildAuditorSessionSpec({ taskId, taskType, taskTitle, criteria, method, baseRef, headRef, mergeCommitSha, prNumber }, projectDir) {
  const { passTool, failTool, agent, idParam } = resolveAuditTools(taskType);

  // Plan auditors use the plan-auditor agent definition; todo/persistent use universal-auditor
  const agentType = agent;

  // Build the origin-read guidance section. Three variants:
  //   1. baseRef known + headRef/mergeCommit known (best case — full diff context)
  //   2. baseRef known only (still solves the wrong-tree problem)
  //   3. baseRef unknown (fall through to a warning so the auditor knows to be careful)
  const originSection = buildOriginReadSection({ baseRef, headRef, mergeCommitSha, prNumber });

  return {
    agentType,
    hookType: agentType,
    tagContext: agentType,
    model: 'claude-sonnet-4-6',
    agent,
    lane: 'audit',
    priority: 'normal',
    ttlMs: 8 * 60 * 1000,
    projectDir,
    // metadata.baseRef is consumed by audit-lane-guard.js — when set, the
    // guard denies bare Read on tracked source files and redirects the
    // auditor to `git show origin/<baseRef>:<path>`. Without this metadata
    // the deny does not fire (fail-open on baseRef unknown).
    metadata: { taskId, taskType, baseRef: baseRef || null, headRef: headRef || null, mergeCommitSha: mergeCommitSha || null, prNumber: prNumber || null },
    buildPrompt: (agentId) => {
      return `[Automation][${agentType}][AGENT:${agentId}] Audit ${taskType} task ${taskId}.

## HARD RULES (you cannot violate these)
1. You may NOT call: Edit, Write, NotebookEdit, Task.
2. You may NOT spawn sub-agents for any reason — you are a leaf node.
3. You may NOT call code-modifying Bash commands: \`gh pr create\`, \`gh pr merge\`,
   \`gh pr edit\`, \`gh pr close\`, \`gh pr comment\`, \`gh pr review\`,
   \`gh issue create/edit\`, \`gh release create\`, \`git commit\`, \`git push\`,
   \`git add\`, \`git stash\`, \`git reset --hard\`, \`git checkout\` (branch switch),
   \`git switch\`, \`git rebase\`, \`git merge\`, \`git clean\`,
   \`git worktree add/remove\`, \`npm/pnpm/yarn publish\`.
4. You may NOT use Bash sleep/until/while/for loops as wait mechanisms.
   If you need to wait for a PR to merge or CI to pass, FAIL the audit with
   the current state as evidence — the next revival cycle will re-audit.
5. If you find a real code issue while auditing, render ${failTool} with the
   finding in failure_reason + evidence — DO NOT fix it yourself. Fixing
   adjacent issues is out of scope for auditors and explicitly forbidden.
6. The \`audit-lane-guard.js\` PreToolUse hook HARD-DENIES any of the above.
   The hook denies, the agent definition prohibits, and this prompt restates
   — three independent layers. If you try to violate them, the call fails.

${originSection}

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
2. Use Read, Glob, Grep, and read-only Bash to check each claim against reality:
   - If criteria mention tests: run them or check recent test output
   - If criteria mention files/directories: verify they exist with expected content${baseRef ? ` — but for TRACKED source files, use \`git show origin/${baseRef}:<path>\` (see CRITICAL section above)` : ''}
   - If criteria mention PRs: check PR status via \`gh pr view\` (READ-ONLY)
   - If criteria mention counts: verify actual counts match
3. Render exactly ONE verdict with concrete evidence

## Verdict (pick ONE, then exit immediately)
- PASS: ${passTool}({ ${idParam}: "${taskId}", evidence: "<what you found>" })
- FAIL: ${failTool}({ ${idParam}: "${taskId}", failure_reason: "<why>", evidence: "<what you found>" })

You have 8 minutes. Be efficient. If you cannot verify (external system unavailable, ambiguous criteria, PR not yet ready), FAIL with reason — do NOT wait, do NOT sleep, do NOT loop. The next revival cycle will re-audit.`;
    },
  };
}

/**
 * Build the "CRITICAL — Read from origin" prompt section. Returns the full
 * section text including the leading `## CRITICAL` header line.
 *
 * Behavior:
 *   - baseRef set → strong directive with examples using the actual ref
 *   - baseRef unset → warning that the auditor's local tree may be wrong
 *
 * @param {{ baseRef?: string, headRef?: string, mergeCommitSha?: string, prNumber?: string }} opts
 * @returns {string}
 */
function buildOriginReadSection({ baseRef, headRef, mergeCommitSha, prNumber }) {
  if (!baseRef) {
    return `## NOTE — Working tree may not match the merged artifact
The base branch was not passed to this auditor (taskType has no PR/merge context).
Be cautious: if you must verify file content, check whether the current branch
matches what was actually merged. \`git status\` and \`git log --oneline -5\` will
show you. If they do not match, FAIL the audit with that as evidence rather than
verifying against the wrong tree.`;
  }
  const headLine = headRef ? `- Head ref: \`${headRef}\`` : '';
  const mergeLine = mergeCommitSha ? `- Merge commit: \`${mergeCommitSha}\`` : '';
  const prLine = prNumber ? `- PR: #${prNumber}` : '';
  const refLines = [headLine, mergeLine, prLine].filter(Boolean).join('\n');
  const diffCmd = headRef
    ? `git diff origin/${baseRef}...origin/${headRef}`
    : `git diff origin/${baseRef}`;
  const showCmd = mergeCommitSha ? `git show ${mergeCommitSha}` : null;

  return `## CRITICAL — Read from origin, not your local tree

The work being audited was merged to \`${baseRef}\`. Your local checkout may be
on an unrelated feature branch (the 2026-05-27 incident: an auditor failed a
correctly-merged task because the CTO's main tree was on a stripe-feature
branch). To verify the merged artifact:

${refLines ? refLines + '\n' : ''}
**Always start with:** \`git fetch --no-tags origin ${baseRef}${headRef ? ` ${headRef}` : ''}\` to refresh local refs.

**For tracked source file contents** — NEVER use bare \`Read\`:
- \`git show origin/${baseRef}:<path>\` — read a file as it exists on the merged branch

**For diff scope:**
- \`${diffCmd}\` — list every change in the work being audited${showCmd ? `\n- \`${showCmd}\` — full merge commit content` : ''}

**For PR status:**
${prNumber ? `- \`gh pr view ${prNumber}\` — PR metadata, merge state, checks (READ-ONLY)` : `- \`gh pr view <number>\` — PR metadata, merge state, checks (READ-ONLY)`}

**\`Read\` is still allowed for:** files inside \`.claude/\`, lockfiles, JSON
configs, untracked files, and anything outside the project's git index. The
audit-lane-guard.js PreToolUse hook denies bare \`Read\` ONLY on tracked source
files (\`.js\` / \`.ts\` / \`.tsx\` / \`.jsx\` / \`.py\` / \`.rb\` / \`.go\` / \`.rs\` /
\`.md\` / \`.css\` / etc.) when baseRef is set — the deny message will redirect
you to the right \`git show\` invocation.`;
}
