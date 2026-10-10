/* Developer commands:
 *   npm run ops:user -- invite --name "Name" --email person@company.com [--role admin|staff]
 *   npm run ops:user -- link --email person@company.com      (new set-password link, 48 hours)
 *   npm run ops:user -- list
 *   npm run ops:backup                                         (copy of the database in data/ops/backups)
 */
import path from 'node:path';
import fs from 'node:fs';
import { openDb, get, conn, DATA_DIR } from './db.ts';
import { createUser, listUsers } from './accounts.ts';
import { issueToken, setPasswordLink } from './auth.ts';

openDb();
const [cmd, ...rest] = process.argv.slice(2);
const arg = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'invite') {
  const r = await createUser(null, { name: arg('name'), email: arg('email'), role: arg('role') === 'admin' ? 'admin' : 'staff' });
  console.log('inviteLink' in r ? `Set-password link for ${r.user.email}:\n${r.inviteLink}` : `Login ID: ${r.loginId}\nPassword: ${r.password}`);
} else if (cmd === 'link') {
  const u = get('SELECT * FROM users WHERE email=?', String(arg('email') || '').toLowerCase());
  if (!u) throw new Error('No account with that email.');
  console.log(setPasswordLink(issueToken(u.id, u.status === 'invited' ? 'invite' : 'reset', null)));
} else if (cmd === 'list') {
  console.table(listUsers().map(u => ({ name: u.name, login: u.email, role: u.role, status: u.status })));
} else if (cmd === 'backup') {
  const dir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ops-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  conn().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  console.log(`Backup written to ${file}`);
} else {
  console.log('Commands: invite, link, list, backup');
}
