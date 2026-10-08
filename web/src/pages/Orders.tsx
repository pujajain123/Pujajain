import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutGrid, List, Search } from 'lucide-react';
import { ORDER_STAGES } from '../../../shared/domain';
import { useApi } from '../lib/live';
import { qs } from '../lib/api';
import { useMeta, useStageLabel } from '../lib/meta';
import { useIsAdmin } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Empty, ErrorState, Input, Loading, PriorityChip, Progress, RiskChip, Seg, Select, StageChip, Tabs, Avatar } from '../components/ui';
import { OrderCard, Pipeline, ProcessMini, type OrderSummary } from '../components/domain';

export function Orders() {
  const [params, setParams] = useSearchParams();
  const stage = params.get('stage') ?? 'active';
  const view = (params.get('view') as 'cards' | 'table') ?? 'cards';
  const filters = { stage, q: params.get('q') ?? '', risk: params.get('risk') ?? '', priority: params.get('priority') ?? '', customer: params.get('customer') ?? '', staff: params.get('staff') ?? '' };
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const counts = useApi<Record<string, number>>('/orders/stage-counts', ['orders']).data;
  const { data, error, reload } = useApi<OrderSummary[]>(`/orders${qs(filters)}`, ['orders', 'jobs', 'inventory']);
  const label = useStageLabel();
  const meta = useMeta();
  const admin = useIsAdmin();
  const nav = useNavigate();

  const tabs = useMemo(
    () => [
      { key: 'active', label: 'All active', count: counts?.active },
      ...ORDER_STAGES.map((s) => ({ key: s, label: label(s), count: counts?.[s] })),
      { key: 'delayed', label: 'Delayed', count: counts?.delayed, tone: 'bad' },
      { key: 'on_hold', label: 'On hold', count: counts?.on_hold, tone: 'warn' },
      { key: 'cancelled', label: 'Cancelled', count: counts?.cancelled },
    ],
    [counts, label],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <div className="sub">Every order, where it is in its lifecycle and what it needs.</div>
        </div>
        {admin && <Link to="/orders/new" className="btn accent">+ New order</Link>}
      </div>

      {counts && <Pipeline counts={counts} onPick={(s) => set('stage', s)} active={stage} />}

      <div className="mt-16">
        <Tabs value={stage} onChange={(v) => set('stage', v)} items={tabs} />
      </div>

      <div className="filters mt-16">
        <div className="search" style={{ maxWidth: 300 }}>
          <Search size={15} style={{ top: 9 }} />
          <Input className="search-in" style={{ height: 32, paddingLeft: 32 }} placeholder="Order ID, client, product, staff" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        </div>
        <Select value={filters.risk} onChange={(e) => set('risk', e.target.value)} aria-label="Deadline risk">
          <option value="">Any deadline risk</option>
          <option value="overdue">🔴 Overdue</option>
          <option value="at_risk,overdue">🟠 At risk or overdue</option>
          <option value="at_risk">🟠 At risk</option>
          <option value="approaching">🟡 Approaching</option>
          <option value="safe">🟢 Safe</option>
        </Select>
        <Select value={filters.priority} onChange={(e) => set('priority', e.target.value)} aria-label="Priority">
          <option value="">Any priority</option>
          {['urgent', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
        </Select>
        <Select value={filters.customer} onChange={(e) => set('customer', e.target.value)} aria-label="Client">
          <option value="">All clients</option>
          {meta.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select value={filters.staff} onChange={(e) => set('staff', e.target.value)} aria-label="Staff">
          <option value="">All staff</option>
          {meta.staff.filter((s) => s.role === 'staff').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <div style={{ marginLeft: 'auto' }}>
          <Seg value={view} onChange={(v) => set('view', v === 'cards' ? '' : v)} items={[{ key: 'cards', label: <><LayoutGrid size={14} /> Cards</> }, { key: 'table', label: <><List size={14} /> Table</> }]} />
        </div>
      </div>

      {error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data ? (
        <Loading rows={3} h={180} />
      ) : data.length === 0 ? (
        <div className="card"><Empty title="No orders match">Try another stage or clear the filters.</Empty></div>
      ) : view === 'cards' ? (
        <div className="order-grid">{data.map((o) => <OrderCard key={o.id} o={o} />)}</div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th><th>Client</th><th>Product</th><th className="num">Qty</th><th>Stage</th><th style={{ minWidth: 160 }}>Production</th>
                <th>Deadline</th><th>Priority</th><th>Team</th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
                  <td className="mono strong nowrap">{o.code}</td>
                  <td className="strong">{o.customer}</td>
                  <td className="muted">{o.product}</td>
                  <td className="num">{o.quantity}</td>
                  <td><StageChip stage={o.stage} onHold={o.on_hold} cancelled={o.cancelled} /></td>
                  <td>{o.jobs.length ? <><Progress value={o.progress} /><div className="mt-8"><ProcessMini jobs={o.jobs} /></div></> : <span className="faint">—</span>}</td>
                  <td className="nowrap">{fmtDate(o.deadline)}<div className="mt-8" style={{ marginTop: 4 }}><RiskChip risk={o.risk} /></div></td>
                  <td><PriorityChip p={o.priority} /></td>
                  <td><div className="row gap-4">{o.assignees.map((a) => <Avatar key={a} name={a} sm light />)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
