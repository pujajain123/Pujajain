// Packages the Codex-built dashboard (codex-app/) into one body-only page for hosting,
// with its stylesheet and scripts inlined. rope_inventory_data.json is published next to it.
import fs from 'node:fs';
const dir = 'codex-app';
const read = (f) => fs.readFileSync(`${dir}/${f}`, 'utf8');
const js = (f) => `<script>\n${read(f).replace(/<\/script/gi, '<\\/script')}\n</script>`;
let html = read('index.html');
html = html.replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${read('styles.css')}\n</style>`);
for (const f of ['seed-data.js', 'seed.js', 'app.js', 'portal-updates.js', 'iron-job-sheet.js']) html = html.replace(`<script src="${f}"></script>`, js(f));
const head = /<head>([\s\S]*?)<\/head>/i.exec(html)[1].replace(/<meta[^>]*>\s*/gi, '').replace(/<title>[\s\S]*?<\/title>/i, '');
const body = /<body>([\s\S]*?)<\/body>/i.exec(html)[1];
fs.mkdirSync('dist-codex', { recursive: true });
fs.writeFileSync('dist-codex/umami-studios.html', `<title>Umami Studios Operations</title>\n${head}\n${body}`);
fs.copyFileSync(`${dir}/rope_inventory_data.json`, 'dist-codex/rope_inventory_data.json');
console.log('dist-codex/umami-studios.html', (fs.statSync('dist-codex/umami-studios.html').size / 1e3).toFixed(0), 'KB');
