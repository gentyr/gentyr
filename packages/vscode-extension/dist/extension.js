"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode4 = __toESM(require("vscode"));

// src/extension/DataService.ts
var vscode = __toESM(require("vscode"));
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var crypto = __toESM(require("crypto"));
var import_better_sqlite3 = __toESM(require("better-sqlite3"));
var COOLDOWN_MINUTES = 55;
var ANTHROPIC_API_URL = "https://api.anthropic.com/api/oauth/usage";
var ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
var REFRESH_INTERVAL_MS = 3e4;
var HOURS = 24;
var PROTECTED_FILES_RELATIVE = [
  ".claude/hooks/pre-commit-review.js",
  "eslint.config.js",
  ".husky/pre-commit"
];
var EMPTY_QUOTA = {
  five_hour: null,
  seven_day: null,
  extra_usage_enabled: false,
  error: null
};
var DataService = class {
  _onDidUpdate = new vscode.EventEmitter();
  onDidUpdate = this._onDidUpdate.event;
  state = null;
  refreshTimer;
  isRefreshing = false;
  projectDir;
  claudeDir;
  todoDB;
  deputyCtoDB;
  ctoReportsDB;
  autonomousConfigPath;
  automationStatePath;
  keyRotationPath;
  credentialsPath;
  constructor(projectDir) {
    this.projectDir = projectDir;
    this.claudeDir = path.join(projectDir, ".claude");
    this.todoDB = path.join(this.claudeDir, "todo.db");
    this.deputyCtoDB = path.join(this.claudeDir, "deputy-cto.db");
    this.ctoReportsDB = path.join(this.claudeDir, "cto-reports.db");
    this.autonomousConfigPath = path.join(this.claudeDir, "autonomous-mode.json");
    this.automationStatePath = path.join(this.claudeDir, "hourly-automation-state.json");
    this.keyRotationPath = path.join(os.homedir(), ".claude", "api-key-rotation.json");
    this.credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json");
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
  }
  getState() {
    return this.state;
  }
  async refresh() {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    try {
      const [verifiedQuota, tokenUsage, sessions] = await Promise.all([
        this.getVerifiedQuota(),
        Promise.resolve(this.getTokenUsage()),
        Promise.resolve(this.getSessionMetrics())
      ]);
      this.state = {
        generated_at: (/* @__PURE__ */ new Date()).toISOString(),
        system_health: this.getSystemHealth(),
        autonomous_mode: this.getAutonomousModeStatus(),
        verified_quota: verifiedQuota,
        token_usage: tokenUsage,
        sessions,
        pending_items: this.getPendingItems(),
        tasks: this.getTaskMetrics(),
        deputy_cto: this.getDeputyCtoData()
      };
      this._onDidUpdate.fire(this.state);
    } catch (err) {
      console.error("[GENTYR] Failed to refresh data:", err);
    } finally {
      this.isRefreshing = false;
    }
  }
  dispose() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this._onDidUpdate.dispose();
  }
  // ========================================================================
  // Quota
  // ========================================================================
  getCredentialToken() {
    const envToken = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
    if (envToken) return envToken;
    if (process.platform === "darwin") {
      try {
        const { execFileSync } = require("child_process");
        const { username } = os.userInfo();
        const raw = execFileSync("security", [
          "find-generic-password",
          "-s",
          "Claude Code-credentials",
          "-a",
          username,
          "-w"
        ], { encoding: "utf8", timeout: 3e3 }).trim();
        const creds = JSON.parse(raw);
        const token = this.extractToken(creds);
        if (token) return token;
      } catch {
      }
    }
    try {
      if (fs.existsSync(this.credentialsPath)) {
        const creds = JSON.parse(fs.readFileSync(this.credentialsPath, "utf8"));
        const token = this.extractToken(creds);
        if (token) return token;
      }
    } catch {
    }
    return null;
  }
  extractToken(creds) {
    if (!creds.claudeAiOauth?.accessToken) return null;
    if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < Date.now()) return null;
    return creds.claudeAiOauth.accessToken;
  }
  generateKeyId(accessToken) {
    const cleanToken = accessToken.replace(/^sk-ant-oat01-/, "").replace(/^sk-ant-/, "");
    return crypto.createHash("sha256").update(cleanToken).digest("hex").substring(0, 16);
  }
  collectAllKeys() {
    const keyMap = /* @__PURE__ */ new Map();
    let rotationState = null;
    if (fs.existsSync(this.keyRotationPath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.keyRotationPath, "utf8"));
        if (state?.version === 1 && typeof state.keys === "object") {
          rotationState = state;
          for (const [keyId, keyData] of Object.entries(state.keys)) {
            if (keyData.status === "invalid" || keyData.status === "expired") continue;
            if (!keyData.accessToken) continue;
            keyMap.set(keyId, {
              key_id: keyId,
              access_token: keyData.accessToken,
              subscription_type: keyData.subscriptionType || "unknown",
              is_current: keyId === state.active_key_id
            });
          }
        }
      } catch {
      }
    }
    const credToken = this.getCredentialToken();
    if (credToken) {
      const credKeyId = this.generateKeyId(credToken);
      if (!keyMap.has(credKeyId)) {
        keyMap.set(credKeyId, {
          key_id: credKeyId,
          access_token: credToken,
          subscription_type: "unknown",
          is_current: !rotationState
        });
      }
    }
    return { keys: Array.from(keyMap.values()), rotationState };
  }
  async fetchQuotaForToken(accessToken) {
    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": "gentyr-vscode/0.1.0",
          "anthropic-beta": ANTHROPIC_BETA_HEADER
        }
      });
      if (!response.ok) return { ...EMPTY_QUOTA, error: `API error: ${response.status}` };
      const data = await response.json();
      const parseBucket = (b) => {
        if (!b) return null;
        const hoursUntil = Math.max(0, Math.round((new Date(b.resets_at).getTime() - Date.now()) / 36e5 * 10) / 10);
        return { utilization: b.utilization, resets_at: b.resets_at, resets_in_hours: hoursUntil };
      };
      return {
        five_hour: parseBucket(data.five_hour),
        seven_day: parseBucket(data.seven_day),
        extra_usage_enabled: data.extra_usage?.is_enabled ?? false,
        error: null
      };
    } catch (err) {
      return { ...EMPTY_QUOTA, error: `Fetch error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  async getVerifiedQuota() {
    const { keys, rotationState } = this.collectAllKeys();
    if (keys.length === 0) {
      return { keys: [], healthy_count: 0, total_attempted: 0, aggregate: { ...EMPTY_QUOTA, error: "No keys found" }, rotation_events_24h: 0 };
    }
    const results = await Promise.all(
      keys.map(async (key) => {
        const quota = await this.fetchQuotaForToken(key.access_token);
        return {
          key_id: `${key.key_id.slice(0, 8)}...`,
          subscription_type: key.subscription_type,
          is_current: key.is_current,
          healthy: !quota.error,
          quota: quota.error ? null : quota
        };
      })
    );
    const healthyKeys = results.filter((k) => k.healthy && k.quota);
    const aggregate = this.buildAggregate(healthyKeys);
    let rotationEvents24h = 0;
    if (rotationState) {
      const since = Date.now() - HOURS * 60 * 60 * 1e3;
      rotationEvents24h = rotationState.rotation_log.filter(
        (entry) => entry.timestamp >= since && entry.event === "key_switched"
      ).length;
    }
    return { keys: results, healthy_count: healthyKeys.length, total_attempted: keys.length, aggregate, rotation_events_24h: rotationEvents24h };
  }
  buildAggregate(healthyKeys) {
    if (healthyKeys.length === 0) return { ...EMPTY_QUOTA, error: "No healthy keys" };
    const avgBucket = (getBucket) => {
      const buckets = healthyKeys.map((k) => getBucket(k.quota)).filter((b) => b !== null);
      if (buckets.length === 0) return null;
      const avgUtil = Math.round(buckets.reduce((s, b) => s + b.utilization, 0) / buckets.length);
      const earliest = buckets.reduce((a, b) => new Date(a.resets_at).getTime() < new Date(b.resets_at).getTime() ? a : b);
      return { utilization: avgUtil, resets_at: earliest.resets_at, resets_in_hours: earliest.resets_in_hours };
    };
    return {
      five_hour: avgBucket((q) => q.five_hour),
      seven_day: avgBucket((q) => q.seven_day),
      extra_usage_enabled: healthyKeys.some((k) => k.quota.extra_usage_enabled),
      error: null
    };
  }
  // ========================================================================
  // Token Usage
  // ========================================================================
  getSessionDir() {
    const projectPath = this.projectDir.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "");
    return path.join(os.homedir(), ".claude", "projects", `-${projectPath}`);
  }
  getTokenUsage() {
    const sessionDir = this.getSessionDir();
    const since = Date.now() - HOURS * 60 * 60 * 1e3;
    const totals = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
    if (!fs.existsSync(sessionDir)) return totals;
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;
      const content = fs.readFileSync(filePath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.timestamp && new Date(entry.timestamp).getTime() < since) continue;
          const usage = entry.message?.usage;
          if (usage) {
            totals.input += usage.input_tokens || 0;
            totals.output += usage.output_tokens || 0;
            totals.cache_read += usage.cache_read_input_tokens || 0;
            totals.cache_creation += usage.cache_creation_input_tokens || 0;
          }
        } catch {
        }
      }
    }
    totals.total = totals.input + totals.output + totals.cache_read + totals.cache_creation;
    return totals;
  }
  // ========================================================================
  // Sessions
  // ========================================================================
  getSessionMetrics() {
    const since = Date.now() - HOURS * 60 * 60 * 1e3;
    const sessionDir = this.getSessionDir();
    const metrics = { task_triggered: 0, user_triggered: 0 };
    if (!fs.existsSync(sessionDir)) return metrics;
    const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtime.getTime() < since) continue;
      const content = fs.readFileSync(filePath, "utf8");
      let isTask = false;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "human" || entry.type === "user") {
            const msg = typeof entry.message?.content === "string" ? entry.message.content : entry.content;
            if (msg?.startsWith("[Task]")) isTask = true;
            break;
          }
        } catch {
        }
      }
      if (isTask) metrics.task_triggered++;
      else metrics.user_triggered++;
    }
    return metrics;
  }
  // ========================================================================
  // Autonomous Mode
  // ========================================================================
  getAutonomousModeStatus() {
    let enabled = false;
    if (fs.existsSync(this.autonomousConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(this.autonomousConfigPath, "utf8"));
        enabled = config.enabled === true;
      } catch {
      }
    }
    let next_run_time = null;
    let seconds_until_next = null;
    if (enabled && fs.existsSync(this.automationStatePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(this.automationStatePath, "utf8"));
        const lastRun = state.lastRun || 0;
        const nextRunMs = lastRun + COOLDOWN_MINUTES * 60 * 1e3;
        next_run_time = new Date(nextRunMs).toISOString();
        seconds_until_next = Math.max(0, Math.floor((nextRunMs - Date.now()) / 1e3));
      } catch {
      }
    } else if (enabled) {
      next_run_time = (/* @__PURE__ */ new Date()).toISOString();
      seconds_until_next = 0;
    }
    return { enabled, interval_minutes: COOLDOWN_MINUTES, next_run_time, seconds_until_next };
  }
  // ========================================================================
  // System Health
  // ========================================================================
  getSystemHealth() {
    let allProtected = true;
    let anyExists = false;
    for (const relPath of PROTECTED_FILES_RELATIVE) {
      const filePath = path.join(this.projectDir, relPath);
      if (fs.existsSync(filePath)) {
        anyExists = true;
        try {
          const stats = fs.statSync(filePath);
          if (stats.uid !== 0) allProtected = false;
        } catch {
          allProtected = false;
        }
      }
    }
    return { protection_status: anyExists ? allProtected ? "protected" : "unprotected" : "unknown" };
  }
  // ========================================================================
  // Pending Items
  // ========================================================================
  getPendingItems() {
    const items = { cto_questions: 0, commit_rejections: 0, pending_triage: 0, commits_blocked: false };
    if (fs.existsSync(this.deputyCtoDB)) {
      try {
        const db = new import_better_sqlite3.default(this.deputyCtoDB, { readonly: true });
        const pending = db.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'pending'").get();
        const rejections = db.prepare("SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'").get();
        db.close();
        items.cto_questions = pending?.count || 0;
        items.commit_rejections = rejections?.count || 0;
      } catch {
      }
    }
    if (fs.existsSync(this.ctoReportsDB)) {
      try {
        const db = new import_better_sqlite3.default(this.ctoReportsDB, { readonly: true });
        const pending = db.prepare("SELECT COUNT(*) as count FROM reports WHERE triage_status = 'pending'").get();
        items.pending_triage = pending?.count || 0;
        db.close();
      } catch {
      }
    }
    items.commits_blocked = items.cto_questions > 0 || items.pending_triage > 0;
    return items;
  }
  // ========================================================================
  // Tasks
  // ========================================================================
  getTaskMetrics() {
    const metrics = { pending_total: 0, in_progress_total: 0, completed_total: 0, by_section: {}, completed_24h: 0 };
    if (!fs.existsSync(this.todoDB)) return metrics;
    try {
      const db = new import_better_sqlite3.default(this.todoDB, { readonly: true });
      const tasks = db.prepare("SELECT section, status, COUNT(*) as count FROM tasks GROUP BY section, status").all();
      for (const row of tasks) {
        if (!metrics.by_section[row.section]) {
          metrics.by_section[row.section] = { pending: 0, in_progress: 0, completed: 0 };
        }
        const section = metrics.by_section[row.section];
        if (row.status === "pending") {
          section.pending = row.count;
          metrics.pending_total += row.count;
        } else if (row.status === "in_progress") {
          section.in_progress = row.count;
          metrics.in_progress_total += row.count;
        } else if (row.status === "completed") {
          section.completed = row.count;
          metrics.completed_total += row.count;
        }
      }
      const sinceTimestamp = Math.floor((Date.now() - HOURS * 60 * 60 * 1e3) / 1e3);
      const completed = db.prepare("SELECT section, COUNT(*) as count FROM tasks WHERE status = 'completed' AND completed_timestamp >= ? GROUP BY section").all(sinceTimestamp);
      for (const row of completed) metrics.completed_24h += row.count;
      db.close();
    } catch {
    }
    return metrics;
  }
  // ========================================================================
  // Deputy CTO
  // ========================================================================
  getDeputyCtoData() {
    const result = {
      hasData: false,
      untriaged: [],
      untriagedCount: 0,
      recentlyTriaged: [],
      escalated: [],
      selfHandled24h: 0,
      escalated24h: 0,
      dismissed24h: 0,
      pendingQuestions: [],
      pendingQuestionCount: 0
    };
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1e3).toISOString();
    if (fs.existsSync(this.ctoReportsDB)) {
      try {
        const db = new import_better_sqlite3.default(this.ctoReportsDB, { readonly: true });
        result.untriaged = db.prepare(
          "SELECT id, title, priority, triage_status, created_at FROM reports WHERE triage_status = 'pending' ORDER BY created_timestamp DESC LIMIT 10"
        ).all();
        const countRow = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'pending'").get();
        result.untriagedCount = countRow?.cnt || 0;
        result.recentlyTriaged = db.prepare(
          "SELECT id, title, priority, triage_status, triage_outcome, triage_completed_at FROM reports WHERE triage_status IN ('self_handled', 'escalated', 'dismissed') AND triage_completed_at >= ? ORDER BY triage_completed_at DESC LIMIT 8"
        ).all(cutoff24h);
        result.escalated = db.prepare(
          "SELECT id, title, priority, triage_status, triage_outcome, triage_completed_at FROM reports WHERE triage_status = 'escalated' ORDER BY triage_completed_at DESC LIMIT 5"
        ).all();
        const sh = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'self_handled' AND triage_completed_at >= ?").get(cutoff24h);
        result.selfHandled24h = sh?.cnt || 0;
        const esc = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'escalated' AND triage_completed_at >= ?").get(cutoff24h);
        result.escalated24h = esc?.cnt || 0;
        const dis = db.prepare("SELECT COUNT(*) as cnt FROM reports WHERE triage_status = 'dismissed' AND triage_completed_at >= ?").get(cutoff24h);
        result.dismissed24h = dis?.cnt || 0;
        result.hasData = true;
        db.close();
      } catch {
      }
    }
    if (fs.existsSync(this.deputyCtoDB)) {
      try {
        const db = new import_better_sqlite3.default(this.deputyCtoDB, { readonly: true });
        result.pendingQuestions = db.prepare(
          "SELECT id, type, title, description, recommendation, created_at FROM questions WHERE status = 'pending' ORDER BY created_timestamp DESC LIMIT 10"
        ).all();
        const qCount = db.prepare("SELECT COUNT(*) as cnt FROM questions WHERE status = 'pending'").get();
        result.pendingQuestionCount = qCount?.cnt || 0;
        result.hasData = true;
        db.close();
      } catch {
      }
    }
    return result;
  }
};

// src/extension/WebviewProvider.ts
var vscode2 = __toESM(require("vscode"));
var WebviewProvider = class {
  constructor(context, dataService2) {
    this.context = context;
    this.dataService = dataService2;
    this.disposables.push(
      dataService2.onDidUpdate((state) => this.postMessage({ type: "update", data: state }))
    );
  }
  panel = null;
  disposables = [];
  show() {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode2.window.createWebviewPanel(
      "gentyrDashboard",
      "GENTYR Dashboard",
      vscode2.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode2.Uri.joinPath(this.context.extensionUri, "dist")
        ]
      }
    );
    this.panel.webview.html = this.getWebviewContent();
    const state = this.dataService.getState();
    if (state) {
      this.postMessage({ type: "update", data: state });
    }
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        if (message.type === "refresh") {
          this.dataService.refresh();
        }
      },
      void 0,
      this.disposables
    );
    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      void 0,
      this.disposables
    );
  }
  postMessage(message) {
    this.panel?.webview.postMessage(message);
  }
  getWebviewContent() {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode2.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src ${webview.cspSource};">
  <title>GENTYR Dashboard</title>
  <style>
    ${getBaseStyles()}
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
};
function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
function getBaseStyles() {
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

// src/extension/StatusBarManager.ts
var vscode3 = __toESM(require("vscode"));
var StatusBarManager = class {
  statusBarItem;
  disposables = [];
  constructor(dataService2) {
    this.statusBarItem = vscode3.window.createStatusBarItem(
      vscode3.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = "gentyr.openDashboard";
    this.statusBarItem.text = "$(shield) GENTYR";
    this.statusBarItem.tooltip = "GENTYR Dashboard - Loading...";
    this.statusBarItem.show();
    this.disposables.push(
      dataService2.onDidUpdate((state) => this.update(state))
    );
  }
  update(state) {
    const { pending_items, verified_quota, tasks, autonomous_mode } = state;
    const pendingTotal = pending_items.cto_questions + pending_items.pending_triage;
    const fiveHourPct = verified_quota.aggregate.five_hour?.utilization ?? 0;
    const sevenDayPct = verified_quota.aggregate.seven_day?.utilization ?? 0;
    const maxQuota = Math.max(fiveHourPct, sevenDayPct);
    const parts = ["$(shield) GENTYR"];
    if (pendingTotal > 0) {
      parts.push(`${pendingTotal} pending`);
    }
    if (tasks.pending_total > 0 || tasks.in_progress_total > 0) {
      parts.push(`${tasks.pending_total}q/${tasks.in_progress_total}a`);
    }
    if (!verified_quota.aggregate.error) {
      parts.push(`${maxQuota}%`);
    }
    this.statusBarItem.text = parts.join(" | ");
    if (pendingTotal > 0 || maxQuota > 80) {
      this.statusBarItem.backgroundColor = new vscode3.ThemeColor("statusBarItem.warningBackground");
    } else {
      this.statusBarItem.backgroundColor = void 0;
    }
    const tooltipLines = ["GENTYR Dashboard (click to open)", ""];
    if (!verified_quota.aggregate.error) {
      tooltipLines.push(`Quota: ${fiveHourPct}% (5h) / ${sevenDayPct}% (7d)`);
      if (verified_quota.healthy_count > 1) {
        tooltipLines.push(`Keys: ${verified_quota.healthy_count} healthy`);
      }
    }
    tooltipLines.push(`Deputy: ${autonomous_mode.enabled ? "ON" : "OFF"}`);
    if (pendingTotal > 0) {
      tooltipLines.push(`Pending: ${pending_items.cto_questions} questions, ${pending_items.pending_triage} triage`);
    }
    tooltipLines.push(`Tasks: ${tasks.pending_total} queued, ${tasks.in_progress_total} active`);
    tooltipLines.push(`Sessions (24h): ${state.sessions.task_triggered} task / ${state.sessions.user_triggered} user`);
    this.statusBarItem.tooltip = tooltipLines.join("\n");
  }
  dispose() {
    this.statusBarItem.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
};

// src/extension/extension.ts
var dataService;
function activate(context) {
  const workspaceFolder = vscode4.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;
  const projectDir = workspaceFolder.uri.fsPath;
  process.env["CLAUDE_PROJECT_DIR"] = projectDir;
  dataService = new DataService(projectDir);
  const statusBarManager = new StatusBarManager(dataService);
  const webviewProvider = new WebviewProvider(context, dataService);
  const openDashboard = vscode4.commands.registerCommand(
    "gentyr.openDashboard",
    () => webviewProvider.show()
  );
  const refreshDashboard = vscode4.commands.registerCommand(
    "gentyr.refreshDashboard",
    () => dataService?.refresh()
  );
  const claudePattern = new vscode4.RelativePattern(
    vscode4.Uri.joinPath(workspaceFolder.uri, ".claude"),
    "**/*.{db,json}"
  );
  const watcher = vscode4.workspace.createFileSystemWatcher(claudePattern);
  let debounceTimer;
  const debouncedRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => dataService?.refresh(), 500);
  };
  watcher.onDidChange(debouncedRefresh);
  watcher.onDidCreate(debouncedRefresh);
  watcher.onDidDelete(debouncedRefresh);
  dataService.refresh();
  context.subscriptions.push(
    openDashboard,
    refreshDashboard,
    watcher,
    statusBarManager,
    { dispose: () => dataService?.dispose() }
  );
}
function deactivate() {
  dataService?.dispose();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
