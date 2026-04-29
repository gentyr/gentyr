/**
 * LLM Client - Shared LLM call helpers
 *
 * Calls `claude -p` to get text or structured JSON output from Haiku.
 * Uses OAuth auth from the Max subscription via the Claude CLI.
 *
 * Child process lifecycle:
 * - All spawned `claude -p` processes are tracked in `activeChildPids`
 * - `killSignal: 'SIGKILL'` ensures hung processes die on timeout
 *   (SIGTERM is insufficient — claude -p ignores it and spins at 100% CPU)
 * - Callers that run as daemons should call `killActiveChildren()` in their
 *   SIGTERM/SIGINT handlers to prevent orphaned processes on restart
 *
 * @version 2.0.0
 */

import childProcess from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEFAULT_MODEL = 'haiku';
const DEFAULT_TIMEOUT = 60000;

// Track all in-flight child PIDs so daemon callers can kill them on shutdown
export const activeChildPids = new Set();

/**
 * Kill all tracked child processes. Call from SIGTERM/SIGINT handlers
 * to prevent orphaned `claude -p` processes when the parent daemon restarts.
 */
export function killActiveChildren() {
  for (const pid of activeChildPids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ESRCH — already dead */ }
  }
  activeChildPids.clear();
}

// Test-only override: set via _setTestHandler() to bypass real LLM calls in tests
let _testHandler = null;

/**
 * Set a test handler that intercepts all LLM calls.
 * Pass null to restore real behavior. Only for use in test files.
 * @param {Function|null} handler - (prompt, systemPrompt, jsonSchema, opts) => result
 */
export function _setTestHandler(handler) {
  _testHandler = handler;
}

/**
 * Internal: spawn `claude -p` with child PID tracking.
 * @returns {Promise<string>} stdout
 */
function execClaude(args, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  return new Promise((resolve, reject) => {
    const child = childProcess.execFile('claude', args, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
    }, (err, stdout) => {
      activeChildPids.delete(child.pid);
      if (err) return reject(err);
      resolve(stdout);
    });
    if (child.pid) activeChildPids.add(child.pid);
  });
}

/**
 * Call LLM with plain text output.
 * Returns { text, tokens } or null on failure.
 *
 * @param {string} prompt - The user prompt
 * @param {string|null} systemPrompt - Optional system prompt
 * @param {object} [opts] - Options
 * @param {string} [opts.model='haiku'] - Model override
 * @param {number} [opts.timeout=60000] - Timeout in ms
 * @returns {Promise<{text: string, tokens: number}|null>}
 */
export async function callLLM(prompt, systemPrompt, opts = {}) {
  if (_testHandler) return _testHandler(prompt, systemPrompt, null, opts);

  const model = opts.model || DEFAULT_MODEL;
  const args = ['-p', prompt, '--model', model, '--output-format', 'json'];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  try {
    const stdout = await execClaude(args, opts);
    const data = JSON.parse(stdout);
    return {
      text: data.result || '',
      tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    };
  } catch {
    return null;
  }
}

/**
 * Call LLM with structured JSON output via --json-schema.
 * Returns the parsed result object directly, or null on failure.
 *
 * @param {string} prompt - The user prompt
 * @param {string|null} systemPrompt - Optional system prompt
 * @param {string} jsonSchema - JSON-stringified schema for --json-schema
 * @param {object} [opts] - Options
 * @param {string} [opts.model='haiku'] - Model override
 * @param {number} [opts.timeout=60000] - Timeout in ms
 * @returns {Promise<object|null>} Parsed result or null on error
 */
export async function callLLMStructured(prompt, systemPrompt, jsonSchema, opts = {}) {
  if (_testHandler) return _testHandler(prompt, systemPrompt, jsonSchema, opts);

  const model = opts.model || DEFAULT_MODEL;
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', jsonSchema];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  try {
    const stdout = await execClaude(args, opts);
    const data = JSON.parse(stdout);
    if (typeof data.result === 'string') {
      return JSON.parse(data.result);
    }
    return data.result || data;
  } catch {
    return null;
  }
}
