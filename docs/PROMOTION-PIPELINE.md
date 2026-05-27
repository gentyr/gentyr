# Promotion Pipeline

How `/promote-to-staging` and `/promote-to-prod` work end-to-end after the production-promotion overhaul (PRs #758 / #759 / #760 / and this PR).

> The CTO's only approval surface is the gentyr interactive session. No
> github.com Environment clicks. No Render dashboard. No Supabase Studio.
> Every external platform action is invoked by gentyr's plan-manager through
> the authorization-audit chain.

## High-level flow

```
/promote-to-staging
  preview-promoter (worktree, GENTYR_PROMOTION_PIPELINE=true)
    Step 1.5 — Migration safety analysis (static + LLM)
    Step 1.6 — Migration execution against staging Supabase (if configured)
    Step 2   — Quality review
    Step 3   — Tests + coverage
    Step 4   — Related demos
    Step 5   — Merge preview → staging
    Step 6   — Collect artifacts
  Phase 8.6 (if deployTargets set) — Deploy & verify staging targets (per-target deployment-verifier agents in parallel)

/promote-to-prod
  Phases 1-3   — Per-PR review, triage, meta-review
  Phase 4      — Test + demo execution on Fly.io
  Phase 4.5    — Migration pre-flight against production Supabase (if configured)
  Phase 4.6    — Canary rollout watch (if canary.enabled)
  Phase 5-6    — Demo coverage audit, final triage
  Phase 7      — CTO sign-off (record_cto_decision)
  Phase 8      — Merge staging → main, generate release report
  Phase 8.6    — Deploy & Verify (per target):
                 for each deployTargets[] entry, spawn a deployment-verifier agent that
                 triggers the platform deploy, polls until live, runs a 5-min health probe,
                 and either recordHealthy or triggers cascading rollback per rollbackGroup.
                 Phase completes when all verifiers succeed; ANY failure cancels the release.
```

Phases marked `(if X set)` are skipped entirely when the project hasn't configured the relevant `services.json` block — projects fall back to today's webhook-trusting behavior.

## Required `services.json` config

All sections are optional. Add only what you need.

```json
{
  "environments": {
    "production": {
      "baseUrl": "https://myapp.example.com",
      "branch": "main",
      "supabase": { "projectRef": "abcdefghijklmnopqrst" },
      "deployTargets": [
        {
          "platform": "render",
          "serviceId": "srv-...",
          "label": "backend",
          "baseUrlOverride": "https://api.myapp.example.com",
          "healthChecks": [{ "path": "/health", "expectStatus": 200 }],
          "rollbackGroup": "api-contract"
        },
        {
          "platform": "vercel",
          "serviceId": "prj_...",
          "label": "web",
          "baseUrlOverride": "https://myapp.example.com",
          "healthChecks": [{ "path": "/api/health", "expectStatus": 200 }],
          "rollbackGroup": "api-contract"
        },
        {
          "platform": "vercel",
          "serviceId": "prj_...",
          "label": "marketing",
          "baseUrlOverride": "https://www.myapp.example.com",
          "healthChecks": [{ "path": "/", "expectStatus": 200 }]
        }
      ],
      "healthChecks": [
        { "path": "/api/health", "expectStatus": 200 }
      ]
    },
    "staging": {
      "baseUrl": "https://staging.example.com",
      "branch": "staging",
      "supabase": { "projectRef": "stagingproject20chars" },
      "deployTarget": { "platform": "render", "serviceId": "srv-..." }
    }
  },
  "canary": {
    "enabled": false,
    "platform": "vercel",
    "trafficPercentage": 10,
    "monitoringWindowMinutes": 15,
    "errorRateThreshold": 5
  },
  "secrets": {
    "local": {
      "SUPABASE_ACCESS_TOKEN": "op://Production/Supabase/access-token",
      "VERCEL_TOKEN": "op://Production/Vercel/api-token",
      "RENDER_API_KEY": "op://Production/Render/api-key"
    }
  },
  "secretProfiles": {
    "supabase-prod": {
      "secretKeys": ["SUPABASE_ACCESS_TOKEN"],
      "description": "Production Supabase Management API access",
      "environmentScope": "production"
    },
    "supabase-staging": {
      "secretKeys": ["SUPABASE_ACCESS_TOKEN"],
      "description": "Staging Supabase Management API access",
      "environmentScope": "staging"
    }
  }
}
```

## Expand → migrate → contract

Destructive migrations (`DROP COLUMN`, `RENAME`, `ALTER TYPE`, `SET NOT NULL`, `DROP TABLE`) are **blocked** by default in both promotion paths. Override one of two ways:

1. **Preferred** — Add the annotation header to the migration file:
   ```sql
   -- @expand-contract-verified: column unused since release v2.3 (deployed 2026-04-15)
   ALTER TABLE users DROP COLUMN legacy_session_id;
   ```
   The annotation must include a reason. The reason is captured in the release report so post-mortems can audit acknowledged destructive ops.

2. **Emergency** — File a bypass request via `submit_bypass_request` and have the CTO approve via `record_cto_decision`. Used when the engineer cannot retrofit the annotation (e.g. external migration delivered through CI from a vendor).

Both routes are recorded on the release ledger.

## Rollback groups (cascading rollback)

By default, Phase 8.6 rolls back ONLY the target whose health probe failed. Other targets stay live, leaving production in a mixed-version state. This is fine for genuinely independent services (marketing site, mobile bundle, internal admin) but unsafe for tightly-coupled targets that share an API contract.

Declare a `rollbackGroup: string` on coupled targets and gentyr will revert the whole group together when any one member fails. In the example above, `backend` + `web` both tag `'api-contract'`: a backend probe failure reverts the web deploy too (so the web isn't talking to a rolled-back backend). `marketing` has no group, so backend/web failures leave it untouched.

Implementation: `resolveRollbackTargets(failingTarget, allTargets)` in `.claude/hooks/lib/auto-rollback.js` computes the rollback set at probe-failure time; Phase 8.6's task agent calls `triggerInBandRollback` for each member.

Membership is by exact string match. Empty or missing values never cascade. Targets in distinct groups (`'api-contract'` vs `'mobile-bundle'`) stay isolated from each other.

## Multi-target deploys

A single production release can deploy to multiple platforms in parallel:

- **`deployTarget`** (singular) — backward-compat shorthand for single-platform releases. Gentyr auto-wraps it into a one-element `deployTargets[]` at runtime.
- **`deployTargets[]`** (canonical) — explicit array. Each entry gets its own `label`, optional `baseUrlOverride` (when the target lives at a different origin than `env.baseUrl`), and optional `healthChecks[]` override.

The promotion plan fires platform deploys in parallel during Phase 8.6 (one `record_deploy_artifact` per target with the `target_label` set). Phase 8.6 probes every target's health endpoints and requires all to pass before clearing release sign-off. Rollback behavior depends on whether targets share a `rollbackGroup` (see above) — grouped targets cascade together, isolated targets stay live.

`deploy-tracking.json` keys both `lastKnownGood` and `recentDeploys` by `${environment}.${target_label}` so a release that updates one target does not clobber sibling targets' rollback pointers. Legacy single-target releases land in the `_default` slot. `executeRollback()` consumes `opts.target_label` + `opts.serviceId` so the platform API call (Vercel scope, Render serviceId) targets the right deploy.

## Auto-rollback model

`auto-rollback.js` runs in two modes:

| Trigger | Latency | What happens |
|---|---|---|
| Hourly synthetic-monitor `consecutive_failures` alert | 1-2 min from deploy | Existing `checkAndRollback()` path. Rolls back to `lastKnownGood` if deploy <5 min old, 3+ failures. |
| Phase 8.6 health probe never reaches `min_consecutive_passes` | 5 min from deploy trigger | New `triggerInBandRollback()` path. Rolls back immediately + cancels the release. |

The two paths use the same `executeRollback()` underneath. The in-band path is stricter: it cancels the release ledger on failure (the synthetic path just rolls back code; the release record stays signed-off).

## Schema drift detection

`hourly-automation.js#schema_drift_check` runs daily. For each environment with `supabase.projectRef` set:

1. Read remote `supabase_migrations.schema_migrations` via Management API.
2. List local `supabase/migrations/*.sql`.
3. If the sets diverge: write a deputy-CTO alert via `recordAlert`.

The drift check requires `secrets.local.SUPABASE_ACCESS_TOKEN` to be a literal token (not an `op://` reference). On first setup, run `mcp__secret-sync__populate_secrets_local` followed by `npx gentyr sync` to resolve the reference.

## Per-environment secret RBAC

`SecretProfile.environmentScope` gates credential resolution by release phase. A profile with `environmentScope: 'production'` is only resolvable when the calling session has `GENTYR_RELEASE_PHASE=prod` in its environment. `secret-env-scope-guard.js` is a PreToolUse hook that fires on every `secret_run_command` invocation.

Set `environmentScope: 'any'` (or omit entirely) for profiles that are scope-agnostic.

## What gentyr does NOT take from xy's pipeline

xy's `.github/workflows/migrate-production.yml`, `deploy-production.yml`, and `drift-check.yml` are NOT lifted into gentyr. Reasons:

- xy uses GitHub Environments as the CTO approval surface. Gentyr uses `record_cto_decision` + the authorization-audit chain. The point of this overhaul is "one approval surface, gentyr-native."
- xy's drift check needs the postgres DB password. Gentyr's drift check uses the Management API only.

Target projects (including xy itself) that already have these workflows can keep them as a redundant safety net for now. After a quarter of clean releases against gentyr's in-band gates, retire the GitHub Actions copies.

## Related docs

- [DEPLOYMENT-FLOW.md](specs/reference/DEPLOYMENT-FLOW.md) (when target projects install gentyr) — branch protection setup
- [`agents/preview-promoter.md`](../agents/preview-promoter.md) — staging promotion details
- [`agents/plan-manager.md`](../agents/plan-manager.md) — production plan phase guidance
- [`.claude/commands/promote-to-prod.md`](../.claude/commands/promote-to-prod.md) — `/promote-to-prod` orchestration
- [`.claude/commands/promote-to-staging.md`](../.claude/commands/promote-to-staging.md) — `/promote-to-staging` orchestration
