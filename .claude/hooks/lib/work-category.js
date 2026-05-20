/**
 * Work-category derivation for the token-usage attribution model.
 *
 * The legacy `source` field captured the spawner code path (e.g.
 * `session-queue-reaper`, `revival-utils`, `drain-audit-orphan-recovery`).
 * When a session crashes and gets revived, the new queue item is tagged with
 * the revival code path — so revived persistent monitors looked like they
 * belonged to `session-queue-reaper`, hiding the actual category of work.
 *
 * This module derives a STABLE work category from `agent_type` (+ metadata)
 * that survives revival. Revival itself is captured as a separate orthogonal
 * dimension (`is_revival`, `revived_by`, `revival_count`).
 *
 * @module lib/work-category
 */

/**
 * Spawner source strings that indicate a session is a revival (resurrection
 * of a crashed/stuck/paused session) rather than fresh original work.
 *
 * Keep in sync with the 9+ revival enqueue call sites in `session-queue.js`,
 * `session-reviver.js`, `revival-utils.js`, `hourly-automation.js`,
 * `deputy-resolution-executor.js`, and `agent-tracker/server.ts`.
 */
export const REVIVAL_SOURCES = new Set([
  // Direct revival call sites
  'session-queue-reaper',                    // requeueDeadPersistentMonitor
  'session-reviver',                         // session-reviver.js
  'revival-utils',                           // lib/revival-utils.js fallback source
  'session-reaper-audit-revival',            // Step 1b.5 audit revival
  'drain-audit-orphan-recovery',             // drainQueue Step 1c audit orphan
  'preemption',                              // legacy destructive preemption
  'sync-recycle',                            // npx gentyr sync step 10
  'deputy-bypass-resolve-audited',           // deputy-resolution-executor
  'bypass-request-resolve',                  // agent-tracker bypass approval
  'timed-pause-auto-resume',                 // hourly-automation timed pause
  'rate-limit-cooldown-recovery',            // hourly-automation rate-limit recovery
  // hourly-automation revival blocks (currentSource() format)
  'hourly-automation:revive_dead_persistent_monitor',
  'hourly-automation:persistent_stale_pause_resume',
  'hourly-automation:rate-limit-cooldown-recovery',
  'hourly-automation:idle_check',
  'hourly-automation:plan_orphan_revive',
  'hourly-automation:timed_pause_auto_resume',
  'hourly-automation:global_monitor_health',
  'hourly-automation:global_monitor_idle_check',
]);

/**
 * Map a spawner source string to a normalized revival mechanism name.
 * Used to populate `revived_by` so downstream queries can group by
 * revival mechanism without parsing the source string each time.
 */
export function normalizeRevivalSource(source) {
  if (!source) return null;
  if (source.startsWith('hourly-automation:')) return source.slice('hourly-automation:'.length);
  return source;
}

/**
 * Categorize a session into a stable work-category bucket.
 *
 * Inputs:
 *   - agentType: the queue_items.agent_type field (or null)
 *   - source: the queue_items.source field (or null) — used as fallback for
 *     categories not derivable from agent_type alone
 *   - sessionId: the raw Claude session id (for compaction detection)
 *   - isSubagent: whether the session is under `subagents/` of a parent
 *   - metadata: parsed queue_items.metadata object (or null) — may carry
 *     `isPlanManager`, `taskType: 'global_monitor'`, etc.
 *
 * Returns one of:
 *   plan-manager, persistent-monitor, global-monitor, universal-auditor,
 *   plan-auditor, authorization-auditor, task-runner, demo-manager,
 *   preview-promoter, pr-reviewer, staging-reviewer, security-auditor,
 *   feedback-agent, gate-agent, antipattern-hunter, compliance-checker,
 *   deputy-cto, health-monitor, lint-fixer, claudemd-refactor,
 *   federation-mapper, hotfix-promotion, test-fixer, todo-maintenance,
 *   compaction-subagent, agent-tool-subagent, interactive-cto,
 *   subprocess-llm, or `other`.
 *
 * Granularity for `agent-tool-subagent` (user-alignment, investigator, ...)
 * is preserved in `agent_type` — pivot with `GROUP BY agent_type` to see
 * each subagent type.
 */
export function deriveWorkCategory({
  agentType = null,
  source = null,
  sessionId = null,
  isSubagent = false,
  metadata = null,
} = {}) {
  // Compaction subprocess detection (no meta.json — labeled in PR A)
  if (typeof sessionId === 'string' && sessionId.startsWith('agent-acompact-')) {
    return 'compaction-subagent';
  }
  if (isSubagent) {
    // Granularity lives in agent_type for Agent-tool subagents.
    return 'agent-tool-subagent';
  }

  // Plan-manager: a persistent-task-monitor flagged as plan manager via
  // metadata. Same model+agent definition as persistent-monitor but a
  // distinct category for cost analysis.
  const isPlanManager = !!(metadata && (metadata.isPlanManager === true || metadata.planManager === true || (metadata.taskType === 'plan' && metadata.planId)));
  // Global deputy-CTO monitor: persistent-task-monitor with taskType: 'global_monitor'.
  const isGlobalMonitor = !!(metadata && (metadata.taskType === 'global_monitor' || metadata.globalMonitor === true));

  // Normalize agent_type comparisons (some spawners use UPPER_SNAKE constants,
  // others use the kebab agent-definition name).
  const at = typeof agentType === 'string' ? agentType.toLowerCase() : '';

  // Persistent-task-monitor family
  if (at === 'persistent-task-monitor' || at === 'persistent_task_monitor') {
    if (isGlobalMonitor) return 'global-monitor';
    if (isPlanManager) return 'plan-manager';
    return 'persistent-monitor';
  }

  // Auditors
  if (at === 'universal-auditor' || at === 'universal_auditor') return 'universal-auditor';
  if (at === 'plan-auditor' || at === 'plan_auditor') return 'plan-auditor';
  if (at === 'authorization-auditor' || at === 'authorization_auditor') return 'authorization-auditor';

  // Gate agent (Haiku review of pending_review tasks + AI PR reviewer)
  if (at === 'task_gate' || at === 'task-gate') return 'gate-agent';
  if (at === 'ai_pr_reviewer' || at === 'ai-pr-reviewer') return 'pr-reviewer';

  // Demo
  if (at === 'task_runner_demo_manager' || at === 'demo-manager' || at === 'demo_repair' || at === 'demo_validator') return 'demo-manager';

  // Project-manager rescue (abandoned-worktree spawn)
  if (at === 'task_runner_project_manager') return 'task-runner'; // rolled into task-runner — same lifecycle

  // Promotion pipeline
  if (at === 'preview-promoter' || at === 'preview_promoter') return 'preview-promoter';
  if (at === 'hotfix_promotion' || at === 'hotfix-promotion') return 'hotfix-promotion';

  // Reviewer/auditor sub-categories
  if (at === 'staging-reactive-reviewer' || at === 'staging_reactive_reviewer' || at === 'staging-reviewer') return 'staging-reviewer';
  if (at === 'security-auditor' || at === 'security_auditor') return 'security-auditor';
  if (at === 'antipattern_hunter_repo' || at === 'antipattern_hunter_commit' || at === 'standalone_antipattern_hunter' || at === 'antipattern-hunter') return 'antipattern-hunter';
  if (at === 'compliance_global' || at === 'standalone_compliance_checker' || at === 'compliance-checker') return 'compliance-checker';

  // Deputy-CTO / triage
  if (at === 'deputy_cto_review' || at === 'deputy-cto-triage' || at === 'deputy-cto') return 'deputy-cto';

  // Health monitoring
  if (at === 'production_health_monitor' || at === 'staging_health_monitor') return 'health-monitor';

  // Maintenance
  if (at === 'lint_fixer' || at === 'lint-fixer') return 'lint-fixer';
  if (at === 'claudemd_refactor' || at === 'claudemd-refactor') return 'claudemd-refactor';
  if (at === 'todo_processing' || at === 'todo-maintenance') return 'todo-maintenance';
  if (at === 'federation_mapper' || at === 'federation-mapper') return 'federation-mapper';

  // Test fixers
  if (at === 'test_failure_jest' || at === 'test_failure_playwright' || at === 'test_failure_vitest' || at === 'test-fixer') return 'test-fixer';

  // Feedback persona agents
  if (at === 'feedback_orchestrator' || at === 'feedback-agent' || at === 'feedback-orchestrator') return 'feedback-agent';

  // Workstream coordinator
  if (at === 'task_runner_workstream_manager') return 'task-runner';

  // Generic task-runner (TASK_RUNNER_* family, code-writer, etc.)
  if (at.startsWith('task_runner_') || at.startsWith('task-runner-') || at === 'task-runner' || at === 'task_runner') return 'task-runner';
  if (at === 'session_revived' || at === 'session-revived') return 'task-runner'; // resumed work — still task-runner

  // Source-based fallback: when the queue row's agent_type wasn't set but the
  // spawner name is recognizable.
  if (typeof source === 'string') {
    if (source === 'antipattern-hunter-hook') return 'antipattern-hunter';
    if (source === 'ai-pr-review-hook') return 'pr-reviewer';
    if (source === 'compliance-checker') return 'compliance-checker';
    if (source === 'schema-mapper-hook') return 'federation-mapper';
    if (source === 'task-gate-spawner') return 'gate-agent';
    if (source === 'universal-audit-spawner') return 'universal-auditor';
    if (source === 'plan-audit-spawner' || source === 'plan-persistent-sync') return 'plan-auditor';
    if (source === 'authorization-audit-spawner') return 'authorization-auditor';
    if (source === 'demo-failure-spawner') return 'demo-manager';
    if (source === 'persistent-task-spawner') return isPlanManager ? 'plan-manager' : 'persistent-monitor';
    if (source === 'plan-activation-spawner') return 'plan-manager';
    if (source && source.startsWith('subprocess:')) return 'subprocess-llm';
  }

  // Subprocess tag (broadcaster, live-feed daemon, llm-client) routes here.
  if (typeof source === 'string' && source.startsWith('subprocess:')) return 'subprocess-llm';

  return null; // caller can decide whether to use 'interactive-cto' or 'other'
}

/**
 * One-line human-readable description for each work_category bucket.
 * Used in the `/tokens` report header so the CTO doesn't have to remember
 * what each label means.
 */
export const WORK_CATEGORY_DESCRIPTIONS = Object.freeze({
  'plan-manager':           'Plan orchestrators (one persistent monitor per active plan)',
  'persistent-monitor':     'Long-running orchestrators for persistent tasks',
  'global-monitor':         'Always-on deputy-CTO alignment monitor',
  'universal-auditor':      'Independent task-completion verifier (audit lane)',
  'plan-auditor':           'Plan-task verification auditor (audit lane)',
  'authorization-auditor':  'CTO-authorization decision verifier (audit lane)',
  'task-runner':            'Standard work agents (code-writer, test-writer, etc.)',
  'demo-manager':           'Demo lifecycle, repair, and validation',
  'preview-promoter':       'Preview→staging promotion pipeline',
  'hotfix-promotion':       'Emergency hotfix promotion (staging→main)',
  'pr-reviewer':            'AI PR review on submission (gate lane)',
  'staging-reviewer':       'Reactive review of new staging commits',
  'security-auditor':       'OWASP code security review (weekly)',
  'feedback-agent':         'Persona-based product testing',
  'gate-agent':             'Haiku task-gate review (gate lane)',
  'antipattern-hunter':     'G001–G019 antipattern detection',
  'compliance-checker':     'Spec compliance checks',
  'deputy-cto':             'Report triage and delegation',
  'health-monitor':         'Production/staging health monitors',
  'lint-fixer':             'Automated lint repair',
  'claudemd-refactor':      'CLAUDE.md refactor agent',
  'federation-mapper':      'Federation schema mapper',
  'test-fixer':             'Test failure repair (Jest/Vitest/Playwright)',
  'todo-maintenance':       'TODO item processing',
  'compaction-subagent':    '/compact sub-process (Claude Code auto-compaction)',
  'agent-tool-subagent':    'Task tool sub-agents (user-alignment, investigator, code-writer, code-reviewer, test-writer, ...)',
  'interactive-cto':        'CTO interactive sessions',
  'subprocess-llm':         'Hook/daemon LLM subprocesses (broadcaster, live-feed, ...)',
  'other':                  'Unclassified sessions',
});

/**
 * Convenience: returns `true` when the source indicates the queue item is
 * a revival path rather than original work.
 */
export function isRevivalSource(source) {
  if (!source) return false;
  if (REVIVAL_SOURCES.has(source)) return true;
  // Catch hourly-automation:<revival-block> variants that may appear with
  // additional suffixes in the future.
  if (source.startsWith('hourly-automation:') && (
    source.includes('revive') ||
    source.includes('resume') ||
    source.includes('orphan') ||
    source.includes('cooldown-recovery') ||
    source.includes('global_monitor')
  )) {
    return true;
  }
  return false;
}
