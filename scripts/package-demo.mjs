// Turns dist-demo/index.html into a body-only page for hosting inside a document skeleton.
import fs from 'node:fs';
const src = fs.readFileSync('dist-demo/index.html', 'utf8');
const head = /<head>([\s\S]*?)<\/head>/i.exec(src)[1].replace(/<meta[^>]*>\s*/gi, '');
const body = /<body>([\s\S]*?)<\/body>/i.exec(src)[1];
const title = /<title>[\s\S]*?<\/title>/i.exec(head)[0];
fs.writeFileSync('dist-demo/umami-ops.html', `${title}\n${head.replace(title, '')}\n${body}`);
console.log('dist-demo/umami-ops.html', (fs.statSync('dist-demo/umami-ops.html').size / 1e6).toFixed(2), 'MB');
