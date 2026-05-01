/**
 * Migration Safety Enforcement
 *
 * THE critical gate that makes auto-rollback safe. Enforces backward-compatible
 * migrations by detecting destructive patterns that would prevent safe rollback.
 *
 * Uses the expand/contract pattern: all schema changes must be additive.
 * Destructive changes (DROP, RENAME, etc.) are blocked until the old schema
 * is fully unused in production.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Destructive migration patterns — these BLOCK promotion.
 * Each pattern has a regex, severity, description, and fix guidance.
 */
const BLOCKED_PATTERNS = [
  {
    regex: /\bDROP\s+TABLE\b/i,
    pattern: 'DROP TABLE',
    risk: 'Irreversible data loss — rollback cannot restore the table',
    severity: 'critical',
    description: 'Dropping a table removes all data permanently. If the deploy is rolled back, the table is gone.',
    fix: 'Expand/contract: (1) Deploy code that stops reading/writing the table. (2) Wait for all old code to drain. (3) Only then DROP TABLE in a cleanup migration.',
  },
  {
    regex: /\bDROP\s+COLUMN\b/i,
    pattern: 'DROP COLUMN',
    risk: 'Rolled-back code still references the column — queries will fail',
    severity: 'critical',
    description: 'Dropping a column while old code references it causes SELECT/INSERT failures on rollback.',
    fix: 'Expand/contract: (1) Deploy code that stops using the column. (2) Backfill any dependent data. (3) Only then DROP COLUMN in a cleanup migration.',
  },
  {
    regex: /\bRENAME\s+(COLUMN|TABLE)\b/i,
    pattern: 'RENAME COLUMN/TABLE',
    risk: 'Rolled-back code references the old name — queries will fail',
    severity: 'critical',
    description: 'Renaming breaks both old code (references old name) and is not reversible without data loss risk.',
    fix: 'Expand/contract: (1) ADD the new column/table. (2) Backfill data from old to new. (3) Deploy code using the new name. (4) DROP old name in a cleanup migration.',
  },
  {
    regex: /\bSET\s+NOT\s+NULL\b/i,
    pattern: 'SET NOT NULL',
    risk: 'Rolled-back code may INSERT NULLs — constraint violations on rollback',
    severity: 'critical',
    description: 'Adding a NOT NULL constraint while old code inserts NULLs causes constraint violations on rollback.',
    fix: 'Expand/contract: (1) Deploy code that never inserts NULL for this column. (2) Backfill existing NULLs. (3) Only then SET NOT NULL in a subsequent migration.',
  },
  {
    regex: /\bALTER\s+(?:COLUMN\s+\w+\s+)?TYPE\b/i,
    pattern: 'ALTER TYPE',
    risk: 'Column type change may be irreversible or cause data truncation on rollback',
    severity: 'critical',
    description: 'Changing a column type can lose precision or fail to cast back on rollback.',
    fix: 'Expand/contract: (1) ADD a new column with the target type. (2) Backfill data with type conversion. (3) Deploy code using the new column. (4) DROP the old column in a cleanup migration.',
  },
];

/**
 * Warning patterns — informational, do NOT block.
 */
const WARNING_PATTERNS = [
  {
    regex: /\bCREATE\s+INDEX\b(?!.*\bCONCURRENTLY\b)/i,
    pattern: 'CREATE INDEX without CONCURRENTLY',
    risk: 'Locks the table during index creation — may cause downtime on large tables',
    severity: 'warning',
    description: 'CREATE INDEX without CONCURRENTLY acquires a table-level lock. On large tables this can block reads/writes for minutes.',
    fix: 'Use CREATE INDEX CONCURRENTLY to build the index without locking the table. Note: cannot run inside a transaction block.',
  },
];

/**
 * Extract migration files from the git diff between two branches.
 *
 * Looks for files matching common migration path patterns:
 * - **/migrations/**
 * - **/migrate/**
 * - *.sql (in common locations)
 * - supabase/migrations/**
 *
 * @param {string} projectDir - Project root directory
 * @param {string} baseBranch - Base branch (e.g., 'origin/staging')
 * @param {string} headBranch - Head branch (e.g., 'origin/preview')
 * @returns {Array<{path: string, content: string}>} Migration files with content
 */
export function extractMigrationFiles(projectDir, baseBranch, headBranch) {
  if (!projectDir || !baseBranch || !headBranch) {
    throw new Error('extractMigrationFiles requires projectDir, baseBranch, and headBranch');
  }

  let diffOutput;
  try {
    diffOutput = execSync(
      `git diff --name-only ${baseBranch}..${headBranch}`,
      { cwd: projectDir, encoding: 'utf8', timeout: 30000, stdio: 'pipe' }
    ).trim();
  } catch (err) {
    throw new Error(`Failed to get git diff: ${err.message}`);
  }

  if (!diffOutput) return [];

  const allFiles = diffOutput.split('\n').filter(Boolean);

  // Filter for migration-related files
  const migrationPatterns = [
    /migrations?\//i,
    /migrate\//i,
    /supabase\/migrations\//i,
    /db\/.*\.sql$/i,
    /schema.*\.sql$/i,
  ];

  const migrationFiles = allFiles.filter(filePath =>
    migrationPatterns.some(pattern => pattern.test(filePath))
  );

  // Read content for each migration file
  const results = [];
  for (const filePath of migrationFiles) {
    try {
      // Get the file content from the head branch
      const content = execSync(
        `git show ${headBranch}:${filePath}`,
        { cwd: projectDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
      );
      results.push({ path: filePath, content });
    } catch {
      // File might be deleted in head — skip
      continue;
    }
  }

  return results;
}

/**
 * Run static analysis on migration files for destructive patterns.
 *
 * @param {Array<{path: string, content: string}>} migrationFiles
 * @returns {Array<{file: string, line: number, pattern: string, risk: string, severity: string, description: string, fix: string}>}
 */
export function staticAnalysis(migrationFiles) {
  if (!Array.isArray(migrationFiles)) {
    throw new Error('staticAnalysis requires an array of migration files');
  }

  const findings = [];

  for (const file of migrationFiles) {
    if (!file || !file.content) continue;

    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Check blocked patterns
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.regex.test(line)) {
          findings.push({
            file: file.path,
            line: lineNum,
            pattern: pattern.pattern,
            risk: pattern.risk,
            severity: pattern.severity,
            description: pattern.description,
            fix: pattern.fix,
          });
        }
      }

      // Check warning patterns
      for (const pattern of WARNING_PATTERNS) {
        if (pattern.regex.test(line)) {
          findings.push({
            file: file.path,
            line: lineNum,
            pattern: pattern.pattern,
            risk: pattern.risk,
            severity: pattern.severity,
            description: pattern.description,
            fix: pattern.fix,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Full migration safety check combining static analysis and optional LLM verification.
 *
 * @param {string} projectDir - Project root directory
 * @param {string} baseBranch - Base branch (e.g., 'origin/staging')
 * @param {string} headBranch - Head branch (e.g., 'origin/preview')
 * @returns {{safe: boolean, blocked: boolean, findings: Array, summary: string}}
 */
export async function checkMigrationSafety(projectDir, baseBranch, headBranch) {
  if (!projectDir || !baseBranch || !headBranch) {
    throw new Error('checkMigrationSafety requires projectDir, baseBranch, and headBranch');
  }

  // Extract migration files
  const migrationFiles = extractMigrationFiles(projectDir, baseBranch, headBranch);

  if (migrationFiles.length === 0) {
    return {
      safe: true,
      blocked: false,
      findings: [],
      summary: 'No migration files detected in diff.',
    };
  }

  // Run static analysis
  const findings = staticAnalysis(migrationFiles);

  const criticalFindings = findings.filter(f => f.severity === 'critical');
  const warningFindings = findings.filter(f => f.severity === 'warning');

  const blocked = criticalFindings.length > 0;

  // Try LLM verification for additional context (non-blocking on failure)
  let llmVerification = null;
  try {
    const { callLLMStructured } = await import('./llm-client.js');

    if (callLLMStructured && migrationFiles.length > 0) {
      const migrationSummary = migrationFiles.map(f =>
        `--- ${f.path} ---\n${f.content.slice(0, 2000)}`
      ).join('\n\n');

      const prompt = `Analyze these database migration files for backward-compatibility issues.

A migration is backward-compatible if the PREVIOUS version of the application code can still function correctly after the migration runs. This means:
- No columns/tables that old code references are removed or renamed
- No new NOT NULL constraints on columns where old code inserts NULLs
- No type changes that would break old code's queries

Migration files:
${migrationSummary}

Static analysis already found these issues: ${JSON.stringify(criticalFindings.map(f => f.pattern))}

Confirm or refute the static analysis findings. Are there any additional backward-compatibility concerns not caught by pattern matching?`;

      const schema = JSON.stringify({
        type: 'object',
        properties: {
          confirmed_issues: { type: 'array', items: { type: 'string' } },
          additional_concerns: { type: 'array', items: { type: 'string' } },
          overall_safe: { type: 'boolean' },
        },
        required: ['confirmed_issues', 'additional_concerns', 'overall_safe'],
      });

      llmVerification = await callLLMStructured(
        prompt,
        'You are a database migration safety reviewer. Be conservative — flag anything that could break on rollback.',
        schema,
        { timeout: 30000 }
      );
    }
  } catch {
    // LLM unavailable — rely on static analysis only (non-fatal)
  }

  // Build summary
  const parts = [];
  parts.push(`${migrationFiles.length} migration file${migrationFiles.length === 1 ? '' : 's'} analyzed.`);
  if (criticalFindings.length > 0) {
    parts.push(`${criticalFindings.length} BLOCKED pattern${criticalFindings.length === 1 ? '' : 's'} found: ${criticalFindings.map(f => f.pattern).join(', ')}.`);
  }
  if (warningFindings.length > 0) {
    parts.push(`${warningFindings.length} warning${warningFindings.length === 1 ? '' : 's'}: ${warningFindings.map(f => f.pattern).join(', ')}.`);
  }
  if (llmVerification) {
    if (llmVerification.additional_concerns && llmVerification.additional_concerns.length > 0) {
      parts.push(`LLM flagged additional concerns: ${llmVerification.additional_concerns.join('; ')}.`);
    }
  }
  if (!blocked) {
    parts.push('All migrations are backward-compatible. Safe to proceed.');
  }

  return {
    safe: !blocked,
    blocked,
    findings,
    summary: parts.join(' '),
    llmVerification,
  };
}
