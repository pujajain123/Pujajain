import { useState } from 'react';
import { Check, Circle, ImagePlus, Lock, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import { readPhoto } from '../lib/photo';
import { fmtDateTime } from '../lib/format';
import { Field, Modal, Textarea, cx, useAction, useToast } from './ui';

export interface Step { id: number; key: string; label: string; kind: 'work' | 'qc'; sequence: number; status: string; note: string | null; updated_by_name: string | null; updated_at: string | null }
const LABEL: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', done: 'Done', not_required: 'Not required', pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
const finished = (s: Step) => ['done', 'approved', 'not_required'].includes(s.status);

/** Production steps with QC gates, as on the paper job sheet. Each row shows the one next action. */
export function StepsPanel({ jobId, steps, canEdit }: { jobId: number; steps: Step[]; canEdit: boolean }) {
  const { run, busy } = useAction();
  const [reject, setReject] = useState<Step | null>(null);
  const [note, setNote] = useState('');
  const set = (s: Step, status: string, n: string | null = null) => run(() => api.post(`/jobs/${jobId}/steps/${s.key}`, { status, note: n }), `${s.label}: ${LABEL[status]}`);
  return (
    <div className="steps">
      {steps.map((s, i) => {
        const gate = steps.slice(0, i).reverse().find((x) => x.kind === 'qc' && !finished(x));
        const prevWork = steps.slice(0, i).reverse().find((x) => x.kind === 'work');
        const locked = (s.kind === 'work' && !!gate) || (s.kind === 'qc' && !!prevWork && !finished(prevWork));
        const why = s.kind === 'work' ? (gate ? `waiting for ${gate.label.toLowerCase()}` : '') : prevWork && !finished(prevWork) ? `after ${prevWork.label.toLowerCase()}` : 'QC required before next step';
        return (
          <div key={s.key} className={cx('step-row', s.kind, finished(s) && 'is-done', s.status === 'rejected' && 'is-bad')}>
            <span className={cx('step-dot', finished(s) && 'done', s.status === 'in_progress' && 'active', s.status === 'rejected' && 'bad')}>
              {finished(s) ? <Check size={13} strokeWidth={3} /> : s.status === 'rejected' ? <X size={13} strokeWidth={3} /> : s.kind === 'qc' ? <ShieldCheck size={13} /> : <Circle size={8} fill="currentColor" />}
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="strong">{s.label}</div>
              <div className="small muted">
                {LABEL[s.status]}
                {s.status === 'not_started' || s.status === 'pending' ? (why ? ` · ${why}` : '') : s.updated_by_name ? ` · ${s.updated_by_name}, ${fmtDateTime(s.updated_at)}` : ''}
              </div>
              {s.note && <div className="small" style={{ color: s.status === 'rejected' ? 'var(--bad)' : 'var(--ink-2)' }}>“{s.note}”</div>}
            </div>
            {canEdit && !finished(s) && (
              locked ? <span className="small muted row gap-4"><Lock size={13} /> Locked</span> :
              s.kind === 'work' ? (
                s.status === 'in_progress'
                  ? <button className="btn sm primary" disabled={busy} onClick={() => set(s, 'done')}>Mark done</button>
                  : <button className="btn sm" disabled={busy} onClick={() => set(s, 'in_progress')}>Start step</button>
              ) : (
                <div className="row gap-4">
                  <button className="btn sm" disabled={busy} onClick={() => (setNote(''), setReject(s))}>Reject</button>
                  <button className="btn sm primary" disabled={busy} onClick={() => set(s, 'approved', 'Inspected and approved')}>Approve</button>
                </div>
              )
            )}
            {canEdit && finished(s) && s.status !== 'not_required' && (
              <button className="btn ghost sm" disabled={busy} onClick={() => set(s, s.kind === 'work' ? 'in_progress' : 'pending')} title="Reopen this step">Reopen</button>
            )}
          </div>
        );
      })}
      {reject && (
        <Modal title={`Reject: ${reject.label}`} sub="The work step before it goes back to In progress for rework." onClose={() => setReject(null)}
          footer={<><button className="btn" onClick={() => setReject(null)}>Cancel</button><button className="btn danger solid" disabled={!note.trim()} onClick={() => { const s = reject; setReject(null); set(s, 'rejected', note.trim()); }}>Reject</button></>}>
          <Field label="What failed?"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. weld gap on rear leg" autoFocus /></Field>
        </Modal>
      )}
    </div>
  );
}

const SPEC_FIELDS: [string, string, string?][] = [
  ['dimensions', 'Dimensions'], ['frame_material', 'Frame material'], ['powder_color', 'Powder colour'], ['dori_color', 'Dori colour'],
  ['rope_code', 'Rope size / code'], ['rope_required', 'Rope required', 'm'], ['fabric_code', 'Fabric code'], ['fabric_company', 'Fabric company'],
  ['fabric_qty', 'Fabric quantity', 'm'], ['seat_height', 'Seat height'], ['seat_bifurcation', 'Seat bifurcation'], ['back_cushion', 'Back cushion'],
  ['extra_cushion', 'Extra cushion'], ['table_top', 'Table top / stone'], ['buffer_type', 'Buffer type'],
];
export const SPEC_KEYS = SPEC_FIELDS;

/** One product line (SKU) with its production specification and reference photo. */
export function ProductLineCard({ orderId, item, index, canPhoto, compact }: { orderId: number; item: any; index?: number; canPhoto: boolean; compact?: boolean }) {
  const { run, busy } = useAction();
  const toast = useToast();
  const facts = SPEC_FIELDS.filter(([k]) => item[k] !== null && item[k] !== undefined && item[k] !== '');
  const upload = async (f: File) => {
    try {
      const photo = await readPhoto(f);
      await run(() => api.patch(`/orders/${orderId}/items/${item.id}`, { photo }), 'Product photo saved');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <article className="line-card">
      <div className="line-photo">
        {item.photo ? <img src={item.photo} alt={`${item.product} reference`} /> : <span className="small muted">No photo</span>}
        {canPhoto && (
          <label className="btn sm" style={{ position: 'absolute', bottom: 8, left: 8 }}>
            <ImagePlus size={14} /> {busy ? 'Saving…' : item.photo ? 'Replace' : 'Add photo'}
            <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          </label>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="row between top">
          <div>
            <div className="eyebrow">{index !== undefined ? `Product ${index + 1} · ` : ''}{item.sku}</div>
            <h3 style={{ marginTop: 2 }}>{item.product}</h3>
          </div>
          <span className="strong nowrap">{item.quantity} units</span>
        </div>
        {facts.length === 0 ? (
          <div className="small muted mt-8">No specification recorded for this line yet.</div>
        ) : (
          <div className={cx('facts', compact && 'compact')}>
            {facts.map(([k, l, unit]) => (
              <div key={k}><small>{l}</small><strong>{item[k]}{unit ? ` ${unit}` : ''}</strong></div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
