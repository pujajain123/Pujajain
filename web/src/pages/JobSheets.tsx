import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useApi } from '../lib/live';
import { qs } from '../lib/api';
import { useMeta } from '../lib/meta';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Avatar, Card, Empty, ErrorState, Input, JobStatusChip, Loading, PriorityChip, Progress, Select, Tabs } from '../components/ui';

/** Job Sheets register — every production job with search and filters. `mine` = staff's My Jobs view. */
export function JobSheets({ mine }: { mine?: boolean }) {
  const [params, setParams] = useSearchParams();
  const meta = useMeta();
  const nav = useNavigate();
  const { user } = useAuth();
  const f = {
    q: params.get('q') ?? '',
    process: params.get('process') ?? '',
    staff: mine ? '' : params.get('staff') ?? '',
    status: params.get('status') ?? (mine ? 'open' : ''),
    due: params.get('due') ?? '',
    order: params.get('order') ?? '',
    mine: mine ? '1' : '',
    closed: params.get('closed') ?? '',
  };
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
  };
  const { data, error, reload } = useApi<any[]>(`/jobs${qs(f)}`, ['jobs', 'orders']);
  const processTabs = [{ key: '', label: 'All processes' }, ...meta.processes.map((p) => ({ key: p.key, label: p.name }))];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Production</div><h1>{mine ? 'My jobs' : 'Job sheets'}</h1>
          <div className="sub">{mine ? `Everything assigned to you, ${user?.name}. Open a job sheet to update production.` : 'Detailed production records for Iron, Rope and Fabric work.'}</div>
        </div>
      </div>
      <Tabs value={f.process} onChange={(v) => set('process', v)} items={processTabs} />
      <div className="filters mt-16">
        <div className="search" style={{ maxWidth: 280 }}>
          <Search size={15} style={{ top: 9 }} />
          <Input className="search-in" style={{ height: 32, paddingLeft: 32 }} placeholder="Job, order, client, product" value={f.q} onChange={(e) => set('q', e.target.value)} />
        </div>
        <Select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="open">Open (not completed)</option>
          <option value="not_started">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="on_hold">On hold</option>
          <option value="delayed">Delayed</option>
          <option value="completed">Completed</option>
        </Select>
        {!mine && (
          <Select value={f.staff} onChange={(e) => set('staff', e.target.value)} aria-label="Staff">
            <option value="">All staff</option>
            {meta.staff.filter((s) => s.role === 'staff').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}
        <Select value={f.due} onChange={(e) => set('due', e.target.value)} aria-label="Due">
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Due in 7 days</option>
        </Select>
        <label className="check small"><input type="checkbox" checked={f.closed === '1'} onChange={(e) => set('closed', e.target.checked ? '1' : '')} /> Include completed orders</label>
      </div>
      {error ? (
        <ErrorState error={error} retry={reload} />
      ) : !data ? (
        <Loading rows={6} h={44} />
      ) : (
        <Card pad={false}>
          {data.length === 0 ? (
            <Empty title={mine ? 'No open jobs assigned to you' : 'No job sheets match'} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Job</th><th>Order</th><th>Process</th><th>Staff</th><th className="num">Quantity</th><th style={{ minWidth: 150 }}>Progress</th><th>Due</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((j) => (
                    <tr key={j.id} className="click" onClick={() => nav(`/jobs/${j.id}`)}>
                      <td className="mono strong nowrap">{j.code}</td>
                      <td>
                        <div className="mono">{j.order_code} <PriorityChip p={j.priority} /></div>
                        <div className="cell-sub">{j.customer} · {j.product}</div>
                      </td>
                      <td className="strong">{j.process_name}</td>
                      <td><span className="row gap-4"><Avatar name={j.assignee} sm light />{j.assignee ?? <span className="muted">Unassigned</span>}</span></td>
                      <td className="num">{j.completed_qty} / {j.quantity}</td>
                      <td><Progress value={j.progress} tone={j.status === 'delayed' || j.overdue ? 'bad' : undefined} label={<><span /><span className="strong">{j.progress}%</span></>} /></td>
                      <td className="nowrap">
                        <span style={j.overdue ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>{fmtDate(j.due_date, false)}</span>
                        <div className="cell-sub">Order {fmtDate(j.order_deadline, false)}</div>
                      </td>
                      <td><JobStatusChip status={j.status} overdue={j.overdue} /></td>
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
