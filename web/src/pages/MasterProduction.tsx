import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, ImageIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useIsAdmin } from '../lib/auth';
import { fmtShort } from '../lib/format';
import { Empty, ErrorState, Field, Input, Loading, Modal, PageHead, Textarea, cx, useAction } from '../components/ui';

type StepCell = { status: string; job_id: number; key: string; kind: 'work' | 'qc' } | null;
type MatCell = { required: boolean; status: string; note: string | null } | null;
interface Row {
  item_id: number; order_id: number; order_code: string; order_date: string; commencement: string | null; client: string; sku: string; product: string; qty: number;
  deadline: string; stage: string; on_hold: boolean; photo: boolean; materials: Record<string, MatCell>; steps: Record<string, StepCell>;
  current_status: string; procurement_delay: string; deadline_delay: string; rework: string | null; notes: string | null; completion: number;
}

const LABEL: Record<string, string> = {
  not_started: 'Not started', in_progress: 'In progress', done: 'Done', not_required: 'Not required',
  pending: 'Pending', approved: 'Approved', rejected: 'Rejected', received: 'Received',
};
const TONE: Record<string, string> = { done: 'good', approved: 'good', received: 'good', in_progress: 'active', pending: 'warn', rejected: 'bad', not_started: '', not_required: 'none' };
const MATS: [string, string][] = [['fabric', 'Fabric'], ['rope', 'Rope'], ['foam', 'Foam'], ['tile', 'Tile / stone'], ['metal', 'Metal']];
const STEPS: [string, string][] = [
  ['structure', 'Structure'], ['structure_qc', 'Structure QCA'], ['powder', 'Powder coating'], ['powder_qc', 'Powder QCA'],
  ['weaving', 'Weaving'], ['weaving_qc', 'Weaving QCA'], ['upholstery', 'Upholstery'], ['upholstery_qc', 'Upholstery QCA'], ['tile_work', 'Tile / stone work'],
];

/** The Master Production Sheet, rebuilt: one row per product line, edited in place, saved for everyone. */
export function MasterProduction() {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState(false);
  const [focus, setFocus] = useState<'all' | 'waiting' | 'qc' | 'late'>('all');
  const { data, error, reload } = useApi<Row[]>(`/production/tracker${closed ? '?closed=1' : ''}`, ['orders', 'jobs', 'inventory']);
  const admin = useIsAdmin();
  const { run } = useAction();

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) r = r.filter((x) => [x.order_code, x.client, x.sku, x.product, x.current_status].join(' ').toLowerCase().includes(q.toLowerCase()));
    if (focus === 'waiting') r = r.filter((x) => x.current_status === 'Waiting for Material');
    if (focus === 'qc') r = r.filter((x) => Object.values(x.steps).some((s) => s?.kind === 'qc' && s.status === 'pending'));
    if (focus === 'late') r = r.filter((x) => x.deadline_delay === 'Late');
    return r;
  }, [data, q, focus]);
  const orders = new Set(rows.map((r) => r.order_code)).size;
  if (error) return <ErrorState error={error} retry={reload} />;

  const [reject, setReject] = useState<NonNullable<StepCell> | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const setStep = (c: NonNullable<StepCell>, status: string, note: string | null = null) => {
    if (status === 'rejected' && !note) return (setRejectNote(''), setReject(c));
    return run(() => api.post(`/jobs/${c.job_id}/steps/${c.key}`, { status, note }), status === 'rejected' ? 'Inspection rejected — work step reopened' : 'Saved');
  };
  const setMat = (r: Row, kind: string, status: string) => run(() => api.patch(`/production/tracker/${r.item_id}`, { material: kind, status }), 'Saved');
  const setLine = (r: Row, body: Record<string, string>) => run(() => api.patch(`/production/tracker/${r.item_id}`, body), 'Saved');

  let lastOrder = '';
  let band = false;
  return (
    <>
      <PageHead
        eyebrow="Operations"
        title="Master production"
        sub="Order master and production tracker. Update material, stage and QC status in place — every change is saved for the whole team and logged."
        actions={<Link to="/jobs" className="btn">Open job sheets</Link>}
      />
      <div className="filters">
        <div className="search" style={{ maxWidth: 300 }}>
          <Search size={15} style={{ top: 11 }} />
          <Input className="search-in" style={{ height: 36, paddingLeft: 34 }} placeholder="Search order, client or SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg">
          {([['all', 'All lines'], ['waiting', 'Waiting for material'], ['qc', 'QC pending'], ['late', 'Late']] as const).map(([k, l]) => (
            <button key={k} className={cx(focus === k && 'on')} onClick={() => setFocus(k)}>{l}</button>
          ))}
        </div>
        <label className="check small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Include completed orders</label>
        <span className="result-count"><b style={{ color: 'var(--ink)' }}>{rows.length}</b> product lines · <b style={{ color: 'var(--ink)' }}>{orders}</b> orders</span>
      </div>
      {!data ? (
        <Loading rows={8} h={40} />
      ) : rows.length === 0 ? (
        <div className="card"><Empty title="No product lines match" /></div>
      ) : (
        <div className="card tracker-wrap">
          <table className="table tracker">
            <thead>
              <tr>
                <th className="sticky-col c1">Order no.</th>
                <th className="sticky-col c2">SKU / product</th>
                <th>Client</th><th className="num">Qty</th><th>Order date</th><th>Commencement</th><th>Deadline</th>
                {MATS.map(([, l]) => <th key={l} className="grp-mat">{l}</th>)}
                {STEPS.map(([k, l]) => <th key={k} className={k.endsWith('_qc') ? 'grp-qc' : 'grp-step'}>{l}</th>)}
                <th>Current status</th><th>Procurement</th><th>Deadline</th><th>Rework</th><th style={{ minWidth: 200 }}>Notes</th><th style={{ minWidth: 120 }}>Completion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const first = r.order_code !== lastOrder;
                if (first) band = !band;
                lastOrder = r.order_code;
                return (
                  <tr key={r.item_id} className={cx(band && 'band', first && 'first')}>
                    <td className="sticky-col c1">{first ? <Link to={`/orders/${r.order_id}`} className="strong link-plain">{r.order_code}</Link> : <span className="faint">〃</span>}</td>
                    <td className="sticky-col c2">
                      <div className="strong nowrap">{r.sku}{r.photo && <ImageIcon size={12} style={{ marginLeft: 6, color: 'var(--muted)' }} />}</div>
                      <div className="cell-sub nowrap">{r.product}</div>
                    </td>
                    <td className="nowrap">{first ? r.client : ''}</td>
                    <td className="num">{r.qty}</td>
                    <td className="nowrap small">{first ? fmtShort(r.order_date) : ''}</td>
                    <td className="nowrap small">{first ? fmtShort(r.commencement) : ''}</td>
                    <td className="nowrap small" style={r.deadline_delay === 'Late' ? { color: 'var(--bad)' } : undefined}>{first ? fmtShort(r.deadline) : ''}</td>
                    {MATS.map(([k]) => {
                      const m = r.materials[k];
                      if (!m || !m.required) return <td key={k}><span className="faint small" title={m?.note ?? 'Not required'}>{m?.note ? m.note : '—'}</span></td>;
                      return (
                        <td key={k}>
                          <PillSelect value={m.status} options={['pending', 'received', 'not_required']} disabled={!admin} onChange={(v) => setMat(r, k, v)} label={`${k} for ${r.sku}`} />
                        </td>
                      );
                    })}
                    {STEPS.map(([k]) => {
                      const c = r.steps[k];
                      if (!c) return <td key={k}><span className="faint small">—</span></td>;
                      const opts = c.kind === 'qc' ? ['pending', 'approved', 'rejected'] : ['not_started', 'in_progress', 'done'];
                      if (admin) opts.push('not_required');
                      return (
                        <td key={k}>
                          <PillSelect value={c.status} options={opts} onChange={(v) => setStep(c, v)} label={`${k} for ${r.sku}`} />
                        </td>
                      );
                    })}
                    <td><span className={cx('pill', r.current_status === 'Waiting for Material' ? 'warn' : r.current_status === 'Quality Check' ? 'active' : r.current_status.startsWith('Ready') || r.current_status === 'Completed' ? 'good' : 'active')}>{r.current_status}</span></td>
                    <td><span className={cx('pill', r.procurement_delay === 'On Track' ? 'good' : 'warn')}>{r.procurement_delay}</span></td>
                    <td><span className={cx('pill', r.deadline_delay === 'On Track' ? 'good' : 'bad')}>{r.deadline_delay}</span></td>
                    <td>
                      <PillSelect value={r.rework ?? ''} options={['', 'required', 'resolved']} labels={{ '': 'None', required: 'Required', resolved: 'Resolved' }} tones={{ '': 'none', required: 'bad', resolved: 'good' }} onChange={(v) => setLine(r, { rework: v })} label={`rework for ${r.sku}`} />
                    </td>
                    <td><NoteCell value={r.notes ?? ''} onSave={(v) => setLine(r, { notes: v })} /></td>
                    <td>
                      <div className="row"><div className="progress grow"><span style={{ width: `${r.completion}%` }} /></div><span className="small strong">{r.completion}%</span></div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {reject && (
        <Modal
          title="Reject inspection"
          sub="The work step before it goes back to In progress so it can be reworked."
          onClose={() => setReject(null)}
          footer={<><button className="btn" onClick={() => setReject(null)}>Cancel</button><button className="btn danger solid" disabled={!rejectNote.trim()} onClick={() => { const c = reject; setReject(null); setStep(c, 'rejected', rejectNote.trim()); }}>Reject</button></>}
        >
          <Field label="What failed?"><Textarea value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="e.g. weld gap on rear leg, uneven powder coat" autoFocus /></Field>
        </Modal>
      )}
      <div className="alert info mt-16 small">
        Status cells save straight away and are shared with the whole team. A work step can only start after the inspection before it is approved — the tracker tells you if a change is out of order. Current status, delays and completion are calculated automatically.
      </div>
    </>
  );
}

function PillSelect({ value, options, onChange, disabled, label, labels = LABEL, tones = TONE }: { value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean; label: string; labels?: Record<string, string>; tones?: Record<string, string> }) {
  const opts = options.includes(value) ? options : [value, ...options];
  return (
    <label className={cx('pill pill-select', tones[value])}>
      {labels[value] ?? value}
      {!disabled && <span aria-hidden className="caret">⌄</span>}
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => e.target.value !== value && onChange(e.target.value)}>
        {opts.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
      </select>
    </label>
  );
}

function NoteCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="cell-input"
      value={v}
      placeholder="Add note"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="Notes"
    />
  );
}
