import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Circle, Search } from 'lucide-react';
import { useApi } from '../lib/live';
import { useMeta } from '../lib/meta';
import { fmtShort, relDays } from '../lib/format';
import { Avatar, Card, Empty, ErrorState, Input, Loading, PriorityChip, Progress, RiskChip, Select, StageChip, cx } from '../components/ui';
import type { OrderSummary, JobBrief } from '../components/domain';

/** The Master Production Sheet, rebuilt as a live operational view. */
export function MasterProduction() {
  const { data, error, reload } = useApi<OrderSummary[]>('/production/master', ['orders', 'jobs']);
  const meta = useMeta();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [risk, setRisk] = useState('');
  const [sort, setSort] = useState<'deadline' | 'progress' | 'priority'>('deadline');
  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) r = r.filter((o) => [o.code, o.customer, o.product, ...o.assignees].some((v) => v.toLowerCase().includes(q.toLowerCase())));
    if (stage) r = r.filter((o) => o.stage === stage);
    if (risk) r = r.filter((o) => o.risk === risk);
    const pr: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    return [...r].sort((a, b) => (sort === 'progress' ? a.progress - b.progress : sort === 'priority' ? pr[a.priority] - pr[b.priority] || a.deadline.localeCompare(b.deadline) : a.deadline.localeCompare(b.deadline)));
  }, [data, q, stage, risk, sort]);
  if (error) return <ErrorState error={error} retry={reload} />;
  const cell = (j?: JobBrief) =>
    !j ? (
      <span className="faint small">n/a</span>
    ) : (
      <div style={{ minWidth: 110 }} title={`${j.code} · ${j.assignee ?? 'unassigned'}`}>
        <div className="row between small">
          <span className="row gap-4">
            {j.status === 'completed' ? <Check size={13} color="var(--ok)" strokeWidth={3} /> : j.status === 'not_started' ? <Circle size={10} color="var(--faint)" /> : <Circle size={10} fill={j.status === 'delayed' || j.overdue ? 'var(--bad)' : 'var(--risk)'} color="transparent" />}
            <span className={cx(j.status === 'not_started' && 'muted')}>{j.completed_qty}/{j.quantity}</span>
          </span>
          <span className="tiny muted">{j.assignee?.split(' ')[0]}</span>
        </div>
        <div className="mt-8" style={{ marginTop: 4 }}><Progress value={j.progress} tone={j.status === 'delayed' || j.overdue ? 'bad' : undefined} /></div>
      </div>
    );
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Production</div><h1>Master production</h1>
          <div className="sub">Every active order with process-level progress — updates live as staff save job sheets.</div>
        </div>
      </div>
      <div className="filters">
        <div className="search" style={{ maxWidth: 280 }}>
          <Search size={15} style={{ top: 9 }} />
          <Input className="search-in" style={{ height: 32, paddingLeft: 32 }} placeholder="Order, client, product, staff" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {meta.stages.filter((s) => s.key !== 'completed').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
        <Select value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="Risk">
          <option value="">Any risk</option>
          <option value="overdue">Overdue</option><option value="at_risk">At risk</option><option value="approaching">Approaching</option><option value="safe">Safe</option>
        </Select>
        <Select value={sort} onChange={(e) => setSort(e.target.value as any)} aria-label="Sort">
          <option value="deadline">Sort: deadline</option><option value="priority">Sort: priority</option><option value="progress">Sort: least progress</option>
        </Select>
      </div>
      {!data ? (
        <Loading rows={8} h={44} />
      ) : (
        <Card pad={false}>
          {rows.length === 0 ? <Empty title="No active orders match" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Order</th><th>Client</th><th>Product</th><th className="num">Qty</th><th>Order date</th><th>Sky date</th><th>Deadline</th><th>Stage</th>
                    {meta.processes.map((p) => <th key={p.id}>{p.name}</th>)}
                    <th style={{ minWidth: 120 }}>Overall</th><th>Staff</th><th>Priority</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
                      <td className="mono strong nowrap">{o.code}</td>
                      <td className="strong nowrap">{o.customer}</td>
                      <td className="small">{o.product}</td>
                      <td className="num">{o.quantity}</td>
                      <td className="nowrap small">{fmtShort(o.order_date)}</td>
                      <td className="nowrap small">{fmtShort(o.sky_date)}</td>
                      <td className="nowrap"><span className="strong" style={o.risk === 'overdue' ? { color: 'var(--bad)' } : undefined}>{fmtShort(o.deadline)}</span><div className="cell-sub">{o.risk === 'done' ? 'Dispatched' : relDays(o.deadline, meta.today)}</div></td>
                      <td><StageChip stage={o.stage} onHold={o.on_hold} /></td>
                      {meta.processes.map((p) => <td key={p.id}>{cell(o.jobs.find((j) => j.process_key === p.key))}</td>)}
                      <td><div className="row"><div className="grow"><Progress value={o.progress} tone={o.risk === 'overdue' ? 'bad' : undefined} /></div><span className="strong small">{o.progress}%</span></div></td>
                      <td><div className="row gap-4">{o.assignees.map((a) => <Avatar key={a} name={a} sm light />)}</div></td>
                      <td><PriorityChip p={o.priority} /></td>
                      <td><RiskChip risk={o.risk} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
