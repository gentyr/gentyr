/**
 * Worktree Data Reader
 *
 * Reads git worktree state from the local repository, cross-references
 * with agent-tracker-history.json for running agent status, and determines
 * pipeline stage for each worktree branch.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_DIR = process.env['CLAUDE_PROJECT_DIR'] || process.cwd();

// ============================================================================
// Types
// ============================================================================

export type PipelineStage = 'local' | 'preview' | 'staging' | 'production';

export interface WorktreeEntry {
  branch: string;
  path: string;
  head: string;
  lastCommitAge: string;  // ISO timestamp
  lastCommitMessage: string;
  agent: { type: string; status: string } | null;
  pipelineStage: PipelineStage;
  isSystem: boolean;
  isMerged: boolean;
}

export interface WorktreeData {
  hasData: boolean;
  worktrees: WorktreeEntry[];
  summary: {
    total: number;
    active: number;
    idle: number;
    merged: number;
    system: number;
  };
}

// ============================================================================
// Helpers
// ============================================================================

interface ParsedWorktree {
  path: string;
  head: string;
  branch: string;
}

function parseWorktreeList(output: string): ParsedWorktree[] {
  const blocks = output.split('\n\n').filter(b => b.trim().length > 0);
  const results: ParsedWorktree[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let wtPath = '';
    let head = '';
    let branch = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        // Strip refs/heads/ prefix
        branch = ref.replace('refs/heads/', '');
      }
    }

    // Only include worktrees that live under .claude/worktrees/
    if (wtPath && wtPath.includes('.claude/worktrees/') && branch) {
      results.push({ path: wtPath, head: head.slice(0, 7), branch });
    }
  }

  return results;
}

function getLastCommit(branch: string): { timestamp: string; message: string } {
  try {
    const output = execSync(`git log ${branch} -1 --format="%ct %s"`, {
      encoding: 'utf8',
      timeout: 5000,
      cwd: PROJECT_DIR,
      stdio: 'pipe',
    }).trim();

    const spaceIdx = output.indexOf(' ');
    if (spaceIdx === -1) {
      throw new Error(`Unexpected git log output: ${output}`);
    }

    const unixTs = parseInt(output.slice(0, spaceIdx), 10);
    const message = output.slice(spaceIdx + 1);

    return {
      timestamp: new Date(unixTs * 1000).toISOString(),
      message,
    };
  } catch {
    throw new Error(`Failed to read last commit for branch: ${branch}`);
  }
}

function isAncestorOf(commitSha: string, remoteBranch: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${commitSha} ${remoteBranch}`, {
      encoding: 'utf8',
      timeout: 5000,
      cwd: PROJECT_DIR,
      stdio: 'pipe',
    });
    return true; // exit code 0 = is ancestor
  } catch {
    return false; // non-zero exit = not ancestor
  }
}

function determinePipelineStage(headFull: string): PipelineStage {
  // Need the full SHA for merge-base comparison; headFull here is the abbreviated SHA
  // but git merge-base handles abbreviated SHAs fine
  if (isAncestorOf(headFull, 'origin/main')) return 'production';
  if (isAncestorOf(headFull, 'origin/staging')) return 'staging';
  if (isAncestorOf(headFull, 'origin/preview')) return 'preview';
  return 'local';
}

interface AgentHistoryEntry {
  status?: string;
  pid?: number;
  metadata?: {
    worktreePath?: string;
    agentType?: string;
  };
}

function findRunningAgent(worktreePath: string): { type: string; status: string } | null {
  const historyPath = join(PROJECT_DIR, '.claude', 'agent-tracker-history.json');
  if (!existsSync(historyPath)) return null;

  try {
    const raw = readFileSync(historyPath, 'utf8');
    const history = JSON.parse(raw) as Record<string, AgentHistoryEntry>;

    for (const entry of Object.values(history)) {
      if (
        entry.status === 'running' &&
        entry.metadata?.worktreePath === worktreePath &&
        typeof entry.pid === 'number'
      ) {
        // Verify PID is actually alive
        try {
          process.kill(entry.pid, 0);
          return {
            type: entry.metadata.agentType || 'unknown',
            status: 'running',
          };
        } catch {
          // PID is dead, agent is not actually running
        }
      }
    }
  } catch {
    // Malformed history file — treat as no agents running
  }

  return null;
}

// ============================================================================
// Main
// ============================================================================

export function getWorktreeData(): WorktreeData {
  const emptyResult: WorktreeData = {
    hasData: false,
    worktrees: [],
    summary: { total: 0, active: 0, idle: 0, merged: 0, system: 0 },
  };

  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf8',
      timeout: 5000,
      cwd: PROJECT_DIR,
      stdio: 'pipe',
    });

    const parsed = parseWorktreeList(output);
    if (parsed.length === 0) return emptyResult;

    const worktrees: WorktreeEntry[] = [];

    for (const wt of parsed) {
      const commit = getLastCommit(wt.branch);
      const pipelineStage = determinePipelineStage(wt.head);
      const isSystem = wt.branch.startsWith('automation/');
      const isMerged = pipelineStage !== 'local';
      const agent = findRunningAgent(wt.path);

      worktrees.push({
        branch: wt.branch,
        path: wt.path,
        head: wt.head,
        lastCommitAge: commit.timestamp,
        lastCommitMessage: commit.message,
        agent,
        pipelineStage,
        isSystem,
        isMerged,
      });
    }

    // Compute summary
    let active = 0;
    let idle = 0;
    let merged = 0;
    let system = 0;

    for (const wt of worktrees) {
      if (wt.isSystem) {
        system++;
      } else if (wt.agent !== null) {
        active++;
      } else {
        idle++;
      }
      if (wt.isMerged && !wt.isSystem) {
        merged++;
      }
    }

    return {
      hasData: true,
      worktrees,
      summary: {
        total: worktrees.length,
        active,
        idle,
        merged,
        system,
      },
    };
  } catch {
    return emptyResult;
  }
}
