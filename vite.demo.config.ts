import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'node:path';

// Browser-only demo: the real server code runs in the page on a pure-JS SQLite build,
// bundled into one self-contained HTML file (dist-demo/index.html).
const shim = (f: string) => path.resolve('web/src/demo', f);
export default defineConfig({
  root: 'web',
  mode: 'demo',
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: shim('sqlite-shim.ts') },
      { find: /^node:crypto$/, replacement: shim('crypto-shim.ts') },
      { find: /^node:fs$/, replacement: shim('fs-shim.ts') },
      { find: /^node:path$/, replacement: shim('path-shim.ts') },
      { find: /^express$/, replacement: shim('express-shim.ts') },
    ],
  },
  build: { outDir: '../dist-demo', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 4000 },
});
