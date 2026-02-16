import React from 'react';
import type { DeputyCtoData } from '../types';

interface DeputyCtoSectionProps {
  data: DeputyCtoData;
}

function formatTimeAgo(isoStr: string): string {
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function PriorityBadge({ priority }: { priority: string }): React.ReactElement {
  const colorClass = priority === 'critical' ? 'text-red'
    : priority === 'high' ? 'text-yellow'
    : 'text-gray';
  return <span className={`report-meta ${colorClass}`}>{priority}</span>;
}

export function DeputyCtoSection({ data }: DeputyCtoSectionProps): React.ReactElement {
  return (
    <div className="section">
      <div className="section-title">
        Deputy CTO
        {(data.untriagedCount + data.pendingQuestionCount) > 0 && (
          <span className="badge">{data.untriagedCount + data.pendingQuestionCount}</span>
        )}
      </div>

      {/* Summary metrics */}
      <div className="grid-3" style={{ marginBottom: '12px' }}>
        <div className="metric-box">
          <div className="metric-label">Untriaged</div>
          <div className={`metric-value ${data.untriagedCount > 0 ? 'text-yellow' : 'text-gray'}`}>
            {data.untriagedCount}
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Escalated</div>
          <div className={`metric-value ${data.escalated.length > 0 ? 'text-red' : 'text-gray'}`}>
            {data.escalated.length}
          </div>
        </div>
        <div className="metric-box">
          <div className="metric-label">Pending Q</div>
          <div className={`metric-value ${data.pendingQuestionCount > 0 ? 'text-yellow' : 'text-gray'}`}>
            {data.pendingQuestionCount}
          </div>
        </div>
      </div>

      {/* 24h triage summary */}
      <div style={{ fontSize: '11px', marginBottom: '8px' }}>
        <span className="text-gray">24h: </span>
        <span className="text-green">{data.selfHandled24h} handled</span>
        <span className="text-gray"> / </span>
        <span className={data.escalated24h > 0 ? 'text-yellow' : 'text-gray'}>{data.escalated24h} escalated</span>
        <span className="text-gray"> / </span>
        <span className="text-gray">{data.dismissed24h} dismissed</span>
      </div>

      {/* Untriaged reports */}
      {data.untriaged.length > 0 && (
        <div style={{ marginBottom: '8px' }}>
          <div className="section-title" style={{ fontSize: '10px', marginBottom: '4px' }}>
            Untriaged Reports
          </div>
          {data.untriaged.slice(0, 5).map((report) => (
            <div key={report.id} className="report-item">
              <span className="report-title">{report.title}</span>
              <PriorityBadge priority={report.priority} />
              <span className="report-meta">{formatTimeAgo(report.created_at)}</span>
            </div>
          ))}
          {data.untriagedCount > 5 && (
            <div className="text-gray" style={{ fontSize: '11px', marginTop: '4px' }}>
              +{data.untriagedCount - 5} more
            </div>
          )}
        </div>
      )}

      {/* Pending questions */}
      {data.pendingQuestions.length > 0 && (
        <div>
          <div className="section-title" style={{ fontSize: '10px', marginBottom: '4px' }}>
            Pending Questions
          </div>
          {data.pendingQuestions.slice(0, 5).map((q) => (
            <div key={q.id} className="report-item">
              <span className="report-title">{q.title}</span>
              <span className="report-meta">{q.type}</span>
              <span className="report-meta">{formatTimeAgo(q.created_at)}</span>
            </div>
          ))}
          {data.pendingQuestionCount > 5 && (
            <div className="text-gray" style={{ fontSize: '11px', marginTop: '4px' }}>
              +{data.pendingQuestionCount - 5} more
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {data.untriaged.length === 0 && data.pendingQuestions.length === 0 && data.escalated.length === 0 && (
        <div className="empty-state text-green">All clear - no pending items</div>
      )}
    </div>
  );
}
