import { useNavigate } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { useApi } from '../lib/live';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Card, Chip, Empty, ErrorState, Kpi, Loading, RiskChip, StageChip } from '../components/ui';

export function Dispatch() {
  const { data, error, reload } = useApi<any>('/dispatch', ['orders']);
  const nav = useNavigate();
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={4} h={80} />;
  const by = (s: string) => data.orders.filter((o: any) => o.stage === s);
  const cl = (id: number) => data.checklists.find((c: any) => c.order_id === id);
  const section = (title: string, rows: any[], hint: string) => (
    <Card title={<div className="row"><h2>{title}</h2><span className="pill-count">{rows.length}</span></div>} pad={false}>
      {rows.length === 0 ? <Empty title="Nothing here">{hint}</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Order</th><th>Client</th><th className="num">Qty</th><th>Dispatched</th><th>Readiness</th><th>Deadline</th><th>Stage</th></tr></thead>
            <tbody>
              {rows.map((o: any) => {
                const c = cl(o.id);
                return (
                  <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
                    <td className="mono strong nowrap">{o.code}</td>
                    <td><div className="strong">{o.customer}</div><div className="cell-sub">{o.product}</div></td>
                    <td className="num">{o.quantity}</td>
                    <td>{o.dispatched_qty ? (o.dispatched_qty < o.quantity ? <Chip tone="warn">{o.dispatched_qty} · partial</Chip> : <Chip tone="ok">{o.dispatched_qty} · full</Chip>) : <span className="faint">—</span>}</td>
                    <td>{c ? (c.done === c.total ? <Chip tone="ok">Ready</Chip> : <Chip tone="warn">{c.done}/{c.total} checks</Chip>) : <span className="faint">—</span>}</td>
                    <td className="nowrap">{fmtDate(o.deadline)} <RiskChip risk={o.risk} /></td>
                    <td><StageChip stage={o.stage} onHold={o.on_hold} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
  return (
    <>
      <div className="page-head">
        <div><h1>Dispatch</h1><div className="sub">From quality check to the client’s door.</div></div>
      </div>
      <div className="kpis">
        <Kpi label="In quality check" value={by('quality_check').length} />
        <Kpi label="Ready for dispatch" value={by('ready_for_dispatch').length} />
        <Kpi label="Dispatched · open" value={by('dispatched').length} foot="Awaiting delivery confirmation" />
        <Kpi label="Dispatches recorded" value={data.records.length} icon={<Truck size={14} />} />
      </div>
      <div className="col gap-16 mt-24">
        {section('Ready for dispatch', by('ready_for_dispatch'), 'Orders appear here once their quality check passes.')}
        {section('In quality check', by('quality_check'), 'Orders arrive here when every job sheet is complete.')}
        {section('Dispatched — awaiting completion', by('dispatched'), 'Mark completed once the client confirms delivery.')}
        <Card title="Dispatch register" pad={false}>
          {data.records.length === 0 ? <Empty title="No dispatches yet" /> : (
            <div className="table-wrap">
              <table className="table dense">
                <thead><tr><th>Date & time</th><th>Order</th><th>Client</th><th className="num">Qty</th><th>Transporter</th><th>Vehicle</th><th>Tracking / LR</th><th>Invoice</th><th>By</th></tr></thead>
                <tbody>
                  {data.records.map((d: any) => (
                    <tr key={d.id} className="click" onClick={() => nav(`/orders/${d.order_id}`)}>
                      <td className="nowrap">{fmtDateTime(d.dispatched_at.length === 16 ? d.dispatched_at + ':00+05:30' : d.dispatched_at)}</td>
                      <td className="mono strong nowrap">{d.order_code}</td>
                      <td>{d.customer}</td>
                      <td className="num">{d.quantity}{d.quantity < d.order_qty && <span className="cell-sub"> /{d.order_qty}</span>}</td>
                      <td>{d.transporter}</td>
                      <td className="mono small">{d.vehicle_no}</td>
                      <td className="mono small">{d.tracking_ref}</td>
                      <td className="mono small">{d.invoice_no}</td>
                      <td>{d.dispatched_by_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
