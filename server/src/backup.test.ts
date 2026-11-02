import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, verifyBackup } from './backup';
import { MIGRATIONS, getAccount, openDb, type Db } from './db';
import { insertAccount } from './test-helpers';

describe('backups of the database, on real files', () => {
  let dir: string;
  let live: Db;
  let livePath: string;
  let backupPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fripon-backup-'));
    livePath = join(dir, 'fripon.db');
    backupPath = join(dir, 'backup.db');
    live = openDb(livePath);
  });

  afterEach(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores: a server opening the backup finds the accounts, even those still in the WAL', async () => {
    const account = insertAccount(live);
    expect(existsSync(`${livePath}-wal`)).toBe(true);

    const summary = await createBackup(livePath, backupPath);

    expect(summary.accounts).toBe(1);
    expect(summary.schemaVersion).toBeGreaterThan(0);

    // What `backup.sh --restore` does: the backup becomes the database of a server that starts.
    const restoredPath = join(dir, 'restored.db');
    copyFileSync(backupPath, restoredPath);
    const restored = openDb(restoredPath);
    expect(getAccount(restored, account.id)?.email).toBe(account.email);
    restored.close();
  });

  it('leaves one file behind, the backup, and the live database untouched', async () => {
    insertAccount(live);

    await createBackup(livePath, backupPath);

    expect(readdirSync(dir).filter((name) => name.startsWith('backup'))).toEqual(['backup.db']);
    expect(live.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 });
  });

  it('replaces the leftover of an interrupted run', async () => {
    writeFileSync(backupPath, 'half a file');

    await expect(createBackup(livePath, backupPath)).resolves.toMatchObject({ accounts: 0 });
  });

  it('refuses a file that is not a database', () => {
    writeFileSync(backupPath, 'this is not a database, not even close to one');

    expect(() => verifyBackup(backupPath)).toThrow();
  });

  it('refuses a truncated backup', async () => {
    for (let i = 0; i < 50; i++) insertAccount(live);
    await createBackup(livePath, backupPath);
    truncateSync(backupPath, Math.floor(statSync(backupPath).size / 2));

    expect(() => verifyBackup(backupPath)).toThrow();
  });

  it('refuses a database without the schema', () => {
    writeFileSync(backupPath, '');

    expect(() => verifyBackup(backupPath)).toThrow('no schema');
  });

  it('refuses a schema newer than this server', () => {
    const newer = openDb(backupPath);
    newer.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    newer.close();

    expect(() => verifyBackup(backupPath)).toThrow('newer');
  });

  it('never replaces the database it backs up', async () => {
    insertAccount(live);

    await expect(createBackup(livePath, join(dir, '.', 'fripon.db'))).rejects.toThrow(
      'own database',
    );

    expect(live.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toEqual({ n: 1 });
  });

  it('refuses a missing file', () => {
    expect(() => verifyBackup(join(dir, 'nothing.db'))).toThrow();
  });
});
