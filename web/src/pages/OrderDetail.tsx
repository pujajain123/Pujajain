import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Check, ChevronLeft, Circle, Clock, FileText, MoreHorizontal, Paperclip, PauseCircle, PlayCircle, Plus, RotateCcw, Truck, Upload, XCircle, ArrowRight, Pencil, PackageCheck,
} from 'lucide-react';
import { ORDER_STAGES, stageIndex, TXN_LABELS, type OrderStage } from '../../../shared/domain';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useIsAdmin } from '../lib/auth';
import { useMeta, useStageLabel } from '../lib/meta';
import { cap, fmtDate, fmtDateTime, num, relDays } from '../lib/format';
import {
  Alert, Avatar, Card, Chip, Empty, ErrorState, Field, Input, JobStatusChip, Loading, Modal, PriorityChip, Progress, RiskChip, Select, StageChip, Tabs, Textarea, cx, useAction,
} from '../components/ui';
import { ActivityFeed, MaterialBar } from '../components/domain';

export function OrderDetail() {
  const id = Number(useParams().id);
  const { data, error, reload } = useApi<any>(`/orders/${id}`, ['orders', 'jobs', 'inventory', 'activity']);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'activity' | 'materials' | 'files' | 'history'>('activity');
  const admin = useIsAdmin();
  const label = useStageLabel();
  const today = useMeta().today;

  useEffect(() => setSelected(null), [id]);
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!data) return <Loading rows={4} h={120} />;
  const { order: o, summary: s } = data;
  const current = o.stage as OrderStage;
  const sel = (selected ?? current) as OrderStage;
  const shortages = data.materials.filter((m: any) => m.shortage > 0);

  return (
    <>
      <div className="crumbs">
        <Link to="/orders" className="row gap-4"><ChevronLeft size={14} /> Orders</Link>
      </div>
      <div className="page-head">
        <div>
          <div className="row wrap gap-12">
            <h1 className="mono" style={{ fontSize: 24 }}>{o.code}</h1>
            <StageChip stage={current} onHold={!!o.on_hold} cancelled={!!o.cancelled_at} lg />
            <RiskChip risk={s.risk} text={s.risk === 'done' ? 'Delivered' : `${relDays(o.deadline, today)}`} />
            <PriorityChip p={o.priority} />
          </div>
          <div className="sub" style={{ fontSize: 15 }}>
            <span className="strong" style={{ color: 'var(--ink)' }}>{o.customer}</span> · {s.product} × {s.quantity}
            {o.po_number && <span className="muted"> · PO {o.po_number}</span>}
          </div>
        </div>
        {admin && <OrderActions data={data} />}
      </div>

      <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        {[
          ['Client', o.customer],
          ['Order date', fmtDate(o.order_date)],
          ['Sky date', fmtDate(o.sky_date)],
          ['Deadline', <span style={s.risk === 'overdue' ? { color: 'var(--bad)' } : undefined}>{fmtDate(o.deadline)}</span>],
          ['Quantity', `${s.quantity} units`],
          ['Priority', cap(o.priority)],
          ['Current status', label(current)],
        ].map(([k, v], i) => (
          <div key={i} style={{ padding: '12px 16px', borderRight: '1px solid var(--line)' }}>
            <div className="stat-label">{k}</div>
            <div className="stat-value truncate">{v}</div>
          </div>
        ))}
        <div style={{ padding: '12px 16px' }}>
          <div className="stat-label">Production</div>
          <div className="row" style={{ marginTop: 6 }}>
            <div className="grow"><Progress value={s.progress} tone={s.risk === 'overdue' ? 'bad' : undefined} /></div>
            <span className="strong">{s.progress}%</span>
          </div>
        </div>
      </div>

      <div className="col mt-12">
        {o.cancelled_at && <Alert tone="bad" title="Order cancelled">{o.cancel_reason} · {fmtDateTime(o.cancelled_at)}</Alert>}
        {!!o.on_hold && <Alert tone="notice" title="Order on hold">{o.hold_reason}</Alert>}
        {s.delayed && !o.cancelled_at && <Alert tone="bad" title="Delayed">{s.delay_reasons.join(' · ')}</Alert>}
        {shortages.length > 0 && stageIndex(current) < stageIndex('quality_check') && (
          <Alert tone="warn" title="Material shortage">
            {shortages.map((m: any) => `${m.material_name}: needs ${num(m.outstanding)} ${m.unit}, short by ${num(m.shortage)} ${m.unit}`).join(' · ')}
          </Alert>
        )}
      </div>

      <div className="grid mt-16 detail-grid">
        <Card title="Order lifecycle">
          <Lifecycle data={data} selected={sel} onSelect={setSelected} />
        </Card>
        <div className="col gap-16" style={{ minWidth: 0 }}>
          <StagePanel stage={sel} data={data} />
        </div>
      </div>

      <div className="card mt-24">
        <div style={{ padding: '0 16px' }}>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { key: 'activity', label: 'Activity timeline', count: data.activity.length },
              { key: 'history', label: 'Status history', count: data.history.length },
              { key: 'materials', label: 'Material movements', count: data.transactions.length },
              { key: 'files', label: 'Attachments', count: data.attachments.length },
            ]}
          />
        </div>
        <div className="card-body">
          {tab === 'activity' && <NotesAndActivity data={data} />}
          {tab === 'history' && <StatusHistory rows={data.history} />}
          {tab === 'materials' && <Movements rows={data.transactions} />}
          {tab === 'files' && <Attachments orderId={o.id} rows={data.attachments} stage={current} />}
        </div>
      </div>
    </>
  );
}

// ───────────────────────── Lifecycle timeline ─────────────────────────
function Lifecycle({ data, selected, onSelect }: { data: any; selected: string; onSelect: (s: string) => void }) {
  const label = useStageLabel();
  const o = data.order;
  const cur = stageIndex(o.stage);
  const done = (i: number) => i < cur || (o.stage === 'completed' && i === cur);
  return (
    <div className="lifecycle">
      {ORDER_STAGES.map((st, i) => {
        const t = data.stage_times[st];
        const state = done(i) ? 'done' : i === cur ? 'current' : 'pending';
        const showProc = st === 'in_production' && data.jobs.length > 0;
        return (
          <div key={st} className={cx('lc-step', state, selected === st && 'selected')}>
            <div className="lc-rail">
              <div className={cx('lc-node', state, state === 'current' && o.on_hold && 'hold')}>{state === 'done' && <Check size={13} strokeWidth={3} />}</div>
              {i < ORDER_STAGES.length - 1 && <div className={cx('lc-line', done(i) && 'done')} />}
            </div>
            <div className="lc-body">
              <div className="lc-title" onClick={() => onSelect(st)} role="button" tabIndex={0}>
                <span className="name">{label(st)}</span>
                {state === 'current' && !o.cancelled_at && <Chip tone={o.on_hold ? 'warn' : 'risk'}>{o.on_hold ? 'On hold' : 'Now'}</Chip>}
              </div>
              {t && <div className="tiny muted">{fmtDateTime(t.entered_at)} · {t.by}</div>}
              {showProc && (
                <div className="lc-sub">
                  {data.jobs.map((j: any) => (
                    <Link to={`/jobs/${j.id}`} key={j.id} className="lc-proc">
                      {j.status === 'completed' ? <Check size={14} color="var(--ok)" strokeWidth={3} /> : j.status === 'not_started' ? <Circle size={12} color="var(--faint)" /> : <Circle size={12} fill={j.status === 'delayed' ? 'var(--bad)' : 'var(--risk)'} color="transparent" />}
                      <span className={j.status === 'not_started' ? 'muted' : 'strong'}>{j.process_name}</span>
                      <Progress value={j.progress} tone={j.status === 'delayed' ? 'bad' : undefined} />
                      <span className="small right muted">{j.completed_qty}/{j.quantity}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────── Stage panels ─────────────────────────
function StagePanel({ stage, data }: { stage: OrderStage; data: any }) {
  const label = useStageLabel();
  const cur = stageIndex(data.order.stage);
  const idx = stageIndex(stage);
  const status = idx < cur || data.order.stage === 'completed' ? <Chip tone="ok"><Check size={12} /> Done</Chip> : idx === cur ? <Chip tone="risk">Current stage</Chip> : <Chip>Upcoming</Chip>;
  const head = (
    <div className="row between">
      <div className="row"><h2>{label(stage)}</h2>{status}</div>
      {data.stage_times[stage] && <span className="small muted">Entered {fmtDateTime(data.stage_times[stage].entered_at)} by {data.stage_times[stage].by}</span>}
    </div>
  );
  switch (stage) {
    case 'received':
      return <ReceivedPanel data={data} head={head} />;
    case 'reviewed':
      return <ReviewedPanel data={data} head={head} />;
    case 'preparing':
    case 'ready_for_production':
      return <PreparationPanel data={data} head={head} stage={stage} />;
    case 'in_production':
      return <ProductionPanel data={data} head={head} />;
    case 'quality_check':
      return <QualityPanel data={data} head={head} />;
    case 'ready_for_dispatch':
    case 'dispatched':
      return <DispatchPanel data={data} head={head} stage={stage} />;
    case 'completed':
      return <CompletedPanel data={data} head={head} />;
  }
}

function ReceivedPanel({ data, head }: { data: any; head: ReactNode }) {
  const o = data.order;
  return (
    <Card title={head}>
      <div className="grid g2">
        <dl className="kv">
          <dt>Order ID</dt><dd className="mono strong">{o.code}</dd>
          <dt>Client</dt><dd className="strong">{o.customer}</dd>
          <dt>Contact</dt><dd>{o.contact_person ?? '—'}{o.phone && <div className="small muted">{o.phone}</div>}{o.email && <div className="small muted">{o.email}</div>}</dd>
          <dt>Delivery address</dt><dd>{o.delivery_address ?? o.customer_address ?? '—'}</dd>
          <dt>PO / reference</dt><dd>{o.po_number ?? '—'}</dd>
          <dt>Order source</dt><dd>{o.source ?? '—'}</dd>
        </dl>
        <dl className="kv">
          <dt>Order date</dt><dd>{fmtDate(o.order_date)}</dd>
          <dt>Required deadline</dt><dd className="strong">{fmtDate(o.deadline)}</dd>
          <dt>Sky date</dt><dd>{fmtDate(o.sky_date)} <span className="small muted">(internal target)</span></dd>
          <dt>Priority</dt><dd><PriorityChip p={o.priority} /></dd>
          <dt>Created by</dt><dd>{o.created_by_name ?? '—'}</dd>
          <dt>Created at</dt><dd>{fmtDateTime(o.created_at)}</dd>
        </dl>
      </div>
      <div className="divider" />
      <h3>Products</h3>
      <ItemsTable items={data.items} />
      {o.notes && (<><div className="divider" /><h3>Notes</h3><p style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{o.notes}</p></>)}
      <div className="small muted mt-12"><Paperclip size={13} style={{ verticalAlign: -2 }} /> {data.attachments.length} attachment(s) — see the Attachments tab below.</div>
    </Card>
  );
}

function ItemsTable({ items }: { items: any[] }) {
  return (
    <div className="table-wrap mt-8">
      <table className="table dense">
        <thead><tr><th>Product</th><th>SKU</th><th className="num">Qty</th><th>Dimensions</th><th>Colour</th><th>Finish</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td className="strong">{i.product}{i.specifications && <div className="cell-sub">{i.specifications}</div>}</td>
              <td className="mono muted">{i.sku}</td>
              <td className="num strong">{i.quantity}</td>
              <td>{i.dimensions ?? '—'}</td>
              <td>{i.color ?? '—'}</td>
              <td>{i.finish ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewedPanel({ data, head }: { data: any; head: ReactNode }) {
  const rev = data.history.find((h: any) => h.to_stage === 'reviewed');
  return (
    <Card title={head}>
      {rev ? (
        <dl className="kv">
          <dt>Reviewed by</dt><dd className="strong">{rev.actor ?? 'System'}</dd>
          <dt>Reviewed on</dt><dd>{fmtDateTime(rev.created_at)}</dd>
          <dt>Review note</dt><dd>{rev.note ?? '—'}</dd>
        </dl>
      ) : (
        <Empty title="Not reviewed yet">An admin confirms specs, quantity and deadline before preparation starts.</Empty>
      )}
      <div className="divider" />
      <h3>Confirmed scope</h3>
      <ItemsTable items={data.items} />
    </Card>
  );
}

function PreparationPanel({ data, head, stage }: { data: any; head: ReactNode; stage: string }) {
  const admin = useIsAdmin();
  const checklist = data.checklists.filter((c: any) => c.stage === 'preparing');
  const { run, busy } = useAction();
  const done = checklist.filter((c: any) => c.done).length;
  return (
    <>
      <Card title={head}>
        <div className="grid g2">
          <dl className="kv">
            <dt>Preparation status</dt>
            <dd>{stage === 'ready_for_production' || stageIndex(data.order.stage) >= stageIndex('ready_for_production') ? <Chip tone="ok">Prepared</Chip> : stageIndex(data.order.stage) === stageIndex('preparing') ? <Chip tone="warn">In preparation</Chip> : <Chip>Not started</Chip>}</dd>
            <dt>Quantity confirmed</dt><dd>{data.summary.quantity} units</dd>
            <dt>Processes</dt><dd>{data.jobs.map((j: any) => j.process_name).join(' → ') || '—'}</dd>
          </dl>
          <div>
            <div className="row between"><h3>Preparation checklist</h3><span className="small muted">{done}/{checklist.length}</span></div>
            {checklist.length === 0 ? (
              <div className="small muted mt-8">Created automatically when preparation starts.</div>
            ) : (
              <div className="col mt-8" style={{ gap: 6 }}>
                {checklist.map((c: any) => (
                  <label key={c.id} className="check small">
                    <input type="checkbox" checked={!!c.done} disabled={busy} onChange={(e) => run(() => api.post(`/orders/${data.order.id}/checklist`, { item_id: c.id, done: e.target.checked }))} />
                    <span className={c.done ? '' : 'strong'}>{c.label}</span>
                    {c.done ? <span className="tiny muted">· {c.done_by_name}</span> : null}
                  </label>
                ))}
                {admin && <AddChecklist orderId={data.order.id} stage="preparing" />}
              </div>
            )}
          </div>
        </div>
      </Card>
      <MaterialReadiness data={data} />
      <StaffPlan data={data} />
    </>
  );
}

function AddChecklist({ orderId, stage }: { orderId: number; stage: string }) {
  const [v, setV] = useState('');
  const { run } = useAction();
  return (
    <form className="row" onSubmit={(e) => (e.preventDefault(), v.trim() && run(() => api.post(`/orders/${orderId}/checklist`, { stage, label: v })).then(() => setV('')))}>
      <Input style={{ height: 30 }} placeholder="Add checklist item" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn sm" disabled={!v.trim()}><Plus size={14} /></button>
    </form>
  );
}

function MaterialReadiness({ data }: { data: any }) {
  const admin = useIsAdmin();
  const { run, busy } = useAction();
  const [edit, setEdit] = useState<any | null>(null);
  const locked = stageIndex(data.order.stage) >= stageIndex('quality_check');
  return (
    <Card
      title="Material readiness"
      actions={
        admin && !locked && (
          <>
            <button className="btn sm" onClick={() => setEdit({})}><Plus size={14} /> Requirement</button>
            <button className="btn sm" disabled={busy} onClick={() => run(() => api.post(`/orders/${data.order.id}/allocate`), 'Available stock reserved')}>
              <PackageCheck size={14} /> Reserve stock
            </button>
          </>
        )
      }
    >
      {data.materials.length === 0 ? (
        <Empty title="No material requirements">Iron work draws no tracked stock. Add rope or fabric requirements if needed.</Empty>
      ) : (
        <div className="col gap-16">
          {data.materials.map((m: any) => (
            <div key={m.requirement_id}>
              <div className="row between wrap">
                <div>
                  <Link to={`/inventory/${m.material_id}`} className="strong">{m.material_name}</Link>
                  <span className="small muted"> · {m.process_name ?? 'General'}</span>
                </div>
                {m.shortage > 0 ? <Chip tone="bad">⚠ Shortage {num(m.shortage)} {m.unit}</Chip> : m.outstanding === 0 ? <Chip tone="ok">✓ Consumed</Chip> : <Chip tone="ok">✓ Ready</Chip>}
              </div>
              <div className="grid g4 mt-8 small" style={{ gap: 8 }}>
                <div><div className="muted">Required</div><div className="strong">{num(m.required)} {m.unit}</div></div>
                <div><div className="muted">Consumed</div><div className="strong">{num(m.consumed)} {m.unit}</div></div>
                <div><div className="muted">Reserved for order</div><div className="strong">{num(m.reserved)} {m.unit}</div></div>
                <div><div className="muted">Free in store</div><div className="strong">{num(m.available_in_store)} {m.unit}</div></div>
              </div>
              <div className="mt-8"><MaterialBar required={m.required} consumed={m.consumed} reserved={m.reserved} shortage={m.shortage} unit={m.unit} /></div>
              {admin && !locked && <button className="btn ghost sm mt-8" onClick={() => setEdit(m)}><Pencil size={13} /> Edit requirement</button>}
            </div>
          ))}
        </div>
      )}
      {edit && <RequirementModal orderId={data.order.id} jobs={data.jobs} req={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function RequirementModal({ orderId, req, jobs, onClose }: { orderId: number; req: any; jobs: any[]; onClose: () => void }) {
  const meta = useMeta();
  const [f, setF] = useState({ material_id: req.material_id ?? '', process_id: req.process_id ?? '', required_qty: req.required ?? '' });
  const { run, busy, fields } = useAction();
  const save = () =>
    run(
      () =>
        (req.requirement_id ? api.put(`/orders/${orderId}/requirements/${req.requirement_id}`, body()) : api.post(`/orders/${orderId}/requirements`, body())),
      'Requirement saved',
    ).then((r) => r && onClose());
  const body = () => ({ material_id: Number(f.material_id), process_id: f.process_id ? Number(f.process_id) : null, required_qty: Number(f.required_qty) });
  return (
    <Modal title={req.requirement_id ? 'Edit material requirement' : 'Add material requirement'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="col gap-12">
        <Field label="Material" error={fields.material_id}>
          <Select value={f.material_id} onChange={(e) => setF({ ...f, material_id: e.target.value })}>
            <option value="">Select…</option>
            {meta.materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}
          </Select>
        </Field>
        <Field label="For process">
          <Select value={f.process_id} onChange={(e) => setF({ ...f, process_id: e.target.value })}>
            <option value="">General</option>
            {jobs.map((j) => <option key={j.process_id} value={j.process_id}>{j.process_name}</option>)}
          </Select>
        </Field>
        <Field label="Required quantity" error={fields.required_qty}>
          <Input type="number" min={0} step="0.1" value={f.required_qty} onChange={(e) => setF({ ...f, required_qty: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function StaffPlan({ data }: { data: any }) {
  const admin = useIsAdmin();
  const meta = useMeta();
  const { run } = useAction();
  const patch = (jobId: number, body: any) => run(() => api.patch(`/jobs/${jobId}`, body), 'Job sheet updated');
  return (
    <Card title="Staff assignment & production plan" pad={false}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Job</th><th>Process</th><th>Assigned staff</th><th>Planned start</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>
            {data.jobs.map((j: any) => (
              <tr key={j.id}>
                <td><Link to={`/jobs/${j.id}`} className="mono strong">{j.code}</Link></td>
                <td className="strong">{j.process_name}</td>
                <td>
                  {admin ? (
                    <Select style={{ height: 30, minWidth: 130 }} value={j.assigned_to ?? ''} onChange={(e) => patch(j.id, { assigned_to: e.target.value ? Number(e.target.value) : null })} aria-label="Assigned staff">
                      <option value="">Unassigned</option>
                      {meta.staff.filter((s) => s.active && s.role === 'staff').map((s) => (
                        <option key={s.id} value={s.id}>{s.name}{s.primary_process_id === j.process_id ? ' ★' : ''}</option>
                      ))}
                    </Select>
                  ) : j.assignee ?? '—'}
                </td>
                <td>{admin ? <Input type="date" style={{ height: 30 }} value={j.start_date ?? ''} onChange={(e) => patch(j.id, { start_date: e.target.value || null })} aria-label="Planned start" /> : fmtDate(j.start_date)}</td>
                <td>{admin ? <Input type="date" style={{ height: 30 }} value={j.due_date ?? ''} max={data.order.deadline} onChange={(e) => patch(j.id, { due_date: e.target.value || null })} aria-label="Due date" /> : fmtDate(j.due_date)}</td>
                <td><JobStatusChip status={j.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ProductionPanel({ data, head }: { data: any; head: ReactNode }) {
  const s = data.summary;
  return (
    <>
      <Card title={head}>
        <div className="row gap-24 wrap">
          <div className="metric">
            <span className="stat-label">Overall</span>
            <span className="big-number">{s.progress}%</span>
          </div>
          <div className="grow" style={{ minWidth: 200 }}>
            <Progress value={s.progress} lg tone={s.risk === 'overdue' ? 'bad' : s.risk === 'at_risk' ? 'risk' : undefined} />
            <div className="small muted mt-8">
              {data.jobs.reduce((a: number, j: any) => a + j.completed_qty, 0)} of {data.jobs.reduce((a: number, j: any) => a + j.quantity, 0)} process-units complete · deadline {fmtDate(data.order.deadline)}
            </div>
          </div>
        </div>
      </Card>
      <div className="grid g3">
        {data.jobs.map((j: any) => (
          <Link to={`/jobs/${j.id}`} key={j.id} className="card job-tile">
            <div className="row between">
              <h3>{j.process_name}</h3>
              <JobStatusChip status={j.status} overdue={s.jobs.find((x: any) => x.id === j.id)?.overdue} />
            </div>
            <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
              <span className="big-number" style={{ fontSize: 26 }}>{j.completed_qty}</span>
              <span className="muted">/ {j.quantity}</span>
            </div>
            <Progress value={j.progress} tone={j.status === 'delayed' ? 'bad' : undefined} />
            <div className="row between small">
              <span className="row gap-4"><Avatar name={j.assignee} sm light /> {j.assignee ?? 'Unassigned'}</span>
              <span className="muted">Due {fmtDate(j.due_date, false)}</span>
            </div>
            {j.delay_reason && j.status === 'delayed' && <div className="small" style={{ color: 'var(--bad)' }}>{j.delay_reason}</div>}
            <div className="small strong row gap-4" style={{ color: 'var(--accent)' }}>Open job sheet <ArrowRight size={13} /></div>
          </Link>
        ))}
      </div>
      <MaterialReadiness data={data} />
    </>
  );
}

function QualityPanel({ data, head }: { data: any; head: ReactNode }) {
  const [open, setOpen] = useState(false);
  const isCurrent = data.order.stage === 'quality_check' && !data.order.on_hold;
  return (
    <Card title={head} actions={isCurrent && <button className="btn primary sm" onClick={() => setOpen(true)}>Record quality check</button>}>
      {data.quality_checks.length === 0 ? (
        <Empty title="No quality checks recorded">{isCurrent ? 'Record the inspection result to move the order to Ready for Dispatch.' : 'Quality check happens once every job sheet is complete.'}</Empty>
      ) : (
        <div className="col gap-12">
          {data.quality_checks.map((q: any) => (
            <div key={q.id} className="row top gap-12">
              <Chip tone={q.result === 'passed' ? 'ok' : q.result === 'rework' ? 'warn' : 'bad'} lg>{cap(q.result)}</Chip>
              <div className="grow">
                <div className="strong">{q.qty_checked != null ? `${q.qty_passed ?? 0} of ${q.qty_checked} passed${q.qty_rejected ? ` · ${q.qty_rejected} rejected` : ''}` : 'Inspection recorded'}</div>
                <div className="small">{q.notes}</div>
                <div className="tiny muted">{q.checked_by_name} · {fmtDateTime(q.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <QCModal data={data} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function QCModal({ data, onClose }: { data: any; onClose: () => void }) {
  const q = data.summary.quantity;
  const [f, setF] = useState({ result: 'passed', qty_checked: q, qty_passed: q, qty_rejected: 0, notes: '' });
  const { run, busy, fields, error } = useAction();
  return (
    <Modal
      title="Record quality check"
      sub={`${data.order.code} · ${data.summary.product} × ${q}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => api.post(`/orders/${data.order.id}/quality-checks`, f), 'Quality check recorded').then((r) => r && onClose())}>Save result</button></>}
    >
      <div className="col gap-12">
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="grid g3" style={{ gap: 8 }}>
          {(['passed', 'rework', 'failed'] as const).map((r) => (
            <button key={r} type="button" className={cx('option-card', f.result === r && 'on')} onClick={() => setF({ ...f, result: r })}>
              <div className="strong">{cap(r)}</div>
              <div className="tiny muted">{r === 'passed' ? '→ Ready for dispatch' : r === 'rework' ? '→ Back to production' : 'Stays in QC'}</div>
            </button>
          ))}
        </div>
        <div className="grid g3" style={{ gap: 8 }}>
          <Field label="Checked"><Input type="number" value={f.qty_checked} onChange={(e) => setF({ ...f, qty_checked: Number(e.target.value) })} /></Field>
          <Field label="Passed"><Input type="number" value={f.qty_passed} onChange={(e) => setF({ ...f, qty_passed: Number(e.target.value) })} /></Field>
          <Field label="Rejected"><Input type="number" value={f.qty_rejected} onChange={(e) => setF({ ...f, qty_rejected: Number(e.target.value) })} /></Field>
        </div>
        <Field label={f.result === 'passed' ? 'Notes' : 'What needs fixing? (required)'} error={fields.notes}>
          <Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Weave tension, weld finish, stitching, colour match…" />
        </Field>
      </div>
    </Modal>
  );
}

function DispatchPanel({ data, head, stage }: { data: any; head: ReactNode; stage: string }) {
  const [open, setOpen] = useState(false);
  const o = data.order;
  const checklist = data.checklists.filter((c: any) => c.stage === 'ready_for_dispatch');
  const { run, busy } = useAction();
  const admin = useIsAdmin();
  const remaining = data.summary.quantity - data.dispatched_qty;
  const canDispatch = admin && ['ready_for_dispatch', 'dispatched'].includes(o.stage) && remaining > 0 && !o.cancelled_at;
  const qc = data.quality_checks[0];
  const pending = checklist.filter((c: any) => !c.done);
  return (
    <>
      <Card title={head} actions={canDispatch && <button className="btn primary sm" onClick={() => setOpen(true)}><Truck size={14} /> Record dispatch</button>}>
        <div className="grid g2">
          <dl className="kv">
            <dt>Quantity</dt><dd className="strong">{data.summary.quantity} units</dd>
            <dt>Dispatched</dt><dd>{data.dispatched_qty} units {remaining > 0 && data.dispatched_qty > 0 && <Chip tone="warn">Partial · {remaining} remaining</Chip>}</dd>
            <dt>Quality check</dt><dd>{qc ? <Chip tone={qc.result === 'passed' ? 'ok' : 'bad'}>{cap(qc.result)} · {fmtDate(qc.created_at)}</Chip> : '—'}</dd>
            <dt>Packaging</dt><dd>{checklist.find((c: any) => /packag/i.test(c.label))?.done ? <Chip tone="ok">Packed</Chip> : <Chip tone="warn">Pending</Chip>}</dd>
            <dt>Dispatch readiness</dt><dd>{checklist.length ? (pending.length ? <Chip tone="warn">{pending.length} item(s) pending</Chip> : <Chip tone="ok">Ready</Chip>) : '—'}</dd>
            <dt>Deliver to</dt><dd>{o.delivery_address ?? o.customer_address ?? '—'}</dd>
          </dl>
          <div>
            <h3>Dispatch readiness checklist</h3>
            {checklist.length === 0 ? (
              <div className="small muted mt-8">Created when the order becomes Ready for Dispatch.</div>
            ) : (
              <div className="col mt-8" style={{ gap: 6 }}>
                {checklist.map((c: any) => (
                  <label key={c.id} className="check small">
                    <input type="checkbox" checked={!!c.done} disabled={busy} onChange={(e) => run(() => api.post(`/orders/${o.id}/checklist`, { item_id: c.id, done: e.target.checked }))} />
                    <span className={c.done ? '' : 'strong'}>{c.label}</span>
                    {c.done ? <span className="tiny muted">· {c.done_by_name}</span> : null}
                  </label>
                ))}
                {admin && <AddChecklist orderId={o.id} stage="ready_for_dispatch" />}
              </div>
            )}
            <div className="small muted mt-12"><FileText size={13} style={{ verticalAlign: -2 }} /> Documents (invoice, e-way bill, photos) go in Attachments below.</div>
          </div>
        </div>
      </Card>
      <Card title={`Dispatch records${stage === 'dispatched' ? '' : ''}`} pad={false}>
        {data.dispatches.length === 0 ? (
          <Empty title="Not dispatched yet" icon={<Truck size={28} />} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date & time</th><th className="num">Qty</th><th>Transporter</th><th>Vehicle</th><th>Tracking / LR</th><th>Invoice</th><th>E-way bill</th><th>By</th></tr></thead>
              <tbody>
                {data.dispatches.map((d: any) => (
                  <tr key={d.id}>
                    <td className="nowrap">{fmtDateTime(d.dispatched_at.length === 16 ? d.dispatched_at + ':00+05:30' : d.dispatched_at)}{d.notes && <div className="cell-sub">{d.notes}</div>}</td>
                    <td className="num strong">{d.quantity}</td>
                    <td>{d.transporter ?? '—'}</td>
                    <td className="mono small">{d.vehicle_no ?? '—'}</td>
                    <td className="mono small">{d.tracking_ref ?? '—'}</td>
                    <td className="mono small">{d.invoice_no ?? '—'}</td>
                    <td className="mono small">{d.eway_bill ?? '—'}</td>
                    <td>{d.dispatched_by_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <DispatchModal data={data} remaining={remaining} onClose={() => setOpen(false)} />}
    </>
  );
}

function DispatchModal({ data, remaining, onClose }: { data: any; remaining: number; onClose: () => void }) {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [f, setF] = useState<any>({ dispatched_at: local, quantity: remaining, transporter: '', vehicle_no: '', tracking_ref: '', invoice_no: '', eway_bill: '', packages: '', notes: '' });
  const { run, busy, fields, error } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const submit = () =>
    run(() => api.post(`/orders/${data.order.id}/dispatches`, { ...f, quantity: Number(f.quantity), packages: f.packages ? Number(f.packages) : null }), 'Dispatch recorded').then((r) => r !== undefined && onClose());
  return (
    <Modal wide title="Record dispatch" sub={`${data.order.code} · ${remaining} unit(s) left to dispatch`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={submit}><Truck size={14} /> Confirm dispatch</button></>}>
      {error && <div className="mt-8"><Alert tone="bad">{error}</Alert></div>}
      <div className="form-grid mt-8">
        <Field label="Dispatch date & time" error={fields.dispatched_at}><Input type="datetime-local" value={f.dispatched_at} onChange={set('dispatched_at')} /></Field>
        <Field label="Quantity dispatched" error={fields.quantity} hint={Number(f.quantity) < remaining ? `Partial — ${remaining - Number(f.quantity)} will remain` : 'Full balance'}>
          <Input type="number" min={1} max={remaining} value={f.quantity} onChange={set('quantity')} />
        </Field>
        <Field label="Transporter / courier"><Input value={f.transporter} onChange={set('transporter')} placeholder="VRL Logistics, own tempo…" /></Field>
        <Field label="Vehicle number"><Input value={f.vehicle_no} onChange={set('vehicle_no')} /></Field>
        <Field label="Tracking / LR number"><Input value={f.tracking_ref} onChange={set('tracking_ref')} /></Field>
        <Field label="Packages"><Input type="number" value={f.packages} onChange={set('packages')} /></Field>
        <Field label="Invoice number"><Input value={f.invoice_no} onChange={set('invoice_no')} /></Field>
        <Field label="E-way bill"><Input value={f.eway_bill} onChange={set('eway_bill')} /></Field>
        <Field label="Dispatch notes" className="full"><Textarea value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

function CompletedPanel({ data, head }: { data: any; head: ReactNode }) {
  const o = data.order;
  const t = data.stage_times;
  const completed = o.stage === 'completed';
  const story: [string, string | undefined][] = [
    ['Order received', t.received?.entered_at],
    ['Reviewed', t.reviewed?.entered_at],
    ['Preparation started', t.preparing?.entered_at],
    ...data.jobs.flatMap((j: any) => [[`${j.process_name} started`, j.started_at], [`${j.process_name} completed`, j.completed_at]] as [string, string][]),
    ['Quality check', t.quality_check?.entered_at],
    ['Ready for dispatch', t.ready_for_dispatch?.entered_at],
    ['Dispatched', t.dispatched?.entered_at],
    ['Completed', t.completed?.entered_at],
  ];
  return (
    <Card title={head}>
      {!completed && <div className="small muted" style={{ marginBottom: 12 }}>The order’s story so far:</div>}
      <div className="col" style={{ gap: 0 }}>
        {story.map(([k, v], i) => (
          <div key={i} className="row between" style={{ padding: '7px 0', borderBottom: '1px solid var(--line)' }}>
            <span className={v ? 'strong' : 'muted'}>{v ? <Check size={13} color="var(--ok)" style={{ verticalAlign: -2, marginRight: 6 }} /> : <Clock size={13} style={{ verticalAlign: -2, marginRight: 6 }} />}{k}</span>
            <span className="small muted">{v ? fmtDateTime(v) : 'pending'}</span>
          </div>
        ))}
      </div>
      <div className="grid g3 mt-16">
        <div><div className="stat-label">Staff involved</div><div className="stat-value">{[...new Set(data.jobs.map((j: any) => j.assignee).filter(Boolean))].join(', ') || '—'}</div></div>
        <div><div className="stat-label">Materials consumed</div><div className="stat-value">{data.materials.map((m: any) => `${num(m.consumed)} ${m.unit} ${m.material_name.split('—')[0].trim()}`).join(', ') || '—'}</div></div>
        <div><div className="stat-label">Delivered vs deadline</div><div className="stat-value">{t.dispatched ? (t.dispatched.entered_at.slice(0, 10) <= o.deadline ? <Chip tone="ok">On time</Chip> : <Chip tone="bad">Late</Chip>) : '—'}</div></div>
      </div>
    </Card>
  );
}

// ───────────────────────── Header actions ─────────────────────────
function OrderActions({ data }: { data: any }) {
  const o = data.order;
  const label = useStageLabel();
  const [modal, setModal] = useState<null | 'advance' | 'back' | 'hold' | 'cancel' | 'edit'>(null);
  const [menu, setMenu] = useState(false);
  const idx = stageIndex(o.stage);
  const next = ORDER_STAGES[idx + 1];
  const prev = ORDER_STAGES[idx - 1];
  if (o.cancelled_at) return null;
  return (
    <div className="row" style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setModal('edit')}><Pencil size={14} /> Edit</button>
      {o.on_hold ? (
        <button className="btn" onClick={() => setModal('hold')}><PlayCircle size={15} /> Resume</button>
      ) : (
        next && <button className="btn primary" onClick={() => setModal('advance')}>Move to {label(next)} <ArrowRight size={14} /></button>
      )}
      <button className="btn icon-btn" onClick={() => setMenu(!menu)} aria-label="More actions"><MoreHorizontal size={16} /></button>
      {menu && (
        <div className="card" style={{ position: 'absolute', right: 0, top: 40, zIndex: 30, padding: 6, minWidth: 210, boxShadow: 'var(--shadow-lg)' }} onMouseLeave={() => setMenu(false)}>
          {prev && o.stage !== 'completed' && <button className="btn ghost block" style={{ justifyContent: 'flex-start' }} onClick={() => (setModal('back'), setMenu(false))}><RotateCcw size={14} /> Move back to {label(prev)}</button>}
          {!o.on_hold && o.stage !== 'completed' && <button className="btn ghost block" style={{ justifyContent: 'flex-start' }} onClick={() => (setModal('hold'), setMenu(false))}><PauseCircle size={14} /> Put on hold</button>}
          {idx < stageIndex('dispatched') && <button className="btn ghost danger block" style={{ justifyContent: 'flex-start' }} onClick={() => (setModal('cancel'), setMenu(false))}><XCircle size={14} /> Cancel order</button>}
        </div>
      )}
      {modal === 'advance' && next && <TransitionModal order={o} to={next} onClose={() => setModal(null)} />}
      {modal === 'back' && prev && <TransitionModal order={o} to={prev} back onClose={() => setModal(null)} />}
      {modal === 'hold' && <HoldModal order={o} onClose={() => setModal(null)} />}
      {modal === 'cancel' && <CancelModal order={o} onClose={() => setModal(null)} />}
      {modal === 'edit' && <EditOrderModal order={o} onClose={() => setModal(null)} />}
    </div>
  );
}

function TransitionModal({ order, to, back, onClose }: { order: any; to: OrderStage; back?: boolean; onClose: () => void }) {
  const label = useStageLabel();
  const { data: check } = useApi<any>(`/orders/${order.id}/transition-check?to=${to}`, ['orders', 'jobs']);
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const { run, busy, error } = useAction();
  const ok = check && check.allowed && (!check.warnings.length || ack) && (!back || note.trim());
  return (
    <Modal
      title={back ? `Move back to ${label(to)}` : `Move to ${label(to)}`}
      sub={`${order.code} · currently ${label(order.stage)}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!ok || busy} onClick={() => run(() => api.post(`/orders/${order.id}/transition`, { to, note: note || null, acknowledge: ack }), `Moved to ${label(to)}`).then((r) => r && onClose())}>Confirm</button></>}
    >
      {!check ? (
        <Loading rows={2} h={40} />
      ) : (
        <div className="col gap-12">
          {error && <Alert tone="bad">{error}</Alert>}
          {check.blockers.length > 0 && (
            <Alert tone="bad" title="This move is blocked">
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{check.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul>
            </Alert>
          )}
          {check.warnings.length > 0 && (
            <>
              <Alert tone="warn" title="Please review">
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{check.warnings.map((b: string) => <li key={b}>{b}</li>)}</ul>
              </Alert>
              <label className="check small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I’ve reviewed these and want to continue</label>
            </>
          )}
          {check.allowed && !check.warnings.length && !back && <Alert tone="ok">All checks for {label(to)} are satisfied.</Alert>}
          <Field label={back ? 'Reason (required)' : 'Note (optional)'}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={back ? 'Why is the order going back?' : 'Visible in the order’s history'} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function HoldModal({ order, onClose }: { order: any; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  const hold = !order.on_hold;
  return (
    <Modal title={hold ? 'Put order on hold' : 'Resume order'} sub={order.code} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || (hold && !reason.trim())} onClick={() => run(() => api.post(`/orders/${order.id}/hold`, { hold, reason }), hold ? 'Order on hold' : 'Order resumed').then((r) => r && onClose())}>{hold ? 'Put on hold' : 'Resume'}</button></>}>
      <Field label={hold ? 'Reason (required)' : 'Note (optional)'}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
      {hold && <div className="small muted mt-8">Staff can’t update job sheets while the order is on hold. Stage and history are kept.</div>}
    </Modal>
  );
}

function CancelModal({ order, onClose }: { order: any; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title={`Cancel ${order.code}?`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Keep order</button><button className="btn danger solid" disabled={busy || reason.trim().length < 3} onClick={() => run(() => api.post(`/orders/${order.id}/cancel`, { reason }), 'Order cancelled').then((r) => r && onClose())}>Cancel order</button></>}>
      <Alert tone="bad">Reserved materials are released back to stock. The order and its full history stay on record.</Alert>
      <Field label="Reason" className="mt-12"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function EditOrderModal({ order, onClose }: { order: any; onClose: () => void }) {
  const [f, setF] = useState({ deadline: order.deadline, sky_date: order.sky_date ?? '', priority: order.priority, po_number: order.po_number ?? '', source: order.source ?? '', delivery_address: order.delivery_address ?? '', notes: order.notes ?? '' });
  const { run, busy, fields, error } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const changes = useMemo(() => Object.fromEntries(Object.entries(f).filter(([k, v]) => String(v ?? '') !== String(order[k] ?? ''))), [f, order]);
  return (
    <Modal
      wide
      title={`Edit ${order.code}`}
      sub="Changes flow to Master Production, job sheets, dashboards and the audit trail."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !Object.keys(changes).length} onClick={() => run(() => api.patch(`/orders/${order.id}`, { ...changes, ...(changes.sky_date === '' ? { sky_date: null } : {}) }), 'Order updated').then((r) => r && onClose())}>Save {Object.keys(changes).length || ''} change(s)</button></>}
    >
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="form-grid mt-8">
        <Field label="Delivery deadline" error={fields.deadline}><Input type="date" value={f.deadline} onChange={set('deadline')} /></Field>
        <Field label="Sky date" error={fields.sky_date} hint="Internal target before the client deadline"><Input type="date" value={f.sky_date} onChange={set('sky_date')} /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={set('priority')}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{cap(p)}</option>)}</Select></Field>
        <Field label="PO / reference"><Input value={f.po_number} onChange={set('po_number')} /></Field>
        <Field label="Order source"><Input value={f.source} onChange={set('source')} /></Field>
        <Field label="Delivery address"><Input value={f.delivery_address} onChange={set('delivery_address')} /></Field>
        <Field label="Notes" className="full"><Textarea value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

// ───────────────────────── Lower tabs ─────────────────────────
function NotesAndActivity({ data }: { data: any }) {
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: 12 }}>
      <form className="row" onSubmit={(e) => (e.preventDefault(), run(() => api.post(`/orders/${data.order.id}/notes`, { note }), 'Note added').then((r) => r && setNote('')))}>
        <Input placeholder="Add a note to this order’s timeline…" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn" disabled={busy || !note.trim()}>Add note</button>
      </form>
      <ActivityFeed rows={data.activity} />
    </div>
  );
}

function StatusHistory({ rows }: { rows: any[] }) {
  const label = useStageLabel();
  return (
    <div className="table-wrap">
      <table className="table dense">
        <thead><tr><th>When</th><th>Event</th><th>From</th><th>To</th><th>By</th><th>Note</th></tr></thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id}>
              <td className="nowrap">{fmtDateTime(h.created_at)}</td>
              <td><Chip tone={h.event === 'rollback' ? 'warn' : h.event === 'cancel' ? 'bad' : h.event === 'hold' ? 'warn' : ''}>{cap(h.event)}</Chip></td>
              <td className="muted">{h.from_stage ? label(h.from_stage) : '—'}</td>
              <td className="strong">{label(h.to_stage)}</td>
              <td>{h.actor ?? 'System'}</td>
              <td className="small">{h.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Movements({ rows }: { rows: any[] }) {
  if (!rows.length) return <Empty title="No material movements for this order yet" />;
  return (
    <div className="table-wrap">
      <table className="table dense">
        <thead><tr><th>Date</th><th>Material</th><th>Type</th><th className="num">Qty</th><th>Job</th><th>By</th><th>Notes</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="nowrap">{fmtDate(t.txn_date)}</td>
              <td className="strong">{t.material_name}</td>
              <td><Chip tone={t.type === 'consumption' ? '' : t.type === 'wastage' ? 'bad' : t.type === 'allocation' ? 'ok' : 'outline'}>{TXN_LABELS[t.type as keyof typeof TXN_LABELS]}</Chip></td>
              <td className="num">{num(t.quantity)} {t.unit}</td>
              <td className="mono small">{t.job_code ?? '—'}</td>
              <td>{t.user_name ?? 'System'}</td>
              <td className="small muted">{t.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Attachments({ orderId, rows, stage }: { orderId: number; rows: any[]; stage: string }) {
  const { run, busy } = useAction();
  const upload = (file: File) => {
    if (file.size > 8 * 1024 * 1024) return run(async () => { throw new Error('File is larger than 8 MB'); });
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1];
      run(() => api.post(`/orders/${orderId}/attachments`, { filename: file.name, mime: file.type, data, stage }), 'File attached');
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="col gap-12">
      <label className="btn" style={{ alignSelf: 'flex-start' }}>
        <Upload size={14} /> {busy ? 'Uploading…' : 'Upload file'}
        <input type="file" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </label>
      {rows.length === 0 ? (
        <Empty title="No attachments">Drawings, client POs, invoices, e-way bills, photos.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table dense">
            <thead><tr><th>File</th><th>Stage</th><th>Size</th><th>Uploaded</th></tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td><a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" className="strong row gap-4"><Paperclip size={13} />{a.filename}</a></td>
                  <td>{a.stage ? cap(a.stage) : '—'}</td>
                  <td className="muted">{(a.size / 1024).toFixed(0)} KB</td>
                  <td className="small">{a.uploaded_by_name} · {fmtDateTime(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
