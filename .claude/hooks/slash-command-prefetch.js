#!/usr/bin/env node
/**
 * Slash Command Prefetch Hook
 *
 * Intercepts slash command prompts via UserPromptSubmit and pre-gathers data.
 * Mode 1 (restart-session): Executes directly, returns continue:false
 * Mode 2 (all others): Gathers data, returns as systemMessage for Claude
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawn } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Lazy-loaded SQLite — deferred until a Mode 2 handler actually needs it
let Database = null;
async function getDatabase() {
  if (Database === undefined) return null; // Previously failed
  if (Database) return Database;
  try {
    Database = (await import('better-sqlite3')).default;
    return Database;
  } catch {
    Database = undefined; // Mark as unavailable
    return null;
  }
}

// ============================================================================
// Stdin
// ============================================================================

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const timeout = setTimeout(() => resolve(data.trim()), 100);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data.trim()); });
    if (!process.stdin.readable) { clearTimeout(timeout); resolve(''); }
  });
}

// ============================================================================
// Sentinel detection
// ============================================================================

const SENTINELS = {
  'restart-session': '<!-- HOOK:GENTYR:restart-session -->',
  'cto-report': '<!-- HOOK:GENTYR:cto-report -->',
  'deputy-cto': '<!-- HOOK:GENTYR:deputy-cto -->',
  'toggle-automation': '<!-- HOOK:GENTYR:toggle-automation -->',
  'overdrive': '<!-- HOOK:GENTYR:overdrive -->',
  'setup-gentyr': '<!-- HOOK:GENTYR:setup-gentyr -->',
  'push-migrations': '<!-- HOOK:GENTYR:push-migrations -->',
  'push-secrets': '<!-- HOOK:GENTYR:push-secrets -->',
  'configure-personas': '<!-- HOOK:GENTYR:configure-personas -->',
  'spawn-tasks': '<!-- HOOK:GENTYR:spawn-tasks -->',
};

/**
 * Extract the prompt string from raw stdin.
 * UserPromptSubmit hooks receive JSON like {"prompt":"/restart-session",...}
 * but the expanded .md content contains the sentinel comments.
 * This extracts the raw user input so we can match bare slash commands.
 */
function extractPrompt(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.prompt === 'string') return parsed.prompt;
  } catch {
    // Not JSON — use raw string as-is
  }
  return raw;
}

/**
 * Check if text matches a command by either raw slash command name or sentinel.
 * Handles both the expanded .md content (contains sentinel) and the raw JSON
 * stdin (contains bare "/command-name").
 */
function matchesCommand(text, commandName) {
  if (text.trim() === `/${commandName}`) return true;
  if (text.includes(SENTINELS[commandName])) return true;
  return false;
}

// ============================================================================
// DB helpers
// ============================================================================

function openDb(dbPath) {
  if (!Database) return null;
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function queryDb(dbPath, queries) {
  const db = openDb(dbPath);
  if (!db) return null;
  try {
    const results = {};
    for (const [key, { sql, params }] of Object.entries(queries)) {
      try {
        if (sql.trimStart().toUpperCase().startsWith('SELECT COUNT')) {
          results[key] = db.prepare(sql).get(...(params || []));
        } else {
          results[key] = db.prepare(sql).all(...(params || []));
        }
      } catch {
        results[key] = null;
      }
    }
    return results;
  } finally {
    db.close();
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================================
// Paths
// ============================================================================

const DEPUTY_CTO_DB = path.join(PROJECT_DIR, '.claude', 'deputy-cto.db');
const CTO_REPORTS_DB = path.join(PROJECT_DIR, '.claude', 'cto-reports.db');
const TODO_DB = path.join(PROJECT_DIR, '.claude', 'todo.db');
const USER_FEEDBACK_DB = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
const AUTONOMOUS_MODE_PATH = path.join(PROJECT_DIR, '.claude', 'autonomous-mode.json');
const AUTOMATION_STATE_PATH = path.join(PROJECT_DIR, '.claude', 'hourly-automation-state.json');
const AUTOMATION_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'state', 'automation-config.json');
const SERVICES_CONFIG_PATH = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');

// ============================================================================
// Mode 1: restart-session
// ============================================================================

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function getSessionDir() {
  const projectPath = PROJECT_DIR.replace(/[^a-zA-Z0-9]/g, '-').replace(/^-/, '');
  return path.join(os.homedir(), '.claude', 'projects', `-${projectPath}`);
}

function discoverSessionIdViaLsof(sessionDir, claudePid) {
  try {
    const output = execSync(`lsof -p ${claudePid} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
    for (const line of output.split('\n')) {
      if (!line.includes('.jsonl')) continue;
      const match = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/);
      if (match && match[1]) {
        const candidate = path.join(sessionDir, `${match[1]}.jsonl`);
        if (fs.existsSync(candidate)) return match[1];
      }
    }
  } catch {
    // lsof unavailable or failed
  }
  return null;
}

function discoverSessionIdViaContent(sessionDir) {
  const TAIL_BYTES = 8192;
  const candidates = [];
  let fileNames;
  try {
    fileNames = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  for (const f of fileNames) {
    const id = f.replace('.jsonl', '');
    if (!UUID_REGEX.test(id)) continue;
    const filePath = path.join(sessionDir, f);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;
      const fd = fs.openSync(filePath, 'r');
      const readSize = Math.min(TAIL_BYTES, stat.size);
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      if (buffer.toString('utf8').includes('session_restart')) {
        candidates.push({ id, mtime: stat.mtimeMs });
      }
    } catch {
      // Skip unreadable files
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
}

export function discoverSessionId() {
  const sessionDir = getSessionDir();
  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Session directory not found: ${sessionDir}`);
  }

  const claudePid = process.ppid;
  const lsofResult = discoverSessionIdViaLsof(sessionDir, claudePid);
  if (lsofResult) return lsofResult;

  // Note: discoverSessionIdViaContent is NOT used here because in hook context
  // Claude hasn't written the tool call to the transcript yet (the hook fires
  // BEFORE Claude processes the prompt). Fall through directly to mtime.

  let files;
  try {
    files = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return { name: f, mtime: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.mtime - a.mtime || b.size - a.size);
  } catch (err) {
    throw new Error(`Failed to read session directory: ${err.message}`);
  }

  if (files.length === 0) {
    throw new Error(`No session files found in: ${sessionDir}`);
  }

  const sessionId = files[0].name.replace('.jsonl', '');
  if (!UUID_REGEX.test(sessionId)) {
    throw new Error(`Session filename is not a valid UUID: ${sessionId}`);
  }
  return sessionId;
}

export function getClaudePid() {
  const pid = process.ppid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid parent PID: ${pid}`);
  }
  try {
    const command = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim();
    if (!command.toLowerCase().includes('claude')) {
      throw new Error(`Parent process (PID ${pid}) does not appear to be Claude Code: "${command}"`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('does not appear')) throw err;
    throw new Error(`Could not verify parent process (PID ${pid}): ${err.message}`);
  }
  return pid;
}

export function detectTerminal() {
  if (process.platform !== 'darwin') return 'unknown';
  const termProgram = process.env.TERM_PROGRAM || '';
  if (termProgram === 'Apple_Terminal') return 'apple_terminal';
  if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') return 'iterm';
  return 'unknown';
}

function escapeForAppleScript(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function validateProjectDir(dir) {
  if (dir.includes("'")) {
    throw new Error(`Project directory path contains single quotes: ${dir}`);
  }
  if (/[\x00-\x1f\x7f]/.test(dir)) {
    throw new Error('Project directory path contains control characters');
  }
}

export function shellEscape(s) {
  if (/^[a-zA-Z0-9._\-/~]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function generateRestartScript(claudePid, sessionId, projectDir, terminal) {
  const resumeCommand = `cd ${shellEscape(projectDir)} && claude --resume ${sessionId}`;

  const killBlock = `
sleep 1
kill -TERM ${claudePid} 2>/dev/null
for i in $(seq 1 20); do
  kill -0 ${claudePid} 2>/dev/null || break
  sleep 0.5
done
kill -0 ${claudePid} 2>/dev/null && kill -9 ${claudePid} 2>/dev/null
sleep 0.5
`;

  let resumeBlock;
  if (terminal === 'apple_terminal') {
    const escaped = escapeForAppleScript(resumeCommand);
    resumeBlock = `osascript -e 'tell application "Terminal" to do script "${escaped}" in selected tab of front window'`;
  } else if (terminal === 'iterm') {
    const escaped = escapeForAppleScript(resumeCommand);
    resumeBlock = `osascript -e 'tell application "iTerm2" to tell current session of current window to write text "${escaped}"'`;
  } else {
    resumeBlock = `echo ""\necho "Claude Code killed. Resume manually with:"\necho "  ${resumeCommand}"\necho ""`;
  }

  return `#!/bin/bash
${killBlock}
${resumeBlock}
`;
}

async function handleRestartSession() {
  const claudePid = getClaudePid();
  const sessionId = discoverSessionId();
  validateProjectDir(PROJECT_DIR);
  const terminal = detectTerminal();

  const script = generateRestartScript(claudePid, sessionId, PROJECT_DIR, terminal);
  const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();

  const resumeCommand = `cd ${shellEscape(PROJECT_DIR)} && claude --resume ${sessionId}`;

  let stopReason;
  if (terminal === 'unknown') {
    stopReason = `Restarting session ${sessionId}. Claude will terminate in ~1s. Resume manually with: ${resumeCommand}`;
  } else {
    stopReason = `Restarting session ${sessionId}. Claude will terminate in ~1s and resume automatically.`;
  }

  console.log(JSON.stringify({ continue: false, stopReason }));
}

// ============================================================================
// Mode 2 handlers
// ============================================================================

function getTriageStats(dbPath) {
  const db = openDb(dbPath);
  if (!db) return null;
  try {
    const rows = db.prepare(
      "SELECT triage_status, COUNT(*) as count FROM reports GROUP BY triage_status"
    ).all();
    const stats = {};
    for (const row of rows) {
      stats[row.triage_status] = row.count;
    }
    return stats;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function handleCtoReport() {
  const output = { command: 'cto-report', gathered: {} };

  // deputy-cto.db
  const deputyDb = openDb(DEPUTY_CTO_DB);
  if (deputyDb) {
    try {
      const pendingCount = deputyDb.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'pending'").get();
      const rejectionCount = deputyDb.prepare("SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'").get();
      output.gathered.deputyCto = {
        pendingQuestions: pendingCount?.count ?? 0,
        pendingRejections: rejectionCount?.count ?? 0,
      };
    } catch {
      output.gathered.deputyCto = { error: 'query failed' };
    } finally {
      deputyDb.close();
    }
  } else {
    output.gathered.deputyCto = { error: 'database not found' };
  }

  // todo.db
  const todoDb = openDb(TODO_DB);
  if (todoDb) {
    try {
      const rows = todoDb.prepare(
        "SELECT section, status, COUNT(*) as count FROM tasks GROUP BY section, status"
      ).all();
      output.gathered.todos = rows;
    } catch {
      output.gathered.todos = { error: 'query failed' };
    } finally {
      todoDb.close();
    }
  } else {
    output.gathered.todos = { error: 'database not found' };
  }

  // cto-reports.db
  const triageStats = getTriageStats(CTO_REPORTS_DB);
  output.gathered.ctoReports = triageStats ?? { error: 'database not found' };

  // autonomous-mode.json
  const autonomousMode = readJson(AUTONOMOUS_MODE_PATH);
  output.gathered.autonomousMode = autonomousMode ?? { error: 'file not found' };

  // hourly-automation-state.json
  const automationState = readJson(AUTOMATION_STATE_PATH);
  output.gathered.automationState = automationState
    ? { lastRun: automationState.lastRun }
    : { error: 'file not found' };

  // automation-config.json
  const automationConfig = readJson(AUTOMATION_CONFIG_PATH);
  if (automationConfig) {
    output.gathered.automationConfig = {
      effective: automationConfig.effective,
      overdrive: automationConfig.overdrive
        ? {
          active: automationConfig.overdrive.active,
          expiresAt: automationConfig.overdrive.expires_at,
        }
        : null,
    };
  } else {
    output.gathered.automationConfig = { error: 'file not found' };
  }

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:cto-report] ${JSON.stringify(output)}`,
    },
  }));
}

function handleDeputyCto() {
  const output = { command: 'deputy-cto', gathered: {} };

  // Read deputy-cto agent instructions for identity injection
  const agentMdPath = path.join(PROJECT_DIR, '.claude', 'agents', 'deputy-cto.md');
  try {
    const raw = fs.readFileSync(agentMdPath, 'utf8');
    // Strip YAML frontmatter (between --- markers)
    const stripped = raw.replace(/^---[\s\S]*?---\n*/, '');
    output.gathered.agentInstructions = stripped.trim();
  } catch {
    // Agent file not found — non-fatal
    output.gathered.agentInstructions = null;
  }

  // deputy-cto.db: pending questions
  const deputyDb = openDb(DEPUTY_CTO_DB);
  if (deputyDb) {
    try {
      // Discover available columns to handle schema variations across db versions
      const tableInfo = deputyDb.prepare("PRAGMA table_info(questions)").all();
      const availableCols = new Set(tableInfo.map(c => c.name));

      // Always-present columns
      const selectCols = ['id', 'type', 'title', 'description'].filter(c => availableCols.has(c));
      // Optional columns added in later schema versions
      const optionalCols = ['suggested_options', 'recommendation', 'created_at', 'created_timestamp'];
      for (const col of optionalCols) {
        if (availableCols.has(col)) selectCols.push(col);
      }

      const orderBy = availableCols.has('created_at')
        ? 'ORDER BY created_at ASC'
        : availableCols.has('created_timestamp')
          ? 'ORDER BY created_timestamp ASC'
          : '';

      const sql = `SELECT ${selectCols.join(', ')} FROM questions WHERE status = 'pending' ${orderBy}`.trim();
      const questions = deputyDb.prepare(sql).all();

      const rejectionCount = deputyDb.prepare(
        "SELECT COUNT(*) as count FROM questions WHERE type = 'rejection' AND status = 'pending'"
      ).get();
      output.gathered.pendingQuestions = questions;
      output.gathered.pendingRejections = rejectionCount?.count ?? 0;
      output.gathered.commitsBlocked = (rejectionCount?.count ?? 0) > 0;
    } catch {
      output.gathered.pendingQuestions = [];
      output.gathered.error = 'deputy-cto query failed';
    } finally {
      deputyDb.close();
    }
  } else {
    output.gathered.pendingQuestions = [];
    output.gathered.error = 'deputy-cto database not found';
  }

  // cto-reports.db: triage stats
  const triageStats = getTriageStats(CTO_REPORTS_DB);
  output.gathered.triageStats = triageStats ?? { error: 'cto-reports database not found' };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:deputy-cto] ${JSON.stringify(output)}`,
    },
  }));
}

function handleToggleAutomation() {
  const content = readJson(AUTONOMOUS_MODE_PATH);
  const output = {
    command: 'toggle-automation',
    gathered: {
      autonomousMode: content ?? { error: 'autonomous-mode.json not found' },
    },
  };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:toggle-automation] ${JSON.stringify(output)}`,
    },
  }));
}

function handleOverdrive() {
  const content = readJson(AUTOMATION_CONFIG_PATH);
  const output = {
    command: 'overdrive',
    gathered: {
      automationConfig: content ?? { error: 'automation-config.json not found' },
    },
  };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:overdrive] ${JSON.stringify(output)}`,
    },
  }));
}

function getAccountInventory() {
  const ROTATION_STATE_PATH = path.join(os.homedir(), '.claude', 'api-key-rotation.json');
  try {
    if (!fs.existsSync(ROTATION_STATE_PATH)) return null;
    const state = JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf8'));
    if (!state || state.version !== 1 || typeof state.keys !== 'object') return null;

    // Deduplicate by account_uuid (same logic as api-key-watcher.js)
    const accountMap = new Map();
    let totalKeys = 0;
    let activeKeys = 0;
    let expiredKeys = 0;
    let invalidKeys = 0;

    for (const [id, k] of Object.entries(state.keys)) {
      totalKeys++;
      if (k.status === 'active') activeKeys++;
      else if (k.status === 'expired') expiredKeys++;
      else if (k.status === 'invalid') invalidKeys++;

      const dedupeKey = k.account_uuid || id;
      if (!accountMap.has(dedupeKey) || k.status === 'active') {
        accountMap.set(dedupeKey, {
          email: k.account_email || null,
          uuid: k.account_uuid || null,
          keyId: id.slice(0, 8),
          status: k.status,
          usage: k.last_usage ? {
            five_hour: Math.round(k.last_usage.five_hour ?? 0),
            seven_day: Math.round(k.last_usage.seven_day ?? 0),
          } : null,
          subscription: k.subscriptionType || 'unknown',
        });
      }
    }

    return {
      accounts: [...accountMap.values()],
      totalKeys,
      activeKeys,
      expiredKeys,
      invalidKeys,
    };
  } catch {
    return null;
  }
}

function handleSetupGentyr() {
  // Find framework dir: if .claude/hooks is a symlink, follow it
  const hooksPath = path.join(PROJECT_DIR, '.claude', 'hooks');
  let frameworkDir = null;

  try {
    const stat = fs.lstatSync(hooksPath);
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync(hooksPath);
      // hooks -> <framework>/.claude/hooks, so framework is 2 levels up
      frameworkDir = path.resolve(resolved, '..', '..');
    }
  } catch {
    // hooks dir is not a symlink or doesn't exist
  }

  // Fallback: look for .claude-framework symlink in project dir
  if (!frameworkDir) {
    const frameworkLink = path.join(PROJECT_DIR, '.claude-framework');
    if (fs.existsSync(frameworkLink)) {
      try {
        frameworkDir = fs.realpathSync(frameworkLink);
      } catch {
        frameworkDir = frameworkLink;
      }
    }
  }

  let setupCheckOutput = null;
  if (frameworkDir) {
    const setupCheckScript = path.join(frameworkDir, 'scripts', 'setup-check.js');
    if (fs.existsSync(setupCheckScript)) {
      try {
        setupCheckOutput = execSync(`node ${shellEscape(setupCheckScript)} 2>/dev/null`, {
          encoding: 'utf8',
          timeout: 15000,
        });
      } catch {
        setupCheckOutput = null;
      }
    }
  }

  let parsedSetupCheck = null;
  if (setupCheckOutput) {
    try {
      parsedSetupCheck = JSON.parse(setupCheckOutput);
    } catch {
      // Raw output if not JSON
      parsedSetupCheck = { raw: setupCheckOutput };
    }
  }

  const output = {
    command: 'setup-gentyr',
    gathered: {
      frameworkDir,
      setupCheck: parsedSetupCheck ?? { error: frameworkDir ? 'setup-check.js failed or not found' : 'framework directory not found' },
      accountInventory: getAccountInventory(),
    },
  };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:setup-gentyr] ${JSON.stringify(output)}`,
    },
  }));
}

function handlePushMigrations() {
  const services = readJson(SERVICES_CONFIG_PATH);
  const output = { command: 'push-migrations', gathered: {} };

  const migrationsDir = services?.supabase?.migrationsDir;
  if (!migrationsDir) {
    output.gathered.migrationsDir = null;
    output.gathered.migrationFiles = null;
    output.gathered.note = 'supabase.migrationsDir not configured in services.json';
  } else {
    output.gathered.migrationsDir = migrationsDir;
    const fullDir = path.isAbsolute(migrationsDir)
      ? migrationsDir
      : path.join(PROJECT_DIR, migrationsDir);

    if (fs.existsSync(fullDir)) {
      try {
        const files = fs.readdirSync(fullDir)
          .filter(f => f.endsWith('.sql'))
          .sort();
        output.gathered.migrationFiles = files;
      } catch {
        output.gathered.migrationFiles = { error: 'failed to read migrations directory' };
      }
    } else {
      output.gathered.migrationFiles = { error: `directory not found: ${fullDir}` };
    }
  }

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:push-migrations] ${JSON.stringify(output)}`,
    },
  }));
}

function handlePushSecrets() {
  const services = readJson(SERVICES_CONFIG_PATH);
  // Only expose key names and whether values are op:// refs — never include actual values
  let secretsSummary = null;
  if (services?.secrets) {
    secretsSummary = {};
    for (const [target, mappings] of Object.entries(services.secrets)) {
      secretsSummary[target] = {};
      for (const [key, value] of Object.entries(mappings)) {
        secretsSummary[target][key] = typeof value === 'string' && value.startsWith('op://') ? 'op://' : '[direct]';
      }
    }
  }
  const output = {
    command: 'push-secrets',
    gathered: {
      secretKeyNames: secretsSummary,
      servicesConfigExists: fs.existsSync(SERVICES_CONFIG_PATH),
      note: !services ? 'services.json not found' : (!services.secrets ? 'no secrets section in services.json' : null),
    },
  };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:push-secrets] ${JSON.stringify(output)}`,
    },
  }));
}

function handleConfigurePersonas() {
  const output = { command: 'configure-personas', gathered: {} };

  const feedbackDb = openDb(USER_FEEDBACK_DB);
  if (feedbackDb) {
    try {
      const personas = feedbackDb.prepare(
        "SELECT id, name, consumption_mode, enabled FROM personas ORDER BY name"
      ).all();
      const features = feedbackDb.prepare(
        "SELECT id, name, category FROM features ORDER BY name"
      ).all();
      const mappings = feedbackDb.prepare(
        "SELECT persona_id, feature_id, priority FROM persona_features"
      ).all();
      output.gathered.personas = personas;
      output.gathered.features = features;
      output.gathered.mappings = mappings;
    } catch {
      output.gathered.error = 'query failed';
    } finally {
      feedbackDb.close();
    }
  } else {
    output.gathered.personas = [];
    output.gathered.features = [];
    output.gathered.mappings = [];
    output.gathered.note = 'user-feedback.db not found (no personas configured yet)';
  }

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:configure-personas] ${JSON.stringify(output)}`,
    },
  }));
}

function handleSpawnTasks() {
  const output = { command: 'spawn-tasks', gathered: {} };

  const todoDb = openDb(TODO_DB);
  if (todoDb) {
    try {
      const rows = todoDb.prepare(
        "SELECT section, COUNT(*) as count FROM tasks WHERE status = 'pending' AND section IN ('CODE-REVIEWER', 'INVESTIGATOR & PLANNER', 'TEST-WRITER', 'PROJECT-MANAGER', 'DEPUTY-CTO') GROUP BY section"
      ).all();
      output.gathered.pendingBySection = rows;
      const total = rows.reduce((sum, r) => sum + r.count, 0);
      output.gathered.totalPending = total;
    } catch {
      output.gathered.pendingBySection = [];
      output.gathered.totalPending = 0;
      output.gathered.error = 'query failed';
    } finally {
      todoDb.close();
    }
  } else {
    output.gathered.pendingBySection = [];
    output.gathered.totalPending = 0;
    output.gathered.note = 'todo.db not found';
  }

  // Count running agents via pgrep
  let runningAgents = 0;
  try {
    const result = execSync(
      "pgrep -cf 'claude.*--dangerously-skip-permissions'",
      { encoding: 'utf8', timeout: 5000, stdio: 'pipe' }
    ).trim();
    runningAgents = parseInt(result, 10) || 0;
  } catch {
    // pgrep returns exit code 1 when no processes match
  }
  output.gathered.runningAgents = runningAgents;

  // Read max concurrent from automation-config.json
  const automationConfig = readJson(AUTOMATION_CONFIG_PATH);
  const maxConcurrent = automationConfig?.effective?.MAX_CONCURRENT_AGENTS ?? 10;
  output.gathered.maxConcurrent = maxConcurrent;
  output.gathered.availableSlots = Math.max(0, maxConcurrent - runningAgents);

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:spawn-tasks] ${JSON.stringify(output)}`,
    },
  }));
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  const prompt = extractPrompt(raw);

  if (matchesCommand(prompt, 'restart-session')) {
    return handleRestartSession();
  }
  // Mode 2 handlers — load Database lazily only when needed
  const needsDb = ['cto-report', 'deputy-cto', 'configure-personas', 'spawn-tasks'];
  const matchedCommand = Object.keys(SENTINELS).find(key => matchesCommand(prompt, key));
  if (matchedCommand && matchedCommand !== 'restart-session') {
    if (needsDb.includes(matchedCommand)) {
      await getDatabase();
    }
  }

  if (matchesCommand(prompt, 'cto-report')) {
    return handleCtoReport();
  }
  if (matchesCommand(prompt, 'deputy-cto')) {
    return handleDeputyCto();
  }
  if (matchesCommand(prompt, 'toggle-automation')) {
    return handleToggleAutomation();
  }
  if (matchesCommand(prompt, 'overdrive')) {
    return handleOverdrive();
  }
  if (matchesCommand(prompt, 'setup-gentyr')) {
    return handleSetupGentyr();
  }
  if (matchesCommand(prompt, 'push-migrations')) {
    return handlePushMigrations();
  }
  if (matchesCommand(prompt, 'push-secrets')) {
    return handlePushSecrets();
  }
  if (matchesCommand(prompt, 'configure-personas')) {
    return handleConfigurePersonas();
  }
  if (matchesCommand(prompt, 'spawn-tasks')) {
    return handleSpawnTasks();
  }

  process.exit(0);
}

main().catch((err) => {
  // For restart-session failures, surface the error to the user
  const msg = err?.message || String(err);
  if (msg.includes('Session') || msg.includes('Claude') || msg.includes('PID')) {
    console.log(JSON.stringify({
      continue: false,
      stopReason: `Session restart failed: ${msg}`,
    }));
  }
  // All other errors: silent exit, Claude falls back to MCP tools
  process.exit(0);
});
