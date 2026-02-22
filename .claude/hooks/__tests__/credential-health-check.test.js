/**
 * Tests for credential-health-check.js
 *
 * These tests validate the credential health check system:
 * 1. Code structure validation
 * 2. Missing credential detection
 * 3. Alternative credential handling
 * 4. 1Password connectivity check
 * 5. Spawned session skip logic
 * 6. Error handling (fail loudly, not gracefully)
 *
 * Uses Node's built-in test runner (node:test)
 * Run with: node --test .claude/hooks/__tests__/credential-health-check.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

describe('credential-health-check.js - Unit Tests', () => {
  const PROJECT_DIR = process.cwd();
  const HOOK_PATH = path.join(PROJECT_DIR, '.claude/hooks/credential-health-check.js');

  describe('Code Structure Validation', () => {
    it('should be a valid ES module with proper shebang', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should have shebang
      assert.match(hookCode, /^#!\/usr\/bin\/env node/, 'Must have node shebang');

      // Should use ES module imports
      assert.match(hookCode, /import.*from ['"]child_process['"]/, 'Must import from child_process');
      assert.match(hookCode, /import.*from ['"]fs['"]/, 'Must import fs');
      assert.match(hookCode, /import.*from ['"]path['"]/, 'Must import path');
    });

    it('should define all required constants', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const requiredConstants = [
        'projectDir',
        'mappingsPath',
        'actionsPath',
      ];

      for (const constant of requiredConstants) {
        assert.match(
          hookCode,
          new RegExp(`const ${constant}`),
          `Must define ${constant} constant`
        );
      }
    });

    it('should define output function', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /function output\(message\)/,
        'Must define output function'
      );
    });

    it('should define ALTERNATIVES constant for credential pairs', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      assert.match(
        hookCode,
        /const ALTERNATIVES = \{/,
        'Must define ALTERNATIVES constant'
      );

      // Should map ELASTIC_CLOUD_ID <-> ELASTIC_ENDPOINT
      assert.match(
        hookCode,
        /['"]ELASTIC_CLOUD_ID['"]:\s*['"]ELASTIC_ENDPOINT['"]/,
        'Must map ELASTIC_CLOUD_ID to ELASTIC_ENDPOINT'
      );

      assert.match(
        hookCode,
        /['"]ELASTIC_ENDPOINT['"]:\s*['"]ELASTIC_CLOUD_ID['"]/,
        'Must map ELASTIC_ENDPOINT to ELASTIC_CLOUD_ID'
      );
    });
  });

  describe('output() Function', () => {
    it('should output valid hook response with systemMessage when message provided', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function output\(message\) \{[\s\S]*?\n\}/);
      assert.ok(functionMatch, 'output function must exist');

      const functionBody = functionMatch[0];

      // Should check if message exists
      assert.match(
        functionBody,
        /if \(message\)/,
        'Must check if message is provided'
      );

      // Should output JSON with systemMessage
      assert.match(
        functionBody,
        /systemMessage:\s*message/,
        'Must include systemMessage in output when message provided'
      );

      // Should set suppressOutput: false when message exists
      assert.match(
        functionBody,
        /suppressOutput:\s*false/,
        'Must not suppress output when message provided'
      );

      // Should always include continue: true
      assert.match(
        functionBody,
        /continue:\s*true/,
        'Must include continue: true'
      );
    });

    it('should suppress output when no message provided', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function output\(message\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should set suppressOutput: true when no message
      assert.match(
        functionBody,
        /suppressOutput:\s*true/,
        'Must suppress output when no message'
      );
    });

    it('should stringify JSON output', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      const functionMatch = hookCode.match(/function output\(message\) \{[\s\S]*?\n\}/);
      const functionBody = functionMatch[0];

      // Should use JSON.stringify
      assert.match(
        functionBody,
        /JSON\.stringify\(/,
        'Must stringify output'
      );

      // Should console.log the result
      assert.match(
        functionBody,
        /console\.log\(JSON\.stringify/,
        'Must console.log stringified output'
      );
    });
  });

  describe('Spawned Session Detection', () => {
    it('should skip for spawned sessions', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check CLAUDE_SPAWNED_SESSION env var
      assert.match(
        hookCode,
        /process\.env\.CLAUDE_SPAWNED_SESSION === ['"]true['"]/,
        'Must check for spawned session environment variable'
      );

      // Should call output(null) for spawned sessions
      assert.match(
        hookCode,
        /CLAUDE_SPAWNED_SESSION === ['"]true['"][\s\S]*?output\(null\)/,
        'Must call output(null) for spawned sessions'
      );

      // Should exit early
      assert.match(
        hookCode,
        /CLAUDE_SPAWNED_SESSION === ['"]true['"][\s\S]*?process\.exit\(0\)/,
        'Must exit early for spawned sessions'
      );
    });
  });

  describe('Required Credential Detection', () => {
    it('should read required keys from protected-actions.json', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should read actionsPath
      assert.match(
        hookCode,
        /fs\.readFileSync\(actionsPath/,
        'Must read protected-actions.json'
      );

      // Should parse JSON
      assert.match(
        hookCode,
        /JSON\.parse\(fs\.readFileSync\(actionsPath/,
        'Must parse protected-actions.json'
      );

      // Should iterate over servers
      assert.match(
        hookCode,
        /Object\.values\(actions\.servers/,
        'Must iterate over servers in protected-actions.json'
      );

      // Should collect credentialKeys
      assert.match(
        hookCode,
        /server\.credentialKeys/,
        'Must collect credentialKeys from each server'
      );

      // Should add to requiredKeys Set
      assert.match(
        hookCode,
        /requiredKeys\.add/,
        'Must add credential keys to requiredKeys Set'
      );
    });

    it('should handle missing protected-actions.json gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should wrap in try-catch
      const actionsBlock = hookCode.match(/try \{[\s\S]*?const actions = JSON\.parse[\s\S]*?\} catch \{/);
      assert.ok(actionsBlock, 'Must wrap protected-actions.json reading in try-catch');

      // Should output(null) if file doesn't exist
      assert.match(
        hookCode,
        /\} catch \{[\s\S]*?output\(null\)/,
        'Must call output(null) when protected-actions.json is missing'
      );
    });

    it('should skip if no required keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check if requiredKeys.size === 0
      assert.match(
        hookCode,
        /requiredKeys\.size === 0/,
        'Must check if requiredKeys is empty'
      );

      // Should output(null) and exit
      assert.match(
        hookCode,
        /requiredKeys\.size === 0[\s\S]*?output\(null\)/,
        'Must call output(null) when no required keys'
      );
    });
  });

  describe('Vault Mappings Validation', () => {
    it('should read vault-mappings.json', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should read mappingsPath
      assert.match(
        hookCode,
        /fs\.readFileSync\(mappingsPath/,
        'Must read vault-mappings.json'
      );

      // Should parse JSON
      assert.match(
        hookCode,
        /JSON\.parse\(fs\.readFileSync\(mappingsPath/,
        'Must parse vault-mappings.json'
      );
    });

    it('should count both op:// references and direct values as configured', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check if mapping exists
      assert.match(
        hookCode,
        /if \(mappings\[key\]\)/,
        'Must check if mapping exists for required key'
      );

      // Should increment configuredCount when mapping exists
      assert.match(
        hookCode,
        /configuredCount\+\+/,
        'Must increment configuredCount for configured keys'
      );

      // Should add to configuredKeys Set
      assert.match(
        hookCode,
        /configuredKeys\.add\(key\)/,
        'Must track which keys are configured'
      );

      // Should track if any op:// references exist
      assert.match(
        hookCode,
        /mappings\[key\]\.startsWith\(['"]op:\/\/['"]\)/,
        'Must detect op:// references'
      );

      // Should set hasOpRefs flag
      assert.match(
        hookCode,
        /hasOpRefs = true/,
        'Must set hasOpRefs flag when op:// reference found'
      );
    });

    it('should collect missing keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should have missingKeys array
      assert.match(
        hookCode,
        /missingKeys/,
        'Must define missingKeys array'
      );

      // Should add to missingKeys when mapping not found
      assert.match(
        hookCode,
        /missingKeys\.push\(key\)/,
        'Must push missing keys to array'
      );
    });

    it('should handle missing vault-mappings.json', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should wrap in try-catch
      const vaultBlock = hookCode.match(/try \{[\s\S]*?const data = JSON\.parse\(fs\.readFileSync\(mappingsPath[\s\S]*?\} catch \{/);
      assert.ok(vaultBlock, 'Must wrap vault-mappings.json reading in try-catch');

      // Should add all required keys to missingKeys if file doesn't exist
      assert.match(
        hookCode,
        /missingKeys\.push\(\.\.\.requiredKeys\)/,
        'Must add all required keys to missingKeys when vault-mappings.json is missing'
      );
    });
  });

  describe('MCP Config Environment Variables', () => {
    it('should check .mcp.json for additional configured keys', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should read .mcp.json
      assert.match(
        hookCode,
        /const mcpPath = path\.join\(projectDir,\s*['"]\.mcp\.json['"]\)/,
        'Must define mcpPath'
      );

      // Should parse .mcp.json
      assert.match(
        hookCode,
        /const mcpConfig = JSON\.parse\(fs\.readFileSync\(mcpPath/,
        'Must parse .mcp.json'
      );

      // Should iterate over mcpServers
      assert.match(
        hookCode,
        /Object\.values\(mcpConfig\.mcpServers/,
        'Must iterate over mcpServers in .mcp.json'
      );

      // Should check server.env
      assert.match(
        hookCode,
        /server\.env/,
        'Must check server.env'
      );

      // Should filter missingKeys based on mcpEnvKeys
      assert.match(
        hookCode,
        /missingKeys = missingKeys\.filter\(/,
        'Must filter missingKeys based on .mcp.json env vars'
      );
    });

    it('should load OP_SERVICE_ACCOUNT_TOKEN from .mcp.json as source of truth', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check for OP_SERVICE_ACCOUNT_TOKEN in server.env
      assert.match(
        hookCode,
        /server\.env\.OP_SERVICE_ACCOUNT_TOKEN/,
        'Must check for OP_SERVICE_ACCOUNT_TOKEN in server.env'
      );

      // Should set process.env.OP_SERVICE_ACCOUNT_TOKEN from .mcp.json
      assert.match(
        hookCode,
        /process\.env\.OP_SERVICE_ACCOUNT_TOKEN = server\.env\.OP_SERVICE_ACCOUNT_TOKEN/,
        'Must load OP_SERVICE_ACCOUNT_TOKEN from .mcp.json'
      );

      // Comment should explain why this is source of truth
      const mcpBlock = hookCode.match(/\{[\s\S]*?const mcpPath[\s\S]*?\}/);
      assert.ok(mcpBlock, 'Must have MCP config block');
      assert.match(
        mcpBlock[0],
        /source of truth|prefer \.mcp\.json/i,
        'Must document why .mcp.json is source of truth for OP_SERVICE_ACCOUNT_TOKEN'
      );
    });

    it('should handle missing .mcp.json gracefully', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should wrap .mcp.json reading in try-catch
      const mcpBlock = hookCode.match(/\{[\s\S]*?const mcpPath[\s\S]*?\} catch \{[\s\S]*?\}/);
      assert.ok(mcpBlock, 'Must wrap .mcp.json reading in try-catch');

      // Should have comment about skipping if not readable
      assert.match(
        mcpBlock[0],
        /skip|not readable/i,
        'Must document that .mcp.json errors are non-fatal'
      );
    });
  });

  describe('Alternative Credentials Handling', () => {
    it('should filter out missing keys if alternative is configured', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check if missingKeys.length > 0
      assert.match(
        hookCode,
        /missingKeys\.length > 0/,
        'Must check if there are missing keys before filtering'
      );

      // Should filter missingKeys
      assert.match(
        hookCode,
        /missingKeys = missingKeys\.filter\(key => \{/,
        'Must filter missingKeys based on alternatives'
      );

      // Should look up alternative key
      assert.match(
        hookCode,
        /const alt = ALTERNATIVES\[key\]/,
        'Must look up alternative key from ALTERNATIVES'
      );

      // Should check if alternative is configured
      assert.match(
        hookCode,
        /configuredKeys\.has\(alt\)/,
        'Must check if alternative key is configured'
      );

      // Should return false (keep in missing) if alternative is not configured
      assert.match(
        hookCode,
        /return !alt \|\| !configuredKeys\.has\(alt\)/,
        'Must keep key in missing if no alternative or alternative not configured'
      );
    });
  });

  describe('Missing Credentials Message', () => {
    it('should output message when credentials are missing', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check if missingKeys.length > 0
      assert.match(
        hookCode,
        /if \(missingKeys\.length > 0\)/,
        'Must check if there are missing keys'
      );

      // Should output message with count (may be prefixed with desyncPrefix)
      assert.match(
        hookCode,
        /output\(`\$\{desyncPrefix\}GENTYR: \$\{missingKeys\.length\}/,
        'Must include missing key count in message'
      );

      // Should instruct user to run /setup-gentyr
      assert.match(
        hookCode,
        /Run \/setup-gentyr/,
        'Must instruct user to run /setup-gentyr'
      );
    });
  });

  describe('1Password Connectivity Check', () => {
    it('should only test 1Password connectivity if op:// references exist', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should check hasOpRefs before testing connectivity
      assert.match(
        hookCode,
        /else if \(hasOpRefs\)/,
        'Must only test 1Password connectivity when op:// references exist'
      );
    });

    it('should use execFileSync to test op whoami', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should call execFileSync with 'op' command
      assert.match(
        hookCode,
        /execFileSync\(['"]op['"]/,
        'Must call execFileSync with op command'
      );

      // Should use 'whoami' subcommand
      assert.match(
        hookCode,
        /['"]whoami['"]/,
        'Must use whoami subcommand'
      );

      // Should use --format json flag
      assert.match(
        hookCode,
        /['"]--format['"],\s*['"]json['"]/,
        'Must use --format json flag'
      );

      // Should set timeout
      assert.match(
        hookCode,
        /timeout:\s*\d+/,
        'Must set timeout for op whoami command'
      );

      // Should pass process.env
      assert.match(
        hookCode,
        /env:\s*process\.env/,
        'Must pass process.env to execFileSync'
      );
    });

    it('should output message when 1Password is not authenticated', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should wrap op whoami in try-catch
      const opBlock = hookCode.match(/try \{[\s\S]*?execFileSync\(['"]op['"][\s\S]*?\} catch \{/);
      assert.ok(opBlock, 'Must wrap op whoami in try-catch');

      // Should output message on failure
      assert.match(
        hookCode,
        /\} catch \{[\s\S]*?output\([`'"].*1Password.*not authenticated/,
        'Must output message when 1Password is not authenticated'
      );

      // Should reference the correct setup command
      assert.match(
        hookCode,
        /sudo scripts\/setup\.sh --path <project> --op-token <TOKEN>/,
        'Must reference correct setup command in 1Password message'
      );

      // Should mention that MCP servers will start without credentials
      assert.match(
        hookCode,
        /MCP servers will start without credentials/,
        'Must mention that MCP servers will start without credentials'
      );
    });

    it('should output null (or desync warning) when 1Password is authenticated', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should call output(desyncPrefix || null) when op whoami succeeds
      const opBlock = hookCode.match(/try \{[\s\S]*?execFileSync\(['"]op['"][\s\S]*?output\(desyncPrefix \|\| null\)/);
      assert.ok(opBlock, 'Must call output(desyncPrefix || null) when 1Password is authenticated');
    });

    it('should output null (or desync warning) when no op:// references exist', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should have else branch for when !hasOpRefs
      assert.match(
        hookCode,
        /\} else \{[\s\S]*?output\(desyncPrefix \|\| null\)/,
        'Must call output(desyncPrefix || null) when no op:// references exist'
      );
    });
  });

  describe('Error Handling', () => {
    it('should fail loudly on unexpected errors', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should wrap main logic in try-catch
      const mainTryCatch = hookCode.match(/try \{[\s\S]*?Skip for spawned sessions[\s\S]*?\} catch \(err\)/);
      assert.ok(mainTryCatch, 'Must wrap main logic in try-catch');

      // Should log errors to console.error
      assert.match(
        hookCode,
        /console\.error\(/,
        'Must log errors to console.error'
      );

      // Should include error message in log
      assert.match(
        hookCode,
        /err\.message \|\| err/,
        'Must include error message in error log'
      );

      // Should call output(null) on error (fail-open for hook)
      assert.match(
        hookCode,
        /\} catch \(err\) \{[\s\S]*?output\(null\)/,
        'Must call output(null) on unexpected error (fail-open)'
      );

      // IMPORTANT: Comment should explain fail-open behavior
      const catchBlock = hookCode.match(/\} catch \(err\) \{[\s\S]*?\}/);
      assert.ok(catchBlock, 'Must have catch block for main try');

      // Check for comment about not blocking session
      const beforeCatch = hookCode.substring(0, hookCode.indexOf('} catch (err)'));
      const afterCatch = hookCode.substring(hookCode.indexOf('} catch (err)'));
      assert.match(
        afterCatch,
        /Don't block|fail-open|continue/i,
        'Must document why errors do not block session (fail-open)'
      );
    });
  });

  describe('Hook Response Format', () => {
    it('should always return continue: true', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should always include continue: true in output
      assert.match(
        hookCode,
        /continue:\s*true/,
        'Must always include continue: true'
      );
    });

    it('should stringify JSON response', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should use JSON.stringify
      assert.match(
        hookCode,
        /JSON\.stringify\(/,
        'Must stringify JSON response'
      );
    });

    it('should output to stdout via console.log', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should use console.log
      assert.match(
        hookCode,
        /console\.log\(/,
        'Must output to stdout via console.log'
      );
    });
  });

  describe('OP Token Desync Detection', () => {
    it('should capture shellOpToken before .mcp.json overwrites process.env', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // shellOpToken must be captured before the .mcp.json block sets process.env
      const shellCapture = hookCode.indexOf('const shellOpToken = process.env.OP_SERVICE_ACCOUNT_TOKEN');
      const mcpOverwrite = hookCode.indexOf('process.env.OP_SERVICE_ACCOUNT_TOKEN = server.env.OP_SERVICE_ACCOUNT_TOKEN');
      assert.ok(shellCapture > -1, 'Must capture shellOpToken');
      assert.ok(mcpOverwrite > -1, 'Must overwrite process.env from .mcp.json');
      assert.ok(
        shellCapture < mcpOverwrite,
        'shellOpToken must be captured BEFORE .mcp.json overwrites process.env'
      );
    });

    it('should compare shellOpToken with mcpOpToken', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Must compare shell token with server.env token
      assert.match(
        hookCode,
        /shellOpToken && shellOpToken !== server\.env\.OP_SERVICE_ACCOUNT_TOKEN/,
        'Must only flag desync when both tokens exist and differ'
      );
    });

    it('should not expose token values in desync warning', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The desync warning must never expose full tokens — uses a fixed message without token values
      assert.match(
        hookCode,
        /OP_SERVICE_ACCOUNT_TOKEN in shell differs from \.mcp\.json/,
        'Desync warning must describe the mismatch without exposing full tokens'
      );
    });

    it('should mention op run as affected pattern in desync context', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The desync warning should mention setup.sh as the fix
      assert.match(
        hookCode,
        /setup\.sh --path/,
        'Desync warning must mention setup.sh --path as the fix'
      );
    });

    it('should only warn when both tokens exist and differ', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Must check shellOpToken is truthy before comparing
      assert.match(
        hookCode,
        /if \(shellOpToken && shellOpToken !== /,
        'Must guard with shellOpToken truthiness check (no warn when shell token is empty)'
      );
    });

    it('should declare opTokenDesync flag and use it in final output', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Must declare opTokenDesync
      assert.match(
        hookCode,
        /let opTokenDesync = false/,
        'Must declare opTokenDesync flag initialized to false'
      );

      // Must build desyncPrefix from opTokenDesync
      assert.match(
        hookCode,
        /const desyncPrefix = opTokenDesync/,
        'Must build desyncPrefix from opTokenDesync flag'
      );

      // desyncPrefix must be used in output calls
      assert.match(
        hookCode,
        /output\(`\$\{desyncPrefix\}/,
        'Must use desyncPrefix in output messages'
      );

      assert.match(
        hookCode,
        /output\(desyncPrefix \|\| null\)/,
        'Must use desyncPrefix || null for silent-path outputs'
      );
    });

    it('should set opTokenDesync = true before overwriting process.env in the same if block', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Both assignments must be inside the same if (server.env.OP_SERVICE_ACCOUNT_TOKEN) block.
      // Verify ordering: opTokenDesync = true must appear before process.env overwrite.
      const desyncAssign = hookCode.indexOf('opTokenDesync = true');
      const envOverwrite = hookCode.indexOf('process.env.OP_SERVICE_ACCOUNT_TOKEN = server.env.OP_SERVICE_ACCOUNT_TOKEN');

      assert.ok(desyncAssign > -1, 'Must assign opTokenDesync = true');
      assert.ok(envOverwrite > -1, 'Must overwrite process.env.OP_SERVICE_ACCOUNT_TOKEN');
      assert.ok(
        desyncAssign < envOverwrite,
        'opTokenDesync = true must be set BEFORE process.env is overwritten so the comparison uses the original shell value'
      );
    });

    it('should produce empty string (not null) when opTokenDesync is false so || null fallback works', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The ternary must yield '' (falsy string) on the false branch so that
      // output(desyncPrefix || null) correctly passes null through to suppress output.
      // A null/undefined desyncPrefix would still satisfy || null, but template literal
      // interpolation would produce "null" or "undefined" in the missing-keys message.
      //
      // The ternary spans multiple lines:
      //   const desyncPrefix = opTokenDesync
      //     ? '...'
      //     : '';
      // We match across lines with a pattern that confirms the false branch is ''.
      assert.match(
        hookCode,
        /const desyncPrefix = opTokenDesync[\s\S]*?:\s*'';/,
        "desyncPrefix ternary false branch must be an empty string literal ('') not null or undefined"
      );
    });

    it('should prepend desyncPrefix in the 1Password-not-authenticated error message', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // When op whoami fails AND opTokenDesync is true, the user must see both
      // the desync warning and the 1Password error in one message.
      assert.match(
        hookCode,
        /output\(`\$\{desyncPrefix\}GENTYR: 1Password is not authenticated/,
        'Must prepend desyncPrefix to the 1Password-not-authenticated error message'
      );
    });

    it('should guard mcpEnvKeys population against empty-string env values', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Empty-string env values in .mcp.json must NOT satisfy missing-key resolution.
      // The guard `if (server.env[k])` (truthy check) prevents blank strings from
      // being added to mcpEnvKeys and incorrectly masking missing credentials.
      assert.match(
        hookCode,
        /if \(server\.env\[k\]\)\s*mcpEnvKeys\.add\(k\)/,
        'Must guard mcpEnvKeys.add with a truthy check to exclude empty-string env values'
      );
    });

    it('should apply desyncPrefix to missing-credentials message even when keys are absent', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // The missing-keys branch uses template literal with desyncPrefix so the user
      // sees the desync warning alongside the missing-credentials notice.
      assert.match(
        hookCode,
        /output\(`\$\{desyncPrefix\}GENTYR: \$\{missingKeys\.length\} credential/,
        'Must include desyncPrefix in the missing-credentials output message'
      );
    });
  });

  describe('File Paths', () => {
    it('should use CLAUDE_PROJECT_DIR or cwd for projectDir', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // Should read CLAUDE_PROJECT_DIR env var
      assert.match(
        hookCode,
        /process\.env\.CLAUDE_PROJECT_DIR/,
        'Must read CLAUDE_PROJECT_DIR environment variable'
      );

      // Should fallback to process.cwd()
      assert.match(
        hookCode,
        /\|\| process\.cwd\(\)/,
        'Must fallback to process.cwd() when CLAUDE_PROJECT_DIR not set'
      );
    });

    it('should define correct file paths', () => {
      const hookCode = fs.readFileSync(HOOK_PATH, 'utf8');

      // mappingsPath should be .claude/vault-mappings.json
      assert.match(
        hookCode,
        /const mappingsPath = path\.join\(projectDir,\s*['"]\.claude['"]/,
        'mappingsPath must be in .claude directory'
      );
      assert.match(
        hookCode,
        /['"]vault-mappings\.json['"]\)/,
        'mappingsPath must point to vault-mappings.json'
      );

      // actionsPath should be .claude/hooks/protected-actions.json
      assert.match(
        hookCode,
        /const actionsPath = path\.join\(projectDir,\s*['"]\.claude['"],\s*['"]hooks['"]/,
        'actionsPath must be in .claude/hooks directory'
      );
      assert.match(
        hookCode,
        /['"]protected-actions\.json['"]\)/,
        'actionsPath must point to protected-actions.json'
      );
    });
  });
});
