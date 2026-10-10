import { openDb } from './db.ts';
import { createApp } from './app.ts';
import { seedWorkspaceFromFiles, seedInitialUsers } from './setup.ts';

openDb();
if (seedWorkspaceFromFiles()) console.log('Workspace loaded from the exported snapshot.');
const invited = await seedInitialUsers();
if (invited.length) {
  console.log('\nFirst accounts created. Send each person their own link (single use, expires in 48 hours):');
  for (const u of invited) console.log(`  ${u.role.padEnd(5)}  ${u.name} <${u.email}>\n         ${u.link}`);
  console.log('');
}
const port = Number(process.env.PORT || 4100);
createApp().listen(port, () => console.log(`Umami Studio operations running on http://localhost:${port}`));
