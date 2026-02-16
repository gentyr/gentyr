import * as vscode from 'vscode';
import { DataService, type DashboardState } from './DataService';

export class StatusBarManager implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(dataService: DataService) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'gentyr.openDashboard';
    this.statusBarItem.text = '$(shield) GENTYR';
    this.statusBarItem.tooltip = 'GENTYR Dashboard - Loading...';
    this.statusBarItem.show();

    this.disposables.push(
      dataService.onDidUpdate((state) => this.update(state))
    );
  }

  private update(state: DashboardState): void {
    const { pending_items, verified_quota, tasks, autonomous_mode } = state;

    const pendingTotal = pending_items.cto_questions + pending_items.pending_triage;
    const fiveHourPct = verified_quota.aggregate.five_hour?.utilization ?? 0;
    const sevenDayPct = verified_quota.aggregate.seven_day?.utilization ?? 0;
    const maxQuota = Math.max(fiveHourPct, sevenDayPct);

    // Build status bar text
    const parts: string[] = ['$(shield) GENTYR'];

    if (pendingTotal > 0) {
      parts.push(`${pendingTotal} pending`);
    }

    if (tasks.pending_total > 0 || tasks.in_progress_total > 0) {
      parts.push(`${tasks.pending_total}q/${tasks.in_progress_total}a`);
    }

    if (!verified_quota.aggregate.error) {
      parts.push(`${maxQuota}%`);
    }

    this.statusBarItem.text = parts.join(' | ');

    // Warning background when there are pending items or high quota
    if (pendingTotal > 0 || maxQuota > 80) {
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }

    // Build tooltip
    const tooltipLines = ['GENTYR Dashboard (click to open)', ''];

    if (!verified_quota.aggregate.error) {
      tooltipLines.push(`Quota: ${fiveHourPct}% (5h) / ${sevenDayPct}% (7d)`);
      if (verified_quota.healthy_count > 1) {
        tooltipLines.push(`Keys: ${verified_quota.healthy_count} healthy`);
      }
    }

    tooltipLines.push(`Deputy: ${autonomous_mode.enabled ? 'ON' : 'OFF'}`);

    if (pendingTotal > 0) {
      tooltipLines.push(`Pending: ${pending_items.cto_questions} questions, ${pending_items.pending_triage} triage`);
    }

    tooltipLines.push(`Tasks: ${tasks.pending_total} queued, ${tasks.in_progress_total} active`);
    tooltipLines.push(`Sessions (24h): ${state.sessions.task_triggered} task / ${state.sessions.user_triggered} user`);

    this.statusBarItem.tooltip = tooltipLines.join('\n');
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
