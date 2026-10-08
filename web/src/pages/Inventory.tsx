import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, PackagePlus, Truck } from 'lucide-react';
import { TXN_LABELS, type TxnType } from '../../../shared/domain';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useIsAdmin } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { fmtDate, num } from '../lib/format';
import { Alert, Card, Chip, Empty, ErrorState, Field, Input, Loading, Modal, Select, Tabs, Textarea, useAction } from '../components/ui';

export function Inventory() {
  const [cat, setCat] = useState<'rope' | 'fabric' | 'movements' | 'incoming'>('rope');
  const admin = useIsAdmin();
  const [modal, setModal] = useState<null | 'txn' | 'incoming' | 'material'>(null);
  const { data, error, reload } = useApi<any[]>('/inventory', ['inventory']);
  const nav = useNavigate();
  if (error) return <ErrorState error={error} retry={reload} />;
  const rows = (data ?? []).filter((s) => s.category === cat);
  const sum = (c: string, k: string) => (data ?? []).filter((s) => s.category === c).reduce((a, s) => a + s[k], 0);
  const low = (c: string) => (data ?? []).filter((s) => s.category === c && s.low_stock).length;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Operations</div><h1>{admin ? 'Inventory' : 'Materials'}</h1>
          <div className="sub">Balances are calculated from the stock ledger — opening + incoming ± adjustments − consumption − wastage. Nothing is overwritten.</div>
        </div>
        <div className="row">
          {admin && <button className="btn" onClick={() => setModal('material')}><Plus size={14} /> Material</button>}
          <button className="btn" onClick={() => setModal('incoming')}><Truck size={14} /> Expected incoming</button>
          <button className="btn primary" onClick={() => setModal('txn')}><PackagePlus size={14} /> Record stock movement</button>
        </div>
      </div>
      {data && (
        <div className="grid g2">
          {(['rope', 'fabric'] as const).map((c) => (
            <div key={c} className="card card-pad">
              <div className="row between"><h2>{c === 'rope' ? 'Rope' : 'Fabric'}</h2>{low(c) > 0 && <Chip tone="bad">{low(c)} low stock</Chip>}</div>
              <div className="grid g4 mt-12" style={{ gap: 8 }}>
                {[['Current stock', 'on_hand'], ['Reserved', 'reserved'], ['Consumed', 'consumed'], ['Incoming', 'expected_incoming']].map(([l, k]) => (
                  <div key={k}><div className="stat-label">{l}</div><div className="stat-value">{num(sum(c, k), 0)} <span className="small muted">{c === 'rope' ? 'kg' : 'm'}</span></div></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-16">
        <Tabs value={cat} onChange={setCat} items={[{ key: 'rope', label: 'Rope stock', count: (data ?? []).filter((s) => s.category === 'rope').length }, { key: 'fabric', label: 'Fabric stock', count: (data ?? []).filter((s) => s.category === 'fabric').length }, { key: 'movements', label: 'Stock movements' }, { key: 'incoming', label: 'Incoming' }]} />
      </div>
      <div className="mt-16">
        {cat === 'movements' ? <Movements /> : cat === 'incoming' ? <Incoming /> : !data ? <Loading rows={5} h={44} /> : (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Material</th><th>Colour</th><th className="num">Current stock</th><th className="num">Reserved</th><th className="num">Available</th><th className="num">Consumed</th><th className="num">Wastage</th><th className="num">Incoming</th><th className="num">Reorder at</th><th>Open orders</th></tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.material_id} className="click" onClick={() => nav(`/inventory/${s.material_id}`)}>
                      <td><div className="strong">{s.name}</div><div className="cell-sub mono">{s.code} · {s.location}</div></td>
                      <td>{s.color}</td>
                      <td className="num strong">{num(s.on_hand)} {s.unit}</td>
                      <td className="num">{num(s.reserved)}</td>
                      <td className="num">{s.low_stock ? <Chip tone="bad">{num(s.available)} {s.unit}</Chip> : <span className="strong" style={{ color: 'var(--ok)' }}>{num(s.available)} {s.unit}</span>}</td>
                      <td className="num muted">{num(s.consumed)}</td>
                      <td className="num muted">{num(s.wastage)}</td>
                      <td className="num">{s.expected_incoming ? <Chip tone="info">+{num(s.expected_incoming)}</Chip> : <span className="faint">—</span>}</td>
                      <td className="num muted">{num(s.reorder_level)}</td>
                      <td>{s.open_orders || <span className="faint">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      {modal === 'txn' && <StockTxnModal onClose={() => setModal(null)} />}
      {modal === 'incoming' && <IncomingModal onClose={() => setModal(null)} />}
      {modal === 'material' && <MaterialModal onClose={() => setModal(null)} />}
    </>
  );
}

function Movements() {
  const [type, setType] = useState('');
  const { data } = useApi<any[]>(`/inventory/transactions${type ? `?type=${type}` : ''}`, ['inventory']);
  return (
    <Card pad={false} title={<Select style={{ width: 220, height: 32 }} value={type} onChange={(e) => setType(e.target.value)}><option value="">All movement types</option>{Object.entries(TXN_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}>
      {!data ? <Loading rows={5} h={36} /> : data.length === 0 ? <Empty title="No movements" /> : <TxnTable rows={data} showMaterial />}
    </Card>
  );
}

export function TxnTable({ rows, showMaterial, unit }: { rows: any[]; showMaterial?: boolean; unit?: string }) {
  const sign = (t: string) => (['opening', 'incoming', 'adjustment_in', 'release'].includes(t) ? '+' : t === 'allocation' ? '⟂' : '−');
  return (
    <div className="table-wrap">
      <table className="table dense">
        <thead><tr><th>Date</th>{showMaterial && <th>Material</th>}<th>Type</th><th className="num">Qty</th><th>Order / job</th><th>Reference</th><th>By</th><th>Notes</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="nowrap">{fmtDate(t.txn_date)}</td>
              {showMaterial && <td className="strong">{t.material_name}</td>}
              <td><Chip tone={['incoming', 'opening', 'adjustment_in'].includes(t.type) ? 'ok' : t.type === 'wastage' || t.type === 'adjustment_out' ? 'bad' : t.type === 'allocation' || t.type === 'release' ? 'info' : ''}>{TXN_LABELS[t.type as TxnType]}</Chip></td>
              <td className="num strong nowrap">{sign(t.type)} {num(t.quantity)} {t.unit ?? unit}</td>
              <td className="mono small">{[t.order_code, t.job_code].filter(Boolean).join(' · ') || '—'}</td>
              <td className="mono small">{t.reference ?? '—'}</td>
              <td>{t.user_name ?? 'System'}</td>
              <td className="small muted">{t.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Incoming() {
  const { data } = useApi<any[]>('/inventory/incoming', ['inventory']);
  const { run, busy } = useAction();
  const admin = useIsAdmin();
  if (!data) return <Loading rows={3} h={40} />;
  return (
    <Card pad={false}>
      {data.length === 0 ? <Empty title="No incoming stock recorded" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Material</th><th className="num">Qty</th><th>Supplier</th><th>Expected</th><th>Reference</th><th>Status</th><th /></tr></thead>
            <tbody>
              {data.map((i) => (
                <tr key={i.id}>
                  <td className="strong">{i.material_name}</td>
                  <td className="num">{num(i.quantity)} {i.unit}</td>
                  <td>{i.supplier ?? '—'}</td>
                  <td>{fmtDate(i.expected_date)}</td>
                  <td className="mono small">{i.reference ?? '—'}</td>
                  <td><Chip tone={i.status === 'pending' ? 'info' : i.status === 'received' ? 'ok' : ''}>{i.status}</Chip></td>
                  <td className="right nowrap">
                    {i.status === 'pending' && (
                      <>
                        <button className="btn sm primary" disabled={busy} onClick={() => run(() => api.post(`/inventory/incoming/${i.id}/receive`, {}), 'Stock received — shortages re-allocated')}>Mark received</button>{' '}
                        {admin && <button className="btn sm ghost" disabled={busy} onClick={() => run(() => api.post(`/inventory/incoming/${i.id}/receive`, { cancel: true }), 'Cancelled')}>Cancel</button>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function StockTxnModal({ onClose, materialId }: { onClose: () => void; materialId?: number }) {
  const meta = useMeta();
  const admin = useIsAdmin();
  const jobs = useApi<any[]>(admin ? '/jobs?status=open' : '/jobs?mine=1&status=open', ['jobs']).data ?? [];
  const types: TxnType[] = admin ? ['incoming', 'consumption', 'wastage', 'adjustment_in', 'adjustment_out', 'allocation', 'release', 'opening'] : ['incoming', 'consumption', 'wastage'];
  const [f, setF] = useState<any>({ material_id: materialId ?? '', type: admin ? 'incoming' : 'consumption', quantity: '', job_id: '', order_id: '', reference: '', notes: '', txn_date: meta.today });
  const { run, busy, fields, error } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const mat = meta.materials.find((m) => m.id === Number(f.material_id));
  const needsOrder = ['allocation', 'release'].includes(f.type);
  const linkJob = ['consumption', 'wastage'].includes(f.type);
  const orders = [...new Map(jobs.map((j) => [j.order_id, j])).values()];
  return (
    <Modal
      title="Record stock movement"
      sub="Posted to the ledger — balances recalculate everywhere."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => api.post('/inventory/transactions', { material_id: Number(f.material_id), type: f.type, quantity: Number(f.quantity), job_id: f.job_id ? Number(f.job_id) : null, order_id: f.order_id ? Number(f.order_id) : null, reference: f.reference || null, notes: f.notes || null, txn_date: f.txn_date }), 'Stock movement recorded').then((r) => r && onClose())}>Post movement</button></>}
    >
      <div className="col gap-12">
        {error && !Object.keys(fields).length && <Alert tone="bad">{error}</Alert>}
        <div className="form-grid">
          <Field label="Material" error={fields.material_id} className="full">
            <Select value={f.material_id} onChange={set('material_id')}>
              <option value="">Select…</option>
              {['rope', 'fabric'].map((c) => <optgroup key={c} label={c === 'rope' ? 'Rope' : 'Fabric'}>{meta.materials.filter((m) => m.category === c).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>)}
            </Select>
          </Field>
          <Field label="Movement type">
            <Select value={f.type} onChange={set('type')}>{types.map((t) => <option key={t} value={t}>{TXN_LABELS[t]}</option>)}</Select>
          </Field>
          <Field label="Quantity" error={fields.quantity}>
            <div className="input-group"><Input type="number" min={0} step="0.1" value={f.quantity} onChange={set('quantity')} /><span className="addon">{mat?.unit ?? '—'}</span></div>
          </Field>
          {linkJob && (
            <Field label="Job sheet" className="full" hint="Links usage to the order and job">
              <Select value={f.job_id} onChange={set('job_id')}><option value="">Not linked to a job</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.code} · {j.process_name} · {j.order_code}</option>)}</Select>
            </Field>
          )}
          {needsOrder && (
            <Field label="Order" className="full">
              <Select value={f.order_id} onChange={set('order_id')}><option value="">Select order…</option>{orders.map((o) => <option key={o.order_id} value={o.order_id}>{o.order_code} — {o.customer}</option>)}</Select>
            </Field>
          )}
          <Field label="Date"><Input type="date" max={meta.today} value={f.txn_date} onChange={set('txn_date')} /></Field>
          <Field label="Reference" hint="Invoice / challan / GRN"><Input value={f.reference} onChange={set('reference')} /></Field>
          <Field label={f.type.startsWith('adjustment') ? 'Reason (required)' : 'Notes'} className="full"><Textarea value={f.notes} onChange={set('notes')} style={{ minHeight: 60 }} /></Field>
        </div>
      </div>
    </Modal>
  );
}

function IncomingModal({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const [f, setF] = useState<any>({ material_id: '', quantity: '', supplier: '', expected_date: '', reference: '' });
  const { run, busy, fields } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Expected incoming stock" sub="Shows as Incoming until it’s received; receiving posts it to the ledger and re-reserves for short orders." onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => api.post('/inventory/incoming', { ...f, material_id: Number(f.material_id), quantity: Number(f.quantity), expected_date: f.expected_date || null }), 'Incoming stock added').then((r) => r && onClose())}>Save</button></>}>
      <div className="form-grid">
        <Field label="Material" error={fields.material_id} className="full"><Select value={f.material_id} onChange={set('material_id')}><option value="">Select…</option>{meta.materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>
        <Field label="Quantity" error={fields.quantity}><Input type="number" value={f.quantity} onChange={set('quantity')} /></Field>
        <Field label="Expected date"><Input type="date" value={f.expected_date} onChange={set('expected_date')} /></Field>
        <Field label="Supplier"><Input value={f.supplier} onChange={set('supplier')} /></Field>
        <Field label="PO / reference"><Input value={f.reference} onChange={set('reference')} /></Field>
      </div>
    </Modal>
  );
}

export function MaterialModal({ onClose, material }: { onClose: () => void; material?: any }) {
  const [f, setF] = useState<any>(material ?? { code: '', name: '', category: 'rope', variant: '', color: '', unit: 'kg', reorder_level: '', supplier: '', location: '', opening_stock: '' });
  const { run, busy, fields, error } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const body = () => {
    const b: any = { name: f.name, category: f.category, variant: f.variant || null, color: f.color || null, unit: f.unit, reorder_level: Number(f.reorder_level || 0), supplier: f.supplier || null, location: f.location || null };
    if (!material) Object.assign(b, { code: f.code, opening_stock: f.opening_stock ? Number(f.opening_stock) : undefined });
    return b;
  };
  return (
    <Modal wide title={material ? `Edit ${material.name}` : 'Add material'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(() => (material ? api.patch(`/inventory/materials/${material.id}`, body()) : api.post('/inventory/materials', body())), 'Material saved').then((r) => r && onClose())}>Save</button></>}>
      {error && !Object.keys(fields).length && <Alert tone="bad">{error}</Alert>}
      <div className="form-grid mt-8">
        {!material && <Field label="Code" error={fields.code} hint="e.g. ROPE-OLF6-CHR"><Input value={f.code} onChange={set('code')} /></Field>}
        <Field label="Name" error={fields.name}><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value, unit: e.target.value === 'rope' ? 'kg' : 'm' })} disabled={!!material}><option value="rope">Rope</option><option value="fabric">Fabric</option></Select></Field>
        <Field label="Unit"><Select value={f.unit} onChange={set('unit')}><option value="kg">kg</option><option value="m">m</option><option value="pcs">pcs</option></Select></Field>
        <Field label="Variant / spec"><Input value={f.variant ?? ''} onChange={set('variant')} /></Field>
        <Field label="Colour"><Input value={f.color ?? ''} onChange={set('color')} /></Field>
        <Field label="Reorder level" error={fields.reorder_level}><Input type="number" value={f.reorder_level} onChange={set('reorder_level')} /></Field>
        <Field label="Supplier"><Input value={f.supplier ?? ''} onChange={set('supplier')} /></Field>
        <Field label="Store location"><Input value={f.location ?? ''} onChange={set('location')} /></Field>
        {!material && <Field label="Opening stock"><Input type="number" value={f.opening_stock} onChange={set('opening_stock')} /></Field>}
      </div>
    </Modal>
  );
}
