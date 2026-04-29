/**
 * Release Report Generator — structured report pipeline for production releases.
 *
 * Reads release data from release-ledger.db and artifacts from the release
 * artifact directory, then generates a structured markdown report using the
 * template at templates/release-report-template.md.
 *
 * @module lib/release-report-generator
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
    fs.appendFileSync(logPath, `[${timestamp}] [release-report-generator] ${message}\n`);
  } catch (_) {
    // Non-fatal — log file not writable
  }
}

// ============================================================================
// Template Resolution
// ============================================================================

/**
 * Resolve the release report template path.
 *
 * Searches in order:
 *   1. node_modules/gentyr/templates/release-report-template.md
 *   2. .claude-framework/templates/release-report-template.md
 *   3. ./templates/release-report-template.md
 *
 * @param {string} [projectDir]
 * @returns {string|null} Absolute path to the template, or null if not found.
 */
function resolveTemplatePath(projectDir = PROJECT_DIR) {
  const candidates = [
    path.join(projectDir, 'node_modules', 'gentyr', 'templates', 'release-report-template.md'),
    path.join(projectDir, '.claude-framework', 'templates', 'release-report-template.md'),
    path.join(projectDir, 'templates', 'release-report-template.md'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ============================================================================
// Section Generators
// ============================================================================

/**
 * Generate the overview section.
 *
 * @param {object} release - Release record from the DB
 * @param {Array} prs - Release PR records
 * @param {Array} sessions - Release session records
 * @param {Array} reports - Release report records
 * @returns {string}
 */
function generateOverview(release, prs, sessions, reports) {
  const prCount = prs.length;
  const sessionCount = sessions.length;
  const reportCount = reports.length;
  const date = release.signed_off_at || release.created_at || new Date().toISOString();
  const formattedDate = date.split('T')[0];

  return `${prCount} PRs, ${sessionCount} review sessions, ${reportCount} reports, released on ${formattedDate}.`;
}

/**
 * Generate the changes table.
 *
 * @param {Array} prs - Release PR records
 * @returns {string}
 */
function generateChangesTable(prs) {
  if (prs.length === 0) {
    return '_No PRs registered for this release._';
  }

  const header = '| PR # | Title | Author | Merged |\n|------|-------|--------|--------|';
  const rows = prs.map(pr => {
    const mergedDate = pr.merged_at ? pr.merged_at.split('T')[0] : 'N/A';
    const prRef = pr.pr_url ? `[#${pr.pr_number}](${pr.pr_url})` : `#${pr.pr_number}`;
    return `| ${prRef} | ${pr.pr_title || 'Untitled'} | ${pr.author || 'Unknown'} | ${mergedDate} |`;
  });

  return [header, ...rows].join('\n');
}

/**
 * Generate the customer-facing changelog.
 *
 * Primary path: LLM-generated changelog via `claude -p` subprocess.
 * Fallback: structured grouping by conventional commit prefix.
 *
 * @param {Array} prs - Release PR records
 * @returns {string}
 */
function generateChangelog(prs) {
  if (prs.length === 0) {
    return '_No changes._';
  }

  // Primary path: LLM-generated changelog
  try {
    const prSummary = prs.map(pr => `- PR #${pr.pr_number}: ${pr.pr_title || 'Untitled'}`).join('\n');
    const prompt = `You are generating a customer-facing changelog from these merged PRs:\n\n${prSummary}\n\nGenerate a bulleted changelog grouped by category (Features, Bug Fixes, Improvements, Other). Each bullet should be a single clear sentence describing the user-visible change. Do not include PR numbers or technical details. Output ONLY the markdown bullets, nothing else.`;

    const result = execFileSync('claude', ['-p', prompt, '--model', 'haiku', '--output-format', 'text'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_SPAWNED_SESSION: 'true' },
    }).trim();

    if (result && result.length > 10) {
      return result;
    }
  } catch (err) {
    log(`LLM changelog generation failed, falling back to structured grouping: ${err.message}`);
  }

  // Fallback: structured grouping by conventional commit prefix
  const groups = {
    Feature: [],
    Fix: [],
    Documentation: [],
    Refactor: [],
    Test: [],
    Other: [],
  };

  for (const pr of prs) {
    const title = pr.pr_title || 'Untitled';
    const lower = title.toLowerCase();

    if (lower.startsWith('feat') || lower.includes('feature')) {
      groups.Feature.push(title);
    } else if (lower.startsWith('fix') || lower.includes('bugfix') || lower.includes('bug fix')) {
      groups.Fix.push(title);
    } else if (lower.startsWith('docs') || lower.includes('documentation')) {
      groups.Documentation.push(title);
    } else if (lower.startsWith('refactor')) {
      groups.Refactor.push(title);
    } else if (lower.startsWith('test') || lower.includes('test')) {
      groups.Test.push(title);
    } else {
      groups.Other.push(title);
    }
  }

  const sections = [];
  for (const [category, items] of Object.entries(groups)) {
    if (items.length > 0) {
      for (const item of items) {
        sections.push(`- **${category}**: ${item}`);
      }
    }
  }

  return sections.length > 0 ? sections.join('\n') : '_No categorizable changes._';
}

/**
 * Generate the per-PR review results table.
 *
 * Reads session summaries from the artifact directory's phase-1-review folder.
 *
 * @param {string} artifactDir
 * @param {Array} prs - Release PR records
 * @returns {string}
 */
function generatePerPrReviewTable(artifactDir, prs) {
  const reviewDir = path.join(artifactDir, 'sessions', 'phase-1-review');

  if (prs.length === 0) {
    return '_No PR reviews._';
  }

  const header = '| PR | Review Status | Plan Task |\n|----|--------------|-----------|';
  const rows = prs.map(pr => {
    const statusEmoji = pr.review_status === 'passed' ? 'Passed' :
      pr.review_status === 'failed' ? 'FAILED' :
        pr.review_status === 'in_review' ? 'In Review' : 'Pending';
    const planRef = pr.review_plan_task_id || 'N/A';
    return `| #${pr.pr_number} | ${statusEmoji} | ${planRef} |`;
  });

  // Check if we have session files for richer data
  let sessionNote = '';
  if (fs.existsSync(reviewDir)) {
    try {
      const files = fs.readdirSync(reviewDir).filter(f => f.endsWith('.jsonl'));
      if (files.length > 0) {
        sessionNote = `\n\n_${files.length} review session transcript(s) archived._`;
      }
    } catch (_) {
      // Non-fatal
    }
  }

  return [header, ...rows].join('\n') + sessionNote;
}

/**
 * Generate the test results section.
 *
 * @param {string} artifactDir
 * @returns {string}
 */
function generateTestResults(artifactDir) {
  const resultsPath = path.join(artifactDir, 'sessions', 'phase-4-tests', 'test-results.json');

  if (!fs.existsSync(resultsPath)) {
    return '_Test results not yet collected._';
  }

  try {
    const raw = fs.readFileSync(resultsPath, 'utf8');
    const results = JSON.parse(raw);

    if (!results || typeof results !== 'object') {
      return '_Test results file is malformed._';
    }

    const passed = results.passed || 0;
    const failed = results.failed || 0;
    const skipped = results.skipped || 0;
    const total = passed + failed + skipped;
    const status = failed > 0 ? 'FAILURES DETECTED' : 'ALL PASSING';

    return `**${status}**: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${total} total tests.`;
  } catch (err) {
    log(`Warning: failed to read test results: ${err.message}`);
    return '_Failed to read test results._';
  }
}

/**
 * Generate the demo results section.
 *
 * @param {string} artifactDir
 * @returns {string}
 */
function generateDemoResults(artifactDir) {
  const resultsPath = path.join(artifactDir, 'sessions', 'phase-4-tests', 'demo-results.json');

  if (!fs.existsSync(resultsPath)) {
    return '_Demo results not yet collected._';
  }

  try {
    const raw = fs.readFileSync(resultsPath, 'utf8');
    const results = JSON.parse(raw);

    if (!Array.isArray(results) || results.length === 0) {
      return '_No demo scenario results._';
    }

    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const other = results.length - passed - failed;
    const status = failed > 0 ? 'FAILURES DETECTED' : 'ALL PASSING';

    const header = '| Scenario | Status | Recording |\n|----------|--------|-----------|';
    const rows = results.map(r => {
      const statusLabel = r.status === 'passed' ? 'Passed' :
        r.status === 'failed' ? 'FAILED' : r.status || 'Unknown';
      const recording = r.recording_path ? path.basename(r.recording_path) : 'N/A';
      return `| ${r.scenarioId || 'Unknown'} | ${statusLabel} | ${recording} |`;
    });

    return `**${status}**: ${passed} passed, ${failed} failed, ${other} other out of ${results.length} scenarios.\n\n${[header, ...rows].join('\n')}`;
  } catch (err) {
    log(`Warning: failed to read demo results: ${err.message}`);
    return '_Failed to read demo results._';
  }
}

/**
 * Generate the demo coverage section.
 *
 * @param {string} artifactDir
 * @returns {string}
 */
function generateDemoCoverage(artifactDir) {
  // Look for a Phase 5 session summary or a coverage report
  const phase5Dir = path.join(artifactDir, 'sessions', 'phase-5-coverage');

  if (!fs.existsSync(phase5Dir)) {
    return '_Demo coverage audit not yet completed._';
  }

  try {
    const files = fs.readdirSync(phase5Dir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) {
      return '_Demo coverage audit session recorded but no summary available._';
    }
    return `_Demo coverage audit completed. ${files.length} session(s) archived in phase-5-coverage/._`;
  } catch (_) {
    return '_Demo coverage audit data unavailable._';
  }
}

/**
 * Generate the issues table from triage actions.
 *
 * @param {string} artifactDir
 * @returns {string}
 */
function generateIssuesTable(artifactDir) {
  const triagePath = path.join(artifactDir, 'reports', 'triage-actions.json');

  if (!fs.existsSync(triagePath)) {
    return '_No triage actions recorded._';
  }

  try {
    const raw = fs.readFileSync(triagePath, 'utf8');
    const actions = JSON.parse(raw);

    if (!Array.isArray(actions) || actions.length === 0) {
      return '_No issues discovered during this release._';
    }

    const header = '| Issue | Category | Outcome | Resolution |\n|-------|----------|---------|------------|';
    const rows = actions.map(a => {
      const title = a.title || a.summary || 'Untitled';
      const category = a.category || a.report_type || 'N/A';
      const outcome = a.outcome || a.status || 'N/A';
      const resolution = a.resolution || a.resolution_context || 'N/A';
      return `| ${title} | ${category} | ${outcome} | ${resolution} |`;
    });

    return [header, ...rows].join('\n');
  } catch (err) {
    log(`Warning: failed to read triage actions: ${err.message}`);
    return '_Failed to read triage actions._';
  }
}

/**
 * Generate the CTO decisions table.
 *
 * @param {string} artifactDir
 * @returns {string}
 */
function generateCtoDecisions(artifactDir) {
  const decisionsPath = path.join(artifactDir, 'reports', 'cto-decisions.json');

  if (!fs.existsSync(decisionsPath)) {
    return '_No CTO decisions recorded._';
  }

  try {
    const raw = fs.readFileSync(decisionsPath, 'utf8');
    const decisions = JSON.parse(raw);

    if (!Array.isArray(decisions) || decisions.length === 0) {
      return '_No CTO decisions required during this release._';
    }

    const header = '| Item | Decision | Context |\n|------|----------|---------|';
    const rows = decisions.map(d => {
      const item = d.question || d.title || d.summary || 'Untitled';
      const decision = d.answer || d.decision || d.status || 'N/A';
      const context = d.context || d.notes || 'N/A';
      return `| ${item} | ${decision} | ${context} |`;
    });

    return [header, ...rows].join('\n');
  } catch (err) {
    log(`Warning: failed to read CTO decisions: ${err.message}`);
    return '_Failed to read CTO decisions._';
  }
}

/**
 * Generate the evidence chain sections.
 *
 * @param {Array} sessions - Release session records from DB
 * @param {Array} tasks - Release task records from DB
 * @param {Array} reports - Release report records from DB
 * @returns {{ evidenceSessions: string, evidenceTasks: string, evidenceReports: string }}
 */
function generateEvidenceChain(sessions, tasks, reports) {
  // Sessions evidence
  let evidenceSessions;
  if (sessions.length === 0) {
    evidenceSessions = '### Sessions\n\n_No sessions recorded._';
  } else {
    const header = '### Sessions\n\n| ID | Type | Phase | Target PR | Status |\n|----|------|-------|-----------|--------|';
    const rows = sessions.map(s => {
      const shortId = (s.id || '').substring(0, 8);
      return `| ${shortId} | ${s.session_type || 'N/A'} | ${s.phase || 'N/A'} | ${s.target_pr || 'N/A'} | ${s.status || 'N/A'} |`;
    });
    evidenceSessions = [header, ...rows].join('\n');
  }

  // Tasks evidence
  let evidenceTasks;
  if (tasks.length === 0) {
    evidenceTasks = '### Tasks\n\n_No tasks recorded._';
  } else {
    const header = '### Tasks\n\n| ID | Type | Phase | Status |\n|----|------|-------|--------|';
    const rows = tasks.map(t => {
      const shortId = (t.id || '').substring(0, 8);
      return `| ${shortId} | ${t.task_type || 'N/A'} | ${t.phase || 'N/A'} | ${t.status || 'N/A'} |`;
    });
    evidenceTasks = [header, ...rows].join('\n');
  }

  // Reports evidence
  let evidenceReports;
  if (reports.length === 0) {
    evidenceReports = '### Reports\n\n_No reports recorded._';
  } else {
    const header = '### Reports\n\n| ID | Type | Title | Outcome |\n|----|------|-------|---------|';
    const rows = reports.map(r => {
      const shortId = (r.id || '').substring(0, 8);
      return `| ${shortId} | ${r.report_type || 'N/A'} | ${r.title || 'N/A'} | ${r.outcome || 'N/A'} |`;
    });
    evidenceReports = [header, ...rows].join('\n');
  }

  return { evidenceSessions, evidenceTasks, evidenceReports };
}

/**
 * Generate the screenshots section.
 *
 * Lists all .png files found in the artifact directory's screenshot subdirectories.
 *
 * @param {string} artifactDir
 * @returns {string}
 */
function generateScreenshots(artifactDir) {
  const screenshotDirs = [
    path.join(artifactDir, 'sessions', 'phase-4-tests', 'screenshots'),
  ];

  const allScreenshots = [];

  for (const dir of screenshotDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      // Walk one level of subdirectories (scenario-specific folders)
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(dir, entry.name);
          const files = fs.readdirSync(subDir).filter(f => f.endsWith('.png'));
          for (const file of files) {
            const relativePath = path.relative(artifactDir, path.join(subDir, file));
            allScreenshots.push(`- \`${relativePath}\``);
          }
        } else if (entry.isFile() && entry.name.endsWith('.png')) {
          const relativePath = path.relative(artifactDir, path.join(dir, entry.name));
          allScreenshots.push(`- \`${relativePath}\``);
        }
      }
    } catch (_) {
      // Non-fatal
    }
  }

  if (allScreenshots.length === 0) {
    return '_No screenshots captured._';
  }

  return `${allScreenshots.length} screenshot(s) captured:\n\n${allScreenshots.join('\n')}`;
}

/**
 * Generate the CTO Approval section.
 * Reads cto-approval.json from the artifact directory if it exists.
 */
function generateCtoApproval(artifactDir) {
  const proofPath = path.join(artifactDir, 'cto-approval.json');
  if (!fs.existsSync(proofPath)) {
    return '_Pending CTO approval._';
  }

  try {
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    const lines = [];
    lines.push(`**Approved by**: CTO`);
    lines.push(`**Timestamp**: ${proof.approved_at || 'unknown'}`);
    lines.push('');
    lines.push('**Verbatim approval**:');
    lines.push(`> ${proof.approval_text}`);
    lines.push('');
    lines.push('**Evidence chain**:');
    lines.push(`- Session transcript: \`${proof.session_jsonl_archived || 'cto-approval-session.jsonl'}\``);
    lines.push(`- Session file SHA-256: \`${proof.session_file_hash || 'unknown'}\``);
    lines.push(`- Approval HMAC proof: \`${(proof.hmac || '').slice(0, 16)}...\``);
    lines.push(`- HMAC domain: \`${proof.domain_separator || 'cto-release-approval'}\``);
    lines.push('');
    lines.push('Full cryptographic proof chain stored in `cto-approval.json`.');
    return lines.join('\n');
  } catch {
    return '_CTO approval recorded but proof file could not be parsed._';
  }
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Generate a structured release report.
 *
 * Reads release data from release-ledger.db, assembles each section using
 * artifact data and DB records, fills in the template, and writes to the
 * artifact directory.
 *
 * @param {string} releaseId
 * @param {string} [projectDir]
 * @returns {Promise<{ mdPath: string, pdfPath: string|null }>}
 */
export async function generateStructuredReport(releaseId, projectDir = PROJECT_DIR) {
  if (!releaseId || typeof releaseId !== 'string') {
    throw new Error('[release-report-generator] generateStructuredReport requires a non-empty releaseId');
  }

  // Load SQLite
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch (err) {
    throw new Error(`[release-report-generator] better-sqlite3 not available: ${err.message}`);
  }

  // Open release-ledger.db read-only
  const ledgerDbPath = path.join(projectDir, '.claude', 'state', 'release-ledger.db');
  if (!fs.existsSync(ledgerDbPath)) {
    throw new Error(`[release-report-generator] release-ledger.db not found at ${ledgerDbPath}`);
  }

  const db = new Database(ledgerDbPath, { readonly: true });

  let release;
  let prs;
  let sessions;
  let reports;
  let tasks;

  try {
    release = db.prepare('SELECT * FROM releases WHERE id = ?').get(releaseId);
    if (!release) {
      throw new Error(`[release-report-generator] Release ${releaseId} not found`);
    }

    prs = db.prepare('SELECT * FROM release_prs WHERE release_id = ? ORDER BY pr_number ASC').all(releaseId);
    sessions = db.prepare('SELECT * FROM release_sessions WHERE release_id = ? ORDER BY started_at ASC').all(releaseId);
    reports = db.prepare('SELECT * FROM release_reports WHERE release_id = ? ORDER BY created_at ASC').all(releaseId);
    tasks = db.prepare('SELECT * FROM release_tasks WHERE release_id = ? ORDER BY created_at ASC').all(releaseId);
  } finally {
    db.close();
  }

  // Resolve template
  const templatePath = resolveTemplatePath(projectDir);
  if (!templatePath) {
    throw new Error('[release-report-generator] release-report-template.md not found in any search path');
  }

  let template = fs.readFileSync(templatePath, 'utf8');

  // Determine artifact directory
  const artifactDir = release.artifact_dir
    ? path.resolve(projectDir, release.artifact_dir)
    : path.join(projectDir, '.claude', 'releases', releaseId);

  // Ensure artifact dir exists
  if (!fs.existsSync(artifactDir)) {
    fs.mkdirSync(artifactDir, { recursive: true });
  }

  // Generate each section
  const overview = generateOverview(release, prs, sessions, reports);
  const changesTable = generateChangesTable(prs);
  const changelog = generateChangelog(prs);
  const perPrReviewTable = generatePerPrReviewTable(artifactDir, prs);
  const testResults = generateTestResults(artifactDir);
  const demoResults = generateDemoResults(artifactDir);
  const demoCoverage = generateDemoCoverage(artifactDir);
  const issuesTable = generateIssuesTable(artifactDir);
  const ctoDecisions = generateCtoDecisions(artifactDir);
  const { evidenceSessions, evidenceTasks, evidenceReports } = generateEvidenceChain(sessions, tasks, reports);
  const screenshots = generateScreenshots(artifactDir);

  // Fill template
  const version = release.version || 'unreleased';
  const date = (release.signed_off_at || release.created_at || new Date().toISOString()).split('T')[0];
  const signedOffBy = release.signed_off_by || 'pending';

  template = template
    .replace('{version}', version)
    .replace('{release_id}', releaseId)
    .replace('{date}', date)
    .replace('{signed_off_by}', signedOffBy)
    .replace('{overview}', overview)
    .replace('{changes_table}', changesTable)
    .replace('{changelog}', changelog)
    .replace('{per_pr_review_table}', perPrReviewTable)
    .replace('{test_results}', testResults)
    .replace('{demo_results}', demoResults)
    .replace('{demo_coverage}', demoCoverage)
    .replace('{issues_table}', issuesTable)
    .replace('{cto_decisions}', ctoDecisions)
    .replace('{evidence_sessions}', evidenceSessions)
    .replace('{evidence_tasks}', evidenceTasks)
    .replace('{evidence_reports}', evidenceReports)
    .replace('{screenshots}', screenshots)
    .replace('{cto_approval}', generateCtoApproval(artifactDir));

  // Write report
  const mdPath = path.join(artifactDir, 'report.md');
  fs.writeFileSync(mdPath, template, 'utf8');
  log(`Generated release report at ${mdPath}`);

  // Generate PDF
  const pdfPath = path.join(artifactDir, 'report.pdf');
  let pdfResult;
  try {
    pdfResult = await convertToPdf(mdPath, pdfPath);
    if (pdfResult.pdfPath) {
      log(`Generated PDF at ${pdfResult.pdfPath}`);
    } else {
      log('PDF generation skipped (Chromium not available) — .md report is the primary artifact');
    }
  } catch (err) {
    log(`Warning: PDF generation failed: ${err.message}`);
    pdfResult = { pdfPath: null, mdPath, fallback: true };
  }

  return { mdPath, pdfPath: pdfResult?.pdfPath || null };
}

/**
 * Convert a markdown report to PDF.
 *
 * Converts markdown to simple HTML, finds Playwright's Chromium browser,
 * and uses it in headless mode to generate a PDF. Falls back gracefully
 * if Chromium is not available.
 *
 * @param {string} mdPath - Path to the source markdown file
 * @param {string} pdfPath - Desired output PDF path
 * @returns {Promise<{ pdfPath: string|null, mdPath: string, fallback?: boolean }>}
 */
export async function convertToPdf(mdPath, pdfPath) {
  if (!fs.existsSync(mdPath)) {
    throw new Error(`[release-report-generator] convertToPdf: source file not found at ${mdPath}`);
  }

  const mdContent = fs.readFileSync(mdPath, 'utf8');

  // Convert markdown to simple HTML (inline implementation — no external deps)
  const htmlContent = markdownToHtml(mdContent);

  const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #333; }
  h1 { border-bottom: 2px solid #333; padding-bottom: 10px; }
  h2 { border-bottom: 1px solid #ccc; padding-bottom: 6px; margin-top: 30px; }
  h3 { margin-top: 20px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background-color: #f5f5f5; font-weight: 600; }
  code { background-color: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
  pre { background-color: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
  a { color: #0366d6; }
  em { color: #666; }
</style>
</head>
<body>
${htmlContent}
</body>
</html>`;

  // Write temp HTML file
  const htmlPath = pdfPath.replace(/\.pdf$/, '.html');
  fs.writeFileSync(htmlPath, fullHtml, 'utf8');

  // Try to find Playwright's Chromium executable
  const chromiumPath = findPlaywrightChromium();
  if (!chromiumPath) {
    log('Warning: Playwright Chromium not found — PDF conversion unavailable');
    // Clean up temp HTML
    try { fs.unlinkSync(htmlPath); } catch (_) { /* non-fatal */ }
    return { pdfPath: null, mdPath, fallback: true };
  }

  // Use Chromium headless to print to PDF
  try {
    execFileSync(chromiumPath, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], {
      timeout: 30000,
      stdio: 'pipe',
    });

    // Clean up temp HTML
    try { fs.unlinkSync(htmlPath); } catch (_) { /* non-fatal */ }

    if (fs.existsSync(pdfPath)) {
      log(`Generated PDF at ${pdfPath}`);
      return { pdfPath, mdPath };
    }

    log('Warning: Chromium did not produce a PDF file');
    return { pdfPath: null, mdPath, fallback: true };
  } catch (err) {
    log(`Warning: PDF generation failed: ${err.message}`);
    // Clean up temp HTML
    try { fs.unlinkSync(htmlPath); } catch (_) { /* non-fatal */ }
    return { pdfPath: null, mdPath, fallback: true };
  }
}

/**
 * Find Playwright's Chromium executable.
 *
 * Searches common Playwright browser cache locations.
 *
 * @returns {string|null} Path to Chromium executable, or null.
 */
function findPlaywrightChromium() {
  const homeDir = os.homedir();

  // Playwright stores browsers in ~/Library/Caches/ms-playwright/ on macOS
  // and ~/.cache/ms-playwright/ on Linux
  const cacheDirs = [
    path.join(homeDir, 'Library', 'Caches', 'ms-playwright'),
    path.join(homeDir, '.cache', 'ms-playwright'),
  ];

  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;

    try {
      const entries = fs.readdirSync(cacheDir).filter(e => e.startsWith('chromium'));
      // Sort descending to get the latest version
      entries.sort().reverse();

      for (const entry of entries) {
        // macOS: chromium-XXXX/chrome-mac/Chromium.app/Contents/MacOS/Chromium
        const macPath = path.join(cacheDir, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
        if (fs.existsSync(macPath)) return macPath;

        // Linux: chromium-XXXX/chrome-linux/chrome
        const linuxPath = path.join(cacheDir, entry, 'chrome-linux', 'chrome');
        if (fs.existsSync(linuxPath)) return linuxPath;
      }
    } catch (_) {
      // Non-fatal
    }
  }

  return null;
}

/**
 * Convert markdown to simple HTML.
 *
 * Handles: headings, paragraphs, bold/italic/code, links, lists,
 * tables, horizontal rules, and code blocks. Not a full markdown parser —
 * just enough for the release report template.
 *
 * @param {string} md - Markdown string
 * @returns {string} HTML string
 */
function markdownToHtml(md) {
  const lines = md.split('\n');
  const html = [];
  let inTable = false;
  let inCodeBlock = false;
  let inList = false;
  let listType = null; // 'ul' or 'ol'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        html.push('</code></pre>');
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        html.push('<pre><code>');
      }
      continue;
    }
    if (inCodeBlock) {
      html.push(escapeHtml(line));
      continue;
    }

    // Close list if we hit a non-list line
    if (inList && !line.match(/^\s*[-*+]\s/) && !line.match(/^\s*\d+\.\s/) && line.trim() !== '') {
      html.push(listType === 'ol' ? '</ol>' : '</ul>');
      inList = false;
      listType = null;
    }

    // Horizontal rule
    if (line.match(/^---+\s*$/) || line.match(/^\*\*\*+\s*$/) || line.match(/^___+\s*$/)) {
      html.push('<hr>');
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      html.push(`<h${level}>${inlineFormat(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Table rows
    if (line.includes('|') && line.trim().startsWith('|')) {
      // Check if this is a separator row
      if (line.match(/^\|[\s-:|]+\|$/)) {
        continue; // Skip separator
      }

      if (!inTable) {
        html.push('<table>');
        inTable = true;
        // First table row is the header
        const cells = line.split('|').filter(c => c.trim() !== '');
        html.push('<thead><tr>' + cells.map(c => `<th>${inlineFormat(c.trim())}</th>`).join('') + '</tr></thead><tbody>');
        continue;
      }

      const cells = line.split('|').filter(c => c.trim() !== '');
      html.push('<tr>' + cells.map(c => `<td>${inlineFormat(c.trim())}</td>`).join('') + '</tr>');
      continue;
    }

    // Close table if we leave table context
    if (inTable && !line.includes('|')) {
      html.push('</tbody></table>');
      inTable = false;
    }

    // Unordered list items
    const ulMatch = line.match(/^\s*[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) html.push(listType === 'ol' ? '</ol>' : '</ul>');
        html.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      html.push(`<li>${inlineFormat(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list items
    const olMatch = line.match(/^\s*\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) html.push(listType === 'ol' ? '</ol>' : '</ul>');
        html.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      html.push(`<li>${inlineFormat(olMatch[1])}</li>`);
      continue;
    }

    // Empty lines
    if (line.trim() === '') {
      continue;
    }

    // Paragraph
    html.push(`<p>${inlineFormat(line)}</p>`);
  }

  // Close any open elements
  if (inTable) html.push('</tbody></table>');
  if (inList) html.push(listType === 'ol' ? '</ol>' : '</ul>');
  if (inCodeBlock) html.push('</code></pre>');

  return html.join('\n');
}

/**
 * Apply inline markdown formatting.
 */
function inlineFormat(text) {
  let result = escapeHtml(text);

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');
  result = result.replace(/_(.+?)_/g, '<em>$1</em>');

  // Inline code: `text`
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return result;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
