import React from 'react';
import type { TaskMetrics } from '../types';

interface TodoSectionProps {
  tasks: TaskMetrics;
}

export function TodoSection({ tasks }: TodoSectionProps): React.ReactElement {
  const sections = Object.entries(tasks.by_section);

  if (sections.length === 0) {
    return (
      <div className="section">
        <div className="section-title">Tasks</div>
        <div className="empty-state">No tasks configured</div>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="section-title">
        Tasks by Section
        {tasks.pending_total > 0 && <span className="badge">{tasks.pending_total}</span>}
      </div>

      <div style={{ fontSize: '11px', marginBottom: '8px' }}>
        <span className="text-yellow">{tasks.pending_total} queued</span>
        <span className="text-gray"> / </span>
        <span className="text-cyan">{tasks.in_progress_total} active</span>
        <span className="text-gray"> / </span>
        <span className="text-green">{tasks.completed_24h} done (24h)</span>
      </div>

      {sections.map(([section, counts]) => (
        <div key={section} className="status-row">
          <span className="status-label" style={{ flex: 1 }}>{section}</span>
          <span style={{ display: 'flex', gap: '12px', fontSize: '12px' }}>
            {counts.pending > 0 && (
              <span className="text-yellow">{counts.pending}q</span>
            )}
            {counts.in_progress > 0 && (
              <span className="text-cyan">{counts.in_progress}a</span>
            )}
            <span className="text-gray">{counts.completed}d</span>
          </span>
        </div>
      ))}
    </div>
  );
}
