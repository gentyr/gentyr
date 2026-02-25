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
 * @version 1.1.0
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const FRAMEWORK_PATH = path.resolve(__dirname, '..', '..');
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
async function getPersona(personaId, projectDir = PROJECT_DIR) {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    console.error('better-sqlite3 not available');
    process.exit(1);
  }

  const dbPath = path.join(projectDir, '.claude', 'user-feedback.db');
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
 * Prepare a scratch workspace for SDK/ADK personas.
 * Creates a temp directory, initializes npm, and installs the SDK packages.
 * Returns the workspace path.
 */
async function prepareWorkspace(persona, sessionId) {
  const tmpDir = path.join(os.tmpdir(), 'gentyr-feedback');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const workspaceDir = path.join(tmpDir, `workspace-${sessionId}`);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const sdkPackages = persona.endpoints[0] || '';
  if (!sdkPackages) {
    process.stderr.write(`[feedback] Warning: persona "${persona.name}" has no SDK packages in endpoints[0]\n`);
    return workspaceDir;
  }

  try {
    // Initialize package.json
    execFileSync('npm', ['init', '-y'], {
      cwd: workspaceDir,
      timeout: 30000,
      stdio: 'pipe',
    });

    // Install SDK packages
    const packages = sdkPackages.split(',').map(p => p.trim()).filter(Boolean);
    if (packages.length > 0) {
      execFileSync('npm', ['install', ...packages], {
        cwd: workspaceDir,
        timeout: 120000, // 2-minute timeout
        stdio: 'pipe',
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[feedback] Warning: workspace setup failed for "${persona.name}": ${message}\n`);
    // Non-fatal: workspace exists but packages may not be installed
  }

  return workspaceDir;
}

/**
 * Generate temporary MCP config with ONLY feedback-specific servers.
 * This is the key isolation mechanism - the feedback agent cannot access
 * any project MCP servers (todo-db, specs-browser, deputy-cto, etc.)
 */
function generateMcpConfig(sessionId, persona, projectDir = PROJECT_DIR) {
  const config = { mcpServers: {} };

  const mode = persona.consumption_mode;

  if (mode === 'gui') {
    config.mcpServers['playwright-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'playwright-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: projectDir,
        FEEDBACK_BASE_URL: persona.endpoints[0] || 'http://localhost:3000',
        FEEDBACK_BROWSER_HEADLESS: 'true',
        FEEDBACK_SESSION_ID: sessionId,
        FEEDBACK_PERSONA_NAME: persona.name,
      },
    };
  }

  if (mode === 'cli') {
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: projectDir,
        FEEDBACK_MODE: 'cli',
        FEEDBACK_CLI_COMMAND: persona.endpoints[0] || '',
        FEEDBACK_SESSION_ID: sessionId,
        FEEDBACK_PERSONA_NAME: persona.name,
      },
    };
  }

  if (mode === 'api') {
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: projectDir,
        FEEDBACK_MODE: 'api',
        FEEDBACK_API_BASE_URL: persona.endpoints[0] || 'http://localhost:3000/api',
        FEEDBACK_SESSION_ID: sessionId,
        FEEDBACK_PERSONA_NAME: persona.name,
      },
    };
  }

  if (mode === 'sdk') {
    // SDK gets programmatic-feedback for quick code evals
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: projectDir,
        FEEDBACK_MODE: 'sdk',
        FEEDBACK_SDK_PACKAGES: persona.endpoints[0] || '',
        FEEDBACK_SESSION_ID: sessionId,
        FEEDBACK_PERSONA_NAME: persona.name,
      },
    };

    // SDK also gets playwright-feedback for browsing docs portal (if configured)
    const docsUrl = persona.endpoints[1];
    if (docsUrl) {
      config.mcpServers['playwright-feedback'] = {
        command: 'node',
        args: [path.join(MCP_SERVERS_DIST, 'playwright-feedback', 'server.js')],
        env: {
          CLAUDE_PROJECT_DIR: projectDir,
          FEEDBACK_BASE_URL: docsUrl,
          FEEDBACK_BROWSER_HEADLESS: 'true',
          FEEDBACK_SESSION_ID: sessionId,
          FEEDBACK_PERSONA_NAME: persona.name,
        },
      };
    }
  }

  if (mode === 'adk') {
    // ADK gets programmatic-feedback for quick code evals
    config.mcpServers['programmatic-feedback'] = {
      command: 'node',
      args: [path.join(MCP_SERVERS_DIST, 'programmatic-feedback', 'server.js')],
      env: {
        CLAUDE_PROJECT_DIR: projectDir,
        FEEDBACK_MODE: 'sdk',
        FEEDBACK_SDK_PACKAGES: persona.endpoints[0] || '',
        FEEDBACK_SESSION_ID: sessionId,
        FEEDBACK_PERSONA_NAME: persona.name,
      },
    };

    // ADK also gets docs-feedback for programmatic docs access (if configured)
    const docsPath = persona.endpoints[1];
    if (docsPath) {
      config.mcpServers['docs-feedback'] = {
        command: 'node',
        args: [path.join(MCP_SERVERS_DIST, 'docs-feedback', 'server.js')],
        env: {
          CLAUDE_PROJECT_DIR: projectDir,
          FEEDBACK_DOCS_PATH: docsPath,
          FEEDBACK_SESSION_ID: sessionId,
          FEEDBACK_PERSONA_NAME: persona.name,
        },
      };
    }
  }

  // Always include feedback-reporter (for submitting findings)
  config.mcpServers['feedback-reporter'] = {
    command: 'node',
    args: [path.join(MCP_SERVERS_DIST, 'feedback-reporter', 'server.js')],
    env: {
      CLAUDE_PROJECT_DIR: projectDir,
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

  let prompt = `[Task][feedback-persona-${persona.name}] You are "${persona.name}": ${persona.description}

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

  // Mode-specific guidance
  if (persona.consumption_mode === 'gui') {
    prompt += `\n\n## GUI Testing Notes\n\nYour browser starts on a blank page. Your FIRST action must be to navigate to the application:\n`;
    prompt += `- Use the \`navigate\` tool with URL: ${persona.endpoints[0] || 'http://localhost:3000'}\n`;
    prompt += `- After navigating, use \`read_visible_text\` or \`screenshot\` to see what's on the page\n`;
    prompt += `- Interact with elements using their visible text or ARIA roles — you cannot use CSS selectors`;
  }

  if (persona.consumption_mode === 'sdk') {
    prompt += `\n\n## SDK Developer Testing Notes\n\nYou are a developer with a scratch workspace where the SDK is pre-installed. You have Claude Code tools (Bash, Read, Write, Edit, Glob, Grep) to write and run test scripts.\n`;
    prompt += `\nFor quick code evaluations, use \`mcp__programmatic-feedback__sdk_eval\` — each call runs in an isolated sandbox.\n`;
    prompt += `For more realistic testing, write .js/.ts files in your workspace and run them with Bash.\n`;
    prompt += `\nFocus on:\n`;
    prompt += `- Getting-started experience: Can you install and import the SDK?\n`;
    prompt += `- API discoverability: Can you find the functions you need?\n`;
    prompt += `- Error messages: Are they helpful when you pass wrong arguments?\n`;
    prompt += `- Type correctness: Do TypeScript types match runtime behavior?\n`;

    if (persona.endpoints[1]) {
      prompt += `\nYou also have Playwright browser tools to browse the developer docs portal at: ${persona.endpoints[1]}\n`;
      prompt += `Use \`navigate\`, \`read_visible_text\`, and \`screenshot\` to check docs quality and accuracy.`;
    } else {
      prompt += `\n**Note:** Documentation is not configured for this persona. You can only test the SDK code directly. To enable docs access, run \`/configure-personas\` and set the docs URL for this persona.`;
    }
  }

  if (persona.consumption_mode === 'adk') {
    prompt += `\n\n## ADK Agent Testing Notes\n\nYou are an AI agent with a scratch workspace where the SDK is pre-installed. You have Claude Code tools (Bash, Read, Write, Edit, Glob, Grep) to write and run test scripts.\n`;
    prompt += `\nFor quick code evaluations, use \`mcp__programmatic-feedback__sdk_eval\` — each call runs in an isolated sandbox.\n`;
    prompt += `For more realistic testing, write .js/.ts files in your workspace and run them with Bash.\n`;
    prompt += `\nFocus on:\n`;
    prompt += `- Docs discoverability: Can you find what you need via \`docs_search\`?\n`;
    prompt += `- Structured error responses: Do errors contain actionable information?\n`;
    prompt += `- API orthogonality: Are naming conventions consistent? Do similar things work similarly?\n`;
    prompt += `- Programmatic consumption: Are docs machine-parseable? Are code examples copy-pasteable?\n`;

    if (persona.endpoints[1]) {
      prompt += `\nYou have MCP docs tools to search and read documentation programmatically:\n`;
      prompt += `- \`mcp__docs-feedback__docs_search\` — Search docs by keywords\n`;
      prompt += `- \`mcp__docs-feedback__docs_list\` — List all available doc files\n`;
      prompt += `- \`mcp__docs-feedback__docs_read\` — Read a specific doc file\n`;
    } else {
      prompt += `\n**Note:** Documentation is not configured for this persona. You can only test the SDK code directly. To enable docs access, run \`/configure-personas\` and set the docs directory for this persona.`;
    }
  }

  return prompt;
}

/**
 * Spawn an isolated feedback agent session.
 * Fire-and-forget: the process is detached and unreferenced.
 */
function spawnFeedbackAgent(mcpConfigPath, prompt, sessionId, personaName, options = {}) {
  const projectDir = options.projectDir || PROJECT_DIR;
  const model = options.model || 'sonnet';
  const tools = options.tools !== undefined ? options.tools : '';
  const cwd = options.cwd || projectDir;

  const spawnArgs = [
    '--dangerously-skip-permissions',
    '--tools', tools,
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--model', model,
    '--output-format', 'json',
    '-p',
    prompt,
  ];

  const claude = spawn('claude', spawnArgs, {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
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
 * Run a feedback agent session and wait for completion.
 * Unlike spawnFeedbackAgent (fire-and-forget), this returns a promise
 * that resolves when the Claude session finishes.
 * Used by E2E tests to await session completion.
 */
function runFeedbackAgent(mcpConfigPath, prompt, sessionId, personaName, options = {}) {
  const projectDir = options.projectDir || PROJECT_DIR;
  const timeout = options.timeout || 120000;
  const model = options.model || 'sonnet';
  const tools = options.tools !== undefined ? options.tools : '';
  const cwd = options.cwd || projectDir;

  const spawnArgs = [
    '--dangerously-skip-permissions',
    '--tools', tools,
    '--strict-mcp-config',
    '--mcp-config', mcpConfigPath,
    '--model', model,
    '--output-format', 'json',
    '-p',
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', spawnArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_SPAWNED_SESSION: 'true',
        FEEDBACK_SESSION_ID: sessionId,
        FEEDBACK_PERSONA_NAME: personaName,
      },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
      reject(new Error(
        `Feedback agent timed out after ${timeout}ms.\n` +
        `stderr: ${stderr.slice(0, 500)}\n` +
        `stdout (last 500 chars): ${stdout.slice(-500)}`
      ));
    }, timeout);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn Claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, pid: proc.pid });
    });
  });
}

/**
 * Cleanup temporary MCP config files older than 1 hour.
 */
function cleanupOldConfigs() {
  const tmpDir = path.join(os.tmpdir(), 'gentyr-feedback');
  if (!fs.existsSync(tmpDir)) return;

  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  try {
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const entryPath = path.join(tmpDir, entry);
      const stat = fs.statSync(entryPath);
      if (stat.mtimeMs < oneHourAgo) {
        if (stat.isDirectory() && entry.startsWith('workspace-')) {
          // Remove old workspace directories recursively
          fs.rmSync(entryPath, { recursive: true, force: true });
        } else if (stat.isFile()) {
          fs.unlinkSync(entryPath);
        }
      }
    }
  } catch {
    // Non-fatal: old config/workspace cleanup failure is not critical
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

  // Prepare workspace for SDK/ADK modes
  const spawnOptions = {};
  const mode = persona.consumption_mode;
  if (mode === 'sdk' || mode === 'adk') {
    const workspaceDir = await prepareWorkspace(persona, sessionId);
    spawnOptions.cwd = workspaceDir;
    spawnOptions.tools = 'Bash,Read,Write,Edit,Glob,Grep';
    console.log(`Prepared workspace: ${workspaceDir}`);
  }

  // Generate isolated MCP config
  const mcpConfigPath = generateMcpConfig(sessionId, persona);
  console.log(`Generated MCP config: ${mcpConfigPath}`);

  // Build persona-specific prompt
  const prompt = buildPrompt(persona, sessionId);

  // Spawn isolated session
  const result = spawnFeedbackAgent(mcpConfigPath, prompt, sessionId, persona.name, spawnOptions);
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
export { getPersona, generateMcpConfig, buildPrompt, spawnFeedbackAgent, runFeedbackAgent, cleanupOldConfigs, prepareWorkspace };

// Run if called directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch(err => {
    console.error(`Feedback launcher error: ${err.message}`);
    process.exit(1);
  });
}
