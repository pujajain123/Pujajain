/**
 * Spreadsheet importer: CSV exports of the current Google Sheets → normalised database.
 *
 *   npm run import -- --orders orders.csv [--master master.csv] [--jobs jobs.csv]
 *                     [--rope rope.csv] [--fabric fabric.csv] [--mapping config/import-mapping.json] [--dry-run]
 *
 * Column headers are configured in config/import-mapping.json (see docs/DATA_MAPPING.md).
 * Everything runs in one transaction: a --dry-run (or any error) leaves the database untouched.
 * Imported records go through the same services as the app, so the audit trail records the import.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db, get, insert, run, tx } from '../db.ts';
import { bootstrap } from '../bootstrap.ts';
import { hashPassword, type AuthUser } from '../auth.ts';
import { createOrder } from '../services/orderOps.ts';
import { postTxn } from '../services/inventory.ts';
import { logActivity } from '../services/activity.ts';
import { nowIso, today } from '../lib.ts';
import { ORDER_STAGES, type OrderStage } from '../../shared/domain.ts';
import { parseCsv, parseDate, num, pick } from './csv.ts';

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes('--dry-run');
const mapping = JSON.parse(fs.readFileSync(opt('mapping') ?? 'config/import-mapping.json', 'utf8'));
const dateFmt: string = mapping.date_format ?? 'DD/MM/YYYY';
const read = (f?: string) => (f ? parseCsv(fs.readFileSync(f, 'utf8')) : []);

db();
bootstrap();
const report: string[] = [];
const warn = (m: string) => report.push(`⚠ ${m}`);

const importer =
  get(`SELECT u.id, u.name, u.email, r.key AS role, u.primary_process_id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='admin' ORDER BY u.id LIMIT 1`) ??
  (() => {
    const id = insert(
      `INSERT INTO users (name, email, password_hash, role_id) VALUES ('Admin','admin@umami.studio',?,(SELECT id FROM roles WHERE key='admin'))`,
      hashPassword(crypto.randomBytes(9).toString('base64url')),
    );
    warn('No admin existed — created admin@umami.studio with a random password; reset it with the Staff screen or the seed.');
    return { id, name: 'Admin', email: 'admin@umami.studio', role: 'admin', primary_process_id: null };
  })();
const actor = importer as AuthUser;

const proc = (raw: string) => {
  const key = mapping.process_map[raw.trim().toLowerCase()];
  return key ? get<{ id: number; key: string }>('SELECT id, key FROM job_processes WHERE key=?', key) : undefined;
};

function staffId(name: string | undefined, processId: number | null): number | null {
  if (!name?.trim()) return null;
  const existing = get<{ id: number }>('SELECT id FROM users WHERE lower(name)=lower(?)', name.trim());
  if (existing) return existing.id;
  const email = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.')}@umami.studio`;
  const id = insert(
    `INSERT INTO users (name, email, password_hash, role_id, primary_process_id) VALUES (?,?,?,(SELECT id FROM roles WHERE key='staff'),?)`,
    name.trim(),
    email,
    hashPassword(crypto.randomBytes(9).toString('base64url')),
    processId,
  );
  report.push(`+ staff user ${name} (${email}) — set a password in Staff`);
  return id;
}

function materialFor(category: 'rope' | 'fabric', row: Record<string, string>) {
  const m = mapping.stock;
  const name = pick(row, m.name);
  if (!name) return;
  const code = pick(row, m.code) || `${category.toUpperCase()}-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 24)}`;
  let id = get<{ id: number }>('SELECT id FROM materials WHERE code=? OR lower(name)=lower(?)', code, name)?.id;
  if (!id) {
    id = insert(
      'INSERT INTO materials (code, name, category, variant, color, unit, reorder_level, supplier, location) VALUES (?,?,?,?,?,?,?,?,?)',
      code, name, category, pick(row, m.variant) || null, pick(row, m.color) || null,
      pick(row, m.unit) || (category === 'rope' ? 'kg' : 'm'), num(pick(row, m.reorder_level)) ?? 0, pick(row, m.supplier) || null, pick(row, m.location) || null,
    );
    report.push(`+ material ${name}`);
  }
  const q = num(pick(row, m.quantity));
  if (q && q > 0) postTxn({ materialId: id, type: 'opening', quantity: q, userId: actor.id, reference: 'SHEET-IMPORT', notes: `Opening balance from ${category} stock sheet` });
  return id;
}

try {
  tx(() => {
    // 1. Stock sheets → materials + opening balances
    for (const cat of ['rope', 'fabric'] as const) for (const row of read(opt(cat))) materialFor(cat, row);

    // 2. Orders (+ master production columns joined on order code)
    const om = mapping.orders;
    const master = new Map(read(opt('master')).map((r) => [pick(r, mapping.master_production.order_code), r]));
    const jobRows = read(opt('jobs'));
    const jm = mapping.jobs;
    for (const row of read(opt('orders'))) {
      const code = pick(row, om.order_code);
      if (!code) continue;
      if (get('SELECT 1 FROM orders WHERE code=?', code)) {
        warn(`${code} already exists — skipped`);
        continue;
      }
      const mp = master.get(code) ?? {};
      const clientName = pick(row, om.client);
      if (!clientName) {
        warn(`${code}: no client — skipped`);
        continue;
      }
      let customerId = get<{ id: number }>('SELECT id FROM customers WHERE lower(name)=lower(?)', clientName)?.id;
      if (!customerId)
        customerId = insert(
          'INSERT INTO customers (name, contact_person, phone, email, address, city) VALUES (?,?,?,?,?,?)',
          clientName, pick(row, om.contact_person) || null, pick(row, om.phone) || null, pick(row, om.email) || null, pick(row, om.address) || null, pick(row, om.city) || null,
        );
      const productName = pick(row, om.product) || 'Unspecified product';
      let productId = get<{ id: number }>('SELECT id FROM products WHERE lower(name)=lower(?)', productName)?.id;
      if (!productId) {
        productId = insert('INSERT INTO products (sku, name) VALUES (?,?)', `IMP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, productName);
        report.push(`+ product ${productName} — review its processes in Settings → Products`);
      }
      const orderDate = parseDate(pick(row, om.order_date), dateFmt) ?? today();
      const deadline = parseDate(pick(mp, mapping.master_production.deadline) || pick(row, om.deadline), dateFmt);
      if (!deadline) {
        warn(`${code}: no valid deadline — skipped`);
        continue;
      }
      const qty = Math.round(num(pick(row, om.quantity)) ?? 0);
      if (qty <= 0) {
        warn(`${code}: quantity missing — skipped`);
        continue;
      }
      const myJobs = jobRows.filter((j) => pick(j, jm.order_code) === code);
      const processes = (myJobs.length ? myJobs : ['iron', 'rope', 'fabric'].map((p) => ({ [jm.process]: p })))
        .map((j) => ({ j, p: proc(pick(j, jm.process)) }))
        .filter((x) => x.p);
      const prio = (pick(row, om.priority) || 'normal').toLowerCase();
      const orderId = createOrder(
        {
          customer_id: customerId,
          po_number: pick(row, om.po_number) || null,
          source: pick(row, om.source) || 'Imported from Google Sheets',
          order_date: orderDate,
          priority: (['low', 'normal', 'high', 'urgent'].includes(prio) ? prio : 'normal') as any,
          notes: pick(row, om.notes) || null,
          sky_date: parseDate(pick(mp, mapping.master_production.sky_date) || pick(row, om.sky_date), dateFmt),
          deadline: deadline < orderDate ? orderDate : deadline,
          delivery_address: pick(row, om.address) || null,
          items: [
            {
              product_id: productId,
              quantity: qty,
              dimensions: pick(row, om.dimensions) || null,
              color: pick(row, om.color) || null,
              finish: pick(row, om.finish) || null,
              specifications: pick(row, om.specifications) || null,
              processes: processes.map(({ j, p }) => ({
                process_id: p!.id,
                assigned_to: staffId(pick(j, jm.staff), p!.id),
                start_date: parseDate(pick(j, jm.start_date), dateFmt),
                due_date: parseDate(pick(j, jm.due_date), dateFmt),
                specs: Object.fromEntries(Object.entries(jm.specs as Record<string, string>).map(([k, h]) => [k, pick(j, h)]).filter(([, v]) => v)),
              })),
              materials: processes
                .map(({ j, p }) => {
                  const mName = pick(j, jm.material);
                  const req = num(pick(j, jm.material_required));
                  const mid = mName ? get<{ id: number }>('SELECT id FROM materials WHERE lower(name)=lower(?) OR lower(code)=lower(?)', mName, mName)?.id : undefined;
                  if (mName && !mid) warn(`${code}: material "${mName}" not found in stock sheets`);
                  return mid && req ? { process_id: p!.id, material_id: mid, required_qty: req } : null;
                })
                .filter(Boolean) as any,
            },
          ],
        },
        actor,
        { code },
      );
      for (const { p } of processes) run('INSERT OR IGNORE INTO product_processes (product_id, process_id) VALUES (?,?)', productId, p!.id);
      // Job progress from the job sheet (direct, so historic sheet data is not re-validated against today's rules).
      for (const { j, p } of processes) {
        const done = Math.min(qty, Math.max(0, Math.round(num(pick(j, jm.completed_qty)) ?? 0)));
        const st = mapping.job_status_map[(pick(j, jm.status) || '').toLowerCase()] ?? (done >= qty ? 'completed' : done > 0 ? 'in_progress' : 'not_started');
        run(
          `UPDATE jobs SET completed_qty=?, status=?, notes=?, started_at=CASE WHEN ?>0 THEN ? END, completed_at=CASE WHEN ?='completed' THEN ? END WHERE order_id=? AND process_id=?`,
          st === 'completed' ? qty : done, st, pick(j, jm.notes) || null, done, nowIso(), st, nowIso(), orderId, p!.id,
        );
        const used = num(pick(j, jm.material_used));
        const req = get<{ material_id: number }>('SELECT material_id FROM material_requirements WHERE order_id=? AND process_id=?', orderId, p!.id);
        if (used && req) postTxn({ materialId: req.material_id, type: 'consumption', quantity: used, orderId, userId: actor.id, reference: 'SHEET-IMPORT', notes: 'Consumption to date (from job sheet)' });
      }
      // Lifecycle stage from the sheet status.
      const statusText = (pick(mp, mapping.master_production.status) || pick(row, om.status) || '').toLowerCase();
      const stage = (mapping.status_map[statusText] ?? 'received') as OrderStage;
      if (!ORDER_STAGES.includes(stage)) warn(`${code}: unknown status "${statusText}" — left as Order Received`);
      else if (stage !== 'received') {
        run('UPDATE orders SET stage=? WHERE id=?', stage, orderId);
        insert(
          `INSERT INTO order_status_history (order_id, from_stage, to_stage, event, note, changed_by, created_at) VALUES (?,?,?,?,?,?,?)`,
          orderId, 'received', stage, 'transition', `Imported with sheet status "${statusText}"`, actor.id, nowIso(),
        );
      }
      logActivity({ actorId: actor.id, entityType: 'order', entityId: orderId, orderId, action: 'import', message: `Order ${code} imported from Google Sheets (status "${statusText || 'n/a'}")` });
      report.push(`+ order ${code} · ${clientName} · ${productName} × ${qty} · ${stage}`);
    }
    if (dryRun) throw new Error('__dry_run__');
  });
  console.log(report.join('\n') || 'Nothing to import — pass --orders/--jobs/--rope/--fabric CSV files.');
  console.log('\nImport committed.');
} catch (e: any) {
  console.log(report.join('\n'));
  if (e.message === '__dry_run__') console.log('\nDry run — nothing was written. Re-run without --dry-run to import.');
  else {
    console.error('\nImport failed, nothing was written:', e.message);
    process.exitCode = 1;
  }
}
