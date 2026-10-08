// Just enough of Express to run the app's routers in-process.
type Fn = (...a: any[]) => any;
type Layer = { kind: 'use'; path: string; fn: Fn | RouterImpl } | { kind: 'route'; method: string; re: RegExp; keys: string[]; fn: Fn };

function compile(path: string) {
  const keys: string[] = [];
  const src = path.replace(/\/:([^/]+)/g, (_m, k) => (keys.push(k), '/([^/]+)')).replace(/\*$/, '.*');
  return { re: new RegExp(`^${src}/?$`), keys };
}

export class RouterImpl {
  stack: Layer[] = [];
  use(a: any, ...rest: any[]) {
    const [path, fns] = typeof a === 'string' ? [a, rest] : ['/', [a, ...rest]];
    for (const fn of fns) this.stack.push({ kind: 'use', path, fn });
    return this;
  }
  private add(method: string, path: string, fns: Fn[]) {
    const { re, keys } = compile(path);
    for (const fn of fns) this.stack.push({ kind: 'route', method, re, keys, fn });
    return this;
  }
  get(p: string, ...f: Fn[]) { return this.add('GET', p, f); }
  post(p: string, ...f: Fn[]) { return this.add('POST', p, f); }
  put(p: string, ...f: Fn[]) { return this.add('PUT', p, f); }
  patch(p: string, ...f: Fn[]) { return this.add('PATCH', p, f); }
  delete(p: string, ...f: Fn[]) { return this.add('DELETE', p, f); }
  disable() { return this; }
  set() { return this; }
  handle(req: any, res: any, out: (err?: any) => void, path: string = req.path) {
    let i = 0;
    const next = (err?: any): void => {
      if (res.headersSent && !err) return;
      const L = this.stack[i++];
      if (!L) return out(err);
      let sub = path;
      if (L.kind === 'use') {
        const p = L.path === '/' ? '' : L.path;
        if (p && path !== p && !path.startsWith(p + '/')) return next(err);
        sub = path.slice(p.length) || '/';
      } else {
        if (L.method !== req.method) return next(err);
        const m = L.re.exec(path);
        if (!m) return next(err);
        req.params = Object.fromEntries(L.keys.map((k, j) => [k, decodeURIComponent(m[j + 1])]));
      }
      const fn = L.fn;
      try {
        // Errors skip routers (as in Express) and travel straight to the error handler.
        if (fn instanceof RouterImpl) return err ? next(err) : fn.handle(req, res, next, sub);
        if (err) return fn.length === 4 ? fn(err, req, res, next) : next(err);
        if (fn.length === 4) return next();
        fn(req, res, next);
      } catch (e) {
        next(e);
      }
    };
    next();
  }
}

export function Router() {
  return new RouterImpl();
}
function express() {
  return new RouterImpl();
}
express.json = () => (_q: any, _s: any, n: Fn) => n();
express.static = () => (_q: any, _s: any, n: Fn) => n();
express.Router = Router;
export default express;
