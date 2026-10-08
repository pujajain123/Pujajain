import { z } from 'zod';
import { all, get, insert, run, tx } from '../db.ts';
import { PRIORITIES, stageIndex } from '../../shared/domain.ts';
import { badRequest, conflict, notFound, nowIso, today } from '../lib.ts';
import type { AuthUser } from '../auth.ts';
import { logActivity, logFieldChanges } from './activity.ts';
import { nextJobCode, nextOrderCode, orderSummary, stageLabel, transition } from './orders.ts';
import { orderMaterials } from './inventory.ts';
import { notifyUser } from './notifications.ts';
import { itemMaterials, seedItemMaterials, seedJobSteps, jobSteps } from './steps.ts';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a valid date');
const optDate = date.nullish().or(z.literal('').transform(() => null));
const optStr = z.string().trim().max(2000).nullish();

export const createOrderSchema = z
  .object({
    customer_id: z.number().int().positive().optional(),
    new_customer: z
      .object({
        name: z.string().trim().min(2, 'Client name is required'),
        contact_person: optStr,
        phone: optStr,
        email: z.string().email().nullish().or(z.literal('')),
        address: optStr,
        city: optStr,
        gstin: optStr,
      })
      .optional(),
    po_number: optStr,
    source: optStr,
    order_date: date,
    priority: z.enum(PRIORITIES),
    notes: optStr,
    delivery_address: optStr,
    sky_date: optDate,
    commencement_date: optDate,
    deadline: date,
    items: z
      .array(
        z.object({
          product_id: z.number().int().positive().optional(),
          sku: z.string().trim().max(60).optional(),
          name: z.string().trim().max(120).optional(),
          quantity: z.number().int().positive('Quantity must be at least 1'),
          dimensions: optStr,
          finish: optStr,
          color: optStr,
          specifications: optStr,
          frame_material: optStr,
          powder_color: optStr,
          dori_color: optStr,
          rope_code: optStr,
          rope_required: z.number().nonnegative().nullish(),
          fabric_code: optStr,
          fabric_company: optStr,
          fabric_qty: z.number().nonnegative().nullish(),
          seat_height: optStr,
          seat_bifurcation: optStr,
          back_cushion: optStr,
          extra_cushion: optStr,
          table_top: optStr,
          buffer_type: optStr,
          photo: z.string().max(3_000_000).nullish(),
          material_status: z.record(z.object({ required: z.boolean(), status: z.enum(['pending', 'received', 'not_required']).optional(), note: optStr })).optional(),
          step_status: z.record(z.record(z.string())).optional(),
          processes: z
            .array(
              z.object({
                process_id: z.number().int().positive(),
                assigned_to: z.number().int().positive().nullish(),
                start_date: optDate,
                due_date: optDate,
                specs: z.record(z.any()).optional(),
              }),
            )
            .min(1, 'Select at least one production process'),
          materials: z
            .array(z.object({ process_id: z.number().int().positive().nullish(), material_id: z.number().int().positive(), required_qty: z.number().positive() }))
            .default([]),
        }),
      )
      .min(1, 'Add at least one product'),
  })
  .superRefine((v, ctx) => {
    if (!v.customer_id && !v.new_customer) ctx.addIssue({ code: 'custom', path: ['customer_id'], message: 'Select or add a client' });
    v.items.forEach((it, i) => {
      if (!it.product_id && !(it.sku && it.name)) ctx.addIssue({ code: 'custom', path: ['items', i, 'sku'], message: 'Enter the SKU and product name' });
    });
    if (v.deadline < v.order_date) ctx.addIssue({ code: 'custom', path: ['deadline'], message: 'Deadline cannot be before the order date' });
    if (v.sky_date && v.sky_date > v.deadline) ctx.addIssue({ code: 'custom', path: ['sky_date'], message: 'Sky date should be on or before the deadline' });
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export function createOrder(input: CreateOrderInput, user: AuthUser, opts: { code?: string; createdAt?: string } = {}) {
  return tx(() => {
    let customerId = input.customer_id;
    if (!customerId) {
      const c = input.new_customer!;
      customerId = insert(
        'INSERT INTO customers (name, contact_person, phone, email, address, city, gstin) VALUES (?,?,?,?,?,?,?)',
        c.name,
        c.contact_person ?? null,
        c.phone ?? null,
        c.email || null,
        c.address ?? null,
        c.city ?? null,
        c.gstin ?? null,
      );
      logActivity({ actorId: user.id, entityType: 'customer', entityId: customerId, action: 'create', message: `Client ${c.name} added` });
    } else if (!get('SELECT 1 FROM customers WHERE id=?', customerId)) throw badRequest('Client not found');

    const code = opts.code ?? nextOrderCode();
    const orderId = insert(
      `INSERT INTO orders (code, customer_id, po_number, order_date, commencement_date, sky_date, deadline, priority, source, notes, delivery_address, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      code,
      customerId,
      input.po_number ?? null,
      input.order_date,
      input.commencement_date ?? null,
      input.sky_date ?? null,
      input.deadline,
      input.priority,
      input.source ?? null,
      input.notes ?? null,
      input.delivery_address ?? null,
      user.id,
      opts.createdAt ?? nowIso(),
      opts.createdAt ?? nowIso(),
    );
    insert(
      `INSERT INTO order_status_history (order_id, from_stage, to_stage, event, note, changed_by, created_at) VALUES (?,?,?,?,?,?,?)`,
      orderId,
      null,
      'received',
      'transition',
      input.source ? `Source: ${input.source}` : null,
      user.id,
      opts.createdAt ?? nowIso(),
    );
    const customer = get('SELECT name FROM customers WHERE id=?', customerId)!.name;
    logActivity({
      actorId: user.id,
      entityType: 'order',
      entityId: orderId,
      orderId,
      action: 'create',
      message: `Order ${code} received from ${customer} · deadline ${input.deadline}`,
    });

    for (const item of input.items) {
      // Product lines carry a free-text SKU; the SKU catalogue grows as orders come in.
      let productId = item.product_id;
      if (!productId) {
        productId = get<{ id: number }>('SELECT id FROM products WHERE lower(sku)=lower(?)', item.sku!)?.id;
        if (!productId) productId = insert('INSERT INTO products (sku, name, category) VALUES (?,?,?)', item.sku!, item.name!, item.name!.split(' ')[0]);
      }
      const product = get('SELECT * FROM products WHERE id=?', productId);
      if (!product) throw badRequest('Product not found');
      const itemId = insert(
        `INSERT INTO order_items (order_id, product_id, quantity, dimensions, finish, color, specifications, frame_material, powder_color, dori_color, rope_code,
           rope_required, fabric_code, fabric_company, fabric_qty, seat_height, seat_bifurcation, back_cushion, extra_cushion, table_top, buffer_type, photo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        orderId,
        productId,
        item.quantity,
        item.dimensions ?? product.default_dimensions ?? null,
        item.finish ?? null,
        item.color ?? item.dori_color ?? null,
        item.specifications ?? null,
        item.frame_material ?? null,
        item.powder_color ?? null,
        item.dori_color ?? null,
        item.rope_code ?? null,
        item.rope_required ?? null,
        item.fabric_code ?? null,
        item.fabric_company ?? null,
        item.fabric_qty ?? null,
        item.seat_height ?? null,
        item.seat_bifurcation ?? null,
        item.back_cushion ?? null,
        item.extra_cushion ?? null,
        item.table_top ?? null,
        item.buffer_type ?? null,
        item.photo ?? null,
      );
      // Material readiness defaults from the processes chosen, unless the caller says otherwise.
      const procKeys = item.processes.map((p) => get<{ key: string }>('SELECT key FROM job_processes WHERE id=?', p.process_id)?.key);
      seedItemMaterials(itemId, {
        metal: { required: procKeys.includes('iron') },
        rope: { required: procKeys.includes('rope') },
        fabric: { required: procKeys.includes('fabric') },
        foam: { required: procKeys.includes('fabric') },
        tile: { required: procKeys.includes('tile') },
        ...(item.material_status as any),
      });
      for (const pr of item.processes) {
        const proc = get('SELECT * FROM job_processes WHERE id=?', pr.process_id);
        if (!proc) throw badRequest('Process not found');
        if (pr.start_date && pr.due_date && pr.start_date > pr.due_date) throw badRequest(`${proc.name}: start date must be before due date`);
        const jobCode = nextJobCode();
        const jobId = insert(
          `INSERT INTO jobs (code, order_id, order_item_id, process_id, quantity, assigned_to, start_date, due_date, specs_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          jobCode,
          orderId,
          itemId,
          pr.process_id,
          item.quantity,
          pr.assigned_to ?? null,
          pr.start_date ?? null,
          pr.due_date ?? null,
          JSON.stringify(pr.specs ?? {}),
          nowIso(),
          nowIso(),
        );
        seedJobSteps(jobId, pr.process_id, item.step_status?.[proc.key] ?? {});
        logActivity({
          actorId: user.id,
          entityType: 'job',
          entityId: jobId,
          orderId,
          jobId,
          action: 'create',
          message: `Job sheet ${jobCode} created: ${proc.name} × ${item.quantity} (${product.name})`,
        });
        if (pr.assigned_to) {
          insert('INSERT INTO staff_assignments (job_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)', jobId, pr.assigned_to, user.id, nowIso());
          notifyUser(pr.assigned_to, {
            type: 'job_assigned',
            severity: 'info',
            title: `New job: ${proc.name} for ${code}`,
            body: `${jobCode} · ${product.name} × ${item.quantity}${pr.due_date ? ` · due ${pr.due_date}` : ''}`,
            orderId,
            jobId,
            dedupeKey: `assigned:${jobId}:${pr.assigned_to}`,
          });
        }
      }
      for (const m of item.materials) {
        if (!get('SELECT 1 FROM materials WHERE id=?', m.material_id)) throw badRequest('Material not found');
        insert(
          'INSERT INTO material_requirements (order_id, order_item_id, process_id, material_id, required_qty) VALUES (?,?,?,?,?)',
          orderId,
          itemId,
          m.process_id ?? null,
          m.material_id,
          m.required_qty,
        );
      }
    }
    return orderId;
  });
}

/** Everything the Order Detail workspace needs, assembled from the normalised tables. */
export function orderDetail(orderId: number) {
  const o = get(
    `SELECT o.*, c.name AS customer, c.contact_person, c.phone, c.email, c.address AS customer_address, c.city, c.gstin,
       u.name AS created_by_name
     FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`,
    orderId,
  );
  if (!o) throw notFound('Order');
  const summary = orderSummary(orderId);
  const items = all(
    `SELECT i.*, p.name AS product, p.sku, p.category FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ? ORDER BY i.id`,
    orderId,
  );
  const jobs = all(
    `SELECT j.*, p.key AS process_key, p.name AS process_name, p.sequence, u.name AS assignee
     FROM jobs j JOIN job_processes p ON p.id = j.process_id LEFT JOIN users u ON u.id = j.assigned_to
     WHERE j.order_id = ? ORDER BY p.sequence, j.id`,
    orderId,
  ).map((j) => ({ ...j, specs: JSON.parse(j.specs_json || '{}'), progress: Math.round((j.completed_qty / j.quantity) * 100), steps: jobSteps(j.id) }));
  const mats = itemMaterials(items.map((i) => i.id));
  for (const it of items) (it as any).materials = mats.filter((m) => m.order_item_id === it.id);
  const history = all(
    `SELECT h.*, u.name AS actor FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = ? ORDER BY h.id`,
    orderId,
  );
  const checklists = all(
    `SELECT c.*, u.name AS done_by_name FROM order_checklist_items c LEFT JOIN users u ON u.id = c.done_by WHERE c.order_id = ? ORDER BY c.stage, c.sequence, c.id`,
    orderId,
  );
  const qc = all(`SELECT q.*, u.name AS checked_by_name FROM quality_checks q LEFT JOIN users u ON u.id = q.checked_by WHERE q.order_id = ? ORDER BY q.id DESC`, orderId);
  const dispatches = all(
    `SELECT d.*, u.name AS dispatched_by_name FROM dispatches d LEFT JOIN users u ON u.id = d.dispatched_by WHERE d.order_id = ? ORDER BY d.dispatched_at`,
    orderId,
  );
  const attachments = all(
    `SELECT a.id, a.filename, a.mime, a.size, a.stage, a.created_at, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
     WHERE a.order_id = ? ORDER BY a.id DESC`,
    orderId,
  );
  const activity = all(
    `SELECT a.*, u.name AS actor FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.order_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 300`,
    orderId,
  );
  const transactions = all(
    `SELECT t.*, m.name AS material_name, m.unit, j.code AS job_code, u.name AS user_name FROM inventory_transactions t
     JOIN materials m ON m.id = t.material_id LEFT JOIN jobs j ON j.id = t.job_id LEFT JOIN users u ON u.id = t.user_id
     WHERE t.order_id = ? ORDER BY t.id DESC`,
    orderId,
  );
  const stages = all('SELECT * FROM order_stages ORDER BY sequence');
  // When did each stage start / finish (latest forward entry)?
  const stageTimes: Record<string, { entered_at: string; by: string | null } | undefined> = {};
  for (const h of history) if (h.event === 'transition' || h.event === 'rollback') stageTimes[h.to_stage] = { entered_at: h.created_at, by: h.actor ?? 'System' };
  return {
    order: o,
    summary,
    items,
    jobs,
    materials: orderMaterials(orderId),
    history,
    stage_times: stageTimes,
    stages,
    checklists,
    quality_checks: qc,
    dispatches,
    dispatched_qty: dispatches.reduce((s, d) => s + d.quantity, 0),
    attachments,
    activity,
    transactions,
  };
}

export const updateOrderSchema = z.object({
  deadline: date.optional(),
  sky_date: optDate.optional(),
  priority: z.enum(PRIORITIES).optional(),
  po_number: optStr,
  source: optStr,
  notes: optStr,
  delivery_address: optStr,
  order_date: date.optional(),
});
const ORDER_FIELDS = {
  deadline: 'Delivery deadline',
  sky_date: 'Sky date',
  priority: 'Priority',
  po_number: 'PO / reference',
  source: 'Order source',
  notes: 'Notes',
  delivery_address: 'Delivery address',
  order_date: 'Order date',
};

export function updateOrder(orderId: number, patch: z.infer<typeof updateOrderSchema>, user: AuthUser) {
  return tx(() => {
    const o = get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o) throw notFound('Order');
    const next: any = { ...o, ...patch };
    if (next.deadline < next.order_date) throw badRequest('Deadline cannot be before the order date');
    if (next.sky_date && next.sky_date > next.deadline) throw badRequest('Sky date should be on or before the deadline');
    const keys = Object.keys(patch).filter((k) => k in ORDER_FIELDS) as (keyof typeof ORDER_FIELDS)[];
    if (!keys.length) return;
    run(`UPDATE orders SET ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`, ...keys.map((k) => (patch as any)[k] ?? null), nowIso(), orderId);
    logFieldChanges({ actorId: user.id, entityType: 'order', entityId: orderId, orderId, label: `Order ${o.code}` }, o, patch, ORDER_FIELDS);
    if (patch.deadline && patch.deadline !== o.deadline) {
      // Job sheets read the deadline from the order; flag job due dates that now fall after it.
      const late = all(`SELECT j.code FROM jobs j WHERE j.order_id=? AND j.due_date > ? AND j.status != 'completed'`, orderId, patch.deadline);
      if (late.length)
        logActivity({
          actorId: null,
          entityType: 'order',
          entityId: orderId,
          orderId,
          action: 'warning',
          message: `Job due dates now after the deadline: ${late.map((l) => l.code).join(', ')} — re-plan required`,
        });
      for (const u of all<{ id: number }>('SELECT DISTINCT assigned_to AS id FROM jobs WHERE order_id=? AND assigned_to IS NOT NULL', orderId))
        notifyUser(u.id, {
          type: 'deadline_changed',
          severity: 'notice',
          title: `Deadline changed for ${o.code}`,
          body: `${o.deadline} → ${patch.deadline}`,
          orderId,
          dedupeKey: `deadline_changed:${orderId}:${patch.deadline}`,
        });
    }
  });
}

export const qcSchema = z.object({
  result: z.enum(['passed', 'failed', 'rework']),
  qty_checked: z.number().int().nonnegative().nullish(),
  qty_passed: z.number().int().nonnegative().nullish(),
  qty_rejected: z.number().int().nonnegative().nullish(),
  notes: optStr,
});

export function recordQualityCheck(orderId: number, input: z.infer<typeof qcSchema>, user: AuthUser) {
  return tx(() => {
    const o = get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o) throw notFound('Order');
    if (o.stage !== 'quality_check') throw conflict('Quality checks are recorded while the order is in Quality Check');
    if (input.result !== 'passed' && !input.notes?.trim()) throw badRequest('Describe what failed or needs rework');
    insert(
      'INSERT INTO quality_checks (order_id, result, qty_checked, qty_passed, qty_rejected, notes, checked_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      orderId,
      input.result,
      input.qty_checked ?? null,
      input.qty_passed ?? null,
      input.qty_rejected ?? null,
      input.notes ?? null,
      user.id,
      nowIso(),
    );
    logActivity({
      actorId: user.id,
      entityType: 'order',
      entityId: orderId,
      orderId,
      action: 'quality_check',
      newValue: input.result,
      message: `Quality check ${input.result.toUpperCase()} on ${o.code}${input.qty_checked ? ` (${input.qty_passed ?? 0}/${input.qty_checked} passed)` : ''}${input.notes ? ` — ${input.notes}` : ''}`,
    });
    if (input.result === 'passed') transition(orderId, 'ready_for_dispatch', { actorId: null, automatic: true, note: 'Quality check passed' });
    else if (input.result === 'rework')
      transition(orderId, 'in_production', { actorId: user.id, actorRole: 'admin', automatic: true, note: `QC rework: ${input.notes}` });
  });
}

export const dispatchSchema = z.object({
  dispatched_at: z.string().min(10),
  quantity: z.number().int().positive(),
  transporter: optStr,
  vehicle_no: optStr,
  tracking_ref: optStr,
  invoice_no: optStr,
  eway_bill: optStr,
  packages: z.number().int().nonnegative().nullish(),
  notes: optStr,
});

export function recordDispatch(orderId: number, input: z.infer<typeof dispatchSchema>, user: AuthUser) {
  return tx(() => {
    const o = get('SELECT * FROM orders WHERE id=?', orderId);
    if (!o) throw notFound('Order');
    if (o.cancelled_at) throw conflict('Order is cancelled');
    if (!['ready_for_dispatch', 'dispatched'].includes(o.stage)) throw conflict('Dispatch is recorded once the order is Ready for Dispatch');
    const qty = get<{ q: number }>('SELECT SUM(quantity) AS q FROM order_items WHERE order_id=?', orderId)!.q;
    const sent = get<{ q: number }>('SELECT COALESCE(SUM(quantity),0) AS q FROM dispatches WHERE order_id=?', orderId)!.q;
    if (sent + input.quantity > qty) throw badRequest(`Only ${qty - sent} unit(s) remain to be dispatched`);
    const id = insert(
      `INSERT INTO dispatches (order_id, dispatched_at, dispatched_by, quantity, transporter, vehicle_no, tracking_ref, invoice_no, eway_bill, packages, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      orderId,
      input.dispatched_at,
      user.id,
      input.quantity,
      input.transporter ?? null,
      input.vehicle_no ?? null,
      input.tracking_ref ?? null,
      input.invoice_no ?? null,
      input.eway_bill ?? null,
      input.packages ?? null,
      input.notes ?? null,
      nowIso(),
    );
    const remaining = qty - sent - input.quantity;
    logActivity({
      actorId: user.id,
      entityType: 'dispatch',
      entityId: id,
      orderId,
      action: 'dispatch',
      message: `${o.code}: ${input.quantity} unit(s) dispatched${input.transporter ? ` via ${input.transporter}` : ''}${input.tracking_ref ? ` (ref ${input.tracking_ref})` : ''}${remaining ? ` — ${remaining} remaining (partial)` : ' — fully dispatched'}`,
    });
    if (o.stage === 'ready_for_dispatch') transition(orderId, 'dispatched', { actorId: user.id, automatic: true, note: remaining ? 'Partial dispatch' : 'Dispatched in full' });
    return id;
  });
}

export function toggleChecklist(orderId: number, itemId: number, done: boolean, user: AuthUser) {
  const c = get('SELECT * FROM order_checklist_items WHERE id=? AND order_id=?', itemId, orderId);
  if (!c) throw notFound('Checklist item');
  run('UPDATE order_checklist_items SET done=?, done_by=?, done_at=? WHERE id=?', done ? 1 : 0, done ? user.id : null, done ? nowIso() : null, itemId);
  const code = get('SELECT code FROM orders WHERE id=?', orderId)!.code;
  logActivity({
    actorId: user.id,
    entityType: 'order',
    entityId: orderId,
    orderId,
    action: 'checklist',
    message: `${code} ${stageLabel(c.stage)} checklist: "${c.label}" ${done ? 'ticked' : 'unticked'}`,
  });
}

export function addChecklistItem(orderId: number, stage: string, label: string, user: AuthUser) {
  if (!label.trim()) throw badRequest('Checklist text is required');
  const seq = get<{ n: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM order_checklist_items WHERE order_id=? AND stage=?', orderId, stage)!.n;
  insert('INSERT INTO order_checklist_items (order_id, stage, label, sequence) VALUES (?,?,?,?)', orderId, stage, label.trim(), seq);
  logActivity({ actorId: user.id, entityType: 'order', entityId: orderId, orderId, action: 'checklist', message: `Checklist item added (${stageLabel(stage)}): ${label}` });
}

export const requirementSchema = z.object({
  material_id: z.number().int().positive(),
  process_id: z.number().int().positive().nullish(),
  order_item_id: z.number().int().positive().nullish(),
  required_qty: z.number().positive(),
  notes: optStr,
});

export function upsertRequirement(orderId: number, reqId: number | null, input: z.infer<typeof requirementSchema>, user: AuthUser) {
  const o = get('SELECT code, stage FROM orders WHERE id=?', orderId);
  if (!o) throw notFound('Order');
  if (stageIndex(o.stage) >= stageIndex('quality_check')) throw conflict('Material requirements are locked after production');
  const m = get('SELECT name, unit FROM materials WHERE id=?', input.material_id);
  if (!m) throw badRequest('Material not found');
  if (reqId) {
    const old = get('SELECT * FROM material_requirements WHERE id=? AND order_id=?', reqId, orderId);
    if (!old) throw notFound('Requirement');
    run('UPDATE material_requirements SET material_id=?, process_id=?, required_qty=?, notes=? WHERE id=?', input.material_id, input.process_id ?? null, input.required_qty, input.notes ?? null, reqId);
    logActivity({
      actorId: user.id,
      entityType: 'order',
      entityId: orderId,
      orderId,
      action: 'requirement',
      field: 'required_qty',
      oldValue: old.required_qty,
      newValue: input.required_qty,
      message: `${o.code} material requirement ${m.name}: ${old.required_qty} → ${input.required_qty} ${m.unit}`,
    });
  } else {
    insert(
      'INSERT INTO material_requirements (order_id, order_item_id, process_id, material_id, required_qty, notes) VALUES (?,?,?,?,?,?)',
      orderId,
      input.order_item_id ?? get('SELECT id FROM order_items WHERE order_id=? ORDER BY id LIMIT 1', orderId)?.id ?? null,
      input.process_id ?? null,
      input.material_id,
      input.required_qty,
      input.notes ?? null,
    );
    logActivity({
      actorId: user.id,
      entityType: 'order',
      entityId: orderId,
      orderId,
      action: 'requirement',
      message: `${o.code} material requirement added: ${input.required_qty} ${m.unit} ${m.name}`,
    });
  }
}

export function addOrderNote(orderId: number, note: string, user: AuthUser) {
  const o = get('SELECT code FROM orders WHERE id=?', orderId);
  if (!o) throw notFound('Order');
  if (!note.trim()) throw badRequest('Note is empty');
  logActivity({ actorId: user.id, entityType: 'order', entityId: orderId, orderId, action: 'note', message: `Note on ${o.code}: ${note.trim()}` });
}

export { today };

export const itemPatchSchema = z.object({
  quantity: z.number().int().positive().optional(),
  dimensions: optStr,
  frame_material: optStr,
  powder_color: optStr,
  dori_color: optStr,
  rope_code: optStr,
  rope_required: z.number().nonnegative().nullish(),
  fabric_code: optStr,
  fabric_company: optStr,
  fabric_qty: z.number().nonnegative().nullish(),
  seat_height: optStr,
  seat_bifurcation: optStr,
  back_cushion: optStr,
  extra_cushion: optStr,
  table_top: optStr,
  buffer_type: optStr,
  photo: z.string().max(3_000_000).nullish(),
});
const ITEM_FIELDS: Record<string, string> = {
  quantity: 'Quantity', dimensions: 'Dimensions', frame_material: 'Frame material', powder_color: 'Powder colour', dori_color: 'Dori colour',
  rope_code: 'Rope size / code', rope_required: 'Rope required', fabric_code: 'Fabric code', fabric_company: 'Fabric company', fabric_qty: 'Fabric quantity',
  seat_height: 'Seat height', seat_bifurcation: 'Seat bifurcation', back_cushion: 'Back cushion', extra_cushion: 'Extra cushion', table_top: 'Table top / stone', buffer_type: 'Buffer type',
};

/** Edit a product line's specification or reference photo (staff may add photos only). */
export function updateItem(orderId: number, itemId: number, patch: z.infer<typeof itemPatchSchema>, user: AuthUser) {
  const it = get('SELECT i.*, o.code AS order_code, p.sku FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id WHERE i.id=? AND i.order_id=?', itemId, orderId);
  if (!it) throw notFound('Product line');
  const keys = Object.keys(patch);
  if (user.role !== 'admin' && keys.some((k) => k !== 'photo')) throw conflict('Only an admin can change product specifications');
  if (patch.quantity !== undefined) {
    const done = get<{ m: number }>('SELECT COALESCE(MAX(completed_qty),0) AS m FROM jobs WHERE order_item_id=?', itemId)!.m;
    if (patch.quantity < done) throw badRequest(`Quantity cannot be below the ${done} units already produced`);
  }
  tx(() => {
    if (keys.length) run(`UPDATE order_items SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => (patch as any)[k] ?? null), itemId);
    if (patch.quantity !== undefined) run('UPDATE jobs SET quantity=? WHERE order_item_id=?', patch.quantity, itemId);
    if ('photo' in patch)
      logActivity({ actorId: user.id, entityType: 'order', entityId: orderId, orderId, action: 'photo', message: `${it.order_code} · ${it.sku}: product photo ${patch.photo ? 'added' : 'removed'}` });
    const { photo: _p, ...rest } = patch;
    logFieldChanges({ actorId: user.id, entityType: 'order', entityId: orderId, orderId, label: `${it.order_code} · ${it.sku}` }, it, rest, ITEM_FIELDS);
  });
}
