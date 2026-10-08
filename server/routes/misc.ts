import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, run, tx } from '../db.ts';
import { ORDER_STAGES, ROLES, daysBetween } from '../../shared/domain.ts';
import { addDays, badRequest, conflict, h, HttpError, intId, notFound, parse, round, today } from '../lib.ts';
import { createSession, destroySession, hashPassword, requireAuth, requireRole, sessionToken, setSessionCookie, verifyPassword } from '../auth.ts';
import { broadcast, subscribe } from '../live.ts';
import { orderSummaries } from '../services/orders.ts';
import { listJobs } from '../services/jobs.ts';
import { stock } from '../services/inventory.ts';
import { logActivity, logFieldChanges } from '../services/activity.ts';

// ───────────────────────────── Auth ─────────────────────────────
export const authRouter = Router();
const attempts = new Map<string, { n: number; until: number }>();

authRouter.post(
  '/login',
  h((req, res) => {
    const { email, password } = parse(z.object({ email: z.string().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') }), req.body);
    const key = `${req.ip}:${email.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.n >= 5 && a.until > Date.now()) throw new HttpError(429, 'Too many attempts — try again in a few minutes');
    const u = get(`SELECT u.*, r.key AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.email=?`, email);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      attempts.set(key, { n: (a?.n ?? 0) + 1, until: Date.now() + 5 * 60_000 });
      throw new HttpError(401, 'Email or password is incorrect');
    }
    attempts.delete(key);
    setSessionCookie(res, createSession(u.id));
    logActivity({ actorId: u.id, entityType: 'user', entityId: u.id, action: 'login', message: `${u.name} signed in` });
    return { id: u.id, name: u.name, email: u.email, role: u.role };
  }),
);

authRouter.post(
  '/logout',
  h((req, res) => {
    const t = sessionToken(req);
    if (t) destroySession(t);
    setSessionCookie(res, null);
    return { ok: true };
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  h((req) => ({ ...req.user, unread: get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL', req.user!.id)!.n })),
);

// ───────────────────────────── Everything else (authenticated) ─────────────────────────────
export const miscRouter = Router();

miscRouter.get('/events', (req, res) => subscribe(res, req.user!.id));

/** Reference data for forms and labels. */
miscRouter.get(
  '/meta',
  h(() => ({
    today: today(),
    stages: all('SELECT * FROM order_stages ORDER BY sequence'),
    processes: all('SELECT * FROM job_processes WHERE active=1 ORDER BY sequence').map((p) => ({ ...p, fields: JSON.parse(p.fields_json || '[]') })),
    products: all('SELECT * FROM products WHERE active=1 ORDER BY name').map((p) => ({
      ...p,
      processes: all('SELECT process_id, material_per_unit FROM product_processes WHERE product_id=?', p.id),
    })),
    customers: all('SELECT * FROM customers ORDER BY name'),
    staff: all(`SELECT u.id, u.name, u.email, u.phone, r.key AS role, u.primary_process_id, u.active FROM users u JOIN roles r ON r.id=u.role_id ORDER BY r.key, u.name`),
    materials: all('SELECT * FROM materials WHERE active=1 ORDER BY category, name'),
    settings: Object.fromEntries(all('SELECT key, value FROM settings').map((s) => [s.key, s.value])),
  })),
);

// ───────────── Dashboards ─────────────
miscRouter.get(
  '/dashboard',
  requireRole('admin'),
  h(() => {
    const t = today();
    const orders = orderSummaries();
    const active = orders.filter((o) => o.stage !== 'completed');
    const notDispatched = active.filter((o) => !['dispatched'].includes(o.stage));
    const stock_ = stock();
    const counts: Record<string, number> = {};
    for (const s of ORDER_STAGES) counts[s] = orders.filter((o) => o.stage === s).length;
    const shortageOrders = active.filter((o) => o.shortage);
    const lowStock = stock_.filter((s) => s.low_stock);
    const recent = all(
      `SELECT a.*, u.name AS actor, o.code AS order_code FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN orders o ON o.id = a.order_id
       WHERE a.action NOT IN ('login') ORDER BY a.id DESC LIMIT 25`,
    );
    const workload = all(
      `SELECT u.id, u.name, p.name AS process,
         SUM(CASE WHEN j.status != 'completed' THEN 1 ELSE 0 END) AS open_jobs,
         SUM(CASE WHEN j.status != 'completed' THEN j.quantity - j.completed_qty ELSE 0 END) AS open_units,
         SUM(CASE WHEN j.status != 'completed' AND j.due_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN job_processes p ON p.id = u.primary_process_id
       LEFT JOIN jobs j ON j.assigned_to = u.id AND j.order_id IN (SELECT id FROM orders WHERE cancelled_at IS NULL)
       WHERE r.key = 'staff' AND u.active = 1 GROUP BY u.id ORDER BY open_units DESC`,
      t,
    );
    const processLoad = all(
      `SELECT p.key, p.name, COUNT(j.id) AS jobs, SUM(j.quantity) AS units, SUM(j.completed_qty) AS done,
         SUM(CASE WHEN j.status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN j.status != 'completed' AND j.due_date < ? THEN 1 ELSE 0 END) AS overdue
       FROM job_processes p LEFT JOIN jobs j ON j.process_id = p.id
         AND j.order_id IN (SELECT id FROM orders WHERE cancelled_at IS NULL AND stage IN ('preparing','ready_for_production','in_production'))
       GROUP BY p.id ORDER BY p.sequence`,
      t,
    );
    return {
      today: t,
      kpis: {
        active: active.length,
        preparing: counts.preparing + counts.received + counts.reviewed,
        in_production: counts.ready_for_production + counts.in_production,
        quality_check: counts.quality_check,
        ready_for_dispatch: counts.ready_for_dispatch,
        dispatched: counts.dispatched,
        delayed: active.filter((o) => o.delayed).length,
        shortages: shortageOrders.length,
        due_today: notDispatched.filter((o) => o.deadline === t).length,
        due_week: notDispatched.filter((o) => o.days_left >= 0 && o.days_left <= 7).length,
        on_hold: active.filter((o) => o.on_hold).length,
        low_stock: lowStock.length,
      },
      pipeline: counts,
      attention: {
        overdue: notDispatched.filter((o) => o.risk === 'overdue'),
        at_risk: notDispatched.filter((o) => o.risk === 'at_risk'),
        due_today: notDispatched.filter((o) => o.deadline === t),
        shortages: shortageOrders,
        on_hold: active.filter((o) => o.on_hold),
        delayed_jobs: listJobs({ due: 'overdue' }).concat(listJobs({ status: 'delayed' })).filter((j, i, a) => a.findIndex((x) => x.id === j.id) === i),
      },
      low_stock: lowStock,
      inventory: stock_,
      workload,
      process_load: processLoad,
      recent,
    };
  }),
);

miscRouter.get(
  '/dashboard/staff',
  h((req) => {
    const t = today();
    const uid = req.user!.id;
    const mine = listJobs({ staff: uid, includeClosed: true });
    const open = mine.filter((j) => j.status !== 'completed');
    return {
      today: t,
      today_jobs: open.filter((j) => (j.start_date ?? t) <= t && (j.due_date ?? j.order_deadline) >= t),
      upcoming: open.filter((j) => j.start_date && j.start_date > t),
      delayed: open.filter((j) => j.overdue || j.status === 'delayed'),
      in_progress: open.filter((j) => j.status === 'in_progress'),
      completed: mine.filter((j) => j.status === 'completed').slice(0, 15),
      counts: {
        open: open.length,
        units_left: open.reduce((s, j) => s + (j.quantity - j.completed_qty), 0),
        delayed: open.filter((j) => j.overdue || j.status === 'delayed').length,
        completed_week: mine.filter((j) => j.status === 'completed').length,
      },
      recent: all(
        `SELECT a.*, o.code AS order_code FROM activity_logs a LEFT JOIN orders o ON o.id=a.order_id WHERE a.actor_id = ? AND a.action != 'login' ORDER BY a.id DESC LIMIT 10`,
        uid,
      ),
      // Orders waiting for quality check that this person worked on (QC staff without a process see all of them).
      qc: all(
        `SELECT o.id, o.code, c.name AS customer, (SELECT GROUP_CONCAT(p.name, ', ') FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=o.id) AS product,
           (SELECT SUM(quantity) FROM order_items WHERE order_id=o.id) AS quantity, o.deadline
         FROM orders o JOIN customers c ON c.id=o.customer_id
         WHERE o.stage='quality_check' AND o.cancelled_at IS NULL
           AND ((SELECT primary_process_id FROM users WHERE id=?) IS NULL OR EXISTS (SELECT 1 FROM jobs j WHERE j.order_id=o.id AND j.assigned_to=?))
         ORDER BY o.deadline`,
        uid,
        uid,
      ),
    };
  }),
);

// ───────────── Search ─────────────
miscRouter.get(
  '/search',
  h((req) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return { orders: [], jobs: [], materials: [], staff: [], customers: [] };
    const like = `%${q}%`;
    return {
      orders: all(
        `SELECT DISTINCT o.id, o.code, o.stage, o.deadline, c.name AS customer,
           (SELECT GROUP_CONCAT(p.name, ', ') FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=o.id) AS product
         FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items i ON i.order_id=o.id LEFT JOIN products p ON p.id=i.product_id
         WHERE o.code LIKE ? OR c.name LIKE ? OR p.name LIKE ? OR o.po_number LIKE ? ORDER BY o.id DESC LIMIT 8`,
        like, like, like, like,
      ),
      jobs: all(
        `SELECT j.id, j.code, j.status, jp.name AS process_name, o.code AS order_code, u.name AS assignee FROM jobs j
         JOIN job_processes jp ON jp.id=j.process_id JOIN orders o ON o.id=j.order_id LEFT JOIN users u ON u.id=j.assigned_to
         WHERE j.code LIKE ? OR o.code LIKE ? OR u.name LIKE ? OR jp.name LIKE ? ORDER BY j.id DESC LIMIT 8`,
        like, like, like, like,
      ),
      materials: all(`SELECT id, code, name, category, unit FROM materials WHERE name LIKE ? OR code LIKE ? OR color LIKE ? OR variant LIKE ? LIMIT 6`, like, like, like, like),
      staff: all(`SELECT u.id, u.name, r.key AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.name LIKE ? OR u.email LIKE ? LIMIT 5`, like, like),
      customers: all(`SELECT id, name, city FROM customers WHERE name LIKE ? OR contact_person LIKE ? LIMIT 5`, like, like),
    };
  }),
);

// ───────────── Notifications ─────────────
miscRouter.get(
  '/notifications',
  h((req) => {
    const filter = req.query.filter === 'unread' ? 'AND read_at IS NULL' : '';
    return all(`SELECT * FROM notifications WHERE user_id=? ${filter} ORDER BY id DESC LIMIT 200`, req.user!.id);
  }),
);
miscRouter.post(
  '/notifications/:id/read',
  h((req) => {
    run(`UPDATE notifications SET read_at=COALESCE(read_at, ?) WHERE id=? AND user_id=?`, new Date().toISOString(), intId(req.params.id), req.user!.id);
    broadcast('notifications');
    return { ok: true };
  }),
);
miscRouter.post(
  '/notifications/read-all',
  h((req) => {
    run(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL`, new Date().toISOString(), req.user!.id);
    broadcast('notifications');
    return { ok: true };
  }),
);

// ───────────── Activity log ─────────────
miscRouter.get(
  '/activity',
  requireRole('admin'),
  h((req) => {
    const q = req.query as Record<string, string | undefined>;
    const where = ['1=1'];
    const p: any[] = [];
    if (q.order) (where.push('a.order_id = ?'), p.push(Number(q.order)));
    if (q.actor === 'system') where.push('a.actor_id IS NULL');
    else if (q.actor) (where.push('a.actor_id = ?'), p.push(Number(q.actor)));
    if (q.entity) (where.push('a.entity_type = ?'), p.push(q.entity));
    if (q.from) (where.push('a.created_at >= ?'), p.push(q.from));
    if (q.to) (where.push('a.created_at < ?'), p.push(addDays(q.to, 1)));
    if (q.q) (where.push('a.message LIKE ?'), p.push(`%${q.q}%`));
    const limit = Math.min(500, Number(q.limit ?? 150));
    const offset = Number(q.offset ?? 0);
    return all(
      `SELECT a.*, u.name AS actor, o.code AS order_code FROM activity_logs a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN orders o ON o.id = a.order_id
       WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
      ...p,
      limit,
      offset,
    );
  }),
);

// ───────────── Reports ─────────────
miscRouter.get(
  '/reports',
  requireRole('admin'),
  h((req) => {
    const t = today();
    const from = String(req.query.from ?? addDays(t, -90));
    const to = String(req.query.to ?? t);
    const all_ = orderSummaries({ includeCancelled: true });
    const inRange = (d: string | null | undefined) => !!d && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
    const received = all_.filter((o) => inRange(o.order_date));
    const stageEntered = (stage: string) =>
      all<{ order_id: number; at: string }>(`SELECT order_id, MIN(created_at) AS at FROM order_status_history WHERE to_stage=? GROUP BY order_id`, stage);
    const completedRows = stageEntered('completed').filter((r) => inRange(r.at));
    const dispatchedRows = stageEntered('dispatched').filter((r) => inRange(r.at));
    const late = (rows: { order_id: number; at: string }[]) =>
      rows.filter((r) => {
        const o = all_.find((x) => x.id === r.order_id);
        return o && r.at.slice(0, 10) > o.deadline;
      });
    const byClient = new Map<string, { client: string; orders: number; units: number; delayed: number }>();
    for (const o of received) {
      const c = byClient.get(o.customer) ?? { client: o.customer, orders: 0, units: 0, delayed: 0 };
      c.orders++;
      c.units += o.quantity;
      if (o.delayed) c.delayed++;
      byClient.set(o.customer, c);
    }
    // Weekly buckets for orders received / dispatched.
    const weeks: { week: string; received: number; dispatched: number }[] = [];
    for (let d = from; d <= to; d = addDays(d, 7)) {
      const end = addDays(d, 7);
      weeks.push({
        week: d,
        received: received.filter((o) => o.order_date >= d && o.order_date < end).length,
        dispatched: dispatchedRows.filter((r) => r.at.slice(0, 10) >= d && r.at.slice(0, 10) < end).length,
      });
    }
    const production = all(
      `SELECT p.key, p.name, COUNT(j.id) AS jobs,
         SUM(CASE WHEN j.status='completed' THEN 1 ELSE 0 END) AS completed,
         SUM(j.completed_qty) AS units_done, SUM(j.quantity) AS units_total,
         SUM(CASE WHEN j.status='completed' AND j.due_date IS NOT NULL AND substr(j.completed_at,1,10) > j.due_date THEN 1 ELSE 0 END) AS completed_late,
         SUM(CASE WHEN j.status!='completed' AND j.due_date < ? THEN 1 ELSE 0 END) AS overdue_open,
         SUM(CASE WHEN j.status='delayed' THEN 1 ELSE 0 END) AS delayed,
         AVG(CASE WHEN j.status='completed' AND j.started_at IS NOT NULL THEN julianday(j.completed_at) - julianday(j.started_at) END) AS avg_days
       FROM job_processes p LEFT JOIN jobs j ON j.process_id = p.id
         AND j.order_id IN (SELECT id FROM orders WHERE cancelled_at IS NULL AND order_date BETWEEN ? AND ?)
       GROUP BY p.id ORDER BY p.sequence`,
      t, from, to,
    ).map((r) => ({ ...r, avg_days: r.avg_days == null ? null : round(r.avg_days, 1), completion_rate: r.jobs ? Math.round((r.completed / r.jobs) * 100) : 0 }));
    const inventory = all(
      `SELECT m.id, m.code, m.name, m.category, m.unit,
         COALESCE(SUM(CASE WHEN t.type='incoming' THEN t.quantity END),0) AS incoming,
         COALESCE(SUM(CASE WHEN t.type='consumption' THEN t.quantity END),0) AS consumed,
         COALESCE(SUM(CASE WHEN t.type='wastage' THEN t.quantity END),0) AS wastage,
         COALESCE(SUM(CASE WHEN t.type='adjustment_in' THEN t.quantity WHEN t.type='adjustment_out' THEN -t.quantity END),0) AS adjustments
       FROM materials m LEFT JOIN inventory_transactions t ON t.material_id = m.id AND t.txn_date BETWEEN ? AND ?
       GROUP BY m.id ORDER BY m.category, consumed DESC`,
      from, to,
    ).map((r) => ({ ...r, wastage_pct: r.consumed + r.wastage ? round((r.wastage / (r.consumed + r.wastage)) * 100, 1) : 0 }));
    const staff = all(
      `SELECT u.id, u.name, p.name AS process,
         SUM(CASE WHEN j.status='completed' AND substr(j.completed_at,1,10) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS jobs_completed,
         (SELECT COALESCE(SUM(ju.qty_after - ju.qty_before),0) FROM job_updates ju WHERE ju.user_id=u.id AND substr(ju.created_at,1,10) BETWEEN ? AND ?) AS units_produced,
         SUM(CASE WHEN j.status!='completed' THEN 1 ELSE 0 END) AS open_jobs,
         SUM(CASE WHEN j.status!='completed' THEN j.quantity - j.completed_qty ELSE 0 END) AS open_units,
         SUM(CASE WHEN j.status!='completed' AND (j.due_date < ? OR j.status='delayed') THEN 1 ELSE 0 END) AS delayed_jobs
       FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN job_processes p ON p.id=u.primary_process_id
       LEFT JOIN jobs j ON j.assigned_to=u.id AND j.order_id IN (SELECT id FROM orders WHERE cancelled_at IS NULL)
       WHERE r.key='staff' GROUP BY u.id ORDER BY units_produced DESC`,
      from, to, from, to, t,
    );
    const lead = completedRows
      .map((r) => all_.find((o) => o.id === r.order_id))
      .filter(Boolean)
      .map((o) => daysBetween(o!.order_date, completedRows.find((r) => r.order_id === o!.id)!.at.slice(0, 10)));
    return {
      range: { from, to },
      orders: {
        received: received.length,
        completed: completedRows.length,
        dispatched: dispatchedRows.length,
        delayed_open: all_.filter((o) => o.delayed && !o.cancelled).length,
        dispatched_late: late(dispatchedRows).length,
        cancelled: received.filter((o) => o.cancelled).length,
        avg_lead_days: lead.length ? round(lead.reduce((a, b) => a + b, 0) / lead.length, 1) : null,
        by_client: [...byClient.values()].sort((a, b) => b.units - a.units),
        weekly: weeks,
      },
      production,
      inventory,
      low_stock: stock().filter((s) => s.low_stock),
      staff,
    };
  }),
);

// ───────────── Staff / users ─────────────
const userSchema = z.object({
  name: z.string().trim().min(2),
  email: z.string().email(),
  phone: z.string().max(30).nullish(),
  role: z.enum(ROLES),
  primary_process_id: z.number().int().positive().nullish(),
  password: z.string().min(8, 'At least 8 characters').optional(),
  active: z.boolean().optional(),
});
miscRouter.get(
  '/users',
  requireRole('admin'),
  h(() =>
    all(
      `SELECT u.id, u.name, u.email, u.phone, r.key AS role, u.primary_process_id, p.name AS process, u.active, u.created_at,
         (SELECT COUNT(*) FROM jobs j WHERE j.assigned_to=u.id AND j.status!='completed') AS open_jobs
       FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN job_processes p ON p.id=u.primary_process_id ORDER BY u.active DESC, r.key, u.name`,
    ),
  ),
);
miscRouter.post(
  '/users',
  requireRole('admin'),
  h((req) => {
    const b = parse(userSchema.required({ password: true }), req.body);
    if (get('SELECT 1 FROM users WHERE email=?', b.email)) throw conflict('A user with this email already exists');
    const id = insert(
      'INSERT INTO users (name, email, phone, password_hash, role_id, primary_process_id) VALUES (?,?,?,?,(SELECT id FROM roles WHERE key=?),?)',
      b.name, b.email, b.phone ?? null, hashPassword(b.password), b.role, b.primary_process_id ?? null,
    );
    logActivity({ actorId: req.user!.id, entityType: 'user', entityId: id, action: 'create', message: `User ${b.name} (${b.role}) created` });
    broadcast('staff');
    return { id };
  }),
);
miscRouter.patch(
  '/users/:id',
  requireRole('admin'),
  h((req) => {
    const id = intId(req.params.id);
    const old = get(`SELECT u.*, r.key AS role FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?`, id);
    if (!old) throw notFound('User');
    const b = parse(userSchema.partial(), req.body);
    if (id === req.user!.id && (b.active === false || (b.role && b.role !== 'admin'))) throw badRequest('You cannot deactivate or demote yourself');
    tx(() => {
      const sets: string[] = [];
      const vals: any[] = [];
      for (const k of ['name', 'email', 'phone', 'primary_process_id'] as const) if (k in b) (sets.push(`${k}=?`), vals.push((b as any)[k] ?? null));
      if (b.active !== undefined) (sets.push('active=?'), vals.push(b.active ? 1 : 0));
      if (b.role) (sets.push('role_id=(SELECT id FROM roles WHERE key=?)'), vals.push(b.role));
      if (b.password) (sets.push('password_hash=?'), vals.push(hashPassword(b.password)));
      if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...vals, id);
      if (b.active === false) run('DELETE FROM sessions WHERE user_id=?', id);
      logFieldChanges({ actorId: req.user!.id, entityType: 'user', entityId: id, label: `User ${old.name}` }, old, { ...b, password: undefined }, {
        name: 'Name', email: 'Email', phone: 'Phone', role: 'Role', active: 'Active', primary_process_id: 'Primary process',
      });
      if (b.password) logActivity({ actorId: req.user!.id, entityType: 'user', entityId: id, action: 'password', message: `Password reset for ${old.name}` });
    });
    broadcast('staff');
    return { ok: true };
  }),
);

// ───────────── Settings & master data ─────────────
miscRouter.put(
  '/settings',
  requireRole('admin'),
  h((req) => {
    const b = parse(z.record(z.string().max(500)), req.body);
    const allowed = ['company_name', 'order_prefix', 'approaching_days', 'at_risk_days', 'due_soon_days'];
    for (const [k, v] of Object.entries(b)) {
      if (!allowed.includes(k)) continue;
      const old = get('SELECT value FROM settings WHERE key=?', k)?.value;
      run('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, v);
      if (old !== v) logActivity({ actorId: req.user!.id, entityType: 'settings', action: 'update', field: k, oldValue: old, newValue: v, message: `Setting ${k}: ${old ?? '—'} → ${v}` });
    }
    broadcast('meta', 'orders', 'dashboard');
    return { ok: true };
  }),
);

miscRouter.put(
  '/stages/:key',
  requireRole('admin'),
  h((req) => {
    const b = parse(z.object({ label: z.string().trim().min(2).max(40), description: z.string().max(300).nullish(), target_days: z.number().int().nonnegative().nullish() }), req.body);
    const old = get('SELECT * FROM order_stages WHERE key=?', req.params.key);
    if (!old) throw notFound('Stage');
    run('UPDATE order_stages SET label=?, description=?, target_days=? WHERE key=?', b.label, b.description ?? null, b.target_days ?? null, req.params.key);
    logFieldChanges({ actorId: req.user!.id, entityType: 'settings', label: `Stage ${old.label}` }, old, b, { label: 'Label', description: 'Description', target_days: 'Target days' });
    broadcast('meta', 'orders');
    return { ok: true };
  }),
);

const fieldDef = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  type: z.enum(['text', 'number', 'select', 'textarea', 'date']),
  options: z.array(z.string()).optional(),
  unit: z.string().optional(),
  section: z.string().optional(),
});
miscRouter.put(
  '/processes/:id',
  requireRole('admin'),
  h((req) => {
    const id = intId(req.params.id);
    const b = parse(z.object({ name: z.string().min(2).optional(), fields: z.array(fieldDef).optional(), active: z.boolean().optional() }), req.body);
    const old = get('SELECT * FROM job_processes WHERE id=?', id);
    if (!old) throw notFound('Process');
    if (b.name) run('UPDATE job_processes SET name=? WHERE id=?', b.name, id);
    if (b.fields) run('UPDATE job_processes SET fields_json=? WHERE id=?', JSON.stringify(b.fields), id);
    if (b.active !== undefined) run('UPDATE job_processes SET active=? WHERE id=?', b.active ? 1 : 0, id);
    logActivity({ actorId: req.user!.id, entityType: 'settings', entityId: id, action: 'update', message: `Process ${old.name} job sheet configuration updated` });
    broadcast('meta');
    return { ok: true };
  }),
);

const customerSchema = z.object({
  name: z.string().trim().min(2),
  contact_person: z.string().max(120).nullish(),
  phone: z.string().max(40).nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  address: z.string().max(500).nullish(),
  city: z.string().max(80).nullish(),
  gstin: z.string().max(20).nullish(),
  notes: z.string().max(1000).nullish(),
});
miscRouter.post(
  '/customers',
  requireRole('admin'),
  h((req) => {
    const b = parse(customerSchema, req.body);
    const id = insert(
      'INSERT INTO customers (name, contact_person, phone, email, address, city, gstin, notes) VALUES (?,?,?,?,?,?,?,?)',
      b.name, b.contact_person ?? null, b.phone ?? null, b.email || null, b.address ?? null, b.city ?? null, b.gstin ?? null, b.notes ?? null,
    );
    logActivity({ actorId: req.user!.id, entityType: 'customer', entityId: id, action: 'create', message: `Client ${b.name} added` });
    broadcast('meta');
    return { id };
  }),
);
miscRouter.put(
  '/customers/:id',
  requireRole('admin'),
  h((req) => {
    const id = intId(req.params.id);
    const old = get('SELECT * FROM customers WHERE id=?', id);
    if (!old) throw notFound('Client');
    const b = parse(customerSchema, req.body);
    run(
      'UPDATE customers SET name=?, contact_person=?, phone=?, email=?, address=?, city=?, gstin=?, notes=? WHERE id=?',
      b.name, b.contact_person ?? null, b.phone ?? null, b.email || null, b.address ?? null, b.city ?? null, b.gstin ?? null, b.notes ?? null, id,
    );
    logFieldChanges({ actorId: req.user!.id, entityType: 'customer', entityId: id, label: `Client ${old.name}` }, old, b, {
      name: 'Name', contact_person: 'Contact', phone: 'Phone', email: 'Email', address: 'Address', city: 'City', gstin: 'GSTIN',
    });
    broadcast('meta', 'orders');
    return { ok: true };
  }),
);

const productSchema = z.object({
  sku: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(120),
  category: z.string().max(60).nullish(),
  description: z.string().max(1000).nullish(),
  default_dimensions: z.string().max(120).nullish(),
  processes: z.array(z.object({ process_id: z.number().int().positive(), material_per_unit: z.number().nonnegative().nullish() })).min(1, 'Pick at least one process'),
});
function saveProduct(id: number | null, b: z.infer<typeof productSchema>, actorId: number) {
  return tx(() => {
    if (id) {
      run('UPDATE products SET sku=?, name=?, category=?, description=?, default_dimensions=? WHERE id=?', b.sku, b.name, b.category ?? null, b.description ?? null, b.default_dimensions ?? null, id);
      run('DELETE FROM product_processes WHERE product_id=?', id);
    } else {
      if (get('SELECT 1 FROM products WHERE sku=?', b.sku)) throw conflict('SKU already exists');
      id = insert('INSERT INTO products (sku, name, category, description, default_dimensions) VALUES (?,?,?,?,?)', b.sku, b.name, b.category ?? null, b.description ?? null, b.default_dimensions ?? null);
    }
    for (const p of b.processes) insert('INSERT INTO product_processes (product_id, process_id, material_per_unit) VALUES (?,?,?)', id, p.process_id, p.material_per_unit ?? null);
    logActivity({ actorId, entityType: 'product', entityId: id, action: 'save', message: `Product ${b.name} (${b.sku}) saved` });
    broadcast('meta');
    return id;
  });
}
miscRouter.post('/products', requireRole('admin'), h((req) => ({ id: saveProduct(null, parse(productSchema, req.body), req.user!.id) })));
miscRouter.put('/products/:id', requireRole('admin'), h((req) => ({ id: saveProduct(intId(req.params.id), parse(productSchema, req.body), req.user!.id) })));
