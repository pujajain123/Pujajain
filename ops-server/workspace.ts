import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, now, tx, kvGet, kvSet, bumpRevision, UPLOAD_DIR, type Row } from './db.ts';
import { HttpError, type Me } from './auth.ts';

/* The dashboard's own record shapes (see codex-app/app.js). Kept as JSON; access rules live here. */
type Process = { name: string; assigned?: string; completed?: number; status?: string; [k: string]: unknown };
type Order = { id: string; qty?: number; stage?: string; processes: Process[]; items?: Row[]; photoData?: string; [k: string]: unknown };

export const CATEGORIES = ['Rope', 'Fabric', 'Powder Color'] as const;
const TX_TYPES = ['Incoming', 'Outward', 'Consumption', 'Wastage', 'Adjustment'];
const STAGES = ['Order received', 'Being prepared', 'In production', 'Quality check', 'Ready for dispatch', 'Dispatched', 'Completed'];
const STAFF_LOCKED_PROCESS_FIELDS = ['name', 'assigned', 'due', 'required', 'material'];
const RESERVED_KEYS = new Set(['orders', 'inventory', 'transactions', 'activity', 'role', 'me']);

const isAdmin = (me: Me) => me.role === 'admin';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const num = (v: unknown) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/* ---------- Photos: data URLs in records are stored as files and replaced by their URL ---------- */

export function extractImages<T>(value: T): T {
  if (typeof value === 'string') {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!m) return value;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new HttpError(413, 'Photos must be smaller than 8 MB.');
    const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    const file = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    return `/uploads/${name}` as T;
  }
  if (Array.isArray(value)) return value.map(extractImages) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, extractImages(v)])) as T;
  return value;
}

/* ---------- Reads ---------- */

const orderRows = () => all('SELECT id, data, version FROM orders ORDER BY created_at DESC, id DESC');
const parseOrder = (r: Row): Order => ({ ...JSON.parse(r.data), _version: r.version });

export const isAssigned = (o: Order, name: string) => o.processes?.some(p => p.assigned === name);
const staffView = (o: Order, name: string): Order => ({ ...o, processes: o.processes.filter(p => p.assigned === name) });

export function readState(me: Me) {
  const admin = isAdmin(me);
  const orders = orderRows().map(parseOrder);
  const visible = admin ? orders : orders.filter(o => isAssigned(o, me.name)).map(o => staffView(o, me.name));
  const ids = new Set(visible.map(o => o.id));
  const jobPrefixes = visible.map(o => `JOB-${o.id.slice(3)}-`);
  const ownEntity = (e: string) => ids.has(e) || jobPrefixes.some(p => e.startsWith(p));

  const transactions = all('SELECT data, user_id FROM transactions ORDER BY seq DESC').map(r => ({ row: r, t: JSON.parse(r.data) }))
    .filter(({ row, t }) => admin || row.user_id === me.id || ids.has(t.order)).map(({ t }) => t);
  const activity = all('SELECT time, actor, entity, text, user_id, demo FROM activity ORDER BY time DESC, seq DESC LIMIT 2000')
    .filter(a => admin || a.user_id === me.id || a.actor === me.name || ownEntity(a.entity))
    .map(a => ({ time: a.time, actor: a.actor, entity: a.entity, text: a.text, ...(a.demo ? { demo: true } : {}) }));
  const inventory = CATEGORIES.map(name => JSON.parse(get('SELECT data FROM inventory WHERE name=?', name)?.data ?? 'null')).filter(Boolean);

  return {
    db: { ...kvGet<Row>('settings', {}), orders: visible, inventory, transactions, activity, role: admin ? 'Admin' : 'Staff' },
    tracker: admin ? kvGet<Row[]>('tracker', []) : [],
    rope: kvGet<Row>('rope', null),
    people: people(),
    revision: kvGet('revision', 0),
  };
}

/** Names that can be assigned work: active staff accounts plus anyone already assigned in an order. */
export function people(): string[] {
  const staff = all(`SELECT name FROM users WHERE role='staff' AND status<>'disabled' ORDER BY name`).map(r => r.name as string);
  const assigned = orderRows().flatMap(r => (JSON.parse(r.data).processes || []).map((p: Process) => p.assigned)).filter(Boolean) as string[];
  return [...new Set([...staff, ...assigned])];
}

/* ---------- Orders ---------- */

function validateOrder(o: Order) {
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !/^[\w-]{1,40}$/.test(o.id)) throw new HttpError(400, 'Order needs a valid ID.');
  if (!Array.isArray(o.processes)) throw new HttpError(400, 'Order needs its production processes.');
  if (o.stage && !STAGES.includes(o.stage)) throw new HttpError(400, `Unknown stage "${o.stage}".`);
}

function autoStage(o: Order) {
  const qty = num(o.qty);
  if (o.stage === 'In production' && qty > 0 && o.processes.length && o.processes.every(p => num(p.completed) >= qty)) o.stage = 'Quality check';
}

function saveOrder(o: Order, actor: string, version: number) {
  const { _version, ...data } = o as Order & { _version?: number };
  run('UPDATE orders SET data=?, version=?, updated_at=?, updated_by=? WHERE id=?', JSON.stringify(data), version, now(), actor, o.id);
}

export function createOrder(me: Me, input: Order) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can create orders.');
  validateOrder(input);
  const o = extractImages(clone(input));
  delete (o as Row)._version;
  o.createdBy = me.name;
  o.createdAt = o.createdAt || now();
  return tx(() => {
    if (get('SELECT 1 FROM orders WHERE id=?', o.id)) throw new HttpError(409, `Order ${o.id} already exists.`);
    run('INSERT INTO orders (id, data, version, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?)', o.id, JSON.stringify(o), 1, now(), now(), me.name);
    bumpRevision();
    return { ...o, _version: 1 };
  });
}

/**
 * Update an order. Admins replace the whole record. Staff may only change their own processes
 * (progress, steps, QC, job sheet) and product photos; everything else must stay as stored.
 * baseVersion guards against overwriting someone else's newer change.
 */
export function updateOrder(me: Me, id: string, input: Order, baseVersion: number) {
  validateOrder(input);
  if (input.id !== id) throw new HttpError(400, 'Order ID cannot change.');
  return tx(() => {
    const row = get('SELECT data, version FROM orders WHERE id=?', id);
    if (!row) throw new HttpError(404, 'Order not found.');
    const stored: Order = JSON.parse(row.data);
    if (!isAdmin(me) && !isAssigned(stored, me.name)) throw new HttpError(404, 'Order not found.');
    if (Number(baseVersion) !== row.version) throw new HttpError(409, 'This order was changed by someone else. The latest version has been loaded.', 'conflict');
    const incoming = extractImages(clone(input));
    let next: Order;
    if (isAdmin(me)) {
      next = { ...incoming, createdBy: stored.createdBy, createdAt: stored.createdAt };
    } else {
      next = mergeStaffChanges(me, stored, incoming);
    }
    delete (next as Row)._version;
    next.updatedBy = me.name;
    next.updatedAt = now();
    autoStage(next);
    saveOrder(next, me.name, row.version + 1);
    bumpRevision();
    return isAdmin(me) ? { ...next, _version: row.version + 1 } : { ...staffView(next, me.name), _version: row.version + 1 };
  });
}

function mergeStaffChanges(me: Me, stored: Order, incoming: Order): Order {
  const next = clone(stored);
  const ignore = new Set(['processes', 'items', 'photoData', 'updatedBy', 'updatedAt', 'stage', '_version']);
  for (const key of new Set([...Object.keys(stored), ...Object.keys(incoming)])) {
    if (!ignore.has(key) && !same(stored[key], incoming[key])) throw new HttpError(403, `Staff cannot change the order's ${key}.`);
  }
  const mine = stored.processes.filter(p => p.assigned === me.name);
  if (incoming.processes.length !== mine.length) throw new HttpError(403, 'Staff can only update their own job sheets.');
  for (const p of incoming.processes) {
    const idx = next.processes.findIndex(x => x.name === p.name && x.assigned === me.name);
    if (idx < 0) throw new HttpError(403, `${p.name} is not assigned to you.`);
    const before = next.processes[idx];
    for (const f of STAFF_LOCKED_PROCESS_FIELDS) if (!same(before[f], p[f])) throw new HttpError(403, `Staff cannot change a job's ${f}.`);
    next.processes[idx] = { ...p, completed: Math.max(0, Math.min(num(stored.qty), num(p.completed))) };
  }
  if (incoming.photoData !== undefined) next.photoData = incoming.photoData;
  const before = stored.items || [], after = incoming.items || [];
  if (before.length !== after.length) throw new HttpError(403, 'Staff cannot add or remove product lines.');
  next.items = before.map((it, i) => {
    const { photoData: _a, ...restBefore } = it, { photoData, ...restAfter } = after[i] || {};
    if (!same(restBefore, restAfter)) throw new HttpError(403, 'Staff can only change product photos on product lines.');
    return { ...it, photoData };
  });
  if (!next.items.length && !stored.items) delete next.items;
  return next;
}

/* ---------- Inventory ledger ---------- */

const loadInventory = (name: string) => JSON.parse(get('SELECT data FROM inventory WHERE name=?', name)?.data ?? 'null');
const saveInventory = (item: Row) => run('INSERT INTO inventory (name, data) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data', item.name, JSON.stringify(item));

export function addTransaction(me: Me, input: Row) {
  const material = String(input?.material || ''), type = String(input?.type || 'Incoming'), qty = num(input?.qty);
  if (!(CATEGORIES as readonly string[]).includes(material)) throw new HttpError(400, 'Inventory category must be Rope, Fabric or Powder Color.');
  if (!TX_TYPES.includes(type)) throw new HttpError(400, 'Unknown transaction type.');
  if (!(qty > 0) || qty > 1e7) throw new HttpError(400, 'Quantity must be more than zero.');
  const order = input.order && input.order !== '—' ? String(input.order) : '—';
  if (order !== '—') {
    const o = get('SELECT data FROM orders WHERE id=?', order);
    if (!o || (!isAdmin(me) && !isAssigned(JSON.parse(o.data), me.name))) throw new HttpError(403, 'You can only link entries to your own orders.');
  }
  const str = (v: unknown, max = 120) => String(v ?? '').trim().slice(0, max);
  const t = {
    id: /^[\w-]{3,40}$/.test(String(input.id || '')) ? String(input.id) : `TX-${Date.now()}`,
    material, type, qty, unit: material === 'Powder Color' ? 'kg' : 'm',
    color: material === 'Rope' ? str(input.color) : '', sku: material === 'Rope' ? str(input.sku) : '', mm: material === 'Rope' ? str(input.mm, 20) : '',
    company: material === 'Fabric' ? str(input.company) : '', colorName: material === 'Powder Color' ? str(input.colorName) : '',
    order, job: str(input.job || '—', 40), staff: me.name, enteredBy: me.name, date: /^\d{4}-\d{2}-\d{2}$/.test(String(input.date)) ? input.date : now().slice(0, 10),
    notes: str(input.notes, 500),
  };
  if (material === 'Rope' && type === 'Incoming' && (!t.sku || !t.color || !t.mm)) throw new HttpError(400, 'Rope entries need colour, SKU and MM.');
  if (material === 'Fabric' && type === 'Incoming' && !t.company) throw new HttpError(400, 'Fabric entries need a company.');
  if (material === 'Powder Color' && type === 'Incoming' && !t.colorName) throw new HttpError(400, 'Powder Color entries need a colour name.');
  return tx(() => {
    if (get('SELECT 1 FROM transactions WHERE id=?', t.id)) t.id = `TX-${Date.now()}-${crypto.randomInt(1000)}`;
    applyTransaction(t);
    run('INSERT INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,?,?)', t.id, JSON.stringify(t), me.id, 0, now());
    bumpRevision();
    return { transaction: t, inventory: CATEGORIES.map(loadInventory).filter(Boolean), rope: kvGet('rope', null) };
  });
}

/** Posts a ledger movement: rope purchases/issues go to the rope workbook, everything else to the category totals. */
export function applyTransaction(t: Row) {
  if (t.material === 'Rope' && t.sku && (t.type === 'Incoming' || t.type === 'Outward')) {
    const rope = kvGet<Row>('rope', null) || { stock_master: [], purchase_log: [], outward_log: [] };
    const eq = (a: unknown, b: unknown) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const masters = rope.stock_master || (rope.stock_master = []);
    let row = masters.find((r: Row) => eq(r['Rope Type (SKU)'], t.sku) && eq(r.mm, `${t.mm}mm`) && eq(r.Color, t.color));
    if (!row) { row = { 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Opening Stock (m)': '0', 'Total Purchased (m)': '0', 'Total Outward (m)': '0', 'Current Balance (m)': '0', '': '' }; masters.push(row); }
    const purchased = num(row['Total Purchased (m)']), outward = num(row['Total Outward (m)']);
    const current = row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null ? num(row['Opening Stock (m)']) + purchased - outward : num(row['Current Balance (m)']);
    const date = new Date(`${t.date}T12:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    if (t.type === 'Incoming') {
      row['Total Purchased (m)'] = String(purchased + t.qty);
      row['Current Balance (m)'] = String(current + t.qty);
      (rope.purchase_log ||= []).unshift({ Date: date, 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Qty Purchased (m)': String(t.qty), Supplier: '', 'Invoice/Bill No.': '', 'Rate (per m)': '', Remarks: t.notes || `Entered by ${t.enteredBy}` });
    } else {
      row['Total Outward (m)'] = String(outward + t.qty);
      row['Current Balance (m)'] = String(current - t.qty);
      (rope.outward_log ||= []).unshift({ Date: date, 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Qty Out (m)': String(t.qty), 'Issued To': t.enteredBy, 'Used For (Job/Product)': t.order, Remarks: t.notes || '' });
    }
    kvSet('rope', rope);
    return;
  }
  const inv = loadInventory(t.material) || { name: t.material, unit: t.unit, opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0 };
  if (t.type === 'Incoming') inv.incoming += t.qty;
  else if (t.type === 'Outward' || t.type === 'Consumption') inv.consumed += t.qty;
  else if (t.type === 'Wastage') inv.wastage += t.qty;
  else inv.adjustments += t.qty;
  saveInventory(inv);
}

/* ---------- Activity (append-only; the actor is always the signed-in user) ---------- */

export function addActivity(me: Me, entries: Row[]) {
  if (!Array.isArray(entries) || entries.length > 50) throw new HttpError(400, 'Send up to 50 activity entries at a time.');
  const visible = isAdmin(me) ? null : new Set(orderRows().map(parseOrder).filter(o => isAssigned(o, me.name)).map(o => o.id));
  return tx(() => {
    for (const e of entries) {
      const entity = String(e?.entity || '').slice(0, 60), text = String(e?.text || '').slice(0, 500);
      if (!entity || !text) continue;
      if (visible && /^(UM-|JOB-)/.test(entity)) {
        const orderId = entity.startsWith('JOB-') ? `UM-${entity.split('-')[1]}` : entity;
        if (!visible.has(orderId)) throw new HttpError(403, 'You can only record activity on your own orders.');
      }
      const actor = e?.actor === 'System' ? 'System' : me.name;
      run('INSERT INTO activity (time, actor, entity, text, user_id) VALUES (?,?,?,?,?)', now(), actor, entity, text, me.id);
    }
    bumpRevision();
  });
}

/* ---------- Admin-only workspace data ---------- */

export function putSettings(me: Me, settings: Row) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can change workspace settings.');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new HttpError(400, 'Settings must be an object.');
  const clean = Object.fromEntries(Object.entries(settings).filter(([k]) => !RESERVED_KEYS.has(k)));
  if (JSON.stringify(clean).length > 200_000) throw new HttpError(413, 'Settings are too large.');
  kvSet('settings', clean);
  bumpRevision();
  return clean;
}

export function putTracker(me: Me, rows: Row[]) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can edit the production tracker.');
  if (!Array.isArray(rows)) throw new HttpError(400, 'Tracker must be a list of rows.');
  kvSet('tracker', rows);
  bumpRevision();
}

export function clearDemo(me: Me) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can remove demo entries.');
  tx(() => {
    for (const r of all('SELECT data FROM transactions WHERE demo=1')) {
      const t = JSON.parse(r.data);
      if (t.material === 'Rope') continue;
      const inv = loadInventory(t.material);
      if (inv) { inv.incoming = Math.max(0, inv.incoming - num(t.qty)); saveInventory(inv); }
    }
    run('DELETE FROM transactions WHERE demo=1');
    run('DELETE FROM activity WHERE demo=1');
    for (const r of orderRows()) {
      const o = JSON.parse(r.data);
      if (o.createdByDemo) { o.createdBy = 'Shubham Jain'; delete o.createdByDemo; run('UPDATE orders SET data=? WHERE id=?', JSON.stringify(o), o.id); }
    }
    bumpRevision();
  });
}

/* ---------- First-run seed from the exported workspace snapshot ---------- */

export function seedWorkspace(snapshot: Row, rope: Row, tracker: Row[]) {
  if (get('SELECT 1 FROM kv WHERE key=?', 'seeded')) return false;
  tx(() => {
    const ops = snapshot.ordersAndOperations || {};
    for (const o of ops.orders || []) {
      const data = extractImages(o);
      run('INSERT OR IGNORE INTO orders (id, data, version, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?)', o.id, JSON.stringify(data), 1, o.createdAt || now(), now(), o.createdBy || 'System');
    }
    const inv = ops.inventory || [];
    for (const name of CATEGORIES) {
      const found = inv.find((i: Row) => i.name === name);
      saveInventory(found || { name, unit: name === 'Powder Color' ? 'kg' : 'm', opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0 });
    }
    for (const t of [...(ops.transactions || [])].reverse()) {
      run('INSERT OR IGNORE INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,?,?)', t.id, JSON.stringify(t), null, t.demo ? 1 : 0, now());
    }
    for (const a of [...(ops.activity || [])].reverse()) {
      run('INSERT INTO activity (time, actor, entity, text, user_id, demo) VALUES (?,?,?,?,?,?)', a.time, a.actor, a.entity, a.text, null, a.demo || String(a.text).startsWith('DEMO · ') ? 1 : 0);
    }
    const { orders: _o, inventory: _i, transactions: _t, activity: _a, role: _r, ...settings } = ops;
    // The dashboard adds its own sample entries when these flags are missing; the server owns that data now.
    kvSet('settings', { ...settings, sampleAuditEventsAdded: true, staffDemoV2: true, inventoryUnitMigrationV1: true });
    kvSet('rope', rope);
    kvSet('tracker', tracker);
    kvSet('seeded', now());
    if (process.env.OPS_DEMO_DATA !== '0') seedDemoEntries();
    bumpRevision();
  });
  return true;
}

/** Sample staff entries (flagged demo) so the staff report has something to show; removable by an admin. */
function seedDemoEntries() {
  const day = (d: number, h = 12) => { const x = new Date(Date.now() - d * 864e5); x.setHours(h, 15, 0, 0); return x.toISOString(); };
  const txs: Row[] = [
    ['TX-DEMO-101', 1, 'Rope', 'Amit Shah', { color: 'Ivory', sku: 'PP-ROPE-IV', mm: '6' }, 250],
    ['TX-DEMO-102', 2, 'Fabric', 'Neha Kapoor', { company: 'SUNBRELLA' }, 40],
    ['TX-DEMO-103', 3, 'Powder Color', 'Rahul Mehta', { colorName: 'Matte Black' }, 25],
    ['TX-DEMO-105', 6, 'Fabric', 'Pooja Rao', { company: 'D’Decor' }, 22],
  ].map(([id, d, material, staff, extra, qty]) => ({ id, material, type: 'Incoming', qty, unit: material === 'Powder Color' ? 'kg' : 'm', color: '', sku: '', mm: '', company: '', colorName: '', order: '—', job: '—', staff, enteredBy: staff, date: day(d as number).slice(0, 10), notes: 'Sample entry', demo: true, ...(extra as Row) }));
  for (const t of txs) {
    if (get('SELECT 1 FROM transactions WHERE id=?', t.id)) continue;
    if (t.material !== 'Rope') applyTransaction(t);
    run('INSERT INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,1,?)', t.id, JSON.stringify(t), null, now());
  }
  const acts: [number, number, string, string, string][] = [
    [1, 11, 'Amit Shah', 'Rope', 'Rope incoming transaction TX-DEMO-101 · Ivory · PP-ROPE-IV · 6 mm · 250 m'],
    [1, 16, 'Amit Shah', 'JOB-1048-ROP', 'Rope Work: 18 → 24 units · In progress'],
    [2, 10, 'Neha Kapoor', 'Fabric', 'Fabric incoming transaction TX-DEMO-102 · SUNBRELLA · 40 m'],
    [2, 15, 'Pooja Rao', 'UM-1046', 'Order details updated · cushion fabric confirmed'],
    [3, 9, 'Rahul Mehta', 'Powder Color', 'Powder Color incoming transaction TX-DEMO-103 · Matte Black · 25 kg'],
    [3, 14, 'Rahul Mehta', 'JOB-1047-IRN', 'Iron work job sheet updated · pipe section and finish'],
    [4, 12, 'Karan Patel', 'UM-1044', 'Dispatch details entered · vehicle and driver'],
    [6, 10, 'Pooja Rao', 'Fabric', 'Fabric incoming transaction TX-DEMO-105 · D’Decor · 22 m'],
  ];
  for (const [d, h, actor, entity, text] of acts) run('INSERT INTO activity (time, actor, entity, text, user_id, demo) VALUES (?,?,?,?,NULL,1)', day(d, h), actor, entity, `DEMO · ${text}`);
}
