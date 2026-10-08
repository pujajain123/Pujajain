import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useMeta, type FieldDef } from '../lib/meta';
import { Alert, Card, Chip, Field, Input, Modal, Select, Tabs, Textarea, useAction } from '../components/ui';

export function SettingsPage() {
  const [tab, setTab] = useState<'general' | 'stages' | 'processes' | 'products' | 'clients'>('general');
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1><div className="sub">Lifecycle labels, job sheet fields, products, clients and alert thresholds. Every change is audited.</div></div></div>
      <Tabs value={tab} onChange={setTab} items={[{ key: 'general', label: 'General' }, { key: 'stages', label: 'Order lifecycle' }, { key: 'processes', label: 'Processes & job sheets' }, { key: 'products', label: 'Products' }, { key: 'clients', label: 'Clients' }]} />
      <div className="mt-16">
        {tab === 'general' && <General />}
        {tab === 'stages' && <Stages />}
        {tab === 'processes' && <Processes />}
        {tab === 'products' && <Products />}
        {tab === 'clients' && <Clients />}
      </div>
    </>
  );
}

function General() {
  const meta = useMeta();
  const [f, setF] = useState(meta.settings);
  const { run, busy } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Card title="General" footer={<button className="btn primary" disabled={busy} onClick={() => run(() => api.put('/settings', f), 'Settings saved')}>Save</button>}>
      <div className="form-grid">
        <Field label="Company name"><Input value={f.company_name} onChange={set('company_name')} /></Field>
        <Field label="Order ID prefix" hint="New orders: prefix + running number, e.g. UM-1036"><Input value={f.order_prefix} onChange={set('order_prefix')} /></Field>
        <Field label="“Approaching” window (days)" hint="🟡 when the deadline is within this many days"><Input type="number" value={f.approaching_days} onChange={set('approaching_days')} /></Field>
        <Field label="“At risk” window (days)" hint="🟠 when within this many days, or production is well behind schedule"><Input type="number" value={f.at_risk_days} onChange={set('at_risk_days')} /></Field>
        <Field label="Due-soon notification (days)" hint="Raise a deadline alert this many days before"><Input type="number" value={f.due_soon_days} onChange={set('due_soon_days')} /></Field>
      </div>
    </Card>
  );
}

function Stages() {
  const meta = useMeta();
  return (
    <Card title="Order lifecycle stages" pad={false}>
      <div className="card-body small muted" style={{ paddingBottom: 0 }}>
        The order of stages and their gates (e.g. every job sheet complete before Quality Check) are enforced by the status engine. Labels, descriptions and target durations are configurable.
      </div>
      <div className="card-body col gap-12">
        {meta.stages.map((s) => <StageRow key={s.key} s={s} />)}
      </div>
    </Card>
  );
}
function StageRow({ s }: { s: any }) {
  const [f, setF] = useState({ label: s.label, description: s.description ?? '', target_days: s.target_days ?? '' });
  const { run, busy } = useAction();
  const dirty = f.label !== s.label || f.description !== (s.description ?? '') || String(f.target_days) !== String(s.target_days ?? '');
  return (
    <div className="row wrap" style={{ alignItems: 'flex-end' }}>
      <span className="pill-count" style={{ marginBottom: 8 }}>{s.sequence}</span>
      <Field label="Label" className="grow"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
      <Field label="Description" className="grow"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Target days"><Input type="number" style={{ width: 100 }} value={f.target_days} onChange={(e) => setF({ ...f, target_days: e.target.value })} /></Field>
      <button className="btn" disabled={!dirty || busy} onClick={() => run(() => api.put(`/stages/${s.key}`, { ...f, target_days: f.target_days === '' ? null : Number(f.target_days) }), 'Stage saved')}>Save</button>
    </div>
  );
}

function Processes() {
  const meta = useMeta();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <div className="grid g3">
      {meta.processes.map((p) => (
        <Card key={p.id} title={p.name} actions={<button className="btn sm" onClick={() => setEdit(p)}>Edit fields</button>}>
          <div className="small muted">Draws from: {p.material_category ? <Chip>{p.material_category}</Chip> : 'no tracked stock'}</div>
          <div className="col mt-12" style={{ gap: 4 }}>
            {p.fields.map((f) => <div key={f.key} className="row between small"><span>{f.label}</span><span className="muted">{f.type}{f.unit ? ` · ${f.unit}` : ''}</span></div>)}
          </div>
        </Card>
      ))}
      {edit && <FieldsModal proc={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function FieldsModal({ proc, onClose }: { proc: any; onClose: () => void }) {
  const [fields, setFields] = useState<FieldDef[]>(proc.fields);
  const { run, busy, error } = useAction();
  const upd = (i: number, patch: Partial<FieldDef>) => setFields(fields.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  return (
    <Modal wide title={`${proc.name} — job sheet fields`} sub="Process-specific fields shown on every job sheet. Removing a field hides it; existing values are kept." onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => api.put(`/processes/${proc.id}`, { fields }), 'Fields saved').then((r) => r && onClose())}>Save fields</button></>}>
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="col gap-8 mt-8">
        {fields.map((f, i) => (
          <div key={i} className="row wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="Label" className="grow"><Input value={f.label} onChange={(e) => upd(i, { label: e.target.value, key: f.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(e) => upd(i, { type: e.target.value as any })}>{['text', 'number', 'select', 'textarea', 'date'].map((t) => <option key={t}>{t}</option>)}</Select></Field>
            <Field label="Unit"><Input style={{ width: 80 }} value={f.unit ?? ''} onChange={(e) => upd(i, { unit: e.target.value || undefined })} /></Field>
            <Field label="Section"><Input style={{ width: 120 }} value={f.section ?? ''} onChange={(e) => upd(i, { section: e.target.value || undefined })} /></Field>
            {f.type === 'select' && <Field label="Options (comma separated)" className="grow"><Input value={(f.options ?? []).join(', ')} onChange={(e) => upd(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>}
            <button className="btn ghost icon-btn danger" onClick={() => setFields(fields.filter((_, k) => k !== i))} aria-label="Remove field"><Trash2 size={15} /></button>
          </div>
        ))}
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setFields([...fields, { key: '', label: '', type: 'text', section: 'Process' }])}><Plus size={14} /> Add field</button>
      </div>
    </Modal>
  );
}

function Products() {
  const meta = useMeta();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <Card title="Products" actions={<button className="btn sm" onClick={() => setEdit({})}><Plus size={14} /> Product</button>} pad={false}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>Default size</th><th>Processes & material per unit</th><th /></tr></thead>
          <tbody>
            {meta.products.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.sku}</td>
                <td className="strong">{p.name}</td>
                <td>{p.category}</td>
                <td className="small">{p.default_dimensions}</td>
                <td><div className="row wrap gap-4">{p.processes.map((x) => { const pr = meta.processes.find((q) => q.id === x.process_id)!; return <Chip key={x.process_id}>{pr.name}{x.material_per_unit ? ` · ${x.material_per_unit} ${pr.material_category === 'rope' ? 'kg' : 'm'}` : ''}</Chip>; })}</div></td>
                <td className="right"><button className="btn sm" onClick={() => setEdit(p)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ProductModal p={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ProductModal({ p, onClose }: { p: any; onClose: () => void }) {
  const meta = useMeta();
  const [f, setF] = useState({ sku: p.sku ?? '', name: p.name ?? '', category: p.category ?? '', default_dimensions: p.default_dimensions ?? '', description: p.description ?? '' });
  const [procs, setProcs] = useState<Record<number, string | null>>(Object.fromEntries((p.processes ?? []).map((x: any) => [x.process_id, x.material_per_unit == null ? '' : String(x.material_per_unit)])));
  const { run, busy, fields, error } = useAction();
  const body = () => ({ ...f, processes: Object.entries(procs).map(([id, v]) => ({ process_id: Number(id), material_per_unit: v ? Number(v) : null })) });
  return (
    <Modal wide title={p.id ? `Edit ${p.name}` : 'Add product'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => (p.id ? api.put(`/products/${p.id}`, body()) : api.post('/products', body())), 'Product saved').then((r) => r && onClose())}>Save</button></>}>
      {error && !Object.keys(fields).length && <Alert tone="bad">{error}</Alert>}
      <div className="form-grid mt-8">
        <Field label="SKU" error={fields.sku}><Input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></Field>
        <Field label="Name" error={fields.name}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Category"><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field>
        <Field label="Default dimensions"><Input value={f.default_dimensions} onChange={(e) => setF({ ...f, default_dimensions: e.target.value })} /></Field>
        <Field label="Description" className="full"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <h3 className="mt-16">Production processes</h3>
      {fields.processes && <div className="small" style={{ color: 'var(--bad)' }}>{fields.processes}</div>}
      <div className="col gap-8 mt-8">
        {meta.processes.map((pr) => (
          <div key={pr.id} className="row">
            <label className="check" style={{ width: 160 }}><input type="checkbox" checked={pr.id in procs} onChange={(e) => { const n = { ...procs }; if (e.target.checked) n[pr.id] = ''; else delete n[pr.id]; setProcs(n); }} /> {pr.name}</label>
            {pr.material_category && pr.id in procs && (
              <div className="input-group" style={{ width: 220 }}><Input type="number" step="0.1" placeholder="Material per unit" value={procs[pr.id] ?? ''} onChange={(e) => setProcs({ ...procs, [pr.id]: e.target.value })} /><span className="addon">{pr.material_category === 'rope' ? 'kg' : 'm'}/unit</span></div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Clients() {
  const meta = useMeta();
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <Card title="Clients" actions={<button className="btn sm" onClick={() => setEdit({})}><Plus size={14} /> Client</button>} pad={false}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Client</th><th>Contact</th><th>Phone</th><th>Email</th><th>City</th><th>GSTIN</th><th /></tr></thead>
          <tbody>
            {meta.customers.map((c) => (
              <tr key={c.id}>
                <td className="strong">{c.name}</td><td>{c.contact_person}</td><td className="small">{c.phone}</td><td className="small">{c.email}</td><td>{c.city}</td><td className="mono small">{c.gstin}</td>
                <td className="right"><button className="btn sm" onClick={() => setEdit(c)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ClientModal c={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ClientModal({ c, onClose }: { c: any; onClose: () => void }) {
  const [f, setF] = useState({ name: c.name ?? '', contact_person: c.contact_person ?? '', phone: c.phone ?? '', email: c.email ?? '', address: c.address ?? '', city: c.city ?? '', gstin: c.gstin ?? '', notes: c.notes ?? '' });
  const { run, busy, fields } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal wide title={c.id ? `Edit ${c.name}` : 'Add client'} sub={c.id ? 'The new details appear on every order, job sheet and dispatch record for this client.' : undefined} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => (c.id ? api.put(`/customers/${c.id}`, f) : api.post('/customers', f)), 'Client saved').then((r) => r && onClose())}>Save</button></>}>
      <div className="form-grid mt-8">
        <Field label="Name" error={fields.name}><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Contact person"><Input value={f.contact_person} onChange={set('contact_person')} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email" error={fields.email}><Input value={f.email} onChange={set('email')} /></Field>
        <Field label="Address" className="full"><Input value={f.address} onChange={set('address')} /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} /></Field>
        <Field label="GSTIN"><Input value={f.gstin} onChange={set('gstin')} /></Field>
        <Field label="Notes" className="full"><Textarea value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}
