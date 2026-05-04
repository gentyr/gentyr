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
 * Two analysis layers:
 * 1. Static regex analysis (fast, deterministic) — catches known destructive patterns
 * 2. LLM-powered analysis (thorough, per-file) — catches context-dependent issues
 *    that regex misses (e.g., conditional DDL, stored procedures, complex ALTER chains)
 *
 * @version 2.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

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
 * - any-path/migrations/any-file
 * - any-path/migrate/any-file
 * - db/*.sql
 * - schema*.sql
 * - supabase/migrations/any-file
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

/**
 * JSON schema for the per-file LLM analysis output.
 * Each migration file is analyzed for individual SQL operations.
 */
const ANALYZE_MIGRATIONS_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The SQL statement or operation being analyzed' },
          classification: {
            type: 'string',
            enum: ['SAFE', 'WARNING', 'BLOCKED'],
            description: 'SAFE = additive/harmless, WARNING = safe but may lock table, BLOCKED = breaks backward compatibility',
          },
          reason: { type: 'string', description: 'Why this operation has this classification' },
          fixSuggestion: { type: 'string', description: 'How to make this operation backward-compatible using expand/contract' },
        },
        required: ['sql', 'classification', 'reason'],
      },
    },
  },
  required: ['operations'],
});

const ANALYZE_SYSTEM_PROMPT = `You are a database migration backward-compatibility analyzer.

Your job is to classify each SQL operation in a migration file for backward compatibility.

A migration is backward-compatible if the PREVIOUS version of the application code can still function correctly after the migration runs. This is critical for safe rollback: if a deploy is rolled back, the old code must work with the new schema.

Classification rules:
- BLOCKED: The operation breaks backward compatibility. Old code WILL fail after this runs.
  Examples: DROP TABLE, DROP COLUMN, RENAME COLUMN/TABLE, SET NOT NULL (old code may insert NULLs), ALTER TYPE (old code expects old type)
- WARNING: The operation is safe but has operational risk (e.g., table locks).
  Examples: CREATE INDEX without CONCURRENTLY (locks table), large data backfill
- SAFE: The operation is additive and old code is unaffected.
  Examples: ADD COLUMN (with default or nullable), ADD TABLE, ADD INDEX CONCURRENTLY, INSERT/UPDATE data, CREATE FUNCTION

For BLOCKED operations, provide a fixSuggestion using the expand/contract pattern:
- DROP COLUMN → Deploy code that stops using it → wait → DROP in cleanup migration
- RENAME → ADD new → backfill → deploy code using new → DROP old later
- SET NOT NULL → Deploy code that never inserts NULL → backfill NULLs → add constraint later
- ALTER TYPE → ADD new column with target type → backfill → deploy code using new → DROP old later

Be conservative: when in doubt, classify as BLOCKED rather than SAFE.
Extract EVERY distinct SQL operation from the file. Do not skip any.`;

/**
 * LLM-powered per-file migration analysis.
 *
 * Sends each migration file to Haiku for structured analysis, classifying
 * every SQL operation as SAFE, WARNING, or BLOCKED with reasons and fix suggestions.
 *
 * Falls back to static analysis alone if the LLM is unavailable.
 *
 * @param {Array<{path: string, content: string}>} migrationFiles - Migration files to analyze
 * @param {string} [projectDir] - Project root directory (defaults to PROJECT_DIR)
 * @returns {Promise<{safe: boolean, results: Array<{file: string, operations: Array<{sql: string, classification: string, reason: string, fixSuggestion?: string}>}>}>}
 */
export async function analyzeMigrations(migrationFiles, projectDir) {
  if (!Array.isArray(migrationFiles)) {
    throw new Error('analyzeMigrations requires an array of migration files');
  }

  if (migrationFiles.length === 0) {
    return { safe: true, results: [] };
  }

  const resolvedDir = projectDir || PROJECT_DIR;
  const results = [];
  let overallSafe = true;

  // Run static analysis first as baseline
  const staticFindings = staticAnalysis(migrationFiles);
  const staticByFile = new Map();
  for (const finding of staticFindings) {
    if (!staticByFile.has(finding.file)) {
      staticByFile.set(finding.file, []);
    }
    staticByFile.get(finding.file).push(finding);
  }

  // Try to load LLM client
  let callLLMStructured = null;
  try {
    const llmClient = await import('./llm-client.js');
    callLLMStructured = llmClient.callLLMStructured;
  } catch {
    // LLM unavailable — fall back to static analysis only
  }

  for (const file of migrationFiles) {
    if (!file || !file.path || !file.content) continue;

    // Attempt LLM analysis
    let llmOperations = null;
    if (callLLMStructured) {
      try {
        const truncatedContent = file.content.slice(0, 4000);
        const prompt = `Analyze this database migration file for backward-compatibility.

File: ${file.path}

\`\`\`sql
${truncatedContent}
\`\`\`

Classify every SQL operation in this file.`;

        const llmResult = await callLLMStructured(
          prompt,
          ANALYZE_SYSTEM_PROMPT,
          ANALYZE_MIGRATIONS_SCHEMA,
          { timeout: 30000 }
        );

        if (llmResult && Array.isArray(llmResult.operations)) {
          llmOperations = llmResult.operations;
        }
      } catch {
        // LLM call failed for this file — fall through to static fallback
      }
    }

    if (llmOperations) {
      // Use LLM results — validate classifications
      const operations = llmOperations.map(op => {
        if (!op.sql || !op.classification || !op.reason) {
          throw new Error(
            `LLM returned invalid operation for file ${file.path}: missing required fields (sql, classification, reason)`
          );
        }
        const classification = op.classification.toUpperCase();
        if (!['SAFE', 'WARNING', 'BLOCKED'].includes(classification)) {
          throw new Error(
            `LLM returned invalid classification "${op.classification}" for file ${file.path}. Must be SAFE, WARNING, or BLOCKED.`
          );
        }
        return {
          sql: op.sql,
          classification,
          reason: op.reason,
          ...(op.fixSuggestion ? { fixSuggestion: op.fixSuggestion } : {}),
        };
      });

      // Cross-validate: if static analysis found a BLOCKED pattern that LLM missed,
      // add it. Static analysis is deterministic — it must never be overridden by LLM.
      const fileStaticFindings = staticByFile.get(file.path) || [];
      for (const finding of fileStaticFindings) {
        if (finding.severity === 'critical') {
          const alreadyCaught = operations.some(
            op => op.classification === 'BLOCKED' && op.sql.toUpperCase().includes(finding.pattern.split(' ')[0])
          );
          if (!alreadyCaught) {
            operations.push({
              sql: finding.pattern,
              classification: 'BLOCKED',
              reason: `${finding.risk} (detected by static analysis)`,
              fixSuggestion: finding.fix,
            });
          }
        }
      }

      const hasBlocked = operations.some(op => op.classification === 'BLOCKED');
      if (hasBlocked) overallSafe = false;

      results.push({ file: file.path, operations });
    } else {
      // Fall back to static analysis for this file
      const fileStaticFindings = staticByFile.get(file.path) || [];

      if (fileStaticFindings.length === 0) {
        // No static findings — mark the whole file as SAFE with a single entry
        results.push({
          file: file.path,
          operations: [{
            sql: '(entire file)',
            classification: 'SAFE',
            reason: 'No destructive patterns detected by static analysis. LLM unavailable for deeper analysis.',
          }],
        });
      } else {
        const operations = fileStaticFindings.map(finding => ({
          sql: finding.pattern,
          classification: finding.severity === 'critical' ? 'BLOCKED' : 'WARNING',
          reason: finding.risk,
          fixSuggestion: finding.fix,
        }));

        const hasBlocked = operations.some(op => op.classification === 'BLOCKED');
        if (hasBlocked) overallSafe = false;

        results.push({ file: file.path, operations });
      }
    }
  }

  return { safe: overallSafe, results };
}

// ---------------------------------------------------------------------------
// Self-test — runs when this file is executed directly: node migration-safety.js
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${fileURLToPath(import.meta.url).replace(/\\/g, '/')}` ||
    process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const testFiles = [
      {
        path: 'supabase/migrations/001_safe.sql',
        content: `
CREATE TABLE users (id uuid PRIMARY KEY, name TEXT);
ALTER TABLE users ADD COLUMN email TEXT;
INSERT INTO users (id, name) VALUES ('abc', 'test');
CREATE INDEX CONCURRENTLY idx_users_email ON users(email);
        `.trim(),
      },
      {
        path: 'supabase/migrations/002_dangerous.sql',
        content: `
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users RENAME COLUMN name TO display_name;
ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
CREATE INDEX idx_users_display_name ON users(display_name);
        `.trim(),
      },
      {
        path: 'supabase/migrations/003_type_change.sql',
        content: `
ALTER TABLE users ALTER COLUMN id TYPE BIGINT;
DROP TABLE legacy_data;
        `.trim(),
      },
    ];

    console.log('=== Migration Safety Self-Test ===\n');

    // Test 1: Static analysis
    console.log('--- Test 1: Static Analysis ---');
    const staticResults = staticAnalysis(testFiles);
    const criticalCount = staticResults.filter(f => f.severity === 'critical').length;
    const warningCount = staticResults.filter(f => f.severity === 'warning').length;
    console.log(`  Found ${criticalCount} critical, ${warningCount} warning findings`);

    // Expected: DROP COLUMN, RENAME COLUMN, SET NOT NULL, ALTER TYPE, DROP TABLE = 5 critical
    // Expected: CREATE INDEX (without CONCURRENTLY in file 002) = 1 warning
    if (criticalCount !== 5) {
      console.error(`  FAIL: Expected 5 critical findings, got ${criticalCount}`);
      console.error('  Details:', JSON.stringify(staticResults.filter(f => f.severity === 'critical').map(f => f.pattern), null, 2));
      process.exit(1);
    }
    if (warningCount !== 1) {
      console.error(`  FAIL: Expected 1 warning finding, got ${warningCount}`);
      process.exit(1);
    }
    console.log('  PASS: Static analysis correctly identified all patterns\n');

    // Test 2: Safe file detection
    console.log('--- Test 2: Safe File Only ---');
    const safeOnly = staticAnalysis([testFiles[0]]);
    if (safeOnly.length !== 0) {
      console.error(`  FAIL: Expected 0 findings for safe file, got ${safeOnly.length}`);
      process.exit(1);
    }
    console.log('  PASS: Safe file produced no findings\n');

    // Test 3: analyzeMigrations without LLM (static fallback)
    console.log('--- Test 3: analyzeMigrations (static fallback) ---');
    const analyzeResult = await analyzeMigrations(testFiles);
    if (analyzeResult.safe !== false) {
      console.error('  FAIL: Expected safe=false for files with BLOCKED patterns');
      process.exit(1);
    }
    if (analyzeResult.results.length !== 3) {
      console.error(`  FAIL: Expected 3 file results, got ${analyzeResult.results.length}`);
      process.exit(1);
    }

    const blockedOps = analyzeResult.results.flatMap(r => r.operations).filter(op => op.classification === 'BLOCKED');
    if (blockedOps.length < 5) {
      console.error(`  FAIL: Expected at least 5 BLOCKED operations, got ${blockedOps.length}`);
      process.exit(1);
    }
    console.log(`  PASS: analyzeMigrations returned safe=false with ${blockedOps.length} BLOCKED operations\n`);

    // Test 4: Empty input
    console.log('--- Test 4: Empty Input ---');
    const emptyResult = await analyzeMigrations([]);
    if (emptyResult.safe !== true || emptyResult.results.length !== 0) {
      console.error('  FAIL: Expected safe=true and empty results for empty input');
      process.exit(1);
    }
    console.log('  PASS: Empty input returns safe=true\n');

    // Test 5: Input validation
    console.log('--- Test 5: Input Validation ---');
    let threw = false;
    try {
      await analyzeMigrations('not an array');
    } catch (err) {
      if (err.message.includes('requires an array')) threw = true;
    }
    if (!threw) {
      console.error('  FAIL: Expected error for non-array input');
      process.exit(1);
    }
    console.log('  PASS: Non-array input throws descriptive error\n');

    console.log('=== All self-tests passed ===');
  })();
}
