/** RFC 4180 CSV parser (quoted fields, embedded commas/newlines, "" escapes). Returns rows keyed by header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
  if (!header) return [];
  const keys = header.map(norm);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Read a mapped column (header matching ignores case and spacing). */
export const pick = (row: Record<string, string>, header?: string) => (header ? (row[norm(header)] ?? '') : '');

export function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.replace(/,/g, '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parse sheet dates: ISO, DD/MM/YYYY (or MM/DD/YYYY when configured), DD-Mon-YYYY, "20 Oct 2026". */
export function parseDate(v: string | undefined, format = 'DD/MM/YYYY'): string | null {
  if (!v?.trim()) return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return format.startsWith('MM') ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]);
  }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    if (mo) return iso(y, mo, +m[1]);
  }
  return null;
}

function iso(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
