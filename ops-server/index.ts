import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { seedWorkspaceFromFiles, seedInitialUsers } from './setup.ts';

openDb();
if (seedWorkspaceFromFiles()) console.log('Workspace loaded from the exported snapshot.');
const invited = await seedInitialUsers();
if (invited.length) {
  console.log('\nFirst accounts created. Give each person only their own details:');
  for (const u of invited) {
    console.log(`  ${u.role.padEnd(5)}  ${u.name} <${u.login}>`);
    console.log('password' in u
      ? `         sign in at ${u.link} with temporary password ${u.password} (must be changed at first sign-in)`
      : `         set-password link (single use, 48 hours): ${u.link}`);
  }
  console.log('');
}
const port = Number(process.env.PORT || 4100);
createApp().listen(port, () => console.log(`Umami Studio operations running on http://localhost:${port}`));
