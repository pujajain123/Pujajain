import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, PackagePlus, Truck } from 'lucide-react';
import { TXN_LABELS, type TxnType } from '../../../shared/domain';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useIsAdmin } from '../lib/auth';
import { useMeta } from '../lib/meta';
import { fmtDate, num } from '../lib/format';
import { Alert, Card, Chip, Empty, ErrorState, Field, Input, Loading, Modal, PageHead, Progress, Select, Tabs, Textarea, cx, useAction } from '../components/ui';

export function Inventory() {
  const admin = useIsAdmin();
  const [modal, setModal] = useState<null | 'txn' | 'incoming' | 'material'>(null);
  const [lower, setLower] = useState<'movements' | 'incoming'>('movements');
  const { data, error, reload } = useApi<any[]>('/inventory', ['inventory']);
  const nav = useNavigate();
  if (error) return <ErrorState error={error} retry={reload} />;
  const fabrics = (data ?? []).filter((s) => s.category === 'fabric');
  return (
    <>
      <PageHead
        eyebrow="Operations"
        title={admin ? 'Inventory' : 'Materials'}
        sub="Rope inventory from the stock workbook, alongside the workspace material ledger. Balances are calculated from recorded movements — nothing is overwritten."
        actions={
          <>
            {admin && <button className="btn" onClick={() => setModal('material')}><Plus size={14} /> Material</button>}
            <button className="btn" onClick={() => setModal('incoming')}><Truck size={14} /> Expected incoming</button>
            <button className="btn accent" onClick={() => setModal('txn')}><PackagePlus size={15} /> Record transaction</button>
          </>
        }
      />
      {!data ? <Loading rows={4} h={80} /> : <RopeWorkbook stock={data.filter((s) => s.category === 'rope')} onOpen={(id) => nav(`/inventory/${id}`)} />}

      <div className="section-title"><span className="eyebrow">Other workspace materials</span></div>
      <div className="grid g3">
        {fabrics.map((s) => (
          <Link key={s.material_id} to={`/inventory/${s.material_id}`} className="card card-pad" style={{ display: 'block' }}>
            <div className="row between top">
              <div><h3>{s.name}</h3><div className="small muted">Fabric · measured in {s.unit}</div></div>
              {s.low_stock ? <Chip tone="bad" dot>Low stock</Chip> : <Chip tone="ok" dot>In stock</Chip>}
            </div>
            <div className="row mt-16" style={{ alignItems: 'baseline', gap: 6 }}><span className="big-number">{num(s.available, 0)}</span><span className="small muted">{s.unit} available</span></div>
            <div className="mt-8"><Progress value={s.on_hand ? (s.available / s.on_hand) * 100 : 0} tone={s.low_stock ? 'bad' : undefined} /></div>
            <div className="grid g4 mt-16 small" style={{ gap: 8 }}>
              {[['On hand', s.on_hand], ['Reserved', s.reserved], ['Consumed', s.consumed], ['Reorder at', s.reorder_level]].map(([l, v]) => (
                <div key={l as string}><div className="muted tiny upper">{l}</div><div className="strong">{num(v as number, 0)} {s.unit}</div></div>
              ))}
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-24">
        <Tabs value={lower} onChange={setLower} items={[{ key: 'movements', label: 'Stock movements' }, { key: 'incoming', label: 'Expected incoming' }]} />
        <div className="mt-16">{lower === 'movements' ? <Movements /> : <Incoming />}</div>
      </div>
      {modal === 'txn' && <StockTxnModal onClose={() => setModal(null)} />}
      {modal === 'incoming' && <IncomingModal onClose={() => setModal(null)} />}
      {modal === 'material' && <MaterialModal onClose={() => setModal(null)} />}
    </>
  );
}

/** The imported rope workbook: stock master (live from the ledger) plus the original outward and purchase logs. */
function RopeWorkbook({ stock, onOpen }: { stock: any[]; onOpen: (id: number) => void }) {
  const book = useApi<any>('/inventory/rope-workbook').data;
  const [tab, setTab] = useState<'master' | 'outward' | 'purchase'>('master');
  const [q, setQ] = useState('');
  const [onlyStock, setOnlyStock] = useState(true);
  const sum = (k: string) => stock.reduce((a, s) => a + s[k], 0);
  const low = stock.filter((s) => s.on_hand < 100).length;
  const match = (...v: any[]) => !q || v.join(' ').toLowerCase().includes(q.toLowerCase());
  const master = stock.filter((s) => (!onlyStock || s.on_hand > 0 || s.incoming > 0) && match(s.name, s.color));
  const kpi = (l: string, v: string, tone?: string) => (
    <div className="card card-pad" style={{ boxShadow: 'none', background: tone ? 'var(--warn-soft)' : 'var(--surface-2)', borderColor: tone ? 'var(--warn-line)' : undefined, padding: '14px 16px' }}>
      <div className="upper tiny">{l}</div>
      <div className="stat-value" style={{ fontFamily: 'var(--display)', fontSize: 22, color: tone ? 'var(--warn-text)' : undefined }}>{v}</div>
    </div>
  );
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <div className="eyebrow">Imported rope workbook</div>
          <h2 style={{ marginTop: 4 }}>Rope inventory</h2>
          <div className="sub">Stock by rope type, thickness and colour, with purchase and issue history. Quantities are in metres.</div>
        </div>
      </div>
      <div className="card-body">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
          {kpi('On hand', `${num(sum('on_hand'), 0)} m`)}
          {kpi('Opening stock', `${num(sum('opening'), 0)} m`)}
          {kpi('Purchased', `${num(sum('incoming'), 0)} m`)}
          {kpi('Issued out', `${num(sum('consumed'), 0)} m`)}
          {kpi('Low / zero (<100 m)', `${low} SKUs`, 'warn')}
        </div>
        {book?.checks?.length > 0 && (
          <details className="alert warn small mt-16" style={{ display: 'block' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{book.checks.length} things in the workbook don’t add up — review before relying on these figures</summary>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>{book.checks.map((c: string) => <li key={c}>{c}</li>)}</ul>
          </details>
        )}
        <div className="row wrap mt-16" style={{ justifyContent: 'space-between' }}>
          <div className="row gap-8 wrap">
            {([['master', 'Stock master', stock.length], ['outward', 'Outward log', book?.outward_log.length], ['purchase', 'Purchase log', book?.purchase_log.length]] as const).map(([k, l, n]) => (
              <button key={k} className={cx('btn sm', tab === k && 'primary')} onClick={() => setTab(k)}>{l} <span style={{ opacity: 0.7 }}>{n ?? ''}</span></button>
            ))}
            {tab === 'master' && <label className="check small" style={{ marginLeft: 8 }}><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Hide never-stocked SKUs</label>}
          </div>
          <Input style={{ maxWidth: 300, height: 36 }} placeholder="Search type, size, colour or job" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
        {tab === 'master' ? (
          <table className="table dense">
            <thead><tr><th>Rope type (SKU)</th><th>mm</th><th>Colour</th><th className="num">Opening (m)</th><th className="num">Purchased (m)</th><th className="num">Outward (m)</th><th className="num">Current balance (m)</th><th className="num">Reserved</th><th className="num">Available</th></tr></thead>
            <tbody>
              {master.map((s) => {
                const [type, mm] = (s.variant ?? s.name).split(' · ');
                return (
                  <tr key={s.material_id} className="click" onClick={() => onOpen(s.material_id)}>
                    <td className="strong">{type}</td><td>{mm}</td><td>{s.color ?? '—'}</td>
                    <td className="num">{num(s.opening, 0)}</td><td className="num">{num(s.incoming, 0)}</td><td className="num">{num(s.consumed, 0)}</td>
                    <td className="num strong">{num(s.on_hand, 0)}</td><td className="num muted">{s.reserved ? num(s.reserved, 0) : '—'}</td>
                    <td className="num">{s.on_hand < 100 ? <Chip tone={s.on_hand <= 0 ? 'bad' : 'warn'}>{num(s.available, 0)}</Chip> : num(s.available, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="table dense">
            <thead><tr><th>Date</th><th>Rope type (SKU)</th><th>mm</th><th>Colour</th><th className="num">{tab === 'outward' ? 'Qty out (m)' : 'Qty purchased (m)'}</th>{tab === 'outward' ? <><th>Issued to</th><th>Used for</th></> : <><th>Supplier</th><th>Invoice</th></>}<th>Remarks</th></tr></thead>
            <tbody>
              {(tab === 'outward' ? book?.outward_log : book?.purchase_log ?? [])
                ?.filter((r: any) => match(...Object.values(r)))
                .map((r: any, i: number) => (
                  <tr key={i}>
                    <td className="nowrap">{r.Date || <span className="faint">no date</span>}</td>
                    <td className="strong">{r['Rope Type (SKU)']}</td><td>{r.mm}</td><td>{r.Color}</td>
                    <td className="num strong">{r['Qty Out (m)'] ?? r['Qty Purchased (m)']}</td>
                    {tab === 'outward' ? <><td>{r['Issued To'] || '—'}</td><td>{r['Used For (Job/Product)'] || '—'}</td></> : <><td>{r.Supplier || '—'}</td><td>{r['Invoice/Bill No.'] || '—'}</td></>}
                    <td className="small muted">{r.Remarks}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card-foot small muted">
        {tab === 'master'
          ? `Showing ${master.length} of ${stock.length} rope SKUs · balances include every movement recorded in this app since the workbook import.`
          : 'Original workbook log as imported from Google Sheets (read-only). New issues and purchases are recorded with “Record transaction”.'}
      </div>
    </section>
  );
}

function Movements() {
  const [type, setType] = useState('');
  const [limit, setLimit] = useState(25);
  const { data } = useApi<any[]>(`/inventory/transactions${type ? `?type=${type}` : ''}`, ['inventory']);
  return (
    <Card pad={false} title={<Select style={{ width: 220, height: 32 }} value={type} onChange={(e) => setType(e.target.value)}><option value="">All movement types</option>{Object.entries(TXN_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}>
      {!data ? <Loading rows={5} h={36} /> : data.length === 0 ? <Empty title="No movements" /> : (
        <>
          <TxnTable rows={data.slice(0, limit)} showMaterial />
          {data.length > limit && <div className="card-foot row between"><span className="small muted">Showing {limit} of {data.length} movements</span><button className="btn sm" onClick={() => setLimit(limit + 50)}>Show more</button></div>}
        </>
      )}
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
