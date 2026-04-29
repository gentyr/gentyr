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
const IS_SPAWNED = process.env.CLAUDE_SPAWNED_SESSION === 'true';

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
    // NOTE: For spawned agents, demo-remote-enforcement.js handles the broader
    // local-run detection (all local runs, not just headless). This trigger
    // only adds the headless-specific hint for interactive (CTO) sessions.
    if (toolName === 'mcp__playwright__run_demo' && !IS_SPAWNED) {
      if (responseParsed) {
        const ranLocally = !responseParsed.remote &&
          (responseParsed.execution_target === 'local' || !responseParsed.fly_machine_id);
        const wasHeadless = responseText.includes('"headless":true') ||
          responseText.includes('"headless": true');

        if (ranLocally && wasHeadless) {
          additionalContext = [
            'Note: This headless demo ran locally. Fly.io is configured — pass `remote: true`',
            '(or omit it — auto-routing picks Fly.io for headless runs) for remote execution.',
            'For multiple scenarios, run_demo_batch runs them concurrently across Fly.io machines.',
          ].join(' ');
        }
      }
    }

    // Trigger 2: After check_demo_result — remote routing warning present (fallback to local)
    if (toolName === 'mcp__playwright__check_demo_result') {
      if (responseParsed && responseParsed.remote_routing_warning) {
        const warning = responseParsed.remote_routing_warning;
        const isImageError = /registry\.fly\.io|could not resolve image|docker image|manifest.*not found|image.*not found/i.test(warning);
        if (isImageError) {
          additionalContext = [
            `WARNING: ${warning}`,
            'To fix: call mcp__playwright__deploy_fly_image() to build and push the Docker image, then retry the demo.',
            'Without a deployed Docker image, all remote demo execution falls back to local.',
          ].join(' ');
        } else {
          additionalContext = `WARNING: ${warning} Check get_fly_status for details and re-run /setup-fly if the image is missing.`;
        }
      }
    }

    // Trigger 3: After get_fly_status — image not deployed
    if (toolName === 'mcp__playwright__get_fly_status') {
      if (responseParsed && responseParsed.imageDeployed === false) {
        additionalContext = [
          'CRITICAL: Fly.io is configured but no Docker image has been deployed.',
          'Remote demo execution will fail until the image is built and pushed.',
          'Fix: call mcp__playwright__deploy_fly_image() to build and push the Docker image.',
          'Poll mcp__playwright__get_fly_status() to check when imageDeployed becomes true.',
        ].join(' ');
      }
    }

    // Trigger 4: After acquire_shared_resource — display lock contention detected
    if (toolName === 'mcp__agent-tracker__acquire_shared_resource') {
      if (responseParsed &&
          responseParsed.acquired === false &&
          (responseParsed.resource_id === 'display' ||
           hookInput.tool_input?.resource_id === 'display')) {
        const position = responseParsed.position ?? '?';
        if (IS_SPAWNED) {
          additionalContext = [
            `WARNING — DISPLAY LOCK CONTENDED (position ${position}).`,
            'Spawned agents should NOT wait for the display lock for validation runs.',
            'Use remote execution instead: run_demo({ remote: true, recorded: true }) or',
            'run_demo_batch({ remote: true, recorded: true }) for concurrent Fly.io execution.',
            'Remote Fly.io demos produce identical video recordings via Xvfb+ffmpeg.',
            'Only acquire the display lock for chrome-bridge or CTO-requested headed demos.',
          ].join(' ');
        } else {
          additionalContext = [
            `Display lock contended (position ${position} in queue).`,
            'If your demo does not need ScreenCaptureKit, run it on Fly.io instead:',
            '  run_demo({ remote: true, recorded: true })',
            'Remote execution produces identical video recordings and bypasses the display queue.',
          ].join(' ');
        }
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
