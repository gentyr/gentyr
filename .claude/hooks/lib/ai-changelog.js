/**
 * AI Changelog Generator
 *
 * Uses LLM (Haiku) to generate developer-facing and user-facing changelogs
 * from commit messages and diffs.
 *
 * @version 1.1.0
 */

import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Generate changelogs from git history between two branches.
 *
 * @param {string} baseBranch - Base branch (e.g. "origin/main")
 * @param {string} headBranch - Head branch (e.g. "origin/preview")
 * @param {string} [projectDir] - Project root directory
 * @returns {Promise<{ developer: string, userFacing: string }>}
 */
export async function generateChangelog(baseBranch, headBranch, projectDir = PROJECT_DIR) {
  // 1. Get commit list
  let commitLines = [];
  try {
    const raw = execSync(
      `git log ${baseBranch}..${headBranch} --oneline`,
      { cwd: projectDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();
    commitLines = raw ? raw.split('\n').filter(Boolean) : [];
  } catch {
    return { developer: 'Unable to read git log.', userFacing: 'No changes detected.' };
  }

  if (commitLines.length === 0) {
    return { developer: 'No commits between branches.', userFacing: 'No changes.' };
  }

  // 2. Get PR titles if available
  let prTitles = [];
  try {
    const prRaw = execSync(
      `gh pr list --state merged --base ${baseBranch.replace('origin/', '')} --json title --limit 20`,
      { cwd: projectDir, encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    ).trim();
    const prs = JSON.parse(prRaw || '[]');
    prTitles = prs.map(pr => pr.title).filter(Boolean);
  } catch {
    // gh CLI not available or no PRs — continue without PR context
  }

  // 3. Use the shared implementation
  const prSection = prTitles.length > 0
    ? `\n\n## Merged PR Titles\n\n${prTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const result = await generateChangelogs(commitLines, projectDir, prSection);

  return {
    developer: result.developer_changelog,
    userFacing: result.user_changelog,
  };
}

/**
 * Generate changelogs from pre-parsed commit messages.
 * Falls back to structured grouping if LLM is unavailable.
 *
 * @param {string[]} commits - Array of "sha message" strings from git log --oneline
 * @param {string} [projectDir] - Project directory (unused, reserved for future expansion)
 * @param {string} [extraContext] - Additional context to append to the LLM prompt (e.g. PR titles)
 * @returns {Promise<{ developer_changelog: string, user_changelog: string }>}
 */
export async function generateChangelogs(commits, projectDir, extraContext = '') {
  // Try LLM-powered changelog
  try {
    const { callLLMStructured } = await import('./llm-client.js');

    const schema = JSON.stringify({
      type: 'object',
      properties: {
        developer_changelog: { type: 'string', description: 'Technical changelog for developers' },
        user_changelog: { type: 'string', description: 'User-facing changelog in plain language' },
      },
      required: ['developer_changelog', 'user_changelog'],
    });

    const result = await callLLMStructured(
      `Generate two changelogs from these commits:\n\n${commits.join('\n')}${extraContext}`,
      `You generate changelogs. Developer changelog: technical, bullet points, mention specific files/APIs changed. User changelog: plain language, focus on what users will notice (new features, bug fixes, performance improvements). Keep each under 10 bullet points. Use markdown bullet lists.`,
      schema,
      { timeout: 30000 }
    );

    if (result) return result;
  } catch { /* LLM unavailable */ }

  // Fallback: structured grouping by conventional commit prefix
  const groups = { features: [], fixes: [], other: [] };
  for (const commit of commits) {
    const msg = commit.replace(/^[a-f0-9]+\s+/, '');
    if (/^feat/i.test(msg)) groups.features.push(msg);
    else if (/^fix/i.test(msg)) groups.fixes.push(msg);
    else groups.other.push(msg);
  }

  const devLines = [];
  if (groups.features.length) devLines.push('### Features', ...groups.features.map(m => `- ${m}`));
  if (groups.fixes.length) devLines.push('### Fixes', ...groups.fixes.map(m => `- ${m}`));
  if (groups.other.length) devLines.push('### Other', ...groups.other.map(m => `- ${m}`));

  return {
    developer_changelog: devLines.join('\n') || 'No changes.',
    user_changelog: `${groups.features.length} new feature(s), ${groups.fixes.length} bug fix(es).`,
  };
}
