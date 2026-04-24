#!/usr/bin/env node
/**
 * PostToolUse Hook: Remote Demo Hint
 *
 * Fires after run_demo and acquire_shared_resource tool calls.
 * Suggests remote Fly.io execution when:
 *   1. A headless demo ran locally but could have run remotely
 *   2. Display lock acquisition failed due to contention
 *
 * Fast path: exits in <1ms when Fly.io is not configured.
 * PostToolUse hooks MUST always exit 0 (the tool already ran).
 *
 * @version 1.0.0
 */

import { createInterface } from 'readline';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/**
 * Fast-path check: returns true only if Fly.io is configured in services.json.
 * Fail-closed: any read error returns false (do not hint if config is unreadable).
 */
function isFlyConfigured() {
  try {
    const servicesPath = path.join(PROJECT_DIR, '.claude', 'config', 'services.json');
    if (!fs.existsSync(servicesPath)) return false;
    const config = JSON.parse(fs.readFileSync(servicesPath, 'utf-8'));
    return !!(config.fly && config.fly.enabled !== false);
  } catch {
    return false;
  }
}

const rl = createInterface({ input: process.stdin });
let data = '';
rl.on('line', (l) => { data += l; });
rl.on('close', () => {
  try {
    const hookInput = JSON.parse(data);
    const toolName = hookInput.tool_name ?? '';

    // Fast exit if Fly.io not configured — avoid any further work
    if (!isFlyConfigured()) {
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    }

    const toolResponse = hookInput.tool_response;
    // Normalize to a parsed object for field access; keep raw string for text matching
    const responseText = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse || '');
    const responseParsed = (() => {
      if (!toolResponse) return null;
      if (typeof toolResponse === 'object') return toolResponse;
      try { return JSON.parse(toolResponse); } catch { return null; }
    })();

    let additionalContext = '';

    // Trigger 1: After run_demo — headless local run that could have used Fly.io
    if (toolName === 'mcp__playwright__run_demo') {
      if (responseParsed) {
        const ranLocally = !responseParsed.remote &&
          (responseParsed.execution_target === 'local' || !responseParsed.fly_machine_id);
        const wasHeadless = responseText.includes('"headless":true') ||
          responseText.includes('"headless": true');
        const succeeded = responseParsed.success === true ||
          responseParsed.status === 'passed' ||
          responseParsed.status === 'completed';

        if (ranLocally && wasHeadless && succeeded) {
          additionalContext = [
            'Tip: This headless demo ran locally. It could run on Fly.io instead to free local resources',
            'and bypass display lock contention entirely. Pass `remote: true` (or omit it — auto-routing',
            'picks Fly.io for headless runs when configured) to `run_demo` on the next execution.',
          ].join(' ');
        }
      }
    }

    // Trigger 2: After acquire_shared_resource — display lock contention detected
    if (toolName === 'mcp__agent-tracker__acquire_shared_resource') {
      if (responseParsed &&
          responseParsed.acquired === false &&
          (responseParsed.resource_id === 'display' ||
           hookInput.tool_input?.resource_id === 'display')) {
        const position = responseParsed.position ?? '?';
        additionalContext = [
          `Display lock contended (position ${position} in queue).`,
          'If your demo does not need video recording or ScreenCaptureKit, run it headless',
          'on Fly.io instead — it bypasses the display queue entirely:',
          '  run_demo({ headless: true })',
          'Fly.io is configured and routes headless demos to remote machines automatically,',
          'enabling parallel execution without any local display contention.',
        ].join(' ');
      }
    }

    if (additionalContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext,
        },
      }));
    } else {
      process.stdout.write(JSON.stringify({}));
    }
  } catch {
    // PostToolUse hooks must never block — non-fatal on any parse/runtime error
    process.stdout.write(JSON.stringify({}));
  }
  process.exit(0);
});

// Safety timeout in case stdin never closes
setTimeout(() => {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}, 4000);
