import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { get, run, now, kvGet, tx } from './db.ts';
import {
  HttpError, loadMe, requireAuth, requireAdmin, createSession, setSessionCookie, verifyPassword, hashPassword,
  checkPasswordStrength, throttle, recordFailure, clearFailures, findToken, consumeToken, revokeSessions, logAuthEvent, COOKIE,
} from './auth.ts';
import { createUser, listUsers, resetPassword, setStatus, publicUser, forgotPassword } from './accounts.ts';
import { readState, createOrder, updateOrder, addTransaction, addActivity, putSettings, putTracker, clearDemo, readUpload } from './workspace.ts';
import { ensureReady, ROOT } from './setup.ts';

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

const APP_DIR = path.join(ROOT, 'codex-app');
const SCRIPTS = /<!-- app-scripts:start -->[\s\S]*?<!-- app-scripts:end -->/;

/** The dashboard page, with its browser-only data scripts swapped for the server boot script. */
function indexHtml() {
  return fs.readFileSync(path.join(APP_DIR, 'index.html'), 'utf8').replace(SCRIPTS, '<script src="/boot.js"></script>');
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '25mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    // CSRF defence for cookie sessions: state-changing API calls must be JSON from this site.
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!req.is('application/json')) return res.status(415).json({ error: 'Requests must be JSON.' });
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
    next();
  });
  // Serverless hosts start a fresh instance per cold start: connect, migrate and seed before the first request.
  app.use((_req, _res, next) => { ensureReady().then(() => next(), next); });
  app.use(loadMe);

  /* ---------- Auth ---------- */
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', wrap(async (req, res) => {
    const login = String(req.body?.login ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
    const key = `${req.ip}|${login}`;
    await throttle(key);
    const u = await get('SELECT * FROM users WHERE email=?', login);
    if (!u || u.status !== 'active' || !verifyPassword(password, u.password_hash)) {
      await recordFailure(key);
      if (u) await logAuthEvent('login_failed', u.id, null);
      throw new HttpError(401, u?.status === 'disabled' ? 'This account is disabled. Contact an admin.' : 'Email/login ID or password is incorrect.');
    }
    await clearFailures(key);
    await run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
    await logAuthEvent('login', u.id, u.id);
    setSessionCookie(res, await createSession(u.id));
    res.json({ user: publicUser(u) });
  }));

  app.post('/api/auth/forgot', wrap(async (req, res) => {
    const key = `forgot|${req.ip}`;
    await throttle(key);
    await recordFailure(key); // counts every request, so the form cannot be used to flood inboxes
    await forgotPassword(req.body?.login, req);
    res.json({ ok: true });
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    if (req.sessionHash) await run('DELETE FROM sessions WHERE token_hash=?', req.sessionHash);
    setSessionCookie(res, null);
    res.json({ ok: true });
  }));

  app.get('/api/auth/me', wrap(async (req, res) => {
    if (!req.me) return res.status(401).json({ error: 'Please sign in.', code: 'signed_out' });
    res.json({ user: publicUser(await get('SELECT * FROM users WHERE id=?', req.me.id)) });
  }));

  app.get('/api/auth/token', wrap(async (req, res) => {
    const t = await findToken(req.query.token);
    if (!t) return res.status(404).json({ error: 'This link is not valid. Ask an admin for a new one.' });
    if ('invalid' in t) return res.status(410).json({ error: t.invalid });
    res.json({ email: t.email, name: t.name, purpose: t.purpose, expiresAt: t.expires_at, hasEmail: !!t.has_email });
  }));

  app.post('/api/auth/set-password', wrap(async (req, res) => {
    const t = await findToken(req.body?.token);
    if (!t) throw new HttpError(404, 'This link is not valid. Ask an admin for a new one.');
    if ('invalid' in t) throw new HttpError(410, t.invalid);
    const password = checkPasswordStrength(req.body?.password);
    await tx(async () => {
      await consumeToken(t.id);
      await run(`UPDATE users SET password_hash=?, must_change_password=0, status='active' WHERE id=?`, hashPassword(password), t.user_id);
      await revokeSessions(t.user_id);
    });
    await logAuthEvent('password_set', t.user_id, t.user_id, t.purpose);
    setSessionCookie(res, await createSession(t.user_id));
    res.json({ user: publicUser(await get('SELECT * FROM users WHERE id=?', t.user_id)) });
  }));

  app.post('/api/auth/change-password', wrap(async (req, res) => {
    if (!req.me) throw new HttpError(401, 'Please sign in.', 'signed_out');
    const u = await get('SELECT * FROM users WHERE id=?', req.me.id);
    if (!verifyPassword(String(req.body?.current ?? ''), u.password_hash)) throw new HttpError(400, 'Your current password is incorrect.');
    const password = checkPasswordStrength(req.body?.password);
    if (verifyPassword(password, u.password_hash)) throw new HttpError(400, 'Choose a password different from the current one.');
    await run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(password), u.id);
    await revokeSessions(u.id, req.sessionHash);
    await logAuthEvent('password_changed', u.id, u.id);
    res.json({ user: publicUser(await get('SELECT * FROM users WHERE id=?', u.id)) });
  }));

  /* ---------- Workspace (signed in, password set) ---------- */
  app.use('/api', requireAuth);
  app.get('/api/state', wrap(async (req, res) => res.json(await readState(req.me!))));
  app.get('/api/revision', wrap(async (_req, res) => res.json({ revision: Number(await kvGet('revision', 0)) })));
  app.post('/api/orders', wrap(async (req, res) => res.status(201).json({ order: await createOrder(req.me!, req.body?.order) })));
  app.put('/api/orders/:id', wrap(async (req, res) => res.json({ order: await updateOrder(req.me!, req.params.id, req.body?.order, req.body?.baseVersion) })));
  app.post('/api/transactions', wrap(async (req, res) => res.status(201).json(await addTransaction(req.me!, req.body?.transaction))));
  app.post('/api/activity', wrap(async (req, res) => { await addActivity(req.me!, req.body?.entries); res.status(201).json({ ok: true }); }));
  app.put('/api/settings', wrap(async (req, res) => res.json({ settings: await putSettings(req.me!, req.body?.settings) })));
  app.put('/api/tracker', wrap(async (req, res) => { await putTracker(req.me!, req.body?.rows); res.json({ ok: true }); }));
  app.post('/api/demo/clear', wrap(async (req, res) => { await clearDemo(req.me!); res.json({ ok: true }); }));

  /* ---------- Staff management (admin) ---------- */
  app.get('/api/admin/users', requireAdmin, wrap(async (_req, res) => res.json({ users: await listUsers() })));
  app.post('/api/admin/users', requireAdmin, wrap(async (req, res) => res.status(201).json(await createUser(req.me!, { name: req.body?.name, email: req.body?.email, role: 'staff' }, req))));
  app.post('/api/admin/users/:id/reset-password', requireAdmin, wrap(async (req, res) => res.json(await resetPassword(req.me!, req.params.id, req))));
  app.post('/api/admin/users/:id/disable', requireAdmin, wrap(async (req, res) => res.json({ user: await setStatus(req.me!, req.params.id, false) })));
  app.post('/api/admin/users/:id/enable', requireAdmin, wrap(async (req, res) => res.json({ user: await setStatus(req.me!, req.params.id, true) })));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  /* ---------- Photos (signed-in users only) and the dashboard itself ---------- */
  app.get('/uploads/:file', wrap(async (req, res) => {
    if (!req.me) return res.status(401).end();
    const name = path.basename(req.params.file);
    const file = /^[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(name) ? await readUpload(name) : null;
    if (!file) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.type(file.type).send(file.data);
  }));
  const page = (_req: Request, res: Response) => { res.setHeader('Cache-Control', 'no-store'); res.type('html').send(indexHtml()); };
  app.get(['/', '/index.html', '/login', '/set-password'], page);
  // Only the app's code and styling are public; workspace data files need a signed-in user, the browser-only seed never ships.
  app.use((req, res, next) => {
    const f = path.basename(req.path);
    if (/^seed(-data)?\.js$|\.md$/i.test(f)) return res.status(404).end();
    if (/\.json$/i.test(f) && !req.me) return res.status(401).end();
    next();
  });
  app.use(express.static(APP_DIR, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
    if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

export { COOKIE };
