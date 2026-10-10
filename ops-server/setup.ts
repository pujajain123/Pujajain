import fs from 'node:fs';
import path from 'node:path';
import { get, tx, openDb } from './db.ts';
import { seedWorkspace } from './workspace.ts';
import { createUser } from './accounts.ts';
import type { Role } from './auth.ts';

export const ROOT = process.env.OPS_ROOT || process.cwd();

/** Loads the exported workspace snapshot (codex-app/seed-data.js) and rope workbook into an empty database. */
export async function seedWorkspaceFromFiles() {
  const src = fs.readFileSync(path.join(ROOT, 'codex-app/seed-data.js'), 'utf8');
  const snapshot = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
  const rope = JSON.parse(fs.readFileSync(path.join(ROOT, 'codex-app/rope_inventory_data.json'), 'utf8'));
  return seedWorkspace(snapshot, rope, snapshot.productionTracker || []);
}

type Seeded = { name: string; role: Role; login: string; link: string; password?: string };

/** Creates the developer-provided first accounts once (database has no users yet) and returns how each signs in. */
export async function seedInitialUsers(file = path.join(ROOT, 'config/initial-users.json')): Promise<Seeded[]> {
  if (!fs.existsSync(file)) return [];
  const { users } = JSON.parse(fs.readFileSync(file, 'utf8')) as { users: { name: string; email?: string; role: Role }[] };
  return tx(async () => {
    await get('SELECT pg_advisory_xact_lock(727003)');
    if (await get('SELECT 1 FROM users LIMIT 1')) return [];
    const out: Seeded[] = [];
    for (const u of users) {
      const r = await createUser(null, u);
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

/** Connect, migrate and seed. Safe to call on every start and from every server instance. */
let ready: Promise<void> | null = null;
export function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await openDb();
      if (await seedWorkspaceFromFiles()) console.log('Workspace loaded from the exported snapshot.');
      printSeeded(await seedInitialUsers());
    })();
    ready.catch(err => { console.error('Start-up failed:', err); ready = null; });
  }
  return ready;
}
