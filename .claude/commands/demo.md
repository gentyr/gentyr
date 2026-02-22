<!-- HOOK:GENTYR:demo -->

# /demo - Launch Product Demo with Preflight Validation

Launch Playwright in interactive UI mode with comprehensive pre-flight checks to prevent silent failures (empty GUI with zero tests).

## Instructions

Follow these steps exactly:

### Step 1: Display Readiness Summary

Show the prefetch data summary to the user. Highlight any critical issues immediately.

### Step 2: Gate on Critical Failures

If the prefetch data shows missing config, missing dependencies, or missing browsers, display the specific failures with recovery steps and **STOP** — do not proceed to project selection.

### Step 3: Ask User for Demo Project

Use `AskUserQuestion` to ask which demo to run:

| Option | Project | Description |
|--------|---------|-------------|
| Full product demo | `demo` | Dashboard + extension in single Chromium session |
| Dashboard only | `manual` | Vendor dashboard with `page.pause()` for inspection |
| Extension only | `extension-manual` | Browser extension scaffolds with `page.pause()` |
| Vendor Owner walkthrough | `vendor-owner` | Full dashboard access as Owner persona |

### Step 4: Run Full Preflight

Call `mcp__playwright__preflight_check` with the selected project:

```
mcp__playwright__preflight_check({ project: "<selected>" })
```

This runs the comprehensive check including compilation validation (which prefetch skipped).

### Step 5: Gate on Preflight Result

If the preflight result shows `ready: false`:
- Display all failures from the `failures` array
- Display all `recovery_steps`
- **STOP** — do not launch

### Step 6: Launch

Call `mcp__playwright__launch_ui_mode` with the selected project:

```
mcp__playwright__launch_ui_mode({ project: "<selected>" })
```

### Step 7: Report Result

Show the user:
- Which project was launched
- The PID of the Playwright process
- Tip: Tests appear in the left sidebar — click to run individual tests
- Tip: Use the filter bar to search for specific test names

## Recovery Guide

| Failure | Fix |
|---------|-----|
| Config missing | Create `playwright.config.ts` — see project E2E spec |
| Dependencies missing | `pnpm add -D @playwright/test` |
| Browsers missing | `npx playwright install chromium` |
| Test files missing | Create test files in the project's test directory |
| Credentials invalid | Check 1Password injection — MCP server needs `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Compilation failed | Fix TypeScript errors — run `npx playwright test --list` for details |
| Dev server unreachable | Start dev server (`pnpm dev`) or ensure `playwright.config.ts` has a `webServer` section |

## Important

- **Never skip preflight** — Playwright GUI can open but display zero tests (silent failure)
- **Never use CLI** — `npx playwright test` bypasses 1Password credential injection
- **Always use MCP tools** — `preflight_check`, `launch_ui_mode`, `run_tests`
