import React from 'react';
import type { TokenUsage, SessionMetrics, TaskMetrics, PendingItems } from '../types';

interface MetricsGridProps {
  tokenUsage: TokenUsage;
  sessions: SessionMetrics;
  tasks: TaskMetrics;
  pendingItems: PendingItems;
}

function formatNumber(num: number): string {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

interface MetricBoxProps {
  title: string;
  items: Array<{ label: string; value: string | number; colorClass?: string }>;
}

function MetricBox({ title, items }: MetricBoxProps): React.ReactElement {
  return (
    <div className="metric-box">
      <div className="metric-label">{title}</div>
      <div style={{ display: 'flex', gap: '12px', marginTop: '4px', flexWrap: 'wrap' }}>
        {items.map((item, i) => (
          <div key={i}>
            <div className={`metric-value ${item.colorClass || ''}`}>{item.value}</div>
            <div className="metric-label">{item.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MetricsGrid({ tokenUsage, sessions, tasks, pendingItems }: MetricsGridProps): React.ReactElement {
  const cacheRate = (tokenUsage.cache_read + tokenUsage.input) > 0
    ? Math.round((tokenUsage.cache_read / (tokenUsage.cache_read + tokenUsage.input)) * 100)
    : 0;

  return (
    <div className="section">
      <div className="section-title">Metrics (24h)</div>
      <div className="grid-4">
        <MetricBox
          title="Tokens"
          items={[
            { label: 'Total', value: formatNumber(tokenUsage.total) },
            { label: 'Cache', value: `${cacheRate}%`, colorClass: cacheRate >= 80 ? 'text-green' : 'text-yellow' },
          ]}
        />
        <MetricBox
          title="Sessions"
          items={[
            { label: 'Task', value: sessions.task_triggered, colorClass: 'text-cyan' },
            { label: 'User', value: sessions.user_triggered, colorClass: 'text-blue' },
          ]}
        />
        <MetricBox
          title="Tasks"
          items={[
            { label: 'Queued', value: tasks.pending_total, colorClass: tasks.pending_total > 0 ? 'text-yellow' : 'text-green' },
            { label: 'Active', value: tasks.in_progress_total, colorClass: 'text-cyan' },
            { label: 'Done', value: tasks.completed_24h, colorClass: 'text-green' },
          ]}
        />
        <MetricBox
          title="CTO Queue"
          items={[
            { label: 'Questions', value: pendingItems.cto_questions, colorClass: pendingItems.cto_questions > 0 ? 'text-yellow' : 'text-green' },
            { label: 'Rejections', value: pendingItems.commit_rejections, colorClass: pendingItems.commit_rejections > 0 ? 'text-red' : 'text-green' },
            { label: 'Triage', value: pendingItems.pending_triage, colorClass: pendingItems.pending_triage > 0 ? 'text-yellow' : 'text-green' },
          ]}
        />
      </div>
    </div>
  );
}
