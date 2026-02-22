/**
 * Tests for patch-credential-cache.py - binary patch research script
 *
 * This script is a DRY-RUN ONLY research tool for analyzing Claude Code's
 * credential cache memoization. Tests validate structural correctness only.
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test scripts/__tests__/patch-credential-cache.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT_PATH = path.join(__dirname, '..', 'patch-credential-cache.py');

describe('patch-credential-cache.py - Structure', () => {
  describe('Script header and permissions', () => {
    it('should have Python shebang', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /^#!\/usr\/bin\/env python3/,
        'Must have python3 shebang for executable'
      );
    });

    it('should be executable', () => {
      const stats = fs.statSync(SCRIPT_PATH);
      const isExecutable = (stats.mode & 0o111) !== 0;

      assert.ok(isExecutable, 'Script must be executable');
    });

    it('should include DRY-RUN ONLY warning in docstring', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /DRY-RUN ONLY/,
        'Must include DRY-RUN ONLY warning'
      );
    });

    it('should include warning about no writes without --apply', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /No writes without --apply/,
        'Must warn that writes require --apply flag'
      );
    });
  });

  describe('Required functions', () => {
    it('should define find_claude_binary function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /def find_claude_binary\(\):/,
        'Must define find_claude_binary function'
      );
    });

    it('should define search_patterns function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /def search_patterns\(/,
        'Must define search_patterns function'
      );
    });

    it('should define analyze_or_function function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /def analyze_or_function\(/,
        'Must define analyze_or_function function'
      );
    });

    it('should define propose_patch function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /def propose_patch\(/,
        'Must define propose_patch function'
      );
    });

    it('should define main function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /def main\(\):/,
        'Must define main function'
      );
    });
  });

  describe('Pattern search patterns', () => {
    it('should search for oR memoization assignment', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_or_assign/,
        'Must define pat_or_assign pattern for oR memoization'
      );

      assert.match(
        code,
        /rb'oR=/,
        'Pattern must search for oR assignment in binary'
      );
    });

    it('should search for iB credential reader assignment', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_ib/,
        'Must define pat_ib pattern'
      );

      assert.match(
        code,
        /iB=oR/,
        'Pattern must match iB=oR(()=>{ assignment'
      );
    });

    it('should search for iB.cache?.clear?.() calls', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_cache_clear/,
        'Must define pat_cache_clear pattern'
      );

      assert.match(
        code,
        /iB\\.cache/,
        'Pattern must match iB.cache clear calls'
      );
    });

    it('should search for nLD cache invalidation function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_nld/,
        'Must define pat_nld pattern'
      );
    });

    it('should search for SRA proactive refresh function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_sra/,
        'Must define pat_sra pattern for SRA function'
      );
    });

    it('should search for r6T 401 recovery function', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_r6t/,
        'Must define pat_r6t pattern for r6T function'
      );
    });

    it('should search for jv expiry check calls', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /pat_jv_call/,
        'Must define pat_jv_call pattern for jv calls'
      );
    });
  });

  describe('Command-line arguments', () => {
    it('should accept --dry-run flag (default true)', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /--dry-run/,
        'Must accept --dry-run flag'
      );

      assert.match(
        code,
        /default=True/,
        '--dry-run must default to True'
      );
    });

    it('should accept --binary flag for custom binary path', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /--binary/,
        'Must accept --binary flag'
      );
    });

    it('should accept --verbose flag', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /--verbose/,
        'Must accept --verbose flag'
      );
    });
  });

  describe('Safety guards', () => {
    it('should document that approach A (setInterval injection) is preferred', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /Approach A \(preferred\)/,
        'Must document Approach A as preferred'
      );

      assert.match(
        code,
        /setInterval/,
        'Approach A must use setInterval'
      );
    });

    it('should calculate injection byte count', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /injection_bytes/,
        'Must track injection_bytes in proposals'
      );
    });

    it('should provide feasibility assessment', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /feasibility/,
        'Must include feasibility assessment in proposals'
      );
    });

    it('should include recommendation with safety notes', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /RECOMMENDATION/,
        'Must include RECOMMENDATION proposal type'
      );

      assert.match(
        code,
        /safest path/,
        'Recommendation must highlight safety'
      );
    });
  });

  describe('Error handling', () => {
    it('should report ERROR when critical patterns are missing', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /'type': 'ERROR'/,
        'Must generate ERROR proposal type when patterns missing'
      );
    });

    it('should exit with code 1 when patterns are missing', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /sys\.exit\(1\)/,
        'Must exit with code 1 on critical errors'
      );
    });

    it('should check for binary existence', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /Could not find Claude Code binary/,
        'Must check for binary existence and provide error message'
      );
    });
  });

  describe('Output structure', () => {
    it('should print pattern search results', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /Pattern Search/,
        'Must include Pattern Search section in output'
      );
    });

    it('should print patch analysis proposals', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /Patch Analysis/,
        'Must include Patch Analysis section in output'
      );
    });

    it('should print summary with pattern counts', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /Summary/,
        'Must include Summary section'
      );

      assert.match(
        code,
        /Patterns found/,
        'Summary must report pattern count'
      );
    });

    it('should provide next steps when successful', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /Next steps:/,
        'Must provide next steps guidance'
      );

      assert.match(
        code,
        /codesign --remove-signature/,
        'Next steps must include codesign instruction for macOS'
      );
    });
  });
});

describe('patch-credential-cache.py - Behavioral Logic', () => {
  describe('Binary candidate search paths', () => {
    it('should check ~/.claude/local/claude first', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/def find_claude_binary\(\):[\s\S]*?return None/);
      assert.ok(fnMatch, 'find_claude_binary must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /~\/\.claude\/local\/claude/,
        'Must check ~/.claude/local/claude'
      );
    });

    it('should check /opt/homebrew/bin/claude', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/def find_claude_binary\(\):[\s\S]*?return None/);
      assert.ok(fnMatch, 'find_claude_binary must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /\/opt\/homebrew\/bin\/claude/,
        'Must check /opt/homebrew/bin/claude (Apple Silicon Homebrew)'
      );
    });

    it('should check /usr/local/bin/claude', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/def find_claude_binary\(\):[\s\S]*?return None/);
      assert.ok(fnMatch, 'find_claude_binary must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /\/usr\/local\/bin\/claude/,
        'Must check /usr/local/bin/claude (Intel Homebrew)'
      );
    });

    it('should resolve symlinks with realpath', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      const fnMatch = code.match(/def find_claude_binary\(\):[\s\S]*?return None/);
      assert.ok(fnMatch, 'find_claude_binary must be defined');
      const fnBody = fnMatch[0];

      assert.match(
        fnBody,
        /os\.path\.realpath/,
        'Must resolve symlinks with realpath'
      );
    });
  });

  describe('Patch injection strategy', () => {
    it('should prefer 60-second TTL interval (6e4 ms)', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /6e4/,
        'Injection must use 60000ms (60 seconds) interval'
      );
    });

    it('should inject after CFT=null marker', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      assert.match(
        code,
        /CFT=null/,
        'Must search for CFT=null marker as injection point'
      );
    });

    it('should propose comma-prefixed injection to maintain syntax', () => {
      const code = fs.readFileSync(SCRIPT_PATH, 'utf8');

      // Check in the full code for the injection string
      assert.match(
        code,
        /b',setInterval/,
        'Injection must start with comma to maintain JS syntax'
      );
    });
  });
});
