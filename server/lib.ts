import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError, type ZodTypeAny, type infer as zInfer } from 'zod';

export const APP_TZ = process.env.APP_TZ ?? 'Asia/Kolkata';

/** Current calendar date (YYYY-MM-DD) in the factory's time zone. Overridable for tests/demo. */
let clock: number | null = null;
/** Pin the application clock (used by the demo seeder to replay history, and by tests). */
export function setClock(at: Date | string | null) {
  clock = at === null ? null : new Date(at).getTime();
}
const now = () => (clock === null ? new Date() : new Date(clock));

export function today(): string {
  if (process.env.APP_TODAY && clock === null) return process.env.APP_TODAY;
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
}
export const nowIso = () => now().toISOString();

export function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): zInfer<S> {
  return schema.parse(data);
}

/** Wrap an async/sync handler so thrown errors reach the error middleware. */
export const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.then((v) => !res.headersSent && v !== undefined && res.json(v)).catch(next);
      else if (!res.headersSent && out !== undefined) res.json(out);
    } catch (e) {
      next(e);
    }
  };

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const fields = Object.fromEntries(err.issues.map((i) => [i.path.join('.') || '_', i.message]));
    return res.status(400).json({ error: 'Please check the highlighted fields', fields });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (typeof err?.message === 'string' && /constraint|append-only|immutable/i.test(err.message)) {
    return res.status(409).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
}

export const intId = (v: unknown, what = 'id') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${what}`);
  return n;
};

export const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
