/**
 * Plan Orchestrator Formatting Utilities
 *
 * Progress bars, table formatting, and dashboard layout for plan visualization.
 * White + Gray only design: white for active/important, gray for secondary/blocked.
 */

// ============================================================================
// Progress Bar
// ============================================================================

const FULL = '\u2588';   // █
const EMPTY = '\u2591';  // ░

export function progressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return FULL.repeat(filled) + EMPTY.repeat(empty) + ` ${Math.round(clamped)}%`;
}

export function substepIndicator(completed: boolean): string {
  return completed ? `[${FULL}]` : `[${EMPTY}]`;
}

// ============================================================================
// Status Formatting
// ============================================================================

export function formatStatus(status: string): string {
  switch (status) {
    case 'ready':
    case 'active':
    case 'in_progress':
      return status.toUpperCase();
    case 'completed':
    case 'complete':
      return 'COMPLETE';
    case 'blocked':
    case 'pending':
    case 'draft':
    case 'paused':
    case 'archived':
    case 'skipped':
      return status.toUpperCase();
    default:
      return status.toUpperCase();
  }
}

// ============================================================================
// Time Formatting
// ============================================================================

export function formatTimeAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m`;
}

export function formatTokens(total: number): string {
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${(total / 1_000).toFixed(0)}K`;
  return String(total);
}

export function formatCompactTime(isoString: string): string {
  const d = new Date(isoString);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ============================================================================
// Dashboard Formatting
// ============================================================================

export interface PlanSummary {
  id: string;
  title: string;
  status: string;
  phase_count: number;
  task_count: number;
  completed_tasks: number;
  ready_tasks: number;
  active_agents: number;
  progress_pct: number;
  current_phase: string | null;
}

export function formatPlanDashboard(summary: PlanSummary): string {
  const lines: string[] = [];
  lines.push(`Plan: ${summary.title}`);
  lines.push(`Status: ${formatStatus(summary.status)} | Phase: ${summary.current_phase || 'N/A'}`);
  lines.push(`Progress: ${progressBar(summary.progress_pct)}`);
  lines.push(`Tasks: ${summary.completed_tasks}/${summary.task_count} complete | ${summary.ready_tasks} ready | ${summary.active_agents} agents`);
  return lines.join('\n');
}

// ============================================================================
// Timeline Formatting (compact arrows — Option D from plan)
// ============================================================================

export interface TimelineEntry {
  time: string;
  label: string;
  action: string;
  detail: string;
  indent?: boolean;
}

export function formatTimeline(entries: TimelineEntry[]): string {
  return entries.map(e => {
    const time = formatCompactTime(e.time).padEnd(8);
    const prefix = e.indent ? '  \u2514 ' : '  ';
    const label = e.label.substring(0, 30).padEnd(30);
    return `${time}${prefix}${label}\u2192 ${e.action.padEnd(14)} ${e.detail}`;
  }).join('\n');
}
