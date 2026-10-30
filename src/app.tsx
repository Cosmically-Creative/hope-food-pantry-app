import type Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Child } from 'hono/jsx';
import { registerAdmin } from './admin-http.js';
import { readSession } from './auth/session.js';
import type { AppConfig } from './config.js';
import { EmptySchedulePage, EventPage, Layout, NotFoundPage, ProblemPage } from './pages.js';
import { getPublishedEvent } from './schedule.js';
import { registerReminderOff } from './reminder-http.js';
import { registerPublicSignup } from './signup-http.js';
import { securityHeaders } from './security.js';
import { SHARED_ASSET_CACHE, SPECULATION_RULES, assetCacheControl, publicDirectory, readPublicFile, rewriteCssUrls, staticAssetStamp } from './static-assets.js';
import { nowUtc } from './time.js';
import { appPath } from './url.js';

export { publicDirectory };

export function createApp(
  config: AppConfig,
  db: Database.Database,
  options?: {
    now?: string;
    publicDir?: string;
    clientIp?: (c: Context) => string | null;
    verifyTurnstile?: Parameters<typeof registerPublicSignup>[1]['verifyTurnstile'];
  },
): Hono {
  const app = new Hono();
  const now = () => options?.now ?? nowUtc();
  const publicDir = options?.publicDir ?? publicDirectory();

  app.use('*', securityHeaders({ https: config.secureCookies, speculationRules: appPath(config, '/speculation-rules.json') }));
  app.use('*', bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => {
      c.header('Cache-Control', 'no-store');
      return c.text('Request body too large.', 413);
    },
  }));
  app.use(appPath(config, '/css/*'), staticFiles(config, publicDir));
  app.use(appPath(config, '/brand/*'), staticFiles(config, publicDir));
  app.use(appPath(config, '/img/*'), staticFiles(config, publicDir));
  app.use(appPath(config, '/js/*'), staticFiles(config, publicDir));

  app.get(appPath(config, '/speculation-rules.json'), (c) => {
    c.header('Cache-Control', SHARED_ASSET_CACHE);
    c.header('Content-Type', 'application/speculationrules+json; charset=utf-8');
    return c.body(JSON.stringify(SPECULATION_RULES));
  });

  app.get(appPath(config, '/healthz'), (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      db.prepare('SELECT 1 AS ok').get();
      return c.json({ ok: true, database: 'ok' });
    } catch {
      return c.json({ ok: false, database: 'unavailable' }, 503);
    }
  });

  app.get(appPath(config, '/'), (c) => {
    const at = now();
    const event = getPublishedEvent(db, 'weekly-pantry', at);
    if (!event) {
      return page(c, config, db, at, 'Weekly pantry · Hope Volunteer', <EmptySchedulePage />);
    }
    return page(
      c,
      config,
      db,
      at,
      `${event.title} · Hope Volunteer`,
      <EventPage config={config} event={event} now={at} month={c.req.query('month')} view={c.req.query('view')} path="/" />,
    );
  });

  if (config.basePath !== '') {
    app.get(`${config.basePath}/`, (c) => c.redirect(config.basePath, 302));
  }

  app.get(appPath(config, '/e/:slug'), (c) => {
    const at = now();
    const slug = c.req.param('slug') ?? '';
    const event = getPublishedEvent(db, slug, at);
    if (!event) return page(c, config, db, at, 'That page is not available · Hope Volunteer', <NotFoundPage />, 404);
    return page(
      c,
      config,
      db,
      at,
      `${event.title} · Hope Volunteer`,
      <EventPage config={config} event={event} now={at} month={c.req.query('month')} view={c.req.query('view')} />,
    );
  });

  registerPublicSignup(app, {
    config,
    db,
    now,
    clientIp: options?.clientIp,
    verifyTurnstile: options?.verifyTurnstile,
  });

  registerReminderOff(app, {
    config,
    db,
    now,
    clientIp: options?.clientIp,
  });

  registerAdmin(app, {
    config,
    db,
    now,
    clientIp: options?.clientIp,
    verifyTurnstile: options?.verifyTurnstile,
  });

  app.notFound((c) => page(c, config, db, now(), 'That page is not available · Hope Volunteer', <NotFoundPage />, 404));
  app.onError((err, c) => {
    console.error(err instanceof Error ? err.message : err);
    return page(c, config, db, now(), 'Something went wrong · Hope Volunteer', <ProblemPage />, 500);
  });

  return app;
}

function page(
  c: Context,
  config: AppConfig,
  db: Database.Database,
  now: string,
  title: string,
  body: Child,
  status: 200 | 404 | 500 = 200,
) {
  c.header('Cache-Control', 'no-store');
  const account = readSession(db, c.req.header('cookie'), now);
  return c.html(
    <Layout config={config} title={title} path={c.req.path} account={account ? { csrf: account.csrf } : null}>
      {body}
    </Layout>,
    status,
  );
}

function staticFiles(config: AppConfig, publicDir: string) {
  return async (c: Context, next: () => Promise<void>) => {
    const file = readPublicFile(publicDir, c.req.path, config.basePath);
    if (!file) return next();
    const cache = assetCacheControl(c.req.query('v'), publicDir);
    c.header('Cache-Control', cache);
    c.header('Content-Type', file.type);
    if (file.type.startsWith('text/css')) {
      return c.body(rewriteCssUrls(file.body.toString('utf8'), staticAssetStamp(publicDir)));
    }
    return c.body(new Uint8Array(file.body));
  };
}

