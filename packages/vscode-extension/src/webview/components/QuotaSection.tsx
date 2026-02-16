import React from 'react';
import type { VerifiedQuotaResult } from '../types';

interface QuotaSectionProps {
  data: VerifiedQuotaResult;
}

function QuotaBar({ label, percentage, resetsIn }: { label: string; percentage: number; resetsIn: number }): React.ReactElement {
  const colorClass = percentage > 80 ? 'bg-red' : percentage > 60 ? 'bg-yellow' : 'bg-green';
  const textClass = percentage > 80 ? 'text-red' : percentage > 60 ? 'text-yellow' : 'text-green';

  return (
    <div className="quota-bar-container">
      <div className="quota-bar-header">
        <span className="quota-bar-label">{label}</span>
        <span>
          <span className={textClass}>{percentage}%</span>
          <span className="text-gray"> (resets {resetsIn}h)</span>
        </span>
      </div>
      <div className="quota-bar-track">
        <div className={`quota-bar-fill ${colorClass}`} style={{ width: `${Math.min(100, percentage)}%` }} />
      </div>
    </div>
  );
}

export function QuotaSection({ data }: QuotaSectionProps): React.ReactElement {
  const { aggregate, healthy_count, rotation_events_24h } = data;

  const title = `Quota & Capacity (${healthy_count} key${healthy_count !== 1 ? 's' : ''})`;

  if (aggregate.error) {
    return (
      <div className="section">
        <div className="section-title">{title}</div>
        <div className="text-red">{aggregate.error}</div>
      </div>
    );
  }

  const fiveHour = aggregate.five_hour;
  const sevenDay = aggregate.seven_day;

  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {fiveHour && (
        <QuotaBar
          label="5-hour"
          percentage={fiveHour.utilization}
          resetsIn={fiveHour.resets_in_hours}
        />
      )}
      {sevenDay && (
        <QuotaBar
          label="7-day"
          percentage={sevenDay.utilization}
          resetsIn={sevenDay.resets_in_hours}
        />
      )}
      {rotation_events_24h > 0 && (
        <div className="text-gray" style={{ fontSize: '11px', marginTop: '4px' }}>
          Key rotations (24h): {rotation_events_24h}
        </div>
      )}
    </div>
  );
}
