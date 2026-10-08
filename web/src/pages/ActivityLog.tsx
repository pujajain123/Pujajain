import { useState } from 'react';
import { Search } from 'lucide-react';
import { useApi } from '../lib/live';
import { qs } from '../lib/api';
import { useMeta } from '../lib/meta';
import { Card, ErrorState, Input, Loading, Select } from '../components/ui';
import { ActivityFeed } from '../components/domain';

export function ActivityLog() {
  const meta = useMeta();
  const [f, setF] = useState({ q: '', actor: '', entity: '', from: '', to: '' });
  const [limit, setLimit] = useState(150);
  const { data, error, reload } = useApi<any[]>(`/activity${qs({ ...f, limit })}`, ['activity', 'orders', 'jobs', 'inventory']);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Workspace</div><h1>Activity log</h1><div className="sub">Append-only audit trail: who changed what, when, from what to what. Entries can’t be edited or deleted.</div></div>
      </div>
      <div className="filters">
        <div className="search" style={{ maxWidth: 280 }}><Search size={15} style={{ top: 9 }} /><Input className="search-in" style={{ height: 32, paddingLeft: 32 }} placeholder="Search messages (e.g. UM-1024)" value={f.q} onChange={set('q')} /></div>
        <Select value={f.actor} onChange={set('actor')} aria-label="Who"><option value="">Everyone</option><option value="system">System</option>{meta.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select value={f.entity} onChange={set('entity')} aria-label="Area"><option value="">All areas</option>{['order', 'job', 'material', 'dispatch', 'customer', 'user', 'settings'].map((e) => <option key={e} value={e}>{e[0].toUpperCase() + e.slice(1)}</option>)}</Select>
        <Input type="date" value={f.from} onChange={set('from')} aria-label="From" />
        <Input type="date" value={f.to} onChange={set('to')} aria-label="To" />
      </div>
      {error ? <ErrorState error={error} retry={reload} /> : !data ? <Loading rows={8} h={40} /> : (
        <Card>
          <ActivityFeed rows={data} showOrder />
          {data.length >= limit && <div className="row mt-16" style={{ justifyContent: 'center' }}><button className="btn" onClick={() => setLimit(limit + 150)}>Load more</button></div>}
        </Card>
      )}
    </>
  );
}
