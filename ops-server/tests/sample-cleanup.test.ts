import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-clean-'));
process.env.OPS_DATA_DIR = dir;
process.env.OPS_PG_DIR = 'memory://';
delete process.env.DATABASE_URL;

const { openDb, closeDb, run, get, all, kvGet } = await import('../db.ts');
const { seedTestFixture, seedWorkspaceFromFiles } = await import('../setup.ts');
const { removeSampleData, applyTransaction, resetWorkspace } = await import('../workspace.ts');

before(async () => { await openDb(); });
after(async () => { await closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test('an existing database loses exactly the old sample data and keeps what the team entered', async () => {
  // A database seeded by the old code: the sample workspace plus demo staff entries, and no clean-up marker.
  await seedTestFixture();
  await run(`DELETE FROM kv WHERE key='sampleDataRemovedV1'`);
  const demo = { id: 'TX-DEMO-102', material: 'Fabric', type: 'Incoming', qty: 40, unit: 'm', company: 'SUNBRELLA', order: '—', job: '—', staff: 'Neha Kapoor', enteredBy: 'Neha Kapoor', date: '2026-10-07', notes: 'Sample entry', demo: true };
  await applyTransaction(demo);
  await run('INSERT INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,1,?)', demo.id, JSON.stringify(demo), null, '2026-10-07');
  await run(`INSERT INTO activity (time, actor, entity, text, user_id, demo) VALUES ('2026-10-07T10:00:00','Neha Kapoor','Fabric','DEMO · Fabric incoming',NULL,1)`);
  // Real work entered by the team, including an entry made against a sample order.
  const real = { id: 'TX-REAL-1', material: 'Fabric', type: 'Incoming', qty: 10, unit: 'm', company: 'Agora', code: 'AG-1', order: '—', job: '—', staff: 'Khushboo', enteredBy: 'Khushboo', date: '2026-10-18', notes: 'Delivery' };
  await applyTransaction(real);
  await run('INSERT INTO transactions (id, data, user_id, demo, created_at) VALUES (?,?,?,0,?)', real.id, JSON.stringify(real), null, '2026-10-18');
  await run(`INSERT INTO orders (id, data, version, created_at, updated_at, updated_by) VALUES ('UM-1049', ?, 1, '2026-10-18', '2026-10-18', 'Khushboo')`, JSON.stringify({ id: 'UM-1049', client: 'Real Client', processes: [] }));
  await run(`INSERT INTO activity (time, actor, entity, text, user_id, demo) VALUES ('2026-10-18T10:00:00','Khushboo','UM-1048','Stage changed',NULL,0)`);
  const trackerBefore = (await kvGet('tracker', [])).length, ropeBefore = JSON.stringify(await kvGet('rope', null));

  const removed = await removeSampleData();
  assert.deepEqual(removed, { orders: 6, entries: 4, activity: 5 });
  assert.deepEqual((await all('SELECT id FROM orders')).map(r => r.id), ['UM-1049'], 'only the real order is left');
  const fabric = JSON.parse((await get(`SELECT data FROM inventory WHERE name='Fabric'`)).data);
  assert.deepEqual([fabric.opening, fabric.incoming, fabric.reserved, fabric.consumed, fabric.wastage, fabric.reorder], [0, 10, 0, 0, 0, 0], 'stock shows only the real delivery');
  const rope = JSON.parse((await get(`SELECT data FROM inventory WHERE name='Rope'`)).data);
  assert.deepEqual([rope.opening, rope.incoming, rope.reserved, rope.consumed, rope.wastage], [0, 0, 0, 0, 0]);
  assert.deepEqual((await all('SELECT id FROM transactions')).map(r => r.id), ['TX-REAL-1']);
  assert.deepEqual((await all('SELECT text FROM activity')).map(r => r.text), ['Stage changed'], 'the team\'s own activity stays');
  assert.equal((await kvGet('tracker', [])).length, trackerBefore, 'Master production rows are not touched');
  assert.equal(JSON.stringify(await kvGet('rope', null)), ropeBefore, 'the rope workbook is not touched');
  await assert.rejects(run(`DELETE FROM transactions WHERE id='TX-REAL-1'`), /append-only/, 'the ledger is append-only again');
  assert.equal(await removeSampleData(), null, 'runs only once');
});

test('the one-time reset clears everything to zero and removes staff, keeping admins', async () => {
  await run(`DELETE FROM kv WHERE key='workspaceResetV2'`);
  await run(`INSERT INTO users (name, email, role, status, created_at) VALUES ('Admin One','a1@example.com','admin','active','2026-10-01'),('Staff One','s1@example.com','staff','active','2026-10-01')`);
  const staffId = (await get(`SELECT id FROM users WHERE email='s1@example.com'`)).id;
  await run(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('h1', ?, '2026-10-01', '2099-01-01')`, staffId);
  await run(`INSERT INTO kv (key, value) VALUES ('tracker', '[{"orderNo":"X"}]') ON CONFLICT (key) DO UPDATE SET value=excluded.value`);
  const r = await resetWorkspace();
  assert.ok(r && r.staff === 1 && r.orders >= 1, JSON.stringify(r));
  assert.equal((await all('SELECT id FROM orders')).length, 0);
  assert.equal((await all('SELECT id FROM transactions')).length, 0);
  assert.equal((await all('SELECT seq FROM activity')).length, 0);
  assert.deepEqual((await all(`SELECT email FROM users ORDER BY email`)).map(u => u.email), ['a1@example.com'], 'staff removed, admin kept');
  assert.deepEqual(await kvGet('tracker', null), []);
  for (const row of (await kvGet('rope', { stock_master: [] } as any)).stock_master) assert.equal(row['Current Balance (m)'], '0');
  for (const x of await all('SELECT data FROM inventory')) { const i = JSON.parse(x.data); assert.equal(i.opening + i.incoming + i.adjustments - i.reserved - i.consumed - i.wastage, 0); }
  await assert.rejects(run(`DELETE FROM users WHERE email='a1@example.com'`), /never deleted/, 'guards are back on');
  assert.equal(await resetWorkspace(), null, 'runs only once');
});

test('a new database starts empty apart from the rope list at zero', async () => {
  await run('DELETE FROM orders'); await run(`DELETE FROM kv`);
  await seedWorkspaceFromFiles();
  assert.equal((await all('SELECT id FROM orders')).length, 0);
  for (const r of await all('SELECT data FROM inventory')) {
    const i = JSON.parse(r.data);
    assert.equal(i.opening + i.incoming + i.adjustments - i.reserved - i.consumed - i.wastage, 0, `${i.name} starts at zero`);
  }
  assert.equal((await kvGet('tracker', [])).length, 0);
  assert.equal(await removeSampleData(), null, 'nothing to clean in a new database');
});
