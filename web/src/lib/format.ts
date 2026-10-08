import { daysBetween, type DeadlineRisk } from '../../../shared/domain';

const TZ = 'Asia/Kolkata';
const d = (s: string) => (s.length === 10 ? new Date(s + 'T00:00:00') : new Date(s));

export const fmtDate = (s?: string | null, withYear = true) =>
  s ? d(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', ...(withYear ? { year: 'numeric' } : {}), ...(s.length > 10 ? { timeZone: TZ } : {}) }) : '—';

export const fmtShort = (s?: string | null) => fmtDate(s, false);

export const fmtTime = (s?: string | null) =>
  s ? new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TZ }) : '';

export const fmtDateTime = (s?: string | null) => (s ? `${fmtShort(s)} · ${fmtTime(s)}` : '—');

export const dayKey = (s: string) => new Date(s).toLocaleDateString('en-CA', { timeZone: TZ });

export function relDays(deadline: string, today: string) {
  const n = daysBetween(today, deadline);
  if (n === 0) return 'Due today';
  if (n === 1) return 'Due tomorrow';
  if (n > 1) return `${n} days left`;
  return `${-n} day${n === -1 ? '' : 's'} overdue`;
}

export function timeAgo(s: string) {
  const sec = (Date.now() - new Date(s).getTime()) / 1000;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return fmtShort(s);
}

export const num = (n: number | null | undefined, dp = 1) =>
  n === null || n === undefined ? '—' : Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { maximumFractionDigits: dp });

export const initials = (name?: string | null) =>
  (name ?? 'System')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export const STAGE_TONE: Record<string, string> = {
  received: '',
  reviewed: '',
  preparing: 'warn',
  ready_for_production: 'warn',
  in_production: 'ok',
  quality_check: 'warn',
  ready_for_dispatch: 'ok',
  dispatched: 'ok',
  completed: 'ok',
};
export const STAGE_COLOR: Record<string, string> = {
  received: '#9aa19c',
  reviewed: '#9aa19c',
  preparing: '#c2700f',
  ready_for_production: '#c2700f',
  in_production: '#1f6b50',
  quality_check: '#c2700f',
  ready_for_dispatch: '#1f6b50',
  dispatched: '#1f6b50',
  completed: '#1f6b50',
};
export const RISK_TONE: Record<DeadlineRisk, string> = { safe: 'ok', approaching: 'warn', at_risk: 'warn', overdue: 'bad', done: 'ok' };
export const JOB_TONE: Record<string, string> = { not_started: '', in_progress: 'ok', on_hold: 'warn', completed: 'ok', delayed: 'bad' };
export const PRIORITY_TONE: Record<string, string> = { low: '', normal: '', high: 'warn', urgent: 'bad' };
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** The 9 lifecycle stages shown as 7 steps people recognise (review and production-ready fold into their neighbours). */
export const STAGE_GROUPS: { key: string; label: string; stages: string[] }[] = [
  { key: 'received,reviewed', label: 'Order received', stages: ['received', 'reviewed'] },
  { key: 'preparing,ready_for_production', label: 'Being prepared', stages: ['preparing', 'ready_for_production'] },
  { key: 'in_production', label: 'In production', stages: ['in_production'] },
  { key: 'quality_check', label: 'Quality check', stages: ['quality_check'] },
  { key: 'ready_for_dispatch', label: 'Ready for dispatch', stages: ['ready_for_dispatch'] },
  { key: 'dispatched', label: 'Dispatched', stages: ['dispatched'] },
  { key: 'completed', label: 'Completed', stages: ['completed'] },
];
export const groupCount = (counts: Record<string, number> | undefined, g: { stages: string[] }) => g.stages.reduce((a, s) => a + (counts?.[s] ?? 0), 0);
