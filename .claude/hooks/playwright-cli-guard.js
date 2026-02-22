#!/usr/bin/env node
/**
 * PreToolUse Hook: Playwright CLI Guard
 *
 * Detects Bash commands that run Playwright E2E tests via CLI
 * (e.g., `npx playwright test`, `pnpm test:e2e`) and warns the agent
 * to use MCP tools instead. Does NOT block execution -- the command
 * proceeds, but the agent receives a systemMessage advising MCP usage.
 *
 * Why: The Playwright MCP server handles credential injection from
 * 1Password. Running tests via CLI bypasses credential resolution,
 * causing tests to fail or skip silently without error.
 *
 * Location: .claude/hooks/playwright-cli-guard.js
 * Auto-propagates to target projects via directory symlink (npm link model)
 *
 * Input: JSON on stdin from Claude Code PreToolUse event
 * Output: JSON on stdout with systemMessage warning (non-blocking)
 *
 * @version 1.0.0
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

    // Check for playwright CLI patterns
    let matchedLabel = null;
    for (const { pattern, label } of playwrightPatterns) {
      if (pattern.test(command)) {
        matchedLabel = label;
        break;
      }
    }

    if (!matchedLabel) {
      // Not a playwright command -- allow silently
      process.exit(0);
    }

    // Emit warning via systemMessage (non-blocking)
    const warning = [
      `WARNING: Playwright CLI detected (\`${matchedLabel}\`)`,
      '',
      'Running E2E tests via CLI bypasses 1Password credential injection.',
      'Tests will fail or skip silently without proper environment variables.',
      '',
      'Use the Playwright MCP tools instead:',
      '  - mcp__playwright__preflight_check -- Pre-flight validation (always run first)',
      '  - mcp__playwright__run_tests       -- Run E2E tests (headless)',
      '  - mcp__playwright__launch_ui_mode  -- Launch interactive UI mode',
      '  - mcp__playwright__seed_data       -- Seed test database',
      '  - mcp__playwright__get_report      -- View last test report',
      '',
      'The MCP server handles credential resolution automatically.',
    ].join('\n');

    console.log(JSON.stringify({
      systemMessage: warning,
    }));

    // Log to stderr for visibility
    console.error(`[playwright-cli-guard] Warned agent: detected "${matchedLabel}" in Bash command`);

    process.exit(0);
  } catch (err) {
    // Fail open -- don't block on hook errors
    console.error(`[playwright-cli-guard] Error: ${err.message}`);
    process.exit(0);
  }
});
