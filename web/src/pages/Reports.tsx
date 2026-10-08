import { useState } from 'react';
import { addDaysISO } from '../lib/dates';
import { useApi } from '../lib/live';
import { useMeta } from '../lib/meta';
import { fmtShort, num } from '../lib/format';
import { Card, Chip, Empty, ErrorState, Field, Input, Kpi, Loading, Seg } from '../components/ui';

const S1 = '#2a78d6'; // categorical slot 1 (validated reference palette)
const S2 = '#eb6834'; // categorical slot 2

export function Reports() {
  const today = useMeta().today;
  const [range, setRange] = useState({ from: addDaysISO(today, -90), to: today });
  const [preset, setPreset] = useState('90');
  const { data, error, reload } = useApi<any>(`/reports?from=${range.from}&to=${range.to}`, ['orders', 'jobs', 'inventory']);
  const pick = (d: string) => (setPreset(d), setRange({ from: addDaysISO(today, -Number(d)), to: today }));
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Insight</div><h1>Reports</h1><div className="sub">Orders, production, inventory and staff performance for the selected period.</div></div>
        <div className="row wrap">
          <Seg value={preset} onChange={pick} items={[{ key: '7', label: '7 days' }, { key: '30', label: '30 days' }, { key: '90', label: '90 days' }]} />
          <Field><Input type="date" value={range.from} max={range.to} onChange={(e) => (setPreset(''), setRange({ ...range, from: e.target.value }))} style={{ height: 32 }} aria-label="From" /></Field>
          <Field><Input type="date" value={range.to} max={today} onChange={(e) => (setPreset(''), setRange({ ...range, to: e.target.value }))} style={{ height: 32 }} aria-label="To" /></Field>
        </div>
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : !data ? <Loading rows={4} h={120} /> : <Body d={data} />}
    </>
  );
}

function HBar({ label, value, max, suffix, sub }: { label: React.ReactNode; value: number; max: number; suffix?: string; sub?: string }) {
  return (
    <div className="hbar" title={`${typeof label === 'string' ? label : ''}: ${num(value)}${suffix ?? ''}`}>
      <span className="truncate">{label}{sub && <div className="tiny muted truncate">{sub}</div>}</span>
      <div className="track"><span style={{ width: `${max ? (value / max) * 100 : 0}%`, background: S1, borderRadius: '0 4px 4px 0' }} /></div>
      <span className="right strong">{num(value)}{suffix}</span>
    </div>
  );
}

function Body({ d }: { d: any }) {
  const o = d.orders;
  const wmax = Math.max(1, ...o.weekly.map((w: any) => Math.max(w.received, w.dispatched)));
  const cmax = Math.max(1, ...o.by_client.map((c: any) => c.units));
  return (
    <div className="col gap-24">
      <div>
        <h2 style={{ marginBottom: 10 }}>Orders</h2>
        <div className="kpis">
          <Kpi label="Orders received" value={o.received} />
          <Kpi label="Orders dispatched" value={o.dispatched} foot={o.dispatched_late ? `${o.dispatched_late} after deadline` : 'All on time'} tone={o.dispatched_late ? 'warn' : undefined} />
          <Kpi label="Orders completed" value={o.completed} foot={o.avg_lead_days != null ? `Avg ${o.avg_lead_days} days order → completion` : undefined} />
          <Kpi label="Delayed (open now)" value={o.delayed_open} tone={o.delayed_open ? 'alert' : undefined} foot={`${o.cancelled} cancelled in period`} />
        </div>
        <div className="grid g2 mt-16" style={{ alignItems: 'start' }}>
          <Card title="Received vs dispatched, by week">
            <div className="legend"><span><i style={{ background: S1 }} />Received</span><span><i style={{ background: S2 }} />Dispatched</span></div>
            <div className="vbars" role="img" aria-label="Weekly orders received and dispatched">
              {o.weekly.map((w: any) => (
                <div className="vb" key={w.week} title={`Week of ${fmtShort(w.week)}: ${w.received} received, ${w.dispatched} dispatched`}>
                  <span style={{ height: `${(w.received / wmax) * 100}%`, background: S1 }} />
                  <span style={{ height: `${(w.dispatched / wmax) * 100}%`, background: S2 }} />
                </div>
              ))}
            </div>
            <div className="row between tiny muted mt-8"><span>{fmtShort(o.weekly[0]?.week)}</span><span>{fmtShort(o.weekly[o.weekly.length - 1]?.week)}</span></div>
          </Card>
          <Card title="Orders by client (units)">
            {o.by_client.length === 0 ? <Empty title="No orders in this period" /> : o.by_client.map((c: any) => <HBar key={c.client} label={c.client} value={c.units} max={cmax} sub={`${c.orders} order${c.orders > 1 ? 's' : ''}${c.delayed ? ` · ${c.delayed} delayed` : ''}`} />)}
          </Card>
        </div>
      </div>

      <Card title="Production by process" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Process</th><th className="num">Job sheets</th><th className="num">Completed</th><th style={{ width: 200 }}>Completion rate</th><th className="num">Units done</th><th className="num">Completed late</th><th className="num">Overdue open</th><th className="num">Marked delayed</th><th className="num">Avg days / job</th></tr></thead>
            <tbody>
              {d.production.map((p: any) => (
                <tr key={p.key}>
                  <td className="strong">{p.name}</td>
                  <td className="num">{p.jobs}</td>
                  <td className="num">{p.completed}</td>
                  <td><HBar label="" value={p.completion_rate} max={100} suffix="%" /></td>
                  <td className="num">{num(p.units_done ?? 0)} / {num(p.units_total ?? 0)}</td>
                  <td className="num">{p.completed_late || <span className="faint">0</span>}</td>
                  <td className="num">{p.overdue_open ? <Chip tone="bad">{p.overdue_open}</Chip> : <span className="faint">0</span>}</td>
                  <td className="num">{p.delayed ? <Chip tone="bad">{p.delayed}</Chip> : <span className="faint">0</span>}</td>
                  <td className="num">{p.avg_days ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid g2">
        <Card title="Material consumption & wastage" pad={false}>
          <div className="table-wrap">
            <table className="table dense">
              <thead><tr><th>Material</th><th className="num">Incoming</th><th className="num">Consumed</th><th className="num">Wastage</th><th className="num">Waste %</th></tr></thead>
              <tbody>
                {d.inventory.map((m: any) => (
                  <tr key={m.id}>
                    <td><div className="strong">{m.name}</div><div className="cell-sub">{m.category}</div></td>
                    <td className="num">{num(m.incoming)} {m.unit}</td>
                    <td className="num strong">{num(m.consumed)} {m.unit}</td>
                    <td className="num">{num(m.wastage)} {m.unit}</td>
                    <td className="num">{m.wastage_pct > 4 ? <Chip tone="risk">{m.wastage_pct}%</Chip> : `${m.wastage_pct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="col gap-16">
          <Card title="Low stock now" pad={false}>
            {d.low_stock.length === 0 ? <Empty title="Nothing below reorder level" /> : (
              <table className="table dense"><tbody>{d.low_stock.map((s: any) => <tr key={s.material_id}><td className="strong">{s.name}</td><td className="num"><Chip tone="bad">{num(s.available)} {s.unit}</Chip></td><td className="num muted">reorder {num(s.reorder_level)}</td></tr>)}</tbody></table>
            )}
          </Card>
          <Card title="Staff performance" pad={false}>
            <div className="table-wrap">
              <table className="table dense">
                <thead><tr><th>Staff</th><th className="num">Jobs done</th><th className="num">Units produced</th><th className="num">Open jobs</th><th className="num">Units left</th><th className="num">Delayed</th></tr></thead>
                <tbody>
                  {d.staff.map((s: any) => (
                    <tr key={s.id}>
                      <td><div className="strong">{s.name}</div><div className="cell-sub">{s.process ?? 'QC / dispatch'}</div></td>
                      <td className="num">{s.jobs_completed}</td>
                      <td className="num strong">{s.units_produced}</td>
                      <td className="num">{s.open_jobs}</td>
                      <td className="num">{s.open_units}</td>
                      <td className="num">{s.delayed_jobs ? <Chip tone="bad">{s.delayed_jobs}</Chip> : <span className="faint">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
