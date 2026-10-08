import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Hammer, Factory, Boxes, PackagePlus, StickyNote, AlertTriangle, CalendarClock, CheckCircle2, ArrowRight } from 'lucide-react';
import { useApi } from '../lib/live';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { fmtDate, relDays } from '../lib/format';
import { Card, Empty, ErrorState, JobStatusChip, Kpi, Loading, Progress, Tabs } from '../components/ui';
import { StockTxnModal } from './Inventory';
import { QuickNoteModal } from './QuickNote';

/** Staff home: "What do I need to work on?" — no analytics, just today’s work and quick actions. */
export function StaffDashboard() {
  const { data, error, reload } = useApi<any>('/dashboard/staff', ['jobs', 'orders']);
  const { user } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'today' | 'upcoming' | 'delayed' | 'completed'>('today');
  const [modal, setModal] = useState<null | 'stock' | 'note'>(null);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={4} h={90} />;
  const lists = { today: data.today_jobs, upcoming: data.upcoming, delayed: data.delayed, completed: data.completed };
  const firstOpen = data.delayed[0] ?? data.in_progress[0] ?? data.today_jobs[0];
  const hour = new Date().getHours();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {user?.name}</h1>
          <div className="sub">{fmtDate(data.today)} · {data.counts.open} open job(s), {data.counts.units_left} unit(s) to go</div>
        </div>
      </div>

      <div className="quick">
        <button onClick={() => (firstOpen ? nav(`/jobs/${firstOpen.id}`) : nav('/my-jobs'))}><Hammer size={20} />Update job</button>
        <button onClick={() => nav('/my-jobs?status=in_progress')}><Factory size={20} />Update production</button>
        <button onClick={() => (firstOpen ? nav(`/jobs/${firstOpen.id}`) : nav('/my-jobs'))}><Boxes size={20} />Update material</button>
        <button onClick={() => setModal('stock')}><PackagePlus size={20} />Update stock</button>
        <button onClick={() => setModal('note')}><StickyNote size={20} />Add note</button>
      </div>

      <div className="kpis mt-16">
        <Kpi label="Open jobs" value={data.counts.open} icon={<Hammer size={14} />} to="/my-jobs" />
        <Kpi label="Units to go" value={data.counts.units_left} icon={<Factory size={14} />} />
        <Kpi label="Delayed" value={data.counts.delayed} tone={data.counts.delayed ? 'alert' : undefined} icon={<AlertTriangle size={14} />} to="/my-jobs?due=overdue" />
        <Kpi label="Completed" value={data.counts.completed_week} icon={<CheckCircle2 size={14} />} to="/my-jobs?status=completed" />
      </div>

      <div className="section-title"><h2>My jobs</h2><Link to="/my-jobs" className="small muted">All my jobs →</Link></div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'today', label: "Today's jobs", count: data.today_jobs.length },
          { key: 'upcoming', label: 'Upcoming', count: data.upcoming.length },
          { key: 'delayed', label: 'Delayed', count: data.delayed.length, tone: 'bad' },
          { key: 'completed', label: 'Completed', count: data.completed.length },
        ]}
      />
      <div className="order-grid mt-16">
        {lists[tab].length === 0 && <div className="card" style={{ gridColumn: '1/-1' }}><Empty title={tab === 'delayed' ? 'Nothing delayed — nice work' : 'No jobs here'} /></div>}
        {lists[tab].map((j: any) => <JobTile key={j.id} j={j} />)}
      </div>

      {data.recent.length > 0 && (
        <Card title="My recent updates" className="mt-24">
          <div className="col" style={{ gap: 6 }}>
            {data.recent.map((a: any) => <div key={a.id} className="small"><span className="muted">{fmtDate(a.created_at, false)}</span> · {a.message}</div>)}
          </div>
        </Card>
      )}
      {modal === 'stock' && <StockTxnModal onClose={() => setModal(null)} />}
      {modal === 'note' && <QuickNoteModal onClose={() => setModal(null)} />}
    </>
  );
}

function JobTile({ j }: { j: any }) {
  const today = useMeta().today;
  return (
    <Link to={`/jobs/${j.id}`} className="card job-tile" style={j.overdue || j.status === 'delayed' ? { boxShadow: 'inset 3px 0 0 var(--bad), var(--shadow)' } : undefined}>
      <div className="row between">
        <span className="mono strong">{j.code}</span>
        <JobStatusChip status={j.status} overdue={j.overdue} />
      </div>
      <div>
        <div className="strong" style={{ fontSize: 16 }}>{j.process_name}</div>
        <div className="small muted">{j.order_code} · {j.customer} · {j.product}</div>
      </div>
      <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
        <span className="big-number" style={{ fontSize: 24 }}>{j.completed_qty}</span><span className="muted">/ {j.quantity} done</span>
      </div>
      <Progress value={j.progress} tone={j.overdue || j.status === 'delayed' ? 'bad' : undefined} />
      <div className="row between small">
        <span className="row gap-4"><CalendarClock size={14} className="muted" />Due {fmtDate(j.due_date ?? j.order_deadline, false)}</span>
        <span className={j.overdue ? '' : 'muted'} style={j.overdue ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>{relDays(j.due_date ?? j.order_deadline, today)}</span>
      </div>
      <div className="small strong row gap-4" style={{ color: 'var(--accent)' }}>{j.status === 'completed' ? 'View job sheet' : 'Update this job'} <ArrowRight size={13} /></div>
    </Link>
  );
}
