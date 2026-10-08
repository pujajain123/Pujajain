import { all, get, getSetting, run } from '../db.ts';
import { daysBetween } from '../../shared/domain.ts';
import { nowIso, today } from '../lib.ts';
import { broadcast } from '../live.ts';

export type Severity = 'critical' | 'warning' | 'notice' | 'info';
export interface NotifyInput {
  type: string;
  severity: Severity;
  title: string;
  body?: string;
  link?: string;
  orderId?: number | null;
  jobId?: number | null;
  materialId?: number | null;
  dedupeKey?: string;
}

/** Create a notification for one user. Duplicate dedupe keys per user are ignored. */
export function notifyUser(userId: number, n: NotifyInput) {
  const link = n.link ?? (n.jobId ? `/jobs/${n.jobId}` : n.orderId ? `/orders/${n.orderId}` : n.materialId ? `/inventory/${n.materialId}` : null);
  const r = run(
    `INSERT OR IGNORE INTO notifications (user_id, type, severity, title, body, link, order_id, job_id, material_id, dedupe_key, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    userId,
    n.type,
    n.severity,
    n.title,
    n.body ?? null,
    link,
    n.orderId ?? null,
    n.jobId ?? null,
    n.materialId ?? null,
    n.dedupeKey ?? null,
    nowIso(),
  );
  if (r.changes) broadcast('notifications');
}

export function notifyAdmins(n: NotifyInput) {
  for (const u of all<{ id: number }>(`SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='admin' AND u.active=1`)) notifyUser(u.id, n);
}

/** Notify admins plus everyone currently assigned to a job on the order. */
export function notifyOrderTeam(orderId: number, n: NotifyInput) {
  notifyAdmins(n);
  for (const u of all<{ id: number }>('SELECT DISTINCT assigned_to AS id FROM jobs WHERE order_id=? AND assigned_to IS NOT NULL', orderId)) notifyUser(u.id, n);
}

/**
 * Scan operational state and raise alerts. Idempotent thanks to dedupe keys, so it runs
 * on startup, on a timer, and after every mutation.
 */
export async function refreshAlerts() {
  const { orderSummaries } = await import('./orders.ts');
  const { orderMaterials, stock } = await import('./inventory.ts');
  const t = today();
  const dueSoonDays = Number(getSetting('due_soon_days', '2'));

  for (const o of orderSummaries()) {
    if (['dispatched', 'completed'].includes(o.stage)) continue;
    const left = daysBetween(t, o.deadline);
    if (left < 0) {
      notifyOrderTeam(o.id, {
        type: 'order_overdue',
        severity: 'critical',
        title: `${o.code} is overdue`,
        body: `${o.code} (${o.customer}) passed its deadline ${-left} day(s) ago and is still in ${o.stage_label}.`,
        orderId: o.id,
        dedupeKey: `overdue:${o.id}:${o.deadline}`,
      });
    } else if (left <= dueSoonDays) {
      notifyOrderTeam(o.id, {
        type: 'deadline_approaching',
        severity: 'notice',
        title: left === 0 ? `${o.code} is due today` : `${o.code} is due in ${left} day(s)`,
        body: `${o.customer} · ${o.product} · ${o.progress}% produced · currently ${o.stage_label}.`,
        orderId: o.id,
        dedupeKey: `due:${o.id}:${o.deadline}:${left === 0 ? 'today' : 'soon'}`,
      });
    }
    if (o.shortage) {
      for (const m of orderMaterials(o.id).filter((m) => m.shortage > 0)) {
        notifyAdmins({
          type: 'material_shortage',
          severity: 'warning',
          title: `Material shortage on ${o.code}`,
          body: `${o.code} requires ${m.outstanding} ${m.unit} ${m.material_name} but only ${m.reserved + Math.max(0, m.available_in_store)} ${m.unit} is available — short by ${m.shortage} ${m.unit}.`,
          orderId: o.id,
          materialId: m.material_id,
          dedupeKey: `shortage:${o.id}:${m.material_id}:${m.shortage}`,
        });
      }
    }
    for (const j of o.jobs) {
      if (j.overdue) {
        const n = {
          type: 'job_overdue',
          severity: 'warning' as const,
          title: `${j.process_name} on ${o.code} is past due`,
          body: `${j.code} was due ${j.due_date}; ${j.completed_qty}/${j.quantity} done.`,
          orderId: o.id,
          jobId: j.id,
          dedupeKey: `job_overdue:${j.id}:${j.due_date}`,
        };
        notifyAdmins(n);
        if (j.assignee_id) notifyUser(j.assignee_id, n);
      }
    }
  }

  for (const s of stock().filter((s) => s.low_stock)) {
    const lastIn = get<{ id: number }>(`SELECT MAX(id) AS id FROM inventory_transactions WHERE material_id=? AND type IN ('incoming','opening','adjustment_in')`, s.material_id);
    notifyAdmins({
      type: 'low_stock',
      severity: 'warning',
      title: `Low stock: ${s.name}`,
      body: `${s.available} ${s.unit} available (reorder level ${s.reorder_level} ${s.unit})${s.expected_incoming ? `; ${s.expected_incoming} ${s.unit} incoming` : ''}.`,
      materialId: s.material_id,
      dedupeKey: `low_stock:${s.material_id}:${lastIn?.id ?? 0}`,
    });
  }
}
