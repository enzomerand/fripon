// What `scripts/backup.sh` runs inside the container (the image has no `sqlite3` client):
//   node dist/backup.js create <file>   copies the database of DATABASE_PATH to <file> and verifies it
//   node dist/backup.js verify <file>   checks that <file> can be restored
//   node dist/backup.js alert <text>    tells the owner by e-mail that a backup failed
// Prints counts only, never an address. `create` and `verify` do not read the configuration: an
// unrelated invalid setting must not stop a backup.
import { createAlerts } from '../src/alerts';
import { createBackup, verifyBackup, type BackupSummary } from '../src/backup';
import { loadConfig } from '../src/config';
import { createMailer } from '../src/mailer';

const [command, argument] = process.argv.slice(2);

const printed = ({ schemaVersion, accounts }: BackupSummary) =>
  `backup verified: schema version ${schemaVersion}, ${accounts} accounts`;

try {
  if (command === 'create' && argument) {
    const from = process.env.DATABASE_PATH;
    if (!from) throw new Error('DATABASE_PATH is not set');
    console.log(printed(await createBackup(from, argument)));
  } else if (command === 'verify' && argument) {
    console.log(printed(verifyBackup(argument)));
  } else if (command === 'alert' && argument) {
    const config = loadConfig();
    const mailer = createMailer(config);
    createAlerts({ mailer, ownerEmail: config.ownerEmail, now: () => Date.now() })(
      'backup-failure',
      argument,
    );
  } else {
    throw new Error('usage: backup.js create|verify <file>, or backup.js alert <text>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
