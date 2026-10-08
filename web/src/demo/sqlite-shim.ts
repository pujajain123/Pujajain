// node:sqlite DatabaseSync API implemented on sql.js (pure-JS SQLite build).
import initSqlJs from 'sql.js/dist/sql-asm.js';

let SQL: any;
let initialBytes: Uint8Array | null = null;
export let current: DatabaseSync | null = null;

export async function initSql(bytes: Uint8Array | null) {
  SQL = await initSqlJs();
  initialBytes = bytes;
}

const norm = (p: any[]) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export class DatabaseSync {
  db: any;
  cache = new Map<string, any>();
  constructor(_file?: string) {
    this.db = initialBytes ? new SQL.Database(initialBytes) : new SQL.Database();
    initialBytes = null;
    current = this;
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) this.cache.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  prepare(sql: string) {
    const rows = (params: any[]) => {
      const s = this.stmt(sql);
      s.bind(norm(params));
      const out: any[] = [];
      while (s.step()) out.push(s.getAsObject());
      s.reset();
      return out;
    };
    return {
      all: (...p: any[]) => rows(p),
      get: (...p: any[]) => rows(p)[0],
      run: (...p: any[]) => {
        const s = this.stmt(sql);
        s.bind(norm(p));
        s.step();
        s.reset();
        const changes = this.db.getRowsModified();
        const id = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        return { changes, lastInsertRowid: id };
      },
    };
  }
  /** Serialise the whole database (sql.js frees prepared statements on export). */
  export(): Uint8Array {
    const bytes = this.db.export();
    this.cache.clear();
    return bytes;
  }
}
