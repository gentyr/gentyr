import * as vscode from 'vscode';
import { DataService, type DashboardState } from './DataService';

export class WebviewProvider {
  private panel: vscode.WebviewPanel | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly dataService: DataService
  ) {
    this.disposables.push(
      dataService.onDidUpdate((state) => this.postMessage({ type: 'update', data: state }))
    );
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gentyrDashboard',
      'GENTYR Dashboard',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
      }
    );

    this.panel.webview.html = this.getWebviewContent();

    // Send initial state
    const state = this.dataService.getState();
    if (state) {
      this.postMessage({ type: 'update', data: state });
    }

    this.panel.webview.onDidReceiveMessage(
      (message: { type: string }) => {
        if (message.type === 'refresh') {
          this.dataService.refresh();
        }
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => { this.panel = null; },
      undefined,
      this.disposables
    );
  }

  private postMessage(message: { type: string; data?: DashboardState }): void {
    this.panel?.webview.postMessage(message);
  }

  private getWebviewContent(): string {
    const webview = this.panel!.webview;

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'unsafe-inline'; font-src ${webview.cspSource};">
  <title>GENTYR Dashboard</title>
  <style nonce="${nonce}">
    ${getBaseStyles()}
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getBaseStyles(): string {
  return `
    :root {
      --border-radius: 6px;
      --gap: 12px;
      --gap-sm: 8px;
      --gap-xs: 4px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      line-height: 1.5;
      padding: 16px;
      overflow-y: auto;
    }

    /* Layout */
    .dashboard { display: flex; flex-direction: column; gap: var(--gap); max-width: 900px; }
    .row { display: flex; gap: var(--gap); flex-wrap: wrap; }
    .row > * { flex: 1; min-width: 280px; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--gap-sm); }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--gap-sm); }

    /* Section */
    .section {
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #333));
      border-radius: var(--border-radius);
      padding: var(--gap);
      background: var(--vscode-editor-background);
    }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: var(--gap-sm);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .section-title .badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      padding: 0 6px;
      font-size: 10px;
      font-weight: 700;
    }

    /* Metric box */
    .metric-box {
      border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #333));
      border-radius: var(--border-radius);
      padding: var(--gap-sm) var(--gap);
    }
    .metric-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--vscode-descriptionForeground);
    }
    .metric-value {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.2;
    }

    /* Quota bar */
    .quota-bar-container { margin-bottom: var(--gap-sm); }
    .quota-bar-header {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 3px;
    }
    .quota-bar-label { color: var(--vscode-descriptionForeground); }
    .quota-bar-track {
      width: 100%;
      height: 8px;
      border-radius: 4px;
      background: var(--vscode-input-background, #333);
      overflow: hidden;
    }
    .quota-bar-fill {
      height: 100%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    /* Status row */
    .status-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #222));
    }
    .status-row:last-child { border-bottom: none; }
    .status-label { color: var(--vscode-descriptionForeground); }
    .status-value { font-weight: 600; }

    /* Report list */
    .report-item {
      padding: 6px 0;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #222));
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--gap-sm);
    }
    .report-item:last-child { border-bottom: none; }
    .report-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .report-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    /* Header */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--vscode-foreground);
    }
    .header-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .refresh-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
    }
    .refresh-btn:hover { background: var(--vscode-button-hoverBackground); }

    /* Colors */
    .text-green { color: #4ec9b0; }
    .text-yellow { color: #dcdcaa; }
    .text-red { color: #f44747; }
    .text-cyan { color: #9cdcfe; }
    .text-blue { color: #569cd6; }
    .text-gray { color: var(--vscode-descriptionForeground); }
    .text-muted { color: var(--vscode-disabledForeground, #666); }

    .bg-green { background: #4ec9b0; }
    .bg-yellow { background: #dcdcaa; }
    .bg-red { background: #f44747; }
    .bg-cyan { background: #9cdcfe; }

    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--vscode-descriptionForeground);
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 20px;
      color: var(--vscode-descriptionForeground);
    }
  `;
}
