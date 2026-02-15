#!/usr/bin/env node
/**
 * Feedback Launcher
 *
 * Generates temporary MCP configs and spawns isolated feedback agent sessions.
 * Called by the orchestrator (hourly-automation.js feedback pipeline block)
 * or manually for testing.
 *
 * Usage:
 *   node feedback-launcher.js --persona-id <id> --session-id <id> --run-id <id>
 *
 * The launcher:
 * 1. Reads persona details from user-feedback.db
 * 2. Generates a temporary feedback-mcp.json with ONLY feedback servers
 * 3. Spawns an isolated Claude session with --tools "" --strict-mcp-config
 * 4. Returns the spawned process info
 *
 * NOTE: This file should be moved to .claude/hooks/ during setup:
 *   sudo scripts/setup.sh --path /path/to/project --unprotect-only
 *   cp scripts/feedback-launcher.js .claude/hooks/feedback-launcher.js
 *   sudo scripts/setup.sh --path /path/to/project --protect-only
 *
 * @version 1.0.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAMEWORK_PATH = path.resolve(__dirname, '..');
const MCP_SERVERS_DIST = path.join(FRAMEWORK_PATH, 'packages', 'mcp-servers', 'dist');

// Parse CLI args
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) {
      parsed[key] = value;
    }
  }
  return parsed;
}

/**
 * Read persona details from user-feedback.db
 */
async function getPersona(personaId) {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    console.error('better-sqlite3 not available');
    process.exit(1);
  }

  const dbPath = path.join(PROJECT_DIR, '.claude', 'user-feedback.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`User feedback DB not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const persona = db.prepare('SELECT * FROM personas WHERE id = ?').get(personaId);
  if (!persona) {
    db.close();
    console.error(`Persona not found: ${personaId}`);
    process.exit(1);
  }

  // Get mapped features with test scenarios
  const features = db.prepare(`
    SELECT pf.feature_id, pf.priority, pf.test_scenarios, f.name, f.description, f.url_patterns
    FROM persona_features pf
    JOIN features f ON f.id = pf.feature_id
    WHERE pf.persona_id = ?
    ORDER BY CASE pf.priority
      WHEN 'critical' THEN 1
      WHEN 'high' THEN 2
      WHEN 'normal' THEN 3
      WHEN 'low' THEN 4
    END
  `).all(personaId);

  db.close();

  return {
    ...persona,
    behavior_traits: JSON.parse(persona.behavior_traits || '[]'),
    endpoints: JSON.parse(persona.endpoints || '[]'),
    features: features.map(f => ({
      ...f,
      test_scenarios: JSON.parse(f.test_scenarios || '[]'),
      url_patterns: JSON.parse(f.url_patterns || '[]'),
    })),
  };
}

/**
 * Generate temporary MCP config with ONLY feedback-specific servers.
 * This is the key isolation mechanism - the feedback agent cannot access
 * any project MCP servers (todo-db, specs-browser, deputy-cto, etc.)
 */
function generateMcpConfig(sessionId, persona) {
  const config = { mcpServers: {} };

  const mode = persona.consumption_mode;

  if (mode === 'gui') {
    config.mcpServers['playwright-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'playwright-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        FEEDBACK_BASE_URL: persona.endpoints[0] || 'http://localhost:3000',
        FEEDBACK_BROWSER_HEADLESS: 'true',
      },
    };
  }

  if (mode === 'cli') {
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        FEEDBACK_MODE: 'cli',
        FEEDBACK_CLI_COMMAND: persona.endpoints[0] || '',
      },
    };
  }

  if (mode === 'api') {
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        FEEDBACK_MODE: 'api',
        FEEDBACK_API_BASE_URL: persona.endpoints[0] || 'http://localhost:3000/api',
      },
    };
  }

  if (mode === 'sdk') {
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: PROJECT_DIR,
        FEEDBACK_MODE: 'sdk',
        FEEDBACK_SDK_PACKAGES: persona.endpoints[0] || '',
      },
    };
  }

  // Always include feedback-reporter (for submitting findings)
  config.mcpServers['feedback-reporter'] = {
    command: 'node',
    args: [path.join(MCP_SERVERS_DIST, 'feedback-reporter', 'server.js')],
    env: {
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      FEEDBACK_PERSONA_NAME: persona.name,
      FEEDBACK_SESSION_ID: sessionId,
    },
  };

  // Write to temp file
  const tmpDir = path.join(os.tmpdir(), 'gentyr-feedback');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }
  const configPath = path.join(tmpDir, `feedback-${sessionId}-mcp.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return configPath;
}

/**
 * Build the system prompt for the feedback agent.
 * This is persona-specific - no CLAUDE.md, no project context, no source code.
 */
function buildPrompt(persona, sessionId) {
  const traits = persona.behavior_traits.length > 0
    ? persona.behavior_traits.map(t => `- ${t}`).join('\n')
    : '- (no specific traits defined)';

  const featuresBlock = persona.features.map(f => {
    const scenarios = f.test_scenarios.length > 0
      ? f.test_scenarios.map(s => `    - ${s}`).join('\n')
      : '    - Explore this feature freely as your persona would';
    return `  **${f.name}**${f.description ? ` - ${f.description}` : ''}\n  Test scenarios:\n${scenarios}`;
  }).join('\n\n');

  return `[Task][feedback-persona-${persona.name}] You are "${persona.name}": ${persona.description}

## Your Behavioral Traits
${traits}

## Features to Test
${featuresBlock || '  No specific features assigned. Explore the application freely.'}

## Session Info
- Session ID: ${sessionId}
- Consumption mode: ${persona.consumption_mode}

## Instructions

You are NOT a developer. You are a real user testing this product.

1. Test each feature/scenario listed above
2. Report any issues via mcp__feedback-reporter__submit_finding
3. When done, submit a session summary via mcp__feedback-reporter__submit_summary
4. Focus on what YOU as "${persona.name}" would notice and care about

If something is confusing or broken, REPORT IT. That's your job.
Do NOT try to debug or fix issues. Just report what you experience.`;
}

/**
 * Spawn an isolated feedback agent session.
 * Fire-and-forget: the process is detached and unreferenced.
 */
function spawnFeedbackAgent(mcpConfigPath, prompt, sessionId, personaName) {
  const spawnArgs = [
    '--dangerously-skip-permissions',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--model', 'sonnet',
    '--output-format', 'json',
    '-p',
    prompt,
  ];

  const claude = spawn('claude', spawnArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: PROJECT_DIR,
      CLAUDE_SPAWNED_SESSION: 'true',
      FEEDBACK_SESSION_ID: sessionId,
      FEEDBACK_PERSONA_NAME: personaName,
    },
  });

  claude.unref();

  return {
    pid: claude.pid,
    mcpConfigPath,
  };
}

/**
 * Cleanup temporary MCP config files older than 1 hour.
 */
function cleanupOldConfigs() {
  const tmpDir = path.join(os.tmpdir(), 'gentyr-feedback');
  if (!fs.existsSync(tmpDir)) return;

  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  try {
    const files = fs.readdirSync(tmpDir);
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // Non-fatal: old config cleanup failure is not critical
  }
}

/**
 * Main entry point
 */
async function main() {
  const args = parseArgs();

  if (!args['persona-id'] || !args['session-id']) {
    console.error('Usage: feedback-launcher.js --persona-id <id> --session-id <id> [--run-id <id>]');
    process.exit(1);
  }

  const personaId = args['persona-id'];
  const sessionId = args['session-id'];

  // Clean up old temp configs
  cleanupOldConfigs();

  // Get persona details
  const persona = await getPersona(personaId);
  console.log(`Launching feedback agent for persona "${persona.name}" (${persona.consumption_mode} mode)`);

  // Generate isolated MCP config
  const mcpConfigPath = generateMcpConfig(sessionId, persona);
  console.log(`Generated MCP config: ${mcpConfigPath}`);

  // Build persona-specific prompt
  const prompt = buildPrompt(persona, sessionId);

  // Spawn isolated session
  const result = spawnFeedbackAgent(mcpConfigPath, prompt, sessionId, persona.name);
  console.log(`Spawned feedback agent PID: ${result.pid}`);

  // Output JSON for orchestrator consumption
  console.log(JSON.stringify({
    success: true,
    persona_name: persona.name,
    session_id: sessionId,
    pid: result.pid,
    mcp_config: mcpConfigPath,
  }));
}

// Export for use by hourly-automation.js
export { getPersona, generateMcpConfig, buildPrompt, spawnFeedbackAgent, cleanupOldConfigs };

// Run if called directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(`Feedback launcher error: ${err.message}`);
    process.exit(1);
  });
}
