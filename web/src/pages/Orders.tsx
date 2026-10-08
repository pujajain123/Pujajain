import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutGrid, List, Search, Plus } from 'lucide-react';
import { useApi } from '../lib/live';
import { qs } from '../lib/api';
import { useMeta } from '../lib/meta';
import { useIsAdmin } from '../lib/auth';
import { cap, fmtShort, relDays, STAGE_GROUPS, groupCount } from '../lib/format';
import { Chip, Empty, ErrorState, Input, Loading, PageHead, Progress, Seg, Select, StageChip, Tabs } from '../components/ui';
import { OrderCard, type OrderSummary } from '../components/domain';

export function Orders() {
  const [params, setParams] = useSearchParams();
  const rawStage = params.get('stage') ?? 'active';
  const stage = STAGE_GROUPS.find((g) => g.stages.length > 1 && g.stages.includes(rawStage))?.key ?? rawStage;
  const view = (params.get('view') as 'cards' | 'table') ?? 'table';
  const filters = { stage, q: params.get('q') ?? '', risk: params.get('risk') ?? '', priority: params.get('priority') ?? '', customer: params.get('customer') ?? '', staff: params.get('staff') ?? '' };
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  const counts = useApi<Record<string, number>>('/orders/stage-counts', ['orders']).data;
  const { data, error, reload } = useApi<OrderSummary[]>(`/orders${qs(filters)}`, ['orders', 'jobs', 'inventory']);
  const meta = useMeta();
  const admin = useIsAdmin();
  const nav = useNavigate();

  const tabs = useMemo(
    () => [
      { key: 'active', label: 'All', count: counts?.active },
      ...STAGE_GROUPS.map((g) => ({ key: g.key, label: g.label, count: groupCount(counts, g) })),
      { key: 'delayed', label: 'Delayed', count: counts?.delayed, tone: 'bad' },
      { key: 'on_hold', label: 'On hold', count: counts?.on_hold },
      { key: 'cancelled', label: 'Cancelled', count: counts?.cancelled },
    ],
    [counts],
  );

  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Orders"
        sub="Manage the full order lifecycle from intake through completion."
        actions={admin && <Link to="/orders/new" className="btn accent lg"><Plus size={17} /> New order</Link>}
      />

      <Tabs value={stage} onChange={(v) => set('stage', v)} items={tabs} />

      <div className="filters mt-16">
        <div className="search" style={{ maxWidth: 280 }}>
          <Search size={15} style={{ top: 11 }} />
          <Input className="search-in" style={{ height: 36, paddingLeft: 34 }} placeholder="Order ID, client, product, staff" value={filters.q} onChange={(e) => set('q', e.target.value)} />
        </div>
        <Select value={filters.priority} onChange={(e) => set('priority', e.target.value)} aria-label="Priority">
          <option value="">All priorities</option>
          {['urgent', 'high', 'normal', 'low'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
        </Select>
        <Select value={filters.risk} onChange={(e) => set('risk', e.target.value)} aria-label="Deadline">
          <option value="">Any deadline</option>
          <option value="overdue">Overdue</option>
          <option value="at_risk,overdue">At risk or overdue</option>
          <option value="approaching">Due within a week</option>
          <option value="safe">On track</option>
        </Select>
        <Select value={filters.customer} onChange={(e) => set('customer', e.target.value)} aria-label="Client">
          <option value="">All clients</option>
          {meta.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Select value={filters.staff} onChange={(e) => set('staff', e.target.value)} aria-label="Staff">
          <option value="">All staff</option>
          {meta.staff.filter((s) => s.role === 'staff').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <span className="result-count">{data ? `${data.length} order${data.length === 1 ? '' : 's'}` : ''}</span>
        <Seg value={view} onChange={(v) => set('view', v === 'table' ? '' : v)} items={[{ key: 'table', label: <><List size={14} /> Table</> }, { key: 'cards', label: <><LayoutGrid size={14} /> Cards</> }]} />
      </div>

      {error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data ? (
        <Loading rows={5} h={56} />
      ) : data.length === 0 ? (
        <div className="card"><Empty title="No orders match">Try another stage or clear the filters.</Empty></div>
      ) : view === 'cards' ? (
        <div className="order-grid">{data.map((o) => <OrderCard key={o.id} o={o} />)}</div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Order</th><th>Client / product</th><th>Quantity</th><th>Stage</th><th>Priority</th><th>Deadline</th><th style={{ width: 210 }}>Progress</th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
                  <td className="strong nowrap">{o.code}</td>
                  <td><div className="strong">{o.customer}</div><div className="cell-sub">{o.product}{o.assignees.length ? ` · ${o.assignees.join(', ')}` : ''}</div></td>
                  <td className="nowrap">{o.quantity} units</td>
                  <td><StageChip stage={o.stage} onHold={o.on_hold} cancelled={o.cancelled} /></td>
                  <td>{o.risk === 'overdue' ? <Chip tone="bad" dot>Overdue</Chip> : <span>{o.priority === 'normal' ? 'Standard' : cap(o.priority)}</span>}</td>
                  <td className="nowrap" style={o.risk === 'overdue' ? { color: 'var(--bad)' } : undefined}>
                    {fmtShort(o.deadline)}{o.risk === 'overdue' ? ' · late' : ''}
                    {o.risk !== 'done' && o.risk !== 'overdue' && <div className="cell-sub">{relDays(o.deadline, meta.today)}</div>}
                  </td>
                  <td>{o.jobs.length ? <Progress value={o.progress} tone={o.risk === 'overdue' ? 'bad' : undefined} label={<><span>{o.progress}%</span>{o.shortage && <span style={{ color: 'var(--warn)' }}>Material short</span>}</>} /> : <span className="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
