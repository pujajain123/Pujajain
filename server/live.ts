import type { Response } from 'express';

/** Server-Sent Events hub: every mutation broadcasts which areas changed so open screens refresh. */
type Client = { res: Response; userId: number };
const clients = new Set<Client>();

export function subscribe(res: Response, userId: number) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const c = { res, userId };
  clients.add(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(c);
  });
}

let pending: Set<string> | null = null;
/** Coalesce broadcasts raised during one request into a single event. */
export function broadcast(...topics: string[]) {
  if (!pending) {
    pending = new Set();
    setImmediate(() => {
      const payload = JSON.stringify({ topics: [...pending!], at: Date.now() });
      pending = null;
      for (const c of clients) c.res.write(`event: change\ndata: ${payload}\n\n`);
    });
  }
  topics.forEach((t) => pending!.add(t));
}

export const liveClientCount = () => clients.size;
