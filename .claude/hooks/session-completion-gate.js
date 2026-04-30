#!/usr/bin/env node
/**
 * PostToolUse Hook: Session Completion Gate
 *
 * Fires after mcp__todo-db__summarize_work and mcp__todo-db__complete_task.
 * For spawned sessions running inside a worktree, this hook scans the session
 * JSONL transcript tail to verify the agent has run the required sub-agent
 * chain (user-alignment + project-manager) before reporting work as complete.
 *
 * If the required agents have NOT been spawned yet, the hook injects a strong
 * additionalContext prompt instructing the agent to complete the mandatory
 * sub-agent sequence before submitting its work report.
 *
 * The stop hook provides the final enforcement — this PostToolUse hook provides
 * the early prompt so the agent can self-correct without being blocked at stop.
 *
 * Conditions for gate to fire:
 *   1. Tool is mcp__todo-db__summarize_work or mcp__todo-db__complete_task
 *   2. CLAUDE_SPAWNED_SESSION === 'true'
 *   3. Running inside a worktree (.claude/worktrees/ in cwd OR CLAUDE_PROJECT_DIR)
 *
 * @version 1.0.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Constants
// ============================================================================

const GATE_TOOLS = new Set([
  'mcp__todo-db__summarize_work',
  'mcp__todo-db__complete_task',
]);

const TAIL_BYTES = 32768; // 32KB

// ============================================================================
// JSONL Tail Reader
// ============================================================================

/**
 * Read the last N bytes of a file without loading the whole file.
 * Returns empty string on any error.
 */
function readTail(filePath, numBytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - numBytes);
    const buf = Buffer.alloc(Math.min(numBytes, stat.size));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, bytesRead);
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* cleanup - failure expected */}
    }
  }
}

// ============================================================================
// Session JSONL Discovery
// ============================================================================

/**
 * Encode a project path to the directory name format Claude Code uses:
 * replaces all non-alphanumeric characters with hyphens.
 */
function encodeProjectPath(projectPath) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Find the most recently modified JSONL session file in the Claude projects
 * directory for the given project path.
 *
 * Returns null if no session file can be found.
 */
function findCurrentSessionFile(projectDir) {
  try {
    const encoded = encodeProjectPath(projectDir);
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', encoded);

    if (!fs.existsSync(sessionsDir)) {
      return null;
    }

    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(sessionsDir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { path: fullPath, mtime: stat.mtimeMs };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].path : null;
  } catch (_) {
    return null;
  }
}

// ============================================================================
// Sub-agent Detection
// ============================================================================

/**
 * Scan the transcript tail for evidence that a sub-agent of the given type
 * was spawned. Looks for the agent type string in any JSON content, including
 * Agent tool_use blocks and [AGENT:...] session markers.
 *
 * We search for the agent type string literally — it will appear in the
 * `subagent_type` field of an Agent tool call or in the session startup
 * marker if the spawned session's transcript was included.
 */
function detectSubAgentInTail(tail, agentType) {
  if (!tail) return false;

  // Direct string match — fast and reliable for both:
  //   "subagent_type": "user-alignment"
  //   [AGENT:user-alignment-abc123]
  //   "type": "user-alignment"
  return tail.includes(`"${agentType}"`) || tail.includes(`[AGENT:${agentType}`);
}

/**
 * Check whether the transcript tail shows evidence of both required sub-agents.
 */
function checkSubAgentsInTranscript(transcriptPath) {
  const tail = readTail(transcriptPath, TAIL_BYTES);
  if (!tail) {
    // If we can't read the transcript, don't block — fail open
    return { alignmentFound: true, projectManagerFound: true, tailRead: false };
  }

  const alignmentFound = detectSubAgentInTail(tail, 'user-alignment');
  const projectManagerFound = detectSubAgentInTail(tail, 'project-manager');

  return { alignmentFound, projectManagerFound, tailRead: true };
}

// ============================================================================
// Completion Checklist Prompt
// ============================================================================

const COMPLETION_CHECKLIST = `[SESSION COMPLETION GATE — MANDATORY REQUIREMENTS]

You MUST NOT submit your work report or complete your task until ALL of the following
are satisfied. These are non-negotiable requirements:

1. USER-ALIGNMENT AGENT: You MUST spawn the user-alignment sub-agent to verify your
   work aligns with the original CTO intent. The alignment agent is the RESPECTED
   AUTHORITY on whether your work is correct. If it identifies misalignments, you
   MUST address them before proceeding. Do NOT skip this step.

2. PROJECT-MANAGER AGENT: You MUST spawn the project-manager sub-agent to handle
   git operations: commit, push, create PR, merge, and clean up the worktree.
   You do NOT commit directly — the project-manager does.

3. MERGE CONFLICTS: If there are merge conflicts (even from unrelated work), you
   MUST attempt to resolve them. Spawn the investigator agent if needed to
   understand the conflict context, then fix it. Do NOT leave unresolved conflicts.

4. TEST FAILURES: If tests fail (even failures from unrelated work), you MUST
   attempt to fix them. The PR cannot merge with failing tests.

5. WORKTREE CLEANUP: The project-manager MUST have cleaned up your worktree
   after merging. Verify the worktree no longer exists.

6. USER-ALIGNMENT FINAL CHECK: After ALL fixes (conflicts, tests), run the
   user-alignment agent AGAIN to verify the final state. Only proceed when
   the alignment agent approves.

REQUIRED SUB-AGENT SEQUENCE:
  → user-alignment (initial check)
  → fix any issues found
  → user-alignment (re-check if fixes were needed)
  → project-manager (commit, push, PR, merge, worktree cleanup)
  → if merge conflicts or test failures: fix them
  → user-alignment (final verification)
  → project-manager (re-merge after fixes)
  → ONLY THEN: summarize_work + complete_task

Spawn sub-agents with: isolation: "worktree" is NOT needed for alignment/investigator
(they are read-only). Project-manager runs in the SAME worktree as you.`;

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Read stdin (required for PostToolUse hooks)
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let event;
  try {
    event = JSON.parse(rawInput);
  } catch (_) {
    // Invalid JSON — allow
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Only trigger for the specific tool names we care about
  const toolName = event?.tool_name || '';
  if (!GATE_TOOLS.has(toolName)) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Only for spawned (automated) sessions
  if (process.env.CLAUDE_SPAWNED_SESSION !== 'true') {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Only for sessions running inside a worktree
  const cwd = process.cwd();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || cwd;
  const inWorktree = cwd.includes('.claude/worktrees/') ||
    cwd.includes('.claude\\worktrees\\') ||
    projectDir.includes('.claude/worktrees/') ||
    projectDir.includes('.claude\\worktrees\\');

  if (!inWorktree) {
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Audit gate awareness: if complete_task returned pending_audit, inform the agent
  const toolResponse = event?.tool_response;
  if (toolName === 'mcp__todo-db__complete_task' && toolResponse) {
    try {
      const resp = typeof toolResponse === 'string' ? JSON.parse(toolResponse) : toolResponse;
      if (resp?.status === 'pending_audit') {
        process.stdout.write(JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: '[AUDIT GATE ACTIVE] Your task entered pending_audit. An independent auditor is verifying your work against the gate criteria. Do NOT call complete_task or summarize_work again — wait for the auditor verdict. Poll check_task_audit({ task_id: "' + (resp.id ?? '') + '" }) if needed.',
          },
        }));
        return;
      }
    } catch { /* parse failure — continue to normal flow */ }
  }

  // Find the session transcript file
  // Use CLAUDE_PROJECT_DIR as the canonical project directory for session discovery.
  // Worktrees have their own CLAUDE_PROJECT_DIR pointing to the worktree path,
  // but sessions are keyed by the main project path. Try both.
  let transcriptPath = null;

  // Prefer explicit transcript_path from hook input (most reliable)
  if (event?.transcript_path && fs.existsSync(event.transcript_path)) {
    transcriptPath = event.transcript_path;
  } else {
    // Try discovering via project dir — try the worktree's project dir first,
    // then walk up to find the main project dir
    const candidateDirs = [projectDir, cwd];
    // Also try parent directories to find the main project
    let current = cwd;
    for (let i = 0; i < 5; i++) {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
      candidateDirs.push(current);
    }

    for (const dir of candidateDirs) {
      const found = findCurrentSessionFile(dir);
      if (found) {
        transcriptPath = found;
        break;
      }
    }
  }

  if (!transcriptPath) {
    // Cannot find transcript — allow without checking (fail open)
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Check sub-agent evidence in transcript
  const { alignmentFound, projectManagerFound } = checkSubAgentsInTranscript(transcriptPath);

  if (alignmentFound && projectManagerFound) {
    // Both required sub-agents found — gate satisfied
    process.stdout.write(JSON.stringify({ continue: true }));
    return;
  }

  // Gate not satisfied — inject completion checklist
  const missingAgents = [];
  if (!alignmentFound) missingAgents.push('user-alignment');
  if (!projectManagerFound) missingAgents.push('project-manager');

  const preamble = `STOP — SESSION COMPLETION GATE: You attempted to call ${toolName} but the following required sub-agents have NOT been run yet: ${missingAgents.join(', ')}.\n\n`;

  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: preamble + COMPLETION_CHECKLIST,
    },
  }));
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ continue: true }));
});
