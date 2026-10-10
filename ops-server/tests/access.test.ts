import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-test-'));
process.env.OPS_DATA_DIR = dir;
// Runs on an in-memory embedded Postgres; set OPS_TEST_DATABASE_URL to run against a real server instead.
process.env.OPS_PG_DIR = 'memory://';
if (process.env.OPS_TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.OPS_TEST_DATABASE_URL; else delete process.env.DATABASE_URL;
process.env.APP_URL = 'http://test.local';

const { openDb, closeDb, run, get } = await import('../db.ts');
const { createApp } = await import('../app.ts');
const { seedWorkspaceFromFiles } = await import('../setup.ts');
const { createUser } = await import('../accounts.ts');

let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base = '';

class Client {
  cookie = '';
  async call(method: string, url: string, body?: unknown) {
    const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  get = (u: string) => this.call('GET', u);
  post = (u: string, b: unknown = {}) => this.call('POST', u, b);
  put = (u: string, b: unknown) => this.call('PUT', u, b);
}
const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

async function activate(link: string, password: string) {
  const c = new Client();
  const r = await c.post('/api/auth/set-password', { token: tokenOf(link), password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return c;
}

let admin: Client, amit: Client, rahul: Client;

before(async () => {
  await openDb();
  await seedWorkspaceFromFiles();
  const a = await createUser(null, { name: 'Shubham Jain', email: 'admin@example.com', role: 'admin' });
  const s1 = await createUser(null, { name: 'Amit Shah', email: 'amit@example.com', role: 'staff' });
  const s2 = await createUser(null, { name: 'Rahul Mehta', email: 'rahul@example.com', role: 'staff' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = await activate((a as { inviteLink: string }).inviteLink, 'adminPass123');
  amit = await activate((s1 as { inviteLink: string }).inviteLink, 'amitPass123');
  rahul = await activate((s2 as { inviteLink: string }).inviteLink, 'rahulPass123');
});
after(async () => { server?.close(); await closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test('there is no public sign-up and workspace data needs a session', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/state')).status, 401);
  assert.equal((await anon.post('/api/admin/users', { name: 'Hacker' })).status, 401);
  assert.equal((await anon.post('/api/auth/register', { email: 'x@y.z' })).status, 401);
  const res = await fetch(`${base}/seed-data.js`);
  assert.equal(res.status, 404, 'the browser-only snapshot must not be served');
  assert.equal((await fetch(`${base}/rope_inventory_data.json`)).status, 401);
});

test('passwords are hashed and logins are checked', async () => {
  const row = await get('SELECT password_hash FROM users WHERE email=?', 'admin@example.com');
  assert.match(row.password_hash, /^scrypt:/);
  assert.ok(!row.password_hash.includes('adminPass123'));
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { login: 'admin@example.com', password: 'wrong-password1' })).status, 401);
  const ok = await c.post('/api/auth/login', { login: 'ADMIN@example.com', password: 'adminPass123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
});

test('set-password links are single use', async () => {
  const r = await createUser(null, { name: 'Neha Kapoor', email: 'neha@example.com', role: 'staff' });
  const link = (r as { inviteLink: string }).inviteLink;
  const info = await new Client().get(`/api/auth/token?token=${tokenOf(link)}`);
  assert.equal(info.body.email, 'neha@example.com');
  await activate(link, 'nehaPass123');
  const again = await new Client().post('/api/auth/set-password', { token: tokenOf(link), password: 'otherPass123' });
  assert.equal(again.status, 410);
});

test('expired links are refused', async () => {
  const r = await createUser(null, { name: 'Karan Patel', email: 'karan@example.com', role: 'staff' });
  const link = (r as { inviteLink: string }).inviteLink;
  await run(`UPDATE auth_tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE used_at IS NULL AND user_id=(SELECT id FROM users WHERE email='karan@example.com')`);
  const res = await new Client().post('/api/auth/set-password', { token: tokenOf(link), password: 'karanPass123' });
  assert.equal(res.status, 410);
  assert.match(res.body.error, /expired/);
});

test('staff only see orders and job sheets assigned to them', async () => {
  const all = (await admin.get('/api/state')).body.db.orders;
  const state = (await amit.get('/api/state')).body;
  assert.equal(state.db.role, 'Staff');
  assert.deepEqual(state.tracker, [], 'staff cannot read the master production tracker');
  for (const o of state.db.orders) {
    assert.ok(o.processes.length > 0);
    assert.ok(o.processes.every((p: { assigned: string }) => p.assigned === 'Amit Shah'));
  }
  const expected = all.filter((o: { processes: { assigned: string }[] }) => o.processes.some(p => p.assigned === 'Amit Shah')).length;
  assert.equal(state.db.orders.length, expected);
  const count = (orders: { processes: unknown[] }[]) => orders.reduce((n, o) => n + o.processes.length, 0);
  assert.ok(count(state.db.orders) < count(all), 'other people\'s job sheets are not sent to staff');
});

test('staff can update their own job but nothing else', async () => {
  const mine = (await amit.get('/api/state')).body.db.orders[0];
  const job = mine.processes[0];
  const update = { ...mine, processes: [{ ...job, completed: Math.min(mine.qty, (job.completed || 0) + 1), detail: 'Weaving going well' }] };
  const ok = await amit.put(`/api/orders/${mine.id}`, { order: update, baseVersion: mine._version });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.order.processes[0].detail, 'Weaving going well');
  assert.equal(ok.body.order.updatedBy, 'Amit Shah');

  const fresh = ok.body.order;
  const deadline = await amit.put(`/api/orders/${mine.id}`, { order: { ...fresh, deadline: '2099-01-01' }, baseVersion: fresh._version });
  assert.equal(deadline.status, 403);
  const reassign = await amit.put(`/api/orders/${mine.id}`, { order: { ...fresh, processes: [{ ...fresh.processes[0], assigned: 'Rahul Mehta' }] }, baseVersion: fresh._version });
  assert.equal(reassign.status, 403);

  // Move one order entirely to other people: it must disappear for Amit and refuse his writes.
  const target = (await admin.get('/api/state')).body.db.orders.find((o: { id: string }) => o.id !== mine.id);
  const moved = await admin.put(`/api/orders/${target.id}`, { order: { ...target, processes: target.processes.map((p: object) => ({ ...p, assigned: 'Neha Kapoor' })) }, baseVersion: target._version });
  assert.equal(moved.status, 200);
  assert.ok(!(await amit.get('/api/state')).body.db.orders.some((o: { id: string }) => o.id === target.id));
  const notMine = moved.body.order;
  const foreign = await amit.put(`/api/orders/${notMine.id}`, { order: notMine, baseVersion: notMine._version });
  assert.equal(foreign.status, 404);
  assert.equal((await amit.post('/api/orders', { order: { id: 'UM-9999', processes: [] } })).status, 403);
});

test('an out-of-date save is rejected instead of overwriting', async () => {
  const o = (await admin.get('/api/state')).body.db.orders[0];
  assert.equal((await admin.put(`/api/orders/${o.id}`, { order: { ...o, notes: 'first' }, baseVersion: o._version })).status, 200);
  const stale = await admin.put(`/api/orders/${o.id}`, { order: { ...o, notes: 'second' }, baseVersion: o._version });
  assert.equal(stale.status, 409);
});

test('inventory entries are posted to the ledger and attributed to the signed-in user', async () => {
  const before = (await admin.get('/api/state')).body.db.inventory.find((i: { name: string }) => i.name === 'Powder Color');
  const r = await rahul.post('/api/transactions', { transaction: { material: 'Powder Color', type: 'Incoming', qty: 12, colorName: 'Matte Black', enteredBy: 'Shubham Jain' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.transaction.enteredBy, 'Rahul Mehta', 'the server sets who entered it');
  assert.equal(r.body.inventory.find((i: { name: string }) => i.name === 'Powder Color').incoming, before.incoming + 12);
  const rope = await amit.post('/api/transactions', { transaction: { material: 'Rope', type: 'Incoming', qty: 50, sku: 'TEST-SKU', color: 'Ivory', mm: '6' } });
  assert.equal(rope.status, 201);
  assert.ok(rope.body.rope.stock_master.some((x: Record<string, string>) => x['Rope Type (SKU)'] === 'TEST-SKU' && x['Current Balance (m)'] === '50'));
  assert.equal((await amit.post('/api/transactions', { transaction: { material: 'Foam', qty: 1 } })).status, 400);
  await assert.rejects(run('DELETE FROM transactions WHERE demo=0'), /append-only/);
});

test('staff cannot use admin endpoints', async () => {
  assert.equal((await amit.get('/api/admin/users')).status, 403);
  assert.equal((await amit.post('/api/admin/users', { name: 'Someone' })).status, 403);
  assert.equal((await amit.put('/api/settings', { settings: {} })).status, 403);
  assert.equal((await amit.put('/api/tracker', { rows: [] })).status, 403);
  assert.equal((await amit.post('/api/demo/clear')).status, 403);
});

test('admin adds staff without email: unique login ID, one-time password, must change it', async () => {
  const r = await admin.post('/api/admin/users', { name: 'Pooja Rao' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.loginId, 'pooja.rao@umami.app');
  assert.ok(r.body.password.length >= 12);
  const twin = await admin.post('/api/admin/users', { name: 'Pooja  Rao' });
  assert.equal(twin.status, 409, 'two active people cannot share a name, since jobs are assigned by name');

  const pooja = new Client();
  assert.equal((await pooja.post('/api/auth/login', { login: 'pooja.rao@umami.app', password: r.body.password })).status, 200);
  const blocked = await pooja.get('/api/state');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  assert.equal((await pooja.post('/api/auth/change-password', { current: r.body.password, password: 'poojaOwn123' })).status, 200);
  assert.equal((await pooja.get('/api/state')).status, 200);
  const list = (await admin.get('/api/admin/users')).body.users;
  assert.ok(list.every((u: Record<string, unknown>) => !('password_hash' in u)), 'hashes never leave the server');
});

test('admin adds staff with email: invite link returned and recorded for email', async () => {
  const r = await admin.post('/api/admin/users', { name: 'Ravi Kumar', email: 'ravi@example.com' });
  assert.equal(r.status, 201);
  assert.match(r.body.inviteLink, /\/set-password\?token=/);
  assert.equal(r.body.user.status, 'invited');
  assert.ok(await get('SELECT 1 FROM email_outbox WHERE to_addr=?', 'ravi@example.com'));
  assert.equal((await new Client().post('/api/auth/login', { login: 'ravi@example.com', password: 'anything123' })).status, 401);
});

test('disable signs the user out, blocks login, and users are never deleted', async () => {
  const id = (await get('SELECT id FROM users WHERE email=?', 'rahul@example.com')).id;
  assert.equal((await admin.post(`/api/admin/users/${id}/disable`)).status, 200);
  assert.equal((await rahul.get('/api/state')).status, 401, 'existing session is revoked');
  const login = await new Client().post('/api/auth/login', { login: 'rahul@example.com', password: 'rahulPass123' });
  assert.equal(login.status, 401);
  assert.match(login.body.error, /disabled/);
  await assert.rejects(run('DELETE FROM users WHERE id=?', id), /never deleted/);
  assert.equal((await admin.post(`/api/admin/users/${id}/enable`)).status, 200);
  assert.equal((await new Client().post('/api/auth/login', { login: 'rahul@example.com', password: 'rahulPass123' })).status, 200);
  const self = (await get('SELECT id FROM users WHERE email=?', 'admin@example.com')).id;
  assert.equal((await admin.post(`/api/admin/users/${self}/disable`)).status, 400);
});

test('admin password reset issues a fresh single-use link and signs the user out', async () => {
  const id = (await get('SELECT id FROM users WHERE email=?', 'amit@example.com')).id;
  const r = await admin.post(`/api/admin/users/${id}/reset-password`);
  assert.equal(r.status, 200);
  assert.ok(r.body.resetLink);
  assert.equal((await amit.get('/api/state')).status, 401);
  amit = await activate(r.body.resetLink, 'amitNew1234');
  assert.equal((await amit.get('/api/state')).status, 200);
});

test('photos sent as data URLs are stored on the server and need a session', async () => {
  const o = (await admin.get('/api/state')).body.db.orders[1];
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const r = await admin.put(`/api/orders/${o.id}`, { order: { ...o, photoData: png }, baseVersion: o._version });
  assert.equal(r.status, 200);
  assert.match(r.body.order.photoData, /^\/uploads\/[a-f0-9]{32}\.png$/);
  assert.equal((await fetch(base + r.body.order.photoData)).status, 401, 'photos need a session');
  const img = await fetch(base + r.body.order.photoData, { headers: { Cookie: admin.cookie } });
  assert.equal(img.status, 200);
});

test('cross-site and non-JSON writes are rejected', async () => {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'login=a&password=b' });
  assert.equal(res.status, 415);
  const cross = await fetch(`${base}/api/demo/clear`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: admin.cookie }, body: '{}' });
  assert.equal(cross.status, 403);
});

test('staff sharing the team inbox each get their own login; links go to the inbox', async () => {
  const a = await admin.post('/api/admin/users', { name: 'Meera Joshi', email: 'Admin@umamistudio.in' });
  const b = await admin.post('/api/admin/users', { name: 'Sanjay Das', email: 'admin@umamistudio.in' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(a.body.loginId, 'meera.joshi@umami.app');
  assert.equal(b.body.loginId, 'sanjay.das@umami.app');
  assert.equal(a.body.sentTo, 'admin@umamistudio.in');
  assert.ok(await get(`SELECT 1 FROM email_outbox WHERE to_addr='admin@umamistudio.in' AND body LIKE '%meera.joshi@umami.app%'`));
  const meera = await activate(a.body.inviteLink, 'meeraPass123');
  assert.equal((await meera.get('/api/auth/me')).body.user.email, 'meera.joshi@umami.app');
  const login = await new Client().post('/api/auth/login', { login: 'meera.joshi@umami.app', password: 'meeraPass123' });
  assert.equal(login.status, 200);
  const id = (await get('SELECT id FROM users WHERE email=?', 'sanjay.das@umami.app')).id;
  const reset = await admin.post(`/api/admin/users/${id}/reset-password`);
  assert.equal(reset.body.sentTo, 'admin@umamistudio.in');
  assert.ok(reset.body.resetLink);
});

test('forgot password emails a single-use link only for accounts in the database', async () => {
  const before = Number((await get('SELECT COUNT(*)::int AS n FROM email_outbox')).n);
  const unknown = await new Client().post('/api/auth/forgot', { login: 'stranger@example.com' });
  assert.equal(unknown.status, 200, 'same answer whether or not the account exists');
  assert.equal(Number((await get('SELECT COUNT(*)::int AS n FROM email_outbox')).n), before, 'no email for unknown addresses');

  const ok = await new Client().post('/api/auth/forgot', { login: 'NEHA@example.com' });
  assert.equal(ok.status, 200);
  const mail = await get(`SELECT body FROM email_outbox WHERE to_addr='neha@example.com' ORDER BY id DESC LIMIT 1`);
  assert.match(mail.body, /password reset was requested/);
  const link = /http\S+set-password\?token=\S+/.exec(mail.body)![0];
  assert.equal((await new Client().post('/api/auth/login', { login: 'neha@example.com', password: 'nehaPass123' })).status, 200, 'old password works until reset');
  await activate(link, 'nehaNew12345');
  assert.equal((await new Client().post('/api/auth/login', { login: 'neha@example.com', password: 'nehaPass123' })).status, 401);
  assert.equal((await new Client().post('/api/auth/login', { login: 'neha@example.com', password: 'nehaNew12345' })).status, 200);
  assert.equal((await new Client().post('/api/auth/set-password', { token: tokenOf(link), password: 'again12345' })).status, 410);

  await new Client().post('/api/auth/forgot', { login: 'meera.joshi@umami.app' });
  assert.ok(await get(`SELECT 1 FROM email_outbox WHERE to_addr='admin@umamistudio.in' AND body LIKE '%meera.joshi@umami.app%' AND body LIKE '%reset was requested%'`), 'generated login IDs: link goes to the staff inbox');
});
