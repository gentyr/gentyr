/**
 * AI Compatibility Check
 *
 * Validates dependency updates won't break the project by analyzing
 * changelogs, breaking changes, and project usage via Haiku LLM.
 *
 * @version 1.0.0
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { callLLMStructured } from './llm-client.js';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * JSON schema for the LLM compatibility analysis response.
 */
const COMPATIBILITY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    compatible: {
      type: 'boolean',
      description: 'Whether the upgrade is likely compatible with the project',
    },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low'],
            description: 'Risk severity',
          },
          description: {
            type: 'string',
            description: 'What could break',
          },
          affected_files: {
            type: 'array',
            items: { type: 'string' },
            description: 'Project files that may be affected',
          },
        },
        required: ['severity', 'description'],
      },
      description: 'Identified risks from the upgrade',
    },
    migration_steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Steps needed to safely upgrade',
    },
  },
  required: ['compatible', 'risks', 'migration_steps'],
});

const SYSTEM_PROMPT = `You are a dependency compatibility analyzer. You will be given:
1. A package name and version range (from → to)
2. Package metadata (readme/changelog excerpt)
3. How the project currently uses the package (import/require statements)

Your job:
- Analyze whether the version upgrade introduces breaking API changes
- Check Node.js version compatibility if mentioned
- Identify migration steps needed
- Be CONSERVATIVE: if you're unsure about compatibility, mark it as a risk

Return compatible=true only if you're confident the upgrade is safe with no changes.
Return compatible=false if any breaking change or migration step is needed.`;

/**
 * Find all files in the project that import/require a given package.
 *
 * @param {string} packageName - npm package name
 * @param {string} projectDir - project root
 * @returns {string[]} Array of { file, line } usage instances (max 20)
 */
function findProjectUsage(packageName, projectDir) {
  try {
    // Escape the package name for use in grep regex
    const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = execSync(
      `grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" ` +
      `"(from\\s+['\\"']${escaped}|require\\s*\\(\\s*['\\"']${escaped})" . ` +
      `| grep -v node_modules | grep -v dist | grep -v .next | head -20`,
      { cwd: projectDir, encoding: 'utf8', timeout: 10000, stdio: 'pipe' }
    ).trim();

    if (!result) return [];
    return result.split('\n').filter(Boolean);
  } catch {
    // grep exits 1 when no matches found — that's fine
    return [];
  }
}

/**
 * Fetch package metadata from npm registry.
 *
 * @param {string} packageName - npm package name
 * @param {string} version - target version
 * @returns {string|null} Relevant readme/changelog excerpt (truncated to 4000 chars)
 */
function fetchPackageMetadata(packageName, version) {
  try {
    const raw = execSync(
      `npm view ${packageName}@${version} readme --json 2>/dev/null || npm view ${packageName}@${version} description --json 2>/dev/null`,
      { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }
    ).trim();

    if (!raw) return null;

    // npm view --json wraps strings in quotes
    let text;
    try {
      text = JSON.parse(raw);
    } catch {
      text = raw;
    }

    if (typeof text !== 'string') return null;

    // Extract changelog/breaking changes sections if present
    const breakingMatch = text.match(/#{1,3}\s*(breaking|migration|upgrade|changelog).*$/im);
    if (breakingMatch) {
      const startIdx = breakingMatch.index || 0;
      return text.slice(startIdx, startIdx + 4000);
    }

    // Fallback: return first 4000 chars
    return text.slice(0, 4000);
  } catch {
    return null;
  }
}

/**
 * Check compatibility of a dependency upgrade using LLM analysis.
 *
 * @param {string} packageName - npm package name (e.g. "react")
 * @param {string} fromVersion - current version (e.g. "17.0.2")
 * @param {string} toVersion - target version (e.g. "18.2.0")
 * @param {string} [projectDir] - project root directory
 * @returns {Promise<{ compatible: boolean, risks: Array<{ severity: string, description: string, affected_files?: string[] }>, migration_steps: string[] } | null>}
 *   Returns the analysis result, or null if the LLM call fails.
 */
export async function checkDependencyCompatibility(packageName, fromVersion, toVersion, projectDir = PROJECT_DIR) {
  // 1. Gather project usage
  const usage = findProjectUsage(packageName, projectDir);

  // 2. Fetch package metadata for the target version
  const metadata = fetchPackageMetadata(packageName, toVersion);

  // 3. Build the LLM prompt
  const usageSection = usage.length > 0
    ? `## Project Usage (${usage.length} imports found)\n\n${usage.join('\n')}`
    : `## Project Usage\n\nNo direct imports found. The package may be a transitive dependency.`;

  const metadataSection = metadata
    ? `## Package Metadata (${packageName}@${toVersion})\n\n${metadata}`
    : `## Package Metadata\n\nNo readme/changelog available from npm registry.`;

  const prompt = [
    `## Dependency Upgrade Analysis`,
    ``,
    `Package: ${packageName}`,
    `From: ${fromVersion}`,
    `To: ${toVersion}`,
    ``,
    metadataSection,
    ``,
    usageSection,
  ].join('\n');

  // 4. Call LLM for analysis
  const result = await callLLMStructured(prompt, SYSTEM_PROMPT, COMPATIBILITY_SCHEMA, {
    timeout: 45000,
  });

  if (!result) return null;

  // Validate the result shape
  if (typeof result.compatible !== 'boolean') return null;
  if (!Array.isArray(result.risks)) result.risks = [];
  if (!Array.isArray(result.migration_steps)) result.migration_steps = [];

  return result;
}
