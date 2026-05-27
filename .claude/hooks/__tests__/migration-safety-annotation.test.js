/**
 * Unit tests for the expand-contract annotation in migration-safety.js
 *
 * Verifies:
 *   - extractExpandContractAnnotation parses `-- @expand-contract-verified: <reason>`
 *     (and `// ` / `# ` comment prefixes) from the first 20 lines of a file
 *   - Empty reasons are rejected (returns null)
 *   - Trailing whitespace is trimmed
 *   - Annotations beyond line 20 are ignored
 *   - staticAnalysis downgrades BLOCKED → 'acknowledged' for annotated files
 *     and attaches the reason on the finding
 *   - staticAnalysis leaves non-annotated destructive ops at severity 'critical'
 *
 * Run with: node --test .claude/hooks/__tests__/migration-safety-annotation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  extractExpandContractAnnotation,
  staticAnalysis,
} from '../lib/migration-safety.js';

describe('extractExpandContractAnnotation', () => {
  it('parses SQL-style -- annotation', () => {
    const reason = extractExpandContractAnnotation(
      '-- @expand-contract-verified: column unused since v2.3\nDROP COLUMN foo;',
    );
    assert.strictEqual(reason, 'column unused since v2.3');
  });

  it('parses JS-style // annotation', () => {
    const reason = extractExpandContractAnnotation(
      '// @expand-contract-verified: rolled out in 1.4.0\nDROP TABLE x;',
    );
    assert.strictEqual(reason, 'rolled out in 1.4.0');
  });

  it('parses shell-style # annotation', () => {
    const reason = extractExpandContractAnnotation(
      '# @expand-contract-verified: bar\nDROP TABLE x;',
    );
    assert.strictEqual(reason, 'bar');
  });

  it('returns null when annotation is absent', () => {
    assert.strictEqual(
      extractExpandContractAnnotation('-- some other comment\nDROP COLUMN x;'),
      null,
    );
  });

  it('returns null on empty reason', () => {
    assert.strictEqual(
      extractExpandContractAnnotation('-- @expand-contract-verified:\nDROP COLUMN x;'),
      null,
    );
  });

  it('returns null on whitespace-only reason', () => {
    assert.strictEqual(
      extractExpandContractAnnotation('-- @expand-contract-verified:   \nDROP COLUMN x;'),
      null,
    );
  });

  it('returns null on empty input', () => {
    assert.strictEqual(extractExpandContractAnnotation(''), null);
    assert.strictEqual(extractExpandContractAnnotation(null), null);
    assert.strictEqual(extractExpandContractAnnotation(undefined), null);
  });

  it('ignores annotation past line 20', () => {
    const lines = Array(21).fill('-- filler');
    lines.push('-- @expand-contract-verified: late');
    lines.push('DROP COLUMN x;');
    assert.strictEqual(extractExpandContractAnnotation(lines.join('\n')), null);
  });

  it('trims trailing whitespace from the reason', () => {
    const reason = extractExpandContractAnnotation(
      '-- @expand-contract-verified: trimmed   \nDROP COLUMN x;',
    );
    assert.strictEqual(reason, 'trimmed');
  });
});

describe('staticAnalysis acknowledgement', () => {
  it('downgrades BLOCKED finding to acknowledged when annotation is present', () => {
    const findings = staticAnalysis([
      {
        path: 'mig1.sql',
        content: '-- @expand-contract-verified: safe per RFC\nDROP COLUMN foo;',
      },
    ]);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'acknowledged');
    assert.strictEqual(findings[0].acknowledgement_reason, 'safe per RFC');
    assert.strictEqual(findings[0].pattern, 'DROP COLUMN');
  });

  it('leaves non-annotated destructive ops at severity critical', () => {
    const findings = staticAnalysis([
      { path: 'mig2.sql', content: 'DROP COLUMN foo;' },
    ]);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].severity, 'critical');
    assert.strictEqual(findings[0].acknowledgement_reason, undefined);
  });

  it('handles a mix of annotated and non-annotated files', () => {
    const findings = staticAnalysis([
      {
        path: 'annotated.sql',
        content: '-- @expand-contract-verified: reason A\nDROP TABLE foo;',
      },
      { path: 'plain.sql', content: 'DROP TABLE bar;' },
    ]);
    assert.strictEqual(findings.length, 2);
    const annotated = findings.find((f) => f.file === 'annotated.sql');
    const plain = findings.find((f) => f.file === 'plain.sql');
    assert.strictEqual(annotated.severity, 'acknowledged');
    assert.strictEqual(plain.severity, 'critical');
  });
});
