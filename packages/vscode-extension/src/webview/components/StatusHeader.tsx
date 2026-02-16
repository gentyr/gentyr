import React from 'react';
import { vscode } from '../vscode-api';

interface StatusHeaderProps {
  generatedAt: string;
}

export function StatusHeader({ generatedAt }: StatusHeaderProps): React.ReactElement {
  const timeStr = new Date(generatedAt).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return (
    <div className="header">
      <div>
        <div className="header-title">GENTYR Dashboard</div>
        <div className="header-meta">Last updated: {timeStr}</div>
      </div>
      <button
        className="refresh-btn"
        onClick={() => vscode.postMessage({ type: 'refresh' })}
      >
        Refresh
      </button>
    </div>
  );
}
