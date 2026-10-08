import { useState } from 'react';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { Field, Modal, Select, Textarea, useAction } from '../components/ui';

/** Staff quick action: add a note to one of their orders’ timelines. */
export function QuickNoteModal({ onClose }: { onClose: () => void }) {
  const jobs = useApi<any[]>('/jobs?mine=1&status=open', ['jobs']).data ?? [];
  const orders = [...new Map(jobs.map((j) => [j.order_id, j])).values()];
  const [orderId, setOrderId] = useState('');
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  return (
    <Modal title="Add a note" sub="Visible on the order’s activity timeline." onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !orderId || !note.trim()} onClick={() => run(() => api.post(`/orders/${orderId}/notes`, { note }), 'Note added').then((r) => r && onClose())}>Add note</button></>}>
      <div className="col gap-12">
        <Field label="Order">
          <Select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">Select…</option>
            {orders.map((o) => <option key={o.order_id} value={o.order_id}>{o.order_code} — {o.customer}</option>)}
          </Select>
        </Field>
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
      </div>
    </Modal>
  );
}
