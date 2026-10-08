import { db, get } from './db.ts';
import { bootstrap } from './bootstrap.ts';
import { createApp } from './app.ts';
import { refreshAlerts } from './services/notifications.ts';
import { seedDemo } from './seed.ts';

db();
bootstrap();
if (!get('SELECT 1 FROM users LIMIT 1')) {
  console.log('Empty database — loading demo data…');
  seedDemo();
}

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => console.log(`Umami Ops API listening on http://localhost:${port}`));

const tick = () => refreshAlerts().catch((e) => console.error('alert refresh failed', e));
tick();
setInterval(tick, 10 * 60_000);
