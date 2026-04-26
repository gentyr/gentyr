/**
 * LLM Client - Shared structured LLM call helper
 *
 * Extracted from scripts/session-activity-broadcaster.js.
 * Calls `claude -p --json-schema` to get structured JSON output from Haiku.
 *
 * @version 1.0.0
 */

import childProcess from 'child_process';
import { promisify } from 'util';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// Test-only override: set via _setTestHandler() to bypass real LLM calls in tests
let _testHandler = null;

/**
 * Set a test handler that intercepts all callLLMStructured calls.
 * Pass null to restore real behavior. Only for use in test files.
 * @param {Function|null} handler - (prompt, systemPrompt, jsonSchema, opts) => result
 */
export function _setTestHandler(handler) {
  _testHandler = handler;
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
  // Test bypass: return mock result without spawning a subprocess
  if (_testHandler) return _testHandler(prompt, systemPrompt, jsonSchema, opts);

  const model = opts.model || 'haiku';
  const timeout = opts.timeout || 60000;

  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', jsonSchema];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  try {
    const execFileAsync = promisify(childProcess.execFile);
    const { stdout } = await execFileAsync('claude', args, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout,
      env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
    });
    const data = JSON.parse(stdout);
    // --json-schema output wraps the structured result in data.result (as a JSON string)
    if (typeof data.result === 'string') {
      return JSON.parse(data.result);
    }
    return data.result || data;
  } catch (err) {
    // Non-fatal: caller handles null
    return null;
  }
}
