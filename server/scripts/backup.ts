// What `scripts/backup.sh` runs inside the container (the image has no `sqlite3` client):
//   node dist/backup.js create <file>   copies the database of DATABASE_PATH to <file> and verifies it
//   node dist/backup.js verify <file>   checks that <file> can be restored
//   node dist/backup.js alert <text>    tells the owner by e-mail that a backup failed
// Prints counts only, never an address. None of them goes through `loadConfig`: an unrelated invalid
// setting must not stop a backup, nor the e-mail saying that the server does not start. A failed
// send exits non-zero, so that `backup.sh` can say so.
import { createBackup, verifyBackup, type BackupSummary } from '../src/backup';
import { createSmtpMailer } from '../src/mailer';

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
    const { SMTP_URL, MAIL_FROM, OWNER_EMAIL } = process.env;
    if (!SMTP_URL || !MAIL_FROM || !OWNER_EMAIL) {
      throw new Error('SMTP_URL, MAIL_FROM and OWNER_EMAIL are needed to send an alert');
    }
    await createSmtpMailer(SMTP_URL, MAIL_FROM).sendAlert(
      OWNER_EMAIL,
      '[Fripon Cloud] backup-failure',
      argument,
    );
  } else {
    throw new Error('usage: backup.js create|verify <file>, or backup.js alert <text>');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
