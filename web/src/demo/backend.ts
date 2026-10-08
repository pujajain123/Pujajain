// Runs the real Umami server (routes, services, status engine, seed) inside the browser.
import './polyfill';
import { initSql, current } from './sqlite-shim';

const STORE_KEY = 'umami-demo-db-v2'; // bump when the schema changes so old browser copies are replaced
const SESSION_KEY = 'umami-demo-session-v2';

type Listener = (topics: string[]) => void;
const listeners = new Set<Listener>();
let app: any;
let cookie = '';
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const b64 = {
  enc(bytes: Uint8Array) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str: string) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function load(): Uint8Array | null {
  try {
    const s = localStorage.getItem(STORE_KEY);
    cookie = localStorage.getItem(SESSION_KEY) ?? '';
    return s ? b64.dec(s) : null;
  } catch {
    return null;
  }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (current) localStorage.setItem(STORE_KEY, b64.enc(current.export()));
      localStorage.setItem(SESSION_KEY, cookie);
    } catch {
      /* storage unavailable: the demo still works for this visit */
    }
  }, 400);
}

export async function startDemo() {
  await initSql(load());
  const [{ db, get }, { bootstrap }, { createApp }, { seedDemo }, { subscribe }, { refreshAlerts }] = await Promise.all([
    import('../../../server/db.ts'),
    import('../../../server/bootstrap.ts'),
    import('../../../server/app.ts'),
    import('../../../server/seed.ts'),
    import('../../../server/live.ts'),
    import('../../../server/services/notifications.ts'),
  ]);
  db();
  bootstrap();
  if (!get('SELECT 1 FROM users LIMIT 1')) {
    cookie = '';
    await seedDemo();
    save();
  } else await refreshAlerts();
  app = createApp();
  // Live updates: a fake SSE response that turns server broadcasts into in-page events.
  subscribe(
    {
      writeHead() {},
      write(chunk: string) {
        const m = /^event: change\ndata: (.*)\n/m.exec(chunk);
        if (m) {
          const { topics } = JSON.parse(m[1]);
          listeners.forEach((l) => l(topics));
        }
      },
      on() {},
    } as any,
    0,
  );
}

export function onChange(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function resetDemo() {
  try {
    localStorage.removeItem(STORE_KEY);
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
  location.reload();
}

export function request(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const [path, query = ''] = url.split('?');
    const req: any = {
      method,
      path,
      url,
      query: Object.fromEntries(new URLSearchParams(query)),
      body: body ?? {},
      headers: { cookie, 'content-type': 'application/json', 'content-length': body === undefined ? '0' : '1' },
      ip: 'demo',
      params: {},
      is: () => true,
    };
    const res: any = {
      statusCode: 200,
      headersSent: false,
      status(c: number) {
        this.statusCode = c;
        return this;
      },
      setHeader(k: string, v: string) {
        if (k.toLowerCase() === 'set-cookie') cookie = v.includes('Max-Age=0') ? '' : v.split(';')[0];
      },
      json(data: any) {
        this.headersSent = true;
        if (method !== 'GET') save();
        resolve({ status: this.statusCode, data });
      },
      end() {
        this.headersSent = true;
        resolve({ status: this.statusCode, data: null });
      },
      send(d: any) {
        this.json(d);
      },
      sendFile() {
        this.end();
      },
      writeHead() {},
      write() {},
      on() {},
    };
    app.handle(req, res, (err: any) => {
      if (res.headersSent) return;
      if (err) console.error(err);
      res.status(err ? 500 : 404).json({ error: err ? 'Something went wrong' : 'Not found' });
    });
  });
}
