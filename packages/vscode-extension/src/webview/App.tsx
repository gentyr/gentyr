import React, { useEffect, useState } from 'react';
import { vscode } from './vscode-api';
import { StatusHeader } from './components/StatusHeader';
import { QuotaSection } from './components/QuotaSection';
import { SystemStatus } from './components/SystemStatus';
import { DeputyCtoSection } from './components/DeputyCtoSection';
import { TodoSection } from './components/TodoSection';
import { MetricsGrid } from './components/MetricsGrid';
import type { DashboardState } from './types';

export function App(): React.ReactElement {
  const [data, setData] = useState<DashboardState | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<{ type: string; data?: DashboardState }>) => {
      if (event.data.type === 'update' && event.data.data) {
        setData(event.data.data);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  if (!data) {
    return <div className="loading">Loading GENTYR Dashboard...</div>;
  }

  return (
    <div className="dashboard">
      <StatusHeader generatedAt={data.generated_at} />

      <div className="row">
        <QuotaSection data={data.verified_quota} />
        <SystemStatus
          autonomousMode={data.autonomous_mode}
          systemHealth={data.system_health}
          pendingItems={data.pending_items}
        />
      </div>

      <MetricsGrid
        tokenUsage={data.token_usage}
        sessions={data.sessions}
        tasks={data.tasks}
        pendingItems={data.pending_items}
      />

      {data.deputy_cto.hasData && (
        <DeputyCtoSection data={data.deputy_cto} />
      )}

      <TodoSection tasks={data.tasks} />
    </div>
  );
}
