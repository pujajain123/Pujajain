import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, ArrowUpRight, Clock, ClipboardList, Factory, PackageX, Plus, Truck, Layers } from 'lucide-react';
import { useApi } from '../lib/live';
import { useMeta } from '../lib/meta';
import { useAuth } from '../lib/auth';
import { fmtShort, num } from '../lib/format';
import { daysBetween } from '../../../shared/domain';
import { Chip, Empty, ErrorState, Kpi, Loading, PageHead, Panel, Progress, StageChip } from '../components/ui';
import { ActivityFeed, Pipeline, type OrderSummary } from '../components/domain';

const RISK_ORDER: Record<string, number> = { overdue: 0, at_risk: 1, approaching: 2, safe: 3, done: 4 };

export function AdminDashboard() {
  const { data, error, reload } = useApi<any>('/dashboard', ['dashboard', 'orders', 'jobs', 'inventory']);
  const orders = useApi<OrderSummary[]>('/orders?stage=active', ['orders', 'jobs', 'inventory']).data;
  const nav = useNavigate();
  const today = useMeta().today;
  const { user } = useAuth();
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={5} h={110} />;
  const k = data.kpis;
  const att = data.attention;
  const hour = new Date().getHours();
  const dateLine = new Date(today + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const watch = (orders ?? [])
    .filter((o) => !['dispatched'].includes(o.stage))
    .sort((a, b) => Number(b.delayed || b.shortage) - Number(a.delayed || a.shortage) || RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.deadline.localeCompare(b.deadline))
    .slice(0, 6);

  const alerts: { key: string; tone: string; icon: React.ReactNode; title: string; sub: string; meta: string; to: string }[] = [];
  for (const o of att.overdue as OrderSummary[])
    alerts.push({ key: 'o' + o.id, tone: 'bad', icon: '!', title: `${o.code} is overdue`, sub: `${o.customer} · due ${fmtShort(o.deadline)}`, meta: `${-o.days_left}d late`, to: `/orders/${o.id}` });
  for (const o of [...att.due_today, ...att.at_risk] as OrderSummary[])
    if (!alerts.some((a) => a.key === 'o' + o.id))
      alerts.push({ key: 'o' + o.id, tone: 'warn', icon: <Clock size={17} />, title: `${o.code} deadline approaching`, sub: `${o.customer} · due ${o.days_left === 0 ? 'today' : `in ${o.days_left} day${o.days_left === 1 ? '' : 's'}`}`, meta: 'Action needed', to: `/orders/${o.id}` });
  for (const o of att.shortages as OrderSummary[])
    alerts.push({ key: 's' + o.id, tone: 'warn', icon: <PackageX size={17} />, title: `Material short on ${o.code}`, sub: `${o.customer} · ${o.product}`, meta: 'Inventory', to: `/orders/${o.id}` });
  for (const s of data.low_stock)
    alerts.push({ key: 'm' + s.material_id, tone: 'warn', icon: <Layers size={17} />, title: `${s.name} is running low`, sub: `${num(s.available)} ${s.unit} available · reorder at ${num(s.reorder_level)}`, meta: 'Inventory', to: `/inventory/${s.material_id}` });
  for (const o of att.on_hold as OrderSummary[])
    alerts.push({ key: 'h' + o.id, tone: 'info', icon: '‖', title: `${o.code} is on hold`, sub: o.hold_reason ?? '', meta: 'On hold', to: `/orders/${o.id}` });

  const stockByCat = (cat: string) => {
    const rows = data.inventory.filter((s: any) => s.category === cat);
    const sum = (k: string) => rows.reduce((a: number, s: any) => a + s[k], 0);
    return { available: sum('available'), reserved: sum('reserved'), used: sum('consumed'), onHand: sum('on_hand'), low: rows.filter((s: any) => s.low_stock).length, unit: cat === 'rope' ? 'kg' : 'm' };
  };

  return (
    <>
      <PageHead
        eyebrow={dateLine}
        title={`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${user?.name.split(' ')[0] ?? 'Umami'}`}
        sub="Here’s what’s moving across the studio today."
        actions={<Link to="/orders/new" className="btn accent lg"><Plus size={17} /> New order</Link>}
      />

      <div className="kpis">
        <Kpi label="Active orders" value={k.active} icon={<ClipboardList size={17} />} foot="Across all active stages" to="/orders" />
        <Kpi label="In production" value={k.in_production} icon={<Factory size={17} />} foot="Orders on the floor" to="/production" />
        <Kpi label="Ready to dispatch" value={k.ready_for_dispatch} icon={<Truck size={17} />} foot="Awaiting carrier handoff" to="/dispatch" />
        <Kpi
          label="Needs attention"
          value={alerts.length}
          tone={alerts.length ? 'alert' : undefined}
          icon={<AlertTriangle size={17} />}
          foot={`${att.overdue.length} overdue · ${att.shortages.length + data.low_stock.length} stock alerts`}
          to="/orders?stage=delayed"
        />
      </div>

      <div className="grid dash-grid mt-24">
        <div className="col gap-24" style={{ minWidth: 0 }}>
          <Panel title="Order pipeline" sub="Live view of every order in motion. Click a stage to open its orders." action={<Link to="/orders" className="link">All orders <ArrowUpRight size={14} /></Link>}>
            <Pipeline counts={data.pipeline} onPick={(s) => nav(`/orders?stage=${s}`)} />
          </Panel>

          <Panel title="Orders needing attention" sub="Most urgent first — overdue, delayed and short of material at the top." action={<Link to="/orders" className="link">View all <ArrowRight size={14} /></Link>} flush>
            {!orders ? <div className="card-body"><Loading rows={3} h={44} /></div> : watch.length === 0 ? <Empty title="All active orders are on track" /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Order</th><th>Client</th><th>Stage</th><th>Deadline</th><th style={{ minWidth: 170 }}>Progress</th></tr></thead>
                  <tbody>
                    {watch.map((o) => {
                      const late = daysBetween(o.deadline, today);
                      return (
                        <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
                          <td className="strong nowrap">{o.code}</td>
                          <td style={{ minWidth: 170 }}><div className="strong nowrap">{o.customer}</div><div className="cell-sub nowrap">{o.product}</div></td>
                          <td><StageChip stage={o.stage} onHold={o.on_hold} /></td>
                          <td className="nowrap" style={o.risk === 'overdue' ? { color: 'var(--bad)' } : o.risk === 'at_risk' ? { color: 'var(--warn)' } : undefined}>
                            {fmtShort(o.deadline)}{o.risk === 'overdue' ? ` · ${late}d late` : ''}
                            {(o.shortage || (o.delayed && o.risk !== 'overdue')) && <div className="cell-sub">{o.shortage ? 'Material short' : o.delay_reasons[0]}</div>}
                          </td>
                          <td><Progress value={o.progress} tone={o.risk === 'overdue' ? 'bad' : undefined} label={<><span>{o.progress}%</span><span className="muted">{o.quantity} units</span></>} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="grid g2" style={{ alignItems: 'start' }}>
            <Panel title="Production by process" sub="Units finished on active orders">
              <div className="col gap-16">
                {data.process_load.map((p: any) => (
                  <div key={p.key}>
                    <Progress
                      value={p.units ? (p.done / p.units) * 100 : 0}
                      label={<><span className="strong">{p.name}</span><span className="muted">{num(p.done ?? 0)} / {num(p.units ?? 0)} units{p.overdue ? ` · ${p.overdue} late` : ''}</span></>}
                    />
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="Team workload" sub="Open job sheets per person" action={<Link to="/jobs" className="link">Job sheets <ArrowRight size={14} /></Link>} flush>
              <table className="table dense">
                <tbody>
                  {data.workload.map((w: any) => (
                    <tr key={w.id} className="click" onClick={() => nav(`/jobs?staff=${w.id}`)}>
                      <td><div className="strong">{w.name}</div><div className="cell-sub">{w.process ?? 'QC & dispatch'}</div></td>
                      <td className="num">{w.open_jobs ?? 0} jobs<div className="cell-sub">{w.open_units ?? 0} units left</div></td>
                      <td className="num">{w.overdue ? <Chip tone="bad">{w.overdue} late</Chip> : <span className="faint small">On time</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </div>
        </div>

        <div className="col gap-24" style={{ minWidth: 0 }}>
          <Panel title="Attention needed" sub="Deadlines and material alerts" action={alerts.length ? <Chip tone="warn" dot>{alerts.length} alerts</Chip> : <Chip tone="ok">All clear</Chip>}>
            {alerts.length === 0 ? <Empty title="Nothing needs attention" /> : (
              <div style={{ marginTop: -8 }}>
                {alerts.slice(0, 7).map((a) => (
                  <Link key={a.key} to={a.to} className="att-item">
                    <span className={`att-icon ${a.tone}`}>{a.icon}</span>
                    <span style={{ minWidth: 0 }}><div className="t">{a.title}</div><div className="s truncate">{a.sub}</div></span>
                    <span className="meta">{a.meta}</span>
                  </Link>
                ))}
                {alerts.length > 7 && <Link to="/notifications" className="link mt-8">{alerts.length - 7} more <ArrowRight size={14} /></Link>}
              </div>
            )}
          </Panel>

          <Panel title="Stock at a glance" sub="Available after reservations" action={<Link to="/inventory" className="link">Inventory <ArrowRight size={14} /></Link>}>
            {(['rope', 'fabric'] as const).map((c) => {
              const s = stockByCat(c);
              return (
                <Link key={c} to="/inventory" className="stock-row" style={{ display: 'block' }}>
                  <div className="row between">
                    <div>
                      <div className="strong">{c === 'rope' ? 'Rope' : 'Fabric'}</div>
                      <div className="small muted">{num(s.reserved, 0)} {s.unit} reserved · {num(s.used, 0)} {s.unit} used</div>
                    </div>
                    <div className="right">
                      <div className="strong" style={{ fontSize: 17 }}>{num(s.available, 0)} {s.unit}</div>
                      {s.low > 0 && <div className="tiny" style={{ color: 'var(--bad)' }}>{s.low} item{s.low > 1 ? 's' : ''} low</div>}
                    </div>
                  </div>
                  <div className="mt-8"><Progress value={s.onHand ? (s.available / s.onHand) * 100 : 0} /></div>
                </Link>
              );
            })}
          </Panel>

          <Panel title="Recent activity" sub="Every update, as it happens" action={<Link to="/activity" className="link">Full log <ArrowRight size={14} /></Link>}>
            <div style={{ maxHeight: 420, overflowY: 'auto', marginTop: -12 }}>
              <ActivityFeed rows={data.recent.slice(0, 12)} />
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

