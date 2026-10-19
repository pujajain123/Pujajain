import fs from 'node:fs';
import path from 'node:path';
import { get, run, tx, openDb } from './db.ts';
import { seedWorkspace, removeSampleData, resetWorkspace } from './workspace.ts';
import { createUser } from './accounts.ts';
import type { Role } from './auth.ts';

export const ROOT = process.env.OPS_ROOT || process.cwd();

const readSeed = (file: string) => { const src = fs.readFileSync(file, 'utf8'); return JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, '')); };
const readRope = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'codex-app/rope_inventory_data.json'), 'utf8'));

/** An empty database gets the rope list (all quantities zero) and nothing else: no orders, stock or history. */
export async function seedWorkspaceFromFiles() {
  const seed = readSeed(path.join(ROOT, 'codex-app/seed-data.js'));
  return seedWorkspace({ ordersAndOperations: {} }, readRope(), seed.productionTracker || []);
}

/** Automated tests only: the old sample workspace, so the tests have orders and job sheets to work with. */
export async function seedTestFixture(file = path.join(ROOT, 'ops-server/tests/fixtures/sample-workspace.json')) {
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  return seedWorkspace(fixture, fixture.rope || readRope(), fixture.productionTracker || []);
}

type Seeded = { name: string; role: Role; login: string; link: string; password?: string };
type InitialUser = { name: string; email?: string; login?: string; role: Role; temporaryPasswordHash?: string };
const readInitialUsers = (file: string): InitialUser[] => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).users : []);

/** Creates the developer-provided first accounts once (database has no users yet) and returns how each signs in. */
export async function seedInitialUsers(file = path.join(ROOT, 'config/initial-users.json')): Promise<Seeded[]> {
  const users = readInitialUsers(file);
  if (!users.length) return [];
  return tx(async () => {
    await get('SELECT pg_advisory_xact_lock(727003)');
    if (await get('SELECT 1 FROM users LIMIT 1')) return [];
    const out: Seeded[] = [];
    for (const u of users) {
      const r = await createUser(null, { name: u.name, email: u.email, role: u.role });
      out.push('inviteLink' in r
        ? { name: u.name, role: u.role, login: r.user.email, link: r.inviteLink }
        : { name: u.name, role: u.role, login: r.loginId, password: r.password, link: r.loginLink });
    }
    return out;
  });
}

export function printSeeded(invited: Seeded[]) {
  if (!invited.length) return;
  console.log('\nFirst accounts created. Give each person only their own details:');
  for (const u of invited) {
    console.log(`  ${u.role.padEnd(5)}  ${u.name} <${u.login}>`);
    console.log(u.password
      ? `         sign in at ${u.link} with temporary password ${u.password} (must be changed at first sign-in)`
      : `         set-password link (single use, 48 hours): ${u.link}`);
  }
  console.log('');
}

/**
 * Gives first accounts their developer-set temporary password (stored here only as a hash). Applied only while an
 * account has never set a password, and always with "must change at first sign-in".
 */
export async function applyTemporaryPasswords(file = path.join(ROOT, 'config/initial-users.json')) {
  let applied = 0;
  for (const u of readInitialUsers(file)) {
    if (!u.temporaryPasswordHash?.startsWith('scrypt:')) continue;
    const login = (u.login || u.email || '').toLowerCase();
    const r = await run(`UPDATE users SET password_hash=?, must_change_password=1, status='active'
      WHERE email=? AND status='invited' AND password_hash IS NULL`, u.temporaryPasswordHash, login);
    applied += r.changes;
  }
  if (applied) console.log(`Temporary passwords applied to ${applied} first account(s); each must choose their own at first sign-in.`);
  return applied;
}

/** Connect, migrate and seed. Safe to call on every start and from every server instance. */
let ready: Promise<void> | null = null;
export function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await openDb();
      if (await seedWorkspaceFromFiles()) console.log('New workspace: empty, with the rope list at zero stock.');
      const removed = await removeSampleData();
      if (removed) console.log(`Old sample data removed: ${removed.orders} orders, ${removed.entries} inventory entries, ${removed.activity} activity entries.`);
      const reset = await resetWorkspace();
      if (reset) console.log(`Workspace reset to zero: ${reset.orders} orders, ${reset.entries} inventory entries, ${reset.activity} activity entries and ${reset.staff} staff accounts removed.`);
      printSeeded(await seedInitialUsers());
      await applyTemporaryPasswords();
    })();
    ready.catch(err => { console.error('Start-up failed:', err); ready = null; });
  }
  return ready;
}
