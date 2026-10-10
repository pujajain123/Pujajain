/* Developer commands (use the same DATABASE_URL / OPS_DATA_DIR as the server):
 *   npm run ops:user -- invite --name "Name" --email person@company.com [--role admin|staff]
 *   npm run ops:user -- link --email person@company.com      (new set-password link, 48 hours)
 *   npm run ops:user -- list
 */
import { openDb, get, closeDb } from './db.ts';
import { createUser, listUsers } from './accounts.ts';
import { issueToken, setPasswordLink } from './auth.ts';

await openDb();
const [cmd, ...rest] = process.argv.slice(2);
const arg = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'invite') {
  const r = await createUser(null, { name: arg('name'), email: arg('email'), role: arg('role') === 'admin' ? 'admin' : 'staff' });
  console.log('inviteLink' in r ? `Set-password link for ${r.user.email}:\n${r.inviteLink}` : `Login ID: ${r.loginId}\nPassword: ${r.password}`);
} else if (cmd === 'link') {
  const u = await get('SELECT * FROM users WHERE email=?', String(arg('email') || '').toLowerCase());
  if (!u) throw new Error('No account with that email.');
  console.log(setPasswordLink(await issueToken(u.id, u.status === 'invited' ? 'invite' : 'reset', null)));
} else if (cmd === 'list') {
  console.table((await listUsers()).map(u => ({ name: u.name, login: u.email, role: u.role, status: u.status })));
} else {
  console.log('Commands: invite, link, list');
}
await closeDb();
