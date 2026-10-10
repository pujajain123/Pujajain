import fs from 'node:fs';
import path from 'node:path';
import { get } from './db.ts';
import { seedWorkspace } from './workspace.ts';
import { createUser } from './accounts.ts';
import type { Role } from './auth.ts';

/** Loads the exported workspace snapshot (codex-app/seed-data.js) and rope workbook into an empty database. */
export function seedWorkspaceFromFiles() {
  const src = fs.readFileSync(path.resolve('codex-app/seed-data.js'), 'utf8');
  const snapshot = JSON.parse(src.slice(src.indexOf('=') + 1).trim().replace(/;\s*$/, ''));
  const rope = JSON.parse(fs.readFileSync(path.resolve('codex-app/rope_inventory_data.json'), 'utf8'));
  return seedWorkspace(snapshot, rope, snapshot.productionTracker || []);
}

/** Creates the developer-provided first accounts once, and returns their set-password links. */
export async function seedInitialUsers(file = path.resolve('config/initial-users.json')) {
  if (get('SELECT 1 FROM users LIMIT 1') || !fs.existsSync(file)) return [];
  const { users } = JSON.parse(fs.readFileSync(file, 'utf8')) as { users: { name: string; email: string; role: Role }[] };
  const out = [];
  for (const u of users) {
    const r = await createUser(null, u);
    out.push({ name: u.name, email: u.email, role: u.role, link: 'inviteLink' in r ? r.inviteLink : '' });
  }
  return out;
}
