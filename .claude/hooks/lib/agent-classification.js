/**
 * Agent classification helpers.
 *
 * Single source of truth for "which agents write code and therefore MUST
 * run inside a worktree". Used by `urgent-task-spawner.js` and any future
 * spawner that needs to refuse-instead-of-fallback when worktree
 * provisioning fails for a code-modifying agent.
 *
 * Read-only investigation / orchestration agents are NOT in this set —
 * they may legitimately run in PROJECT_DIR.
 */

export const CODE_MODIFYING_AGENTS = new Set([
  'code-writer',
  'code-reviewer',
  'test-writer',
  'demo-manager',
  'project-manager',
  'preview-promoter',
  'hotfix-promotion',
  'lint-fixer',
  'test-fixer',
]);

/**
 * Returns true if the named agent edits files. Defaults to TRUE for
 * unknown agent names (fail-closed — better to refuse a fallback for an
 * unrecognized agent than to silently pollute the main tree).
 *
 * @param {string|null|undefined} agentName
 * @returns {boolean}
 */
export function isCodeModifyingAgent(agentName) {
  if (!agentName || typeof agentName !== 'string') return true;
  if (CODE_MODIFYING_AGENTS.has(agentName)) return true;

  // Known read-only / orchestration agents — explicit allow-list.
  const READ_ONLY_AGENTS = new Set([
    'investigator',
    'deputy-cto',
    'user-alignment',
    'plan-manager',
    'plan-updater',
    'plan-auditor',
    'universal-auditor',
    'authorization-auditor',
    'persistent-monitor',
    'product-manager',
    'gate-agent',
    'staging-reviewer',
    'pr-reviewer',
    'antipattern-hunter',
    'compliance-checker',
    'health-monitor',
    'security-auditor',
    'workstream-manager',
    'feedback-agent',
    'icon-finder',
  ]);
  if (READ_ONLY_AGENTS.has(agentName)) return false;

  // Unknown — fail-closed.
  return true;
}
