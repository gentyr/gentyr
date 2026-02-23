#!/usr/bin/env node
/**
 * Slash Command Prefetch Hook
 *
 * Intercepts slash command prompts via UserPromptSubmit and pre-gathers data.
 * Gathers data and returns as systemMessage for Claude to use.
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
  'cto-report': '<!-- HOOK:GENTYR:cto-report -->',
  'deputy-cto': '<!-- HOOK:GENTYR:deputy-cto -->',
  'toggle-automation': '<!-- HOOK:GENTYR:toggle-automation -->',
  'overdrive': '<!-- HOOK:GENTYR:overdrive -->',
  'setup-gentyr': '<!-- HOOK:GENTYR:setup-gentyr -->',
  'push-migrations': '<!-- HOOK:GENTYR:push-migrations -->',
  'push-secrets': '<!-- HOOK:GENTYR:push-secrets -->',
  'configure-personas': '<!-- HOOK:GENTYR:configure-personas -->',
  'spawn-tasks': '<!-- HOOK:GENTYR:spawn-tasks -->',
  'show': '<!-- HOOK:GENTYR:show -->',
  'product-manager': '<!-- HOOK:GENTYR:product-manager -->',
  'toggle-product-manager': '<!-- HOOK:GENTYR:toggle-product-manager -->',
  'triage': '<!-- HOOK:GENTYR:triage -->',
  'demo': '<!-- HOOK:GENTYR:demo -->',
  'demo-interactive': '<!-- HOOK:GENTYR:demo -->',
  'demo-auto': '<!-- HOOK:GENTYR:demo -->',
  'persona-feedback': '<!-- HOOK:GENTYR:persona-feedback -->',
};

/**
 * Extract the prompt string from raw stdin.
 * UserPromptSubmit hooks receive JSON like {"prompt":"/cto-report",...}
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
const PRODUCT_MANAGER_DB = path.join(PROJECT_DIR, '.claude', 'state', 'product-manager.db');

// ============================================================================
// Session utilities
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

export function shellEscape(s) {
  if (/^[a-zA-Z0-9._\-/~]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
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

      const dedupeKey = k.account_uuid || `fp:${id}`;
      if (!accountMap.has(dedupeKey) || k.status === 'active') {
        accountMap.set(dedupeKey, {
          email: k.account_email || null,
          uuid: k.account_uuid || null,
          keyId: id.slice(0, 8),
          status: k.status,
          usage: k.last_usage ? {
            five_hour: Math.round(k.last_usage.five_hour ?? 0),
            seven_day: Math.round(k.last_usage.seven_day ?? 0),
            seven_day_sonnet: Math.round(k.last_usage.seven_day_sonnet ?? 0),
          } : null,
          subscription: k.subscriptionType || 'unknown',
        });
      }
    }

    // Cross-match null-UUID keys against UUID-bearing keys with matching usage.
    // Prevents "unknown" accounts when profile resolution hasn't run yet.
    const fpKeys = [...accountMap.keys()].filter(k => k.startsWith('fp:'));
    for (const fpKey of fpKeys) {
      const fpEntry = accountMap.get(fpKey);
      if (!fpEntry.usage) continue;
      for (const [uuidKey, uuidEntry] of accountMap) {
        if (uuidKey.startsWith('fp:') || !uuidEntry.email || !uuidEntry.usage) continue;
        if (uuidEntry.usage.seven_day === fpEntry.usage.seven_day && uuidEntry.usage.seven_day_sonnet === fpEntry.usage.seven_day_sonnet) {
          accountMap.delete(fpKey);
          break;
        }
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

  // Fallback: look for node_modules/gentyr (npm install model) or .claude-framework (legacy symlink)
  if (!frameworkDir) {
    const npmPath = path.join(PROJECT_DIR, 'node_modules', 'gentyr');
    const legacyPath = path.join(PROJECT_DIR, '.claude-framework');
    const frameworkLink = fs.existsSync(npmPath) ? npmPath : legacyPath;
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

function detectProjectFeatures() {
  const EXCLUDE = new Set(['node_modules', '.git', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'coverage', '.cache', '.turbo', '__pycache__']);
  const MAX_FEATURES = 20;
  const features = [];

  function safeReaddir(dirPath) {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && !EXCLUDE.has(d.name));
    } catch {
      return [];
    }
  }

  // Route directories (Next.js app/, SvelteKit routes/, pages/)
  const routeDirs = [
    { base: 'app', source: 'route' },
    { base: path.join('src', 'app'), source: 'route' },
    { base: 'routes', source: 'route' },
    { base: path.join('src', 'routes'), source: 'route' },
    { base: 'pages', source: 'route' },
    { base: path.join('src', 'pages'), source: 'route' },
  ];

  for (const { base, source } of routeDirs) {
    const fullBase = path.join(PROJECT_DIR, base);
    if (!fs.existsSync(fullBase)) continue;
    const subdirs = safeReaddir(fullBase);
    for (const d of subdirs) {
      if (features.length >= MAX_FEATURES) break;
      const relativePath = path.join(base, d.name);
      features.push({
        name: d.name,
        suggested_file_patterns: [`${relativePath}/**`],
        suggested_url_patterns: [`/${d.name}`, `/${d.name}/*`],
        category: 'route',
        source: `${source} directory: ${base}/`,
      });
    }
    if (features.length >= MAX_FEATURES) break;
    break; // Only use the first matching route directory
  }

  // Feature/module directories
  const featureDirs = [
    { base: path.join('src', 'features'), source: 'feature' },
    { base: path.join('src', 'modules'), source: 'module' },
    { base: 'lib', source: 'lib' },
  ];

  for (const { base, source } of featureDirs) {
    const fullBase = path.join(PROJECT_DIR, base);
    if (!fs.existsSync(fullBase)) continue;
    const subdirs = safeReaddir(fullBase);
    for (const d of subdirs) {
      if (features.length >= MAX_FEATURES) break;
      // Skip if already detected as a route
      if (features.some(f => f.name === d.name)) continue;
      const relativePath = path.join(base, d.name);
      features.push({
        name: d.name,
        suggested_file_patterns: [`${relativePath}/**`],
        suggested_url_patterns: [],
        category: source,
        source: `${source} directory: ${base}/`,
      });
    }
  }

  // Component directories (top-level subdirs of src/components)
  if (features.length < MAX_FEATURES) {
    const compBase = path.join('src', 'components');
    const fullCompBase = path.join(PROJECT_DIR, compBase);
    if (fs.existsSync(fullCompBase)) {
      const subdirs = safeReaddir(fullCompBase);
      for (const d of subdirs) {
        if (features.length >= MAX_FEATURES) break;
        if (features.some(f => f.name === d.name)) continue;
        const relativePath = path.join(compBase, d.name);
        features.push({
          name: `components/${d.name}`,
          suggested_file_patterns: [`${relativePath}/**`],
          suggested_url_patterns: [],
          category: 'component',
          source: `component directory: ${compBase}/`,
        });
      }
    }
  }

  return features;
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

  // Auto-detected features (directory structure scan)
  output.gathered.detectedFeatures = detectProjectFeatures();

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
        "SELECT section, COUNT(*) as count FROM tasks WHERE status = 'pending' AND section IN ('CODE-REVIEWER', 'INVESTIGATOR & PLANNER', 'TEST-WRITER', 'PROJECT-MANAGER', 'DEPUTY-CTO', 'PRODUCT-MANAGER') GROUP BY section"
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

function handleProductManager() {
  const output = { command: 'product-manager', gathered: {} };

  // Check feature toggle
  const autonomousConfig = readJson(AUTONOMOUS_MODE_PATH);
  output.gathered.productManagerEnabled = autonomousConfig?.productManagerEnabled === true;

  const pmDb = openDb(PRODUCT_MANAGER_DB);
  if (pmDb) {
    try {
      const meta = pmDb.prepare("SELECT status, last_updated_at, initiated_by, approved_by FROM analysis_meta WHERE id = 'default'").get();
      output.gathered.meta = meta ?? { status: 'not_started' };

      const sections = pmDb.prepare('SELECT section_number, title, content FROM sections ORDER BY section_number').all();
      const sectionStatus = sections.map(s => {
        const isListSection = s.section_number === 2 || s.section_number === 6;
        let populated = false;
        let entryCount = 0;
        if (isListSection) {
          const count = pmDb.prepare('SELECT COUNT(*) as c FROM section_entries WHERE section_number = ?').get(s.section_number);
          entryCount = count?.c ?? 0;
          populated = entryCount >= 3;
        } else {
          populated = !!s.content;
        }
        return { number: s.section_number, title: s.title, populated, entryCount: isListSection ? entryCount : undefined };
      });
      output.gathered.sections = sectionStatus;
      output.gathered.populatedCount = sectionStatus.filter(s => s.populated).length;

      // Compliance
      const totalPainPoints = pmDb.prepare("SELECT COUNT(*) as c FROM section_entries WHERE section_number = 6").get();
      const mappedCount = pmDb.prepare("SELECT COUNT(DISTINCT pain_point_id) as c FROM pain_point_personas").get();
      output.gathered.compliance = {
        totalPainPoints: totalPainPoints?.c ?? 0,
        mapped: mappedCount?.c ?? 0,
      };
    } catch {
      output.gathered.error = 'query failed';
    } finally {
      pmDb.close();
    }
  } else {
    output.gathered.meta = { status: 'not_started' };
    output.gathered.sections = [];
    output.gathered.populatedCount = 0;
    output.gathered.note = 'product-manager.db not found';
  }

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:product-manager] ${JSON.stringify(output)}`,
    },
  }));
}

function handleToggleProductManager() {
  const content = readJson(AUTONOMOUS_MODE_PATH);
  const output = {
    command: 'toggle-product-manager',
    gathered: {
      productManagerEnabled: content?.productManagerEnabled === true,
      autonomousMode: content ?? { error: 'autonomous-mode.json not found' },
    },
  };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:toggle-product-manager] ${JSON.stringify(output)}`,
    },
  }));
}

function handleTriage() {
  const output = { command: 'triage', gathered: {} };

  // cto-reports.db: triage status breakdown
  const triageStats = getTriageStats(CTO_REPORTS_DB);
  output.gathered.triageStats = triageStats ?? { error: 'cto-reports database not found' };

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
      additionalContext: `[PREFETCH:triage] ${JSON.stringify(output)}`,
    },
  }));
}

function handleShow() {
  // Lightweight check: confirm dashboard binary exists and list sections
  const npmPath = path.join(PROJECT_DIR, 'node_modules', 'gentyr');
  const legacyPath = path.join(PROJECT_DIR, '.claude-framework');
  const frameworkLink = fs.existsSync(npmPath) ? npmPath : legacyPath;
  let dashboardExists = false;
  try {
    if (fs.existsSync(frameworkLink)) {
      const frameworkDir = fs.realpathSync(frameworkLink);
      const dashboardPath = path.join(frameworkDir, 'packages', 'cto-dashboard', 'dist', 'index.js');
      dashboardExists = fs.existsSync(dashboardPath);
    }
  } catch {
    // ignore
  }

  // Canonical source: packages/mcp-servers/src/show/types.ts SECTION_IDS
  const sections = [
    'quota', 'accounts', 'deputy-cto', 'usage', 'automations',
    'testing', 'deployments', 'worktrees', 'infra', 'logging',
    'timeline', 'tasks', 'product-market-fit',
  ];

  const output = {
    command: 'show',
    gathered: {
      dashboardAvailable: dashboardExists,
      availableSections: sections,
    },
  };

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:show] ${JSON.stringify(output)}`,
    },
  }));
}

function handlePersonaFeedback() {
  const output = { command: 'persona-feedback', gathered: {} };

  const feedbackDb = openDb(USER_FEEDBACK_DB);
  if (feedbackDb) {
    try {
      // All enabled personas with basic info
      const personas = feedbackDb.prepare(
        "SELECT id, name, consumption_mode, enabled FROM personas ORDER BY name"
      ).all();
      output.gathered.personas = personas;
      output.gathered.enabledCount = personas.filter(p => p.enabled).length;

      // Recent feedback runs (last 5)
      try {
        const runs = feedbackDb.prepare(
          "SELECT id, trigger_type, status, started_at FROM feedback_runs ORDER BY started_at DESC LIMIT 5"
        ).all();
        output.gathered.recentRuns = runs;
      } catch {
        output.gathered.recentRuns = [];
      }

      // Per-persona last session date and satisfaction (lightweight)
      try {
        const perPersona = feedbackDb.prepare(`
          SELECT
            p.id,
            p.name,
            (SELECT MAX(s.completed_at) FROM feedback_sessions s WHERE s.persona_id = p.id) as last_session_date,
            (SELECT s.satisfaction_level FROM feedback_sessions s WHERE s.persona_id = p.id ORDER BY s.completed_at DESC LIMIT 1) as last_satisfaction
          FROM personas p
          WHERE p.enabled = 1
          ORDER BY p.name
        `).all();
        output.gathered.perPersonaStats = perPersona;
      } catch {
        output.gathered.perPersonaStats = [];
      }

      // Overview stats
      try {
        const totalSessions = feedbackDb.prepare("SELECT COUNT(*) as count FROM feedback_sessions").get();
        output.gathered.totalSessions = totalSessions?.count ?? 0;
      } catch {
        output.gathered.totalSessions = 0;
      }

      try {
        const totalFindings = feedbackDb.prepare("SELECT COALESCE(SUM(findings_count), 0) as count FROM feedback_sessions").get();
        output.gathered.totalFindings = totalFindings?.count ?? 0;
      } catch {
        output.gathered.totalFindings = 0;
      }
    } catch {
      output.gathered.error = 'query failed';
    } finally {
      feedbackDb.close();
    }
  } else {
    output.gathered.personas = [];
    output.gathered.enabledCount = 0;
    output.gathered.recentRuns = [];
    output.gathered.perPersonaStats = [];
    output.gathered.totalSessions = 0;
    output.gathered.totalFindings = 0;
    output.gathered.note = 'user-feedback.db not found (no personas configured yet)';
  }

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:persona-feedback] ${JSON.stringify(output)}`,
    },
  }));
}

function handleDemo() {
  const output = { command: 'demo', gathered: {} };

  // Check playwright.config.ts existence
  const tsConfig = path.join(PROJECT_DIR, 'playwright.config.ts');
  const jsConfig = path.join(PROJECT_DIR, 'playwright.config.js');
  output.gathered.configExists = fs.existsSync(tsConfig) || fs.existsSync(jsConfig);
  output.gathered.configPath = fs.existsSync(tsConfig) ? 'playwright.config.ts' : (fs.existsSync(jsConfig) ? 'playwright.config.js' : null);

  // Check @playwright/test in node_modules
  const pwTestDir = path.join(PROJECT_DIR, 'node_modules', '@playwright', 'test');
  output.gathered.depsInstalled = fs.existsSync(pwTestDir);

  // Check Chromium in browser cache directories
  const cacheLocations = [
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ];
  let browsersFound = false;
  for (const cacheDir of cacheLocations) {
    if (!fs.existsSync(cacheDir)) continue;
    try {
      const entries = fs.readdirSync(cacheDir);
      if (entries.some(e => e.startsWith('chromium-'))) {
        browsersFound = true;
        break;
      }
    } catch {
      // ignore
    }
  }
  output.gathered.browsersInstalled = browsersFound;

  // Credential env var status
  const credentialKeys = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  const credentials = {};
  for (const key of credentialKeys) {
    const value = process.env[key];
    if (!value) {
      credentials[key] = 'missing';
    } else if (value.startsWith('op://')) {
      credentials[key] = 'unresolved_op_ref';
    } else {
      credentials[key] = 'set';
    }
  }
  output.gathered.credentials = credentials;

  // Test file counts per project directory
  const activeDirs = {
    'vendor-owner': 'e2e/vendor',
    'manual': 'e2e/manual',
    'extension-manual': 'e2e/extension/manual',
    'demo': 'e2e/demo',
  };
  const testCounts = {};
  for (const [project, testDir] of Object.entries(activeDirs)) {
    const fullDir = path.join(PROJECT_DIR, testDir);
    if (!fs.existsSync(fullDir)) {
      testCounts[project] = 0;
      continue;
    }
    try {
      const files = fs.readdirSync(fullDir, { recursive: true });
      testCounts[project] = files.filter(f => {
        const filename = String(f);
        return filename.endsWith('.spec.ts') || filename.endsWith('.manual.ts');
      }).length;
    } catch {
      testCounts[project] = 0;
    }
  }
  output.gathered.testCounts = testCounts;

  // Fast path: read cached health signal from SessionStart hook
  const healthFile = path.join(PROJECT_DIR, '.claude', 'playwright-health.json');
  let authCheckedFromCache = false;
  if (fs.existsSync(healthFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(healthFile, 'utf-8'));
      const cacheAge = Date.now() - new Date(cached.checkedAt).getTime();
      if (cacheAge < 3_600_000) { // 1 hour
        output.gathered.authState = cached.authState;
        output.gathered.extensionBuilt = cached.extensionBuilt;
        authCheckedFromCache = true;
      }
    } catch { /* ignore — fall through to manual checks */ }
  }

  // Auth state freshness (manual check if cache miss)
  if (!authCheckedFromCache) {
    const authDir = path.join(PROJECT_DIR, '.auth');
    const primaryAuth = path.join(authDir, 'vendor-owner.json');
    let authState = { exists: false, ageHours: null, cookiesExpired: false, isStale: true };

    if (fs.existsSync(primaryAuth)) {
      try {
        const stat = fs.statSync(primaryAuth);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageHours = ageMs / (1000 * 60 * 60);

        let cookiesExpired = false;
        try {
          const state = JSON.parse(fs.readFileSync(primaryAuth, 'utf-8'));
          const now = Date.now() / 1000;
          const cookies = state.cookies || [];
          cookiesExpired = cookies.some(c => c.expires && c.expires > 0 && c.expires < now);
        } catch { /* ignore */ }

        authState = {
          exists: true,
          ageHours: Math.round(ageHours * 10) / 10,
          cookiesExpired,
          isStale: cookiesExpired || ageHours > 24,
        };
      } catch { /* ignore */ }
    }
    output.gathered.authState = authState;
  }

  // Summary: critical issues
  const criticalIssues = [];
  if (!output.gathered.configExists) criticalIssues.push('playwright.config.ts not found');
  if (!output.gathered.depsInstalled) criticalIssues.push('@playwright/test not installed');
  if (!output.gathered.browsersInstalled) criticalIssues.push('Chromium browser not installed');
  output.gathered.criticalIssues = criticalIssues;
  output.gathered.readyForPreflight = criticalIssues.length === 0;

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `[PREFETCH:demo] ${JSON.stringify(output)}`,
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

  // Mode 2 handlers — load Database lazily only when needed
  const needsDb = ['cto-report', 'deputy-cto', 'configure-personas', 'spawn-tasks', 'product-manager', 'triage', 'persona-feedback'];
  const matchedCommand = Object.keys(SENTINELS).find(key => matchesCommand(prompt, key));
  if (matchedCommand) {
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
  if (matchesCommand(prompt, 'product-manager')) {
    return handleProductManager();
  }
  if (matchesCommand(prompt, 'toggle-product-manager')) {
    return handleToggleProductManager();
  }
  if (matchesCommand(prompt, 'triage')) {
    return handleTriage();
  }
  if (matchesCommand(prompt, 'persona-feedback')) {
    return handlePersonaFeedback();
  }
  if (matchesCommand(prompt, 'show')) {
    return handleShow();
  }
  if (matchesCommand(prompt, 'demo')) {
    return handleDemo();
  }
  if (matchesCommand(prompt, 'demo-interactive')) {
    return handleDemo();
  }
  if (matchesCommand(prompt, 'demo-auto')) {
    return handleDemo();
  }

  process.exit(0);
}

main().catch(() => {
  // All errors: silent exit, Claude falls back to MCP tools
  process.exit(0);
});
