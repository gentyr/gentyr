<!-- HOOK:GENTYR:demo -->

# /demo - Launch Product Demo

Choose between interactive mode (UI test runner) or auto-play mode (headed browser, tests run automatically).

## Instructions

### Step 1: Display Readiness Summary

Show all prefetch data briefly. Highlight any `criticalIssues` prominently.

### Step 2: Ask User for Demo Mode

Use `AskUserQuestion`:

| Option | Description |
|--------|-------------|
| Auto-play (Recommended) | Tests run automatically in a visible browser at watchable speed. Best for presentations and demos. |
| Interactive | Opens Playwright UI mode — you click tests to run them. Best for debugging and step-through inspection. |

### Step 3: Delegate

Based on the user's choice:

- **Auto-play**: Follow the `/demo-auto` skill instructions (preflight, project selection, then `mcp__playwright__run_demo`)
- **Interactive**: Follow the `/demo-interactive` skill instructions (preflight, project selection, then `mcp__playwright__launch_ui_mode`)
