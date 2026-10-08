// Minimal Node globals so the unmodified server modules run in the browser demo.
import { Buffer } from 'buffer';
const g = globalThis as any;
g.process ??= { env: {}, argv: [], exitCode: 0 };
g.Buffer ??= Buffer;
g.setImmediate ??= (fn: () => void) => setTimeout(fn, 0);
