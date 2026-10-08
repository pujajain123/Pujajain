import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ClipboardList, Factory, FileSpreadsheet, Boxes, Truck, BarChart3, Users, History, Bell, Settings, Search,
  LogOut, Menu, Hammer, Package, User as UserIcon,
} from 'lucide-react';
import { useAuth, useUnreadSync } from '../lib/auth';
import { useLive, useApi } from '../lib/live';
import { api } from '../lib/api';
import { Avatar, StageChip, cx } from './ui';
import { DEMO } from '../lib/env';

type NavItem = { to: string; label: string; icon: ReactNode; count?: number; alert?: boolean; end?: boolean };

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { connected } = useLive();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useUnreadSync();
  useEffect(() => setOpen(false), [loc.pathname]);
  const admin = user?.role === 'admin';
  const counts = useApi<Record<string, number>>(admin ? '/orders/stage-counts' : null, ['orders']).data;

  const adminNav: (NavItem | string)[] = [
    'Operations',
    { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={17} />, end: true },
    { to: '/orders', label: 'Orders', icon: <ClipboardList size={17} />, count: counts?.active },
    { to: '/production', label: 'Production', icon: <Factory size={17} /> },
    { to: '/jobs', label: 'Job Sheets', icon: <FileSpreadsheet size={17} /> },
    { to: '/inventory', label: 'Inventory', icon: <Boxes size={17} /> },
    { to: '/dispatch', label: 'Dispatch', icon: <Truck size={17} />, count: counts?.ready_for_dispatch || undefined },
    'Insight',
    { to: '/reports', label: 'Reports', icon: <BarChart3 size={17} /> },
    { to: '/activity', label: 'Activity Log', icon: <History size={17} /> },
    { to: '/notifications', label: 'Notifications', icon: <Bell size={17} />, count: user?.unread || undefined, alert: true },
    'Admin',
    { to: '/staff', label: 'Staff', icon: <Users size={17} /> },
    { to: '/settings', label: 'Settings', icon: <Settings size={17} /> },
  ];
  const staffNav: (NavItem | string)[] = [
    'My work',
    { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={17} />, end: true },
    { to: '/my-jobs', label: 'My Jobs', icon: <Hammer size={17} /> },
    { to: '/notifications', label: 'Notifications', icon: <Bell size={17} />, count: user?.unread || undefined, alert: true },
    'Reference',
    { to: '/orders', label: 'Orders', icon: <ClipboardList size={17} /> },
    { to: '/jobs', label: 'Job Sheets', icon: <FileSpreadsheet size={17} /> },
    { to: '/inventory', label: 'Materials', icon: <Package size={17} /> },
  ];

  return (
    <div className={cx('shell', open && 'nav-open')}>
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          <div className="brand-mark">U</div>
          <div>
            <div className="brand-name">Umami Studios</div>
            <div className="brand-sub">Operations</div>
          </div>
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
        <div className="sidebar-foot">
          <Avatar name={user?.name} />
          <div className="grow">
            <div style={{ color: '#fff', fontWeight: 600, fontSize: 13 }} className="truncate">{user?.name}</div>
            <div style={{ fontSize: 11.5, color: '#8d9097' }}>{admin ? 'Admin' : 'Staff'}</div>
          </div>
          <button className="btn ghost icon-btn sm" style={{ color: '#c9cbd0' }} onClick={logout} title="Sign out" aria-label="Sign out">
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {open && <div className="overlay" style={{ zIndex: 55 }} onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon-btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu size={18} />
          </button>
          <GlobalSearch />
          {DEMO && (
            <span className="row small hide-sm" style={{ marginLeft: 'auto' }}>
              <span className="chip info">Demo</span>
              <span className="muted">Data is saved in this browser only</span>
              <button className="btn ghost sm" onClick={() => (window as any).__umamiReset?.()}>Reset demo data</button>
            </span>
          )}
          <div className="row" style={{ marginLeft: DEMO ? 0 : 'auto' }}>
            <span className="row small muted" title={connected ? 'Live updates connected' : 'Reconnecting…'}>
              <span className={cx('live-dot', !connected && 'off')} />
              <span className="hide-sm">{connected ? 'Live' : 'Offline'}</span>
            </span>
            <NavLink to="/notifications" className="btn ghost icon-btn" style={{ position: 'relative' }} aria-label="Notifications">
              <Bell size={18} />
              {!!user?.unread && <span className="badge-dot" style={{ position: 'absolute', top: 6, right: 7 }} />}
            </NavLink>
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
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
        placeholder="Search orders, clients, job sheets, staff, materials…"
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
      <kbd>/</kbd>
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
