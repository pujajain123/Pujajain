import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  resolve: { alias: [{ find: /^\.\/demo\/backend$/, replacement: path.resolve('web/src/demo/backend-stub.ts') }] },
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
