import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Clock, Hammer, PackagePlus, StickyNote, Boxes, ClipboardCheck, Target } from 'lucide-react';
import { useApi } from '../lib/live';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { fmtShort, relDays } from '../lib/format';
import { Chip, Empty, ErrorState, JobStatusChip, Kpi, Loading, PageHead, Panel, Progress, Seg } from '../components/ui';
import { StockTxnModal } from './Inventory';
import { QuickNoteModal } from './QuickNote';

/** Staff home: "What do I need to work on?" — assigned jobs first, quick actions, no analytics. */
export function StaffDashboard() {
  const { data, error, reload } = useApi<any>('/dashboard/staff', ['jobs', 'orders']);
  const { user } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'active' | 'late' | 'upcoming' | 'done'>('active');
  const [modal, setModal] = useState<null | 'stock' | 'note'>(null);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={4} h={110} />;
  const first = user?.name.split(' ')[0];
  const active = [...data.delayed, ...data.today_jobs, ...data.in_progress].filter((j: any, i: number, a: any[]) => a.findIndex((x) => x.id === j.id) === i);
  const lists = { active, late: data.delayed, upcoming: data.upcoming, done: data.completed };
  const next = active[0];

  return (
    <>
      <PageHead eyebrow="Staff workspace" title={`Your work, ${first}`} sub="Your assigned production jobs, quality checks and material updates." />

      <div className="kpis">
        <Kpi label="My active jobs" value={data.counts.open} icon={<Hammer size={17} />} foot="Assigned to you" to="/my-jobs" />
        <Kpi label="Units to finish" value={data.counts.units_left} icon={<Target size={17} />} foot="Across your open jobs" />
        <Kpi label="Due today / overdue" value={data.counts.delayed + data.today_jobs.filter((j: any) => j.due_date === data.today && !j.overdue).length} tone={data.counts.delayed ? 'alert' : undefined} icon={<Clock size={17} />} foot="Jobs that need attention" to="/my-jobs?due=overdue" />
        <Kpi label="Completed" value={data.counts.completed_week} icon={<CheckCircle2 size={17} />} foot="Your completed jobs" to="/my-jobs?status=completed" />
      </div>

      <div className="grid dash-grid mt-24">
        <Panel
          title="My jobs"
          sub="Open a job sheet to record units finished and material used."
          action={<Seg value={tab} onChange={setTab} items={[{ key: 'active', label: `Active · ${active.length}` }, { key: 'late', label: `Late · ${data.delayed.length}` }, { key: 'upcoming', label: 'Upcoming' }, { key: 'done', label: 'Done' }]} />}
        >
          {lists[tab].length === 0 ? (
            <Empty title={tab === 'late' ? 'Nothing late — good work' : 'No jobs here'} />
          ) : (
            <div style={{ marginTop: -10 }}>
              {lists[tab].map((j: any) => <JobRow key={j.id} j={j} />)}
            </div>
          )}
        </Panel>

        <div className="col gap-24" style={{ minWidth: 0 }}>
          <Panel title="Quality checks" sub="Orders waiting for inspection before dispatch." action={<Chip tone={data.qc.length ? 'warn' : 'ok'} dot>{data.qc.length} pending</Chip>}>
            {data.qc.length === 0 ? (
              <div className="empty small" style={{ padding: '18px 0' }}>No quality checks waiting on your jobs.</div>
            ) : (
              <div style={{ marginTop: -8 }}>
                {data.qc.map((o: any) => (
                  <Link key={o.id} to={`/orders/${o.id}`} className="att-item">
                    <span className="att-icon ok"><ClipboardCheck size={17} /></span>
                    <span style={{ minWidth: 0 }}><div className="t">{o.code} · {o.customer}</div><div className="s truncate">{o.product} × {o.quantity}</div></span>
                    <span className="meta">due {fmtShort(o.deadline)}</span>
                  </Link>
                ))}
              </div>
            )}
            <div className="alert info mt-16 small">
              <span>Each process is checked when it finishes: frames after welding and powder coat, then rope and fabric work. The final check happens before dispatch.</span>
            </div>
          </Panel>

          <Panel title="How to update a job" sub="Three steps, once a day or whenever a batch is done.">
            <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 8, color: 'var(--ink-2)' }}>
              <li>Open the job from <b>My jobs</b>.</li>
              <li>Enter the units finished and the material you used.</li>
              <li>Press <b>Save update</b>. The order, stock and admin dashboard update automatically.</li>
            </ol>
          </Panel>
        </div>
      </div>

      <Panel title="Quick actions" sub="Record work as it happens. Progress and material usage roll up to the order." className="mt-24">
        <div className="quick">
          <button onClick={() => (next ? nav(`/jobs/${next.id}`) : nav('/my-jobs'))}><Hammer size={20} />Update job<span className="d">{next ? `${next.code} · ${next.process_name}` : 'Pick a job'}</span></button>
          <button onClick={() => nav('/my-jobs')}><ArrowRight size={20} />All my jobs<span className="d">Search and filter</span></button>
          <button onClick={() => (next ? nav(`/jobs/${next.id}`) : nav('/my-jobs'))}><Boxes size={20} />Record material used<span className="d">On the job sheet</span></button>
          <button onClick={() => setModal('stock')}><PackagePlus size={20} />Stock received<span className="d">Log rope or fabric in</span></button>
          <button onClick={() => setModal('note')}><StickyNote size={20} />Add note<span className="d">To an order’s timeline</span></button>
        </div>
      </Panel>

      {modal === 'stock' && <StockTxnModal onClose={() => setModal(null)} />}
      {modal === 'note' && <QuickNoteModal onClose={() => setModal(null)} />}
    </>
  );
}

function JobRow({ j }: { j: any }) {
  const today = useMeta().today;
  const late = j.overdue || j.status === 'delayed';
  const due = j.due_date ?? j.order_deadline;
  return (
    <div className="job-row">
      <span className={`att-icon ${late ? 'bad' : j.status === 'completed' ? 'ok' : 'ok'}`}>{late ? '!' : j.status === 'completed' ? <CheckCircle2 size={17} /> : <Hammer size={16} />}</span>
      <div style={{ minWidth: 0 }}>
        <div className="t">{j.code} · {j.process_name}</div>
        <div className="s truncate">{j.order_code} · {j.customer} · {j.product}</div>
        <div className="s">
          {j.completed_qty}/{j.quantity} units · <span style={late ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>due {fmtShort(due)} ({relDays(due, today).toLowerCase()})</span>
        </div>
        <div className="mt-8" style={{ maxWidth: 360 }}><Progress value={j.progress} tone={late ? 'bad' : undefined} /></div>
      </div>
      <div className="col" style={{ alignItems: 'flex-end', gap: 10 }}>
        <JobStatusChip status={j.status} overdue={j.overdue} />
        <Link to={`/jobs/${j.id}`} className={j.status === 'completed' ? 'btn sm' : 'btn sm primary'}>
          {j.status === 'completed' ? 'View' : 'Update progress'} <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}
