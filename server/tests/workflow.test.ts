import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, useDb, get, all, run } from '../db.ts';
import { bootstrap } from '../bootstrap.ts';
import { hashPassword, type AuthUser } from '../auth.ts';
import { createOrder } from '../services/orderOps.ts';
import { recordQualityCheck, recordDispatch } from '../services/orderOps.ts';
import { checkTransition, transition, orderSummary, setHold } from '../services/orders.ts';
import { updateJob } from '../services/jobs.ts';
import { postTxn, orderMaterials, stock } from '../services/inventory.ts';
import { deadlineRisk } from '../../shared/domain.ts';

let admin: AuthUser, rahul: AuthUser, amit: AuthUser, other: AuthUser;
let ropeId: number, productId: number;
const P = (k: string) => get('SELECT id FROM job_processes WHERE key=?', k)!.id as number;

before(() => {
  useDb(openDb(':memory:'));
  bootstrap();
  const mk = (name: string, role: string): AuthUser => {
    const id = Number(run('INSERT INTO users (name, email, password_hash, role_id) VALUES (?,?,?,(SELECT id FROM roles WHERE key=?))', name, `${name}@t.test`, hashPassword('x'), role).lastInsertRowid);
    return { id, name, email: `${name}@t.test`, role: role as any, primary_process_id: null };
  };
  admin = mk('admin', 'admin');
  rahul = mk('rahul', 'staff');
  amit = mk('amit', 'staff');
  other = mk('other', 'staff');
  run(`INSERT INTO customers (name) VALUES ('ABC Interiors')`);
  productId = Number(run(`INSERT INTO products (sku, name) VALUES ('LC','Lounge Chair')`).lastInsertRowid);
  ropeId = Number(run(`INSERT INTO materials (code, name, category, unit, reorder_level) VALUES ('R1','Rope','rope','kg',50)`).lastInsertRowid);
  postTxn({ materialId: ropeId, type: 'opening', quantity: 80, userId: admin.id });
});

function newOrder(qty = 10, rope = 120, materialId = ropeId) {
  return createOrder(
    {
      customer_id: 1, order_date: '2026-10-01', deadline: '2026-10-30', priority: 'high',
      items: [{
        product_id: productId, quantity: qty,
        processes: [{ process_id: P('iron'), assigned_to: rahul.id }, { process_id: P('rope'), assigned_to: amit.id }],
        materials: [{ process_id: P('rope'), material_id: materialId, required_qty: rope }],
      }],
    } as any,
    admin,
  );
}

test('order creation generates one job sheet per process', () => {
  const id = newOrder();
  const jobs = all('SELECT * FROM jobs WHERE order_id=?', id);
  assert.equal(jobs.length, 2);
  assert.equal(orderSummary(id).stage, 'received');
  assert.ok(get('SELECT 1 FROM activity_logs WHERE order_id=? AND action=?', id, 'create'));
});

test('stages cannot be skipped and gates are enforced', () => {
  const id = newOrder();
  assert.equal(checkTransition(id, 'preparing').allowed, false);
  assert.throws(() => transition(id, 'in_production', { actorId: admin.id, actorRole: 'admin' }));
  transition(id, 'reviewed', { actorId: admin.id, actorRole: 'admin' });
  transition(id, 'preparing', { actorId: admin.id, actorRole: 'admin' });
  // Quality check is blocked while job sheets are incomplete
  run(`UPDATE orders SET stage='in_production' WHERE id=?`, id);
  const c = checkTransition(id, 'quality_check');
  assert.equal(c.allowed, false);
  assert.match(c.blockers.join(' '), /not completed/);
});

test('preparation reserves stock and reports the shortage (120 kg needed, 80 kg in store)', () => {
  const mat = Number(run(`INSERT INTO materials (code, name, category, unit) VALUES ('R2','Rope 2','rope','kg')`).lastInsertRowid);
  postTxn({ materialId: mat, type: 'opening', quantity: 80, userId: admin.id });
  const id = newOrder(10, 120, mat);
  transition(id, 'reviewed', { actorId: admin.id, actorRole: 'admin' });
  transition(id, 'preparing', { actorId: admin.id, actorRole: 'admin' });
  const m = orderMaterials(id)[0];
  assert.equal(m.reserved, 80);
  assert.equal(m.shortage, 40);
  assert.equal(orderSummary(id).shortage, true);
  // Stock arriving is reserved for the short order automatically by the route; here post + allocate manually.
  postTxn({ materialId: mat, type: 'incoming', quantity: 100, userId: admin.id });
  assert.equal(orderMaterials(id)[0].shortage, 0);
});

test('a staff update flows to job, ledger, order progress, lifecycle and audit trail', () => {
  postTxn({ materialId: ropeId, type: 'incoming', quantity: 500, userId: admin.id });
  const id = newOrder(10, 20);
  transition(id, 'reviewed', { actorId: admin.id, actorRole: 'admin' });
  transition(id, 'preparing', { actorId: admin.id, actorRole: 'admin' });
  const [iron, rope] = all('SELECT j.id FROM jobs j JOIN job_processes p ON p.id=j.process_id WHERE order_id=? ORDER BY p.sequence', id);
  const before = get<{ on_hand: number }>('SELECT on_hand FROM inventory WHERE material_id=?', ropeId)!.on_hand;

  updateJob(iron.id, { completed_qty: 10 }, rahul);
  let s = orderSummary(id);
  assert.equal(s.stage, 'in_production', 'first update auto-starts production');
  assert.equal(s.progress, 50);

  // Staff can only touch their own job sheets
  assert.throws(() => updateJob(rope.id, { completed_qty: 1 }, other), /not assigned/);

  updateJob(rope.id, { completed_qty: 10, material_used: 18.5, wastage: 0.5 }, amit);
  s = orderSummary(id);
  assert.equal(s.progress, 100);
  assert.equal(s.stage, 'quality_check', 'all job sheets complete → quality check');
  const after = get<{ on_hand: number }>('SELECT on_hand FROM inventory WHERE material_id=?', ropeId)!.on_hand;
  assert.equal(Math.round((before - after) * 10) / 10, 19);
  assert.ok(get(`SELECT 1 FROM activity_logs WHERE order_id=? AND actor_id IS NULL AND field='progress'`, id));

  // Staff cannot reduce completed quantity
  run(`UPDATE orders SET stage='in_production' WHERE id=?`, id);
  assert.throws(() => updateJob(rope.id, { completed_qty: 5 }, amit), /cannot go down/);
  run(`UPDATE orders SET stage='quality_check' WHERE id=?`, id);

  recordQualityCheck(id, { result: 'passed' }, admin);
  assert.equal(orderSummary(id).stage, 'ready_for_dispatch');
  recordDispatch(id, { dispatched_at: '2026-10-20T10:00', quantity: 6 }, admin);
  assert.equal(orderSummary(id).stage, 'dispatched');
  assert.throws(() => recordDispatch(id, { dispatched_at: '2026-10-21T10:00', quantity: 5 }, admin), /Only 4/);
  const c = checkTransition(id, 'completed');
  assert.match(c.warnings.join(), /Only 6 of 10/);
  transition(id, 'completed', { actorId: admin.id, actorRole: 'admin', acknowledgeWarnings: true });
  assert.equal(orderSummary(id).stage, 'completed');
});

test('on-hold orders block staff updates and transitions', () => {
  const id = newOrder(5, 5);
  transition(id, 'reviewed', { actorId: admin.id, actorRole: 'admin' });
  transition(id, 'preparing', { actorId: admin.id, actorRole: 'admin' });
  setHold(id, true, 'Client revising colour', admin.id);
  const job = get('SELECT id FROM jobs WHERE order_id=? AND assigned_to=?', id, rahul.id);
  assert.throws(() => updateJob(job.id, { completed_qty: 1 }, rahul), /on hold/);
  assert.equal(checkTransition(id, 'ready_for_production').allowed, false);
});

test('audit trail and stock ledger are append-only', () => {
  assert.throws(() => run('DELETE FROM activity_logs'), /append-only/);
  assert.throws(() => run(`UPDATE activity_logs SET message='x'`), /append-only/);
  assert.throws(() => run('DELETE FROM inventory_transactions'), /immutable/);
});

test('stock cannot go negative', () => {
  const s = stock({ materialId: ropeId })[0];
  assert.throws(() => postTxn({ materialId: ropeId, type: 'wastage', quantity: s.on_hand + 1, userId: admin.id }), /physically in stock/);
});

test('deadline risk bands', () => {
  const base = { today: '2026-10-10', stage: 'in_production' as const, progress: 50, orderDate: '2026-09-01' };
  assert.equal(deadlineRisk({ ...base, deadline: '2026-10-09' }), 'overdue');
  assert.equal(deadlineRisk({ ...base, deadline: '2026-10-11' }), 'at_risk');
  assert.equal(deadlineRisk({ ...base, deadline: '2026-10-15', progress: 90 }), 'approaching');
  assert.equal(deadlineRisk({ ...base, deadline: '2026-11-30', progress: 90 }), 'safe');
  assert.equal(deadlineRisk({ ...base, deadline: '2026-10-01', stage: 'dispatched' }), 'done');
});
