import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { Alert, Field, Input } from '../components/ui';

const FLOW = ['Order Received', 'Being Prepared', 'In Production', 'Quality Check', 'Ready for Dispatch', 'Dispatched', 'Completed'];

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark">U</div>
          <div>
            <div className="brand-name">Umami Studios</div>
            <div className="brand-sub">Operations platform</div>
          </div>
        </div>
        <div>
          <h1 style={{ fontSize: 34, lineHeight: 1.15, maxWidth: 460 }}>Every order has a lifecycle. See all of it in one place.</h1>
          <div className="login-flow">
            {FLOW.map((s, i) => (
              <div key={s}>
                <div className={`lf ${i === 2 ? 'on' : ''}`}>
                  <span className="d" />
                  {s}
                  {i === 2 && <span style={{ color: '#8d9097', fontWeight: 400 }}>· Iron ✓ · Rope 70% · Fabric —</span>}
                </div>
                {i < FLOW.length - 1 && <div className="bar" />}
              </div>
            ))}
          </div>
        </div>
        <div style={{ color: '#6f7279', fontSize: 12.5 }}>Orders · Job sheets · Inventory · Dispatch · Audit history</div>
      </div>
      <div className="login-form">
        <form onSubmit={submit} noValidate>
          <div>
            <h1>Sign in</h1>
            <div className="muted mt-8">Use your Umami Studios account.</div>
          </div>
          {error && <Alert tone="bad">{error}</Alert>}
          <Field label="Email">
            <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button className="btn primary lg block" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="card card-pad small" style={{ background: 'var(--surface-2)' }}>
            <div className="strong">Demo accounts</div>
            <div className="muted mt-8">Password for all: <span className="mono">umami123</span></div>
            <div className="row wrap mt-8">
              {[
                ['admin@umami.studio', 'Admin'],
                ['amit@umami.studio', 'Amit · Rope'],
                ['rahul@umami.studio', 'Rahul · Iron'],
                ['neha@umami.studio', 'Neha · Fabric'],
              ].map(([e, l]) => (
                <button type="button" key={e} className="btn sm" onClick={() => (setEmail(e), setPassword('umami123'))}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
