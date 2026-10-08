// Domain vocabulary shared by the API and the web client.
// The order lifecycle is the spine of the whole system: every screen reads from it.

export const ORDER_STAGES = [
  'received',
  'reviewed',
  'preparing',
  'ready_for_production',
  'in_production',
  'quality_check',
  'ready_for_dispatch',
  'dispatched',
  'completed',
] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

export const DEFAULT_STAGE_LABELS: Record<OrderStage, string> = {
  received: 'Order Received',
  reviewed: 'Order Reviewed',
  preparing: 'Being Prepared',
  ready_for_production: 'Ready for Production',
  in_production: 'In Production',
  quality_check: 'Quality Check',
  ready_for_dispatch: 'Ready for Dispatch',
  dispatched: 'Dispatched',
  completed: 'Completed',
};

export const stageIndex = (s: OrderStage) => ORDER_STAGES.indexOf(s);

/** Stages that count as "active" work (not finished). */
export const ACTIVE_STAGES: OrderStage[] = ORDER_STAGES.filter((s) => s !== 'completed');

export const JOB_STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed', 'delayed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  not_started: 'Not Started',
  in_progress: 'In Progress',
  on_hold: 'On Hold',
  completed: 'Completed',
  delayed: 'Delayed',
};

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ROLES = ['admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];

/** Inventory ledger movement types. Quantities are always stored positive; the type gives the sign. */
export const TXN_TYPES = ['opening', 'incoming', 'adjustment_in', 'adjustment_out', 'allocation', 'release', 'consumption', 'wastage'] as const;
export type TxnType = (typeof TXN_TYPES)[number];
export const TXN_LABELS: Record<TxnType, string> = {
  opening: 'Opening Stock',
  incoming: 'Incoming',
  adjustment_in: 'Adjustment (+)',
  adjustment_out: 'Adjustment (−)',
  allocation: 'Allocated to Order',
  release: 'Allocation Released',
  consumption: 'Consumed',
  wastage: 'Wastage',
};

export type DeadlineRisk = 'safe' | 'approaching' | 'at_risk' | 'overdue' | 'done';
export const RISK_LABELS: Record<DeadlineRisk, string> = {
  safe: 'Safe',
  approaching: 'Approaching',
  at_risk: 'At Risk',
  overdue: 'Overdue',
  done: 'Delivered',
};

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const da = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const db = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((db - da) / 86400000);
}

/**
 * Deadline risk combines time left with how much production remains.
 * - overdue: deadline passed and not yet dispatched
 * - at_risk: due within `atRiskDays`, or remaining work outpaces remaining time
 * - approaching: due within `approachingDays`
 */
export function deadlineRisk(opts: {
  deadline: string;
  today: string;
  stage: OrderStage;
  progress: number; // 0..100
  orderDate?: string;
  approachingDays?: number;
  atRiskDays?: number;
}): DeadlineRisk {
  const { deadline, today, stage, progress, orderDate, approachingDays = 7, atRiskDays = 2 } = opts;
  if (stageIndex(stage) >= stageIndex('dispatched')) return 'done';
  const left = daysBetween(today, deadline);
  if (left < 0) return 'overdue';
  if (left <= atRiskDays) return 'at_risk';
  if (orderDate) {
    const total = Math.max(1, daysBetween(orderDate, deadline));
    const elapsedPct = (1 - left / total) * 100;
    // More than 25 points behind the straight-line schedule while in/after preparation.
    if (stageIndex(stage) >= stageIndex('preparing') && elapsedPct - progress > 25 && left <= approachingDays * 2) return 'at_risk';
  }
  if (left <= approachingDays) return 'approaching';
  return 'safe';
}

export const fmtQty = (n: number, unit?: string) =>
  `${Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, '')}${unit ? ' ' + unit : ''}`;
