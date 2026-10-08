import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { all, get, insert, DATA_DIR } from '../db.ts';
import { ORDER_STAGES, type OrderStage } from '../../shared/domain.ts';
import { badRequest, forbidden, h, intId, notFound, parse } from '../lib.ts';
import { requireRole, isAdmin } from '../auth.ts';
import { broadcast } from '../live.ts';
import { orderSummaries, checkTransition, transition, setHold, cancelOrder } from '../services/orders.ts';
import {
  createOrder,
  createOrderSchema,
  orderDetail,
  updateOrder,
  updateOrderSchema,
  recordQualityCheck,
  qcSchema,
  recordDispatch,
  dispatchSchema,
  toggleChecklist,
  addChecklistItem,
  upsertRequirement,
  requirementSchema,
  addOrderNote,
} from '../services/orderOps.ts';
import { allocateForOrder } from '../services/inventory.ts';
import { logActivity } from '../services/activity.ts';
import { refreshAlerts } from '../services/notifications.ts';

const r = Router();
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const changed = () => {
  broadcast('orders', 'jobs', 'inventory', 'dashboard', 'activity');
  void refreshAlerts();
};

/** Orders list with pipeline filters. `stage` accepts any lifecycle stage plus delayed / on_hold / cancelled / active. */
r.get(
  '/',
  h((req) => {
    const { stage, risk, q, priority, customer, staff } = req.query as Record<string, string | undefined>;
    let list = orderSummaries({ includeCancelled: stage === 'cancelled' });
    if (stage === 'cancelled') list = list.filter((o) => o.cancelled);
    else if (stage === 'delayed') list = list.filter((o) => o.delayed);
    else if (stage === 'on_hold') list = list.filter((o) => o.on_hold);
    else if (stage === 'active') list = list.filter((o) => o.stage !== 'completed');
    else if (stage) {
      const wanted = stage.split(',').filter((s) => ORDER_STAGES.includes(s as OrderStage));
      if (wanted.length) list = list.filter((o) => wanted.includes(o.stage));
    }
    if (risk) list = list.filter((o) => risk.split(',').includes(o.risk));
    if (priority) list = list.filter((o) => o.priority === priority);
    if (customer) list = list.filter((o) => o.customer_id === Number(customer));
    if (staff) list = list.filter((o) => o.jobs.some((j) => j.assignee_id === Number(staff)));
    if (q) {
      const s = q.toLowerCase();
      list = list.filter((o) => [o.code, o.customer, o.product, ...o.assignees].some((v) => v?.toLowerCase().includes(s)));
    }
    return list;
  }),
);

r.get(
  '/stage-counts',
  h(() => {
    const list = orderSummaries({ includeCancelled: true });
    const live = list.filter((o) => !o.cancelled);
    const counts: Record<string, number> = { all: live.length, active: live.filter((o) => o.stage !== 'completed').length };
    for (const s of ORDER_STAGES) counts[s] = live.filter((o) => o.stage === s).length;
    counts.delayed = live.filter((o) => o.delayed).length;
    counts.on_hold = live.filter((o) => o.on_hold).length;
    counts.cancelled = list.filter((o) => o.cancelled).length;
    return counts;
  }),
);

r.post(
  '/',
  requireRole('admin'),
  h((req) => {
    const input = parse(createOrderSchema, req.body);
    const id = createOrder(input, req.user!);
    changed();
    return { id, code: get('SELECT code FROM orders WHERE id=?', id)!.code };
  }),
);

r.get('/:id', h((req) => orderDetail(intId(req.params.id))));

r.patch(
  '/:id',
  requireRole('admin'),
  h((req) => {
    updateOrder(intId(req.params.id), parse(updateOrderSchema, req.body), req.user!);
    changed();
    return { ok: true };
  }),
);

r.get('/:id/transition-check', h((req) => checkTransition(intId(req.params.id), String(req.query.to) as OrderStage)));

r.post(
  '/:id/transition',
  requireRole('admin'),
  h((req) => {
    const body = parse(z.object({ to: z.enum(ORDER_STAGES), note: z.string().max(1000).nullish(), acknowledge: z.boolean().optional() }), req.body);
    const res = transition(intId(req.params.id), body.to, {
      actorId: req.user!.id,
      actorRole: req.user!.role,
      note: body.note,
      acknowledgeWarnings: body.acknowledge,
    });
    changed();
    return res;
  }),
);

r.post(
  '/:id/hold',
  requireRole('admin'),
  h((req) => {
    const { hold, reason } = parse(z.object({ hold: z.boolean(), reason: z.string().max(500).nullish() }), req.body);
    setHold(intId(req.params.id), hold, reason ?? null, req.user!.id);
    changed();
    return { ok: true };
  }),
);

r.post(
  '/:id/cancel',
  requireRole('admin'),
  h((req) => {
    const { reason } = parse(z.object({ reason: z.string().min(3, 'Give a reason') }), req.body);
    cancelOrder(intId(req.params.id), reason, req.user!.id);
    changed();
    return { ok: true };
  }),
);

r.post(
  '/:id/allocate',
  requireRole('admin'),
  h((req) => {
    const id = intId(req.params.id);
    const got = allocateForOrder(id, req.user!.id);
    changed();
    return { allocated: got };
  }),
);

r.post(
  '/:id/requirements',
  requireRole('admin'),
  h((req) => {
    upsertRequirement(intId(req.params.id), null, parse(requirementSchema, req.body), req.user!);
    changed();
    return { ok: true };
  }),
);
r.put(
  '/:id/requirements/:reqId',
  requireRole('admin'),
  h((req) => {
    upsertRequirement(intId(req.params.id), intId(req.params.reqId), parse(requirementSchema, req.body), req.user!);
    changed();
    return { ok: true };
  }),
);

r.post(
  '/:id/quality-checks',
  h((req) => {
    recordQualityCheck(intId(req.params.id), parse(qcSchema, req.body), req.user!);
    changed();
    return { ok: true };
  }),
);

r.post(
  '/:id/dispatches',
  requireRole('admin'),
  h((req) => {
    const id = recordDispatch(intId(req.params.id), parse(dispatchSchema, req.body), req.user!);
    changed();
    return { id };
  }),
);

r.post(
  '/:id/checklist',
  h((req) => {
    const id = intId(req.params.id);
    const body = parse(z.object({ item_id: z.number().int().optional(), done: z.boolean().optional(), stage: z.string().optional(), label: z.string().optional() }), req.body);
    if (body.item_id !== undefined) toggleChecklist(id, body.item_id, !!body.done, req.user!);
    else {
      if (!isAdmin(req)) throw forbidden();
      addChecklistItem(id, body.stage ?? 'preparing', body.label ?? '', req.user!);
    }
    broadcast('orders', 'activity');
    return { ok: true };
  }),
);

r.post(
  '/:id/notes',
  h((req) => {
    const { note } = parse(z.object({ note: z.string().min(1).max(2000) }), req.body);
    addOrderNote(intId(req.params.id), note, req.user!);
    broadcast('orders', 'activity');
    return { ok: true };
  }),
);

/** Attachments are sent as base64 JSON (max ~8 MB) to keep the stack dependency-free. */
r.post(
  '/:id/attachments',
  h((req) => {
    const id = intId(req.params.id);
    const o = get('SELECT code FROM orders WHERE id=?', id);
    if (!o) throw notFound('Order');
    const body = parse(
      z.object({ filename: z.string().min(1).max(200), mime: z.string().max(100).optional(), data: z.string().min(1), stage: z.string().optional(), job_id: z.number().int().optional() }),
      req.body,
    );
    const buf = Buffer.from(body.data, 'base64');
    if (buf.length > 8 * 1024 * 1024) throw badRequest('File is larger than 8 MB');
    const stored = crypto.randomBytes(16).toString('hex') + path.extname(body.filename).slice(0, 10);
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
    const aid = insert(
      'INSERT INTO attachments (order_id, job_id, stage, filename, stored_name, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)',
      id,
      body.job_id ?? null,
      body.stage ?? null,
      body.filename,
      stored,
      body.mime ?? 'application/octet-stream',
      buf.length,
      req.user!.id,
    );
    logActivity({ actorId: req.user!.id, entityType: 'order', entityId: id, orderId: id, jobId: body.job_id, action: 'attachment', message: `Attachment added to ${o.code}: ${body.filename}` });
    broadcast('orders', 'activity');
    return { id: aid };
  }),
);

export const attachmentDownload = h((req, res) => {
  const a = get('SELECT * FROM attachments WHERE id=?', intId(req.params.id));
  if (!a) throw notFound('Attachment');
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(a.filename).replace(/"/g, '')}"`);
  fs.createReadStream(path.join(UPLOAD_DIR, a.stored_name)).on('error', () => res.status(404).end()).pipe(res);
});

export const masterProduction = h(() => {
  return orderSummaries().filter((o) => o.stage !== 'completed');
});

export const dispatchBoard = h(() => {
  const ready = orderSummaries().filter((o) => ['quality_check', 'ready_for_dispatch', 'dispatched'].includes(o.stage));
  const records = all(
    `SELECT d.*, o.code AS order_code, c.name AS customer, u.name AS dispatched_by_name,
       (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS order_qty
     FROM dispatches d JOIN orders o ON o.id = d.order_id JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = d.dispatched_by
     ORDER BY d.dispatched_at DESC LIMIT 200`,
  );
  const checklists = all(`SELECT order_id, SUM(done) AS done, COUNT(*) AS total FROM order_checklist_items WHERE stage='ready_for_dispatch' GROUP BY order_id`);
  return { orders: ready, records, checklists };
});

export default r;
