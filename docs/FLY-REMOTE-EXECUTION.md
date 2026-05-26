# Remote Playwright Execution (Fly.io)

Full reference for GENTYR's Fly.io remote demo execution. See `CLAUDE.md` for the essential routing rules and agent decision trees agents need inline.

## Setup

Run `/setup-fly` — guides through Fly.io account creation, credential registration via 1Password, and app provisioning. After setup, run `deploy_fly_image()` to build and push the Docker image to `registry.fly.io/<appName>:latest`. Without this, `spawnRemoteMachine` fails and `run_demo` returns a fail-closed error.

## Image Management

**Image freshness**: The Fly.io Docker image contains `remote-runner.sh`, system dependencies, and Playwright. Target project code is cloned fresh from git on each run, but if GENTYR's `infra/fly-playwright/Dockerfile` or `remote-runner.sh` changes (e.g., after `npx gentyr sync` or framework updates), rebuild with `deploy_fly_image({ force: true })`.

`get_fly_status()` returns `imageStale: true` when the deployed image is outdated. Session briefing shows image age and staleness warnings. **Do NOT ignore `imageStale` warnings** — stale images cause systematic demo failures.

`get_fly_status` also returns `imageDeployed` — if `false`, no Docker image has been deployed yet. `run_demo` returns an error rather than silently falling back to local.

## Cost Control

Machines auto-stop on completion and have a 30-minute hard kill safety net. `maxConcurrentMachines` (default 10) caps concurrent usage. `get_fly_status` shows current machine count and health.

## Compute Sizes

Each scenario has a `compute_size` field:
- `"standard"` (4GB, default)
- `"large"` (8GB)

If a demo fails with OOM (exit code 137, `oom_detected: true` in `check_demo_result`), increase: `update_demo_scenario({ id: "...", compute_size: "large" })`. `check_demo_result` automatically detects OOM and includes a `compute_size_suggestion` field.

## Background Services on Remote Machines

Demos needing additional services (code-server, ttyd, LiveCodes, etc.) should register a background prerequisite:

```js
register_prerequisite({
  scope: 'scenario',
  scenario_id: "...",
  command: "npx code-server --port 7682 --auth none",
  health_check: "curl -sf http://localhost:7682",
  run_as_background: true,
})
```

Prerequisites with `run_as_background: true` are started before the test and health-checked. The remote execution environment supports any Node.js-based service.

## What Requires `remote_eligible: false` (Local-Only)

- Chrome-bridge scenarios (require Unix domain socket to local Chrome extension)
- Extension demos that load unpacked Chrome extensions
- Scenarios requiring macOS-specific system interactions (Finder, native dialogs)

Everything else — including headed demos, dev servers, code-server, and custom background services — runs on remote machines.

## Headed Demos

Fully supported on Fly.io via Xvfb + ffmpeg recording. `run_demo` with `headless: false` works identically on Fly.io as locally.

## Batch Parallelization

`run_demo_batch` runs multiple scenarios simultaneously across Fly.io machines (or Steel.dev sessions for stealth batches), limited by `fly.maxConcurrentMachines` (default 10) or `steel.maxConcurrentSessions`.

## Steel.dev (Stealth Demos)

For scenarios requiring anti-bot stealth: `run_demo({ stealth: true })` routes to Steel.dev. `run_demo_batch` with stealth scenarios uses Steel.dev sessions. Same interface as Fly.io.

## Credential Injection

Project code is cloned fresh on each Fly.io machine. `op://` secrets are NOT available on Fly.io (no op CLI). Set E2E credentials directly as Fly.io app secrets + `demoDevModeEnv` in `services.json`. See memory note: `project_fly_e2e_credential_injection.md`.
