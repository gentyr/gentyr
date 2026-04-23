#!/usr/bin/env node
/**
 * PostToolUse Hook: Screenshot Reminder
 *
 * When a tool response contains a screenshot file path (PNG),
 * injects a context reminder for the agent to Read and analyze it.
 *
 * Fast path: <1ms when no screenshot is present (regex check only).
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', (l) => { data += l; });
rl.on('close', () => {
  try {
    const hookInput = JSON.parse(data);

    // Don't remind if the tool was Read — agent is already viewing a screenshot
    const toolName = hookInput.tool_name || '';
    if (toolName === 'Read') {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Extract the tool response text
    const toolResponse = hookInput.tool_response;
    const responseText = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse || '');

    // Fast path: check for screenshot path patterns
    // Matches:
    //   [Screenshot saved: /path/to/file.png]
    //   "file_path": "/path/to/file.png"
    //   "screenshot_paths": [...]
    //   "screenshot_hint": "/path/..."
    const screenshotPatterns = [
      /\[Screenshot saved:\s*([^\]]+\.png)\]/g,
      /"file_path"\s*:\s*"([^"]+\.png)"/g,
      /"path"\s*:\s*"([^"]+\.png)"/g,
      /"screenshot_hint"\s*:\s*"([^"]+)"/g,
      /"screenshot_paths"\s*:\s*\[\s*"([^"]+)"/g,
    ];

    const foundPaths = [];
    for (const pattern of screenshotPatterns) {
      let match;
      while ((match = pattern.exec(responseText)) !== null) {
        foundPaths.push(match[1]);
      }
    }

    if (foundPaths.length === 0) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    // Deduplicate and cap at 5
    const uniquePaths = [...new Set(foundPaths)].slice(0, 5);
    const pathList = uniquePaths.map((p) => `  - ${p}`).join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: [
          'SCREENSHOT(S) AVAILABLE — View them NOW before proceeding:',
          pathList,
          '',
          'Use the Read tool on each .png file path above to visually verify the UI state.',
          'Claude Code can see images directly — analyze the screenshot to confirm your action',
          'produced the expected result before moving to the next step.',
        ].join('\n'),
      },
    }));
    process.exit(0);
  } catch {
    // PostToolUse hooks must never block — non-fatal on any parse/runtime error
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }
});
