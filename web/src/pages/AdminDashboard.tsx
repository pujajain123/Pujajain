import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ClipboardList, Factory, PackageX, Truck, CheckCircle2, Timer, Boxes } from 'lucide-react';
import { useApi } from '../lib/live';
import { useMeta } from '../lib/meta';
import { fmtDate, num, relDays } from '../lib/format';
import { Card, Chip, Empty, ErrorState, JobStatusChip, Kpi, Loading, Progress, RiskChip, StageChip } from '../components/ui';
import { ActivityFeed, Pipeline, ProcessMini, type OrderSummary } from '../components/domain';

export function AdminDashboard() {
  const { data, error, reload } = useApi<any>('/dashboard', ['dashboard', 'orders', 'jobs', 'inventory']);
  const nav = useNavigate();
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={5} h={90} />;
  const k = data.kpis;
  const att = data.attention;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Operations control</h1>
          <div className="sub">What’s happening across Umami Studios · {fmtDate(data.today)}</div>
        </div>
        <Link to="/orders/new" className="btn accent">+ New order</Link>
      </div>

      <div className="kpis">
        <Kpi label="Active orders" value={k.active} icon={<ClipboardList size={14} />} foot={`${k.on_hold} on hold`} to="/orders?stage=active" />
        <Kpi label="In preparation" value={k.preparing} icon={<Timer size={14} />} foot="Received · reviewed · preparing" to="/orders?stage=preparing" />
        <Kpi label="In production" value={k.in_production} icon={<Factory size={14} />} foot={`${k.quality_check} in quality check`} to="/production" />
        <Kpi label="Ready for dispatch" value={k.ready_for_dispatch} icon={<Truck size={14} />} foot={`${k.dispatched} dispatched, awaiting close`} to="/dispatch" />
        <Kpi label="Delayed" value={k.delayed} tone={k.delayed ? 'alert' : undefined} icon={<AlertTriangle size={14} />} foot="Overdue, past sky date or job delays" to="/orders?stage=delayed" />
        <Kpi label="Material shortages" value={k.shortages} tone={k.shortages ? 'warn' : undefined} icon={<PackageX size={14} />} foot={`${k.low_stock} materials below reorder level`} to="/inventory" />
        <Kpi label="Due today" value={k.due_today} tone={k.due_today ? 'warn' : undefined} icon={<CalendarClock size={14} />} foot={`${k.due_week} due within 7 days`} to="/orders?risk=at_risk,overdue" />
        <Kpi label="Dispatched" value={k.dispatched} icon={<CheckCircle2 size={14} />} foot="Awaiting delivery confirmation" to="/orders?stage=dispatched" />
      </div>

      <div className="section-title">
        <h2>Order pipeline</h2>
        <Link to="/orders" className="small muted">Open all orders →</Link>
      </div>
      <Pipeline counts={data.pipeline} onPick={(s) => nav(`/orders?stage=${s}`)} />

      <div className="grid g3 mt-24" style={{ alignItems: 'start' }}>
        <div className="span-2 col gap-16">
          <Card title={<div className="row"><h2>Needs attention</h2><Chip tone="bad">{att.overdue.length + att.at_risk.length + att.shortages.length + att.on_hold.length}</Chip></div>} pad={false}>
            <AttentionList data={att} />
          </Card>
          <Card title="Production floor" pad={false} actions={<Link to="/jobs" className="btn sm">Job sheets</Link>}>
            <div className="grid g3" style={{ padding: 16, gap: 12 }}>
              {data.process_load.map((p: any) => (
                <div key={p.key} className="card card-pad" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row between">
                    <h3>{p.name}</h3>
                    {p.overdue > 0 && <Chip tone="bad">{p.overdue} past due</Chip>}
                  </div>
                  <div className="row mt-12" style={{ alignItems: 'baseline', gap: 6 }}>
                    <span className="big-number" style={{ fontSize: 26 }}>{num(p.units ? Math.round((p.done / p.units) * 100) : 0)}%</span>
                    <span className="muted small">{num(p.done ?? 0)} / {num(p.units ?? 0)} units</span>
                  </div>
                  <div className="mt-8"><Progress value={p.units ? (p.done / p.units) * 100 : 0} /></div>
                  <div className="small muted mt-8">{p.jobs} active job sheets · {p.in_progress} in progress</div>
                </div>
              ))}
            </div>
            <div className="table-wrap">
              <table className="table dense">
                <thead>
                  <tr><th>Staff</th><th>Process</th><th className="num">Open jobs</th><th className="num">Units left</th><th className="num">Overdue</th></tr>
                </thead>
                <tbody>
                  {data.workload.map((w: any) => (
                    <tr key={w.id} className="click" onClick={() => nav(`/jobs?staff=${w.id}`)}>
                      <td className="strong">{w.name}</td>
                      <td className="muted">{w.process ?? 'QC / Dispatch'}</td>
                      <td className="num">{w.open_jobs ?? 0}</td>
                      <td className="num">{w.open_units ?? 0}</td>
                      <td className="num">{w.overdue ? <Chip tone="bad">{w.overdue}</Chip> : <span className="faint">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="col gap-16">
          <Card title="Stock watch" pad={false} actions={<Link to="/inventory" className="btn sm"><Boxes size={14} /> Inventory</Link>}>
            {data.low_stock.length === 0 ? (
              <Empty title="All materials above reorder level" />
            ) : (
              <div>
                {data.low_stock.map((s: any) => (
                  <Link key={s.material_id} to={`/inventory/${s.material_id}`} className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)' }}>
                    <div className="grow">
                      <div className="strong truncate">{s.name}</div>
                      <div className="small muted">Reorder at {num(s.reorder_level)} {s.unit}{s.expected_incoming ? ` · ${num(s.expected_incoming)} ${s.unit} incoming` : ''}</div>
                    </div>
                    <div className="right">
                      <div className="strong" style={{ color: 'var(--bad)' }}>{num(s.available)} {s.unit}</div>
                      <div className="tiny muted">available</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
          <Card title="Live activity" actions={<Link to="/activity" className="small muted">Full log →</Link>}>
            <div style={{ maxHeight: 560, overflowY: 'auto', marginTop: -10 }}>
              <ActivityFeed rows={data.recent} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function AttentionList({ data }: { data: any }) {
  const nav = useNavigate();
  const today = useMeta().today;
  const rows: { o: OrderSummary; why: React.ReactNode; tone: string }[] = [];
  const seen = new Set<number>();
  const add = (o: OrderSummary, why: React.ReactNode, tone: string) => {
    if (seen.has(o.id)) return;
    seen.add(o.id);
    rows.push({ o, why, tone });
  };
  data.overdue.forEach((o: OrderSummary) => add(o, <>Overdue — {o.delay_reasons.filter((r) => r !== 'Past client deadline').join('; ') || `still in ${o.stage_label}`}</>, 'bad'));
  data.shortages.forEach((o: OrderSummary) => add(o, <>Material shortage blocks production</>, 'risk'));
  data.at_risk.forEach((o: OrderSummary) => add(o, <>At risk — {o.progress}% produced, {o.days_left} day(s) left</>, 'risk'));
  data.on_hold.forEach((o: OrderSummary) => add(o, <>On hold — {o.hold_reason}</>, 'warn'));
  if (!rows.length && !data.delayed_jobs.length) return <Empty title="Nothing needs attention right now" icon={<CheckCircle2 size={28} />} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Order</th><th>Issue</th><th>Stage</th><th>Deadline</th><th style={{ width: 180 }}>Production</th></tr>
        </thead>
        <tbody>
          {rows.map(({ o, why, tone }) => (
            <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
              <td>
                <div className="mono strong">{o.code}</div>
                <div className="cell-sub">{o.customer}</div>
              </td>
              <td><span className="small" style={{ color: `var(--${tone})`, fontWeight: 550 }}>{why}</span></td>
              <td><StageChip stage={o.stage} onHold={o.on_hold} /></td>
              <td className="nowrap"><div>{fmtDate(o.deadline)}</div><RiskChip risk={o.risk} /></td>
              <td><ProcessMini jobs={o.jobs} /></td>
            </tr>
          ))}
          {data.delayed_jobs
            .filter((j: any) => !seen.has(j.order_id))
            .map((j: any) => (
              <tr key={'j' + j.id} className="click" onClick={() => nav(`/jobs/${j.id}`)}>
                <td><div className="mono strong">{j.code}</div><div className="cell-sub">{j.order_code} · {j.customer}</div></td>
                <td><span className="small" style={{ color: 'var(--risk)', fontWeight: 550 }}>{j.process_name} past due date ({j.assignee ?? 'unassigned'})</span></td>
                <td><JobStatusChip status={j.status} /></td>
                <td className="nowrap">{fmtDate(j.due_date)}<div className="cell-sub">{relDays(j.due_date, today)}</div></td>
                <td><Progress value={j.progress} /></td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
