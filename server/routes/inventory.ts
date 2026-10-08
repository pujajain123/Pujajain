import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, run, tx } from '../db.ts';
import { TXN_TYPES } from '../../shared/domain.ts';
import { badRequest, conflict, forbidden, h, intId, notFound, parse, today } from '../lib.ts';
import { requireRole, isAdmin } from '../auth.ts';
import { broadcast } from '../live.ts';
import { autoAllocateMaterial, ledger, postTxn, stock } from '../services/inventory.ts';
import { logActivity, logFieldChanges } from '../services/activity.ts';
import { refreshAlerts } from '../services/notifications.ts';

import ropeBook from '../data/rope-workbook.json' with { type: 'json' };

const r = Router();

/** The imported rope workbook as it was in Google Sheets, plus the consistency checks found on import. */
r.get(
  '/rope-workbook',
  h(() => {
    const book = ropeBook as any;
    const n = (v: string) => Number(v || 0);
    const master = book.stock_master.filter((x: any) => (x['Rope Type (SKU)'] || x.mm || x.Color || '').trim());
    const sum = (k: string) => master.reduce((a: number, x: any) => a + n(x[k]), 0);
    const checks: string[] = [];
    const mism = master.filter((x: any) => x['Current Balance (m)'] !== '' && Math.abs(n(x['Opening Stock (m)']) + n(x['Total Purchased (m)']) - n(x['Total Outward (m)']) - n(x['Current Balance (m)'])) > 0.01);
    for (const x of mism) checks.push(`${x['Rope Type (SKU)']} ${x.mm} ${x.Color}: balance ${x['Current Balance (m)']} m but opening + purchased − outward = ${n(x['Opening Stock (m)']) + n(x['Total Purchased (m)']) - n(x['Total Outward (m)'])} m`);
    const blankBal = master.filter((x: any) => x['Current Balance (m)'] === '' && n(x['Opening Stock (m)']) > 0);
    for (const x of blankBal) checks.push(`${x['Rope Type (SKU)']} ${x.mm} ${x.Color}: ${x['Opening Stock (m)']} m opening stock but the balance cell is empty`);
    const noSku = master.filter((x: any) => !(x['Rope Type (SKU)'] || '').trim()).length;
    if (noSku) checks.push(`${noSku} stock rows have no rope type (SKU) — imported as "Unlabelled"`);
    const outLog = book.outward_log.reduce((a: number, x: any) => a + n(x['Qty Out (m)']), 0);
    const inLog = book.purchase_log.reduce((a: number, x: any) => a + n(x['Qty Purchased (m)']), 0);
    if (Math.abs(outLog - sum('Total Outward (m)')) > 0.01) checks.push(`Outward log totals ${outLog} m but the stock master's total outward is ${sum('Total Outward (m)')} m`);
    if (Math.abs(inLog - sum('Total Purchased (m)')) > 0.01) checks.push(`Purchase log totals ${inLog} m but the stock master's total purchased is ${sum('Total Purchased (m)')} m`);
    const undated = [...book.outward_log, ...book.purchase_log].filter((x: any) => !x.Date).length;
    if (undated) checks.push(`${undated} log entries have no date`);
    return {
      totals: { opening: sum('Opening Stock (m)'), purchased: sum('Total Purchased (m)'), outward: sum('Total Outward (m)'), balance: sum('Current Balance (m)'), low: master.filter((x: any) => n(x['Current Balance (m)']) < 100).length, rows: master.length },
      outward_log: book.outward_log,
      purchase_log: book.purchase_log,
      checks,
    };
  }),
);
const changed = () => {
  broadcast('inventory', 'orders', 'dashboard', 'activity');
  void refreshAlerts();
};

r.get(
  '/',
  h((req) => {
    const rows = stock({ category: req.query.category as string | undefined });
    const demand = all(
      `SELECT r.material_id, COUNT(DISTINCT r.order_id) AS open_orders FROM material_requirements r JOIN orders o ON o.id = r.order_id
       WHERE o.cancelled_at IS NULL AND o.stage NOT IN ('dispatched','completed') GROUP BY r.material_id`,
    );
    return rows.map((s) => ({ ...s, open_orders: demand.find((d) => d.material_id === s.material_id)?.open_orders ?? 0 }));
  }),
);

r.get(
  '/transactions',
  h((req) => {
    const q = req.query as Record<string, string | undefined>;
    const where = ['1=1'];
    const p: any[] = [];
    if (q.category) (where.push('m.category = ?'), p.push(q.category));
    if (q.type) (where.push('t.type = ?'), p.push(q.type));
    if (q.from) (where.push('t.txn_date >= ?'), p.push(q.from));
    if (q.to) (where.push('t.txn_date <= ?'), p.push(q.to));
    return all(
      `SELECT t.*, m.name AS material_name, m.code AS material_code, m.unit, m.category, u.name AS user_name, o.code AS order_code, j.code AS job_code
       FROM inventory_transactions t JOIN materials m ON m.id = t.material_id LEFT JOIN users u ON u.id = t.user_id
       LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN jobs j ON j.id = t.job_id
       WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT 300`,
      ...p,
    );
  }),
);

r.get(
  '/incoming',
  h(() =>
    all(
      `SELECT i.*, m.name AS material_name, m.unit, m.category, u.name AS created_by_name FROM material_incoming i JOIN materials m ON m.id = i.material_id
       LEFT JOIN users u ON u.id = i.created_by ORDER BY (i.status='pending') DESC, i.expected_date`,
    ),
  ),
);

r.get(
  '/materials/:id',
  h((req) => {
    const id = intId(req.params.id);
    const s = stock({ materialId: id })[0];
    if (!s) throw notFound('Material');
    const material = get('SELECT * FROM materials WHERE id=?', id);
    const orders = all(
      `SELECT o.id, o.code, o.stage, o.deadline, c.name AS customer, SUM(r.required_qty) AS required,
         COALESCE((SELECT SUM(CASE WHEN type='allocation' THEN quantity WHEN type IN ('release','consumption') THEN -quantity ELSE 0 END) FROM inventory_transactions t WHERE t.order_id=o.id AND t.material_id=?),0) AS reserved,
         COALESCE((SELECT SUM(quantity) FROM inventory_transactions t WHERE t.order_id=o.id AND t.material_id=? AND t.type='consumption'),0) AS consumed
       FROM material_requirements r JOIN orders o ON o.id = r.order_id JOIN customers c ON c.id = o.customer_id
       WHERE r.material_id = ? AND o.cancelled_at IS NULL GROUP BY o.id ORDER BY (o.stage IN ('dispatched','completed')), o.deadline`,
      id,
      id,
      id,
    ).map((o) => ({ ...o, reserved: Math.max(0, o.reserved), outstanding: Math.max(0, o.required - o.consumed) }));
    const incoming = all(`SELECT * FROM material_incoming WHERE material_id=? ORDER BY id DESC`, id);
    return { material, stock: s, ledger: ledger(id), orders, incoming };
  }),
);

const materialSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(120),
  category: z.enum(['rope', 'fabric']),
  variant: z.string().max(120).nullish(),
  color: z.string().max(60).nullish(),
  unit: z.enum(['kg', 'm', 'pcs']),
  reorder_level: z.number().nonnegative(),
  supplier: z.string().max(120).nullish(),
  location: z.string().max(120).nullish(),
  opening_stock: z.number().nonnegative().optional(),
});

r.post(
  '/materials',
  requireRole('admin'),
  h((req) => {
    const b = parse(materialSchema, req.body);
    if (get('SELECT 1 FROM materials WHERE code=?', b.code)) throw conflict('A material with this code already exists');
    const id = tx(() => {
      const id = insert(
        'INSERT INTO materials (code, name, category, variant, color, unit, reorder_level, supplier, location) VALUES (?,?,?,?,?,?,?,?,?)',
        b.code, b.name, b.category, b.variant ?? null, b.color ?? null, b.unit, b.reorder_level, b.supplier ?? null, b.location ?? null,
      );
      logActivity({ actorId: req.user!.id, entityType: 'material', entityId: id, action: 'create', message: `Material ${b.name} (${b.code}) added` });
      if (b.opening_stock) postTxn({ materialId: id, type: 'opening', quantity: b.opening_stock, userId: req.user!.id, notes: 'Opening stock' });
      return id;
    });
    changed();
    return { id };
  }),
);

r.patch(
  '/materials/:id',
  requireRole('admin'),
  h((req) => {
    const id = intId(req.params.id);
    const old = get('SELECT * FROM materials WHERE id=?', id);
    if (!old) throw notFound('Material');
    const b = parse(materialSchema.omit({ opening_stock: true, code: true }).partial().extend({ active: z.boolean().optional() }), req.body);
    const keys = Object.keys(b);
    if (!keys.length) return { ok: true };
    run(`UPDATE materials SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => { const v = (b as any)[k]; return typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null; }), id);
    logFieldChanges({ actorId: req.user!.id, entityType: 'material', entityId: id, label: `Material ${old.name}` }, old, b, {
      name: 'Name', variant: 'Variant', color: 'Colour', unit: 'Unit', reorder_level: 'Reorder level', supplier: 'Supplier', location: 'Location', active: 'Active',
    });
    changed();
    return { ok: true };
  }),
);

/** Staff may post consumption / wastage / incoming receipts; adjustments, opening and allocations are admin-only. */
const STAFF_TXN = ['consumption', 'wastage', 'incoming'];
r.post(
  '/transactions',
  h((req) => {
    const b = parse(
      z.object({
        material_id: z.number().int().positive(),
        type: z.enum(TXN_TYPES),
        quantity: z.number().positive('Quantity must be greater than zero'),
        order_id: z.number().int().positive().nullish(),
        job_id: z.number().int().positive().nullish(),
        reference: z.string().max(120).nullish(),
        notes: z.string().max(1000).nullish(),
        txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      req.body,
    );
    if (!isAdmin(req) && !STAFF_TXN.includes(b.type)) throw forbidden('Only an admin can post this type of stock movement');
    if (['allocation', 'release'].includes(b.type) && !b.order_id) throw badRequest('Choose the order for this allocation');
    if (b.type.startsWith('adjustment') && !b.notes?.trim()) throw badRequest('Adjustments need a reason in the notes');
    if (b.txn_date && b.txn_date > today()) throw badRequest('Transaction date cannot be in the future');
    if (b.job_id) {
      const j = get('SELECT order_id FROM jobs WHERE id=?', b.job_id);
      if (!j) throw badRequest('Job not found');
      b.order_id = j.order_id;
    }
    const id = tx(() => {
      const id = postTxn({
        materialId: b.material_id, type: b.type, quantity: b.quantity, orderId: b.order_id, jobId: b.job_id,
        userId: req.user!.id, reference: b.reference, notes: b.notes, date: b.txn_date,
      });
      if (b.type === 'incoming' || b.type === 'adjustment_in') autoAllocateMaterial(b.material_id);
      return id;
    });
    changed();
    return { id };
  }),
);

r.post(
  '/incoming',
  h((req) => {
    const b = parse(
      z.object({
        material_id: z.number().int().positive(),
        quantity: z.number().positive(),
        supplier: z.string().max(120).nullish(),
        expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
        reference: z.string().max(120).nullish(),
      }),
      req.body,
    );
    const m = get('SELECT name, unit FROM materials WHERE id=?', b.material_id);
    if (!m) throw badRequest('Material not found');
    const id = insert(
      'INSERT INTO material_incoming (material_id, quantity, supplier, expected_date, reference, created_by) VALUES (?,?,?,?,?,?)',
      b.material_id, b.quantity, b.supplier ?? null, b.expected_date ?? null, b.reference ?? null, req.user!.id,
    );
    logActivity({ actorId: req.user!.id, entityType: 'material', entityId: b.material_id, action: 'incoming_expected', message: `Incoming stock expected: ${b.quantity} ${m.unit} ${m.name}${b.expected_date ? ` on ${b.expected_date}` : ''}` });
    changed();
    return { id };
  }),
);

r.post(
  '/incoming/:id/receive',
  h((req) => {
    const id = intId(req.params.id);
    const b = parse(z.object({ quantity: z.number().positive().optional(), reference: z.string().max(120).nullish(), cancel: z.boolean().optional() }), req.body ?? {});
    const inc = get('SELECT * FROM material_incoming WHERE id=?', id);
    if (!inc) throw notFound('Incoming entry');
    if (inc.status !== 'pending') throw conflict('This entry is already closed');
    tx(() => {
      if (b.cancel) {
        if (!isAdmin(req)) throw forbidden();
        run(`UPDATE material_incoming SET status='cancelled' WHERE id=?`, id);
        return;
      }
      const txnId = postTxn({
        materialId: inc.material_id, type: 'incoming', quantity: b.quantity ?? inc.quantity, userId: req.user!.id,
        reference: b.reference ?? inc.reference, notes: inc.supplier ? `Received from ${inc.supplier}` : 'Received',
      });
      run(`UPDATE material_incoming SET status='received', received_txn_id=? WHERE id=?`, txnId, id);
      autoAllocateMaterial(inc.material_id);
    });
    changed();
    return { ok: true };
  }),
);

export default r;
