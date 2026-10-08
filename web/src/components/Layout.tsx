import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ClipboardList, Factory, FileSpreadsheet, Boxes, Truck, BarChart3, Users, History, Bell, Settings, Search,
  LogOut, Menu, Hammer, Package, User as UserIcon, ChevronDown, ArrowUpRight, RotateCcw,
} from 'lucide-react';
import { useAuth, useUnreadSync } from '../lib/auth';
import { useApi } from '../lib/live';
import { useMeta } from '../lib/meta';
import { api } from '../lib/api';
import { Avatar, StageChip, cx } from './ui';
import { DEMO } from '../lib/env';

type NavItem = { to: string; label: string; icon: ReactNode; count?: number; alert?: boolean; end?: boolean };

const PAGE_NAMES: [RegExp, string][] = [
  [/^\/$/, 'Dashboard'],
  [/^\/orders\/new/, 'New order'],
  [/^\/orders\/\d+/, 'Order'],
  [/^\/orders/, 'Orders'],
  [/^\/production/, 'Master production'],
  [/^\/my-jobs/, 'My jobs'],
  [/^\/jobs\/\d+/, 'Job sheet'],
  [/^\/jobs/, 'Job sheets'],
  [/^\/inventory/, 'Inventory'],
  [/^\/dispatch/, 'Dispatch'],
  [/^\/reports/, 'Reports'],
  [/^\/activity/, 'Activity log'],
  [/^\/notifications/, 'Notifications'],
  [/^\/staff/, 'Staff'],
  [/^\/settings/, 'Settings'],
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const today = useMeta().today;
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useUnreadSync();
  useEffect(() => setOpen(false), [loc.pathname]);
  const admin = user?.role === 'admin';
  const counts = useApi<Record<string, number>>(admin ? '/orders/stage-counts' : null, ['orders']).data;
  const myJobs = useApi<any[]>(!admin ? '/jobs?mine=1&status=open' : null, ['jobs']).data;
  const page = PAGE_NAMES.find(([re]) => re.test(loc.pathname))?.[1] ?? '';
  const I = 18;

  const adminNav: (NavItem | string)[] = [
    'Overview',
    { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={I} />, end: true },
    { to: '/orders', label: 'Orders', icon: <ClipboardList size={I} />, count: counts?.active },
    { to: '/production', label: 'Master production', icon: <Factory size={I} /> },
    { to: '/jobs', label: 'Job sheets', icon: <FileSpreadsheet size={I} /> },
    'Operations',
    { to: '/inventory', label: 'Inventory', icon: <Boxes size={I} /> },
    { to: '/dispatch', label: 'Dispatch', icon: <Truck size={I} />, count: counts?.ready_for_dispatch || undefined },
    { to: '/reports', label: 'Reports', icon: <BarChart3 size={I} /> },
    { to: '/notifications', label: 'Notifications', icon: <Bell size={I} />, count: user?.unread || undefined, alert: true },
    'Workspace',
    { to: '/staff', label: 'Staff', icon: <Users size={I} /> },
    { to: '/activity', label: 'Activity log', icon: <History size={I} /> },
    { to: '/settings', label: 'Settings', icon: <Settings size={I} /> },
  ];
  const staffNav: (NavItem | string)[] = [
    'Overview',
    { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={I} />, end: true },
    { to: '/my-jobs', label: 'My jobs', icon: <Hammer size={I} />, count: myJobs?.length || undefined },
    { to: '/orders', label: 'Orders', icon: <ClipboardList size={I} /> },
    { to: '/jobs', label: 'Job sheets', icon: <FileSpreadsheet size={I} /> },
    'Operations',
    { to: '/inventory', label: 'Inventory', icon: <Package size={I} /> },
    { to: '/notifications', label: 'Notifications', icon: <Bell size={I} />, count: user?.unread || undefined, alert: true },
  ];

  return (
    <div className={cx('shell', open && 'nav-open')}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">u</div>
          <div>
            <div className="brand-name">umami</div>
            <div className="brand-sub">Studios · Operations</div>
          </div>
        </div>
        <div className="workspace-box">
          <div className="eyebrow">Workspace</div>
          <div className="name">Umami Studios</div>
        </div>
        {(admin ? adminNav : staffNav).map((n, i) =>
          typeof n === 'string' ? (
            <div key={i} className="nav-section">{n}</div>
          ) : (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('nav-link', isActive && 'active')}>
              {n.icon}
              {n.label}
              {!!n.count && <span className={cx('count', n.alert && 'alert')}>{n.count}</span>}
            </NavLink>
          ),
        )}
        <div className="help-card" style={{ marginTop: 24 }}>
          <span className="q">?</span>
          <div className="strong">Need a hand?</div>
          <div className="small muted">{admin ? 'Every order moves through 9 stages. Click a stage in the pipeline to see its orders.' : 'Open a job sheet, enter what you finished today and press Save update. Everything else updates itself.'}</div>
          <a className="link" href="https://github.com/pujajain123/Pujajain#readme" target="_blank" rel="noreferrer">Open guide <ArrowUpRight size={14} /></a>
        </div>
        <div className="sidebar-foot">
          <Avatar name={user?.name} />
          <div className="grow">
            <div className="strong truncate" style={{ color: 'var(--ink)' }}>{user?.name}</div>
            <div className="small muted">{admin ? 'Administrator' : 'Staff'}</div>
          </div>
          {DEMO ? <SwitchView /> : (
            <button className="btn ghost icon-btn sm" onClick={logout} title="Sign out" aria-label="Sign out"><LogOut size={16} /></button>
          )}
        </div>
      </aside>
      {open && <div className="overlay" style={{ zIndex: 55 }} onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={18} /></button>
          <div className="trail"><span>Umami Studios</span><span>/</span><b>{page}</b></div>
          <div className="row" style={{ marginLeft: 'auto', flex: 1, justifyContent: 'flex-end', gap: 14 }}>
            <GlobalSearch />
            {DEMO && (
              <button className="btn ghost sm hide-sm" onClick={() => (window as any).__umamiReset?.()} title="Put the sample data back">
                <RotateCcw size={14} /> Reset demo
              </button>
            )}
            <NavLink to="/notifications" className="btn ghost icon-btn" style={{ position: 'relative' }} aria-label="Notifications">
              <Bell size={19} />
              {!!user?.unread && <span className="badge-dot" style={{ position: 'absolute', top: 7, right: 8 }} />}
            </NavLink>
            <span className="hide-sm muted" style={{ borderLeft: '1px solid var(--line)', paddingLeft: 16, whiteSpace: 'nowrap' }}>
              {new Date(today + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}

const DEMO_USERS = [
  ['admin@umami.studio', 'Admin'],
  ['amit@umami.studio', 'Amit · Rope'],
  ['rahul@umami.studio', 'Rahul · Iron'],
  ['neha@umami.studio', 'Neha · Fabric'],
  ['vikram@umami.studio', 'Vikram · QC'],
];

/** Demo only: switch between admin and staff views without signing in. */
function SwitchView() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  return (
    <label className="link" style={{ position: 'relative', fontSize: 12.5, cursor: 'pointer' }}>
      Switch view <ChevronDown size={13} />
      <select
        aria-label="Switch view"
        value={user?.email}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
        onChange={async (e) => {
          await login(e.target.value, 'umami123');
          nav('/');
        }}
      >
        {DEMO_USERS.map(([email, label]) => (
          <option key={email} value={email}>{label}</option>
        ))}
      </select>
    </label>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) return setRes(null);
    const t = setTimeout(() => api.get(`/search?q=${encodeURIComponent(q.trim())}`).then(setRes).catch(() => {}), 160);
    return () => clearTimeout(t);
  }, [q]);
  const items: { key: string; to: string; node: ReactNode; group: string }[] = [];
  if (res) {
    for (const o of res.orders)
      items.push({
        key: 'o' + o.id, group: 'Orders', to: `/orders/${o.id}`,
        node: (<><span className="mono strong">{o.code}</span><span className="grow truncate">{o.customer} <span className="muted">· {o.product}</span></span><StageChip stage={o.stage} /></>),
      });
    for (const j of res.jobs)
      items.push({
        key: 'j' + j.id, group: 'Job sheets', to: `/jobs/${j.id}`,
        node: (<><span className="mono strong">{j.code}</span><span className="grow truncate">{j.process_name} · {j.order_code} <span className="muted">· {j.assignee ?? 'Unassigned'}</span></span></>),
      });
    for (const m of res.materials)
      items.push({ key: 'm' + m.id, group: 'Materials', to: `/inventory/${m.id}`, node: (<><Package size={15} className="muted" /><span className="grow truncate">{m.name}</span><span className="mono muted">{m.code}</span></>) });
    for (const c of res.customers)
      items.push({ key: 'c' + c.id, group: 'Clients', to: `/orders?customer=${c.id}`, node: (<><UserIcon size={15} className="muted" /><span className="grow">{c.name}</span><span className="muted small">{c.city}</span></>) });
    for (const s of res.staff)
      items.push({ key: 's' + s.id, group: 'Staff', to: `/jobs?staff=${s.id}`, node: (<><Avatar name={s.name} sm light /><span className="grow">{s.name}</span><span className="muted small">{s.role}</span></>) });
  }
  const go = (to: string) => {
    nav(to);
    setOpen(false);
    setQ('');
    ref.current?.blur();
  };
  let lastGroup = '';
  return (
    <div className="search">
      <Search size={16} />
      <input
        ref={ref}
        value={q}
        placeholder="Search orders, jobs, materials…"
        onChange={(e) => (setQ(e.target.value), setOpen(true), setSel(0))}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
          if (e.key === 'Enter' && items[sel]) go(items[sel].to);
          if (e.key === 'Escape') ref.current?.blur();
        }}
        aria-label="Global search"
      />
      <kbd>⌘ K</kbd>
      {open && res && (
        <div className="search-pop">
          {items.length === 0 && <div className="empty small">No matches for “{q}”</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : null;
            return (
              <div key={it.key}>
                {head && <div className="search-group upper">{head}</div>}
                <div className={cx('search-item', i === sel && 'sel')} onMouseDown={() => go(it.to)} onMouseEnter={() => setSel(i)}>
                  {it.node}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
