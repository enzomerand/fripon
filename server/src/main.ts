import { serve } from '@hono/node-server';
import { GEMINI_URL, vertexGeminiUrl } from '../../lib/google/gemini';
import { createApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { realGoogleDeps } from './google';
import { purgeExpired } from './maintenance';
import { createMailer } from './mailer';
import { registerBillingRoutes } from './routes/billing';
import { registerLegalRoutes } from './routes/legal';
import { registerProxyRoutes } from './routes/proxy';
import { createShutdown } from './shutdown';
import { realStripe } from './stripe';

const config = loadConfig();
if (config.production && !config.trustProxy) {
  // Behind Caddy every client then looks like the proxy's own address: the per-address limits and
  // the cap on accounts per address would hit everybody at once.
  console.warn(
    '[config] TRUST_PROXY is false: the client address is read from the socket, not from ' +
      'X-Forwarded-For. That is only right when no reverse proxy is in front of the server.',
  );
}
const db = openDb(config.databasePath);
const now = () => new Date();

const app = createApp({ db, mailer: createMailer(config), config, now }, [
  registerProxyRoutes(
    realGoogleDeps(
      config.geminiVertexModel === null ? GEMINI_URL : vertexGeminiUrl(config.geminiVertexModel),
    ),
  ),
  registerBillingRoutes(realStripe(config.stripeSecretKey)),
  registerLegalRoutes,
]);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Fripon Cloud listening on :${info.port} (${config.nodeEnv})`);
});

purgeExpired(db, Date.now());
const purge = setInterval(() => purgeExpired(db, Date.now()), 60 * 60 * 1000);
purge.unref();

const shutdown = createShutdown({
  server,
  cleanup: () => {
    clearInterval(purge);
    db.close();
  },
  exit: (code) => process.exit(code),
  log: console.log,
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
