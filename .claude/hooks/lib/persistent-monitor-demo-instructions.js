/**
 * Demo validation instructions injected into persistent monitor prompts
 * when the persistent task has demo_involved: true in its metadata.
 *
 * Shared between persistent-task-spawner.js, hourly-automation.js,
 * and session-queue.js (requeueDeadPersistentMonitor).
 *
 * @module lib/persistent-monitor-demo-instructions
 */

/**
 * Build demo-specific instructions for the persistent monitor prompt.
 * @returns {string} Markdown instruction block
 */
export function buildPersistentMonitorDemoInstructions() {
  return `

## Demo Validation Protocol

This persistent task involves demo scenarios. You MUST follow these rules:

### 1. Run Demos Headed with Video Recording
Always instruct child sessions to run demos **headed** (not headless) so video recording captures the full UI flow. Use \`mcp__playwright__run_demo\` with \`headless: false\`.

### 2. Review Video Frames — Do NOT Trust Programmatic Pass/Fail Alone
After each demo run, you MUST visually verify success by reviewing video frames at key moments:

- **\`mcp__playwright__check_demo_result({ pid })\`** — Get demo result, screenshot hints, and recording path
- **\`mcp__playwright__get_demo_screenshot({ scenario_id, timestamp_seconds })\`** — Retrieve a screenshot at a specific timestamp
- **\`mcp__playwright__extract_video_frames({ scenario_id, timestamp_seconds })\`** — Extract high-res frames (13 frames at 0.5s intervals, 3s before/after the timestamp). Use the Read tool to view the extracted frame images.

Review frames at EVERY critical step that proves an outcome criterion is met. A demo that passes programmatically but shows the wrong UI state is a FAILURE.

### 3. Enhanced Frame Export at Critical Moments
When instructing child sessions to run demos, tell them to use \`extract_video_frames\` at the exact timestamps where success criteria are visually verifiable. Order them to extract frames at multiple key moments throughout the demo, not just at the end. The more visual evidence, the better.

### 4. Demo Success Criteria Must Be Robust
Before running demos, verify that the demo's \`.demo.ts\` success criteria (assertions, expected elements, timeouts) are robust enough to actually prove the persistent task's outcome criteria. If the demo would pass even when the feature is broken, the success criteria are inadequate — create a task to tighten them first.

### 5. Keep Timeouts Tight
Instruct child sessions to keep Playwright timeouts short (5-10 seconds for element waits, 30 seconds max for page loads). Demos should fail fast and early. A demo that hangs for minutes before timing out wastes iteration cycles. If a step needs more than 10 seconds, the implementation likely has a performance problem that should be fixed.

### 6. Rapid Iteration Flow
The demo development loop should be: run → fail fast → review frames → fix → re-run. Do not let child sessions spend time on elaborate workarounds for flaky demos. If a demo is flaky, fix the root cause (tighten selectors, add proper waits for specific conditions, fix race conditions).`;
}
