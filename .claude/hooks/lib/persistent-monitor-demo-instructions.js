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

### 1. Run Demos Remote + Recorded (Default)
Always instruct child sessions to use \`mcp__playwright__run_demo\` with the defaults (\`recorded: true, remote: true\`). Remote execution runs on Fly.io with Xvfb+ffmpeg video recording, avoids display lock contention, and produces identical recordings. Only use \`remote: false\` when the CTO explicitly requests to watch live, or when chrome-bridge/extension interaction is required. Never pass \`recorded: false\` unless the CTO specifically asks for headless-only validation.

### 2. Screenshot-First Diagnosis (MANDATORY -- Before ANY Code Investigation)

When a demo fails, you MUST visually diagnose BEFORE investigating code or spawning fix tasks:

**Step A**: Call \`mcp__playwright__check_demo_result({ pid })\` -- read the \`analysis_guidance\` field and FOLLOW IT.
**Step B**: If \`failure_frames\` are returned (auto-extracted from 3s before failure), use the Read tool to view EACH frame image. You are a multimodal model -- you can see images directly.
**Step C**: If no failure_frames, call \`mcp__playwright__get_demo_screenshot({ scenario_id, timestamp_seconds })\` at the failure timestamp and 2-3 timestamps before it (e.g., T-10s, T-5s, T-2s) to see the UI progression.
**Step D**: Call \`mcp__playwright__extract_video_frames({ scenario_id, timestamp_seconds })\` around the failure timestamp for high-res 13-frame analysis (0.5s intervals, 3s before/after). Use Read to view the extracted frames.

After visual analysis, you know:
- Was the browser showing the expected page? (e.g., AWS Console vs blank page vs error)
- Did the UI reach the expected state before timing out?
- Is this a navigation failure, element timeout, or app error?

Only AFTER visual diagnosis should you investigate code. A 5-second screenshot review prevents 30+ minutes of wrong-path code investigation.

**For child agents**: Include these exact screenshot analysis steps in every demo task prompt. Require children to report what they SAW in screenshots -- not just "the demo failed."

### 3. Visual Verification of Success (MANDATORY -- Before Claiming Pass)

A programmatic pass is NOT sufficient. After \`check_demo_result\` shows pass:

**Step A**: Use \`get_demo_screenshot\` at 3+ key moments (early, middle, end of the demo duration) to verify the UI matches the persistent task's outcome criteria.
**Step B**: If video recording exists, call \`extract_video_frames\` at the critical step where the outcome criterion should be visually provable.
**Step C**: Use the Read tool to view the frame images directly.

If the UI doesn't match expected state despite a programmatic pass, the demo is a FAILURE. Report this as a "false pass" and create a task to tighten the demo's success criteria.

### 4. Demo Success Criteria Must Be Robust
Before running demos, verify that the demo's \`.demo.ts\` success criteria (assertions, expected elements, timeouts) are robust enough to actually prove the persistent task's outcome criteria. If the demo would pass even when the feature is broken, the success criteria are inadequate -- create a task to tighten them first.

### 5. Keep Timeouts Tight
Instruct child sessions to keep Playwright timeouts short (5-10 seconds for element waits, 30 seconds max for page loads). Demos should fail fast and early. A demo that hangs for minutes before timing out wastes iteration cycles. If a step needs more than 10 seconds, the implementation likely has a performance problem that should be fixed. When a demo times out, the timeout duration itself is diagnostic: anything over 10s for a field wait means the page never reached the expected state.

### 6. Rapid Iteration Flow
The demo development loop should be: run -> fail fast -> **analyze screenshots** -> fix -> re-run. Do not let child sessions spend time on elaborate workarounds for flaky demos. If a demo is flaky, fix the root cause (tighten selectors, add proper waits for specific conditions, fix race conditions).

### 7. Prerequisites -- Never Manual Dev Server Management
Before spawning any child task that runs demos, do NOT include instructions to manually call \`secret_dev_server_start\`. The \`run_demo\` tool handles dev server startup automatically via registered prerequisites and auto-start from services.json. If demos fail with "dev server not ready", instruct the child to register a prerequisite (\`register_prerequisite\` with scope: "global", run_as_background: true) with a port-aware health check (\`curl -sf http://localhost:\${PORT:-3000}\`), NOT to manually start the server.

### 8. Child Agent Reporting Requirements

When spawning a child task that runs demos, ALWAYS include this instruction in the task prompt:

"After the demo completes (pass or fail), you MUST:
1. Call check_demo_result and read the analysis_guidance field
2. If failed: use the Read tool to view failure_frames images (or call get_demo_screenshot at the failure timestamp)
3. Report back WHAT YOU SAW: describe the browser state, what page was displayed, whether expected elements were visible or missing, any error messages visible on screen
4. Include screenshot file paths in your report so the monitor can verify independently
5. Do NOT just say 'the demo failed with timeout error' -- describe the visual state of the browser"

### 9. Use DEMO-MANAGER for All Demo Work

ALL demo-related sub-tasks MUST be created with \`category_id: 'demo-design'\`, NOT \`standard\` or other categories. The demo-manager agent has specialized knowledge of demo prerequisites, scenario lifecycle, repair protocols, and visual verification.

Use DEMO-MANAGER for:
- Running or re-running demo scenarios
- Creating or modifying \`.demo.ts\` files
- Registering or updating demo prerequisites
- Repairing failed demo scenarios
- Any demo-related investigation or diagnosis

Pipeline for code changes that affect demos: code-writer (implement) -> project-manager (merge) -> **demo-manager** (verify via demo). Do NOT skip the demo-manager step by having code-writers run demos directly.

### 10. Shared Resource Locks for Chrome and Display

When spawning child tasks that need the real Chrome window (chrome-bridge) or headed display access, include these instructions in the task prompt:

"Before using chrome-bridge tools, acquire the shared resource:
\`mcp__agent-tracker__acquire_shared_resource({ resource_id: 'chrome-bridge', title: '<what you need it for>' })\`
Release it when done: \`mcp__agent-tracker__release_shared_resource({ resource_id: 'chrome-bridge' })\`
If the resource is held, poll \`get_shared_resource_status\` every 30s until position=0."

For headed demos: the display lock is auto-acquired by \`run_demo\`, but chrome-bridge is NOT auto-acquired.
If both display and chrome-bridge are needed (e.g., headed demo that interacts with real Chrome), acquire both before starting.

When creating child tasks for demo work, ALWAYS set \`demo_involved: true\` in the \`create_task\` call.`;
}
