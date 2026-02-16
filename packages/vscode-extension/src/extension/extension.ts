import * as vscode from 'vscode';
import { DataService } from './DataService';
import { WebviewProvider } from './WebviewProvider';
import { StatusBarManager } from './StatusBarManager';

let dataService: DataService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const projectDir = workspaceFolder.uri.fsPath;

  // Set project dir for data readers
  process.env['CLAUDE_PROJECT_DIR'] = projectDir;

  dataService = new DataService(projectDir);
  const statusBarManager = new StatusBarManager(dataService);
  const webviewProvider = new WebviewProvider(context, dataService);

  const openDashboard = vscode.commands.registerCommand(
    'gentyr.openDashboard',
    () => webviewProvider.show()
  );

  const refreshDashboard = vscode.commands.registerCommand(
    'gentyr.refreshDashboard',
    () => dataService?.refresh()
  );

  // Watch .claude/ directory for changes
  const claudePattern = new vscode.RelativePattern(
    vscode.Uri.joinPath(workspaceFolder.uri, '.claude'),
    '**/*.{db,json}'
  );
  const watcher = vscode.workspace.createFileSystemWatcher(claudePattern);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => dataService?.refresh(), 500);
  };

  watcher.onDidChange(debouncedRefresh);
  watcher.onDidCreate(debouncedRefresh);
  watcher.onDidDelete(debouncedRefresh);

  // Initial data load
  dataService.refresh();

  context.subscriptions.push(
    openDashboard,
    refreshDashboard,
    watcher,
    statusBarManager,
    { dispose: () => dataService?.dispose() }
  );
}

export function deactivate(): void {
  dataService?.dispose();
}
