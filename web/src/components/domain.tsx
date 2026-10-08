import { Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, PauseCircle, PackageX } from 'lucide-react';
import type { DeadlineRisk } from '../../../shared/domain';
import { fmtDate, fmtShort, fmtTime, relDays, dayKey, num, STAGE_GROUPS, groupCount } from '../lib/format';
import { useMeta } from '../lib/meta';
import { Avatar, Chip, PriorityChip, Progress, RiskChip, StageChip, cx } from './ui';

export interface JobBrief {
  id: number;
  code: string;
  process_key: string;
  process_name: string;
  status: string;
  quantity: number;
  completed_qty: number;
  progress: number;
  assignee: string | null;
  assignee_id: number | null;
  due_date: string | null;
  overdue: boolean;
}
export interface OrderSummary {
  id: number;
  code: string;
  customer_id: number;
  customer: string;
  product: string;
  quantity: number;
  order_date: string;
  sky_date: string | null;
  deadline: string;
  priority: string;
  stage: string;
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
}

const riskBar = (o: OrderSummary) => (o.risk === 'overdue' ? 'bad' : o.risk === 'at_risk' ? 'risk' : o.progress >= 100 ? 'ok' : '');

export function DeadlineText({ o }: { o: OrderSummary }) {
  const today = useMeta().today;
  if (o.risk === 'done') return <span className="muted">{fmtDate(o.deadline)}</span>;
  return (
    <span>
      <span className="strong">{fmtDate(o.deadline)}</span>
      <span className={cx('small', o.risk === 'overdue' ? '' : 'muted')} style={o.risk === 'overdue' ? { color: 'var(--bad)' } : undefined}>
        {' '}· {relDays(o.deadline, today)}
      </span>
    </span>
  );
}

export function ProcessMini({ jobs }: { jobs: JobBrief[] }) {
  if (!jobs.length) return null;
  return (
    <div className="proc-mini">
      {jobs.map((j) => (
        <div className="pm" key={j.id} title={`${j.process_name}: ${j.completed_qty}/${j.quantity}`}>
          <div className={cx('pm-bar', j.status === 'completed' && 'done', (j.status === 'delayed' || j.overdue) && 'delayed')}>
            <span style={{ width: `${j.progress}%` }} />
          </div>
          <div className="pm-label">
            <span className="truncate">{j.process_name.replace(' Work', '')}</span>
            <span>{j.status === 'completed' ? '✓' : `${j.progress}%`}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function OrderCard({ o }: { o: OrderSummary }) {
  const nav = useNavigate();
  return (
    <article className={cx('card order-card', `risk-${o.risk}`)} onClick={() => nav(`/orders/${o.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/orders/${o.id}`)}>
      <div className="row between">
        <span className="oc-code">{o.code}</span>
        <div className="row gap-4">
          <PriorityChip p={o.priority} />
          {o.risk !== 'safe' && o.risk !== 'done' && <RiskChip risk={o.risk} />}
        </div>
      </div>
      <div>
        <div className="oc-client">{o.customer}</div>
        <div className="muted small truncate">{o.product}</div>
      </div>
      <div className="oc-meta">
        <div>
          <div className="k">Quantity</div>
          <div className="strong">{o.quantity} units</div>
        </div>
        <div>
          <div className="k">Deadline</div>
          <div className={cx('strong', o.risk === 'overdue' && 'nowrap')} style={o.risk === 'overdue' ? { color: 'var(--bad)' } : undefined}>
            {fmtDate(o.deadline)}
          </div>
        </div>
      </div>
      <div className="row between">
        <StageChip stage={o.stage} onHold={o.on_hold} cancelled={o.cancelled} />
        {o.current_process && <span className="small"><span className="muted">Now:</span> <span className="strong">{o.current_process}</span></span>}
      </div>
      {o.jobs.length > 0 && (
        <div>
          <Progress value={o.progress} tone={riskBar(o)} label={<><span className="muted">Production</span><span className="strong">{o.progress}%</span></>} />
          <div className="mt-8">
            <ProcessMini jobs={o.jobs} />
          </div>
        </div>
      )}
      <div className="row between small">
        <div className="row gap-4">
          {o.assignees.slice(0, 3).map((a) => (
            <Avatar key={a} name={a} sm light />
          ))}
          <span className="muted truncate">{o.assignees.join(', ') || 'Unassigned'}</span>
        </div>
        <div className="row gap-4">
          {o.shortage && <Chip tone="risk" title="Material shortage"><PackageX size={12} /> Material</Chip>}
          {o.on_hold && <PauseCircle size={15} color="var(--warn)" />}
          {o.delayed && !o.shortage && o.risk !== 'overdue' && <Chip tone="bad" title={o.delay_reasons.join('; ')}><AlertTriangle size={12} /> Delayed</Chip>}
        </div>
      </div>
    </article>
  );
}

/** Numbered pipeline of lifecycle steps with live counts. Click a step to see its orders. */
export function Pipeline({ counts, onPick, active }: { counts: Record<string, number>; onPick: (stageKey: string) => void; active?: string }) {
  return (
    <div className="pipeline" style={{ ['--steps' as any]: STAGE_GROUPS.length }}>
      {STAGE_GROUPS.map((g, i) => {
        const n = groupCount(counts, g);
        return (
          <div key={g.key} className={cx('pipe-stage', n === 0 && 'zero', n > 0 && 'has', active === g.key && 'active')} onClick={() => onPick(g.key)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPick(g.key)}>
            <div className="pipe-num">{i + 1}</div>
            <div className="pipe-count">{n}</div>
            <div className="pipe-label">{g.label}</div>
          </div>
        );
      })}
    </div>
  );
}

export interface ActivityRow {
  id: number;
  actor: string | null;
  actor_id: number | null;
  message: string;
  created_at: string;
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
  order_code?: string | null;
  action: string;
}

/** Audit trail grouped by day. */
export function ActivityFeed({ rows, showOrder }: { rows: ActivityRow[]; showOrder?: boolean }) {
  const nav = useNavigate();
  if (!rows.length) return <div className="empty small">No activity yet</div>;
  let last = '';
  return (
    <div className="feed">
      {rows.map((a) => {
        const day = dayKey(a.created_at);
        const head = day !== last ? (last = day) : null;
        return (
          <Fragment key={a.id}>
            {head && <div className="feed-day">{fmtDate(a.created_at)}</div>}
            <div className="feed-item">
              <div className="feed-time">
                {fmtTime(a.created_at)}
                <div className="strong" style={{ color: 'var(--ink-2)' }}>{a.actor ?? 'System'}</div>
              </div>
              <Avatar name={a.actor} sm light={!!a.actor} />
              <div className="feed-msg">
                {a.message}
                {showOrder && a.order_code && (
                  <button className="btn ghost sm" style={{ height: 20, marginLeft: 6 }} onClick={() => nav(`/orders?q=${a.order_code}`)}>
                    <span className="mono">{a.order_code}</span>
                  </button>
                )}
                {a.field && a.old_value !== null && a.new_value !== null && a.field !== 'notes' && (
                  <div className="feed-change">
                    <span className="old">{a.old_value}</span>→<span className="strong">{a.new_value}</span>
                  </div>
                )}
              </div>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export function MaterialBar({ required, consumed, reserved, shortage, unit }: { required: number; consumed: number; reserved: number; shortage: number; unit: string }) {
  const total = Math.max(required, consumed + reserved + shortage, 0.0001);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div>
      <div className="progress lg" style={{ display: 'flex' }}>
        <span style={{ width: pct(consumed), background: 'var(--ink)', borderRadius: 0 }} title={`Consumed ${num(consumed)} ${unit}`} />
        <span style={{ width: pct(reserved), background: 'var(--ok)', borderRadius: 0 }} title={`Reserved ${num(reserved)} ${unit}`} />
        <span style={{ width: pct(shortage), background: 'repeating-linear-gradient(45deg, var(--bad) 0 4px, #e7807f 4px 8px)', borderRadius: 0 }} title={`Short ${num(shortage)} ${unit}`} />
      </div>
      <div className="legend mt-8">
        <span><i style={{ background: 'var(--ink)' }} />Consumed {num(consumed)}</span>
        <span><i style={{ background: 'var(--ok)' }} />Reserved {num(reserved)}</span>
        {shortage > 0 && <span style={{ color: 'var(--bad)' }}><i style={{ background: 'var(--bad)' }} />Short {num(shortage)}</span>}
      </div>
    </div>
  );
}

export const shortDate = fmtShort;
