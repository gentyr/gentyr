/**
 * Safe readonly SQLite opener for WAL-mode databases in root-owned directories.
 *
 * When setup.sh --protect makes .claude/ root-owned, SQLite can't create the
 * -shm/-wal files it needs for WAL mode even with { readonly: true }. This
 * helper detects that failure and falls back to a temp copy with DELETE journal
 * mode so readonly consumers can still read the data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

export function openReadonlyDb(dbPath: string): InstanceType<typeof Database> {
  try {
    const db = new Database(dbPath, { readonly: true });
    // Force WAL shared-memory initialization — SQLite defers -shm/-wal creation
    // until the first query, so new Database() alone won't surface the error.
    db.pragma('journal_mode');
    return db;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('readonly') && !msg.includes('READONLY')) {
      throw err;
    }

    const basename = path.basename(dbPath, '.db');
    const tmpPath = path.join(
      os.tmpdir(),
      `gentyr-ro-${basename}-${process.pid}-${Date.now()}.db`
    );

    fs.copyFileSync(dbPath, tmpPath);

    const tmpDb = new Database(tmpPath);
    tmpDb.pragma('journal_mode = DELETE');
    tmpDb.close();

    const db = new Database(tmpPath, { readonly: true });

    const originalClose = db.close.bind(db);
    db.close = (): InstanceType<typeof Database> => {
      const result = originalClose();
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best-effort cleanup
      }
      return result;
    };

    return db;
  }
}
