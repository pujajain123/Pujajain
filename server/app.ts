import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { errorHandler } from './lib.ts';
import { loadUser, requireAuth, requireRole } from './auth.ts';
import ordersRouter, { attachmentDownload, dispatchBoard, masterProduction, trackerList, trackerPatch } from './routes/orders.ts';
import jobsRouter from './routes/jobs.ts';
import inventoryRouter from './routes/inventory.ts';
import { authRouter, miscRouter } from './routes/misc.ts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '12mb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // Basic CSRF defence for cookie auth: state-changing API calls must be JSON.
    if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json') && req.headers['content-length'] !== '0') {
      return res.status(415).json({ error: 'Requests must be JSON' });
    }
    next();
  });
  app.use(loadUser);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth);
  app.use('/api/orders', ordersRouter);
  app.get('/api/attachments/:id', attachmentDownload);
  app.get('/api/production/master', masterProduction);
  app.get('/api/production/tracker', trackerList);
  app.patch('/api/production/tracker/:itemId', trackerPatch);
  app.get('/api/dispatch', requireRole('admin'), dispatchBoard);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/inventory', inventoryRouter);
  app.use('/api', miscRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  const dist = path.resolve('dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
