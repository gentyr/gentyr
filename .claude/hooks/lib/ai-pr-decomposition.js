/**
 * AI PR Decomposition
 *
 * Suggests how to split large PRs into smaller, independently-promotable units.
 * Uses Haiku LLM to group commits by feature/concern.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import { callLLMStructured } from './llm-client.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** Threshold above which a PR is considered "large" and needs splitting. */
const LARGE_PR_THRESHOLD = 3000;

/**
 * JSON schema for the LLM decomposition response.
 */
const DECOMPOSITION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short descriptive name for this group (e.g. "Auth refactor", "API endpoint additions")',
          },
          commits: {
            type: 'array',
            items: { type: 'string' },
            description: 'Commit SHAs belonging to this group',
          },
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files touched by this group',
          },
          safe_to_promote: {
            type: 'boolean',
            description: 'Whether this group can be promoted independently without the other groups',
          },
          rationale: {
            type: 'string',
            description: 'Why this grouping makes sense and whether it has dependencies on other groups',
          },
        },
        required: ['name', 'commits', 'files', 'safe_to_promote'],
      },
    },
  },
  required: ['groups'],
});

const SYSTEM_PROMPT = `You are a PR decomposition assistant. You will be given a list of commits with their SHAs, messages, and changed files.

Your job:
- Group commits into logical feature/concern units that could each be a separate PR
- Each group should be a cohesive change (all related files and commits together)
- Mark each group as safe_to_promote=true if it can land independently, false if it depends on another group
- Common groupings: feature work, refactoring, tests, config changes, documentation
- Prefer fewer, larger groups over many tiny ones (2-5 groups is ideal)
- Every commit must appear in exactly one group

If all commits are tightly coupled and cannot be split, return a single group with all commits and safe_to_promote=true.`;

/**
 * Get the total lines changed between two branches.
 *
 * @param {string} baseBranch
 * @param {string} headBranch
 * @param {string} projectDir
 * @returns {number} Total lines added + deleted
 */
function getTotalLinesChanged(baseBranch, headBranch, projectDir) {
  try {
    const stats = execSync(
      `git diff --stat ${baseBranch}..${headBranch}`,
      { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    ).trim();

    // Last line of --stat looks like: "42 files changed, 1234 insertions(+), 567 deletions(-)"
    const match = stats.match(/(\d+)\s+insertions?.*?(\d+)\s+deletions?/);
    if (!match) return 0;

    return parseInt(match[1], 10) + parseInt(match[2], 10);
  } catch {
    return 0;
  }
}

/**
 * Get commits with their changed files between two branches.
 *
 * @param {string} baseBranch
 * @param {string} headBranch
 * @param {string} projectDir
 * @returns {Array<{ sha: string, message: string, files: string[] }>}
 */
function getCommitsWithFiles(baseBranch, headBranch, projectDir) {
  try {
    // Use a delimiter to separate commits since messages can be multi-line
    const raw = execSync(
      `git log --format="COMMIT_START %H %s" --name-only ${baseBranch}..${headBranch}`,
      { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    ).trim();

    if (!raw) return [];

    const commits = [];
    let current = null;

    for (const line of raw.split('\n')) {
      if (line.startsWith('COMMIT_START ')) {
        if (current) commits.push(current);
        const rest = line.slice('COMMIT_START '.length);
        const spaceIdx = rest.indexOf(' ');
        current = {
          sha: rest.slice(0, spaceIdx),
          message: rest.slice(spaceIdx + 1),
          files: [],
        };
      } else if (current && line.trim()) {
        current.files.push(line.trim());
      }
    }

    if (current) commits.push(current);
    return commits;
  } catch {
    return [];
  }
}

/**
 * Suggest how to decompose a large PR into smaller, independently-promotable units.
 *
 * @param {string} baseBranch - Base branch (e.g. "origin/main")
 * @param {string} headBranch - Head branch (e.g. "origin/preview")
 * @param {string} [projectDir] - Project root directory
 * @returns {Promise<{ needsSplit: boolean, totalLines?: number, groups?: Array<{ name: string, commits: string[], files: string[], safe_to_promote: boolean, rationale?: string }> } | null>}
 *   Returns the decomposition suggestion, or null if the LLM call fails.
 */
export async function suggestDecomposition(baseBranch, headBranch, projectDir = PROJECT_DIR) {
  // 1. Check total size
  const totalLines = getTotalLinesChanged(baseBranch, headBranch, projectDir);

  if (totalLines < LARGE_PR_THRESHOLD) {
    return { needsSplit: false, totalLines };
  }

  // 2. Get commits with files
  const commits = getCommitsWithFiles(baseBranch, headBranch, projectDir);

  if (commits.length === 0) {
    return { needsSplit: false, totalLines };
  }

  // If there's only 1 commit, it can't be split
  if (commits.length === 1) {
    return {
      needsSplit: false,
      totalLines,
      groups: [{
        name: 'Single commit',
        commits: [commits[0].sha],
        files: commits[0].files,
        safe_to_promote: true,
      }],
    };
  }

  // 3. Build the LLM prompt
  const commitList = commits.map(c => {
    const filesStr = c.files.length > 0 ? `\n  Files: ${c.files.join(', ')}` : '';
    return `- ${c.sha.slice(0, 8)} ${c.message}${filesStr}`;
  }).join('\n');

  const prompt = [
    `## PR Decomposition Analysis`,
    ``,
    `Total lines changed: ${totalLines}`,
    `Total commits: ${commits.length}`,
    ``,
    `## Commits`,
    ``,
    commitList,
  ].join('\n');

  // 4. Call LLM for grouping
  const result = await callLLMStructured(prompt, SYSTEM_PROMPT, DECOMPOSITION_SCHEMA, {
    timeout: 45000,
  });

  if (!result || !Array.isArray(result.groups)) return null;

  // Validate groups: ensure every returned commit SHA is a real commit
  const validShas = new Set(commits.map(c => c.sha));
  const shortToFull = new Map(commits.map(c => [c.sha.slice(0, 8), c.sha]));

  for (const group of result.groups) {
    if (!Array.isArray(group.commits)) group.commits = [];
    if (!Array.isArray(group.files)) group.files = [];

    // Normalize short SHAs to full SHAs and filter out hallucinated ones
    group.commits = group.commits
      .map(sha => {
        if (validShas.has(sha)) return sha;
        const full = shortToFull.get(sha.slice(0, 8));
        return full || null;
      })
      .filter(Boolean);
  }

  // Remove empty groups
  const validGroups = result.groups.filter(g => g.commits.length > 0);

  if (validGroups.length === 0) return null;

  return {
    needsSplit: true,
    totalLines,
    groups: validGroups,
  };
}
