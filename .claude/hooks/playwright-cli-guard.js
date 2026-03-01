#!/usr/bin/env node
/**
 * PreToolUse Hook: Playwright CLI Guard
 *
 * Detects Bash commands that run Playwright E2E tests via CLI
 * (e.g., `npx playwright test`, `pnpm test:e2e`) and BLOCKS execution.
 * Agents must use MCP tools instead for proper credential injection.
 *
 * Why: The Playwright MCP server handles credential injection from
 * 1Password. Running tests via CLI bypasses credential resolution,
 * causing tests to fail or skip silently without error.
 *
 * Escape hatch: Prefix the specific sub-command with PLAYWRIGHT_CLI_BYPASS=1
 * to allow CLI execution for that single command. The bypass must be an
 * env var prefix on the same sub-command (not in a chained echo/grep/etc).
 *
 * Location: .claude/hooks/playwright-cli-guard.js
 * Auto-propagates to target projects via directory symlink (npm link model)
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with permissionDecision deny (hard block)
 *
 * SECURITY: This file should be root-owned via npx gentyr protect
 *
 * @version 2.1.0
 */

// Patterns that indicate Playwright CLI usage
const playwrightPatterns = [
  { pattern: /\bnpx\s+playwright\s+test\b/i, label: 'npx playwright test' },
  { pattern: /\bnpx\s+playwright\s+show-report\b/i, label: 'npx playwright show-report' },
  { pattern: /\bplaywright\s+test\b/i, label: 'playwright test' },
  { pattern: /\bpnpm\s+(run\s+)?test:e2e\b/i, label: 'pnpm test:e2e' },
  { pattern: /\bpnpm\s+(run\s+)?test:pw\b/i, label: 'pnpm test:pw' },
  { pattern: /\bnpm\s+run\s+test:e2e\b/i, label: 'npm run test:e2e' },
  { pattern: /\bnpm\s+run\s+test:pw\b/i, label: 'npm run test:pw' },
  { pattern: /\byarn\s+(run\s+)?test:e2e\b/i, label: 'yarn test:e2e' },
  { pattern: /\byarn\s+(run\s+)?test:pw\b/i, label: 'yarn test:pw' },
];

// ============================================================================
// Shell Parsing Utilities
// (Same pattern as branch-checkout-guard.js / main-tree-commit-guard.js)
// ============================================================================

/**
 * Split a command string on shell operators (|, ||, &&, ;) while respecting
 * single and double quotes.
 *
 * @param {string} command
 * @returns {string[]} Array of sub-command strings
 */
function splitOnShellOperators(command) {
  const parts = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Only split on operators when outside quotes
    if (!inSingle && !inDouble) {
      if ((ch === '&' || ch === '|') && i + 1 < command.length && command[i + 1] === ch) {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
      if (ch === ';') {
        if (current.trim()) parts.push(current.trim());
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Check if a sub-command has the bypass env var prefix.
 * The bypass must appear as a VAR=VALUE token at the start of the sub-command
 * (before the actual command), matching shell env-var-prefix semantics.
 *
 * @param {string} subCommand - A single sub-command string
 * @returns {boolean}
 */
function hasBypassPrefix(subCommand) {
  // Shell env var prefix pattern: VAR=VALUE must appear before the command.
  // We check if the sub-command starts with PLAYWRIGHT_CLI_BYPASS=1 as a
  // whitespace-separated token (not embedded in an argument or string).
  return /^(\s*)PLAYWRIGHT_CLI_BYPASS=1\b/.test(subCommand);
}

/**
 * Check if a sub-command matches any playwright CLI pattern.
 *
 * @param {string} subCommand
 * @returns {{ matched: boolean, label: string|null }}
 */
function matchesPlaywright(subCommand) {
  for (const { pattern, label } of playwrightPatterns) {
    if (pattern.test(subCommand)) {
      return { matched: true, label };
    }
  }
  return { matched: false, label: null };
}

// ============================================================================
// Main Hook Logic
// ============================================================================

/**
 * Emit a hard deny response.
 */
function blockCommand(matchedLabel) {
  const reason = [
    `BLOCKED: Playwright CLI detected (\`${matchedLabel}\`)`,
    '',
    'Running E2E tests via CLI bypasses 1Password credential injection.',
    'Tests will fail or skip silently without proper environment variables.',
    '',
    'Use the Playwright MCP tools instead:',
    '  - mcp__playwright__preflight_check -- Pre-flight validation (always run first)',
    '  - mcp__playwright__run_tests       -- Run E2E tests (headless)',
    '  - mcp__playwright__run_demo         -- Run a demo scenario (headed, slow)',
    '  - mcp__playwright__launch_ui_mode  -- Launch interactive UI mode',
    '  - mcp__playwright__seed_data       -- Seed test database',
    '  - mcp__playwright__get_report      -- View last test report',
    '',
    'The MCP server handles credential resolution automatically.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'BYPASS (if you genuinely need CLI access for this command):',
    '',
    '  Prefix your command with PLAYWRIGHT_CLI_BYPASS=1, e.g.:',
    '    PLAYWRIGHT_CLI_BYPASS=1 npx playwright test --project=seed',
    '',
    '  Valid reasons for CLI bypass:',
    '    - Running playwright codegen / trace viewer / other non-test CLI tools',
    '    - Debugging a specific test with custom Node flags',
    '    - Installing browsers (npx playwright install)',
    '',
    '  The bypass applies to a single command only.',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));

  console.error(`[playwright-cli-guard] BLOCKED: detected "${matchedLabel}" in Bash command`);
  process.exit(0);
}

// Read JSON input from stdin
let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk.toString();
});

process.stdin.on('end', () => {
  try {
    const hookInput = JSON.parse(input);

    const toolName = hookInput.tool_name;
    const toolInput = hookInput.tool_input || {};

    // Only intercept Bash tool calls
    if (toolName !== 'Bash') {
      process.exit(0);
    }

    const command = toolInput.command || '';
    if (!command) {
      process.exit(0);
    }

    // Split into sub-commands on shell operators (&&, ||, |, ;)
    const subCommands = splitOnShellOperators(command);

    // Check each sub-command independently.
    // A sub-command is only allowed if it has the bypass prefix on itself.
    for (const sub of subCommands) {
      const { matched, label } = matchesPlaywright(sub);
      if (!matched) continue;

      // Check if THIS sub-command has the bypass prefix
      if (hasBypassPrefix(sub)) {
        console.error(`[playwright-cli-guard] PLAYWRIGHT_CLI_BYPASS=1 detected on sub-command — allowing`);
        continue;
      }

      // Playwright sub-command without bypass — block the entire command
      blockCommand(label);
      return; // blockCommand calls process.exit, but just in case
    }

    // No unbypasssed playwright commands found — allow
    process.exit(0);
  } catch (err) {
    // G001: fail-closed on parse errors — output deny JSON so Claude Code blocks the action
    console.error(`[playwright-cli-guard] G001 FAIL-CLOSED: Error parsing input: ${err.message}`);
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `G001 FAIL-CLOSED: Hook error - ${err.message}`,
      },
    }));
    process.exit(0);
  }
});
