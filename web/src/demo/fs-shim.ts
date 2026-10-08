// In-memory file store for the browser demo (attachments live only in this tab).
export const files = new Map<string, Uint8Array>();
export const mkdirSync = () => undefined;
export const existsSync = (p: string) => files.has(p);
export const rmSync = (p: string) => void files.delete(p);
export const writeFileSync = (p: string, d: Uint8Array) => void files.set(p, d);
export const readFileSync = (p: string) => {
  const f = files.get(p);
  if (!f) throw new Error(`ENOENT: ${p}`);
  return f;
};
export const createReadStream = () => ({ on: () => ({ pipe: () => undefined }), pipe: () => undefined });
export default { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, createReadStream };
