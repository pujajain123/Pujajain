import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'umami.db');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

/**
 * Normalised relational schema. Notes:
 * - Stock balances are never stored: the `inventory` view derives them from `inventory_transactions`.
 * - `activity_logs` and `order_status_history` are append-only (enforced with triggers).
 * - Order progress, delay and deadline risk are computed, never typed in.
 */
const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  primary_process_id INTEGER REFERENCES job_processes(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_stages (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  description TEXT,
  target_days INTEGER          -- planning SLA for time spent in the stage
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  gstin TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Production process master: Iron Work, Rope Work, Fabric Work (extensible).
CREATE TABLE IF NOT EXISTS job_processes (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  material_category TEXT,          -- inventory category this process draws from (rope/fabric), if any
  fields_json TEXT NOT NULL DEFAULT '[]', -- process-specific job sheet field definitions
  steps_json TEXT NOT NULL DEFAULT '[]',  -- production steps and their QC gates, in order
  checklist_json TEXT NOT NULL DEFAULT '[]', -- QC checklist printed on the job sheet
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  default_dimensions TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

-- Bill of process for a product: which processes it needs and typical material per unit.
CREATE TABLE IF NOT EXISTS product_processes (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  process_id INTEGER NOT NULL REFERENCES job_processes(id),
  material_per_unit REAL,          -- kg of rope / m of fabric per unit
  PRIMARY KEY (product_id, process_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                 -- UM-1024
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  po_number TEXT,                            -- client reference / PO
  order_date TEXT NOT NULL,
  commencement_date TEXT,                    -- production start (Master Production Sheet: COMMENCEMENT)
  sky_date TEXT,                             -- internal target date ahead of the client deadline
  deadline TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  source TEXT,
  stage TEXT NOT NULL DEFAULT 'received' REFERENCES order_stages(key),
  on_hold INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  delivery_address TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_stage ON orders(stage);
CREATE INDEX IF NOT EXISTS idx_orders_deadline ON orders(deadline);

-- One row per product line (SKU) on an order — the Order Detailed Sheet.
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  dimensions TEXT,
  finish TEXT,
  color TEXT,
  specifications TEXT,
  frame_material TEXT,      -- Aluminium / CR / iron
  powder_color TEXT,
  dori_color TEXT,          -- rope colour
  rope_code TEXT,           -- rope size / code
  rope_required REAL,       -- metres
  fabric_code TEXT,
  fabric_company TEXT,
  fabric_qty REAL,          -- metres
  seat_height TEXT,
  seat_bifurcation TEXT,
  back_cushion TEXT,
  extra_cushion TEXT,
  table_top TEXT,           -- table top / stone
  buffer_type TEXT,
  photo TEXT,               -- reference photo (data URI, downscaled in the browser)
  rework TEXT,              -- NULL | required | resolved  (tracker "Rework alert")
  line_notes TEXT
);

-- Material readiness per product line (Master Production Sheet: <material> REQUIRED / STATUS).
CREATE TABLE IF NOT EXISTS item_materials (
  id INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('metal','rope','fabric','foam','tile')),
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','not_required')),
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  UNIQUE (order_item_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  event TEXT NOT NULL DEFAULT 'transition',   -- transition | hold | resume | cancel | rollback
  note TEXT,
  changed_by INTEGER REFERENCES users(id),    -- NULL = system
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_osh_order ON order_status_history(order_id);

-- Stage checklists (preparation checklist, packaging / dispatch readiness).
CREATE TABLE IF NOT EXISTS order_checklist_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  label TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES users(id),
  done_at TEXT,
  sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,                  -- JOB-001
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  process_id INTEGER NOT NULL REFERENCES job_processes(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  completed_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','on_hold','completed','delayed')),
  assigned_to INTEGER REFERENCES users(id),
  start_date TEXT,                            -- planned start
  due_date TEXT,                              -- planned completion
  started_at TEXT,                            -- actual
  completed_at TEXT,                          -- actual
  delay_reason TEXT,
  specs_json TEXT NOT NULL DEFAULT '{}',      -- process-specific job sheet fields
  notes TEXT,
  qc_remarks TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (completed_qty >= 0 AND completed_qty <= quantity),
  UNIQUE (order_item_id, process_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_order ON jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_jobs_assignee ON jobs(assigned_to);

CREATE TABLE IF NOT EXISTS staff_assignments (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unassigned_at TEXT
);

-- Production steps inside a job sheet. Work steps are followed by QC gates:
-- a later work step cannot start until the QC before it is approved.
CREATE TABLE IF NOT EXISTS job_steps (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('work','qc')),
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,       -- work: not_started|in_progress|done|not_required · qc: pending|approved|rejected|not_required
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT,
  UNIQUE (job_id, key)
);

CREATE TABLE IF NOT EXISTS job_checklist (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_by INTEGER REFERENCES users(id),
  done_at TEXT,
  UNIQUE (job_id, key)
);

CREATE TABLE IF NOT EXISTS job_updates (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  qty_before INTEGER,
  qty_after INTEGER,
  status_before TEXT,
  status_after TEXT,
  material_used REAL,
  wastage REAL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_job_updates_job ON job_updates(job_id);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,           -- rope | fabric
  variant TEXT,                     -- e.g. 6mm Olefin / 280 GSM Outdoor Acrylic
  color TEXT,
  unit TEXT NOT NULL,               -- kg | m
  reorder_level REAL NOT NULL DEFAULT 0,
  supplier TEXT,
  location TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  type TEXT NOT NULL CHECK (type IN ('opening','incoming','adjustment_in','adjustment_out','allocation','release','consumption','wastage')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  order_id INTEGER REFERENCES orders(id),
  job_id INTEGER REFERENCES jobs(id),
  user_id INTEGER REFERENCES users(id),
  reference TEXT,                   -- invoice / challan / GRN
  notes TEXT,
  txn_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_material ON inventory_transactions(material_id);
CREATE INDEX IF NOT EXISTS idx_txn_order ON inventory_transactions(order_id);

-- Expected stock (purchase orders not yet received). Receiving posts an 'incoming' transaction.
CREATE TABLE IF NOT EXISTS material_incoming (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  supplier TEXT,
  expected_date TEXT,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','cancelled')),
  received_txn_id INTEGER REFERENCES inventory_transactions(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS material_requirements (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
  process_id INTEGER REFERENCES job_processes(id),
  material_id INTEGER NOT NULL REFERENCES materials(id),
  required_qty REAL NOT NULL CHECK (required_qty > 0),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_order ON material_requirements(order_id);

CREATE TABLE IF NOT EXISTS quality_checks (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  result TEXT NOT NULL CHECK (result IN ('passed','failed','rework')),
  qty_checked INTEGER,
  qty_passed INTEGER,
  qty_rejected INTEGER,
  notes TEXT,
  checked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  dispatched_at TEXT NOT NULL,
  dispatched_by INTEGER REFERENCES users(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  transporter TEXT,
  vehicle_no TEXT,
  tracking_ref TEXT,
  invoice_no TEXT,
  eway_bill TEXT,
  packages INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  dispatch_id INTEGER REFERENCES dispatches(id) ON DELETE CASCADE,
  stage TEXT,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- order_overdue | material_shortage | deadline_approaching | job_completed | low_stock | job_overdue | job_assigned | stage_changed
  severity TEXT NOT NULL CHECK (severity IN ('critical','warning','notice','info')),
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materials(id),
  dedupe_key TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),   -- NULL = System
  entity_type TEXT NOT NULL,               -- order | job | material | dispatch | user | settings ...
  entity_id INTEGER,
  order_id INTEGER,
  job_id INTEGER,
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_order ON activity_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);

CREATE TRIGGER IF NOT EXISTS activity_logs_no_update BEFORE UPDATE ON activity_logs
BEGIN SELECT RAISE(ABORT, 'activity_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS activity_logs_no_delete BEFORE DELETE ON activity_logs
BEGIN SELECT RAISE(ABORT, 'activity_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS status_history_no_update BEFORE UPDATE ON order_status_history
BEGIN SELECT RAISE(ABORT, 'order_status_history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS inventory_txn_no_update BEFORE UPDATE ON inventory_transactions
BEGIN SELECT RAISE(ABORT, 'inventory_transactions are immutable; post a correcting adjustment'); END;
CREATE TRIGGER IF NOT EXISTS inventory_txn_no_delete BEFORE DELETE ON inventory_transactions
BEGIN SELECT RAISE(ABORT, 'inventory_transactions are immutable; post a correcting adjustment'); END;

-- Stock position per material, derived entirely from the ledger.
--   on_hand   = opening + incoming + adj_in - adj_out - consumption - wastage
--   reserved  = per order: max(0, allocated - released - consumed for that order)
--   available = on_hand - reserved
DROP VIEW IF EXISTS inventory;
CREATE VIEW inventory AS
WITH sums AS (
  SELECT m.id AS material_id,
    COALESCE(SUM(CASE WHEN t.type='opening' THEN t.quantity END),0) AS opening,
    COALESCE(SUM(CASE WHEN t.type='incoming' THEN t.quantity END),0) AS incoming,
    COALESCE(SUM(CASE WHEN t.type='adjustment_in' THEN t.quantity WHEN t.type='adjustment_out' THEN -t.quantity END),0) AS adjustments,
    COALESCE(SUM(CASE WHEN t.type='consumption' THEN t.quantity END),0) AS consumed,
    COALESCE(SUM(CASE WHEN t.type='wastage' THEN t.quantity END),0) AS wastage
  FROM materials m LEFT JOIN inventory_transactions t ON t.material_id = m.id
  GROUP BY m.id
),
per_order AS (
  SELECT material_id, order_id,
    SUM(CASE WHEN type='allocation' THEN quantity WHEN type IN ('release','consumption') THEN -quantity ELSE 0 END) AS open_res
  FROM inventory_transactions WHERE order_id IS NOT NULL
  GROUP BY material_id, order_id
),
res AS (
  SELECT material_id, SUM(MAX(open_res, 0)) AS reserved FROM per_order GROUP BY material_id
),
inc AS (
  SELECT material_id, SUM(quantity) AS expected FROM material_incoming WHERE status='pending' GROUP BY material_id
)
SELECT s.material_id, s.opening, s.incoming, s.adjustments, s.consumed, s.wastage,
  (s.opening + s.incoming + s.adjustments - s.consumed - s.wastage) AS on_hand,
  COALESCE(r.reserved,0) AS reserved,
  (s.opening + s.incoming + s.adjustments - s.consumed - s.wastage) - COALESCE(r.reserved,0) AS available,
  COALESCE(i.expected,0) AS expected_incoming
FROM sums s LEFT JOIN res r ON r.material_id = s.material_id LEFT JOIN inc i ON i.material_id = s.material_id;
`;

let _db: DatabaseSync | null = null;

export function openDb(file = DB_PATH): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export function db(): DatabaseSync {
  if (!_db) _db = openDb();
  return _db;
}

/** Swap the active connection (tests use an in-memory database). */
export function useDb(conn: DatabaseSync) {
  _db = conn;
}

export const all = <T = Row>(sql: string, ...params: any[]) => db().prepare(sql).all(...params) as T[];
export const get = <T = Row>(sql: string, ...params: any[]) => db().prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: any[]) => db().prepare(sql).run(...params);
export const insert = (sql: string, ...params: any[]) => Number(db().prepare(sql).run(...params).lastInsertRowid);

let txDepth = 0;
/** Run fn inside a transaction (nesting-safe via savepoints). */
export function tx<T>(fn: () => T): T {
  const name = `sp${txDepth}`;
  const d = db();
  d.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    d.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return out;
  } catch (e) {
    txDepth--;
    d.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  }
}

export function getSetting(key: string, fallback: string): string {
  return get<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value ?? fallback;
}
