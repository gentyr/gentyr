# Demo Observability & Application Logging

Full reference for GENTYR's demo telemetry, Elastic logging setup, and dev server management. See `CLAUDE.md` for the quick-reference rules agents need inline.

## Demo Telemetry (Maximum Capture Mode)

Enable per-scenario (`update_demo_scenario({ id: "...", telemetry: true })`) or per-run (`run_demo({ ..., telemetry: true })`). When enabled, captures:
- Browser console logs from ALL open tabs (log/warn/error/info/debug)
- Network requests and responses (method, URL, status, timing, headers)
- JavaScript errors and unhandled exceptions with full stack traces
- Performance metrics (Web Vitals: LCP, FCP, CLS, TTFB, navigation timing)
- System metrics (CPU%, memory, load averages) sampled every 2 seconds
- Full stdout/stderr capture

Telemetry files: `.claude/recordings/demos/{scenarioId}/telemetry/*.jsonl`
`check_demo_result` returns `telemetry_summary` with counts of each telemetry type.

## Querying Demo Telemetry via Elastic

Use `mcp__elastic-logs__query_logs`:
- All telemetry for a run: `demo.run_id:"dr-xxx"`
- Console errors only: `demo.run_id:"dr-xxx" AND telemetry_type:console AND level:error`
- Network failures: `demo.run_id:"dr-xxx" AND telemetry_type:network_response AND status:>=400`
- JavaScript errors: `demo.run_id:"dr-xxx" AND telemetry_type:js_error`
- System metrics: `demo.run_id:"dr-xxx" AND telemetry_type:system_metrics`
- Performance: `demo.run_id:"dr-xxx" AND telemetry_type:performance`

## Demo Dev Server Management (AUTOMATED)

`run_demo`, `run_demo_batch`, and `preflight_check` automatically handle dev server lifecycle:
1. Execute registered prerequisites (starts dev server if registered as background prereq)
2. Verify dev server health on the correct port
3. Auto-start from `services.json` `devServices` config if no prerequisite started it
4. Auto-set `PLAYWRIGHT_BASE_URL` once healthy

**Do NOT manually start dev servers.** Do not call `secret_dev_server_start` before `run_demo` — it handles this automatically. If auto-start fails, register a prerequisite:

```js
register_prerequisite({
  command: "pnpm dev",
  scope: "global",
  run_as_background: true,
  health_check: "curl -sf http://localhost:${PORT:-3000}",
  description: "Start dev server"
})
```

Port-aware health checks (`${PORT:-3000}`) are mandatory — they resolve correctly in both main tree (port 3000) and worktree (port 3100+) contexts. Never hardcode port numbers.

Project-level env overrides (e.g., skip rebuilds) can be declared in `.claude/config/services.json` under `demoDevModeEnv`. Foreground prerequisites are killed if no output for 60s.

## Run ID Correlation

Every demo run generates a `DEMO_RUN_ID` (format: `dr-{scenarioId}-{ts}-{hex}`). When the dev server is started by `run_demo`, this ID is injected into the server environment. Application code can read `process.env.DEMO_RUN_ID` and include it in log context for end-to-end tracing across browser telemetry, API logs, and background jobs.

## Application Logging Setup

Use `createLogger({ service, module })` for stdout-only logging; `createElasticLogger({ service, module })` for dual stdout + Elastic Cloud shipping. Both produce ECS-compatible JSON. `createElasticLogger` silently no-ops when Elastic credentials are missing (graceful degradation). Index naming: `logs-{service}-{YYYY-MM-DD}`.

## Elastic Credentials Configuration

1. Configure the `elastic` section in services.json:
   `mcp__secret-sync__update_services_config({ updates: { elastic: { apiKey: "op://Production/Elastic/api-key", cloudId: "op://Production/Elastic/cloud-id", enabled: true } } })`
2. Add credentials to secrets.local for local dev and demo execution:
   `mcp__secret-sync__populate_secrets_local({ entries: { ELASTIC_API_KEY: "op://Production/Elastic/api-key", ELASTIC_CLOUD_ID: "op://Production/Elastic/cloud-id" } })`
3. Verify setup: `mcp__elastic-logs__verify_logging_config` returns a health report with credential status, cluster connectivity, and deployment environment coverage.

## Deployment Environment Credentials

Elastic credentials must be configured in ALL deployment environments. Add `ELASTIC_API_KEY` and `ELASTIC_CLOUD_ID` to:
- `secrets.renderProduction` and `secrets.renderStaging` (for backend API)
- `secrets.vercel` (for Next.js SSR)
- GitHub Actions secrets (for CI log shipping and Playwright reporter)

Then run `/push-secrets` to sync. Without this, production/staging apps log to stdout only.

## Application Log Queries

Use `mcp__elastic-logs__query_logs`:
- App runtime errors: `service:"my-api" AND level:error`
- Slow requests: `service:"my-api" AND duration:>1000`
- User-specific: `service:"my-api" AND userId:"usr_123"`
- CI failures: `event.module:"github-ci" AND event.outcome:failure`
- Deploy events: `event.module:"render" AND deploy.state:"live"`
- Log stats: `mcp__elastic-logs__get_log_stats({ groupBy: "service" })` for volume overview
