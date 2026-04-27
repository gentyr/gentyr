/**
 * Release Orchestrator — shared module for production release artifact collection.
 *
 * Provides utilities for enumerating staging PRs, managing artifact directories,
 * and collecting session transcripts, demo results, and triage artifacts during
 * a production release.
 *
 * @module lib/release-orchestrator
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

// ============================================================================
// Logging
// ============================================================================

function log(message) {
  const timestamp = new Date().toISOString();
  try {
    const logPath = path.join(PROJECT_DIR, '.claude', 'session-queue.log');
    fs.appendFileSync(logPath, `[${timestamp}] [release-orchestrator] ${message}\n`);
  } catch (_) {
    // Non-fatal — log file not writable
  }
}

// ============================================================================
// Session File Discovery
// ============================================================================

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Resolve the session directory for a project.
 *
 * @param {string} projectDir
 * @returns {string|null}
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
 * Find a session JSONL file by agent ID marker.
 *
 * Scans the session directory for JSONL files containing the [AGENT:{agentId}]
 * marker in the first 16KB. Same pattern as findSessionFileByAgentId in session-queue.js.
 *
 * @param {string} sessionDir
 * @param {string} agentId
 * @returns {string|null} Full path to the JSONL file, or null if not found.
 */
function findSessionFileByAgentId(sessionDir, agentId) {
  const marker = `[AGENT:${agentId}]`;
  let files;
  try {
    files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));
  } catch (err) {
    log(`Warning: could not read session dir: ${err.message}`);
    return null;
  }

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16000);
      const bytesRead = fs.readSync(fd, buf, 0, 16000, 0);
      const head = buf.toString('utf8', 0, bytesRead);
      if (head.includes(marker)) return filePath;
    } catch (err) {
      log(`Warning: could not read session file ${file}: ${err.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return null;
}

// ============================================================================
// PR Enumeration
// ============================================================================

/**
 * Enumerate merged PRs on the staging branch that are not yet on main.
 *
 * Uses `gh pr list` for structured data with a fallback to `git log --merges`.
 *
 * @param {string} [projectDir]
 * @returns {Array<{ number: number, title: string, url: string, author: string, merged_at: string }>}
 */
export function enumerateReleasePRs(projectDir = PROJECT_DIR) {
  try {
    const raw = execFileSync('gh', [
      'pr', 'list',
      '--state', 'merged',
      '--base', 'staging',
      '--limit', '100',
      '--json', 'number,title,author,mergedAt,url',
    ], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 30000,
      stdio: 'pipe',
    }).trim();

    const prs = JSON.parse(raw);
    if (!Array.isArray(prs)) {
      throw new Error('gh pr list did not return an array');
    }

    return prs.map(pr => ({
      number: pr.number,
      title: pr.title || '',
      url: pr.url || '',
      author: pr.author?.login || pr.author || '',
      merged_at: pr.mergedAt || '',
    }));
  } catch (err) {
    log(`Warning: gh pr list failed, falling back to git log: ${err.message}`);

    // Fallback: parse git log merge commits
    try {
      const gitLog = execFileSync('git', [
        'log', '--oneline', '--merges', 'origin/main..origin/staging',
      ], {
        cwd: projectDir,
        encoding: 'utf8',
        timeout: 15000,
        stdio: 'pipe',
      }).trim();

      if (!gitLog) return [];

      return gitLog.split('\n').map((line, index) => {
        // Format: "abc1234 Merge pull request #42 from branch/name"
        const prMatch = line.match(/#(\d+)/);
        const prNumber = prMatch ? parseInt(prMatch[1], 10) : index + 1;
        const title = line.replace(/^[a-f0-9]+\s+/, '');
        return {
          number: prNumber,
          title,
          url: '',
          author: '',
          merged_at: '',
        };
      });
    } catch (gitErr) {
      log(`Warning: git log fallback also failed: ${gitErr.message}`);
      return [];
    }
  }
}

// ============================================================================
// Artifact Directory Management
// ============================================================================

/**
 * Get (and create) the artifact directory for a release.
 *
 * Creates the directory structure:
 *   .claude/releases/{releaseId}/
 *     prs/
 *     sessions/
 *     reports/
 *
 * @param {string} releaseId
 * @param {string} [projectDir]
 * @returns {string} Absolute path to the artifact directory.
 */
export function getArtifactDir(releaseId, projectDir = PROJECT_DIR) {
  if (!releaseId || typeof releaseId !== 'string') {
    throw new Error('[release-orchestrator] getArtifactDir requires a non-empty releaseId string');
  }

  const artifactDir = path.join(projectDir, '.claude', 'releases', releaseId);

  const subdirs = [
    artifactDir,
    path.join(artifactDir, 'prs'),
    path.join(artifactDir, 'sessions'),
    path.join(artifactDir, 'reports'),
  ];

  for (const dir of subdirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return artifactDir;
}

// ============================================================================
// Session Summary Generation
// ============================================================================

/**
 * Generate a deterministic markdown summary from a session JSONL file.
 *
 * Reads the last 4KB of the JSONL, extracts tool calls and their results,
 * and produces a structured markdown document. This is a pragmatic approach
 * that avoids LLM dependencies — an LLM summary can be layered on later.
 *
 * @param {string} jsonlPath - Absolute path to the session JSONL file
 * @param {string} sessionId - Session UUID
 * @param {string} agentId - Agent ID
 * @param {string} phase - Release phase identifier
 * @returns {string} Markdown summary content
 */
function generateSessionSummary(jsonlPath, sessionId, agentId, phase) {
  const stat = fs.statSync(jsonlPath);
  const readSize = Math.min(4096, stat.size);
  const buffer = Buffer.alloc(readSize);
  const fd = fs.openSync(jsonlPath, 'r');

  try {
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stat.size - readSize));
  } finally {
    fs.closeSync(fd);
  }

  const tail = buffer.toString('utf8');

  // Parse JSONL lines from the tail (first line may be partial — skip it)
  const lines = tail.split('\n').filter(l => l.trim());
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]));
    } catch (_) {
      // Partial line at the start — expected
    }
  }

  // Extract tool calls from the entries
  const toolCalls = [];
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const entry of entries) {
    const ts = entry.timestamp || entry.created_at || null;
    if (ts) {
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;
    }

    // Look for tool_use entries
    if (entry.type === 'tool_use' || entry.tool || entry.name) {
      const toolName = entry.name || entry.tool || 'unknown';
      toolCalls.push(toolName);
    }

    // Look for nested content blocks with tool_use
    if (Array.isArray(entry.content)) {
      for (const block of entry.content) {
        if (block.type === 'tool_use' && block.name) {
          toolCalls.push(block.name);
        }
      }
    }
  }

  // Deduplicate tool calls and count occurrences
  const toolCounts = {};
  for (const tool of toolCalls) {
    toolCounts[tool] = (toolCounts[tool] || 0) + 1;
  }

  // Calculate approximate duration
  let durationStr = 'unknown';
  if (firstTimestamp && lastTimestamp) {
    try {
      const startMs = new Date(firstTimestamp).getTime();
      const endMs = new Date(lastTimestamp).getTime();
      if (!isNaN(startMs) && !isNaN(endMs)) {
        const durationMs = endMs - startMs;
        const minutes = Math.round(durationMs / 60000);
        durationStr = minutes > 0 ? `~${minutes} minutes` : '< 1 minute';
      }
    } catch (_) {
      // Non-fatal — keep default
    }
  }

  // Build the markdown summary
  const toolList = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tool, count]) => `- \`${tool}\` (${count}x)`)
    .join('\n');

  const summary = `# Session Summary

| Field | Value |
|-------|-------|
| Session ID | \`${sessionId}\` |
| Agent ID | \`${agentId}\` |
| Phase | ${phase} |
| Duration | ${durationStr} |
| JSONL Size | ${stat.size} bytes |
| Entries (tail) | ${entries.length} |

## Tools Used

${toolList || '_No tool calls detected in session tail._'}

## Notes

This is a deterministic summary generated from the last 4KB of the session JSONL file.
For full context, refer to the archived JSONL transcript.
`;

  return summary;
}

// ============================================================================
// Session Artifact Collection
// ============================================================================

/**
 * Collect a session transcript artifact for a release.
 *
 * Finds the session JSONL file by agent ID marker and copies it to the
 * release artifact directory under sessions/{phase}/.
 *
 * @param {string} releaseId
 * @param {string} sessionId - Session UUID (used for naming the copy)
 * @param {string} agentId - Agent ID to find the JSONL file by marker
 * @param {string} phase - Release phase identifier (e.g., "phase-1-review")
 * @param {string} [projectDir]
 * @returns {{ copied: boolean, jsonlPath: string|null, targetPath: string|null }}
 */
export function collectSessionArtifact(releaseId, sessionId, agentId, phase, projectDir = PROJECT_DIR) {
  if (!releaseId || !sessionId || !agentId || !phase) {
    throw new Error('[release-orchestrator] collectSessionArtifact requires releaseId, sessionId, agentId, and phase');
  }

  const artifactDir = getArtifactDir(releaseId, projectDir);
  const phaseDir = path.join(artifactDir, 'sessions', phase);

  if (!fs.existsSync(phaseDir)) {
    fs.mkdirSync(phaseDir, { recursive: true });
  }

  // Find the session JSONL file
  const sessionDir = getSessionDir(projectDir);
  if (!sessionDir) {
    log(`Warning: could not resolve session directory for ${projectDir}`);
    return { copied: false, jsonlPath: null, targetPath: null };
  }

  const jsonlPath = findSessionFileByAgentId(sessionDir, agentId);
  if (!jsonlPath) {
    log(`Warning: could not find session file for agent ${agentId}`);
    return { copied: false, jsonlPath: null, targetPath: null };
  }

  const targetPath = path.join(phaseDir, `session-${sessionId}.jsonl`);

  try {
    fs.copyFileSync(jsonlPath, targetPath);
    log(`Collected session artifact: ${targetPath}`);
  } catch (err) {
    log(`Warning: failed to copy session artifact: ${err.message}`);
    return { copied: false, jsonlPath, targetPath: null };
  }

  // Generate a deterministic summary from the JSONL tail
  try {
    const summaryPath = path.join(phaseDir, `session-${sessionId}-summary.md`);
    const summary = generateSessionSummary(jsonlPath, sessionId, agentId, phase);
    fs.writeFileSync(summaryPath, summary, 'utf8');
    log(`Generated session summary: ${summaryPath}`);
  } catch (err) {
    log(`Warning: failed to generate session summary: ${err.message}`);
    // Non-fatal — the JSONL copy already succeeded
  }

  return { copied: true, jsonlPath, targetPath };
}

// ============================================================================
// Demo Artifact Collection
// ============================================================================

/**
 * Collect demo scenario artifacts for a release.
 *
 * Copies screenshots and recordings from .claude/recordings/demos/ to the
 * release artifact directory. Writes a demo-results.json summary.
 *
 * @param {string} releaseId
 * @param {Array<{ scenarioId: string, status: string, recording_path?: string, screenshot_hint?: string }>} scenarioResults
 * @param {string} [projectDir]
 * @returns {{ scenarioCount: number, screenshotCount: number }}
 */
export function collectDemoArtifacts(releaseId, scenarioResults, projectDir = PROJECT_DIR) {
  if (!releaseId || !Array.isArray(scenarioResults)) {
    throw new Error('[release-orchestrator] collectDemoArtifacts requires releaseId and scenarioResults array');
  }

  const artifactDir = getArtifactDir(releaseId, projectDir);
  const testsDir = path.join(artifactDir, 'sessions', 'phase-4-tests');
  const screenshotTargetDir = path.join(testsDir, 'screenshots');

  if (!fs.existsSync(testsDir)) {
    fs.mkdirSync(testsDir, { recursive: true });
  }
  if (!fs.existsSync(screenshotTargetDir)) {
    fs.mkdirSync(screenshotTargetDir, { recursive: true });
  }

  let screenshotCount = 0;

  for (const result of scenarioResults) {
    const scenarioId = result.scenarioId;
    if (!scenarioId) continue;

    // Copy screenshots
    const screenshotSourceDir = path.join(projectDir, '.claude', 'recordings', 'demos', scenarioId, 'screenshots');
    if (fs.existsSync(screenshotSourceDir)) {
      try {
        const files = fs.readdirSync(screenshotSourceDir).filter(f => f.endsWith('.png'));
        const scenarioScreenshotDir = path.join(screenshotTargetDir, scenarioId);
        if (!fs.existsSync(scenarioScreenshotDir)) {
          fs.mkdirSync(scenarioScreenshotDir, { recursive: true });
        }
        for (const file of files) {
          fs.copyFileSync(
            path.join(screenshotSourceDir, file),
            path.join(scenarioScreenshotDir, file)
          );
          screenshotCount++;
        }
      } catch (err) {
        log(`Warning: failed to copy screenshots for scenario ${scenarioId}: ${err.message}`);
      }
    }

    // Copy recording if it exists
    if (result.recording_path && fs.existsSync(result.recording_path)) {
      try {
        const recordingTarget = path.join(testsDir, `${scenarioId}.mp4`);
        fs.copyFileSync(result.recording_path, recordingTarget);
      } catch (err) {
        log(`Warning: failed to copy recording for scenario ${scenarioId}: ${err.message}`);
      }
    }
  }

  // Write demo results summary
  try {
    const resultsPath = path.join(testsDir, 'demo-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(scenarioResults, null, 2) + '\n', 'utf8');
  } catch (err) {
    log(`Warning: failed to write demo-results.json: ${err.message}`);
  }

  return { scenarioCount: scenarioResults.length, screenshotCount };
}

// ============================================================================
// Triage Artifact Collection
// ============================================================================

/**
 * Collect triage artifacts (CTO reports and deputy-CTO decisions) for a release.
 *
 * Opens cto-reports.db and deputy-cto.db read-only, queries records created
 * after the release's created_at timestamp, and writes JSON summaries to the
 * artifact directory.
 *
 * @param {string} releaseId
 * @param {string} [projectDir]
 * @returns {{ triageActionCount: number, ctoDecisionCount: number }}
 */
export async function collectTriageArtifacts(releaseId, projectDir = PROJECT_DIR) {
  if (!releaseId) {
    throw new Error('[release-orchestrator] collectTriageArtifacts requires a releaseId');
  }

  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch (err) {
    log(`Warning: better-sqlite3 not available: ${err.message}`);
    return { triageActionCount: 0, ctoDecisionCount: 0 };
  }

  const artifactDir = getArtifactDir(releaseId, projectDir);
  const reportsDir = path.join(artifactDir, 'reports');

  // Get the release created_at from the ledger DB
  const ledgerDbPath = path.join(projectDir, '.claude', 'state', 'release-ledger.db');
  let releaseCreatedAt = null;

  try {
    if (fs.existsSync(ledgerDbPath)) {
      const ledgerDb = new Database(ledgerDbPath, { readonly: true });
      const release = ledgerDb.prepare('SELECT created_at FROM releases WHERE id = ?').get(releaseId);
      ledgerDb.close();
      releaseCreatedAt = release?.created_at || null;
    }
  } catch (err) {
    log(`Warning: could not read release-ledger.db: ${err.message}`);
  }

  if (!releaseCreatedAt) {
    // If we cannot determine the release start time, use 24 hours ago as a safe default
    releaseCreatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  }

  let triageActionCount = 0;
  let ctoDecisionCount = 0;

  // Collect CTO reports (triage actions)
  const ctoReportsDbPath = path.join(projectDir, '.claude', 'cto-reports.db');
  try {
    if (fs.existsSync(ctoReportsDbPath)) {
      const db = new Database(ctoReportsDbPath, { readonly: true });
      const reports = db.prepare(
        'SELECT * FROM reports WHERE created_at >= ? ORDER BY created_at ASC'
      ).all(releaseCreatedAt);
      db.close();

      triageActionCount = reports.length;
      const outputPath = path.join(reportsDir, 'triage-actions.json');
      fs.writeFileSync(outputPath, JSON.stringify(reports, null, 2) + '\n', 'utf8');
    }
  } catch (err) {
    log(`Warning: failed to collect CTO reports: ${err.message}`);
  }

  // Collect deputy-CTO decisions
  const deputyCtoDbPath = path.join(projectDir, '.claude', 'deputy-cto.db');
  try {
    if (fs.existsSync(deputyCtoDbPath)) {
      const db = new Database(deputyCtoDbPath, { readonly: true });

      // Try questions table first (may not exist in all installs)
      let decisions = [];
      try {
        decisions = db.prepare(
          'SELECT * FROM questions WHERE created_at >= ? ORDER BY created_at ASC'
        ).all(releaseCreatedAt);
      } catch (_) {
        // questions table may not exist — non-fatal
      }
      db.close();

      ctoDecisionCount = decisions.length;
      const outputPath = path.join(reportsDir, 'cto-decisions.json');
      fs.writeFileSync(outputPath, JSON.stringify(decisions, null, 2) + '\n', 'utf8');
    }
  } catch (err) {
    log(`Warning: failed to collect deputy-CTO decisions: ${err.message}`);
  }

  return { triageActionCount, ctoDecisionCount };
}
