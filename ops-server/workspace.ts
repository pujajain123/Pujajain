import crypto from 'node:crypto';
import { all, get, run, now, tx, kvGet, kvSet, bumpRevision, type Row } from './db.ts';
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

/* ---------- Photos: data URLs in records are stored in the uploads table and replaced by their URL ---------- */

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export async function extractImages<T>(value: T): Promise<T> {
  if (typeof value === 'string') {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(value);
    if (!m) return value;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new HttpError(413, 'Photos must be smaller than 8 MB.');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`;
    await run('INSERT INTO uploads (name, content_type, data, created_at) VALUES (?,?,?,?) ON CONFLICT (name) DO NOTHING', name, MIME[ext], buf, now());
    return `/uploads/${name}` as T;
  }
  if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await extractImages(v)); return out as T; }
  if (value && typeof value === 'object') {
    const out: Row = {};
    for (const [k, v] of Object.entries(value)) out[k] = await extractImages(v);
    return out as T;
  }
  return value;
}

export async function readUpload(name: string) {
  const r = await get('SELECT content_type, data FROM uploads WHERE name=?', name);
  return r ? { type: r.content_type as string, data: Buffer.from(r.data) } : null;
}

/* ---------- Reads ---------- */

const orderRows = () => all('SELECT id, data, version FROM orders ORDER BY created_at DESC, id DESC');
const parseOrder = (r: Row): Order => ({ ...JSON.parse(r.data), _version: r.version });

export const isAssigned = (o: Order, name: string) => o.processes?.some(p => p.assigned === name);
/** Staff see and work on orders where they have a job, and orders they created. */
export const canAccess = (o: Order, name: string) => isAssigned(o, name) || o.createdBy === name;
const staffView = (o: Order, name: string): Order => ({ ...o, processes: o.processes.filter(p => p.assigned === name) });

export async function readState(me: Me) {
  const admin = isAdmin(me);
  const orders = (await orderRows()).map(parseOrder);
  const visible = admin ? orders : orders.filter(o => canAccess(o, me.name)).map(o => staffView(o, me.name));
  const ids = new Set(visible.map(o => o.id));
  const jobPrefixes = visible.map(o => `JOB-${o.id.slice(3)}-`);
  const ownEntity = (e: string) => ids.has(e) || jobPrefixes.some(p => e.startsWith(p));

  const transactions = (await all('SELECT data, user_id FROM transactions ORDER BY seq DESC')).map(r => ({ row: r, t: JSON.parse(r.data) }))
    .filter(({ row, t }) => admin || row.user_id === me.id || ids.has(t.order)).map(({ t }) => t);
  // An edited entry stays in the ledger, marked with the entry that replaced it.
  const replacedBy = new Map(transactions.filter(t => t.replaces).map(t => [t.replaces, t.id]));
  for (const t of transactions) if (replacedBy.has(t.id)) t.replacedBy = replacedBy.get(t.id);
  // Staff see their own orders' history plus what the other staff members did (not admin-only changes).
  const staffIds = new Set((await all("SELECT id FROM users WHERE role <> 'admin'")).map(u => u.id));
  const activity = (await all('SELECT time, actor, entity, text, user_id, demo FROM activity ORDER BY time DESC, seq DESC LIMIT 2000'))
    .filter(a => admin || a.user_id === me.id || a.actor === me.name || ownEntity(a.entity) || staffIds.has(a.user_id))
    .map(a => ({ time: a.time, actor: a.actor, entity: a.entity, text: a.text, ...(a.demo ? { demo: true } : {}) }));
  const inventory = await loadAllInventory();

  return {
    db: { ...await kvGet<Row>('settings', {}), orders: visible, inventory, transactions, activity, role: admin ? 'Admin' : 'Staff' },
    tracker: admin ? await kvGet<Row[]>('tracker', []) : [],
    rope: await kvGet<Row>('rope', null),
    people: await people(),
    revision: Number(await kvGet('revision', 0)),
  };
}

/** Names that can be assigned work: active staff accounts plus anyone already assigned in an order. */
export async function people(): Promise<string[]> {
  const staff = (await all(`SELECT name FROM users WHERE role='staff' AND status<>'disabled' ORDER BY name`)).map(r => r.name as string);
  const assigned = (await orderRows()).flatMap(r => (JSON.parse(r.data).processes || []).map((p: Process) => p.assigned)).filter(Boolean) as string[];
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

async function saveOrder(o: Order, actor: string, version: number) {
  const { _version, ...data } = o as Order & { _version?: number };
  await run('UPDATE orders SET data=?, version=?, updated_at=?, updated_by=? WHERE id=?', JSON.stringify(data), version, now(), actor, o.id);
}

const ddmmyy = (iso: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(iso || '')) ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(2, 4)}` : '');
/** One Master production row per product line, with material status from what was issued on creation. */
export function trackerRowsFor(o: Order): Row[] {
  const issued: Row[] = Array.isArray(o.materialsIssued) ? o.materialsIssued as Row[] : [];
  const has = (m: string) => issued.some(x => x.material === m), short = (m: string) => issued.some(x => x.material === m && x.short);
  const anyShort = issued.some(x => x.short);
  const lines: Row[] = o.items?.length ? o.items : [{ sku: '', name: o.product, qty: o.qty }];
  return lines.map(it => {
    const fabric = num(it.fabricRequired) > 0 || !!it.fabricCode, rope = num(it.ropeRequired) > 0 || !!it.ropeCode, tile = !!it.tableTop;
    return {
      orderDate: ddmmyy(o.orderDate), commencement: '', orderNo: o.id, client: o.client, sku: it.sku || '', product: it.name || o.product, qty: num(it.qty) || 1, deadline: ddmmyy(o.deadline),
      fabricRequired: fabric ? 'Yes' : 'No', fabricStatus: !fabric ? 'Not Required' : has('Fabric') && !short('Fabric') ? 'Received' : 'Pending',
      ropeRequired: rope ? 'Yes' : 'No', ropeStatus: !rope ? 'Not Required' : has('Rope') && !short('Rope') ? 'Received' : 'Pending',
      foamRequired: fabric ? 'Yes' : 'No', foamStatus: fabric ? 'Pending' : 'Not Required',
      tileRequired: tile ? 'Yes' : 'No', tileStatus: tile ? 'Pending' : 'Not Required',
      metalRequired: 'Yes', metalStatus: 'Pending',
      structureStatus: 'Not Started', structureQca: '', powderStatus: 'Not Started', powderQca: '',
      weavingStatus: rope ? 'Not Started' : 'Not Required', weavingQca: '',
      upholsteryStatus: fabric ? 'Not Started' : 'Not Required', upholsteryQca: '',
      tileProductionStatus: tile ? 'Not Started' : 'Not Required',
      currentStatus: issued.length && !anyShort ? 'In Production' : 'Waiting for Material',
      procurementDelay: anyShort ? 'Material Order Delay' : 'On Track', deadlineDelay: '', completion: 0, notes: '', rework: '',
    };
  });
}

export async function createOrder(me: Me, input: Order) {
  validateOrder(input);
  if (!/^UM-\d{3,6}$/.test(input.id)) throw new HttpError(400, 'Order numbers look like UM-1049.');
  const o = await extractImages(clone(input));
  delete (o as Row)._version;
  o.createdBy = me.name;
  o.createdAt = o.createdAt || now();
  return tx(async () => {
    const r = await run('INSERT INTO orders (id, data, version, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING', o.id, JSON.stringify(o), 1, now(), now(), me.name);
    if (r.changes !== 1) throw new HttpError(409, `Order ${o.id} already exists.`);
    // Master production rows are built here too, so they exist whoever created the order.
    const locked = await get(`SELECT value FROM kv WHERE key='tracker' FOR UPDATE`);
    const tracker: Row[] = locked ? JSON.parse(locked.value) : [];
    if (!tracker.some(r => r.orderNo === o.id)) await kvSet('tracker', [...trackerRowsFor(o), ...tracker]);
    await bumpRevision();
    return { ...o, _version: 1 };
  });
}

/**
 * Update an order. Admins replace the whole record. Staff may only change their own processes
 * (progress, steps, QC, job sheet) and product photos; everything else must stay as stored.
 * baseVersion guards against overwriting someone else's newer change.
 */
export async function updateOrder(me: Me, id: string, input: Order, baseVersion: number) {
  validateOrder(input);
  if (input.id !== id) throw new HttpError(400, 'Order ID cannot change.');
  const incoming = await extractImages(clone(input));
  return tx(async () => {
    const row = await get('SELECT data, version FROM orders WHERE id=? FOR UPDATE', id);
    if (!row) throw new HttpError(404, 'Order not found.');
    const stored: Order = JSON.parse(row.data);
    if (!isAdmin(me) && !canAccess(stored, me.name)) throw new HttpError(404, 'Order not found.');
    if (Number(baseVersion) !== row.version) throw new HttpError(409, 'This order was changed by someone else. The latest version has been loaded.', 'conflict');
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
    await saveOrder(next, me.name, row.version + 1);
    await bumpRevision();
    return isAdmin(me) ? { ...next, _version: row.version + 1 } : { ...staffView(next, me.name), _version: row.version + 1 };
  });
}

function mergeStaffChanges(me: Me, stored: Order, incoming: Order): Order {
  const next = clone(stored);
  const ignore = new Set(['processes', 'items', 'photoData', 'updatedBy', 'updatedAt', 'stage', 'dispatch', 'address', '_version']);
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
  // Dispatch: staff may record or update the dispatch of an order that is ready for it, and complete it afterwards.
  if (!same(stored.dispatch, incoming.dispatch) || stored.stage !== incoming.stage || !same(stored.address, incoming.address)) {
    const dispatchStages = ['Ready for dispatch', 'Dispatched', 'Completed'];
    const target = incoming.stage ?? stored.stage;
    if (!dispatchStages.includes(String(stored.stage)) || !dispatchStages.includes(String(target)) || (target === 'Ready for dispatch' && stored.stage !== 'Ready for dispatch')) {
      if (stored.stage !== incoming.stage || !same(stored.dispatch, incoming.dispatch)) throw new HttpError(403, 'Staff can only record dispatch for orders that are ready for dispatch.');
    }
    if (incoming.dispatch && typeof incoming.dispatch === 'object') next.dispatch = incoming.dispatch;
    if (incoming.address !== undefined) next.address = String(incoming.address).slice(0, 1000);
    next.stage = target;
  }
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

const loadInventory = async (name: string, lock = false) => JSON.parse((await get(`SELECT data FROM inventory WHERE name=?${lock ? ' FOR UPDATE' : ''}`, name))?.data ?? 'null');
const loadAllInventory = async () => { const out = []; for (const n of CATEGORIES) { const i = await loadInventory(n); if (i) out.push(i); } return out; };
const saveInventory = (item: Row) => run('INSERT INTO inventory (name, data) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data', item.name, JSON.stringify(item));

export async function addTransaction(me: Me, input: Row) {
  const material = String(input?.material || ''), type = String(input?.type || 'Incoming'), qty = num(input?.qty);
  if (!(CATEGORIES as readonly string[]).includes(material)) throw new HttpError(400, 'Inventory category must be Rope, Fabric or Powder Color.');
  if (!TX_TYPES.includes(type)) throw new HttpError(400, 'Unknown transaction type.');
  if (type === 'Adjustment' ? !(qty !== 0 && Math.abs(qty) <= 1e7) : !(qty > 0 && qty <= 1e7)) throw new HttpError(400, 'Quantity must be more than zero.');
  const order = input.order && input.order !== '—' ? String(input.order) : '—';
  if (order !== '—') {
    const o = await get('SELECT data FROM orders WHERE id=?', order);
    if (!o || (!isAdmin(me) && !canAccess(JSON.parse(o.data), me.name))) throw new HttpError(403, 'You can only link entries to your own orders.');
  }
  const str = (v: unknown, max = 120) => String(v ?? '').trim().slice(0, max);
  const t = {
    id: /^[\w-]{3,40}$/.test(String(input.id || '')) ? String(input.id) : `TX-${Date.now()}`,
    material, type, qty, unit: material === 'Powder Color' ? 'kg' : 'm',
    color: material === 'Rope' ? str(input.color) : '', sku: material === 'Rope' ? str(input.sku) : '', mm: material === 'Rope' ? str(input.mm, 20) : '',
    company: material === 'Fabric' ? str(input.company) : '', code: material === 'Fabric' ? str(input.code, 60) : '', colorName: material === 'Powder Color' ? str(input.colorName) : '',
    order, job: str(input.job || '—', 40), staff: me.name, enteredBy: me.name, date: /^\d{4}-\d{2}-\d{2}$/.test(String(input.date)) ? input.date : now().slice(0, 10),
    notes: str(input.notes, 500),
  };
  if (material === 'Rope' && type === 'Incoming' && (!t.sku || !t.color || !t.mm)) throw new HttpError(400, 'Rope entries need colour, SKU and MM.');
  if (material === 'Fabric' && type === 'Incoming' && !t.company) throw new HttpError(400, 'Fabric entries need a company.');
  if (material === 'Powder Color' && type === 'Incoming' && !t.colorName) throw new HttpError(400, 'Powder Color entries need a colour name.');
  return tx(async () => {
    if (await get('SELECT 1 FROM transactions WHERE id=?', t.id)) t.id = `TX-${Date.now()}-${crypto.randomInt(1000)}`;
    // Editing an entry: the original stays in the ledger; its effect is reversed and the corrected entry posted.
    if (input.replaces) {
      const orig = await get('SELECT data, user_id FROM transactions WHERE id=? FOR UPDATE', String(input.replaces));
      if (!orig) throw new HttpError(404, 'The entry being edited was not found.');
      const o = JSON.parse(orig.data);
      if (!isAdmin(me) && orig.user_id !== me.id && o.enteredBy !== me.name) throw new HttpError(403, 'Staff can only edit entries they made.');
      if (await get(`SELECT 1 FROM transactions WHERE data LIKE ?`, `%"replaces":"${String(input.replaces).replace(/[%_"]/g, '')}"%`)) throw new HttpError(409, 'This entry was already edited. Reload to see the latest version.');
      if (o.material !== material) throw new HttpError(400, 'An edit cannot change the inventory category.');
      await applyTransaction(o, -1);
      Object.assign(t, { replaces: o.id, order: o.order, job: o.job, editedBy: me.name, editedAt: now(), reason: str(input.reason, 300) });
    }
    await applyTransaction(t);
    await run('INSERT INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,?,?)', t.id, JSON.stringify(t), me.id, 0, now());
    await bumpRevision();
    return { transaction: t, inventory: await loadAllInventory(), rope: await kvGet('rope', null) };
  });
}

/** Posts a ledger movement: rope purchases/issues go to the rope workbook, everything else to the category totals. */
export async function applyTransaction(t: Row, sign: 1 | -1 = 1) {
  if (t.material === 'Rope' && t.sku && (t.type === 'Incoming' || t.type === 'Outward' || t.type === 'Adjustment')) {
    const locked = await get(`SELECT value FROM kv WHERE key='rope' FOR UPDATE`);
    const rope = (locked ? JSON.parse(locked.value) : null) || { stock_master: [], purchase_log: [], outward_log: [] };
    const eq = (a: unknown, b: unknown) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const masters = rope.stock_master || (rope.stock_master = []);
    const size = (v: unknown) => String(v ?? '').trim().replace(/\s*mm$/i, '').trim().toLowerCase();
    let row = masters.find((r: Row) => eq(r['Rope Type (SKU)'], t.sku) && size(r.mm) === size(t.mm) && eq(r.Color, t.color));
    if (!row) { row = { 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Opening Stock (m)': '0', 'Total Purchased (m)': '0', 'Total Outward (m)': '0', 'Current Balance (m)': '0', '': '' }; masters.push(row); }
    const purchased = num(row['Total Purchased (m)']), outward = num(row['Total Outward (m)']);
    const current = row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null ? num(row['Opening Stock (m)']) + purchased - outward : num(row['Current Balance (m)']);
    const date = new Date(`${t.date}T12:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const q = sign * t.qty, note = sign < 0 ? 'Correction: entry edited' : '';
    if (t.type === 'Adjustment') {
      // A stock count correction for this rope: only the balance changes.
      row['Current Balance (m)'] = String(current + q);
    } else if (t.type === 'Incoming') {
      row['Total Purchased (m)'] = String(purchased + q);
      row['Current Balance (m)'] = String(current + q);
      if (sign > 0) (rope.purchase_log ||= []).unshift({ Date: date, 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Qty Purchased (m)': String(t.qty), Supplier: '', 'Invoice/Bill No.': '', 'Rate (per m)': '', Remarks: t.notes || `Entered by ${t.enteredBy}` });
    } else {
      row['Total Outward (m)'] = String(outward + q);
      row['Current Balance (m)'] = String(current - q);
      if (sign > 0 || note) (rope.outward_log ||= []).unshift(sign < 0 ? { Date: date, 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Qty Out (m)': String(q), 'Issued To': t.enteredBy, 'Used For (Job/Product)': t.order, Remarks: note } : { Date: date, 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Qty Out (m)': String(t.qty), 'Issued To': t.enteredBy, 'Used For (Job/Product)': t.order, Remarks: t.notes || '' });
    }
    await kvSet('rope', rope);
    return;
  }
  const inv = await loadInventory(t.material, true) || { name: t.material, unit: t.unit, opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0 };
  const q = sign * t.qty;
  if (t.type === 'Incoming') inv.incoming += q;
  else if (t.type === 'Outward' || t.type === 'Consumption') inv.consumed += q;
  else if (t.type === 'Wastage') inv.wastage += q;
  else inv.adjustments += q;
  await saveInventory(inv);
}

/* ---------- Activity (append-only; the actor is always the signed-in user) ---------- */

export async function addActivity(me: Me, entries: Row[]) {
  if (!Array.isArray(entries) || entries.length > 50) throw new HttpError(400, 'Send up to 50 activity entries at a time.');
  const visible = isAdmin(me) ? null : new Set((await orderRows()).map(parseOrder).filter(o => canAccess(o, me.name)).map(o => o.id));
  return tx(async () => {
    for (const e of entries) {
      const entity = String(e?.entity || '').slice(0, 60), text = String(e?.text || '').slice(0, 500);
      if (!entity || !text) continue;
      if (visible && /^(UM-|JOB-)/.test(entity)) {
        const orderId = entity.startsWith('JOB-') ? `UM-${entity.split('-')[1]}` : entity;
        if (!visible.has(orderId)) throw new HttpError(403, 'You can only record activity on your own orders.');
      }
      const actor = e?.actor === 'System' ? 'System' : me.name;
      await run('INSERT INTO activity (time, actor, entity, text, user_id) VALUES (?,?,?,?,?)', now(), actor, entity, text, me.id);
    }
    await bumpRevision();
  });
}

/* ---------- Admin-only workspace data ---------- */

export async function putSettings(me: Me, settings: Row) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can change workspace settings.');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new HttpError(400, 'Settings must be an object.');
  const clean = Object.fromEntries(Object.entries(settings).filter(([k]) => !RESERVED_KEYS.has(k)));
  if (JSON.stringify(clean).length > 200_000) throw new HttpError(413, 'Settings are too large.');
  await kvSet('settings', clean);
  await bumpRevision();
  return clean;
}

export async function putTracker(me: Me, rows: Row[]) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can edit the production tracker.');
  if (!Array.isArray(rows)) throw new HttpError(400, 'Tracker must be a list of rows.');
  await kvSet('tracker', rows);
  await bumpRevision();
}

export async function clearDemo(me: Me) {
  if (!isAdmin(me)) throw new HttpError(403, 'Only admins can remove demo entries.');
  await tx(async () => {
    for (const r of await all('SELECT data FROM transactions WHERE demo=1')) {
      const t = JSON.parse(r.data);
      if (t.material === 'Rope') continue;
      const inv = await loadInventory(t.material, true);
      if (inv) { inv.incoming = Math.max(0, inv.incoming - num(t.qty)); await saveInventory(inv); }
    }
    await run('DELETE FROM transactions WHERE demo=1');
    await run('DELETE FROM activity WHERE demo=1');
    for (const r of await orderRows()) {
      const o = JSON.parse(r.data);
      if (o.createdByDemo) { o.createdBy = 'Admin'; delete o.createdByDemo; await run('UPDATE orders SET data=? WHERE id=?', JSON.stringify(o), o.id); }
    }
    await bumpRevision();
  });
}

/* ---------- One-time removal of the old sample workspace ---------- */

// Databases seeded before live use got a sample workspace: six sample orders, sample stock figures, three sample
// ledger entries, four sample activity entries and demo-flagged staff entries. Exactly those are removed once.
// Anything entered by the team stays, including entries recorded against a sample order.
const SAMPLE_ORDERS: Record<string, string> = { 'UM-1048': 'Casa Forma', 'UM-1047': 'The June House', 'UM-1046': 'Studio North', 'UM-1045': 'Nook & Nest', 'UM-1044': 'Atelier One', 'UM-1043': 'Morrow Living' };
const SAMPLE_TX: Record<string, string> = { 'TX-208': 'Cotton rope delivery', 'TX-207': 'Ivory boucle', 'TX-206': 'Arlo side table batch' };
const SAMPLE_ACTIVITY = [
  ['2026-10-08T10:42:00', 'Amit Shah', 'JOB-1048-ROP', 'Rope Work updated to 48%'],
  ['2026-10-08T09:55:00', 'Rahul Mehta', 'JOB-1048-IRN', 'Iron Work marked completed'],
  ['2026-10-07T16:20:00', 'System', 'UM-1048', 'Order production progress recalculated'],
  ['2026-10-07T11:05:00', 'Shubham Jain', 'UM-1044', 'Order marked ready for dispatch'],
];
const SAMPLE_STOCK: Record<string, Record<string, number>> = { Rope: { opening: 280, incoming: 32, reserved: 152, consumed: 96, wastage: 3, reorder: 70 }, Fabric: { opening: 420, incoming: 75, reserved: 116, consumed: 120, wastage: 4, reorder: 100 } };

export async function removeSampleData() {
  return tx(async () => {
    await get('SELECT pg_advisory_xact_lock(727004)');
    if (await get('SELECT 1 FROM kv WHERE key=?', 'sampleDataRemovedV1')) return null;
    const removed = { orders: 0, entries: 0, activity: 0 };
    if (await get('SELECT 1 FROM kv WHERE key=?', 'seeded')) {
      for (const [id, client] of Object.entries(SAMPLE_ORDERS)) {
        const row = await get('SELECT data FROM orders WHERE id=?', id);
        if (row && JSON.parse(row.data).client === client) { await run('DELETE FROM orders WHERE id=?', id); removed.orders++; }
      }
      // Sample stock figures (the seed wrote them straight into the totals) and the demo incoming entries added to them.
      for (const [name, base] of Object.entries(SAMPLE_STOCK)) {
        const inv = await loadInventory(name, true);
        if (!inv) continue;
        for (const k of ['opening', 'incoming', 'reserved', 'consumed', 'wastage']) inv[k] = Math.round((num(inv[k]) - base[k]) * 1000) / 1000;
        if (num(inv.reorder) === base.reorder) inv.reorder = 0;
        await saveInventory(inv);
      }
      for (const r of await all('SELECT data FROM transactions WHERE demo=1')) {
        const t = JSON.parse(r.data);
        if (t.material === 'Rope' || t.type !== 'Incoming') continue;
        const inv = await loadInventory(t.material, true);
        if (inv) { inv.incoming = Math.round((num(inv.incoming) - num(t.qty)) * 1000) / 1000; await saveInventory(inv); }
      }
      removed.entries += (await run('DELETE FROM transactions WHERE demo=1')).changes;
      removed.activity += (await run('DELETE FROM activity WHERE demo=1')).changes;
      // The four sample activity rows and three sample ledger entries were stored as ordinary rows; the append-only
      // guard is lifted only inside this transaction, only to delete those exact rows.
      const txIds: string[] = [];
      for (const [id, notes] of Object.entries(SAMPLE_TX)) { const r = await get('SELECT data FROM transactions WHERE id=?', id); if (r && JSON.parse(r.data).notes === notes) txIds.push(id); }
      const acts: number[] = [];
      for (const [time, actor, entity, text] of SAMPLE_ACTIVITY) for (const r of await all('SELECT seq FROM activity WHERE time=? AND actor=? AND entity=? AND text=?', time, actor, entity, text)) acts.push(Number(r.seq));
      if (txIds.length || acts.length) {
        await run('ALTER TABLE transactions DISABLE TRIGGER transactions_append_only');
        await run('ALTER TABLE activity DISABLE TRIGGER activity_append_only');
        for (const id of txIds) removed.entries += (await run('DELETE FROM transactions WHERE id=?', id)).changes;
        for (const seq of acts) removed.activity += (await run('DELETE FROM activity WHERE seq=?', seq)).changes;
        await run('ALTER TABLE transactions ENABLE TRIGGER transactions_append_only');
        await run('ALTER TABLE activity ENABLE TRIGGER activity_append_only');
      }
      await bumpRevision();
    }
    await kvSet('sampleDataRemovedV1', JSON.stringify({ at: now(), ...removed }));
    return removed;
  });
}

/* ---------- First-run seed from the exported workspace snapshot ---------- */

export async function seedWorkspace(snapshot: Row, rope: Row, tracker: Row[]) {
  return tx(async () => {
    // Only the first server instance to get here seeds; others wait for it, then see the marker.
    await get('SELECT pg_advisory_xact_lock(727002)');
    if (await get('SELECT 1 FROM kv WHERE key=?', 'seeded')) return false;
    const ops = snapshot.ordersAndOperations || {};
    for (const o of ops.orders || []) {
      const data = await extractImages(o);
      await run('INSERT INTO orders (id, data, version, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING', o.id, JSON.stringify(data), 1, o.createdAt || now(), now(), o.createdBy || 'System');
    }
    const inv = ops.inventory || [];
    for (const name of CATEGORIES) {
      const found = inv.find((i: Row) => i.name === name);
      await saveInventory(found || { name, unit: name === 'Powder Color' ? 'kg' : 'm', opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0 });
    }
    for (const t of [...(ops.transactions || [])].reverse()) {
      await run('INSERT INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,?,?) ON CONFLICT (id) DO NOTHING', t.id, JSON.stringify(t), null, t.demo ? 1 : 0, now());
    }
    for (const a of [...(ops.activity || [])].reverse()) {
      await run('INSERT INTO activity (time, actor, entity, text, user_id, demo) VALUES (?,?,?,?,?,?)', a.time, a.actor, a.entity, a.text, null, a.demo || String(a.text).startsWith('DEMO · ') ? 1 : 0);
    }
    const { orders: _o, inventory: _i, transactions: _t, activity: _a, role: _r, ...settings } = ops;
    // The dashboard adds its own sample entries when these flags are missing; the server owns that data now.
    await kvSet('settings', { ...settings, sampleAuditEventsAdded: true, staffDemoV2: true, inventoryUnitMigrationV1: true });
    await kvSet('rope', rope);
    await kvSet('tracker', tracker);
    await kvSet('seeded', now());
    // Whatever was seeded here was asked for (live: nothing but the tracker and rope workbook; tests: a fixture),
    // so the one-time sample clean-up below must not touch it.
    await kvSet('sampleDataRemovedV1', now());
    await bumpRevision();
    return true;
  });
}
