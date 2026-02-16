import React from 'react';
import type { AutonomousModeStatus, SystemHealth, PendingItems } from '../types';

interface SystemStatusProps {
  autonomousMode: AutonomousModeStatus;
  systemHealth: SystemHealth;
  pendingItems: PendingItems;
}

function formatDelta(seconds: number): string {
  if (seconds < 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m${s}s` : `${m}m`;
  return `${s}s`;
}

export function SystemStatus({ autonomousMode, systemHealth, pendingItems }: SystemStatusProps): React.ReactElement {
  const deputyColor = autonomousMode.enabled ? 'text-green' : 'text-gray';
  const protectionColor = systemHealth.protection_status === 'protected' ? 'text-green'
    : systemHealth.protection_status === 'unprotected' ? 'text-red' : 'text-yellow';
  const commitColor = pendingItems.commits_blocked ? 'text-red' : 'text-green';

  const nextTime = autonomousMode.next_run_time
    ? new Date(autonomousMode.next_run_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '')
    : 'N/A';
  const delta = autonomousMode.seconds_until_next != null
    ? formatDelta(autonomousMode.seconds_until_next)
    : 'N/A';

  return (
    <div className="section">
      <div className="section-title">System Status</div>

      <div className="status-row">
        <span className="status-label">Deputy CTO</span>
        <span className={`status-value ${deputyColor}`}>
          {autonomousMode.enabled ? 'ENABLED' : 'DISABLED'}
        </span>
      </div>

      {autonomousMode.enabled && (
        <div className="status-row">
          <span className="status-label" style={{ paddingLeft: '12px' }}>Next run</span>
          <span className="status-value">
            <span className="text-cyan">{nextTime}</span>
            <span className="text-gray"> (</span>
            <span className="text-yellow">{delta}</span>
            <span className="text-gray">)</span>
          </span>
        </div>
      )}

      <div className="status-row">
        <span className="status-label">Protection</span>
        <span className={`status-value ${protectionColor}`}>
          {systemHealth.protection_status.toUpperCase()}
        </span>
      </div>

      <div className="status-row">
        <span className="status-label">Commits</span>
        <span className={`status-value ${commitColor}`}>
          {pendingItems.commits_blocked ? 'BLOCKED' : 'ALLOWED'}
        </span>
      </div>
    </div>
  );
}
