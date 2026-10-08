import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { get, insert, run } from './db.ts';
import { forbidden, HttpError } from './lib.ts';
import type { Role } from '../shared/domain.ts';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  primary_process_id: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const COOKIE = 'umami_session';
const SESSION_DAYS = 14;

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  insert('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)', token, userId, exp);
  return token;
}

export function destroySession(token: string) {
  run('DELETE FROM sessions WHERE token=?', token);
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export function sessionToken(req: Request) {
  return readCookie(req, COOKIE);
}

export function setSessionCookie(res: Response, token: string | null) {
  const secure = process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    token
      ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
      : `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = sessionToken(req);
  if (token) {
    const u = get(
      `SELECT u.id, u.name, u.email, r.key AS role, u.primary_process_id FROM sessions s
       JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
      token,
      new Date().toISOString(),
    );
    if (u) req.user = u as AuthUser;
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, 'Please sign in'));
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in'));
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const isAdmin = (req: Request) => req.user?.role === 'admin';
