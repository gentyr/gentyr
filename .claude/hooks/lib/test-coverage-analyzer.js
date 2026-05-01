/**
 * Test Coverage Analyzer
 *
 * Identifies source files with no corresponding test coverage.
 * Assesses risk based on file content (API endpoints, auth, money handling).
 *
 * @version 1.0.0
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Find source files and their corresponding test files.
 */
export function mapSourceToTests(projectDir = PROJECT_DIR) {
  const sourceFiles = [];
  const testFiles = new Set();

  try {
    // Find all source files
    const sources = execSync(
      'find . -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | grep -v node_modules | grep -v dist | grep -v .claude | grep -v .next | head -500',
      { cwd: projectDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();

    for (const file of sources.split('\n').filter(Boolean)) {
      if (/\.(test|spec|demo)\.(ts|tsx|js|jsx)$/.test(file) || /__(tests|mocks)__/.test(file)) {
        testFiles.add(file);
      } else {
        sourceFiles.push(file);
      }
    }
  } catch { return { sourceFiles: [], testFiles: new Set(), uncovered: [] }; }

  // Find uncovered source files
  const uncovered = sourceFiles.filter(src => {
    const base = src.replace(/\.(ts|tsx|js|jsx)$/, '');
    const testPatterns = [
      `${base}.test.ts`, `${base}.test.tsx`, `${base}.test.js`,
      `${base}.spec.ts`, `${base}.spec.tsx`, `${base}.spec.js`,
    ];
    return !testPatterns.some(p => testFiles.has(p));
  });

  return { sourceFiles, testFiles, uncovered };
}

/**
 * Assess risk level of an uncovered file.
 */
export function assessRisk(filePath, projectDir = PROJECT_DIR) {
  try {
    const content = fs.readFileSync(path.join(projectDir, filePath), 'utf8');

    // High risk patterns
    if (/api\s*route|router\.(get|post|put|delete|patch)/i.test(content)) return 'high';
    if (/auth|session|token|password|credential/i.test(content) && /middleware|handler|guard/i.test(content)) return 'critical';
    if (/payment|billing|invoice|subscription|charge/i.test(content)) return 'critical';
    if (/sql|query|exec|prepare/i.test(content) && !/\.test\./i.test(filePath)) return 'high';
    if (/export\s+default\s+function|export\s+function/i.test(content)) return 'medium';

    return 'low';
  } catch { return 'low'; }
}

/**
 * Get coverage gaps with risk assessment.
 */
export function getCoverageGaps(projectDir = PROJECT_DIR) {
  const { sourceFiles, uncovered } = mapSourceToTests(projectDir);

  const gaps = uncovered.map(file => ({
    file,
    risk: assessRisk(file, projectDir),
  }));

  // Sort by risk (critical > high > medium > low)
  const riskOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  gaps.sort((a, b) => (riskOrder[a.risk] || 3) - (riskOrder[b.risk] || 3));

  return {
    total_source_files: sourceFiles.length,
    uncovered_count: uncovered.length,
    coverage_percentage: sourceFiles.length > 0
      ? Math.round(((sourceFiles.length - uncovered.length) / sourceFiles.length) * 100)
      : 100,
    gaps,
  };
}
