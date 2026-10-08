import { all, get, insert, tx } from '../db.ts';
import type { TxnType } from '../../shared/domain.ts';
import { TXN_LABELS } from '../../shared/domain.ts';
import { badRequest, nowIso, round, today } from '../lib.ts';
import { logActivity } from './activity.ts';

export interface StockRow {
  material_id: number;
  code: string;
  name: string;
  category: string;
  variant: string | null;
  color: string | null;
  unit: string;
  reorder_level: number;
  supplier: string | null;
  location: string | null;
  opening: number;
  incoming: number;
  adjustments: number;
  consumed: number;
  wastage: number;
  on_hand: number;
  reserved: number;
  available: number;
  expected_incoming: number;
  low_stock: boolean;
}

export function stock(filter: { category?: string; materialId?: number } = {}): StockRow[] {
  const where: string[] = ['m.active = 1'];
  const params: any[] = [];
  if (filter.category) (where.push('m.category = ?'), params.push(filter.category));
  if (filter.materialId) (where.push('m.id = ?'), params.push(filter.materialId));
  return all<StockRow>(
    `SELECT m.id AS material_id, m.code, m.name, m.category, m.variant, m.color, m.unit, m.reorder_level, m.supplier, m.location,
       i.opening, i.incoming, i.adjustments, i.consumed, i.wastage, i.on_hand, i.reserved, i.available, i.expected_incoming
     FROM materials m JOIN inventory i ON i.material_id = m.id
     WHERE ${where.join(' AND ')} ORDER BY m.category, m.name`,
    ...params,
  ).map((r) => ({ ...roundRow(r), low_stock: r.available < r.reorder_level }));
}

function roundRow<T extends Record<string, any>>(r: T): T {
  const out: any = { ...r };
  for (const k of ['opening', 'incoming', 'adjustments', 'consumed', 'wastage', 'on_hand', 'reserved', 'available', 'expected_incoming'])
    if (k in out) out[k] = round(out[k]);
  return out;
}

export interface TxnInput {
  materialId: number;
  type: TxnType;
  quantity: number;
  orderId?: number | null;
  jobId?: number | null;
  userId: number | null;
  reference?: string | null;
  notes?: string | null;
  date?: string;
}

/** Post a ledger movement. Outflows may not take physical stock below zero. */
export function postTxn(t: TxnInput): number {
  if (!(t.quantity > 0)) throw badRequest('Quantity must be greater than zero');
  const mat = get<{ id: number; name: string; unit: string }>('SELECT id, name, unit FROM materials WHERE id=?', t.materialId);
  if (!mat) throw badRequest('Unknown material');
  const s = get<{ on_hand: number; available: number }>('SELECT on_hand, available FROM inventory WHERE material_id=?', t.materialId)!;
  if (['consumption', 'wastage', 'adjustment_out'].includes(t.type) && t.quantity > s.on_hand + 1e-9) {
    throw badRequest(`Only ${round(s.on_hand)} ${mat.unit} of ${mat.name} is physically in stock`);
  }
  if (t.type === 'allocation' && t.quantity > s.available + 1e-9) {
    throw badRequest(`Only ${round(s.available)} ${mat.unit} of ${mat.name} is available to allocate`);
  }
  if (t.type === 'release') {
    const open = openReservation(t.materialId, t.orderId!);
    if (t.quantity > open + 1e-9) throw badRequest(`Only ${round(open)} ${mat.unit} is reserved for this order`);
  }
  const id = insert(
    `INSERT INTO inventory_transactions (material_id, type, quantity, order_id, job_id, user_id, reference, notes, txn_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    t.materialId,
    t.type,
    round(t.quantity, 3),
    t.orderId ?? null,
    t.jobId ?? null,
    t.userId,
    t.reference ?? null,
    t.notes ?? null,
    t.date ?? today(),
    nowIso(),
  );
  const orderCode = t.orderId ? get<{ code: string }>('SELECT code FROM orders WHERE id=?', t.orderId)?.code : null;
  logActivity({
    actorId: t.userId,
    entityType: 'material',
    entityId: t.materialId,
    orderId: t.orderId,
    jobId: t.jobId,
    action: `stock_${t.type}`,
    newValue: t.quantity,
    message: `${TXN_LABELS[t.type]}: ${round(t.quantity)} ${mat.unit} ${mat.name}${orderCode ? ` (${orderCode})` : ''}${t.notes ? ` — ${t.notes}` : ''}`,
  });
  return id;
}

/** Quantity still reserved for an order (allocated − released − consumed, floored at 0). */
export function openReservation(materialId: number, orderId: number): number {
  const r = get<{ v: number }>(
    `SELECT COALESCE(SUM(CASE WHEN type='allocation' THEN quantity WHEN type IN ('release','consumption') THEN -quantity ELSE 0 END),0) AS v
     FROM inventory_transactions WHERE material_id=? AND order_id=?`,
    materialId,
    orderId,
  )!;
  return Math.max(0, round(r.v, 3));
}

export interface MaterialReadiness {
  requirement_id: number;
  material_id: number;
  material_code: string;
  material_name: string;
  category: string;
  color: string | null;
  unit: string;
  process_id: number | null;
  process_name: string | null;
  required: number;
  consumed: number;
  wastage: number;
  reserved: number;
  available_in_store: number;
  outstanding: number; // still to be consumed
  shortage: number; // outstanding not covered by this order's reservation or free stock
  ready: boolean;
}

/** Material readiness for an order: requirement vs consumption, reservation and free stock. */
export function orderMaterials(orderId: number): MaterialReadiness[] {
  const reqs = all(
    `SELECT r.id, r.material_id, r.process_id, SUM(r.required_qty) AS required, m.code, m.name, m.category, m.color, m.unit, p.name AS process_name,
       i.available
     FROM material_requirements r JOIN materials m ON m.id = r.material_id
     LEFT JOIN job_processes p ON p.id = r.process_id
     JOIN inventory i ON i.material_id = m.id
     WHERE r.order_id = ? GROUP BY r.material_id, r.process_id ORDER BY p.sequence, m.name`,
    orderId,
  );
  return reqs.map((r) => {
    const used = get<{ consumed: number; wastage: number }>(
      `SELECT COALESCE(SUM(CASE WHEN type='consumption' THEN quantity END),0) AS consumed,
              COALESCE(SUM(CASE WHEN type='wastage' THEN quantity END),0) AS wastage
       FROM inventory_transactions WHERE order_id=? AND material_id=?`,
      orderId,
      r.material_id,
    )!;
    const reserved = openReservation(r.material_id, orderId);
    const outstanding = Math.max(0, round(r.required - used.consumed, 3));
    const shortage = Math.max(0, round(outstanding - reserved - Math.max(0, r.available), 3));
    return {
      requirement_id: r.id,
      material_id: r.material_id,
      material_code: r.code,
      material_name: r.name,
      category: r.category,
      color: r.color,
      unit: r.unit,
      process_id: r.process_id,
      process_name: r.process_name,
      required: round(r.required),
      consumed: round(used.consumed),
      wastage: round(used.wastage),
      reserved: round(reserved),
      available_in_store: round(r.available),
      outstanding: round(outstanding),
      shortage: round(shortage),
      ready: shortage <= 0,
    };
  });
}

/** Reserve free stock for an order's outstanding requirements. Returns what was allocated. */
export function allocateForOrder(orderId: number, userId: number | null): { material: string; qty: number; unit: string }[] {
  return tx(() => {
    const out: { material: string; qty: number; unit: string }[] = [];
    const byMaterial = new Map<number, MaterialReadiness>();
    for (const m of orderMaterials(orderId)) {
      const prev = byMaterial.get(m.material_id);
      if (prev) prev.outstanding += m.outstanding;
      else byMaterial.set(m.material_id, { ...m });
    }
    for (const m of byMaterial.values()) {
      const reserved = openReservation(m.material_id, orderId);
      const need = round(m.outstanding - reserved, 3);
      if (need <= 0) continue;
      const free = get<{ available: number }>('SELECT available FROM inventory WHERE material_id=?', m.material_id)!.available;
      const qty = round(Math.min(need, free), 3);
      if (qty <= 0) continue;
      postTxn({ materialId: m.material_id, type: 'allocation', quantity: qty, orderId, userId, notes: 'Reserved for production' });
      out.push({ material: m.material_name, qty, unit: m.unit });
    }
    return out;
  });
}

/** Release any stock still reserved for an order (on completion or cancellation). */
export function releaseOrderReservations(orderId: number, userId: number | null, reason: string) {
  const mats = all<{ material_id: number }>('SELECT DISTINCT material_id FROM inventory_transactions WHERE order_id=?', orderId);
  for (const { material_id } of mats) {
    const open = openReservation(material_id, orderId);
    if (open > 0) postTxn({ materialId: material_id, type: 'release', quantity: open, orderId, userId, notes: reason });
  }
}

/**
 * After stock arrives, top up reservations for orders that are short of this material,
 * most urgent first (priority, then deadline).
 */
export function autoAllocateMaterial(materialId: number) {
  const orders = all<{ id: number }>(
    `SELECT DISTINCT o.id FROM orders o JOIN material_requirements r ON r.order_id = o.id
     WHERE r.material_id = ? AND o.cancelled_at IS NULL AND o.stage IN ('preparing','ready_for_production','in_production')
     ORDER BY CASE o.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, o.deadline`,
    materialId,
  );
  for (const o of orders) {
    const free = get<{ available: number }>('SELECT available FROM inventory WHERE material_id=?', materialId)!.available;
    if (free <= 0) break;
    const need = orderMaterials(o.id)
      .filter((m) => m.material_id === materialId)
      .reduce((s, m) => s + m.outstanding, 0) - openReservation(materialId, o.id);
    const qty = round(Math.min(need, free), 3);
    if (qty > 0) postTxn({ materialId, type: 'allocation', quantity: qty, orderId: o.id, userId: null, notes: 'Auto-reserved after stock receipt' });
  }
}

export function ledger(materialId: number, limit = 200) {
  return all(
    `SELECT t.*, u.name AS user_name, o.code AS order_code, j.code AS job_code
     FROM inventory_transactions t LEFT JOIN users u ON u.id = t.user_id
     LEFT JOIN orders o ON o.id = t.order_id LEFT JOIN jobs j ON j.id = t.job_id
     WHERE t.material_id = ? ORDER BY t.txn_date DESC, t.id DESC LIMIT ?`,
    materialId,
    limit,
  );
}
