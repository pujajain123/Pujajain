// Browser stand-in for node:crypto. The demo hash is NOT for production use.
import { Buffer } from 'buffer';
export function randomBytes(n: number) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return Buffer.from(a);
}
export function scryptSync(pw: string, salt: string, len: number) {
  const input = new TextEncoder().encode(`${salt}:${pw}`);
  const out = new Uint8Array(len);
  let h = 2166136261;
  for (let r = 0; r < 64; r++)
    for (let i = 0; i < len; i++) {
      h ^= input[(i + r) % input.length] + out[(i + 7) % len];
      h = Math.imul(h, 16777619) >>> 0;
      out[i] ^= h & 0xff;
    }
  return Buffer.from(out);
}
export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
export default { randomBytes, scryptSync, timingSafeEqual };
