import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `server/scripts/backup.sh` run for real with a fake `docker` first on the PATH: it logs its
 * arguments, writes the file of a `cp`, keeps what a `sh -c` gets on stdin, and fails when its
 * arguments hold FAKE_FAIL. Nothing here touches Docker.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/backup.sh', import.meta.url));

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_LOG"
if [[ -n "\${FAKE_FAIL:-}" && "$*" == *"$FAKE_FAIL"* ]]; then exit 1; fi
case "$*" in
  *"sh -c"*) cat > "$FAKE_DOCKER_LOG.stdin" ;;
  *" cp "*) echo "today's backup" > "\${@: -1}" ;;
esac
`;

const DAY_S = 24 * 60 * 60;
const TODAY = /^fripon-\d{4}-\d{2}-\d{2}\.db$/;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function install() {
  const root = mkdtempSync(join(tmpdir(), 'fripon-backup-script-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
  const backups = join(root, 'backups');
  const log = join(root, 'docker.log');

  /** A file in the backups folder, `days` old. */
  const existing = (name: string, days = 0) => {
    mkdirSync(backups, { recursive: true });
    const path = join(backups, name);
    writeFileSync(path, 'an older backup');
    const at = Date.now() / 1000 - days * DAY_S;
    utimesSync(path, at, at);
    return path;
  };

  const run = (args: string[], options: { fail?: string; input?: string } = {}) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      input: options.input ?? '',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_DOCKER_LOG: log,
        FAKE_FAIL: options.fail ?? '',
        FRIPON_BACKUP_DIR: backups,
      },
    });

  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const inBackups = () => (existsSync(backups) ? readdirSync(backups).sort() : []);
  const stdin = () => readFileSync(`${log}.stdin`, 'utf8');

  return { run, existing, calls, inBackups, stdin, backups };
}

/** The position of the first call that holds `text`. */
const at = (calls: string[], text: string) => calls.findIndex((call) => call.includes(text));

describe('server/scripts/backup.sh', () => {
  it('is valid bash, and executable', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  describe('a backup', () => {
    it('creates, copies, proves the copy can be read, keeps it, and cleans the container', () => {
      const t = install();

      const result = t.run([]);

      expect(result.status).toBe(0);
      const [file, ...others] = t.inBackups();
      expect(others).toEqual([]);
      expect(file).toMatch(TODAY);
      expect(statSync(join(t.backups, file as string)).mode & 0o777).toBe(0o600);
      expect(statSync(t.backups).mode & 0o777).toBe(0o700);

      const calls = t.calls();
      const create = at(calls, 'backup.js create /data/backup.db');
      const copy = at(calls, 'cp fripon-cloud:/data/backup.db');
      const verify = at(calls, 'backup.js verify');
      const clean = at(calls, 'rm -f /data/backup.db');
      expect(create).toBeGreaterThanOrEqual(0);
      expect(copy).toBeGreaterThan(create);
      expect(verify).toBeGreaterThan(copy);
      expect(clean).toBeGreaterThan(verify);
      expect(t.stdin()).toBe("today's backup\n");
      expect(at(calls, 'backup.js alert')).toBe(-1);
    });

    it('drops the backups by their 30th day, the leftovers of a power cut too, and only those', () => {
      const t = install();
      const old = t.existing('fripon-2026-01-01.db', 30);
      const part = t.existing('.fripon-2026-01-01.part', 30);
      const recent = t.existing('fripon-2026-02-01.db', 28);
      const other = t.existing('notes.txt', 90);

      expect(t.run([]).status).toBe(0);

      expect(existsSync(old)).toBe(false);
      expect(existsSync(part)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(other)).toBe(true);
    });

    it.each([
      ['the copy cannot be made', 'backup.js create'],
      ['the file cannot be fetched', 'cp fripon-cloud'],
      ['the copy cannot be read back', 'backup.js verify'],
    ])('when %s: deletes nothing, keeps nothing, alerts the owner', (_name, fail) => {
      const t = install();
      const old = t.existing('fripon-2026-01-01.db', 31);

      const result = t.run([], { fail });

      expect(result.status).not.toBe(0);
      expect(existsSync(old)).toBe(true);
      expect(t.inBackups()).toEqual(['fripon-2026-01-01.db']);
      const calls = t.calls();
      expect(at(calls, 'backup.js alert')).toBeGreaterThanOrEqual(0);
      expect(at(calls, 'rm -f /data/backup.db')).toBeGreaterThanOrEqual(0);
    });

    it("does not overwrite today's earlier backup when a second run fails", () => {
      const t = install();
      expect(t.run([]).status).toBe(0);
      const [file] = t.inBackups();
      writeFileSync(join(t.backups, file as string), 'the good one');

      expect(t.run([], { fail: 'backup.js verify' }).status).not.toBe(0);

      expect(readFileSync(join(t.backups, file as string), 'utf8')).toBe('the good one');
    });

    it('still reports the failure when the alert cannot be sent', () => {
      const t = install();

      const result = t.run([], { fail: 'backup.js' });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("L'alerte n'a pas pu être envoyée");
    });
  });

  describe('--verify', () => {
    it('reads the file in a throwaway container, and changes nothing', () => {
      const t = install();
      const file = t.existing('fripon-2026-02-01.db');

      expect(t.run(['--verify', file]).status).toBe(0);

      expect(t.stdin()).toBe('an older backup');
      expect(t.calls()).toHaveLength(1);
      expect(t.calls()[0]).toContain('run --rm --no-deps -T fripon-cloud');
    });

    it('fails on a damaged backup, and on a missing file', () => {
      const t = install();
      const file = t.existing('fripon-2026-02-01.db');

      expect(t.run(['--verify', file], { fail: 'backup.js verify' }).status).not.toBe(0);
      expect(t.run(['--verify', join(t.backups, 'nothing.db')]).status).not.toBe(0);
      expect(t.run(['--verify']).status).not.toBe(0);
    });
  });

  describe('--restore', () => {
    const CONFIRM = { input: 'RESTAURER\n' };

    it('verifies, stops the server, swaps the database, starts the server', () => {
      const t = install();
      const file = t.existing('fripon-2026-02-01.db');

      const result = t.run(['--restore', file], CONFIRM);

      expect(result.status).toBe(0);
      const calls = t.calls();
      const verify = at(calls, 'backup.js verify');
      const stop = at(calls, 'stop fripon-cloud');
      const swap = at(calls, 'mv /data/fripon.db.new /data/fripon.db');
      const up = at(calls, 'up -d --wait fripon-cloud');
      expect(verify).toBeGreaterThanOrEqual(0);
      expect(stop).toBeGreaterThan(verify);
      expect(swap).toBeGreaterThan(stop);
      expect(up).toBeGreaterThan(swap);
      expect(t.stdin()).toBe('an older backup');
      expect(result.stdout).toContain('stripe-resync');
      // The -wal holds the last writes of a database that was not closed cleanly.
      expect(at(calls, 'cp /data/fripon.db-wal /data/before-restore/')).toBeGreaterThanOrEqual(0);
    });

    it.each(['', 'oui\n'])('touches nothing without the confirmation (%j)', (input) => {
      const t = install();
      const file = t.existing('fripon-2026-02-01.db');

      expect(t.run(['--restore', file], { input }).status).not.toBe(0);

      expect(at(t.calls(), 'stop fripon-cloud')).toBe(-1);
    });

    it('does not even ask for a backup that cannot be read', () => {
      const t = install();
      const file = t.existing('fripon-2026-02-01.db');

      const result = t.run(['--restore', file], { ...CONFIRM, fail: 'backup.js verify' });

      expect(result.status).not.toBe(0);
      expect(at(t.calls(), 'stop fripon-cloud')).toBe(-1);
    });

    it('starts the server again when the swap fails', () => {
      const t = install();
      const file = t.existing('fripon-2026-02-01.db');

      const result = t.run(['--restore', file], { ...CONFIRM, fail: 'fripon.db.new' });

      expect(result.status).not.toBe(0);
      expect(at(t.calls(), 'up -d fripon-cloud')).toBeGreaterThanOrEqual(0);
    });

    it('fails on a missing file before touching anything', () => {
      const t = install();

      expect(t.run(['--restore', join(t.backups, 'nothing.db')], CONFIRM).status).not.toBe(0);

      expect(t.calls()).toEqual([]);
    });
  });

  it('refuses an unknown option', () => {
    const t = install();

    expect(t.run(['--oops']).status).toBe(2);
    expect(t.calls()).toEqual([]);
  });
});
