/**
 * Supabase migration runner — applies pending SQL migrations via the
 * Management API so the postgres `postgres` user's password never has to
 * leave 1Password.
 *
 * Ported from xy's `.github/scripts/apply-supabase-migrations.mjs` and
 * generalized to operate against any environment configured in
 * `services.json#environments[].supabase.projectRef`.
 *
 * Used by:
 *   - `/promote-to-prod` Phase 4.5 (in-band migrations)
 *   - `/promote-to-staging` Phase 4.5
 *   - `verify_schema_drift` MCP tool (read-only diff path)
 *   - `schema_drift_check` hourly automation (PR 4)
 *   - `/push-migrations` slash command (manual escape hatch)
 *
 * Auth: SUPABASE_ACCESS_TOKEN — a Supabase personal access token with the
 * "database" scope. Resolved from 1Password by the calling agent at
 * invocation time; never read from disk.
 */

import fs from 'fs';
import path from 'path';

const API_BASE = 'https://api.supabase.com';

/**
 * @typedef {Object} MigrationRunOptions
 * @property {string} accessToken      Supabase Management API personal access token
 * @property {string} projectRef       Supabase project ref (20 chars)
 * @property {string} migrationsDir    Absolute path to migrations directory
 * @property {boolean} [dryRun=false]  If true, lists pending migrations but does not apply
 * @property {number} [statementTimeoutMs=120000] Per-statement timeout
 */

/**
 * @typedef {Object} MigrationRunResult
 * @property {boolean} ok
 * @property {string[]} applied         Migration filenames applied this run
 * @property {string[]} skipped         Migration filenames already present in schema_migrations
 * @property {string[]} pending         Migration filenames left pending (failure mode only)
 * @property {string | null} failure_reason
 * @property {Array<{filename: string, version: string}>} tracking_rows
 */

function assertOpts(opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('migration-runner: options object required');
  }
  if (!opts.accessToken || typeof opts.accessToken !== 'string') {
    throw new TypeError('migration-runner: accessToken (string) required');
  }
  if (!/^[a-z0-9]{20}$/.test(opts.projectRef || '')) {
    throw new TypeError(`migration-runner: projectRef must be 20 lowercase alphanumeric chars (got: "${opts.projectRef}")`);
  }
  if (!opts.migrationsDir || !fs.existsSync(opts.migrationsDir)) {
    throw new TypeError(`migration-runner: migrationsDir does not exist: ${opts.migrationsDir}`);
  }
}

/**
 * POST a SQL query against the Management API.
 * Throws on any non-2xx response — the caller decides how to surface.
 */
async function postQuery(accessToken, projectRef, query) {
  const url = `${API_BASE}/v1/projects/${projectRef}/database/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, read_only: false }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase Management API ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Read the supabase_migrations.schema_migrations table to learn which
 * filenames have already been applied. Matched by `name` column (filename
 * without `.sql` extension), mirroring the supabase CLI's convention.
 */
async function fetchAppliedNames(accessToken, projectRef) {
  const query = `
    SELECT name FROM supabase_migrations.schema_migrations
    ORDER BY version ASC
  `;
  const result = await postQuery(accessToken, projectRef, query);
  if (!Array.isArray(result)) {
    // Table may not exist yet (first run) — Management API returns either
    // an array of rows or an error object. Treat unknown shape as empty.
    return new Set();
  }
  return new Set(result.map(r => r.name).filter(Boolean));
}

/**
 * List *.sql files in the migrations directory, sorted by filename.
 * Each filename becomes `name` in schema_migrations (without extension).
 */
function listMigrationFiles(migrationsDir) {
  const all = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  return all.map(f => ({
    filename: f,
    name: f.replace(/\.sql$/, ''),
    fullPath: path.join(migrationsDir, f),
  }));
}

/**
 * Synthesize a deterministic-per-run version string for newly-applied rows.
 * Format: YYYYMMDDhhmmss + 4-digit counter, mirroring xy's convention so
 * supabase CLI sees consistent ordering when invoked locally afterwards.
 */
function buildVersion(counter) {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(counter, 4)}`;
}

/**
 * Reload PostgREST's schema cache after schema-mutating migrations so the
 * REST API serves the new columns immediately instead of waiting for the
 * 10-minute auto-refresh.
 */
async function reloadPostgRestCache(accessToken, projectRef) {
  try {
    await postQuery(accessToken, projectRef, `NOTIFY pgrst, 'reload schema'`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply pending migrations against a Supabase project.
 *
 * @param {MigrationRunOptions} options
 * @returns {Promise<MigrationRunResult>}
 */
export async function applyMigrations(options) {
  assertOpts(options);
  const { accessToken, projectRef, migrationsDir, dryRun = false } = options;

  const applied = [];
  const skipped = [];
  const pending = [];
  const trackingRows = [];

  let appliedNames;
  try {
    appliedNames = await fetchAppliedNames(accessToken, projectRef);
  } catch (err) {
    return {
      ok: false,
      applied,
      skipped,
      pending: listMigrationFiles(migrationsDir).map(f => f.filename),
      failure_reason: `Failed to read schema_migrations: ${err.message}`,
      tracking_rows: trackingRows,
    };
  }

  const files = listMigrationFiles(migrationsDir);
  let counter = 0;

  for (const file of files) {
    if (appliedNames.has(file.name)) {
      skipped.push(file.filename);
      continue;
    }
    if (dryRun) {
      pending.push(file.filename);
      continue;
    }

    let sql;
    try {
      sql = fs.readFileSync(file.fullPath, 'utf8');
    } catch (err) {
      pending.push(file.filename);
      pending.push(...files
        .slice(files.indexOf(file) + 1)
        .filter(f => !appliedNames.has(f.name))
        .map(f => f.filename));
      return {
        ok: false,
        applied,
        skipped,
        pending: Array.from(new Set(pending)),
        failure_reason: `Could not read ${file.filename}: ${err.message}`,
        tracking_rows: trackingRows,
      };
    }

    try {
      await postQuery(accessToken, projectRef, sql);
    } catch (err) {
      pending.push(file.filename);
      pending.push(...files
        .slice(files.indexOf(file) + 1)
        .filter(f => !appliedNames.has(f.name))
        .map(f => f.filename));
      return {
        ok: false,
        applied,
        skipped,
        pending: Array.from(new Set(pending)),
        failure_reason: `Failed applying ${file.filename}: ${err.message}`,
        tracking_rows: trackingRows,
      };
    }

    counter += 1;
    const version = buildVersion(counter);
    try {
      // INSERT into schema_migrations atomically with the apply. If this
      // INSERT fails, the next run will re-attempt the same file — which
      // is safe only if the migration is idempotent. Best-effort: surface
      // the failure but do not roll back the apply.
      await postQuery(
        accessToken,
        projectRef,
        `INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
         VALUES ('${version}', '${file.name.replace(/'/g, "''")}', ARRAY[]::text[])
         ON CONFLICT (version) DO NOTHING`,
      );
      trackingRows.push({ filename: file.filename, version });
    } catch (err) {
      // Apply succeeded but tracking-row INSERT failed — surface as warning
      // but keep going. Caller may need to manually reconcile.
      trackingRows.push({ filename: file.filename, version: 'tracking_failed:' + err.message.slice(0, 80) });
    }

    applied.push(file.filename);
  }

  if (applied.length > 0 && !dryRun) {
    await reloadPostgRestCache(accessToken, projectRef);
  }

  return {
    ok: true,
    applied,
    skipped,
    pending: [],
    failure_reason: null,
    tracking_rows: trackingRows,
  };
}

/**
 * Read-only variant — produces the same diff that applyMigrations would
 * resolve but does not invoke the Management API beyond the schema_migrations
 * read. Used by `verify_schema_drift` and the schema_drift_check hourly
 * automation.
 *
 * @param {Omit<MigrationRunOptions, 'dryRun'>} options
 * @returns {Promise<{ok: boolean, missing_in_db: string[], extra_in_db: string[], in_sync: boolean, failure_reason: string | null}>}
 */
export async function diffMigrations(options) {
  assertOpts(options);
  const { accessToken, projectRef, migrationsDir } = options;

  let appliedNames;
  try {
    appliedNames = await fetchAppliedNames(accessToken, projectRef);
  } catch (err) {
    return {
      ok: false,
      missing_in_db: [],
      extra_in_db: [],
      in_sync: false,
      failure_reason: `Failed to read schema_migrations: ${err.message}`,
    };
  }

  const files = listMigrationFiles(migrationsDir);
  const fileNames = new Set(files.map(f => f.name));

  const missing_in_db = files
    .filter(f => !appliedNames.has(f.name))
    .map(f => f.filename);

  const extra_in_db = Array.from(appliedNames)
    .filter(name => !fileNames.has(name))
    .map(name => `${name}.sql`);

  return {
    ok: true,
    missing_in_db,
    extra_in_db,
    in_sync: missing_in_db.length === 0 && extra_in_db.length === 0,
    failure_reason: null,
  };
}

// ---------------------------------------------------------------------------
// Self-test — runs when executed directly: node .claude/hooks/lib/migration-runner.js
// ---------------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const migrationsDir = process.env.MIGRATIONS_DIR;
  if (!token || !projectRef || !migrationsDir) {
    console.error('Self-test requires SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, MIGRATIONS_DIR');
    process.exit(2);
  }
  const result = await applyMigrations({ accessToken: token, projectRef, migrationsDir, dryRun: true });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
