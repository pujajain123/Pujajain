import { all, get, insert, run, tx } from '../db.ts';
import { JOB_STATUS_LABELS, type JobStatus, stageIndex } from '../../shared/domain.ts';
import { badRequest, conflict, forbidden, notFound, nowIso, round, today } from '../lib.ts';
import type { AuthUser } from '../auth.ts';
import { logActivity, logFieldChanges } from './activity.ts';
import { autoAdvance, orderProgress } from './orders.ts';
import { postTxn } from './inventory.ts';
import { notifyAdmins, notifyUser } from './notifications.ts';

export function jobRow(id: number) {
  const j = get(
    `SELECT j.*, p.key AS process_key, p.name AS process_name, p.fields_json, p.material_category,
       o.code AS order_code, o.stage AS order_stage, o.deadline AS order_deadline, o.sky_date AS order_sky_date, o.priority,
       o.on_hold AS order_on_hold, o.cancelled_at AS order_cancelled_at,
       c.name AS customer, pr.name AS product, pr.sku AS product_sku, i.dimensions, i.finish, i.color, i.specifications,
       u.name AS assignee
     FROM jobs j JOIN job_processes p ON p.id = j.process_id JOIN orders o ON o.id = j.order_id
     JOIN customers c ON c.id = o.customer_id JOIN order_items i ON i.id = j.order_item_id JOIN products pr ON pr.id = i.product_id
     LEFT JOIN users u ON u.id = j.assigned_to WHERE j.id = ?`,
    id,
  );
  if (!j) throw notFound('Job sheet');
  return j;
}

/** Material linked to a job: the order's requirement for that item + process. */
export function jobMaterial(job: { order_id: number; order_item_id: number; process_id: number }) {
  return get(
    `SELECT r.material_id, SUM(r.required_qty) AS required, m.name, m.code, m.unit, m.variant, m.color
     FROM material_requirements r JOIN materials m ON m.id = r.material_id
     WHERE r.order_id = ? AND r.process_id = ? AND (r.order_item_id = ? OR r.order_item_id IS NULL)
     GROUP BY r.material_id ORDER BY required DESC LIMIT 1`,
    job.order_id,
    job.process_id,
    job.order_item_id,
  );
}

export interface JobUpdateInput {
  completed_qty?: number;
  status?: JobStatus;
  material_used?: number;
  wastage?: number;
  note?: string;
  delay_reason?: string;
  specs?: Record<string, unknown>;
}

/**
 * The single staff action "SAVE UPDATE". From one input it:
 *  records the job update, posts material consumption/wastage to the ledger,
 *  derives job status, recalculates order progress, advances the order lifecycle,
 *  writes the audit trail and raises notifications.
 */
export function updateJob(jobId: number, input: JobUpdateInput, user: AuthUser) {
  return tx(() => {
    const j = jobRow(jobId);
    if (user.role !== 'admin' && j.assigned_to !== user.id) throw forbidden('This job sheet is not assigned to you');
    if (j.order_cancelled_at) throw conflict('The order is cancelled');
    if (j.order_on_hold && user.role !== 'admin') throw conflict('The order is on hold — check with the admin');
    if (stageIndex(j.order_stage) < stageIndex('preparing')) throw conflict('Production updates open once the order is being prepared');
    if (stageIndex(j.order_stage) >= stageIndex('ready_for_dispatch') && user.role !== 'admin')
      throw conflict('The order has passed production; only an admin can change this job sheet');

    const before = { completed_qty: j.completed_qty, status: j.status as JobStatus };
    let qty = input.completed_qty ?? j.completed_qty;
    if (!Number.isInteger(qty) || qty < 0 || qty > j.quantity) throw badRequest(`Completed quantity must be between 0 and ${j.quantity}`);
    if (qty < j.completed_qty && user.role !== 'admin') throw badRequest('Completed quantity cannot go down — ask an admin to correct it');

    // Derive status: explicit hold/delay wins, otherwise follow the numbers.
    let status: JobStatus = input.status ?? j.status;
    if (input.status === 'completed' && qty < j.quantity) {
      if (input.completed_qty === undefined) qty = j.quantity;
      else throw badRequest(`Mark all ${j.quantity} units done to complete the job`);
    }
    if (qty === j.quantity) status = 'completed';
    else if (status === 'completed') status = qty > 0 ? 'in_progress' : 'not_started';
    else if (qty > 0 && status === 'not_started') status = 'in_progress';
    if (status === 'delayed' && !(input.delay_reason ?? j.delay_reason)?.trim()) throw badRequest('Please give a reason for the delay');

    const now = nowIso();
    const startedAt = j.started_at ?? (qty > 0 || status === 'in_progress' ? now : null);
    const completedAt = status === 'completed' ? (j.completed_at ?? now) : null;
    const specs = input.specs ? JSON.stringify({ ...JSON.parse(j.specs_json || '{}'), ...input.specs }) : j.specs_json;
    run(
      `UPDATE jobs SET completed_qty=?, status=?, started_at=?, completed_at=?, delay_reason=?, specs_json=?, updated_at=? WHERE id=?`,
      qty,
      status,
      startedAt,
      completedAt,
      status === 'delayed' ? (input.delay_reason ?? j.delay_reason) : status === 'completed' ? null : (input.delay_reason ?? j.delay_reason),
      specs,
      now,
      jobId,
    );

    // Material movements go to the ledger — never typed into a balance.
    const mat = jobMaterial(j);
    for (const [kind, amount] of [
      ['consumption', input.material_used],
      ['wastage', input.wastage],
    ] as const) {
      if (!amount) continue;
      if (amount < 0) throw badRequest('Material quantities cannot be negative');
      if (!mat) throw badRequest(`No material requirement is linked to ${j.process_name} on ${j.order_code}`);
      postTxn({
        materialId: mat.material_id,
        type: kind,
        quantity: amount,
        orderId: j.order_id,
        jobId,
        userId: user.id,
        notes: `${j.code} ${j.process_name}`,
      });
    }

    insert(
      `INSERT INTO job_updates (job_id, user_id, qty_before, qty_after, status_before, status_after, material_used, wastage, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      jobId,
      user.id,
      before.completed_qty,
      qty,
      before.status,
      status,
      input.material_used ?? null,
      input.wastage ?? null,
      input.note?.trim() || null,
      now,
    );

    const label = `${j.process_name} (${j.code}, ${j.order_code})`;
    const pct = (n: number) => `${Math.round((n / j.quantity) * 100)}%`;
    if (qty !== before.completed_qty)
      logActivity({
        actorId: user.id,
        entityType: 'job',
        entityId: jobId,
        orderId: j.order_id,
        jobId,
        action: 'progress',
        field: 'completed_qty',
        oldValue: before.completed_qty,
        newValue: qty,
        message: `${label} updated ${before.completed_qty}/${j.quantity} → ${qty}/${j.quantity} (${pct(before.completed_qty)} → ${pct(qty)})`,
      });
    if (status !== before.status)
      logActivity({
        actorId: user.id,
        entityType: 'job',
        entityId: jobId,
        orderId: j.order_id,
        jobId,
        action: 'status',
        field: 'status',
        oldValue: JOB_STATUS_LABELS[before.status],
        newValue: JOB_STATUS_LABELS[status],
        message: `${label} marked ${JOB_STATUS_LABELS[status]}${status === 'delayed' ? ` — ${input.delay_reason ?? j.delay_reason}` : ''}`,
      });
    if (input.note?.trim())
      logActivity({ actorId: user.id, entityType: 'job', entityId: jobId, orderId: j.order_id, jobId, action: 'note', message: `${label} note: ${input.note.trim()}` });

    // Order-level roll up.
    const jobsAfter = all('SELECT quantity, completed_qty FROM jobs WHERE order_id=?', j.order_id);
    const oldProgress = orderProgress(
      all('SELECT id, quantity, completed_qty FROM jobs WHERE order_id=?', j.order_id).map((x: any) =>
        x.id === jobId ? { ...x, completed_qty: before.completed_qty } : x,
      ),
    );
    const newProgress = orderProgress(jobsAfter);
    if (oldProgress !== newProgress) {
      run('UPDATE orders SET updated_at=? WHERE id=?', now, j.order_id);
      logActivity({
        actorId: null,
        entityType: 'order',
        entityId: j.order_id,
        orderId: j.order_id,
        action: 'progress',
        field: 'progress',
        oldValue: `${oldProgress}%`,
        newValue: `${newProgress}%`,
        message: `Order ${j.order_code} production progress updated ${oldProgress}% → ${newProgress}%`,
      });
    }

    if (status === 'completed' && before.status !== 'completed') {
      notifyAdmins({
        type: 'job_completed',
        severity: 'info',
        title: `${j.process_name} completed on ${j.order_code}`,
        body: `${j.code} · ${j.quantity} units · ${j.customer}${j.assignee ? ` · by ${j.assignee}` : ''}`,
        orderId: j.order_id,
        jobId,
        dedupeKey: `job_completed:${jobId}:${now}`,
      });
    }
    if (status === 'delayed' && before.status !== 'delayed') {
      notifyAdmins({
        type: 'job_delayed',
        severity: 'warning',
        title: `${j.process_name} delayed on ${j.order_code}`,
        body: input.delay_reason ?? j.delay_reason,
        orderId: j.order_id,
        jobId,
        dedupeKey: `job_delayed:${jobId}:${now}`,
      });
    }

    autoAdvance(j.order_id);
    return jobRow(jobId);
  });
}

const ADMIN_JOB_FIELDS = {
  assigned_to: 'Assigned staff',
  start_date: 'Planned start',
  due_date: 'Due date',
  quantity: 'Quantity',
  notes: 'Notes',
} as const;

/** Admin edits planning fields; staff may edit notes/specs on their own job. */
export function editJob(
  jobId: number,
  patch: Partial<{ assigned_to: number | null; start_date: string | null; due_date: string | null; quantity: number; notes: string | null; specs: Record<string, unknown> }>,
  user: AuthUser,
) {
  return tx(() => {
    const j = jobRow(jobId);
    const admin = user.role === 'admin';
    if (!admin) {
      if (j.assigned_to !== user.id) throw forbidden('This job sheet is not assigned to you');
      const allowed = ['notes', 'specs'];
      if (Object.keys(patch).some((k) => !allowed.includes(k))) throw forbidden('Only notes and process details can be edited by staff');
    }
    if (patch.quantity !== undefined && patch.quantity < j.completed_qty) throw badRequest(`Quantity cannot be below the ${j.completed_qty} units already completed`);
    if (patch.start_date && (patch.due_date ?? j.due_date) && patch.start_date > (patch.due_date ?? j.due_date))
      throw badRequest('Start date must be before the due date');
    if (patch.assigned_to) {
      const u = get(`SELECT u.id FROM users u WHERE u.id=? AND u.active=1`, patch.assigned_to);
      if (!u) throw badRequest('Assigned staff member not found');
    }
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of Object.keys(ADMIN_JOB_FIELDS) as (keyof typeof ADMIN_JOB_FIELDS)[]) {
      if (k in patch) (sets.push(`${k}=?`), vals.push((patch as any)[k] ?? null));
    }
    if (patch.specs) (sets.push('specs_json=?'), vals.push(JSON.stringify({ ...JSON.parse(j.specs_json || '{}'), ...patch.specs })));
    if (!sets.length) return j;
    sets.push('updated_at=?');
    vals.push(nowIso());
    run(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?`, ...vals, jobId);
    if (patch.quantity !== undefined && patch.quantity === j.completed_qty && j.status !== 'completed')
      run(`UPDATE jobs SET status='completed', completed_at=? WHERE id=?`, nowIso(), jobId);

    const label = `${j.process_name} (${j.code}, ${j.order_code})`;
    const names = (id: number | null) => (id ? get('SELECT name FROM users WHERE id=?', id)?.name : null);
    logFieldChanges(
      { actorId: user.id, entityType: 'job', entityId: jobId, orderId: j.order_id, jobId, label },
      { ...j, assigned_to: names(j.assigned_to) },
      { ...patch, ...('assigned_to' in patch ? { assigned_to: names(patch.assigned_to ?? null) } : {}) },
      ADMIN_JOB_FIELDS,
    );
    if (patch.specs) {
      const old = JSON.parse(j.specs_json || '{}');
      const changed = Object.entries(patch.specs).filter(([k, v]) => String(old[k] ?? '') !== String(v ?? ''));
      if (changed.length)
        logActivity({
          actorId: user.id,
          entityType: 'job',
          entityId: jobId,
          orderId: j.order_id,
          jobId,
          action: 'specs',
          message: `${label} details updated: ${changed.map(([k, v]) => `${k} → ${v || '—'}`).join(', ')}`,
        });
    }
    if ('assigned_to' in patch && patch.assigned_to !== j.assigned_to) {
      run('UPDATE staff_assignments SET unassigned_at=? WHERE job_id=? AND unassigned_at IS NULL', nowIso(), jobId);
      if (patch.assigned_to) {
        insert('INSERT INTO staff_assignments (job_id, user_id, assigned_by, assigned_at) VALUES (?,?,?,?)', jobId, patch.assigned_to, user.id, nowIso());
        notifyUser(patch.assigned_to, {
          type: 'job_assigned',
          severity: 'info',
          title: `New job: ${j.process_name} for ${j.order_code}`,
          body: `${j.code} · ${j.product} × ${patch.quantity ?? j.quantity} · due ${patch.due_date ?? j.due_date ?? j.order_deadline}`,
          orderId: j.order_id,
          jobId,
          dedupeKey: `assigned:${jobId}:${patch.assigned_to}:${nowIso()}`,
        });
      }
    }
    autoAdvance(j.order_id);
    return jobRow(jobId);
  });
}

/** Job sheet list with filters (used by the Job Sheets module and My Jobs). */
export function listJobs(f: {
  q?: string;
  process?: string;
  staff?: number;
  status?: string;
  order?: number;
  overdue?: boolean;
  due?: 'today' | 'week' | 'overdue';
  includeClosed?: boolean;
}) {
  const where = ['o.cancelled_at IS NULL'];
  const p: any[] = [];
  const t = today();
  if (f.q) {
    where.push('(j.code LIKE ? OR o.code LIKE ? OR c.name LIKE ? OR pr.name LIKE ? OR u.name LIKE ?)');
    p.push(...Array(5).fill(`%${f.q}%`));
  }
  if (f.process) (where.push('pp.key = ?'), p.push(f.process));
  if (f.staff) (where.push('j.assigned_to = ?'), p.push(f.staff));
  if (f.status === 'open') where.push(`j.status != 'completed'`);
  else if (f.status) (where.push('j.status = ?'), p.push(f.status));
  if (f.order) (where.push('j.order_id = ?'), p.push(f.order));
  if (f.overdue || f.due === 'overdue') (where.push(`j.status != 'completed' AND j.due_date < ?`), p.push(t));
  if (f.due === 'today') (where.push(`j.due_date = ?`), p.push(t));
  if (f.due === 'week') (where.push(`j.due_date BETWEEN ? AND date(?, '+7 day')`), p.push(t, t));
  if (!f.includeClosed && !f.status) where.push(`o.stage NOT IN ('completed')`);
  return all(
    `SELECT j.id, j.code, j.order_id, o.code AS order_code, c.name AS customer, pr.name AS product, pp.key AS process_key, pp.name AS process_name,
       j.quantity, j.completed_qty, CAST(ROUND(j.completed_qty * 100.0 / j.quantity) AS INTEGER) AS progress, j.status, j.assigned_to, u.name AS assignee,
       j.start_date, j.due_date, o.deadline AS order_deadline, o.priority, o.stage AS order_stage, j.updated_at,
       (j.status != 'completed' AND j.due_date IS NOT NULL AND j.due_date < ?) AS overdue
     FROM jobs j JOIN orders o ON o.id = j.order_id JOIN customers c ON c.id = o.customer_id
     JOIN order_items i ON i.id = j.order_item_id JOIN products pr ON pr.id = i.product_id
     JOIN job_processes pp ON pp.id = j.process_id LEFT JOIN users u ON u.id = j.assigned_to
     WHERE ${where.join(' AND ')}
     ORDER BY (j.status = 'completed'), COALESCE(j.due_date, o.deadline), pp.sequence`,
    t,
    ...p,
  ).map((r) => ({ ...r, overdue: !!r.overdue }));
}

export function jobDetail(jobId: number) {
  const j = jobRow(jobId);
  const mat = jobMaterial(j);
  let material = null;
  if (mat) {
    const used = get(
      `SELECT COALESCE(SUM(CASE WHEN type='consumption' THEN quantity END),0) AS consumed, COALESCE(SUM(CASE WHEN type='wastage' THEN quantity END),0) AS wastage
       FROM inventory_transactions WHERE job_id=? AND material_id=?`,
      jobId,
      mat.material_id,
    )!;
    const inv = get('SELECT available, on_hand FROM inventory WHERE material_id=?', mat.material_id)!;
    material = {
      ...mat,
      required: round(mat.required),
      consumed: round(used.consumed),
      wastage: round(used.wastage),
      remaining: round(Math.max(0, mat.required - used.consumed)),
      store_available: round(inv.available),
      store_on_hand: round(inv.on_hand),
    };
  }
  const updates = all(
    `SELECT ju.*, u.name AS user_name FROM job_updates ju LEFT JOIN users u ON u.id = ju.user_id WHERE ju.job_id = ? ORDER BY ju.id DESC`,
    jobId,
  );
  const activity = all(
    `SELECT a.*, u.name AS actor FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.job_id = ? ORDER BY a.id DESC LIMIT 100`,
    jobId,
  );
  const assignments = all(
    `SELECT s.*, u.name AS user_name, b.name AS assigned_by_name FROM staff_assignments s JOIN users u ON u.id = s.user_id
     LEFT JOIN users b ON b.id = s.assigned_by WHERE s.job_id = ? ORDER BY s.id DESC`,
    jobId,
  );
  const siblings = all(
    `SELECT j.id, j.code, p.name AS process_name, j.status, j.completed_qty, j.quantity FROM jobs j JOIN job_processes p ON p.id = j.process_id
     WHERE j.order_id = ? ORDER BY p.sequence`,
    j.order_id,
  );
  const fields = JSON.parse(j.fields_json || '[]');
  const { fields_json: _f, ...rest } = j;
  return {
    ...rest,
    specs: JSON.parse(j.specs_json || '{}'),
    fields,
    progress: Math.round((j.completed_qty / j.quantity) * 100),
    remaining: j.quantity - j.completed_qty,
    overdue: !!j.due_date && j.status !== 'completed' && j.due_date < today(),
    material,
    updates,
    activity,
    assignments,
    siblings,
  };
}
