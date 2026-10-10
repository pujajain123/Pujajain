import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

/**
 * Storage for the Umami Studio operations dashboard.
 * - Workspace records keep the dashboard's own JSON shape (orders, inventory, transactions, activity).
 * - Accounts, sessions and single-use tokens are relational; secrets are stored only as hashes.
 * - Transactions and activity are append-only (triggers); only rows flagged as demo data can be removed.
 */
const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  has_email INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  status TEXT NOT NULL CHECK (status IN ('invited','active','disabled')),
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  last_login_at TEXT,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite','reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_events (
  id INTEGER PRIMARY KEY,
  time TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  actor_id INTEGER REFERENCES users(id),
  event TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS inventory (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  actor TEXT NOT NULL,
  entity TEXT NOT NULL,
  text TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activity_time ON activity(time);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);

CREATE TRIGGER IF NOT EXISTS transactions_no_update BEFORE UPDATE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS transactions_no_delete BEFORE DELETE ON transactions WHEN old.demo = 0
BEGIN SELECT RAISE(ABORT, 'transactions are append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity WHEN old.demo = 0
BEGIN SELECT RAISE(ABORT, 'activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'users are never deleted; disable them instead'); END;
`;

export const DATA_DIR = process.env.OPS_DATA_DIR ?? path.resolve('data', 'ops');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

let db: DatabaseSync | null = null;

export function openDb(file = process.env.OPS_DB_PATH ?? path.join(DATA_DIR, 'ops.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function conn(): DatabaseSync {
  if (!db) openDb();
  return db!;
}

export const now = () => new Date().toISOString();
export const get = (sql: string, ...p: unknown[]): Row => conn().prepare(sql).get(...(p as never[]));
export const all = (sql: string, ...p: unknown[]): Row[] => conn().prepare(sql).all(...(p as never[]));
export const run = (sql: string, ...p: unknown[]) => conn().prepare(sql).run(...(p as never[]));

let depth = 0;
export function tx<T>(fn: () => T): T {
  const name = `sp${depth++}`;
  conn().exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    conn().exec(`RELEASE ${name}`);
    return out;
  } catch (e) {
    conn().exec(`ROLLBACK TO ${name}`);
    conn().exec(`RELEASE ${name}`);
    throw e;
  } finally {
    depth--;
  }
}

export function kvGet<T>(key: string, fallback: T): T {
  const r = get('SELECT value FROM kv WHERE key=?', key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}
export function kvSet(key: string, value: unknown) {
  run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

/** Monotonic counter bumped on every workspace write, so open dashboards know to refresh. */
export function bumpRevision(): number {
  const next = kvGet('revision', 0) + 1;
  kvSet('revision', next);
  return next;
}
