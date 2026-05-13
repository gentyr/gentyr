/**
 * Fly.io Machine Slot Pool
 *
 * SQLite-backed counted slot pool that coordinates Fly machine spawning
 * across concurrent MCP server instances. Each instance draws from a
 * shared pool of N machine slots to prevent exceeding the Fly.io org limit.
 *
 * @module machine-pool
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';

const PROJECT_DIR = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

/**
 * Resolve the DB path. The pool DB lives in the main tree's state directory,
 * even when running from a worktree (same pattern as user-feedback.db).
 */
function getPoolDbPath(): string {
  // If in a worktree, derive the main tree path
  const worktreeIdx = PROJECT_DIR.indexOf('/.claude/worktrees/');
  const mainTree = worktreeIdx !== -1 ? PROJECT_DIR.substring(0, worktreeIdx) : PROJECT_DIR;
  return path.join(mainTree, '.claude', 'state', 'fly-machine-pool.db');
}

let _db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (_db) return _db;

  const dbPath = getPoolDbPath();
  const stateDir = path.dirname(dbPath);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  // Create tables if they don't exist
  _db.exec(`
    CREATE TABLE IF NOT EXISTS machine_slots (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      machine_id TEXT,
      status TEXT DEFAULT 'acquired',
      acquired_at TEXT DEFAULT (datetime('now')),
      released_at TEXT,
      holder_pid INTEGER,
      ttl_minutes INTEGER DEFAULT 15
    );
    CREATE INDEX IF NOT EXISTS idx_slots_status ON machine_slots(status);
    CREATE INDEX IF NOT EXISTS idx_slots_batch ON machine_slots(batch_id);

    CREATE TABLE IF NOT EXISTS pool_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return _db;
}

/**
 * Read max_slots from services.json on every call, keeping the DB in sync.
 * Previously this only read services.json on first access (when no DB row existed),
 * which caused the DB to cache a stale value after config changes.
 */
export function getMaxSlots(): number {
  try {
    const db = getDb();

    // Always read the authoritative value from services.json
    let maxFromConfig = 10; // default
    try {
      const worktreeIdx = PROJECT_DIR.indexOf('/.claude/worktrees/');
      const mainTree = worktreeIdx !== -1 ? PROJECT_DIR.substring(0, worktreeIdx) : PROJECT_DIR;
      const servicesPath = path.join(mainTree, '.claude', 'config', 'services.json');
      if (fs.existsSync(servicesPath)) {
        const raw = fs.readFileSync(servicesPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.fly?.maxConcurrentMachines && typeof parsed.fly.maxConcurrentMachines === 'number') {
          maxFromConfig = parsed.fly.maxConcurrentMachines;
        }
      }
    } catch { /* non-fatal — use default */ }

    // Read current DB value
    const row = db.prepare('SELECT value FROM pool_config WHERE key = ?').get('max_slots') as { value: string } | undefined;
    const currentDbValue = row ? parseInt(row.value, 10) : null;

    // Update DB if services.json value differs (or no row exists)
    if (currentDbValue !== maxFromConfig) {
      db.prepare('INSERT OR REPLACE INTO pool_config (key, value) VALUES (?, ?)').run('max_slots', String(maxFromConfig));
    }

    return maxFromConfig;
  } catch (err) {
    process.stderr.write(`[fly-pool] getMaxSlots error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 10; // safe default
  }
}

/**
 * Update the max_slots value at runtime.
 */
export function setMaxSlots(n: number): void {
  if (!Number.isFinite(n) || n < 1 || n > 100) {
    throw new Error(`[fly-pool] setMaxSlots: invalid value ${n} (must be 1-100)`);
  }
  try {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO pool_config (key, value) VALUES (?, ?)').run('max_slots', String(n));
  } catch (err) {
    process.stderr.write(`[fly-pool] setMaxSlots error: ${err instanceof Error ? err.message : String(err)}\n`);
    throw err;
  }
}

/**
 * Clean expired and dead-PID slots. Called internally before every acquire,
 * and also exported for external use.
 */
export function cleanExpiredSlots(): { cleaned: number } {
  try {
    const db = getDb();
    let cleaned = 0;

    // 1. Expire slots past their TTL
    const ttlResult = db.prepare(`
      UPDATE machine_slots
      SET status = 'expired', released_at = datetime('now')
      WHERE status = 'acquired'
        AND datetime(acquired_at, '+' || ttl_minutes || ' minutes') < datetime('now')
    `).run();
    cleaned += ttlResult.changes;

    // 2. Expire slots with dead holder PIDs
    const acquiredSlots = db.prepare(
      "SELECT id, holder_pid FROM machine_slots WHERE status = 'acquired' AND holder_pid IS NOT NULL"
    ).all() as Array<{ id: string; holder_pid: number }>;

    for (const slot of acquiredSlots) {
      let alive = false;
      try {
        process.kill(slot.holder_pid, 0);
        alive = true;
      } catch {
        // PID is dead
      }
      if (!alive) {
        db.prepare(
          "UPDATE machine_slots SET status = 'expired', released_at = datetime('now') WHERE id = ?"
        ).run(slot.id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      process.stderr.write(`[fly-pool] Cleaned ${cleaned} expired/dead slot(s)\n`);
    }

    return { cleaned };
  } catch (err) {
    process.stderr.write(`[fly-pool] cleanExpiredSlots error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { cleaned: 0 };
  }
}

export interface AcquireSlotResult {
  acquired: boolean;
  slotId?: string;
  position?: number;
  activeSlots: number;
  maxSlots: number;
}

/**
 * Attempt to acquire a machine slot. Atomic: cleans expired/dead slots,
 * counts active, inserts if under max.
 *
 * Returns { acquired: true, slotId } on success, or { acquired: false, position }
 * when at capacity.
 */
export function acquireSlot(batchId: string, scenarioId: string, pid: number): AcquireSlotResult {
  try {
    const db = getDb();
    const maxSlots = getMaxSlots();

    // Clean expired/dead slots before counting
    cleanExpiredSlots();

    // Count active slots atomically
    const activeRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM machine_slots WHERE status = 'acquired'"
    ).get() as { cnt: number };
    const activeSlots = activeRow.cnt;

    if (activeSlots >= maxSlots) {
      return {
        acquired: false,
        position: activeSlots - maxSlots + 1,
        activeSlots,
        maxSlots,
      };
    }

    // Insert new slot
    const slotId = `slot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`
      INSERT INTO machine_slots (id, batch_id, scenario_id, holder_pid, status, acquired_at, ttl_minutes)
      VALUES (?, ?, ?, ?, 'acquired', datetime('now'), 15)
    `).run(slotId, batchId, scenarioId, pid);

    process.stderr.write(`[fly-pool] Acquired slot ${slotId} (${activeSlots + 1}/${maxSlots}) for batch=${batchId} scenario=${scenarioId}\n`);

    return {
      acquired: true,
      slotId,
      activeSlots: activeSlots + 1,
      maxSlots,
    };
  } catch (err) {
    process.stderr.write(`[fly-pool] acquireSlot error: ${err instanceof Error ? err.message : String(err)}\n`);
    // Fail-open: if the pool DB is broken, allow the spawn to proceed
    // (the Fly API will reject if truly over limit)
    return {
      acquired: true,
      slotId: `slot-fallback-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      activeSlots: 0,
      maxSlots: 10,
    };
  }
}

/**
 * Release a previously acquired slot.
 */
export function releaseSlot(slotId: string): { released: boolean } {
  try {
    const db = getDb();
    const result = db.prepare(
      "UPDATE machine_slots SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'acquired'"
    ).run(slotId);

    if (result.changes > 0) {
      process.stderr.write(`[fly-pool] Released slot ${slotId}\n`);
    }

    return { released: result.changes > 0 };
  } catch (err) {
    process.stderr.write(`[fly-pool] releaseSlot error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { released: false };
  }
}

/**
 * Update a slot with the actual Fly machine ID after spawn.
 */
export function updateSlotMachineId(slotId: string, machineId: string): void {
  try {
    const db = getDb();
    db.prepare(
      "UPDATE machine_slots SET machine_id = ? WHERE id = ?"
    ).run(machineId, slotId);
  } catch (err) {
    process.stderr.write(`[fly-pool] updateSlotMachineId error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export interface PoolStatus {
  activeSlots: number;
  maxSlots: number;
  byBatch: Record<string, number>;
}

/**
 * Get current pool utilization, broken down by batch.
 */
export function getPoolStatus(): PoolStatus {
  try {
    const db = getDb();
    const maxSlots = getMaxSlots();

    // Clean expired/dead slots first for accurate counts
    cleanExpiredSlots();

    const activeRow = db.prepare(
      "SELECT COUNT(*) as cnt FROM machine_slots WHERE status = 'acquired'"
    ).get() as { cnt: number };

    const batchRows = db.prepare(
      "SELECT batch_id, COUNT(*) as cnt FROM machine_slots WHERE status = 'acquired' GROUP BY batch_id"
    ).all() as Array<{ batch_id: string; cnt: number }>;

    const byBatch: Record<string, number> = {};
    for (const row of batchRows) {
      byBatch[row.batch_id] = row.cnt;
    }

    return {
      activeSlots: activeRow.cnt,
      maxSlots,
      byBatch,
    };
  } catch (err) {
    process.stderr.write(`[fly-pool] getPoolStatus error: ${err instanceof Error ? err.message : String(err)}\n`);
    return { activeSlots: 0, maxSlots: 10, byBatch: {} };
  }
}

/**
 * Close the database connection. Called during graceful shutdown.
 */
export function closePool(): void {
  if (_db) {
    try {
      _db.close();
    } catch { /* ignore close errors */ }
    _db = null;
  }
}
