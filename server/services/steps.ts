import { all, get, insert, run, tx } from '../db.ts';
import { badRequest, conflict, forbidden, notFound, nowIso, today } from '../lib.ts';
import { daysBetween, JOB_STATUS_LABELS } from '../../shared/domain.ts';
import { autoAdvance } from './orders.ts';
import type { AuthUser } from '../auth.ts';
import { logActivity } from './activity.ts';
import { notifyAdmins } from './notifications.ts';

export const WORK_STATUSES = ['not_started', 'in_progress', 'done', 'not_required'] as const;
export const QC_STATUSES = ['pending', 'approved', 'rejected', 'not_required'] as const;
export const MATERIAL_KINDS = ['metal', 'rope', 'fabric', 'foam', 'tile'] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];
export const MATERIAL_LABELS: Record<MaterialKind, string> = { metal: 'Metal', rope: 'Rope', fabric: 'Fabric', foam: 'Foam', tile: 'Tile / stone' };

export const STEP_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
  not_required: 'Not required',
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

const finished = (s: { kind: string; status: string }) => (s.kind === 'work' ? ['done', 'not_required'] : ['approved', 'not_required']).includes(s.status);

/** Create the step list (and checklist) for a new job from its process definition. */
export function seedJobSteps(jobId: number, processId: number, initial: Record<string, string> = {}) {
  const p = get<{ steps_json: string; checklist_json: string }>('SELECT steps_json, checklist_json FROM job_processes WHERE id=?', processId)!;
  const steps = JSON.parse(p.steps_json || '[]') as { key: string; label: string; kind: 'work' | 'qc' }[];
  steps.forEach((s, i) =>
    insert(
      'INSERT OR IGNORE INTO job_steps (job_id, key, label, kind, sequence, status, updated_at) VALUES (?,?,?,?,?,?,?)',
      jobId, s.key, s.label, s.kind, i, initial[s.key] ?? (s.kind === 'work' ? 'not_started' : 'pending'), nowIso(),
    ),
  );
  (JSON.parse(p.checklist_json || '[]') as { key: string; label: string }[]).forEach((c, i) =>
    insert('INSERT OR IGNORE INTO job_checklist (job_id, key, label, sequence) VALUES (?,?,?,?)', jobId, c.key, c.label, i),
  );
}

export function jobSteps(jobId: number) {
  return all(
    `SELECT s.*, u.name AS updated_by_name FROM job_steps s LEFT JOIN users u ON u.id = s.updated_by WHERE s.job_id=? ORDER BY s.sequence`,
    jobId,
  );
}

export function jobChecklist(jobId: number) {
  return all(`SELECT c.*, u.name AS done_by_name FROM job_checklist c LEFT JOIN users u ON u.id = c.done_by WHERE c.job_id=? ORDER BY c.sequence`, jobId);
}

/** True when every step is finished (work done, QC approved, or not required). */
export function stepsComplete(jobId: number) {
  return all<{ kind: string; status: string }>('SELECT kind, status FROM job_steps WHERE job_id=?', jobId).every(finished);
}

/** Why a step cannot move to `status` yet, or null if it can. */
export function stepBlocker(jobId: number, key: string, status: string): string | null {
  const steps = all('SELECT * FROM job_steps WHERE job_id=? ORDER BY sequence', jobId);
  const i = steps.findIndex((s) => s.key === key);
  if (i < 0) return 'Unknown step';
  const step = steps[i];
  if (step.kind === 'work' && ['in_progress', 'done'].includes(status)) {
    const gate = steps.slice(0, i).reverse().find((s) => s.kind === 'qc' && !finished(s));
    if (gate) return `${gate.label} must be approved before ${step.label} can start`;
    const prevWork = steps.slice(0, i).reverse().find((s) => s.kind === 'work' && !finished(s));
    if (prevWork) return `${prevWork.label} is not finished yet`;
  }
  if (step.kind === 'qc' && ['approved', 'rejected'].includes(status)) {
    const work = steps.slice(0, i).reverse().find((s) => s.kind === 'work');
    if (work && !finished(work)) return `Finish ${work.label} before recording its inspection`;
  }
  return null;
}

/**
 * Update one production step or QC gate. Enforces the gate order, records who did it,
 * and re-derives the job status (a job completes only when units AND every QC are done).
 */
export function updateStep(jobId: number, key: string, status: string, note: string | null, user: AuthUser) {
  return tx(() => {
    const job = get(
      `SELECT j.*, p.name AS process_name, o.code AS order_code, o.cancelled_at, o.on_hold FROM jobs j JOIN job_processes p ON p.id=j.process_id JOIN orders o ON o.id=j.order_id WHERE j.id=?`,
      jobId,
    );
    if (!job) throw notFound('Job sheet');
    if (user.role !== 'admin' && job.assigned_to !== user.id) throw forbidden('This job sheet is not assigned to you');
    if (job.cancelled_at) throw conflict('The order is cancelled');
    if (job.on_hold && user.role !== 'admin') throw conflict('The order is on hold — check with the admin');
    const step = get('SELECT * FROM job_steps WHERE job_id=? AND key=?', jobId, key);
    if (!step) throw notFound('Step');
    const allowed: readonly string[] = step.kind === 'work' ? WORK_STATUSES : QC_STATUSES;
    if (!allowed.includes(status)) throw badRequest('Invalid status for this step');
    if (status === 'not_required' && user.role !== 'admin') throw forbidden('Only an admin can mark a step as not required');
    if (status === 'rejected' && !note?.trim()) throw badRequest('Describe what failed so it can be reworked');
    const blocker = stepBlocker(jobId, key, status);
    if (blocker) throw conflict(blocker);
    if (step.status === status && !note) return;

    run('UPDATE job_steps SET status=?, note=COALESCE(?, note), updated_by=?, updated_at=? WHERE id=?', status, note?.trim() || null, user.id, nowIso(), step.id);
    // A rejected inspection sends the work step before it back to "in progress".
    if (status === 'rejected') {
      const work = all('SELECT * FROM job_steps WHERE job_id=? AND kind=? AND sequence<? ORDER BY sequence DESC LIMIT 1', jobId, 'work', step.sequence)[0];
      if (work) run(`UPDATE job_steps SET status='in_progress', updated_by=?, updated_at=? WHERE id=?`, user.id, nowIso(), work.id);
    }
    logActivity({
      actorId: user.id,
      entityType: 'job',
      entityId: jobId,
      orderId: job.order_id,
      jobId,
      action: step.kind === 'qc' ? 'qc' : 'step',
      field: key,
      oldValue: STEP_LABEL[step.status],
      newValue: STEP_LABEL[status],
      message: `${job.process_name} (${job.code}, ${job.order_code}): ${step.label} ${STEP_LABEL[step.status]} → ${STEP_LABEL[status]}${note ? ` — ${note}` : ''}`,
    });
    if (status === 'rejected')
      notifyAdmins({
        type: 'qc_rejected',
        severity: 'warning',
        title: `${step.label} rejected on ${job.order_code}`,
        body: note ?? '',
        orderId: job.order_id,
        jobId,
        dedupeKey: `qc_rejected:${step.id}:${nowIso()}`,
      });
    syncJobStatus(jobId, user.id);
  });
}

/** Re-derive job status from units + steps after a step change. */
export function syncJobStatus(jobId: number, actorId: number | null) {
  const j = get('SELECT * FROM jobs WHERE id=?', jobId)!;
  if (['on_hold', 'delayed'].includes(j.status)) return;
  const steps = all('SELECT kind, status FROM job_steps WHERE job_id=?', jobId);
  const anyStarted = steps.some((s) => s.kind === 'work' && ['in_progress', 'done'].includes(s.status));
  let next = j.status;
  if (j.completed_qty === j.quantity && stepsComplete(jobId)) next = 'completed';
  else if (anyStarted || j.completed_qty > 0) next = 'in_progress';
  else next = 'not_started';
  if (next !== j.status) {
    run(
      `UPDATE jobs SET status=?, started_at=COALESCE(started_at, ?), completed_at=?, updated_at=? WHERE id=?`,
      next,
      next !== 'not_started' ? nowIso() : null,
      next === 'completed' ? nowIso() : null,
      nowIso(),
      jobId,
    );
    logActivity({ actorId: null, entityType: 'job', entityId: jobId, orderId: j.order_id, jobId, action: 'status', field: 'status', oldValue: (JOB_STATUS_LABELS as any)[j.status], newValue: (JOB_STATUS_LABELS as any)[next], message: `${j.code} is now ${(JOB_STATUS_LABELS as any)[next]}` });
  }
  void actorId;
  autoAdvance(j.order_id);
}

export function toggleChecklist(jobId: number, key: string, done: boolean, user: AuthUser) {
  const job = get('SELECT j.*, o.code AS order_code FROM jobs j JOIN orders o ON o.id=j.order_id WHERE j.id=?', jobId);
  if (!job) throw notFound('Job sheet');
  if (user.role !== 'admin' && job.assigned_to !== user.id) throw forbidden('This job sheet is not assigned to you');
  const c = get('SELECT * FROM job_checklist WHERE job_id=? AND key=?', jobId, key);
  if (!c) throw notFound('Checklist item');
  run('UPDATE job_checklist SET done=?, done_by=?, done_at=? WHERE id=?', done ? 1 : 0, done ? user.id : null, done ? nowIso() : null, c.id);
  logActivity({ actorId: user.id, entityType: 'job', entityId: jobId, orderId: job.order_id, jobId, action: 'checklist', message: `${job.code} QC checklist: ${c.label} ${done ? 'checked' : 'reopened'}` });
}

// ───────────────────────── Material readiness per product line ─────────────────────────

export function seedItemMaterials(itemId: number, req: Partial<Record<MaterialKind, { required: boolean; status?: string; note?: string }>>) {
  for (const kind of MATERIAL_KINDS) {
    const r = req[kind];
    const required = r?.required ?? false;
    insert(
      'INSERT OR IGNORE INTO item_materials (order_item_id, kind, required, status, note, updated_at) VALUES (?,?,?,?,?,?)',
      itemId, kind, required ? 1 : 0, required ? (r?.status ?? 'pending') : 'not_required', r?.note ?? null, nowIso(),
    );
  }
}

export function setItemMaterial(itemId: number, kind: MaterialKind, status: 'pending' | 'received' | 'not_required', user: AuthUser) {
  const m = get(
    `SELECT im.*, o.code AS order_code, o.id AS order_id, p.sku FROM item_materials im JOIN order_items i ON i.id=im.order_item_id
     JOIN orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id WHERE im.order_item_id=? AND im.kind=?`,
    itemId,
    kind,
  );
  if (!m) throw notFound('Material line');
  if (m.status === status) return;
  run('UPDATE item_materials SET status=?, required=?, updated_by=?, updated_at=? WHERE id=?', status, status === 'not_required' ? 0 : 1, user.id, nowIso(), m.id);
  logActivity({
    actorId: user.id,
    entityType: 'order',
    entityId: m.order_id,
    orderId: m.order_id,
    action: 'material_status',
    field: kind,
    oldValue: STEP_LABEL[m.status] ?? m.status,
    newValue: STEP_LABEL[status] ?? status,
    message: `${m.order_code} · ${m.sku}: ${MATERIAL_LABELS[kind]} ${m.status.replace('_', ' ')} → ${status.replace('_', ' ')}`,
  });
}

export function itemMaterials(itemIds: number[]) {
  if (!itemIds.length) return [];
  return all(`SELECT * FROM item_materials WHERE order_item_id IN (${itemIds.map(() => '?').join(',')})`, ...itemIds);
}

// ───────────────────────── Master production tracker ─────────────────────────

const STEP_COLUMNS: [string, string, string][] = [
  ['structure', 'iron', 'frame'],
  ['structure_qc', 'iron', 'frame_qc'],
  ['powder', 'iron', 'powder'],
  ['powder_qc', 'iron', 'powder_qc'],
  ['weaving', 'rope', 'weaving'],
  ['weaving_qc', 'rope', 'weaving_qc'],
  ['upholstery', 'fabric', 'upholstery'],
  ['upholstery_qc', 'fabric', 'upholstery_qc'],
  ['tile_work', 'tile', 'tile'],
];

/**
 * One row per product line — the Master Production Sheet, derived live from
 * orders, product lines, material readiness and job steps.
 */
export function trackerRows(filter: { q?: string; includeClosed?: boolean } = {}) {
  const items = all(
    `SELECT i.*, o.id AS order_id, o.code AS order_code, o.order_date, o.commencement_date, o.deadline, o.stage, o.on_hold, c.name AS client, p.sku, p.name AS product
     FROM order_items i JOIN orders o ON o.id=i.order_id JOIN customers c ON c.id=o.customer_id JOIN products p ON p.id=i.product_id
     WHERE o.cancelled_at IS NULL ${filter.includeClosed ? '' : `AND o.stage != 'completed'`}
     ORDER BY o.order_date, o.id, i.id`,
  );
  const ids = items.map((i) => i.id);
  const mats = itemMaterials(ids);
  const steps = ids.length
    ? all(
        `SELECT s.*, j.order_item_id, j.id AS job_id, pr.key AS process_key FROM job_steps s JOIN jobs j ON j.id=s.job_id JOIN job_processes pr ON pr.id=j.process_id
         WHERE j.order_item_id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
      )
    : [];
  const t = today();
  const q = filter.q?.toLowerCase();
  return items
    .map((i) => {
      const m = Object.fromEntries(mats.filter((x) => x.order_item_id === i.id).map((x) => [x.kind, x]));
      const st = steps.filter((s) => s.order_item_id === i.id);
      const cols: Record<string, { status: string; job_id: number; key: string; kind: string } | null> = {};
      for (const [col, proc, key] of STEP_COLUMNS) {
        const s = st.find((x) => x.process_key === proc && x.key === key);
        cols[col] = s ? { status: s.status, job_id: s.job_id, key: s.key, kind: s.kind } : null;
      }
      const applicable = st.filter((s) => s.status !== 'not_required');
      const doneCount = applicable.filter((s) => ['done', 'approved'].includes(s.status)).length;
      const completion = applicable.length ? Math.round((doneCount / applicable.length) * 100) : 0;
      const pendingMat = Object.values(m).filter((x: any) => x.required && x.status === 'pending');
      const inProg = (k: string) => st.some((s) => s.key === k && s.status === 'in_progress');
      const qcWaiting = st.some((s) => s.kind === 'qc' && s.status === 'pending' && st.some((w) => w.job_id === s.job_id && w.kind === 'work' && w.sequence === s.sequence - 1 && w.status === 'done'));
      let current: string;
      if (['ready_for_dispatch'].includes(i.stage)) current = 'Ready for Dispatch';
      else if (['dispatched', 'completed'].includes(i.stage)) current = 'Completed';
      else if (completion === 100) current = 'Quality Check';
      else if (inProg('upholstery')) current = 'In Assembly';
      else if (inProg('weaving')) current = 'In Weaving';
      else if (inProg('powder')) current = 'In Painting';
      else if (qcWaiting) current = 'Quality Check';
      else if (pendingMat.length && !st.some((s) => s.kind === 'work' && ['in_progress', 'done'].includes(s.status))) current = 'Waiting for Material';
      else current = 'In Production';
      const start = i.commencement_date ?? i.order_date;
      const procurementDelay = pendingMat.length && daysBetween(start, t) > 3 ? 'Material Order Delay' : 'On Track';
      const deadlineDelay = i.deadline < t && !['dispatched', 'completed'].includes(i.stage) ? 'Late' : 'On Track';
      return {
        item_id: i.id,
        order_id: i.order_id,
        order_code: i.order_code,
        order_date: i.order_date,
        commencement: i.commencement_date,
        client: i.client,
        sku: i.sku,
        product: i.product,
        qty: i.quantity,
        deadline: i.deadline,
        stage: i.stage,
        on_hold: !!i.on_hold,
        photo: !!i.photo,
        materials: Object.fromEntries(MATERIAL_KINDS.map((k) => [k, m[k] ? { required: !!m[k].required, status: m[k].status, note: m[k].note } : null])),
        steps: cols,
        current_status: current,
        procurement_delay: procurementDelay,
        deadline_delay: deadlineDelay,
        rework: i.rework,
        notes: i.line_notes,
        completion,
      };
    })
    .filter((r) => !q || [r.order_code, r.client, r.sku, r.product, r.current_status].join(' ').toLowerCase().includes(q));
}

export function setItemFields(itemId: number, patch: { rework?: string | null; line_notes?: string | null }, user: AuthUser) {
  const i = get('SELECT i.*, o.code AS order_code, p.sku FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id WHERE i.id=?', itemId);
  if (!i) throw notFound('Product line');
  for (const [k, label] of [['rework', 'Rework alert'], ['line_notes', 'Notes']] as const) {
    if (!(k in patch)) continue;
    const v = (patch as any)[k] || null;
    if ((i[k] ?? null) === v) continue;
    run(`UPDATE order_items SET ${k}=? WHERE id=?`, v, itemId);
    logActivity({ actorId: user.id, entityType: 'order', entityId: i.order_id, orderId: i.order_id, action: 'line_update', field: k, oldValue: i[k], newValue: v, message: `${i.order_code} · ${i.sku}: ${label} ${i[k] ?? '—'} → ${v ?? '—'}` });
  }
}
