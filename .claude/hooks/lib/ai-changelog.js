/**
 * AI Changelog Generator
 *
 * Uses LLM (Haiku) to generate developer-facing and user-facing changelogs
 * from commit messages and diffs.
 *
 * @version 1.0.0
 */

/**
 * Generate changelogs from commit messages.
 * Falls back to structured grouping if LLM is unavailable.
 *
 * @param {string[]} commits - Array of "sha message" strings from git log --oneline
 * @param {string} [projectDir] - Project directory (unused, reserved for future expansion)
 * @returns {Promise<{ developer_changelog: string, user_changelog: string }>}
 */
export async function generateChangelogs(commits, projectDir) {
  // Try LLM-powered changelog
  try {
    const { callLLMStructured } = await import('./llm-client.js');

    const schema = {
      type: 'object',
      properties: {
        developer_changelog: { type: 'string', description: 'Technical changelog for developers' },
        user_changelog: { type: 'string', description: 'User-facing changelog in plain language' },
      },
      required: ['developer_changelog', 'user_changelog'],
    };

    const result = await callLLMStructured(
      `Generate two changelogs from these commits:\n\n${commits.join('\n')}`,
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
