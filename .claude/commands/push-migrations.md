<!-- HOOK:GENTYR:push-migrations -->
# /push-migrations - Push Local Database Migrations to Remote Supabase

Apply pending local migration files to the remote Supabase database. This is the MCP-native equivalent of `supabase link && supabase db push`.

The prefetch hook has pre-gathered local migration files and injected them as a `[PREFETCH:push-migrations]` systemMessage above. Use that data for Step 0/Step 2 instead of reading the filesystem. If the prefetch data is missing, read the files directly.

## Security Notes

- Each migration is executed via `supabase_push_migration` which requires **APPROVE DATABASE** CTO approval
- Migrations are tracked in `supabase_migrations.schema_migrations` — already-applied migrations are skipped
- Failed migrations are automatically rolled back by the Supabase Management API
- Requires `SUPABASE_ACCESS_TOKEN` (management API token) to be set

## Push Flow

### Step 0: Load Configuration

Read `.claude/config/services.json` and use the `supabase.migrationsDir` field for the local migration file path.

If the file does not exist or `supabase.migrationsDir` is not set:
1. Use `AskUserQuestion` to ask: "Where are your Supabase migration files? (relative path from project root)"
2. Provide common options:
   - Option 1: "supabase/migrations/" — Standard Supabase CLI layout
   - Option 2: "database/migrations/" — Alternative layout
3. Save the path to `.claude/config/services.json` (create file if needed)

### Step 1: List Remote Migrations

Call `mcp__supabase__supabase_list_migrations` to get the list of already-applied migrations on the remote database.

Display the results to the user showing which migrations have been applied.

### Step 2: Read Local Migration Files

Read the local migration directory (from config) and list all `.sql` files, sorted by name (which sorts by number prefix).

Naming convention: `NNN_description.sql` (e.g., `001_initial_schema.sql`)

### Step 3: Identify Pending Migrations

Compare local files against remote migrations. A migration is pending if its name/version does not appear in the remote migration list.

Display to the user:
- Already applied: `001_initial_schema.sql`, etc.
- Pending: `004_new_feature.sql`, etc.

If no pending migrations, inform the user and stop.

### Step 4: Confirm with User

Use `AskUserQuestion` to confirm:

**Question:** "Push {N} pending migration(s) to remote Supabase? This will execute SQL against the production database."

**Header:** "Migrations"

**Options:**
- Option 1: "Push all pending" — apply all pending migrations in order
- Option 2: "Show SQL first" — display the SQL content of each pending migration before pushing
- Option 3: "Cancel" — abort without changes

### Step 5: Push Each Pending Migration

For each pending migration (in order):

1. Read the local `.sql` file content
2. Call `mcp__supabase__supabase_push_migration` with:
   - `name`: The migration filename without `.sql` extension (e.g., `004_new_feature`)
   - `sql`: The full SQL content of the file
3. Report success or failure for each migration
4. **STOP on first failure** — do not continue with subsequent migrations

### Step 6: Verify

Call `mcp__supabase__supabase_list_migrations` again to confirm all pending migrations now appear as applied.

Report final status to the user.

## Important

- NEVER modify migration files — they are immutable once created
- NEVER skip migrations — they must be applied in sequential order
- NEVER apply migrations without user confirmation
- If a migration fails, report the error and suggest the user check the SQL manually
- The `APPROVE DATABASE` CTO gate will trigger for each `supabase_push_migration` call
