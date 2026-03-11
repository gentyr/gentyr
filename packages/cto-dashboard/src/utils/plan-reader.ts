/**
 * Plan reader — reads plan data from .claude/state/plans.db
 */

import * as fs from 'fs';
import * as path from 'path';
import { openReadonlyDb } from './readonly-db.js';

// ============================================================================
// Public interfaces
// ============================================================================

export interface PlanPhaseInfo {
  id: string;
  title: string;
  phase_order: number;
  status: string;
  progress_pct: number;
  task_count: number;
  completed_tasks: number;
}

export interface PlanTaskInfo {
  id: string;
  title: string;
  status: string;
  agent_type: string | null;
  pr_number: number | null;
  pr_merged: boolean;
  progress_pct: number;
  substeps: PlanSubstepInfo[];
}

export interface PlanSubstepInfo {
  id: string;
  title: string;
  completed: boolean;
}

export interface PlanInfo {
  id: string;
  title: string;
  status: string;
  progress_pct: number;
  phase_count: number;
  task_count: number;
  completed_tasks: number;
  ready_tasks: number;
  active_tasks: number;
  current_phase: string | null;
  phases: PlanPhaseInfo[];
  updated_at: string | null;
}

export interface PlanTimelineEntry {
  time: string;
  entity_type: string;
  label: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
}

export interface PlanAgentMetric {
  agent_type: string;
  tasks_assigned: number;
  tasks_completed: number;
  prs_merged: number;
}

export interface PlanData {
  hasData: boolean;
  plans: PlanInfo[];
  total_ready: number;
  total_active: number;
}

export interface PlanProgressData {
  hasData: boolean;
  plans: Array<PlanInfo & { tasks_by_phase: Array<{ phase: string; tasks: PlanTaskInfo[] }> }>;
}

export interface PlanTimelineData {
  hasData: boolean;
  entries: PlanTimelineEntry[];
}

export interface PlanAuditData {
  hasData: boolean;
  plans: Array<{
    title: string;
    agents: PlanAgentMetric[];
    phases: PlanPhaseInfo[];
  }>;
}

// ============================================================================
// Helpers
// ============================================================================

function getTaskProgress(db: ReturnType<typeof openReadonlyDb>, taskId: string): number {
  const total = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ?').get(taskId) as { c: number }).c;
  if (total === 0) {
    const task = db.prepare('SELECT status FROM plan_tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    return task?.status === 'completed' || task?.status === 'skipped' ? 100 : 0;
  }
  const completed = (db.prepare('SELECT COUNT(*) as c FROM substeps WHERE task_id = ? AND completed = 1').get(taskId) as { c: number }).c;
  return Math.round((completed / total) * 100);
}

function getPhaseProgress(db: ReturnType<typeof openReadonlyDb>, phaseId: string): number {
  const tasks = db.prepare('SELECT id FROM plan_tasks WHERE phase_id = ?').all(phaseId) as Array<{ id: string }>;
  if (tasks.length === 0) return 0;
  const progresses = tasks.map(t => getTaskProgress(db, t.id));
  return Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length);
}

function getPlanProgress(db: ReturnType<typeof openReadonlyDb>, planId: string): number {
  const phases = db.prepare("SELECT id FROM phases WHERE plan_id = ? AND status != 'skipped'").all(planId) as Array<{ id: string }>;
  if (phases.length === 0) return 0;
  const progresses = phases.map(p => getPhaseProgress(db, p.id));
  return Math.round(progresses.reduce((a, b) => a + b, 0) / progresses.length);
}

// ============================================================================
// Readers
// ============================================================================

const EMPTY: PlanData = { hasData: false, plans: [], total_ready: 0, total_active: 0 };

export function getPlanData(): PlanData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');

  if (!fs.existsSync(dbPath)) return EMPTY;

  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch {
    return EMPTY;
  }

  try {
    const plans = db.prepare("SELECT * FROM plans WHERE status IN ('draft', 'active', 'paused') ORDER BY updated_at DESC").all() as Array<{
      id: string; title: string; status: string; updated_at: string | null;
    }>;

    if (plans.length === 0) {
      db.close();
      return EMPTY;
    }

    let totalReady = 0;
    let totalActive = 0;

    const planInfos: PlanInfo[] = plans.map(p => {
      const phaseCount = (db.prepare('SELECT COUNT(*) as c FROM phases WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const taskCount = (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const completedTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'completed'").get(p.id) as { c: number }).c;
      const readyTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'ready'").get(p.id) as { c: number }).c;
      const activeTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress'").get(p.id) as { c: number }).c;

      totalReady += readyTasks;
      totalActive += activeTasks;

      // Current phase: first non-completed phase
      const currentPhase = db.prepare("SELECT title FROM phases WHERE plan_id = ? AND status != 'completed' AND status != 'skipped' ORDER BY phase_order LIMIT 1").get(p.id) as { title: string } | undefined;

      // Phase summaries
      const phases = db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order').all(p.id) as Array<{
        id: string; title: string; phase_order: number; status: string;
      }>;

      const phaseInfos: PlanPhaseInfo[] = phases.map(ph => {
        const ptCount = (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ?').get(ph.id) as { c: number }).c;
        const ptCompleted = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ? AND status = 'completed'").get(ph.id) as { c: number }).c;
        return {
          id: ph.id,
          title: ph.title,
          phase_order: ph.phase_order,
          status: ph.status,
          progress_pct: getPhaseProgress(db, ph.id),
          task_count: ptCount,
          completed_tasks: ptCompleted,
        };
      });

      return {
        id: p.id,
        title: p.title,
        status: p.status,
        progress_pct: getPlanProgress(db, p.id),
        phase_count: phaseCount,
        task_count: taskCount,
        completed_tasks: completedTasks,
        ready_tasks: readyTasks,
        active_tasks: activeTasks,
        current_phase: currentPhase?.title ?? null,
        phases: phaseInfos,
        updated_at: p.updated_at,
      };
    });

    db.close();
    return { hasData: true, plans: planInfos, total_ready: totalReady, total_active: totalActive };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return EMPTY;
  }
}

export function getPlanProgressData(): PlanProgressData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');

  if (!fs.existsSync(dbPath)) return { hasData: false, plans: [] };

  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch {
    return { hasData: false, plans: [] };
  }

  try {
    const plans = db.prepare("SELECT * FROM plans WHERE status IN ('active', 'paused') ORDER BY updated_at DESC").all() as Array<{
      id: string; title: string; status: string; updated_at: string | null;
    }>;

    const result = plans.map(p => {
      const phases = db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order').all(p.id) as Array<{
        id: string; title: string; phase_order: number; status: string;
      }>;

      const tasksByPhase = phases.map(ph => {
        const tasks = db.prepare('SELECT * FROM plan_tasks WHERE phase_id = ? ORDER BY task_order').all(ph.id) as Array<{
          id: string; title: string; status: string; agent_type: string | null; pr_number: number | null; pr_merged: number | null;
        }>;

        const taskInfos: PlanTaskInfo[] = tasks.map(t => {
          const substeps = db.prepare('SELECT id, title, completed FROM substeps WHERE task_id = ? ORDER BY step_order').all(t.id) as Array<{
            id: string; title: string; completed: number;
          }>;

          return {
            id: t.id,
            title: t.title,
            status: t.status,
            agent_type: t.agent_type,
            pr_number: t.pr_number,
            pr_merged: t.pr_merged === 1,
            progress_pct: getTaskProgress(db, t.id),
            substeps: substeps.map(s => ({ id: s.id, title: s.title, completed: s.completed === 1 })),
          };
        });

        return { phase: ph.title, tasks: taskInfos };
      });

      // Build PlanInfo
      const phaseCount = phases.length;
      const taskCount = (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ?').get(p.id) as { c: number }).c;
      const completedTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'completed'").get(p.id) as { c: number }).c;
      const readyTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'ready'").get(p.id) as { c: number }).c;
      const activeTasks = (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = ? AND status = 'in_progress'").get(p.id) as { c: number }).c;
      const currentPhase = db.prepare("SELECT title FROM phases WHERE plan_id = ? AND status != 'completed' AND status != 'skipped' ORDER BY phase_order LIMIT 1").get(p.id) as { title: string } | undefined;

      const phaseInfos: PlanPhaseInfo[] = phases.map(ph => ({
        id: ph.id,
        title: ph.title,
        phase_order: ph.phase_order,
        status: ph.status,
        progress_pct: getPhaseProgress(db, ph.id),
        task_count: (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ?').get(ph.id) as { c: number }).c,
        completed_tasks: (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ? AND status = 'completed'").get(ph.id) as { c: number }).c,
      }));

      return {
        id: p.id,
        title: p.title,
        status: p.status,
        progress_pct: getPlanProgress(db, p.id),
        phase_count: phaseCount,
        task_count: taskCount,
        completed_tasks: completedTasks,
        ready_tasks: readyTasks,
        active_tasks: activeTasks,
        current_phase: currentPhase?.title ?? null,
        phases: phaseInfos,
        updated_at: p.updated_at,
        tasks_by_phase: tasksByPhase,
      };
    });

    db.close();
    return { hasData: result.length > 0, plans: result };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return { hasData: false, plans: [] };
  }
}

export function getPlanTimelineData(hours = 24): PlanTimelineData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');

  if (!fs.existsSync(dbPath)) return { hasData: false, entries: [] };

  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch {
    return { hasData: false, entries: [] };
  }

  try {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const changes = db.prepare(
      'SELECT * FROM state_changes WHERE changed_at >= ? ORDER BY changed_at DESC LIMIT 50'
    ).all(since) as Array<{
      entity_type: string; entity_id: string; field_name: string;
      old_value: string | null; new_value: string | null; changed_at: string;
    }>;

    const entries: PlanTimelineEntry[] = changes.map(c => {
      let label = c.entity_id.substring(0, 8);
      try {
        if (c.entity_type === 'task') {
          const t = db.prepare('SELECT title FROM plan_tasks WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          if (t) label = t.title;
        } else if (c.entity_type === 'phase') {
          const p = db.prepare('SELECT title FROM phases WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          if (p) label = p.title;
        } else if (c.entity_type === 'substep') {
          const s = db.prepare('SELECT title FROM substeps WHERE id = ?').get(c.entity_id) as { title: string } | undefined;
          if (s) label = s.title;
        }
      } catch { /* ignore */ }

      return {
        time: c.changed_at,
        entity_type: c.entity_type,
        label,
        field: c.field_name,
        old_value: c.old_value,
        new_value: c.new_value,
      };
    });

    db.close();
    return { hasData: entries.length > 0, entries };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return { hasData: false, entries: [] };
  }
}

export function getPlanAuditData(): PlanAuditData {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const dbPath = path.join(projectDir, '.claude', 'state', 'plans.db');

  if (!fs.existsSync(dbPath)) return { hasData: false, plans: [] };

  let db;
  try {
    db = openReadonlyDb(dbPath);
  } catch {
    return { hasData: false, plans: [] };
  }

  try {
    const plans = db.prepare("SELECT id, title FROM plans WHERE status IN ('active', 'paused', 'completed') ORDER BY updated_at DESC").all() as Array<{ id: string; title: string }>;

    const result = plans.map(p => {
      const tasks = db.prepare('SELECT agent_type, status, pr_merged FROM plan_tasks WHERE plan_id = ?').all(p.id) as Array<{
        agent_type: string | null; status: string; pr_merged: number | null;
      }>;

      const agentMap: Record<string, PlanAgentMetric> = {};
      for (const t of tasks) {
        const at = t.agent_type || 'unassigned';
        if (!agentMap[at]) {
          agentMap[at] = { agent_type: at, tasks_assigned: 0, tasks_completed: 0, prs_merged: 0 };
        }
        agentMap[at].tasks_assigned++;
        if (t.status === 'completed') agentMap[at].tasks_completed++;
        if (t.pr_merged) agentMap[at].prs_merged++;
      }

      const phases = db.prepare('SELECT * FROM phases WHERE plan_id = ? ORDER BY phase_order').all(p.id) as Array<{
        id: string; title: string; phase_order: number; status: string;
      }>;

      const phaseInfos: PlanPhaseInfo[] = phases.map(ph => ({
        id: ph.id,
        title: ph.title,
        phase_order: ph.phase_order,
        status: ph.status,
        progress_pct: getPhaseProgress(db, ph.id),
        task_count: (db.prepare('SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ?').get(ph.id) as { c: number }).c,
        completed_tasks: (db.prepare("SELECT COUNT(*) as c FROM plan_tasks WHERE phase_id = ? AND status = 'completed'").get(ph.id) as { c: number }).c,
      }));

      return { title: p.title, agents: Object.values(agentMap), phases: phaseInfos };
    });

    db.close();
    return { hasData: result.length > 0, plans: result };
  } catch {
    try { db.close(); } catch { /* ignore */ }
    return { hasData: false, plans: [] };
  }
}
