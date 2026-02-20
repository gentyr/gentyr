/**
 * Safe readonly SQLite opener for WAL-mode databases in root-owned directories.
 *
 * When setup.sh --protect makes .claude/ root-owned, SQLite can't create the
 * -shm/-wal files it needs for WAL mode even with { readonly: true }. This
 * helper detects that failure and falls back to a temp copy with DELETE journal
 * mode so the dashboard (and other readonly consumers) can still read the data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

export function openReadonlyDb(dbPath: string): InstanceType<typeof Database> {
  try {
    return new Database(dbPath, { readonly: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // SQLITE_READONLY_DIRECTORY or generic "attempt to write a readonly database"
    if (!msg.includes('readonly') && !msg.includes('READONLY')) {
      throw err;
    }

    // Fallback: copy to a temp file, convert from WAL to DELETE mode, reopen readonly
    const basename = path.basename(dbPath, '.db');
    const tmpPath = path.join(
      os.tmpdir(),
      `gentyr-ro-${basename}-${process.pid}-${Date.now()}.db`
    );

    fs.copyFileSync(dbPath, tmpPath);

    // Open read-write in temp dir to switch journal mode
    const tmpDb = new Database(tmpPath);
    tmpDb.pragma('journal_mode = DELETE');
    tmpDb.close();

    // Reopen as readonly
    const db = new Database(tmpPath, { readonly: true });

    // Patch close() to clean up temp file
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
