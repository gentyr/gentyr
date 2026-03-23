/**
 * User Prompt Resolver
 *
 * Resolves user prompt UUIDs to content for injection into agent prompts.
 * Reads session JSONL files directly (no DB dependency).
 *
 * @module lib/user-prompt-resolver
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAX_UUIDS = 5;
const MAX_CONTENT_CHARS = 2000;
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Compute the session directory for a project path.
 */
function getSessionDir(projectDir) {
  const projectPath = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  const sessionDir = path.join(CLAUDE_PROJECTS_DIR, projectPath);
  if (fs.existsSync(sessionDir)) return sessionDir;

  const altPath = path.join(CLAUDE_PROJECTS_DIR, projectPath.replace(/^-/, ''));
  if (fs.existsSync(altPath)) return altPath;

  return null;
}

/**
 * Generate a deterministic UUID from session_id + line_number.
 * Must match the agent-tracker server's promptUuid() function.
 */
function promptUuid(sessionId, lineNumber) {
  const input = `${sessionId}:${lineNumber}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return `up-${sessionId.substring(0, 8)}-${hex}-${lineNumber}`;
}

/**
 * Extract user content from a parsed JSONL entry.
 */
function extractUserContent(entry) {
  if (entry.type !== 'human' && entry.type !== 'user') return null;
  const msg = entry.message;
  if (!msg) return null;

  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    const texts = msg.content
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

/**
 * Resolve user prompt UUIDs to content.
 *
 * @param {string[]} uuids - Array of user prompt UUIDs to resolve
 * @param {string} projectDir - Project directory path
 * @returns {string} Formatted markdown block for injection into agent prompts
 */
export function resolveUserPrompts(uuids, projectDir) {
  if (!uuids || uuids.length === 0) return '';

  const resolveUuids = uuids.slice(0, MAX_UUIDS);
  if (uuids.length > MAX_UUIDS) {
    process.stderr.write(`[user-prompt-resolver] Warning: ${uuids.length} UUIDs provided, resolving first ${MAX_UUIDS}\n`);
  }

  const sessionDir = getSessionDir(projectDir);
  if (!sessionDir) return '';

  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    process.stderr.write('[user-prompt-resolver] Warning: failed to read prompts directory: ' + (err.message || err) + '\n');
    return '';
  }

  // Build a map of UUID -> { content, timestamp } by scanning session files
  const resolved = new Map();
  const targetSet = new Set(resolveUuids);

  for (const file of files) {
    if (resolved.size >= resolveUuids.length) break;

    const filePath = path.join(sessionDir, file);
    const sessionId = file.replace('.jsonl', '');

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write('[user-prompt-resolver] Warning: failed to read prompt file ' + file + ': ' + (err.message || err) + '\n');
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const lineNumber = i + 1;
      const uuid = promptUuid(sessionId, lineNumber);

      if (!targetSet.has(uuid)) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) { // F004: error captured; parse failures on individual JSONL lines are expected noise
        continue;
      }

      const userContent = extractUserContent(parsed);
      if (!userContent) continue;

      resolved.set(uuid, {
        content: userContent.substring(0, MAX_CONTENT_CHARS),
        timestamp: parsed.timestamp || new Date().toISOString(),
      });

      if (resolved.size >= resolveUuids.length) break;
    }
  }

  if (resolved.size === 0) return '';

  // Build markdown block sorted by timestamp (oldest first)
  const entries = Array.from(resolved.entries())
    .sort((a, b) => a[1].timestamp.localeCompare(b[1].timestamp));

  let block = `## Referenced User Prompts

The following user prompts are the original instructions this task derives from.
Your implementation MUST honor the user's intent expressed in these prompts.
More recent prompts take precedence over older ones.

`;

  for (const [uuid, { content, timestamp }] of entries) {
    block += `### Prompt ${uuid} (${timestamp})\n> ${content.replace(/\n/g, '\n> ')}\n\n`;
  }

  return block;
}
