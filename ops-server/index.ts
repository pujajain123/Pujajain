import { createApp } from './app.ts';
import { ensureReady } from './setup.ts';

await ensureReady();
const port = Number(process.env.PORT || 4100);
createApp().listen(port, () => console.log(`Umami Studio operations running on http://localhost:${port}`));
