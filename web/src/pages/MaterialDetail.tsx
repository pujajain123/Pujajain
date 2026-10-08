import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, PackagePlus, Pencil } from 'lucide-react';
import { useApi } from '../lib/live';
import { useIsAdmin } from '../lib/auth';
import { useStageLabel } from '../lib/meta';
import { fmtDate, num } from '../lib/format';
import { Card, Chip, Empty, ErrorState, Loading } from '../components/ui';
import { MaterialModal, StockTxnModal, TxnTable } from './Inventory';

export function MaterialDetail() {
  const id = Number(useParams().id);
  const { data, error, reload } = useApi<any>(`/inventory/materials/${id}`, ['inventory']);
  const admin = useIsAdmin();
  const label = useStageLabel();
  const [modal, setModal] = useState<null | 'txn' | 'edit'>(null);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={4} h={90} />;
  const { material: m, stock: s } = data;
  return (
    <>
      <div className="crumbs"><Link to="/inventory" className="row gap-4"><ChevronLeft size={14} /> Inventory</Link></div>
      <div className="page-head">
        <div>
          <div className="row gap-12"><h1>{m.name}</h1>{s.low_stock && <Chip tone="bad">Low stock</Chip>}</div>
          <div className="sub"><span className="mono">{m.code}</span> · {m.variant} · {m.supplier} · {m.location}</div>
        </div>
        <div className="row">
          {admin && <button className="btn" onClick={() => setModal('edit')}><Pencil size={14} /> Edit</button>}
          <button className="btn primary" onClick={() => setModal('txn')}><PackagePlus size={14} /> Record movement</button>
        </div>
      </div>
      <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
        {[
          ['Opening', s.opening], ['+ Incoming', s.incoming], ['± Adjustments', s.adjustments], ['− Consumed', s.consumed], ['− Wastage', s.wastage], ['= Current stock', s.on_hand], ['Reserved', s.reserved], ['Available', s.available], ['Incoming (expected)', s.expected_incoming],
        ].map(([k, v]) => (
          <div key={k as string} style={{ padding: '12px 16px', borderRight: '1px solid var(--line)' }}>
            <div className="stat-label">{k}</div>
            <div className="stat-value" style={k === 'Available' ? { color: s.low_stock ? 'var(--bad)' : 'var(--ok)' } : undefined}>{num(v as number)} <span className="small muted">{m.unit}</span></div>
          </div>
        ))}
      </div>
      <div className="small muted mt-8">Reorder level {num(m.reorder_level)} {m.unit}. Available = current stock − stock reserved for orders.</div>

      <Card title="Orders using this material" pad={false} className="mt-16">
        {data.orders.length === 0 ? <Empty title="No orders require this material" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Order</th><th>Client</th><th>Stage</th><th>Deadline</th><th className="num">Required</th><th className="num">Consumed</th><th className="num">Reserved</th><th className="num">Still needed</th></tr></thead>
              <tbody>
                {data.orders.map((o: any) => (
                  <tr key={o.id}>
                    <td><Link to={`/orders/${o.id}`} className="mono strong">{o.code}</Link></td>
                    <td>{o.customer}</td>
                    <td><Chip>{label(o.stage)}</Chip></td>
                    <td>{fmtDate(o.deadline)}</td>
                    <td className="num">{num(o.required)}</td>
                    <td className="num">{num(o.consumed)}</td>
                    <td className="num">{num(o.reserved)}</td>
                    <td className="num">{o.outstanding - o.reserved > 0.01 && !['dispatched', 'completed', 'quality_check', 'ready_for_dispatch'].includes(o.stage) ? <Chip tone="bad">{num(o.outstanding - o.reserved)} unreserved</Chip> : num(o.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Stock ledger" pad={false} className="mt-16">
        {data.ledger.length === 0 ? <Empty title="No movements yet" /> : <TxnTable rows={data.ledger} unit={m.unit} />}
      </Card>
      {modal === 'txn' && <StockTxnModal materialId={m.id} onClose={() => setModal(null)} />}
      {modal === 'edit' && <MaterialModal material={m} onClose={() => setModal(null)} />}
    </>
  );
}
