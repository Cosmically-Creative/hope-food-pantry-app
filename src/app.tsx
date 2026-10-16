import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';
import type Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Child } from 'hono/jsx';
import { registerAdmin } from './admin-http.js';
import { readSession } from './auth/session.js';
import type { AppConfig } from './config.js';
import { EmptySchedulePage, EventPage, Layout, NotFoundPage, PrivacyPage, ProblemPage } from './pages.js';
import { getPublishedEvent } from './schedule.js';
import { privacyParagraphs, readPantrySettings } from './settings.js';
import { registerReminderOff } from './reminder-http.js';
import { registerPublicSignup } from './signup-http.js';
import { securityHeaders } from './security.js';
import { nowUtc } from './time.js';
import { appPath } from './url.js';

export function publicDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
}

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

  app.use('*', securityHeaders({ https: config.secureCookies }));
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
      <EventPage config={config} event={event} now={at} month={c.req.query('month')} path="/" />,
    );
  });

  if (config.basePath !== '') {
    app.get(`${config.basePath}/`, (c) => c.redirect(config.basePath, 302));
  }

  app.get(appPath(config, '/privacy'), (c) => {
    const paragraphs = privacyParagraphs(readPantrySettings(db, config.mail.replyTo).privacyText);
    return page(c, config, db, now(), 'Privacy · Hope Volunteer', <PrivacyPage paragraphs={paragraphs} />);
  });

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
      <EventPage config={config} event={event} now={at} month={c.req.query('month')} />,
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
  return serveStatic({
    root: publicDir,
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache');
    },
    rewriteRequestPath: (requestPath) => {
      if (config.basePath !== '' && requestPath.startsWith(config.basePath)) {
        return requestPath.slice(config.basePath.length) || '/';
      }
      return requestPath;
    },
  });
}

