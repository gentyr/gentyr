/**
 * Show MCP Server Types
 *
 * Shared types for the show MCP server that renders individual
 * CTO dashboard sections on demand.
 */

import { z } from 'zod';

export const SECTION_IDS = [
  'quota', 'accounts', 'deputy-cto', 'usage', 'automations',
  'testing', 'deployments', 'worktrees', 'infra', 'logging',
  'timeline', 'tasks', 'product-market-fit', 'worklog',
  'plans', 'plan-progress', 'plan-timeline', 'plan-audit', 'plan-sessions',
  'session-queue',
  'persistent-tasks',
  'persistent-task-monitor',
] as const;

export type SectionId = typeof SECTION_IDS[number];

export const ShowSectionArgsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional()
    .describe('Row limit for sections that support it (deployments, timeline). Default varies by section, max 100.'),
});

export type ShowSectionArgs = z.infer<typeof ShowSectionArgsSchema>;

export const SECTION_DESCRIPTIONS: Record<SectionId, string> = {
  quota: 'Show API quota utilization (5-hour and 7-day usage bars)',
  accounts: 'Show account overview with key status, usage, and subscription info',
  'deputy-cto': 'Show deputy-CTO triage pipeline (pending questions, rejections, reports)',
  usage: 'Show usage trends and trajectory projections (line graphs)',
  automations: 'Show running automated agents, token usage by type, and concurrency',
  testing: 'Show test health (pass/fail rates, coverage, Codecov integration)',
  deployments: 'Show recent deployments across Render and Vercel with pipeline status',
  worktrees: 'Show active git worktrees with branch, age, and PR status',
  infra: 'Show infrastructure status (Render, Vercel, Supabase, Elastic, Cloudflare)',
  logging: 'Show log volume, error rates, and top error messages from Elasticsearch',
  timeline: 'Show chronological timeline of recent system events',
  tasks: 'Show task metrics (pending, active, completed) and token usage summary',
  'product-market-fit': 'Show product-market-fit analysis with full section content and persona compliance',
  worklog: 'Show agent worklog entries with durations, tokens, and 30-day rolling metrics',
  plans: 'Show active plans with phase progress bars and ready-to-spawn summary',
  'plan-progress': 'Show detailed plan progress with agent assignments, completions, and ready tasks',
  'plan-timeline': 'Show plan state changes timeline (task completions, agent spawns, dependency unlocks)',
  'plan-audit': 'Show agent work metrics per plan (tasks, completions, PRs, phase efficiency)',
  'plan-sessions': 'Show per-session lifecycle timeline (spawns, rotations, interrupts, revivals, worklogs, PR merges)',
  'session-queue': 'Show session queue status (running, queued, capacity, throughput)',
  'persistent-tasks': 'Show active persistent tasks with progress, monitor health, and amendments',
  'persistent-task-monitor': 'Show deep persistent task monitoring view: task hierarchy, sub-task tree with agent stages, recent events, and amendment details',
};
