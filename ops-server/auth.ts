import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { get, run, all, now, tx } from './db.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export type Role = 'admin' | 'staff';
export interface Me {
  id: number;
  name: string;
  email: string;
  role: Role;
  must_change_password: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      me?: Me;
      sessionHash?: string;
    }
  }
}

export const COOKIE = 'umami_ops_session';
const SESSION_DAYS = 14;
export const TOKEN_HOURS = 48;
export const MIN_PASSWORD = 8;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  const [, salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Readable random password: no look-alike characters, always mixes letters and digits. */
export function generatePassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ', digits = '23456789';
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [...Array.from({ length: 9 }, () => pick(letters)), pick(digits), pick(digits), pick(digits)];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

export function checkPasswordStrength(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  if (pw.length > 200) throw new HttpError(400, 'Password is too long.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'Use at least one letter and one number.');
  return pw;
}

export async function logAuthEvent(event: string, userId: number | null, actorId: number | null, detail = '') {
  await run('INSERT INTO auth_events (time, user_id, actor_id, event, detail) VALUES (?,?,?,?,?)', now(), userId, actorId, event, detail);
}

/* ---------- Sessions ---------- */

export async function createSession(userId: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), userId, now(), new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
  return token;
}

export async function revokeSessions(userId: number, exceptHash?: string) {
  if (exceptHash) await run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', userId, exceptHash);
  else await run('DELETE FROM sessions WHERE user_id=?', userId);
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export function setSessionCookie(res: Response, token: string | null) {
  const secure = process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1' ? '; Secure' : '';
  res.setHeader('Set-Cookie', token
    ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
    : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export async function loadMe(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = readCookie(req, COOKIE);
    if (token) {
      const hash = sha256(token);
      const me = await get(`SELECT u.id, u.name, u.email, u.role, u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'`, hash, now());
      if (me) { req.me = me as Me; req.sessionHash = hash; }
    }
    next();
  } catch (e) { next(e); }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.me) return next(new HttpError(401, 'Please sign in.', 'signed_out'));
  if (req.me.must_change_password) return next(new HttpError(403, 'Set a new password to continue.', 'password_change_required'));
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.me?.role !== 'admin') return next(new HttpError(403, 'Only admins can do this.', 'forbidden'));
  next();
}

/* ---------- Login throttling (per IP + login, stored so it holds across server instances) ---------- */

const WINDOW = 15 * 60 * 1000, MAX_ATTEMPTS = 8;
export async function throttle(key: string) {
  const a = await get('SELECT count, until FROM login_failures WHERE key=?', key);
  if (a && a.until > now() && a.count >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
}
export async function recordFailure(key: string) {
  const until = new Date(Date.now() + WINDOW).toISOString();
  await run(`INSERT INTO login_failures (key, count, until) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN login_failures.until < ? THEN 1 ELSE login_failures.count + 1 END,
    until = CASE WHEN login_failures.until < ? THEN excluded.until ELSE login_failures.until END`, key, until, now(), now());
}
export const clearFailures = async (key: string) => { await run('DELETE FROM login_failures WHERE key=?', key); };

/* ---------- Single-use tokens (invite / reset) ---------- */

export async function issueToken(userId: number, purpose: 'invite' | 'reset', actorId: number | null): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await tx(async () => {
    // A new link replaces any earlier unused link for the same account.
    await run(`UPDATE auth_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL`, now(), userId);
    await run('INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at, created_at, created_by) VALUES (?,?,?,?,?,?)',
      userId, sha256(token), purpose, new Date(Date.now() + TOKEN_HOURS * 3600e3).toISOString(), now(), actorId);
  });
  return token;
}

export async function findToken(token: unknown) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const t = await get(`SELECT t.id, t.user_id, t.purpose, t.expires_at, t.used_at, u.email, u.name, u.status, u.has_email
    FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=?`, sha256(token));
  if (!t) return null;
  if (t.used_at) return { ...t, invalid: 'This link has already been used. Ask an admin for a new one.' };
  if (t.expires_at < now()) return { ...t, invalid: 'This link has expired. Ask an admin for a new one.' };
  if (t.status === 'disabled') return { ...t, invalid: 'This account is disabled.' };
  return t;
}

export async function consumeToken(tokenId: number) {
  const r = await run('UPDATE auth_tokens SET used_at=? WHERE id=? AND used_at IS NULL', now(), tokenId);
  if (r.changes !== 1) throw new HttpError(410, 'This link has already been used.');
}

export const appUrl = (req?: Request) => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '') || (req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:4100')).replace(/\/$/, '');
export const setPasswordLink = (token: string, req?: Request) => `${appUrl(req)}/set-password?token=${token}`;

/** Unique generated login such as "rahul.mehta@umami.app". */
export async function generateLoginId(name: string): Promise<string> {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^\w\s.-]/g, '').trim().replace(/[\s_]+/g, '.').replace(/\.+/g, '.').replace(/^\.|\.$/g, '') || 'staff';
  const taken = new Set((await all('SELECT email FROM users WHERE email LIKE ?', `${base}%@umami.app`)).map(r => String(r.email).toLowerCase()));
  for (let i = 1; ; i++) {
    const id = `${base}${i === 1 ? '' : i}@umami.app`;
    if (!taken.has(id)) return id;
  }
}
