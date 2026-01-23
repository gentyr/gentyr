#!/usr/bin/env node

/**
 * Spec-File Mapping Validator
 *
 * Validates the spec-file-mappings.json file against its schema.
 * Checks for:
 * - Valid JSON syntax
 * - Schema compliance
 * - All required specs present
 * - All mapped files exist on disk
 * - All spec files in specs/global/, specs/local/, and specs/reference/ have mapping entries
 * - Total agent count within limit
 *
 * @author Claude Code Hooks
 * @version 1.0.0
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

// Required global spec rules that MUST have entries in the mapping file
// These correspond to the G001-G011 rules in specs/global/CORE-INVARIANTS.md
const REQUIRED_SPECS = [
  'CORE-INVARIANTS.md' // Contains G001-G011 global invariants
];

/**
 * Validates the spec-file-mappings.json file
 * @param {string} projectDir - Project root directory
 * @param {object} config - Compliance configuration
 * @returns {ValidationResult}
 */
export function validateMappings(projectDir, config) {
  // G001: Fail-hard on missing config - no graceful fallbacks
  if (!config) {
    throw new Error('validateMappings: config parameter is required');
  }
  if (!config.global || typeof config.global.maxAgentsPerDay !== 'number') {
    throw new Error('validateMappings: config.global.maxAgentsPerDay is required and must be a number');
  }
  if (!config.mappingFile) {
    throw new Error('validateMappings: config.mappingFile is required');
  }

  const mappingPath = path.join(projectDir, config.mappingFile);
  const schemaPath = path.join(projectDir, '.claude/hooks/spec-file-mappings-schema.json');
  const maxAgents = config.global.maxAgentsPerDay;
  const errors = [];

  // 1. Check file exists
  if (!existsSync(mappingPath)) {
    return {
      valid: false,
      errors: [{
        code: 'MAPPING_FILE_MISSING',
        message: `Mapping file not found at ${mappingPath}`,
        suggestion: 'Create the mapping file with entries for all specs',
        severity: 'critical'
      }],
      agentCount: 0,
      specBreakdown: {},
      limit: maxAgents,
      utilizationPercent: 0
    };
  }

  // 2. Parse JSON
  let mappings;
  try {
    mappings = JSON.parse(readFileSync(mappingPath, 'utf8'));
  } catch (err) {
    return {
      valid: false,
      errors: [{
        code: 'INVALID_JSON',
        message: `Failed to parse mapping file: ${err.message}`,
        suggestion: 'Fix JSON syntax errors in the mapping file',
        severity: 'critical'
      }],
      agentCount: 0,
      specBreakdown: {},
      limit: maxAgents,
      utilizationPercent: 0
    };
  }

  // 3. Validate against JSON schema
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);

  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    return {
      valid: false,
      errors: [{
        code: 'SCHEMA_FILE_MISSING',
        message: `Failed to read schema file: ${err.message}`,
        suggestion: 'Ensure spec-file-mappings-schema.json exists',
        severity: 'critical'
      }],
      agentCount: 0,
      specBreakdown: {},
      limit: maxAgents,
      utilizationPercent: 0
    };
  }

  const schemaValid = ajv.validate(schema, mappings);

  if (!schemaValid) {
    for (const error of ajv.errors) {
      errors.push({
        code: 'SCHEMA_VIOLATION',
        message: `${error.instancePath}: ${error.message}`,
        suggestion: `Fix the schema violation at ${error.instancePath}`,
        severity: 'critical',
        details: error
      });
    }
  }

  // 4. Check all required specs have entries
  const presentSpecs = Object.keys(mappings.specs || {});
  for (const requiredSpec of REQUIRED_SPECS) {
    if (!presentSpecs.includes(requiredSpec)) {
      errors.push({
        code: 'MISSING_SPEC_ENTRY',
        message: `Required spec '${requiredSpec}' is missing from mappings`,
        suggestion: `Add an entry for ${requiredSpec} with at least one file`,
        severity: 'critical'
      });
    }
  }

  // 5. Validate all mapped files exist
  for (const [spec, specData] of Object.entries(mappings.specs || {})) {
    for (const fileEntry of specData.files || []) {
      const filePath = path.join(projectDir, fileEntry.path);
      if (!existsSync(filePath)) {
        errors.push({
          code: 'FILE_NOT_FOUND',
          message: `Mapped file '${fileEntry.path}' for spec '${spec}' does not exist`,
          suggestion: `Remove '${fileEntry.path}' from ${spec} or fix the path`,
          severity: 'critical'
        });
      }
    }
  }

  // 6. Detect unmapped spec files in specs/global/, specs/local/, and specs/reference/
  const specDirs = ['specs/global', 'specs/local', 'specs/reference'];
  const mappedSpecNames = Object.keys(mappings.specs || {});

  for (const specDir of specDirs) {
    const specDirPath = path.join(projectDir, specDir);
    if (existsSync(specDirPath)) {
      const specFiles = readdirSync(specDirPath)
        .filter(file => file.endsWith('.md'));

      for (const specFile of specFiles) {
        if (!mappedSpecNames.includes(specFile)) {
          errors.push({
            code: 'UNMAPPED_SPEC_FILE',
            message: `Spec file '${specDir}/${specFile}' exists but has no mapping entry`,
            suggestion: `Add '${specFile}' to spec-file-mappings.json with at least one source file`,
            severity: 'critical'
          });
        }
      }
    }
  }

  // 7. Calculate total agent count
  let agentCount = 0;
  for (const specData of Object.values(mappings.specs || {})) {
    agentCount += (specData.files || []).length;
  }

  // 8. Check agent limit
  if (agentCount > maxAgents) {
    errors.push({
      code: 'AGENT_LIMIT_EXCEEDED',
      message: `Total agent count (${agentCount}) exceeds daily limit (${maxAgents})`,
      suggestion: `Remove ${agentCount - maxAgents} files from mappings. ` +
                  `Prioritize removing low-priority specs or files unlikely to violate.`,
      severity: 'critical',
      details: {
        currentCount: agentCount,
        limit: maxAgents,
        excess: agentCount - maxAgents
      }
    });
  }

  // 9. Build per-spec breakdown for reporting
  const specBreakdown = {};
  for (const [spec, specData] of Object.entries(mappings.specs || {})) {
    specBreakdown[spec] = {
      fileCount: (specData.files || []).length,
      priority: specData.priority
    };
  }

  const hasCriticalErrors = errors.some(e => e.severity === 'critical');

  return {
    valid: !hasCriticalErrors,
    errors,
    agentCount,
    specBreakdown,
    limit: maxAgents,
    utilizationPercent: Math.round((agentCount / maxAgents) * 100)
  };
}

/**
 * Format validation result as human-readable message
 * @param {ValidationResult} result
 * @returns {string}
 */
export function formatValidationResult(result) {
  const lines = [];

  lines.push('╔═══════════════════════════════════════════════════════════════╗');
  lines.push('║           SPEC-FILE MAPPING VALIDATION RESULT                 ║');
  lines.push('╠═══════════════════════════════════════════════════════════════╣');

  if (result.valid) {
    lines.push('║ Status: ✅ VALID                                              ║');
  } else {
    lines.push('║ Status: ❌ INVALID                                            ║');
  }

  const countStr = `${result.agentCount} / ${result.limit}`.padEnd(10);
  const percentStr = `${result.utilizationPercent}%`.padEnd(4);
  lines.push(`║ Total Agents: ${countStr} (${percentStr} utilized)           ║`);
  lines.push('╠═══════════════════════════════════════════════════════════════╣');

  if (result.specBreakdown && Object.keys(result.specBreakdown).length > 0) {
    lines.push('║ Per-Spec Breakdown:                                           ║');
    for (const [spec, data] of Object.entries(result.specBreakdown)) {
      const paddedSpec = spec.substring(0, 25).padEnd(25);
      const count = String(data.fileCount).padStart(3);
      const priority = `[${data.priority}]`.padEnd(10);
      lines.push(`║   ${paddedSpec} ${count} files ${priority}          ║`);
    }
  }

  if (result.errors.length > 0) {
    lines.push('╠═══════════════════════════════════════════════════════════════╣');
    lines.push('║ Errors:                                                       ║');
    for (const error of result.errors) {
      const severityStr = `[${error.severity.toUpperCase()}]`.padEnd(12);
      lines.push(`║ ${severityStr} ${error.code.padEnd(48)} ║`);

      // Wrap long messages
      const msgWords = error.message.split(' ');
      let currentLine = '║   ';
      for (const word of msgWords) {
        if (currentLine.length + word.length + 1 > 63) {
          lines.push(currentLine.padEnd(63) + '║');
          currentLine = '║   ' + word;
        } else {
          currentLine += (currentLine.length > 4 ? ' ' : '') + word;
        }
      }
      if (currentLine.length > 4) {
        lines.push(currentLine.padEnd(63) + '║');
      }

      // Add suggestion
      lines.push(`║   → ${error.suggestion.substring(0, 57).padEnd(57)} ║`);
      lines.push('║                                                               ║');
    }
  }

  lines.push('╚═══════════════════════════════════════════════════════════════╝');

  return lines.join('\n');
}
