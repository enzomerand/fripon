import { Hono } from 'hono';
import { createContext, type AppDeps, type AppEnv, type RouteModule } from './context';
import { registerAuthRoutes } from './routes/auth';
import { registerMeRoute } from './routes/me';

export type { AppContext, AppDeps, AppEnv, RouteModule } from './context';

/**
 * The HTTP app. `extraRoutes` is where the other route groups plug in (the Google proxy, billing):
 * each is a `RouteModule`, built by its own factory with its own dependencies, e.g.
 * `createApp(deps, [registerProxyRoutes(google), registerBillingRoutes(stripe)])`.
 *
 * No CORS headers on purpose: the extension's background calls with host permissions, and no web
 * page has any business calling this server.
 */
export function createApp(deps: AppDeps, extraRoutes: RouteModule[] = []): Hono<AppEnv> {
  const ctx = createContext(deps);
  const app = new Hono<AppEnv>();

  // Answers carry a person's account and quota: nothing may keep them.
  app.use('/v1/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });

  // 503 while the database does not answer, and while the owner's own Google key was refused in the
  // last 10 minutes (`degraded` names the service): an external probe on this address catches both.
  app.get('/healthz', (c) => {
    try {
      deps.db.prepare('SELECT 1').get();
    } catch {
      return c.json({ ok: false }, 503);
    }
    const degraded = ctx.health.degraded();
    return degraded.length === 0 ? c.json({ ok: true }) : c.json({ ok: false, degraded }, 503);
  });

  for (const register of [registerAuthRoutes, registerMeRoute, ...extraRoutes]) register(app, ctx);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    console.error('Unhandled error:', error);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}
