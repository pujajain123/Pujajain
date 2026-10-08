import { all, get, getSetting, insert, run, tx } from '../db.ts';
import {
  ORDER_STAGES,
  type OrderStage,
  stageIndex,
  deadlineRisk,
  daysBetween,
  type DeadlineRisk,
} from '../../shared/domain.ts';
import { badRequest, conflict, notFound, nowIso, today } from '../lib.ts';
import { logActivity } from './activity.ts';
import { allocateForOrder, orderMaterials, releaseOrderReservations } from './inventory.ts';
import { notifyAdmins } from './notifications.ts';

export const stageLabel = (key: string) => get<{ label: string }>('SELECT label FROM order_stages WHERE key=?', key)?.label ?? key;

export interface JobBrief {
  id: number;
  code: string;
  process_id: number;
  process_key: string;
  process_name: string;
  status: string;
  quantity: number;
  completed_qty: number;
  progress: number;
  assignee_id: number | null;
  assignee: string | null;
  due_date: string | null;
  overdue: boolean;
}

export interface OrderSummary {
  id: number;
  code: string;
  customer_id: number;
  customer: string;
  product: string;
  products: { name: string; quantity: number }[];
  quantity: number;
  order_date: string;
  sky_date: string | null;
  deadline: string;
  priority: string;
  stage: OrderStage;
  stage_label: string;
  on_hold: boolean;
  hold_reason: string | null;
  cancelled: boolean;
  progress: number;
  jobs: JobBrief[];
  current_process: string | null;
  assignees: string[];
  days_left: number;
  risk: DeadlineRisk;
  delayed: boolean;
  delay_reasons: string[];
  shortage: boolean;
  dispatched_qty: number;
  updated_at: string;
}

function riskThresholds() {
  return {
    approachingDays: Number(getSetting('approaching_days', '7')),
    atRiskDays: Number(getSetting('at_risk_days', '2')),
  };
}

/** Production progress = completed units across all jobs / total job units. */
export function orderProgress(jobs: { quantity: number; completed_qty: number }[]): number {
  const total = jobs.reduce((s, j) => s + j.quantity, 0);
  if (!total) return 0;
  return Math.round((jobs.reduce((s, j) => s + j.completed_qty, 0) / total) * 100);
}

/**
 * Build order summaries (used by the pipeline, order cards, master production, dashboard).
 * Everything derived — progress, risk, delay, shortage, current process — is computed here.
 */
export function orderSummaries(opts: { ids?: number[]; includeCancelled?: boolean } = {}): OrderSummary[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.ids) {
    if (!opts.ids.length) return [];
    where.push(`o.id IN (${opts.ids.map(() => '?').join(',')})`);
    params.push(...opts.ids);
  }
  if (!opts.includeCancelled) where.push('o.cancelled_at IS NULL');
  const orders = all(
    `SELECT o.*, c.name AS customer FROM orders o JOIN customers c ON c.id = o.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.deadline, o.id`,
    ...params,
  );
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const ph = ids.map(() => '?').join(',');
  const items = all(
    `SELECT i.order_id, i.quantity, p.name FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id IN (${ph}) ORDER BY i.id`,
    ...ids,
  );
  const jobs = all(
    `SELECT j.id, j.code, j.order_id, j.process_id, j.status, j.quantity, j.completed_qty, j.due_date, j.assigned_to AS assignee_id,
       p.key AS process_key, p.name AS process_name, p.sequence, u.name AS assignee
     FROM jobs j JOIN job_processes p ON p.id = j.process_id LEFT JOIN users u ON u.id = j.assigned_to
     WHERE j.order_id IN (${ph}) ORDER BY p.sequence, j.id`,
    ...ids,
  );
  const dispatched = all<{ order_id: number; qty: number }>(
    `SELECT order_id, SUM(quantity) AS qty FROM dispatches WHERE order_id IN (${ph}) GROUP BY order_id`,
    ...ids,
  );
  const shortages = new Set(
    all<{ order_id: number }>(
      `SELECT DISTINCT r.order_id FROM material_requirements r WHERE r.order_id IN (${ph})`,
      ...ids,
    ).map((r) => r.order_id),
  );
  const labels = Object.fromEntries(all<{ key: string; label: string }>('SELECT key, label FROM order_stages').map((s) => [s.key, s.label]));
  const t = today();
  const th = riskThresholds();

  return orders.map((o) => {
    const its = items.filter((i) => i.order_id === o.id);
    const js: JobBrief[] = jobs
      .filter((j) => j.order_id === o.id)
      .map((j) => ({
        id: j.id,
        code: j.code,
        process_id: j.process_id,
        process_key: j.process_key,
        process_name: j.process_name,
        status: j.status,
        quantity: j.quantity,
        completed_qty: j.completed_qty,
        progress: Math.round((j.completed_qty / j.quantity) * 100),
        assignee_id: j.assignee_id,
        assignee: j.assignee,
        due_date: j.due_date,
        overdue: !!j.due_date && j.status !== 'completed' && j.due_date < t,
      }));
    const progress = orderProgress(js);
    const stage = o.stage as OrderStage;
    const risk = deadlineRisk({ deadline: o.deadline, today: t, stage, progress, orderDate: o.order_date, ...th });
    const delayReasons: string[] = [];
    if (risk === 'overdue') delayReasons.push('Past client deadline');
    if (o.sky_date && o.sky_date < t && stageIndex(stage) < stageIndex('ready_for_dispatch')) delayReasons.push('Past sky date');
    for (const j of js) {
      if (j.status === 'delayed') delayReasons.push(`${j.process_name} marked delayed`);
      else if (j.overdue) delayReasons.push(`${j.process_name} past due date`);
    }
    const shortage = shortages.has(o.id) && stageIndex(stage) < stageIndex('quality_check') && orderMaterials(o.id).some((m) => m.shortage > 0);
    const active = js.find((j) => j.status === 'in_progress' || j.status === 'delayed') ?? js.find((j) => j.status !== 'completed');
    return {
      id: o.id,
      code: o.code,
      customer_id: o.customer_id,
      customer: o.customer,
      product: its.map((i) => i.name).join(', '),
      products: its.map((i) => ({ name: i.name, quantity: i.quantity })),
      quantity: its.reduce((s, i) => s + i.quantity, 0),
      order_date: o.order_date,
      sky_date: o.sky_date,
      deadline: o.deadline,
      priority: o.priority,
      stage,
      stage_label: labels[stage] ?? stage,
      on_hold: !!o.on_hold,
      hold_reason: o.hold_reason,
      cancelled: !!o.cancelled_at,
      progress,
      jobs: js,
      current_process: stage === 'in_production' || stage === 'ready_for_production' ? active?.process_name ?? null : null,
      assignees: [...new Set(js.map((j) => j.assignee).filter(Boolean) as string[])],
      days_left: daysBetween(t, o.deadline),
      risk,
      delayed: delayReasons.length > 0 && stageIndex(stage) < stageIndex('dispatched'),
      delay_reasons: delayReasons,
      shortage,
      dispatched_qty: dispatched.find((d) => d.order_id === o.id)?.qty ?? 0,
      updated_at: o.updated_at,
    };
  });
}

export function orderSummary(id: number): OrderSummary {
  const s = orderSummaries({ ids: [id], includeCancelled: true })[0];
  if (!s) throw notFound('Order');
  return s;
}

// ───────────────────────────── Status engine ─────────────────────────────

export interface TransitionCheck {
  from: OrderStage;
  to: OrderStage;
  allowed: boolean;
  blockers: string[];
  warnings: string[];
}

/**
 * Workflow rules. Forward moves go one stage at a time and must satisfy the stage's gate.
 * Backward moves (e.g. QC rework) go one stage at a time, are admin-only and need a reason.
 */
export function checkTransition(orderId: number, to: OrderStage): TransitionCheck {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw notFound('Order');
  const from = o.stage as OrderStage;
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!ORDER_STAGES.includes(to)) blockers.push('Unknown stage');
  const fi = stageIndex(from);
  const ti = stageIndex(to);
  if (o.cancelled_at) blockers.push('Order is cancelled');
  if (o.on_hold) blockers.push(`Order is on hold${o.hold_reason ? `: ${o.hold_reason}` : ''} — resume it first`);
  if (ti === fi) blockers.push('Order is already in this stage');
  else if (Math.abs(ti - fi) > 1) blockers.push('Stages cannot be skipped — move one stage at a time');

  const jobs = all('SELECT j.*, p.name AS process_name FROM jobs j JOIN job_processes p ON p.id=j.process_id WHERE j.order_id=?', orderId);
  const checklist = (stage: string) => all('SELECT * FROM order_checklist_items WHERE order_id=? AND stage=?', orderId, stage);

  if (ti === fi + 1) {
    switch (to) {
      case 'preparing':
        if (!get('SELECT 1 FROM order_items WHERE order_id=?', orderId)) blockers.push('Order has no products');
        break;
      case 'ready_for_production': {
        if (!jobs.length) blockers.push('No job sheets exist for this order');
        for (const j of jobs) {
          if (!j.assigned_to) blockers.push(`${j.process_name} (${j.code}) has no assigned staff`);
          if (!j.due_date) warnings.push(`${j.process_name} (${j.code}) has no due date`);
        }
        const open = checklist('preparing').filter((c) => !c.done);
        if (open.length) warnings.push(`${open.length} preparation checklist item(s) not ticked`);
        const short = orderMaterials(orderId).filter((m) => m.shortage > 0);
        for (const m of short) warnings.push(`Material shortage: ${m.material_name} short by ${m.shortage} ${m.unit}`);
        break;
      }
      case 'in_production':
        if (jobs.some((j) => j.status === 'on_hold')) warnings.push('Some job sheets are on hold');
        break;
      case 'quality_check': {
        const open = jobs.filter((j) => j.status !== 'completed');
        for (const j of open) blockers.push(`${j.process_name} is ${j.completed_qty}/${j.quantity} — job sheet not completed`);
        break;
      }
      case 'ready_for_dispatch': {
        const qc = get('SELECT * FROM quality_checks WHERE order_id=? ORDER BY id DESC LIMIT 1', orderId);
        if (!qc) blockers.push('Record a quality check first');
        else if (qc.result !== 'passed') blockers.push(`Latest quality check result is "${qc.result}"`);
        break;
      }
      case 'dispatched':
        if (!get('SELECT 1 FROM dispatches WHERE order_id=?', orderId)) blockers.push('Record a dispatch (date, transporter, quantity) first');
        {
          const open = checklist('ready_for_dispatch').filter((c) => !c.done);
          if (open.length) warnings.push(`${open.length} dispatch readiness item(s) not ticked`);
        }
        break;
      case 'completed': {
        const qty = get<{ q: number }>('SELECT COALESCE(SUM(quantity),0) AS q FROM order_items WHERE order_id=?', orderId)!.q;
        const sent = get<{ q: number }>('SELECT COALESCE(SUM(quantity),0) AS q FROM dispatches WHERE order_id=?', orderId)!.q;
        if (sent < qty) warnings.push(`Only ${sent} of ${qty} units dispatched — completing will close the balance short`);
        break;
      }
    }
  }
  return { from, to, allowed: blockers.length === 0, blockers, warnings };
}

export interface TransitionOpts {
  actorId: number | null;
  actorRole?: 'admin' | 'staff' | 'system';
  note?: string | null;
  acknowledgeWarnings?: boolean;
  automatic?: boolean;
}

export function transition(orderId: number, to: OrderStage, opts: TransitionOpts) {
  return tx(() => {
    const check = checkTransition(orderId, to);
    if (!check.allowed) throw conflict(check.blockers[0], check);
    const backward = stageIndex(to) < stageIndex(check.from);
    if (backward) {
      if (opts.actorRole === 'staff') throw conflict('Only an admin can move an order back a stage');
      if (!opts.note?.trim()) throw badRequest('A reason is required to move an order back a stage');
    }
    if (check.warnings.length && !opts.acknowledgeWarnings && !opts.automatic) throw conflict('Please review the warnings before continuing', check);

    const o = get('SELECT * FROM orders WHERE id=?', orderId)!;
    run('UPDATE orders SET stage=?, updated_at=? WHERE id=?', to, nowIso(), orderId);
    insert(
      'INSERT INTO order_status_history (order_id, from_stage, to_stage, event, note, changed_by, created_at) VALUES (?,?,?,?,?,?,?)',
      orderId,
      check.from,
      to,
      backward ? 'rollback' : 'transition',
      [opts.note, check.warnings.length ? `Acknowledged: ${check.warnings.join('; ')}` : null].filter(Boolean).join(' — ') || null,
      opts.actorId,
      nowIso(),
    );
    logActivity({
      actorId: opts.actorId,
      entityType: 'order',
      entityId: orderId,
      orderId,
      action: backward ? 'stage_rollback' : 'stage_change',
      field: 'stage',
      oldValue: stageLabel(check.from),
      newValue: stageLabel(to),
      message: `Order ${o.code} status ${stageLabel(check.from)} → ${stageLabel(to)}${opts.note ? ` (${opts.note})` : ''}`,
    });
    onEnterStage(orderId, to, opts.actorId);
    if (['dispatched', 'completed', 'ready_for_dispatch'].includes(to)) {
      notifyAdmins({
        type: 'stage_changed',
        severity: 'info',
        title: `${o.code} is ${stageLabel(to)}`,
        body: `${o.code} moved from ${stageLabel(check.from)} to ${stageLabel(to)}.`,
        orderId,
        dedupeKey: `stage:${orderId}:${to}:${Date.now()}`,
      });
    }
    return check;
  });
}

const PREP_CHECKLIST = [
  'Product details & drawings confirmed with client',
  'Quantity confirmed',
  'Material requirements checked against stock',
  'Staff assigned to every process',
  'Production dates planned',
];
const DISPATCH_CHECKLIST = ['Packaging completed', 'Labels / carton marking done', 'Invoice prepared', 'E-way bill generated', 'Final photos taken'];

function seedChecklist(orderId: number, stage: string, items: string[]) {
  if (get('SELECT 1 FROM order_checklist_items WHERE order_id=? AND stage=?', orderId, stage)) return;
  items.forEach((label, i) =>
    insert('INSERT INTO order_checklist_items (order_id, stage, label, sequence) VALUES (?,?,?,?)', orderId, stage, label, i),
  );
}

function onEnterStage(orderId: number, stage: OrderStage, actorId: number | null) {
  if (stage === 'preparing') {
    seedChecklist(orderId, 'preparing', PREP_CHECKLIST);
    const got = allocateForOrder(orderId, null);
    if (got.length)
      logActivity({
        actorId: null,
        entityType: 'order',
        entityId: orderId,
        orderId,
        action: 'materials_reserved',
        message: `Materials reserved: ${got.map((g) => `${g.qty} ${g.unit} ${g.material}`).join(', ')}`,
      });
  }
  if (stage === 'ready_for_dispatch') seedChecklist(orderId, 'ready_for_dispatch', DISPATCH_CHECKLIST);
  if (stage === 'completed') releaseOrderReservations(orderId, actorId, 'Order completed — unused reservation released');
}

/** Called by the system after job activity: advances the order when its gate is met. */
export function autoAdvance(orderId: number) {
  const o = get('SELECT stage, on_hold, cancelled_at FROM orders WHERE id=?', orderId);
  if (!o || o.on_hold || o.cancelled_at) return;
  const jobs = all('SELECT status, completed_qty FROM jobs WHERE order_id=?', orderId);
  const started = jobs.some((j) => j.completed_qty > 0 || j.status === 'in_progress');
  const attempt = (to: OrderStage, note: string) => {
    const c = checkTransition(orderId, to);
    if (!c.allowed) return false;
    transition(orderId, to, { actorId: null, automatic: true, note });
    return true;
  };
  let stage = o.stage as OrderStage;
  if (started && stage === 'preparing' && attempt('ready_for_production', 'Production started on the floor')) stage = 'ready_for_production';
  if (started && stage === 'ready_for_production' && attempt('in_production', 'First job sheet update received')) stage = 'in_production';
  if (stage === 'in_production' && jobs.length && jobs.every((j) => j.status === 'completed')) {
    attempt('quality_check', 'All job sheets completed');
  }
}

export function setHold(orderId: number, hold: boolean, reason: string | null, actorId: number) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw notFound('Order');
  if (o.cancelled_at) throw conflict('Order is cancelled');
  if (!!o.on_hold === hold) throw conflict(hold ? 'Order is already on hold' : 'Order is not on hold');
  if (hold && !reason?.trim()) throw badRequest('A reason is required to put an order on hold');
  tx(() => {
    run('UPDATE orders SET on_hold=?, hold_reason=?, updated_at=? WHERE id=?', hold ? 1 : 0, hold ? reason : null, nowIso(), orderId);
    insert(
      'INSERT INTO order_status_history (order_id, from_stage, to_stage, event, note, changed_by, created_at) VALUES (?,?,?,?,?,?,?)',
      orderId,
      o.stage,
      o.stage,
      hold ? 'hold' : 'resume',
      reason,
      actorId,
      nowIso(),
    );
    logActivity({
      actorId,
      entityType: 'order',
      entityId: orderId,
      orderId,
      action: hold ? 'hold' : 'resume',
      message: hold ? `Order ${o.code} put ON HOLD: ${reason}` : `Order ${o.code} resumed${reason ? `: ${reason}` : ''}`,
    });
  });
}

export function cancelOrder(orderId: number, reason: string, actorId: number) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) throw notFound('Order');
  if (o.cancelled_at) throw conflict('Order is already cancelled');
  if (stageIndex(o.stage) >= stageIndex('dispatched')) throw conflict('A dispatched order cannot be cancelled');
  if (!reason?.trim()) throw badRequest('A cancellation reason is required');
  tx(() => {
    run('UPDATE orders SET cancelled_at=?, cancel_reason=?, updated_at=? WHERE id=?', nowIso(), reason, nowIso(), orderId);
    insert(
      'INSERT INTO order_status_history (order_id, from_stage, to_stage, event, note, changed_by, created_at) VALUES (?,?,?,?,?,?,?)',
      orderId,
      o.stage,
      o.stage,
      'cancel',
      reason,
      actorId,
      nowIso(),
    );
    releaseOrderReservations(orderId, actorId, 'Order cancelled');
    logActivity({ actorId, entityType: 'order', entityId: orderId, orderId, action: 'cancel', message: `Order ${o.code} CANCELLED: ${reason}` });
  });
}

export function nextOrderCode(): string {
  const prefix = getSetting('order_prefix', 'UM-');
  const last = get<{ n: number }>(
    `SELECT MAX(CAST(SUBSTR(code, ?) AS INTEGER)) AS n FROM orders WHERE code LIKE ?`,
    prefix.length + 1,
    prefix + '%',
  );
  return `${prefix}${Math.max(1000, last?.n ?? 1000) + 1}`;
}

export function nextJobCode(): string {
  const last = get<{ n: number }>(`SELECT MAX(CAST(SUBSTR(code, 5) AS INTEGER)) AS n FROM jobs WHERE code LIKE 'JOB-%'`);
  return `JOB-${String((last?.n ?? 0) + 1).padStart(3, '0')}`;
}
