import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './db';

/** What a verified backup holds: enough to see at a glance that it is the right database. */
export interface BackupSummary {
  schemaVersion: number;
  accounts: number;
}

/**
 * Reads a backup the way a restored server would, or throws: a damaged file, a file that is not a
 * database, or a database without the schema. The file itself is left as it is.
 */
export function verifyBackup(path: string): BackupSummary {
  const db = new Database(path, { fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity check failed: ${String(integrity)}`);
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    if (schemaVersion < 1) throw new Error('no schema in this database');
    // This server could not start on it: `openDb` refuses a schema it does not know.
    if (schemaVersion > MIGRATIONS.length) throw new Error('schema newer than this server');
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    return { schemaVersion, accounts: n };
  } finally {
    db.close();
  }
}

/**
 * Copies the live database to `to` through SQLite's backup API, consistent even while the server
 * writes (copying a database in WAL mode file by file would not be), and verifies the copy. A
 * leftover of an interrupted run is replaced, along with any -wal that would be replayed on the copy.
 */
export async function createBackup(from: string, to: string): Promise<BackupSummary> {
  if (resolve(to) === resolve(from)) throw new Error('a backup cannot replace its own database');
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${to}${suffix}`, { force: true });
  const db = new Database(from, { readonly: true, fileMustExist: true });
  try {
    await db.backup(to);
  } finally {
    db.close();
  }
  return verifyBackup(to);
}
