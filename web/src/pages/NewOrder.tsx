import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, Plus, Trash2, Check, AlertTriangle } from 'lucide-react';
import { addDaysISO } from '../lib/dates';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useMeta, type FieldDef } from '../lib/meta';
import { cap, fmtDate, num } from '../lib/format';
import { daysBetween } from '../../../shared/domain';
import { Alert, Card, Chip, Field, Input, Select, Textarea, cx, useAction } from '../components/ui';

const STEPS = ['Client', 'Order information', 'Product & quantity', 'Deadline & sky date', 'Production requirements', 'Material requirements', 'Staff assignment', 'Review & create'];

interface Proc { process_id: number; enabled: boolean; assigned_to: string; start_date: string; due_date: string; specs: Record<string, any>; material_id: string; required_qty: string; qtyTouched?: boolean }
interface Item { product_id: string; quantity: string; dimensions: string; color: string; finish: string; specifications: string; procs: Proc[] }

export function NewOrder() {
  const meta = useMeta();
  const nav = useNavigate();
  const stock = useApi<any[]>('/inventory', ['inventory']).data ?? [];
  const users = useApi<any[]>('/users', ['staff', 'jobs']).data ?? [];
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { run, busy, error } = useAction();

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [customerId, setCustomerId] = useState('');
  const [nc, setNc] = useState({ name: '', contact_person: '', phone: '', email: '', address: '', city: '', gstin: '' });
  const [info, setInfo] = useState({ po_number: '', source: '', order_date: meta.today, priority: 'normal', notes: '', delivery_address: '' });
  const [dates, setDates] = useState({ deadline: addDaysISO(meta.today, 21), sky_date: addDaysISO(meta.today, 18) });
  const [items, setItems] = useState<Item[]>([newItem()]);

  function newItem(): Item {
    return { product_id: '', quantity: '', dimensions: '', color: '', finish: '', specifications: '', procs: [] };
  }
  const product = (id: string) => meta.products.find((p) => p.id === Number(id));
  const proc = (id: number) => meta.processes.find((p) => p.id === id)!;
  const customer = meta.customers.find((c) => c.id === Number(customerId));

  const setItem = (i: number, patch: Partial<Item>) => setItems((arr) => arr.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  const setProc = (i: number, pid: number, patch: Partial<Proc>) =>
    setItems((arr) => arr.map((it, k) => (k === i ? { ...it, procs: it.procs.map((p) => (p.process_id === pid ? { ...p, ...patch } : p)) } : it)));

  /** Default processes, materials, staff and dates whenever the product or quantity changes. */
  const pickProduct = (i: number, pid: string) => {
    const p = product(pid);
    const qty = Number(items[i].quantity) || 0;
    setItem(i, {
      product_id: pid,
      dimensions: p?.default_dimensions ?? '',
      procs: meta.processes.map((pr) => {
        const pp = p?.processes.find((x) => x.process_id === pr.id);
        return planProc(pr.id, !!pp, pp?.material_per_unit ?? null, qty);
      }),
    });
  };
  function planProc(processId: number, enabled: boolean, perUnit: number | null, qty: number): Proc {
    const pr = proc(processId);
    const span = Math.max(3, daysBetween(info.order_date, dates.sky_date || dates.deadline));
    const win: Record<string, [number, number]> = { iron: [0.05, 0.4], rope: [0.3, 0.75], fabric: [0.45, 0.9] };
    const [a, b] = win[pr.key] ?? [0.1, 0.9];
    const staff = users.filter((u) => u.role === 'staff' && u.active && u.primary_process_id === processId).sort((x, y) => x.open_jobs - y.open_jobs)[0];
    return {
      process_id: processId,
      enabled,
      assigned_to: staff ? String(staff.id) : '',
      start_date: addDaysISO(info.order_date, Math.round(span * a)),
      due_date: addDaysISO(info.order_date, Math.round(span * b)),
      specs: {},
      material_id: '',
      required_qty: perUnit && qty ? String(Math.round(perUnit * qty * 1.05 * 10) / 10) : '',
    };
  }
  const perUnit = (it: Item, pid: number) => product(it.product_id)?.processes.find((x) => x.process_id === pid)?.material_per_unit ?? null;
  const setQty = (i: number, q: string) => {
    const it = items[i];
    setItem(i, {
      quantity: q,
      procs: it.procs.map((p) => {
        const pu = perUnit(it, p.process_id);
        return p.qtyTouched || !pu || !Number(q) ? p : { ...p, required_qty: String(Math.round(pu * Number(q) * 1.05 * 10) / 10) };
      }),
    });
  };

  // ── Validation per step ──
  const validate = (s: number): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (mode === 'existing' && !customerId) e.customer = 'Select a client';
      if (mode === 'new' && nc.name.trim().length < 2) e.nc_name = 'Client name is required';
      if (mode === 'new' && nc.email && !/^\S+@\S+\.\S+$/.test(nc.email)) e.nc_email = 'Enter a valid email';
    }
    if (s === 1 && !info.order_date) e.order_date = 'Order date is required';
    if (s === 2)
      items.forEach((it, i) => {
        if (!it.product_id) e[`p${i}`] = 'Choose a product';
        if (!(Number(it.quantity) > 0) || !Number.isInteger(Number(it.quantity))) e[`q${i}`] = 'Enter a whole number above 0';
      });
    if (s === 3) {
      if (!dates.deadline) e.deadline = 'Deadline is required';
      else if (dates.deadline < info.order_date) e.deadline = 'Deadline cannot be before the order date';
      if (dates.sky_date && dates.sky_date > dates.deadline) e.sky_date = 'Sky date should be on or before the deadline';
    }
    if (s === 4) items.forEach((it, i) => !it.procs.some((p) => p.enabled) && (e[`pr${i}`] = 'Select at least one process'));
    if (s === 5)
      items.forEach((it, i) =>
        it.procs.filter((p) => p.enabled && proc(p.process_id).material_category).forEach((p) => {
          if (p.material_id && !(Number(p.required_qty) > 0)) e[`m${i}_${p.process_id}`] = 'Enter the required quantity';
        }),
      );
    if (s === 6)
      items.forEach((it, i) =>
        it.procs.filter((p) => p.enabled).forEach((p) => {
          if (p.start_date && p.due_date && p.start_date > p.due_date) e[`d${i}_${p.process_id}`] = 'Start must be before due';
        }),
      );
    return e;
  };
  const goto = (s: number) => {
    for (let k = 0; k < Math.min(s, STEPS.length); k++) {
      const e = validate(k);
      if (Object.keys(e).length) {
        setErrors(e);
        setStep(k);
        return;
      }
    }
    setErrors({});
    setStep(s);
    setMaxStep((m) => Math.max(m, s));
    window.scrollTo({ top: 0 });
  };

  const payload = () => ({
    ...(mode === 'existing' ? { customer_id: Number(customerId) } : { new_customer: nc }),
    ...info,
    po_number: info.po_number || null,
    source: info.source || null,
    notes: info.notes || null,
    delivery_address: info.delivery_address || (mode === 'existing' ? customer?.address : nc.address) || null,
    deadline: dates.deadline,
    sky_date: dates.sky_date || null,
    items: items.map((it) => ({
      product_id: Number(it.product_id),
      quantity: Number(it.quantity),
      dimensions: it.dimensions || null,
      color: it.color || null,
      finish: it.finish || null,
      specifications: it.specifications || null,
      processes: it.procs.filter((p) => p.enabled).map((p) => ({
        process_id: p.process_id,
        assigned_to: p.assigned_to ? Number(p.assigned_to) : null,
        start_date: p.start_date || null,
        due_date: p.due_date || null,
        specs: p.specs,
      })),
      materials: it.procs.filter((p) => p.enabled && p.material_id && Number(p.required_qty) > 0).map((p) => ({ process_id: p.process_id, material_id: Number(p.material_id), required_qty: Number(p.required_qty) })),
    })),
  });
  const create = () => run(() => api.post('/orders', payload()), 'Order created — job sheets generated').then((r: any) => r && nav(`/orders/${r.id}`));

  const shortages = useMemo(() => {
    const need = new Map<number, number>();
    items.forEach((it) => it.procs.forEach((p) => p.enabled && p.material_id && need.set(Number(p.material_id), (need.get(Number(p.material_id)) ?? 0) + Number(p.required_qty || 0))));
    return [...need.entries()]
      .map(([mid, q]) => {
        const s = stock.find((x) => x.material_id === mid);
        return s && q > s.available ? { name: s.name, unit: s.unit, need: q, available: s.available, short: q - s.available } : null;
      })
      .filter(Boolean) as any[];
  }, [items, stock]);

  return (
    <>
      <div className="crumbs"><Link to="/orders" className="row gap-4"><ChevronLeft size={14} /> Orders</Link></div>
      <div className="page-head">
        <div>
          <div className="eyebrow">Orders</div><h1>New order</h1>
          <div className="sub">Enter it once — the client, product, quantity and deadline flow to every job sheet, dashboard and dispatch record.</div>
        </div>
      </div>
      <div className="wizard">
        <nav className="wiz-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button key={s} className={cx('wiz-step', i === step && 'active', i < step && 'done')} onClick={() => i <= maxStep + 1 && goto(i)} disabled={i > maxStep + 1}>
              <span className="n">{i < step ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              <span className="lbl">{s}</span>
            </button>
          ))}
        </nav>
        <Card
          title={<div><div className="upper">Step {step + 1} of {STEPS.length}</div><h2 style={{ marginTop: 2 }}>{STEPS[step]}</h2></div>}
          footer={
            <div className="row between">
              <button className="btn" disabled={step === 0} onClick={() => goto(step - 1)}>Back</button>
              {step < STEPS.length - 1 ? (
                <button className="btn primary" onClick={() => goto(step + 1)}>Continue</button>
              ) : (
                <button className="btn accent lg" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create order & job sheets'}</button>
              )}
            </div>
          }
        >
          {error && <div style={{ marginBottom: 12 }}><Alert tone="bad">{error}</Alert></div>}

          {step === 0 && (
            <div className="col gap-16">
              <div className="grid g2" style={{ gap: 8 }}>
                <button type="button" className={cx('option-card', mode === 'existing' && 'on')} onClick={() => setMode('existing')}><div className="strong">Existing client</div><div className="small muted">{meta.customers.length} clients on record</div></button>
                <button type="button" className={cx('option-card', mode === 'new' && 'on')} onClick={() => setMode('new')}><div className="strong">New client</div><div className="small muted">Added to the client list</div></button>
              </div>
              {mode === 'existing' ? (
                <>
                  <Field label="Client" error={errors.customer}>
                    <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} invalid={!!errors.customer}>
                      <option value="">Select a client…</option>
                      {meta.customers.map((c) => <option key={c.id} value={c.id}>{c.name}{c.city ? ` — ${c.city}` : ''}</option>)}
                    </Select>
                  </Field>
                  {customer && (
                    <dl className="kv card card-pad" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                      <dt>Contact</dt><dd>{customer.contact_person ?? '—'}</dd>
                      <dt>Phone</dt><dd>{customer.phone ?? '—'}</dd>
                      <dt>Email</dt><dd>{customer.email ?? '—'}</dd>
                      <dt>Address</dt><dd>{customer.address ?? '—'}</dd>
                    </dl>
                  )}
                </>
              ) : (
                <div className="form-grid">
                  <Field label="Client / company name" error={errors.nc_name} className="full"><Input value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} invalid={!!errors.nc_name} /></Field>
                  <Field label="Contact person"><Input value={nc.contact_person} onChange={(e) => setNc({ ...nc, contact_person: e.target.value })} /></Field>
                  <Field label="Phone"><Input value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} /></Field>
                  <Field label="Email" error={errors.nc_email}><Input type="email" value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} /></Field>
                  <Field label="City"><Input value={nc.city} onChange={(e) => setNc({ ...nc, city: e.target.value })} /></Field>
                  <Field label="Address" className="full"><Input value={nc.address} onChange={(e) => setNc({ ...nc, address: e.target.value })} /></Field>
                  <Field label="GSTIN"><Input value={nc.gstin} onChange={(e) => setNc({ ...nc, gstin: e.target.value })} /></Field>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="form-grid">
              <Field label="Order date" error={errors.order_date}><Input type="date" value={info.order_date} onChange={(e) => setInfo({ ...info, order_date: e.target.value })} /></Field>
              <Field label="Priority">
                <Select value={info.priority} onChange={(e) => setInfo({ ...info, priority: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{cap(p)}</option>)}</Select>
              </Field>
              <Field label="PO / client reference"><Input value={info.po_number} onChange={(e) => setInfo({ ...info, po_number: e.target.value })} /></Field>
              <Field label="Order source">
                <Input list="sources" value={info.source} onChange={(e) => setInfo({ ...info, source: e.target.value })} placeholder="Email RFQ, WhatsApp, architect referral…" />
                <datalist id="sources">{['Email RFQ', 'Repeat client — email', 'Repeat client — WhatsApp', 'Architect referral', 'Website', 'Instagram enquiry', 'Showroom walk-in', 'Trade fair'].map((s) => <option key={s} value={s} />)}</datalist>
              </Field>
              <Field label="Delivery address" className="full" hint="Leave blank to use the client’s address"><Input value={info.delivery_address} onChange={(e) => setInfo({ ...info, delivery_address: e.target.value })} /></Field>
              <Field label="Notes" className="full"><Textarea value={info.notes} onChange={(e) => setInfo({ ...info, notes: e.target.value })} placeholder="Anything production or dispatch should know" /></Field>
            </div>
          )}

          {step === 2 && (
            <div className="col gap-16">
              {items.map((it, i) => (
                <div key={i} className="card card-pad" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
                  <div className="row between"><h3>Product {items.length > 1 ? i + 1 : ''}</h3>{items.length > 1 && <button className="btn ghost sm danger" onClick={() => setItems(items.filter((_, k) => k !== i))}><Trash2 size={14} /> Remove</button>}</div>
                  <div className="form-grid mt-12">
                    <Field label="Product" error={errors[`p${i}`]}>
                      <Select value={it.product_id} onChange={(e) => pickProduct(i, e.target.value)} invalid={!!errors[`p${i}`]}>
                        <option value="">Select…</option>
                        {meta.products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.sku})</option>)}
                      </Select>
                    </Field>
                    <Field label="Quantity (units)" error={errors[`q${i}`]}><Input type="number" min={1} value={it.quantity} onChange={(e) => setQty(i, e.target.value)} invalid={!!errors[`q${i}`]} /></Field>
                    <Field label="Dimensions"><Input value={it.dimensions} onChange={(e) => setItem(i, { dimensions: e.target.value })} /></Field>
                    <Field label="Colour"><Input value={it.color} onChange={(e) => setItem(i, { color: e.target.value })} placeholder="e.g. Charcoal / Ecru" /></Field>
                    <Field label="Finish"><Input value={it.finish} onChange={(e) => setItem(i, { finish: e.target.value })} placeholder="e.g. Powder coat — matte black" /></Field>
                    <Field label="Specifications"><Input value={it.specifications} onChange={(e) => setItem(i, { specifications: e.target.value })} /></Field>
                  </div>
                </div>
              ))}
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setItems([...items, newItem()])}><Plus size={14} /> Add another product</button>
            </div>
          )}

          {step === 3 && (
            <div className="col gap-16">
              <div className="form-grid">
                <Field label="Client deadline" error={errors.deadline} hint={dates.deadline ? `${daysBetween(info.order_date, dates.deadline)} days from order date` : undefined}>
                  <Input type="date" value={dates.deadline} min={info.order_date} onChange={(e) => setDates({ ...dates, deadline: e.target.value })} invalid={!!errors.deadline} />
                </Field>
                <Field label="Sky date" error={errors.sky_date} hint="Internal target date — production plans to finish by this date to keep a buffer">
                  <Input type="date" value={dates.sky_date} max={dates.deadline} onChange={(e) => setDates({ ...dates, sky_date: e.target.value })} invalid={!!errors.sky_date} />
                </Field>
              </div>
              {dates.deadline && dates.sky_date && <Alert tone="info">Buffer between sky date and deadline: {daysBetween(dates.sky_date, dates.deadline)} day(s). Job due dates are planned inside the sky date.</Alert>}
            </div>
          )}

          {step === 4 && (
            <div className="col gap-16">
              {items.map((it, i) => (
                <div key={i}>
                  <h3>{product(it.product_id)?.name} × {it.quantity}</h3>
                  {errors[`pr${i}`] && <div className="small" style={{ color: 'var(--bad)' }}>{errors[`pr${i}`]}</div>}
                  <div className="grid g3 mt-8" style={{ gap: 8 }}>
                    {it.procs.map((p) => (
                      <button key={p.process_id} type="button" className={cx('option-card', p.enabled && 'on')} onClick={() => setProc(i, p.process_id, { enabled: !p.enabled })}>
                        <div className="row between"><span className="strong">{proc(p.process_id).name}</span>{p.enabled ? <Chip tone="ok">Included</Chip> : <Chip>Skip</Chip>}</div>
                        <div className="tiny muted mt-8">A job sheet will be created for this process</div>
                      </button>
                    ))}
                  </div>
                  {it.procs.filter((p) => p.enabled).map((p) => (
                    <details key={p.process_id} className="mt-12">
                      <summary className="small strong" style={{ cursor: 'pointer' }}>{proc(p.process_id).name} — job sheet details (optional, can be filled later)</summary>
                      <SpecFields fields={proc(p.process_id).fields} values={p.specs} onChange={(specs) => setProc(i, p.process_id, { specs })} />
                    </details>
                  ))}
                </div>
              ))}
            </div>
          )}

          {step === 5 && (
            <div className="col gap-16">
              {shortages.map((s) => (
                <Alert key={s.name} tone="warn" title={`${num(s.short)} ${s.unit} shortage — ${s.name}`}>Needs {num(s.need)} {s.unit}, only {num(s.available)} {s.unit} free in store. You can still create the order; it will be flagged.</Alert>
              ))}
              {items.map((it, i) => (
                <div key={i} className="col gap-12">
                  <h3>{product(it.product_id)?.name} × {it.quantity}</h3>
                  {it.procs.filter((p) => p.enabled).map((p) => {
                    const pr = proc(p.process_id);
                    if (!pr.material_category) return <div key={p.process_id} className="small muted">{pr.name}: no tracked stock material.</div>;
                    const s = stock.find((x) => x.material_id === Number(p.material_id));
                    const short = s && Number(p.required_qty) > s.available;
                    return (
                      <div key={p.process_id} className="form-grid" style={{ gridTemplateColumns: '1.6fr 1fr 1fr' }}>
                        <Field label={`${pr.name} material`}>
                          <Select value={p.material_id} onChange={(e) => setProc(i, p.process_id, { material_id: e.target.value })}>
                            <option value="">Select {pr.material_category}…</option>
                            {stock.filter((m) => m.category === pr.material_category).map((m) => <option key={m.material_id} value={m.material_id}>{m.name} — {num(m.available)} {m.unit} free</option>)}
                          </Select>
                        </Field>
                        <Field label="Required" error={errors[`m${i}_${p.process_id}`]} hint={perUnit(it, p.process_id) ? `${perUnit(it, p.process_id)} ${s?.unit ?? ''}/unit + 5% allowance` : undefined}>
                          <div className="input-group">
                            <Input type="number" min={0} step="0.1" value={p.required_qty} onChange={(e) => setProc(i, p.process_id, { required_qty: e.target.value, qtyTouched: true })} />
                            <span className="addon">{s?.unit ?? (pr.material_category === 'rope' ? 'kg' : 'm')}</span>
                          </div>
                        </Field>
                        <Field label="Availability">
                          <div style={{ paddingTop: 8 }}>{!s ? <span className="muted small">—</span> : short ? <Chip tone="bad"><AlertTriangle size={12} /> Short {num(Number(p.required_qty) - s.available)} {s.unit}</Chip> : <Chip tone="ok">✓ Available</Chip>}</div>
                        </Field>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {step === 6 && (
            <div className="col gap-16">
              {items.map((it, i) => (
                <div key={i}>
                  <h3>{product(it.product_id)?.name} × {it.quantity}</h3>
                  <div className="table-wrap mt-8">
                    <table className="table">
                      <thead><tr><th>Process</th><th>Assign to</th><th>Planned start</th><th>Due</th></tr></thead>
                      <tbody>
                        {it.procs.filter((p) => p.enabled).map((p) => (
                          <tr key={p.process_id}>
                            <td className="strong">{proc(p.process_id).name}</td>
                            <td>
                              <Select value={p.assigned_to} onChange={(e) => setProc(i, p.process_id, { assigned_to: e.target.value })} style={{ minWidth: 180 }}>
                                <option value="">Assign later</option>
                                {users.filter((u) => u.role === 'staff' && u.active).sort((a, b) => Number(b.primary_process_id === p.process_id) - Number(a.primary_process_id === p.process_id)).map((u) => (
                                  <option key={u.id} value={u.id}>{u.name}{u.primary_process_id === p.process_id ? ` · ${proc(p.process_id).name}` : ''} · {u.open_jobs} open</option>
                                ))}
                              </Select>
                            </td>
                            <td><Input type="date" value={p.start_date} onChange={(e) => setProc(i, p.process_id, { start_date: e.target.value })} /></td>
                            <td>
                              <Input type="date" value={p.due_date} max={dates.deadline} onChange={(e) => setProc(i, p.process_id, { due_date: e.target.value })} invalid={!!errors[`d${i}_${p.process_id}`]} />
                              {errors[`d${i}_${p.process_id}`] && <div className="tiny" style={{ color: 'var(--bad)' }}>{errors[`d${i}_${p.process_id}`]}</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
              <div className="small muted">Unassigned job sheets block the move to “Ready for Production”.</div>
            </div>
          )}

          {step === 7 && (
            <div className="col gap-16">
              <div className="grid g2">
                <dl className="kv">
                  <dt>Client</dt><dd className="strong">{mode === 'existing' ? customer?.name : `${nc.name} (new)`}</dd>
                  <dt>Order date</dt><dd>{fmtDate(info.order_date)}</dd>
                  <dt>Priority</dt><dd>{cap(info.priority)}</dd>
                  <dt>Source</dt><dd>{info.source || '—'}</dd>
                  <dt>PO</dt><dd>{info.po_number || '—'}</dd>
                </dl>
                <dl className="kv">
                  <dt>Deadline</dt><dd className="strong">{fmtDate(dates.deadline)}</dd>
                  <dt>Sky date</dt><dd>{fmtDate(dates.sky_date)}</dd>
                  <dt>Lead time</dt><dd>{daysBetween(info.order_date, dates.deadline)} days</dd>
                </dl>
              </div>
              {items.map((it, i) => (
                <div key={i} className="card" style={{ boxShadow: 'none' }}>
                  <div className="card-head"><h3>{product(it.product_id)?.name} × {it.quantity}</h3><span className="small muted">{[it.color, it.finish, it.dimensions].filter(Boolean).join(' · ')}</span></div>
                  <table className="table dense">
                    <thead><tr><th>Job sheet</th><th>Staff</th><th>Dates</th><th>Material</th></tr></thead>
                    <tbody>
                      {it.procs.filter((p) => p.enabled).map((p) => {
                        const s = stock.find((x) => x.material_id === Number(p.material_id));
                        return (
                          <tr key={p.process_id}>
                            <td className="strong">{proc(p.process_id).name}</td>
                            <td>{users.find((u) => u.id === Number(p.assigned_to))?.name ?? <Chip tone="warn">Unassigned</Chip>}</td>
                            <td className="small">{fmtDate(p.start_date, false)} → {fmtDate(p.due_date, false)}</td>
                            <td className="small">{s ? `${p.required_qty} ${s.unit} ${s.name}` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
              {shortages.length > 0 && <Alert tone="warn">This order will be flagged with a material shortage.</Alert>}
              <Alert tone="info">On create: the order enters <b>Order Received</b>, one job sheet per process is generated, assigned staff are notified and material requirements are linked to inventory.</Alert>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

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
