/**
 * Tests for scripts/apply-bundle-security-fixes.sh
 *
 * This test file verifies that the apply script:
 *   1. Contains the correct patch content for all three hook files
 *   2. Has all required anchor strings that the script validates
 *   3. Has all required smoke test checks
 *   4. Covers idempotency detection strings
 *   5. Validates the patch Python code references correct replacement content
 *
 * These tests run against the SCRIPT FILE ITSELF (string content checks)
 * and do not require the patches to be applied to the hook files.
 * They are safe to run at any time, before or after patching.
 *
 * Run with: node --test .claude/hooks/__tests__/apply-bundle-security-fixes.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve script path.
//
// Due to symlink resolution in Node.js (import.meta.url uses realpath),
// __dirname may point to the symlink target (e.g. /git/gentyr/.claude/hooks/__tests__)
// rather than the actual project directory (/git/my-project/.claude/hooks/__tests__/).
//
// Strategy: search multiple candidate repo roots for the script:
//   1. process.cwd() — the directory tests are run from
//   2. process.env.CLAUDE_PROJECT_DIR — set by Claude hooks infrastructure
//   3. __dirname resolved upward (may follow symlinks)
//   4. Scan all worktrees under each candidate root
//
// The script only lives on the feature branch worktree until merged to main.

function findScript() {
  const searchRoots = [];

  // Add cwd-based root (most reliable when running from repo root)
  const cwd = process.cwd();
  searchRoots.push(cwd);

  // Add CLAUDE_PROJECT_DIR if set
  if (process.env.CLAUDE_PROJECT_DIR) {
    searchRoots.push(process.env.CLAUDE_PROJECT_DIR);
  }

  // Add __dirname-based roots (may be symlink-resolved)
  searchRoots.push(path.resolve(__dirname, '..', '..', '..'));        // 3 levels: gentyr or target project
  searchRoots.push(path.resolve(__dirname, '..', '..', '..', '..'));  // 4 levels: fallback

  // Deduplicate
  const seen = new Set();
  const uniqueRoots = searchRoots.filter((r) => {
    if (seen.has(r)) return false;
    seen.add(r);
    return true;
  });

  for (const root of uniqueRoots) {
    // Try direct scripts/ in root
    const direct = path.join(root, 'scripts', 'apply-bundle-security-fixes.sh');
    if (fs.existsSync(direct)) {
      return direct;
    }

    // Scan worktrees under this root
    const worktreesDir = path.join(root, '.claude', 'worktrees');
    if (fs.existsSync(worktreesDir)) {
      try {
        const worktrees = fs.readdirSync(worktreesDir);
        for (const wt of worktrees) {
          const candidate = path.join(worktreesDir, wt, 'scripts', 'apply-bundle-security-fixes.sh');
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        // ignore scan errors
      }
    }
  }

  // Not found — return a descriptive path for the error message
  return path.join(uniqueRoots[0], 'scripts', 'apply-bundle-security-fixes.sh');
}

const SCRIPT_PATH = findScript();

// ============================================================================
// Read the script once for all tests
// ============================================================================

let scriptContent = '';
let scriptExists = false;

try {
  scriptContent = fs.readFileSync(SCRIPT_PATH, 'utf8');
  scriptExists = true;
} catch {
  // Script not found — tests will fail with descriptive messages
}

// ============================================================================
// Test Suite
// ============================================================================

describe('apply-bundle-security-fixes.sh', () => {

  // ==========================================================================
  // Script Existence and Structure
  // ==========================================================================

  describe('Script existence and structure', () => {
    it('should exist at scripts/apply-bundle-security-fixes.sh', () => {
      assert.ok(
        fs.existsSync(SCRIPT_PATH),
        `Expected script at: ${SCRIPT_PATH}`
      );
    });

    it('should start with a bash shebang', () => {
      assert.ok(scriptExists, 'Script must exist for this check');
      assert.ok(
        scriptContent.startsWith('#!/bin/bash'),
        'Script must begin with #!/bin/bash'
      );
    });

    it('should use set -euo pipefail for safety', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('set -euo pipefail'),
        'Script must use set -euo pipefail for safe error handling'
      );
    });

    it('should require root (EUID check)', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('EUID'),
        'Script must check EUID to enforce root execution'
      );
    });

    it('should restore root:wheel ownership after patching', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('chown root:wheel'),
        'Script must restore root:wheel ownership on patched files'
      );
    });

    it('should restore 644 permissions after patching', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('chmod 644'),
        'Script must restore 644 permissions on patched files'
      );
    });
  });

  // ==========================================================================
  // Idempotency Detection
  // ==========================================================================

  describe('Idempotency detection', () => {
    it('should detect when shell RC files already in credential-file-guard.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("grep -qF '.zshrc'"),
        'Script must detect .zshrc presence for idempotency check'
      );
    });

    it('should detect when G027 B2 already in credential-file-guard.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("grep -qF 'HTTP_CLIENT_COMMANDS'"),
        'Script must detect HTTP_CLIENT_COMMANDS for G027 B2 idempotency check'
      );
    });

    it('should detect when execFileSync already in block-no-verify.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("grep -qF 'execFileSync'"),
        'Script must detect execFileSync for block-no-verify idempotency check'
      );
    });

    it('should detect when logBlockedAction already in protected-action-gate.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("grep -qF 'logBlockedAction'"),
        'Script must detect logBlockedAction for protected-action-gate idempotency check'
      );
    });

    it('should exit 0 with "nothing to do" message when all patches already applied', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Nothing to do'),
        'Script must exit cleanly when all patches already applied'
      );
    });
  });

  // ==========================================================================
  // Anchor Verification (credential-file-guard.js)
  // ==========================================================================

  describe('Anchor verification: credential-file-guard.js', () => {
    it('should verify BLOCKED_BASENAMES anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('const BLOCKED_BASENAMES = new Set(['),
        'Script must verify BLOCKED_BASENAMES anchor in credential-file-guard.js'
      );
    });

    it('should verify ALWAYS_BLOCKED_BASENAMES anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('const ALWAYS_BLOCKED_BASENAMES = new Set(['),
        'Script must verify ALWAYS_BLOCKED_BASENAMES anchor in credential-file-guard.js'
      );
    });

    it('should verify scanRawCommandForProtectedPaths anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('function scanRawCommandForProtectedPaths(command)'),
        'Script must verify scanRawCommandForProtectedPaths anchor'
      );
    });

    it('should verify checkBashEnvAccess anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('function checkBashEnvAccess'),
        'Script must verify checkBashEnvAccess anchor'
      );
    });

    it('should verify ENV_DUMP_COMMANDS anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('ENV_DUMP_COMMANDS'),
        'Script must verify ENV_DUMP_COMMANDS anchor'
      );
    });
  });

  // ==========================================================================
  // Anchor Verification (block-no-verify.js)
  // ==========================================================================

  describe('Anchor verification: block-no-verify.js', () => {
    it('should verify credentialAccessPatterns anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('const credentialAccessPatterns = ['),
        'Script must verify credentialAccessPatterns anchor in block-no-verify.js'
      );
    });

    it('should verify 1Password CLI full-path variant anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('1Password CLI access blocked (full-path variant)'),
        'Script must verify the full-path variant anchor in block-no-verify.js'
      );
    });
  });

  // ==========================================================================
  // Anchor Verification (protected-action-gate.js)
  // ==========================================================================

  describe('Anchor verification: protected-action-gate.js', () => {
    it('should verify __filename/__dirname anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("const __filename = fileURLToPath(import.meta.url);"),
        'Script must verify __filename anchor in protected-action-gate.js'
      );
    });

    it('should verify G001 FAIL-CLOSED config error anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('G001 FAIL-CLOSED: Config error, blocking all MCP actions'),
        'Script must verify G001 FAIL-CLOSED config error anchor'
      );
    });

    it('should verify ALL MCP actions blocked anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('ALL MCP actions are blocked until config is restored'),
        'Script must verify ALL MCP actions blocked anchor'
      );
    });

    it('should verify Unrecognized MCP Server anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Unrecognized MCP Server'),
        'Script must verify Unrecognized MCP Server anchor in protected-action-gate.js'
      );
    });

    it('should verify Cannot verify approval signatures anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Cannot verify approval signatures without protection key'),
        'Script must verify the protection key missing anchor'
      );
    });

    it('should verify Exit with error anchor', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Exit with error to block the tool call'),
        'Script must verify the final block-path anchor in protected-action-gate.js'
      );
    });
  });

  // ==========================================================================
  // Patch 1: credential-file-guard.js Shell RC Files
  // ==========================================================================

  describe('Patch 1a/1b: Shell RC files', () => {
    it('should add .zshrc to BLOCKED_BASENAMES replacement', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.zshrc',"),
        'Patch must add .zshrc to BLOCKED_BASENAMES'
      );
    });

    it('should add .bashrc to BLOCKED_BASENAMES replacement', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.bashrc',"),
        'Patch must add .bashrc to BLOCKED_BASENAMES'
      );
    });

    it('should add .bash_profile to BLOCKED_BASENAMES replacement', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.bash_profile',"),
        'Patch must add .bash_profile to BLOCKED_BASENAMES'
      );
    });

    it('should add .profile to BLOCKED_BASENAMES replacement', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.profile',"),
        'Patch must add .profile to BLOCKED_BASENAMES'
      );
    });

    it('should add .zprofile to BLOCKED_BASENAMES replacement', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.zprofile',"),
        'Patch must add .zprofile to BLOCKED_BASENAMES'
      );
    });

    it('should add RC files to both BLOCKED_BASENAMES and ALWAYS_BLOCKED_BASENAMES', () => {
      assert.ok(scriptExists, 'Script must exist');
      // Count occurrences of .zshrc — should appear in both NEW_BLOCKED_BASENAMES and NEW_ALWAYS_BLOCKED_BASENAMES
      const zshrcCount = (scriptContent.match(/'.zshrc',/g) || []).length;
      assert.ok(
        zshrcCount >= 2,
        `'.zshrc' should appear in both BLOCKED_BASENAMES and ALWAYS_BLOCKED_BASENAMES replacements (found ${zshrcCount} times)`
      );
    });
  });

  // ==========================================================================
  // Patch 1c: Extended scanRawCommandForProtectedPaths
  // ==========================================================================

  describe('Patch 1c: Extended scanRawCommandForProtectedPaths', () => {
    it('should include matchedBasename in the new scan function return', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('matchedBasename'),
        'Patch 1c must include matchedBasename in the scan result for path-context detection'
      );
    });

    it('should include BLOCKED_BASENAMES iteration in the new scan function', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('for (const basename of BLOCKED_BASENAMES)'),
        'Patch 1c must iterate BLOCKED_BASENAMES in scanRawCommandForProtectedPaths'
      );
    });

    it('should use path-context pattern (leading / or ~)', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('[/~]'),
        'Patch 1c must use [/~] pattern to restrict to path-context matches'
      );
    });

    it('should document path-context to avoid false positives', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('false positives'),
        'Patch 1c must document the path-context restriction to prevent false positives'
      );
    });
  });

  // ==========================================================================
  // Patch 1d: G027 B2 — HTTP client blocking
  // ==========================================================================

  describe('Patch 1d: G027 B2 HTTP client blocking', () => {
    it('should add HTTP_CLIENT_COMMANDS constant', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("const HTTP_CLIENT_COMMANDS = new Set(["),
        'Patch 1d must add HTTP_CLIENT_COMMANDS constant'
      );
    });

    it('should add PROTECTED_API_DOMAINS constant', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("const PROTECTED_API_DOMAINS = ["),
        'Patch 1d must add PROTECTED_API_DOMAINS constant'
      );
    });

    it('should include api.vercel.com in PROTECTED_API_DOMAINS', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'api.vercel.com',"),
        'PROTECTED_API_DOMAINS must include api.vercel.com'
      );
    });

    it('should include api.render.com in PROTECTED_API_DOMAINS', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'api.render.com',"),
        'PROTECTED_API_DOMAINS must include api.render.com'
      );
    });

    it('should include api.github.com in PROTECTED_API_DOMAINS', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'api.github.com',"),
        'PROTECTED_API_DOMAINS must include api.github.com'
      );
    });

    it('should include api.cloudflare.com in PROTECTED_API_DOMAINS', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'api.cloudflare.com',"),
        'PROTECTED_API_DOMAINS must include api.cloudflare.com'
      );
    });

    it('should include supabase.co in PROTECTED_API_DOMAINS', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'supabase.co',"),
        'PROTECTED_API_DOMAINS must include supabase.co'
      );
    });

    it('should add checkBashDirectApiCalls function', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('function checkBashDirectApiCalls'),
        'Patch 1d must add checkBashDirectApiCalls function'
      );
    });

    it('should integrate Check 4 into Bash handler', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('apiCallCheck = checkBashDirectApiCalls'),
        'Patch 1d must wire apiCallCheck = checkBashDirectApiCalls into the Bash handler'
      );
    });

    it('should reference G027 B2 in block reason', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('G027 B2'),
        'Block reason must reference G027 B2'
      );
    });
  });

  // ==========================================================================
  // Patch 2: block-no-verify.js — execFileSync/spawn/exec op patterns
  // ==========================================================================

  describe('Patch 2: execFileSync/spawn/exec op patterns', () => {
    it('should add execFileSync pattern targeting op CLI', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("execFileSync\\\\s*\\\\(\\\\s*"),
        'Patch 2 must add execFileSync pattern to credentialAccessPatterns'
      );
    });

    it('should add spawn/spawnSync pattern targeting op CLI', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('spawn(?:Sync)?'),
        'Patch 2 must add spawn/spawnSync pattern to credentialAccessPatterns'
      );
    });

    it('should add exec/execSync pattern targeting op CLI', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('exec(?:Sync)?'),
        'Patch 2 must add exec/execSync pattern to credentialAccessPatterns'
      );
    });

    it('should have block reason for execFileSync mentioning 1Password CLI', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('1Password CLI access via execFileSync blocked'),
        'Patch 2 execFileSync block reason must mention 1Password CLI'
      );
    });

    it('should have block reason for spawn/spawnSync mentioning 1Password CLI', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('1Password CLI access via spawn/spawnSync blocked'),
        'Patch 2 spawn/spawnSync block reason must mention 1Password CLI'
      );
    });

    it('should have block reason for exec/execSync mentioning 1Password CLI', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('1Password CLI access via exec/execSync blocked'),
        'Patch 2 exec/execSync block reason must mention 1Password CLI'
      );
    });

    it('should target single/double/backtick-quoted "op" in patterns', () => {
      assert.ok(scriptExists, 'Script must exist');
      // The pattern [\\'"\`]op[\\'"\`] covers all quote types
      assert.ok(
        scriptContent.includes("['\"\\`]op['\"\\`]") || scriptContent.includes("['\""),
        'Patch 2 patterns must match op in single, double, and backtick quotes'
      );
    });
  });

  // ==========================================================================
  // Patch 3: protected-action-gate.js — G024 audit logging
  // ==========================================================================

  describe('Patch 3: G024 audit logging infrastructure', () => {
    it('should add logBlockedAction function', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('function logBlockedAction(server, tool, args, reason, category)'),
        'Patch 3 must add logBlockedAction function with correct signature'
      );
    });

    it('should add blockedActions array', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('const blockedActions = [];'),
        'Patch 3 must add blockedActions array for in-memory audit log'
      );
    });

    it('should add MAX_BLOCKED_ACTIONS constant (500)', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('const MAX_BLOCKED_ACTIONS = 500;'),
        'Patch 3 must set MAX_BLOCKED_ACTIONS = 500 (ring buffer cap)'
      );
    });

    it('should call logBlockedAction on config-error block path', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'config-error'"),
        "Patch 3 must call logBlockedAction with category 'config-error'"
      );
    });

    it('should call logBlockedAction on config-missing block path', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'config-missing'"),
        "Patch 3 must call logBlockedAction with category 'config-missing'"
      );
    });

    it('should call logBlockedAction on unknown-server block path', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'unknown-server'"),
        "Patch 3 must call logBlockedAction with category 'unknown-server'"
      );
    });

    it('should call logBlockedAction on key-missing block path', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'key-missing'"),
        "Patch 3 must call logBlockedAction with category 'key-missing'"
      );
    });

    it('should call logBlockedAction on requires-approval block path', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'requires-approval'"),
        "Patch 3 must call logBlockedAction with category 'requires-approval'"
      );
    });

    it('should wire logBlockedAction into all 5 block paths (5 categories)', () => {
      assert.ok(scriptExists, 'Script must exist');
      const categories = ['config-error', 'config-missing', 'unknown-server', 'key-missing', 'requires-approval'];
      for (const category of categories) {
        assert.ok(
          scriptContent.includes(`'${category}'`),
          `Missing block path category: '${category}'`
        );
      }
    });

    it('should include G024 comment in audit infrastructure', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('G024'),
        'Patch 3 must reference G024 in the audit logging code'
      );
    });

    it('should truncate args to 200 chars to prevent log flooding', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('substring(0, 200)'),
        'Patch 3 must truncate args to 200 chars in logBlockedAction'
      );
    });
  });

  // ==========================================================================
  // Smoke Test Coverage
  // ==========================================================================

  describe('Smoke test coverage', () => {
    it('should smoke-test .zshrc in BLOCKED_BASENAMES', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.zshrc' in BLOCKED_BASENAMES"),
        "Smoke test must check '.zshrc' in BLOCKED_BASENAMES"
      );
    });

    it('should smoke-test .bashrc in ALWAYS_BLOCKED_BASENAMES', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'.bashrc' in ALWAYS_BLOCKED_BASENAMES"),
        "Smoke test must check '.bashrc' in ALWAYS_BLOCKED_BASENAMES"
      );
    });

    it('should smoke-test matchedBasename in scanRawCommand return', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes("'matchedBasename' in scanRawCommand return"),
        'Smoke test must verify matchedBasename is present after patch 1c'
      );
    });

    it('should smoke-test HTTP_CLIENT_COMMANDS constant (G027 B2)', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('HTTP_CLIENT_COMMANDS (G027 B2)'),
        'Smoke test must verify HTTP_CLIENT_COMMANDS is present after patch 1d'
      );
    });

    it('should smoke-test PROTECTED_API_DOMAINS constant (G027 B2)', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('PROTECTED_API_DOMAINS (G027 B2)'),
        'Smoke test must verify PROTECTED_API_DOMAINS is present after patch 1d'
      );
    });

    it('should smoke-test checkBashDirectApiCalls function', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('checkBashDirectApiCalls function'),
        'Smoke test must verify checkBashDirectApiCalls function is present'
      );
    });

    it('should smoke-test Check 4 in Bash handler', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Check 4 in Bash handler'),
        'Smoke test must verify Check 4 (G027 B2) is wired into Bash handler'
      );
    });

    it('should smoke-test execFileSync pattern in block-no-verify.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('execFileSync pattern'),
        'Smoke test must verify execFileSync pattern is present in block-no-verify.js'
      );
    });

    it('should smoke-test spawnSync pattern in block-no-verify.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('spawnSync pattern'),
        'Smoke test must verify spawnSync pattern is present in block-no-verify.js'
      );
    });

    it('should smoke-test exec/execSync pattern in block-no-verify.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('exec/execSync pattern'),
        'Smoke test must verify exec/execSync pattern is present in block-no-verify.js'
      );
    });

    it('should smoke-test logBlockedAction function in protected-action-gate.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('logBlockedAction function'),
        'Smoke test must verify logBlockedAction function is present'
      );
    });

    it('should smoke-test MAX_BLOCKED_ACTIONS constant in protected-action-gate.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('MAX_BLOCKED_ACTIONS constant'),
        'Smoke test must verify MAX_BLOCKED_ACTIONS constant is present'
      );
    });

    it('should smoke-test blockedActions array in protected-action-gate.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('blockedActions array'),
        'Smoke test must verify blockedActions array is present'
      );
    });

    it('should smoke-test all 5 audit categories in protected-action-gate.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      const auditCategories = [
        "'config-error' category",
        "'config-missing' category",
        "'unknown-server' category",
        "'key-missing' category",
        "'requires-approval' category",
      ];
      for (const category of auditCategories) {
        assert.ok(
          scriptContent.includes(category),
          `Smoke test must check ${category}`
        );
      }
    });
  });

  // ==========================================================================
  // Backup and Restore Instructions
  // ==========================================================================

  describe('Backup and restore instructions', () => {
    it('should create timestamped backups before patching', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('.bundle-backup.'),
        'Script must create bundle-backup timestamped files'
      );
    });

    it('should include restore instructions in failure output', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('sudo cp'),
        'Script must include sudo cp restore instructions in failure output'
      );
    });

    it('should target credential-file-guard.js, block-no-verify.js, and protected-action-gate.js', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('credential-file-guard.js'),
        'Script must reference credential-file-guard.js'
      );
      assert.ok(
        scriptContent.includes('block-no-verify.js'),
        'Script must reference block-no-verify.js'
      );
      assert.ok(
        scriptContent.includes('protected-action-gate.js'),
        'Script must reference protected-action-gate.js'
      );
    });
  });

  // ==========================================================================
  // Python Patch Script Error Handling
  // ==========================================================================

  describe('Python patch error handling', () => {
    it('should fail with sys.exit(1) when patch 1a anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 1a anchor (BLOCKED_BASENAMES) not found'),
        'Python script must fail loudly when patch 1a anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 1b anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 1b anchor (ALWAYS_BLOCKED_BASENAMES) not found'),
        'Python script must fail loudly when patch 1b anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 1c anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 1c anchor (scanRawCommandForProtectedPaths) not found'),
        'Python script must fail loudly when patch 1c anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 1d-i anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 1d anchor (ENV_DUMP_COMMANDS) not found'),
        'Python script must fail loudly when patch 1d-i anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 1d-ii anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 1d-ii anchor (end of checkBashEnvAccess + File Approval Logic) not found'),
        'Python script must fail loudly when patch 1d-ii anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 1d-iii anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 1d-iii anchor (end of Check 3 + Bash command is allowed) not found'),
        'Python script must fail loudly when patch 1d-iii anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 2 anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 2 anchor (credentialAccessPatterns array) not found in block-no-verify.js'),
        'Python script must fail loudly when patch 2 anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 3a anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 3a anchor (__filename/__dirname) not found in protected-action-gate.js'),
        'Python script must fail loudly when patch 3a anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 3b-1 anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 3b-1 anchor (config error exit block) not found in protected-action-gate.js'),
        'Python script must fail loudly when patch 3b-1 anchor is missing'
      );
    });

    it('should fail with sys.exit(1) when patch 3b-5 anchor is missing', () => {
      assert.ok(scriptExists, 'Script must exist');
      assert.ok(
        scriptContent.includes('Patch 3b-5 anchor (no-approval exit block) not found in protected-action-gate.js'),
        'Python script must fail loudly when patch 3b-5 anchor is missing'
      );
    });
  });
});
