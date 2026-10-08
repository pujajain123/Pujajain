import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, Trash2, ImagePlus, AlertTriangle } from 'lucide-react';
import { addDaysISO } from '../lib/dates';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useMeta, type FieldDef } from '../lib/meta';
import { readPhoto } from '../lib/photo';
import { cap, num } from '../lib/format';
import { daysBetween } from '../../../shared/domain';
import { Alert, Card, Chip, Field, Input, PageHead, Select, Textarea, cx, useAction, useToast } from '../components/ui';

interface Line {
  sku: string; name: string; quantity: string; dimensions: string; frame_material: string; powder_color: string; dori_color: string; rope_code: string;
  rope_required: string; rope_material: string; fabric_code: string; fabric_company: string; fabric_qty: string; fabric_material: string; seat_height: string;
  seat_bifurcation: string; back_cushion: string; extra_cushion: string; table_top: string; buffer_type: string; photo: string | null; procs: string[];
}
const blank = (): Line => ({
  sku: '', name: '', quantity: '1', dimensions: '', frame_material: '', powder_color: '', dori_color: '', rope_code: '', rope_required: '', rope_material: '',
  fabric_code: '', fabric_company: '', fabric_qty: '', fabric_material: '', seat_height: '', seat_bifurcation: '', back_cushion: '', extra_cushion: '',
  table_top: '', buffer_type: '', photo: null, procs: ['iron'],
});

/** Order intake: capture the order once — product lines, dates and who does what. Jobs, schedule and material checks are created from it. */
export function NewOrder() {
  const meta = useMeta();
  const nav = useNavigate();
  const toast = useToast();
  const stock = useApi<any[]>('/inventory', ['inventory']).data ?? [];
  const users = useApi<any[]>('/users', ['staff', 'jobs']).data ?? [];
  const { run, busy, error } = useAction();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [mode, setMode] = useState<'existing' | 'new'>('new');
  const [customerId, setCustomerId] = useState('');
  const [nc, setNc] = useState({ name: '', contact_person: '', phone: '', city: '' });
  const [info, setInfo] = useState({ source: 'Direct', po_number: '', priority: 'normal', notes: '' });
  const [dates, setDates] = useState({ order_date: meta.today, commencement_date: meta.today, sky_date: addDaysISO(meta.today, 18), deadline: addDaysISO(meta.today, 21) });
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [plan, setPlan] = useState<Record<string, { assigned_to: string; due_date: string }>>({});

  const procOf = (k: string) => meta.processes.find((p) => p.key === k)!;
  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? autoProcs({ ...l, ...patch }, patch) : l)));
  /** Suggest processes from what the line needs; the admin can still toggle them. */
  function autoProcs(l: Line, patch: Partial<Line>): Line {
    if ('procs' in patch) return l;
    const p = new Set(l.procs);
    if (patch.rope_required !== undefined || patch.dori_color !== undefined || patch.rope_code !== undefined) (l.rope_required || l.dori_color || l.rope_code) && p.add('rope');
    if (patch.fabric_qty !== undefined || patch.fabric_code !== undefined) (l.fabric_qty || l.fabric_code) && p.add('fabric');
    if (patch.table_top !== undefined) l.table_top && p.add('tile');
    return { ...l, procs: [...p] };
  }
  const usedProcs = [...new Set(lines.flatMap((l) => l.procs))].sort((a, b) => procOf(a).sequence - procOf(b).sequence);
  const planFor = (k: string) => {
    const staff = users.filter((u) => u.role === 'staff' && u.active && u.primary_process_id === procOf(k).id).sort((a, b) => a.open_jobs - b.open_jobs)[0];
    return plan[k] ?? { assigned_to: staff ? String(staff.id) : '', due_date: dates.sky_date || dates.deadline };
  };

  const totals = useMemo(() => {
    const units = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
    const rope = lines.reduce((a, l) => a + (Number(l.rope_required) || 0), 0);
    const fabric = lines.reduce((a, l) => a + (Number(l.fabric_qty) || 0), 0);
    const jobs = lines.reduce((a, l) => a + l.procs.length, 0);
    const need = new Map<number, number>();
    for (const l of lines) {
      if (l.rope_material && Number(l.rope_required)) need.set(Number(l.rope_material), (need.get(Number(l.rope_material)) ?? 0) + Number(l.rope_required));
      if (l.fabric_material && Number(l.fabric_qty)) need.set(Number(l.fabric_material), (need.get(Number(l.fabric_material)) ?? 0) + Number(l.fabric_qty));
    }
    const short = [...need.entries()].map(([id, q]) => ({ s: stock.find((x) => x.material_id === id), q })).filter((x) => x.s && x.q > x.s.available);
    return { units, rope, fabric, jobs, short };
  }, [lines, stock]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (mode === 'existing' && !customerId) e.customer = 'Select a client';
    if (mode === 'new' && nc.name.trim().length < 2) e.client = 'Client name is required';
    if (!dates.deadline) e.deadline = 'Deadline is required';
    else if (dates.deadline < dates.order_date) e.deadline = 'Deadline cannot be before the order date';
    if (dates.sky_date && dates.sky_date > dates.deadline) e.sky_date = 'Sky date should be on or before the deadline';
    lines.forEach((l, i) => {
      if (!l.sku.trim()) e[`sku${i}`] = 'SKU is required';
      if (!l.name.trim()) e[`name${i}`] = 'Product name is required';
      if (!(Number(l.quantity) > 0)) e[`qty${i}`] = 'Enter at least 1';
      if (!l.procs.length) e[`procs${i}`] = 'Pick at least one process';
    });
    setErrors(e);
    if (Object.keys(e).length) {
      toast('Please fix the highlighted fields', 'error');
      document.querySelector('.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return !Object.keys(e).length;
  };

  const create = () => {
    if (!validate()) return;
    const n = (v: string) => (v.trim() === '' ? null : v.trim());
    const body = {
      ...(mode === 'existing' ? { customer_id: Number(customerId) } : { new_customer: { name: nc.name, contact_person: n(nc.contact_person), phone: n(nc.phone), city: n(nc.city) } }),
      source: info.source, po_number: n(info.po_number), priority: info.priority, notes: n(info.notes),
      order_date: dates.order_date, commencement_date: dates.commencement_date || null, sky_date: dates.sky_date || null, deadline: dates.deadline,
      items: lines.map((l) => ({
        sku: l.sku.trim(), name: l.name.trim(), quantity: Number(l.quantity),
        dimensions: n(l.dimensions), frame_material: n(l.frame_material), powder_color: n(l.powder_color), dori_color: n(l.dori_color), rope_code: n(l.rope_code),
        rope_required: Number(l.rope_required) || null, fabric_code: n(l.fabric_code), fabric_company: n(l.fabric_company), fabric_qty: Number(l.fabric_qty) || null,
        seat_height: n(l.seat_height), seat_bifurcation: n(l.seat_bifurcation), back_cushion: n(l.back_cushion), extra_cushion: n(l.extra_cushion),
        table_top: n(l.table_top), buffer_type: n(l.buffer_type), photo: l.photo,
        processes: l.procs.map((k) => {
          const p = planFor(k);
          return { process_id: procOf(k).id, assigned_to: p.assigned_to ? Number(p.assigned_to) : null, start_date: dates.commencement_date || dates.order_date, due_date: p.due_date || null };
        }),
        materials: [
          ...(l.rope_material && Number(l.rope_required) ? [{ process_id: procOf('rope').id, material_id: Number(l.rope_material), required_qty: Number(l.rope_required) }] : []),
          ...(l.fabric_material && Number(l.fabric_qty) ? [{ process_id: procOf('fabric').id, material_id: Number(l.fabric_material), required_qty: Number(l.fabric_qty) }] : []),
        ],
      })),
    };
    run(() => api.post('/orders', body), 'Order created — job sheets generated').then((r: any) => r && nav(`/orders/${r.id}`));
  };

  const T = (k: keyof Line, i: number, label: string, ph?: string, type = 'text') => (
    <Field label={label} error={errors[`${k === 'quantity' ? 'qty' : k}${i}`]}>
      <Input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 'any' : undefined} placeholder={ph} value={lines[i][k] as string} invalid={!!errors[`${k === 'quantity' ? 'qty' : k}${i}`]} onChange={(e) => setLine(i, { [k]: e.target.value } as Partial<Line>)} />
    </Field>
  );

  return (
    <>
      <div className="crumbs"><Link to="/orders" className="row gap-4"><ChevronLeft size={14} /> Orders</Link></div>
      <PageHead eyebrow="Order intake" title="Create an order" sub="Capture the order once. Job sheets, the production tracker and material checks all use these details." />
      <div className="grid side-grid">
        <div className="col gap-24" style={{ minWidth: 0 }}>
          {error && <Alert tone="bad">{error}</Alert>}
          <Card title={<div><h2>Client & order</h2><div className="sub">Who it is for and where it came from.</div></div>}>
            <div className="form-grid">
              <div className="full row gap-8">
                <button type="button" className={cx('btn sm', mode === 'new' && 'primary')} onClick={() => setMode('new')}>New client</button>
                <button type="button" className={cx('btn sm', mode === 'existing' && 'primary')} onClick={() => setMode('existing')}>Existing client</button>
              </div>
              {mode === 'existing' ? (
                <Field label="Client *" error={errors.customer} className="full">
                  <Select value={customerId} invalid={!!errors.customer} onChange={(e) => setCustomerId(e.target.value)}>
                    <option value="">Select a client…</option>
                    {meta.customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ''}</option>)}
                  </Select>
                </Field>
              ) : (
                <>
                  <Field label="Client name *" error={errors.client}><Input placeholder="e.g. Casa Forma" value={nc.name} invalid={!!errors.client} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></Field>
                  <Field label="Contact person"><Input value={nc.contact_person} onChange={(e) => setNc({ ...nc, contact_person: e.target.value })} /></Field>
                  <Field label="Phone"><Input value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} /></Field>
                  <Field label="City"><Input value={nc.city} onChange={(e) => setNc({ ...nc, city: e.target.value })} /></Field>
                </>
              )}
              <Field label="Order source">
                <Select value={info.source} onChange={(e) => setInfo({ ...info, source: e.target.value })}>{['Direct', 'Website', 'Referral', 'Trade show', 'Architect', 'WhatsApp'].map((s) => <option key={s}>{s}</option>)}</Select>
              </Field>
              <Field label="Priority">
                <Select value={info.priority} onChange={(e) => setInfo({ ...info, priority: e.target.value })}>{[['normal', 'Standard'], ['high', 'High'], ['urgent', 'Urgent'], ['low', 'Low']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              </Field>
              <Field label="PO / client reference"><Input value={info.po_number} onChange={(e) => setInfo({ ...info, po_number: e.target.value })} /></Field>
            </div>
          </Card>

          <Card title={<div className="row between" style={{ width: '100%' }}><div><h2>Product lines</h2><div className="sub">Add each SKU in the order with its own production specifications.</div></div><button type="button" className="btn sm" onClick={() => setLines([...lines, blank()])}><Plus size={14} /> Add product</button></div>}>
            <div className="col gap-24">
              {lines.map((l, i) => (
                <div key={i} className="card card-pad" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row between">
                    <h3 style={{ fontSize: 17 }}>Product {i + 1}</h3>
                    {lines.length > 1 && <button className="btn ghost sm danger" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 size={14} /> Remove</button>}
                  </div>
                  <div className="form-grid cols-3 mt-12">
                    {T('sku', i, 'SKU *', 'e.g. UM-CH-045')}
                    {T('name', i, 'Product name *', 'Chair, sofa, table…')}
                    {T('quantity', i, 'Quantity *', '1', 'number')}
                    {T('dimensions', i, 'Dimensions', 'W × D × H')}
                    {T('frame_material', i, 'Frame material', 'Aluminium / CR / iron')}
                    {T('powder_color', i, 'Powder colour', 'e.g. black')}
                  </div>
                  <div className="eyebrow mt-16">Rope</div>
                  <div className="form-grid cols-3 mt-8">
                    {T('dori_color', i, 'Dori colour', 'Rope colour')}
                    {T('rope_code', i, 'Rope size / code', 'Size or code')}
                    {T('rope_required', i, 'Rope required (m)', '', 'number')}
                    <Field label="Draw from rope stock" className="full" hint="Optional — links the requirement to the rope workbook so it can be reserved">
                      <Select value={l.rope_material} onChange={(e) => setLine(i, { rope_material: e.target.value })}>
                        <option value="">Not linked</option>
                        {stock.filter((s) => s.category === 'rope' && s.on_hand > 0).map((s) => <option key={s.material_id} value={s.material_id}>{s.name} — {num(s.available, 0)} m free</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div className="eyebrow mt-16">Fabric & upholstery</div>
                  <div className="form-grid cols-3 mt-8">
                    {T('fabric_code', i, 'Fabric code', 'Fabric / upholstery code')}
                    {T('fabric_company', i, 'Fabric company', 'Supplier / company')}
                    {T('fabric_qty', i, 'Fabric quantity (m)', '', 'number')}
                    {T('seat_height', i, 'Seat height')}
                    {T('seat_bifurcation', i, 'Seat bifurcation')}
                    {T('back_cushion', i, 'Back cushion')}
                    {T('extra_cushion', i, 'Extra cushion')}
                    <Field label="Draw from fabric stock" className="span-2">
                      <Select value={l.fabric_material} onChange={(e) => setLine(i, { fabric_material: e.target.value })}>
                        <option value="">Not linked</option>
                        {stock.filter((s) => s.category === 'fabric').map((s) => <option key={s.material_id} value={s.material_id}>{s.name} — {num(s.available, 0)} m free</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div className="eyebrow mt-16">Other</div>
                  <div className="form-grid cols-3 mt-8">
                    {T('table_top', i, 'Table top / stone', 'Material, thickness, supplier')}
                    {T('buffer_type', i, 'Buffer type')}
                    <Field label="Product photo">
                      <div className="row gap-8">
                        {l.photo && <img src={l.photo} alt="" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover' }} />}
                        <label className="btn sm"><ImagePlus size={14} /> {l.photo ? 'Replace' : 'Add photo'}
                          <input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (f) try { setLine(i, { photo: await readPhoto(f) }); } catch (err: any) { toast(err.message, 'error'); } }} />
                        </label>
                      </div>
                    </Field>
                  </div>
                  <div className="eyebrow mt-16">Processes for this product</div>
                  <div className="row wrap gap-8 mt-8">
                    {meta.processes.map((p) => {
                      const on = l.procs.includes(p.key);
                      return (
                        <button key={p.key} type="button" className={cx('btn sm', on && 'primary')} onClick={() => setLine(i, { procs: on ? l.procs.filter((x) => x !== p.key) : [...l.procs, p.key] })}>
                          {on ? '✓ ' : ''}{p.name}
                        </button>
                      );
                    })}
                    {errors[`procs${i}`] && <span className="small" style={{ color: 'var(--bad)' }}>{errors[`procs${i}`]}</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title={<div><h2>Dates</h2><div className="sub">The sky date is your internal target, a few days before the client deadline.</div></div>}>
            <div className="form-grid cols-4">
              <Field label="Order date *"><Input type="date" value={dates.order_date} onChange={(e) => setDates({ ...dates, order_date: e.target.value })} /></Field>
              <Field label="Commencement"><Input type="date" value={dates.commencement_date} onChange={(e) => setDates({ ...dates, commencement_date: e.target.value })} /></Field>
              <Field label="Sky date" error={errors.sky_date}><Input type="date" value={dates.sky_date} invalid={!!errors.sky_date} onChange={(e) => setDates({ ...dates, sky_date: e.target.value })} /></Field>
              <Field label="Required deadline *" error={errors.deadline} hint={dates.deadline ? `${daysBetween(dates.order_date, dates.deadline)} days from order` : undefined}>
                <Input type="date" value={dates.deadline} invalid={!!errors.deadline} onChange={(e) => setDates({ ...dates, deadline: e.target.value })} />
              </Field>
            </div>
          </Card>

          <Card title={<div><h2>Who does what</h2><div className="sub">One job sheet is created per product line and process, assigned as below.</div></div>}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Process</th><th>Assign to</th><th>Due</th><th className="num">Job sheets</th></tr></thead>
                <tbody>
                  {usedProcs.map((k) => {
                    const p = planFor(k);
                    return (
                      <tr key={k}>
                        <td className="strong">{procOf(k).name}</td>
                        <td>
                          <Select value={p.assigned_to} onChange={(e) => setPlan({ ...plan, [k]: { ...p, assigned_to: e.target.value } })} style={{ minWidth: 200 }}>
                            <option value="">Assign later</option>
                            {users.filter((u) => u.role === 'staff' && u.active).map((u) => <option key={u.id} value={u.id}>{u.name}{u.primary_process_id === procOf(k).id ? ' ★' : ''} · {u.open_jobs} open</option>)}
                          </Select>
                        </td>
                        <td><Input type="date" value={p.due_date} max={dates.deadline} onChange={(e) => setPlan({ ...plan, [k]: { ...p, due_date: e.target.value } })} /></td>
                        <td className="num">{lines.filter((l) => l.procs.includes(k)).length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Field label="Order notes" className="mt-16"><Textarea value={info.notes} onChange={(e) => setInfo({ ...info, notes: e.target.value })} placeholder="Specifications, finish, delivery instructions…" /></Field>
          </Card>
        </div>

        <aside className="card card-pad side-sticky">
          <div className="eyebrow">Summary</div>
          <h2 style={{ marginTop: 4 }}>{mode === 'existing' ? meta.customers.find((c) => c.id === Number(customerId))?.name ?? 'New order' : nc.name || 'New order'}</h2>
          <dl className="kv mt-16" style={{ gridTemplateColumns: '1fr auto' }}>
            <dt>Product lines</dt><dd className="strong">{lines.length}</dd>
            <dt>Total units</dt><dd className="strong">{totals.units}</dd>
            <dt>Job sheets</dt><dd className="strong">{totals.jobs}</dd>
            <dt>Rope required</dt><dd className="strong">{num(totals.rope)} m</dd>
            <dt>Fabric required</dt><dd className="strong">{num(totals.fabric)} m</dd>
            <dt>Priority</dt><dd><Chip tone={info.priority === 'urgent' ? 'bad' : info.priority === 'high' ? 'warn' : ''}>{info.priority === 'normal' ? 'Standard' : cap(info.priority)}</Chip></dd>
          </dl>
          {totals.short.map((x) => (
            <div key={x.s.material_id} className="alert warn small mt-12"><AlertTriangle size={14} /><span>{x.s.name}: needs {num(x.q)} {x.s.unit}, only {num(x.s.available)} free. The order will be flagged.</span></div>
          ))}
          <button className="btn accent lg block mt-16" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create order & jobs →'}</button>
          <div className="small muted mt-12">The order starts in <b>Order received</b>. Assigned staff are notified, and every line appears in Master production.</div>
        </aside>
      </div>
    </>
  );
}

/** Process-specific job sheet fields (used on the job sheet page). */
export function SpecFields({ fields, values, onChange, disabled }: { fields: FieldDef[]; values: Record<string, any>; onChange: (v: Record<string, any>) => void; disabled?: boolean }) {
  return (
    <div className="form-grid mt-12">
      {fields.map((f) => (
        <Field key={f.key} label={`${f.label}${f.unit ? ` (${f.unit})` : ''}`} className={f.type === 'textarea' ? 'full' : undefined}>
          {f.type === 'select' ? (
            <Select value={values[f.key] ?? ''} disabled={disabled} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}>
              <option value="">—</option>
              {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : f.type === 'textarea' ? (
            <Textarea value={values[f.key] ?? ''} disabled={disabled} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
          ) : (
            <Input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={values[f.key] ?? ''} disabled={disabled} onChange={(e) => onChange({ ...values, [f.key]: f.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })} />
          )}
        </Field>
      ))}
    </div>
  );
}
