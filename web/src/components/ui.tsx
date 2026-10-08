import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, Inbox, X, XCircle } from 'lucide-react';
import { JOB_STATUS_LABELS, RISK_LABELS, type DeadlineRisk } from '../../../shared/domain';
import { initials, JOB_TONE, PRIORITY_TONE, RISK_TONE, STAGE_TONE, cap } from '../lib/format';
import { useStageLabel } from '../lib/meta';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Chip({ tone = '', children, dot, lg, title }: { tone?: string; children: ReactNode; dot?: boolean; lg?: boolean; title?: string }) {
  return (
    <span className={cx('chip', tone, lg && 'lg')} title={title}>
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function StageChip({ stage, onHold, cancelled, lg }: { stage: string; onHold?: boolean; cancelled?: boolean; lg?: boolean }) {
  const label = useStageLabel();
  if (cancelled) return <Chip tone="bad" dot lg={lg}>Cancelled</Chip>;
  return (
    <span className="row gap-4">
      <Chip tone={STAGE_TONE[stage]} dot lg={lg}>{label(stage)}</Chip>
      {onHold && <Chip tone="warn" lg={lg}>On hold</Chip>}
    </span>
  );
}

export const RiskChip = ({ risk, text }: { risk: DeadlineRisk; text?: string }) => (
  <Chip tone={RISK_TONE[risk]} dot>{text ?? RISK_LABELS[risk]}</Chip>
);
export const JobStatusChip = ({ status, overdue }: { status: string; overdue?: boolean }) => (
  <span className="row gap-4">
    <Chip tone={JOB_TONE[status]} dot>{JOB_STATUS_LABELS[status as keyof typeof JOB_STATUS_LABELS] ?? status}</Chip>
    {overdue && status !== 'delayed' && <Chip tone="bad">Past due</Chip>}
  </span>
);
export const PriorityChip = ({ p }: { p: string }) => (p === 'normal' ? <span className="muted small">Normal</span> : <Chip tone={PRIORITY_TONE[p]}>{cap(p)}</Chip>);

export function Progress({ value, tone, lg, label }: { value: number; tone?: string; lg?: boolean; label?: ReactNode }) {
  const t = tone ?? (value >= 100 ? 'ok' : '');
  return (
    <div>
      {label && <div className="progress-label">{label}</div>}
      <div className={cx('progress', t, lg && 'lg')} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

export function Avatar({ name, sm, light }: { name?: string | null; sm?: boolean; light?: boolean }) {
  return (
    <span className={cx('avatar', sm && 'sm', light && 'light')} title={name ?? 'System'} aria-hidden>
      {name ? initials(name) : '⚙'}
    </span>
  );
}

export function Card({ title, actions, children, pad, footer, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; footer?: ReactNode; className?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={pad === false ? '' : 'card-body'}>{children}</div>
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={28} />}
      <div className="t">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Loading({ rows = 3, h = 56 }: { rows?: number; h?: number }) {
  return (
    <div className="col" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: h }} />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="alert bad">
      <XCircle size={16} />
      <div className="grow">
        <div className="strong">Couldn’t load this</div>
        <div className="small">{error.message}</div>
      </div>
      {retry && (
        <button className="btn sm" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Alert({ tone, children, title }: { tone: 'bad' | 'warn' | 'notice' | 'info' | 'ok'; children?: ReactNode; title?: ReactNode }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div className={cx('alert', tone)} role={tone === 'bad' ? 'alert' : undefined}>
      <Icon size={16} />
      <div className="grow">
        {title && <div className="strong">{title}</div>}
        {children && <div className={title ? 'small' : ''}>{children}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: ReactNode; count?: number; tone?: string }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.key} role="tab" aria-selected={value === it.key} className={cx('tab', value === it.key && 'active')} onClick={() => onChange(it.key)}>
          {it.label}
          {it.count !== undefined && (
            <span className="pill-count" style={it.tone && it.count ? { background: `var(--${it.tone}-soft)`, color: `var(--${it.tone})` } : undefined}>
              {it.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: ReactNode }[] }) {
  return (
    <div className="seg">
      {items.map((i) => (
        <button key={i.key} className={cx(value === i.key && 'on')} onClick={() => onChange(i.key)} type="button">
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ── Forms ──
export function Field({ label, error, hint, children, className }: { label?: ReactNode; error?: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('field', className)}>
      {label && <label>{label}</label>}
      {children}
      {error ? <div className="err">{error}</div> : hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
export const Input = ({ invalid, className, ...p }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) => <input className={cx('input', invalid && 'invalid', className)} {...p} />;
export const Select = ({ invalid, className, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) => <select className={cx('select', invalid && 'invalid', className)} {...p} />;
export const Textarea = ({ invalid, className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) => (
  <textarea className={cx('textarea', invalid && 'invalid', className)} {...p} />
);

// ── Overlays ──
export function Modal({ title, sub, onClose, children, footer, wide }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'wide')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {sub && <div className="muted small mt-8" style={{ marginTop: 3 }}>{sub}</div>}
          </div>
          <button className="btn ghost icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          <button className="btn ghost icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="card-body" style={{ overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
        {footer && <div className="modal-foot" style={{ borderRadius: 0 }}>{footer}</div>}
      </aside>
    </div>
  );
}

// ── Toasts ──
type Toast = { id: number; msg: string; tone?: 'error' };
const ToastCtx = createContext<(msg: string, tone?: 'error') => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((msg: string, tone?: 'error') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', t.tone)}>
            {t.tone === 'error' ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wrap an async action with busy state, toast feedback and field errors. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      setFields({});
      try {
        const out = await fn();
        if (success) toast(success);
        return out;
      } catch (e: any) {
        setError(e.message);
        setFields(e.fields ?? {});
        if (!e.fields) toast(e.message, 'error');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run, fields, error, setError };
}

export function Kpi({ label, value, foot, tone, icon, to }: { label: string; value: ReactNode; foot?: ReactNode; tone?: 'alert' | 'warn'; icon?: ReactNode; to?: string }) {
  const body = (
    <>
      <div className="kpi-label">
        <span>{label}</span>
        {icon && <span className="kpi-icon">{icon}</span>}
      </div>
      <div className="kpi-value">{value}</div>
      {foot && <div className="kpi-foot">{foot}</div>}
    </>
  );
  return to ? (
    <Link to={to} className={cx('card kpi', tone)}>
      {body}
    </Link>
  ) : (
    <div className={cx('card kpi', tone)}>{body}</div>
  );
}

/** Page title block: eyebrow, title, one-line description, primary action. */
export function PageHead({ eyebrow, title, sub, actions }: { eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

/** Card with a title + description header, as used across dashboards. */
export function Panel({ title, sub, action, children, className, flush }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={cx('card', className)}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {sub && <div className="sub">{sub}</div>}
        </div>
        {action}
      </div>
      <div className={flush ? '' : 'card-body'} style={flush ? { paddingTop: 10 } : undefined}>{children}</div>
    </section>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}
