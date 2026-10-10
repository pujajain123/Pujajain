// Builds the Vercel deployment (Build Output API v3) for the operations server:
//   .vercel/output/static            public dashboard code, styles and logo
//   .vercel/output/functions/index.func  the bundled server, with the files it reads at run time
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const out = '.vercel/output';
const func = `${out}/functions/index.func`;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(`${out}/static`, { recursive: true });
fs.mkdirSync(func, { recursive: true });

// Public assets only: workspace data files and the browser-only seed stay behind the server's sign-in checks.
for (const f of fs.readdirSync('codex-app')) {
  if (/^seed(-data)?\.js$/.test(f) || !/\.(js|css|png)$/.test(f)) continue;
  fs.copyFileSync(path.join('codex-app', f), `${out}/static/${f}`);
}

await build({
  entryPoints: ['ops-server/vercel-entry.ts'],
  outfile: `${func}/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@electric-sql/pglite', 'pg-native'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});

for (const f of ['codex-app/index.html', 'codex-app/seed-data.js', 'codex-app/rope_inventory_data.json', 'config/initial-users.json']) {
  fs.mkdirSync(path.dirname(`${func}/${f}`), { recursive: true });
  fs.copyFileSync(f, `${func}/${f}`);
}
fs.writeFileSync(`${func}/.vc-config.json`, JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 30 }, null, 2));
fs.writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '/(.*)\\.(js|css|png)$', headers: { 'Cache-Control': 'public, max-age=300' }, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index' },
  ],
}, null, 2));
console.log('Vercel output written to .vercel/output');
