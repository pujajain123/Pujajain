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
  reviewed: 'info',
  preparing: 'warn',
  ready_for_production: 'teal',
  in_production: 'risk',
  quality_check: 'violet',
  ready_for_dispatch: 'info',
  dispatched: 'teal',
  completed: 'ok',
};
export const STAGE_COLOR: Record<string, string> = {
  received: '#56606e',
  reviewed: '#2f6fed',
  preparing: '#b7791f',
  ready_for_production: '#0f8a87',
  in_production: '#d0661a',
  quality_check: '#6d4bd8',
  ready_for_dispatch: '#2f6fed',
  dispatched: '#0f8a87',
  completed: '#1f8a4c',
};
export const RISK_TONE: Record<DeadlineRisk, string> = { safe: 'ok', approaching: 'warn', at_risk: 'risk', overdue: 'bad', done: 'teal' };
export const JOB_TONE: Record<string, string> = { not_started: '', in_progress: 'risk', on_hold: 'warn', completed: 'ok', delayed: 'bad' };
export const PRIORITY_TONE: Record<string, string> = { low: 'outline', normal: '', high: 'risk', urgent: 'bad' };
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
