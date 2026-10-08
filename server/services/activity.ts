import { insert } from '../db.ts';
import { nowIso } from '../lib.ts';

export interface ActivityInput {
  actorId: number | null; // null = System
  entityType: string;
  entityId?: number | null;
  orderId?: number | null;
  jobId?: number | null;
  action: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  message: string;
}

const s = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Append an audit entry. The table is append-only at the database level. */
export function logActivity(a: ActivityInput) {
  return insert(
    `INSERT INTO activity_logs (actor_id, entity_type, entity_id, order_id, job_id, action, field, old_value, new_value, message, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    a.actorId,
    a.entityType,
    a.entityId ?? null,
    a.orderId ?? null,
    a.jobId ?? null,
    a.action,
    a.field ?? null,
    s(a.oldValue),
    s(a.newValue),
    a.message,
    nowIso(),
  );
}

/** Log each changed field of an update as its own audit entry. */
export function logFieldChanges(
  base: Omit<ActivityInput, 'field' | 'oldValue' | 'newValue' | 'message' | 'action'> & { label: string },
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fieldLabels: Record<string, string>,
) {
  for (const [k, lbl] of Object.entries(fieldLabels)) {
    if (!(k in after)) continue;
    const o = before[k] ?? null;
    const n = after[k] ?? null;
    if (String(o ?? '') === String(n ?? '')) continue;
    logActivity({
      ...base,
      action: 'update',
      field: k,
      oldValue: o,
      newValue: n,
      message: `${base.label}: ${lbl} changed from ${o ?? '—'} → ${n ?? '—'}`,
    });
  }
}
