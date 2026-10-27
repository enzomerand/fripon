import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { realGoogleDeps } from './google';
import { purgeExpired } from './maintenance';
import { createMailer } from './mailer';
import { registerBillingRoutes } from './routes/billing';
import { registerProxyRoutes } from './routes/proxy';
import { realStripe } from './stripe';

const config = loadConfig();
const db = openDb(config.databasePath);
const now = () => new Date();

const app = createApp({ db, mailer: createMailer(config), config, now }, [
  registerProxyRoutes(realGoogleDeps()),
  registerBillingRoutes(realStripe(config.stripeSecretKey)),
]);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Fripon Cloud listening on :${info.port} (${config.nodeEnv})`);
});

purgeExpired(db, Date.now());
const purge = setInterval(() => purgeExpired(db, Date.now()), 60 * 60 * 1000);
purge.unref();

/** Stops taking requests, lets the running ones finish, then closes the database. */
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  clearInterval(purge);
  // A connection kept alive by a client must not hold the container past its stop timeout.
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
