import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/live';
import { useMeta } from '../lib/meta';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Alert, Avatar, Card, Chip, ErrorState, Field, Input, Loading, Modal, Select, useAction } from '../components/ui';

export function Staff() {
  const { data, error, reload } = useApi<any[]>('/users', ['staff', 'jobs']);
  const [edit, setEdit] = useState<any | null>(null);
  const nav = useNavigate();
  if (error) return <ErrorState error={error} retry={reload} />;
  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">Workspace</div><h1>Staff</h1><div className="sub">People, roles and who works on which process.</div></div>
        <button className="btn accent" onClick={() => setEdit({})}><Plus size={14} /> Add user</button>
      </div>
      {!data ? <Loading rows={6} h={44} /> : (
        <Card pad={false}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th>Primary process</th><th>Contact</th><th className="num">Open jobs</th><th>Since</th><th>Status</th><th /></tr></thead>
              <tbody>
                {data.map((u) => (
                  <tr key={u.id} style={u.active ? undefined : { opacity: 0.55 }}>
                    <td><span className="row"><Avatar name={u.name} sm light /><span className="strong">{u.name}</span></span></td>
                    <td><Chip tone={u.role === 'admin' ? 'violet' : ''}>{u.role === 'admin' ? 'Admin' : 'Staff'}</Chip></td>
                    <td>{u.process ?? <span className="muted">—</span>}</td>
                    <td className="small">{u.email}<div className="cell-sub">{u.phone}</div></td>
                    <td className="num">{u.open_jobs ? <button className="btn ghost sm" onClick={() => nav(`/jobs?staff=${u.id}`)}>{u.open_jobs}</button> : <span className="faint">0</span>}</td>
                    <td className="small muted">{fmtDate(u.created_at)}</td>
                    <td>{u.active ? <Chip tone="ok">Active</Chip> : <Chip>Inactive</Chip>}</td>
                    <td className="right"><button className="btn sm" onClick={() => setEdit(u)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {edit && <UserModal user={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function UserModal({ user, onClose }: { user: any; onClose: () => void }) {
  const meta = useMeta();
  const me = useAuth().user!;
  const isNew = !user.id;
  const [f, setF] = useState<any>({ name: user.name ?? '', email: user.email ?? '', phone: user.phone ?? '', role: user.role ?? 'staff', primary_process_id: user.primary_process_id ?? '', password: '', active: user.active === undefined ? true : !!user.active });
  const { run, busy, fields, error } = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = () => {
    const body: any = { name: f.name, email: f.email, phone: f.phone || null, role: f.role, primary_process_id: f.primary_process_id ? Number(f.primary_process_id) : null };
    if (f.password) body.password = f.password;
    if (!isNew) body.active = f.active;
    return run(() => (isNew ? api.post('/users', body) : api.patch(`/users/${user.id}`, body)), 'User saved').then((r) => r && onClose());
  };
  return (
    <Modal title={isNew ? 'Add user' : `Edit ${user.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      {error && !Object.keys(fields).length && <Alert tone="bad">{error}</Alert>}
      <div className="form-grid mt-8">
        <Field label="Name" error={fields.name}><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Email" error={fields.email}><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Role"><Select value={f.role} onChange={set('role')} disabled={user.id === me.id}><option value="staff">Staff</option><option value="admin">Admin</option></Select></Field>
        <Field label="Primary process"><Select value={f.primary_process_id} onChange={set('primary_process_id')}><option value="">None (QC / dispatch / office)</option>{meta.processes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label={isNew ? 'Password' : 'Reset password'} error={fields.password} hint="At least 8 characters"><Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        {!isNew && user.id !== me.id && <label className="check full"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active — inactive users can’t sign in (history is kept)</label>}
      </div>
    </Modal>
  );
}
