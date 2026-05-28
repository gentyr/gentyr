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
 * Session persistence: always passes `--no-session-persistence` to `claude -p`.
 * We never resume these subprocesses; the JSONL transcript would only pollute
 * `~/.claude/projects/<encoded-cwd>/` and be misread by agents browsing
 * sessions. Token attribution still works — `--output-format json` returns
 * `usage` in stdout, which is persisted to `subprocess_calls.{input,output,
 * cache_read,cache_creation}_tokens` for the token-usage collector.
 *
 * @version 3.0.0
 */

import childProcess from 'child_process';
import {
  startSubprocessCall,
  finishSubprocessCall,
  getCurrentParentSessionId,
} from './subprocess-call-tracker.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const DEFAULT_MODEL = 'haiku';
const DEFAULT_TIMEOUT = 60000;

// Warn once per untagged caller per process so we notice instrumentation gaps
const _untaggedWarned = new Set();

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
 * Resolve the caller tag for this invocation. Warns once per process if
 * a caller forgot to pass `opts.tag`.
 */
function resolveCallerTag(opts, callsite) {
  const tag = opts && typeof opts.tag === 'string' && opts.tag.trim()
    ? opts.tag.trim()
    : 'untagged';
  if (tag === 'untagged' && !_untaggedWarned.has(callsite)) {
    _untaggedWarned.add(callsite);
    try {
      process.stderr.write(
        `[llm-client] ${callsite} invoked without opts.tag — token usage will attribute to 'subprocess:untagged'\n`
      );
    } catch { /* non-fatal */ }
  }
  return tag;
}

/**
 * Internal: spawn `claude -p` with child PID tracking and subprocess_calls
 * recording for token-usage attribution.
 *
 * Returns `{ stdout, data }` where `data` is the parsed `--output-format json`
 * envelope (`{ result, usage: { input_tokens, output_tokens, cache_*_tokens } }`)
 * so callers can hand token counts to `finishSubprocessCall` for attribution.
 *
 * Always appends `--no-session-persistence` so `claude -p` does not write a
 * JSONL transcript to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 *
 * @returns {Promise<{stdout: string, data: object|null}>}
 */
function execClaude(args, opts = {}, callerTag = 'untagged') {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const model = opts.model || DEFAULT_MODEL;
  const parentSessionId = getCurrentParentSessionId();
  const rowId = startSubprocessCall({ caller: callerTag, model, parentSessionId });

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CLAUDE_SPAWNED_SESSION: 'true',
      CLAUDE_USAGE_TAG: callerTag,
    };
    if (parentSessionId) env.CLAUDE_USAGE_PARENT = parentSessionId;

    const fullArgs = args.includes('--no-session-persistence')
      ? args
      : [...args, '--no-session-persistence'];

    const child = childProcess.execFile('claude', fullArgs, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      env,
    }, (err, stdout) => {
      activeChildPids.delete(child.pid);
      let data = null;
      try { data = stdout ? JSON.parse(stdout) : null; } catch { /* non-JSON output — leave null */ }
      const usage = data?.usage || {};
      finishSubprocessCall(rowId, {
        pid: child.pid || null,
        exitCode: err ? (err.code || 1) : 0,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        cacheReadTokens: usage.cache_read_input_tokens || 0,
        cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      });
      if (err) return reject(err);
      resolve({ stdout, data });
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

  const tag = resolveCallerTag(opts, 'callLLM');
  const model = opts.model || DEFAULT_MODEL;
  const args = ['-p', prompt, '--model', model, '--output-format', 'json'];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  try {
    const { data } = await execClaude(args, opts, tag);
    if (!data) return null;
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

  const tag = resolveCallerTag(opts, 'callLLMStructured');
  const model = opts.model || DEFAULT_MODEL;
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', jsonSchema];
  if (systemPrompt) args.push('--system-prompt', systemPrompt);

  try {
    const { data } = await execClaude(args, opts, tag);
    if (!data) return null;
    if (typeof data.result === 'string') {
      return JSON.parse(data.result);
    }
    return data.result || data;
  } catch {
    return null;
  }
}
