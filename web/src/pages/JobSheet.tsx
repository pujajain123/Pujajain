import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Minus, Plus, Save, Check, Lock } from 'lucide-react';
import { JOB_STATUSES, JOB_STATUS_LABELS, stageIndex } from '../../../shared/domain';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useAuth } from '../lib/auth';
import { useMeta, type FieldDef } from '../lib/meta';
import { fmtDate, fmtDateTime, num, relDays } from '../lib/format';
import { Alert, Avatar, Card, Chip, ErrorState, Field, Input, JobStatusChip, Loading, PriorityChip, Progress, Select, StageChip, Textarea, cx, useAction } from '../components/ui';
import { ActivityFeed } from '../components/domain';
import { SpecFields } from './NewOrder';

export function JobSheet() {
  const id = Number(useParams().id);
  const { data: j, error, reload } = useApi<any>(`/jobs/${id}`, ['jobs', 'orders', 'inventory']);
  const { user } = useAuth();
  const meta = useMeta();
  if (error) return <ErrorState error={error} retry={reload} />;
  if (!j) return <Loading rows={4} h={110} />;
  const admin = user?.role === 'admin';
  const mine = j.assigned_to === user?.id;
  const canUpdate = (admin || mine) && !j.order_cancelled_at && (admin || !j.order_on_hold) && stageIndex(j.order_stage) >= stageIndex('preparing') && (admin || stageIndex(j.order_stage) < stageIndex('ready_for_dispatch'));
  const lockReason = j.order_cancelled_at
    ? 'The order is cancelled.'
    : !admin && !mine
      ? `Assigned to ${j.assignee ?? 'nobody yet'} — only they or an admin can update it.`
      : j.order_on_hold && !admin
        ? 'The order is on hold. Check with the admin.'
        : stageIndex(j.order_stage) < stageIndex('preparing')
          ? 'Updates open once the order is being prepared.'
          : 'The order has moved past production.';

  return (
    <>
      <div className="crumbs">
        <Link to={admin ? '/jobs' : '/my-jobs'} className="row gap-4"><ChevronLeft size={14} /> {admin ? 'Job sheets' : 'My jobs'}</Link>
        <span>/</span>
        <Link to={`/orders/${j.order_id}`} className="mono">{j.order_code}</Link>
      </div>
      <div className="page-head">
        <div>
          <div className="upper">{j.process_name} — Job sheet</div>
          <div className="row wrap gap-12" style={{ marginTop: 4 }}>
            <h1 className="mono" style={{ fontSize: 24 }}>{j.code}</h1>
            <JobStatusChip status={j.status} overdue={j.overdue} />
            <PriorityChip p={j.priority} />
          </div>
          <div className="sub" style={{ fontSize: 15 }}>
            <span className="strong" style={{ color: 'var(--ink)' }}>{j.customer}</span> · {j.product} · Order <Link to={`/orders/${j.order_id}`} className="mono strong">{j.order_code}</Link> <StageChip stage={j.order_stage} onHold={!!j.order_on_hold} />
          </div>
        </div>
      </div>

      <div className="grid job-grid">
        <div className="col gap-16" style={{ minWidth: 0 }}>
          <Card>
            <div className="grid g4" style={{ gap: 12 }}>
              <div className="metric"><span className="stat-label">Required</span><span className="big-number">{j.quantity}</span></div>
              <div className="metric"><span className="stat-label">Completed</span><span className="big-number" style={{ color: 'var(--ok)' }}>{j.completed_qty}</span></div>
              <div className="metric"><span className="stat-label">Remaining</span><span className="big-number">{j.remaining}</span></div>
              <div className="metric"><span className="stat-label">Progress</span><span className="big-number">{j.progress}%</span></div>
            </div>
            <div className="mt-16"><Progress value={j.progress} lg tone={j.status === 'delayed' || j.overdue ? 'bad' : undefined} /></div>
            {j.status === 'delayed' && j.delay_reason && <div className="mt-12"><Alert tone="bad" title="Delayed">{j.delay_reason}</Alert></div>}
          </Card>

          <div className="grid g2">
            <Card title="Assigned staff">
              <div className="row gap-12">
                <Avatar name={j.assignee} />
                <div>
                  <div className="strong">{j.assignee ?? 'Unassigned'}</div>
                  <div className="small muted">{j.assignments.length > 1 ? `${j.assignments.length - 1} earlier assignment(s)` : 'Assigned at order creation'}</div>
                </div>
              </div>
            </Card>
            <Card title="Dates">
              <dl className="kv" style={{ gridTemplateColumns: '130px 1fr' }}>
                <dt>Planned start</dt><dd>{fmtDate(j.start_date)}</dd>
                <dt>Started</dt><dd>{j.started_at ? fmtDateTime(j.started_at) : '—'}</dd>
                <dt>Expected completion</dt><dd className="strong" style={j.overdue ? { color: 'var(--bad)' } : undefined}>{fmtDate(j.due_date)}{j.due_date && j.status !== 'completed' && <span className="small muted"> · {relDays(j.due_date, meta.today)}</span>}</dd>
                {j.completed_at && (<><dt>Completed</dt><dd>{fmtDateTime(j.completed_at)}</dd></>)}
                <dt>Order deadline</dt><dd>{fmtDate(j.order_deadline)} <span className="small muted">· sky {fmtDate(j.order_sky_date, false)}</span></dd>
              </dl>
            </Card>
          </div>

          {j.material ? (
            <Card title="Material">
              <div className="row between wrap">
                <div>
                  <Link to={`/inventory/${j.material.material_id}`} className="strong">{j.material.name}</Link>
                  <div className="small muted">{j.material.variant}</div>
                </div>
                <span className="small muted">Store: {num(j.material.store_available)} {j.material.unit} free</span>
              </div>
              <div className="grid g4 mt-12" style={{ gap: 8 }}>
                <div><div className="stat-label">Required</div><div className="stat-value">{num(j.material.required)} {j.material.unit}</div></div>
                <div><div className="stat-label">Consumed</div><div className="stat-value">{num(j.material.consumed)} {j.material.unit}</div></div>
                <div><div className="stat-label">Remaining</div><div className="stat-value">{num(j.material.remaining)} {j.material.unit}</div></div>
                <div><div className="stat-label">Wastage</div><div className="stat-value">{num(j.material.wastage)} {j.material.unit}</div></div>
              </div>
              <div className="mt-12"><Progress value={j.material.required ? (j.material.consumed / j.material.required) * 100 : 0} tone={j.material.consumed > j.material.required ? 'bad' : ''} /></div>
            </Card>
          ) : (
            j.material_category && <Alert tone="notice">No {j.material_category} requirement is linked to this job. Ask an admin to add one on the order.</Alert>
          )}

          <ProcessDetails job={j} canEdit={admin || mine} fields={j.fields} />

          {admin && <PlanningCard job={j} />}

          <Card title="Production updates" pad={false}>
            {j.updates.length === 0 ? (
              <div className="empty small">No updates yet</div>
            ) : (
              <div className="table-wrap">
                <table className="table dense">
                  <thead><tr><th>When</th><th>By</th><th className="num">Qty</th><th>Status</th><th className="num">Material</th><th className="num">Wastage</th><th>Note</th></tr></thead>
                  <tbody>
                    {j.updates.map((u: any) => (
                      <tr key={u.id}>
                        <td className="nowrap">{fmtDateTime(u.created_at)}</td>
                        <td>{u.user_name}</td>
                        <td className="num nowrap">{u.qty_before !== u.qty_after ? <>{u.qty_before} → <b>{u.qty_after}</b></> : u.qty_after}</td>
                        <td>{u.status_before !== u.status_after ? <JobStatusChip status={u.status_after} /> : <span className="faint">—</span>}</td>
                        <td className="num">{u.material_used ? `${num(u.material_used)} ${j.material?.unit ?? ''}` : '—'}</td>
                        <td className="num">{u.wastage ? `${num(u.wastage)} ${j.material?.unit ?? ''}` : '—'}</td>
                        <td className="small">{u.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Activity history">
            <ActivityFeed rows={j.activity} />
          </Card>
        </div>

        <div className="update-panel col gap-16">
          {canUpdate ? <UpdatePanel job={j} /> : (
            <Card title={<div className="row"><Lock size={15} /><h2>Updates locked</h2></div>}><div className="small muted">{lockReason}</div></Card>
          )}
          <Card title="Other processes on this order" pad={false}>
            {j.siblings.map((s: any) => (
              <Link key={s.id} to={`/jobs/${s.id}`} className={cx('row between')} style={{ padding: '10px 16px', borderBottom: '1px solid var(--line)', background: s.id === j.id ? 'var(--surface-2)' : undefined }}>
                <span className="row gap-4">{s.status === 'completed' ? <Check size={14} color="var(--ok)" /> : null}<span className="strong">{s.process_name}</span><span className="mono small muted">{s.code}</span></span>
                <span className="small">{s.completed_qty}/{s.quantity}</span>
              </Link>
            ))}
          </Card>
          {j.notes && <Card title="Notes"><div style={{ whiteSpace: 'pre-wrap' }}>{j.notes}</div></Card>}
        </div>
      </div>
    </>
  );
}

function UpdatePanel({ job }: { job: any }) {
  const [qty, setQty] = useState<number>(job.completed_qty);
  const [status, setStatus] = useState<string>(job.status);
  const [used, setUsed] = useState('');
  const [waste, setWaste] = useState('');
  const [note, setNote] = useState('');
  const [delay, setDelay] = useState(job.delay_reason ?? '');
  const { run, busy, fields, error } = useAction();
  const { user } = useAuth();
  useEffect(() => {
    setQty(job.completed_qty);
    setStatus(job.status);
  }, [job.completed_qty, job.status]);
  const clamp = (n: number) => Math.max(user?.role === 'admin' ? 0 : job.completed_qty, Math.min(job.quantity, n));
  const delta = qty - job.completed_qty;
  const effStatus = qty === job.quantity ? 'completed' : status === 'completed' ? 'in_progress' : qty > 0 && status === 'not_started' ? 'in_progress' : status;
  const suggested = job.material && delta > 0 && job.specs?.rope_per_unit ? Math.round(job.specs.rope_per_unit * delta * 10) / 10 : job.material && delta > 0 && job.specs?.fabric_per_unit ? Math.round(job.specs.fabric_per_unit * delta * 10) / 10 : null;
  const dirty = delta !== 0 || effStatus !== job.status || !!used || !!waste || !!note.trim();
  const save = () =>
    run(
      () =>
        api.post(`/jobs/${job.id}/updates`, {
          completed_qty: qty,
          status: status === 'completed' && qty < job.quantity ? undefined : status,
          material_used: used ? Number(used) : null,
          wastage: waste ? Number(waste) : null,
          note: note || undefined,
          delay_reason: status === 'delayed' ? delay : undefined,
        }),
      'Update saved — order, inventory and dashboard updated',
    ).then((r) => {
      if (r) {
        setUsed('');
        setWaste('');
        setNote('');
      }
    });
  return (
    <Card title="Update production" footer={<button className="btn accent lg block" disabled={busy || !dirty} onClick={save}><Save size={16} /> {busy ? 'Saving…' : 'Save update'}</button>}>
      <div className="col gap-16">
        {error && <Alert tone="bad">{error}</Alert>}
        <Field label="Quantity completed" error={fields.completed_qty} hint={delta > 0 ? `+${delta} unit(s) in this update` : `${job.remaining} unit(s) remaining`}>
          <div className="row gap-12 wrap">
            <div className="stepper">
              <button type="button" onClick={() => setQty(clamp(qty - 1))} aria-label="Decrease"><Minus size={18} /></button>
              <input type="number" value={qty} min={0} max={job.quantity} onChange={(e) => setQty(clamp(Number(e.target.value) || 0))} aria-label="Quantity completed" />
              <button type="button" onClick={() => setQty(clamp(qty + 1))} aria-label="Increase"><Plus size={18} /></button>
            </div>
            <span className="muted">of {job.quantity}</span>
          </div>
          <div className="row wrap mt-8" style={{ gap: 6 }}>
            {[5, 10].map((n) => <button key={n} type="button" className="btn sm" onClick={() => setQty(clamp(qty + n))}>+{n}</button>)}
            <button type="button" className="btn sm" onClick={() => setQty(job.quantity)}>All done</button>
          </div>
        </Field>
        <Progress value={(qty / job.quantity) * 100} tone={qty === job.quantity ? 'ok' : undefined} />
        {job.material && (
          <div className="grid g2" style={{ gap: 10 }}>
            <Field label="Material used" error={fields.material_used} hint={suggested ? <button type="button" className="btn ghost sm" style={{ height: 20, padding: 0 }} onClick={() => setUsed(String(suggested))}>Suggest {suggested} {job.material.unit}</button> : job.material.name.split('—')[0]}>
              <div className="input-group"><Input type="number" min={0} step="0.1" value={used} onChange={(e) => setUsed(e.target.value)} /><span className="addon">{job.material.unit}</span></div>
            </Field>
            <Field label="Wastage" error={fields.wastage}>
              <div className="input-group"><Input type="number" min={0} step="0.1" value={waste} onChange={(e) => setWaste(e.target.value)} /><span className="addon">{job.material.unit}</span></div>
            </Field>
          </div>
        )}
        <Field label="Status">
          <div className="status-pick">
            {JOB_STATUSES.map((s) => (
              <button key={s} type="button" className={cx(effStatus === s && 'on')} onClick={() => (s === 'completed' ? (setQty(job.quantity), setStatus(s)) : setStatus(s))}>
                {JOB_STATUS_LABELS[s]}
              </button>
            ))}
          </div>
        </Field>
        {effStatus === 'delayed' && (
          <Field label="Reason for delay (required)" error={fields.delay_reason}>
            <Input value={delay} onChange={(e) => setDelay(e.target.value)} placeholder="e.g. waiting for rope stock" />
          </Field>
        )}
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done, any issue on the floor…" style={{ minHeight: 64 }} />
        </Field>
        {dirty && (
          <div className="small muted">
            Saving updates the job sheet{used || waste ? ', posts material to the stock ledger' : ''}, recalculates order {job.order_code} progress
            {effStatus === 'completed' ? ' and notifies the admin' : ''}.
          </div>
        )}
      </div>
    </Card>
  );
}

function ProcessDetails({ job, canEdit, fields }: { job: any; canEdit: boolean; fields: FieldDef[] }) {
  const [edit, setEdit] = useState(false);
  const [vals, setVals] = useState<Record<string, any>>(job.specs);
  const [notes, setNotes] = useState(job.notes ?? '');
  const { run, busy } = useAction();
  useEffect(() => (setVals(job.specs), setNotes(job.notes ?? '')), [job.specs, job.notes]);
  const sections = [...new Set(fields.map((f) => f.section ?? 'Details'))];
  return (
    <Card
      title={`${job.process_name} details`}
      actions={canEdit && (edit ? (
        <>
          <button className="btn sm" onClick={() => setEdit(false)}>Cancel</button>
          <button className="btn primary sm" disabled={busy} onClick={() => run(() => api.patch(`/jobs/${job.id}`, { specs: vals, notes: notes || null }), 'Job sheet details saved').then((r) => r && setEdit(false))}>Save</button>
        </>
      ) : <button className="btn sm" onClick={() => setEdit(true)}>Edit</button>)}
    >
      <dl className="kv" style={{ marginBottom: 12 }}>
        <dt>Product</dt><dd className="strong">{job.product} <span className="mono small muted">{job.product_sku}</span></dd>
        <dt>Dimensions</dt><dd>{job.dimensions ?? '—'}</dd>
        <dt>Colour / finish</dt><dd>{[job.color, job.finish].filter(Boolean).join(' · ') || '—'}</dd>
        {job.specifications && (<><dt>Specifications</dt><dd>{job.specifications}</dd></>)}
      </dl>
      {edit ? (
        <>
          <SpecFields fields={fields} values={vals} onChange={setVals} />
          <Field label="Job notes" className="mt-12"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </>
      ) : (
        sections.map((sec) => (
          <div key={sec} className="mt-12">
            <div className="upper" style={{ marginBottom: 6 }}>{sec}</div>
            <dl className="kv">
              {fields.filter((f) => (f.section ?? 'Details') === sec).map((f) => (
                <FragmentRow key={f.key} label={f.label} value={job.specs[f.key] != null && job.specs[f.key] !== '' ? `${job.specs[f.key]}${f.unit ? ` ${f.unit}` : ''}` : null} />
              ))}
            </dl>
          </div>
        ))
      )}
    </Card>
  );
}
const FragmentRow = ({ label, value }: { label: string; value: string | null }) => (
  <>
    <dt>{label}</dt>
    <dd className={value ? '' : 'faint'}>{value ?? '—'}</dd>
  </>
);

function PlanningCard({ job }: { job: any }) {
  const meta = useMeta();
  const { run } = useAction();
  const patch = (body: any) => run(() => api.patch(`/jobs/${job.id}`, body), 'Job sheet updated');
  return (
    <Card title={<div className="row"><h2>Planning</h2><Chip>Admin</Chip></div>}>
      <div className="form-grid">
        <Field label="Assigned staff">
          <Select value={job.assigned_to ?? ''} onChange={(e) => patch({ assigned_to: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Unassigned</option>
            {meta.staff.filter((s) => s.active && s.role === 'staff').map((s) => <option key={s.id} value={s.id}>{s.name}{s.primary_process_id === job.process_id ? ' ★' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Job quantity" hint="Normally equals the order quantity">
          <Input type="number" min={job.completed_qty || 1} defaultValue={job.quantity} onBlur={(e) => Number(e.target.value) !== job.quantity && patch({ quantity: Number(e.target.value) })} />
        </Field>
        <Field label="Planned start"><Input type="date" value={job.start_date ?? ''} onChange={(e) => patch({ start_date: e.target.value || null })} /></Field>
        <Field label="Due date" hint={`Order deadline ${fmtDate(job.order_deadline)}`}><Input type="date" value={job.due_date ?? ''} onChange={(e) => patch({ due_date: e.target.value || null })} /></Field>
      </div>
    </Card>
  );
}
