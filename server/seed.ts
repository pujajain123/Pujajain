/**
 * Demo / starting data for Umami Studios.
 *
 * Sources:
 *  - server/data/production-tracker.json — the real Master Production Sheet (7 orders, 35 product lines)
 *  - server/data/rope-workbook.json      — the real rope stock workbook (stock master, outward and purchase logs)
 *  - the reference workspace's sample orders UM-1043…UM-1048 (to show every lifecycle stage)
 *
 * Orders are replayed through the same services the app uses, with the clock pinned to past
 * dates, so the lifecycle history, ledger balances and audit trail all agree.
 */
import fs from 'node:fs';
import { all, db, DB_PATH, get, insert, run, tx } from './db.ts';
import { bootstrap } from './bootstrap.ts';
import { hashPassword, type AuthUser } from './auth.ts';
import { setClock, today } from './lib.ts';
import { createOrder, recordQualityCheck, recordDispatch, toggleChecklist as toggleOrderChecklist } from './services/orderOps.ts';
import { transition, setHold } from './services/orders.ts';
import { updateJob } from './services/jobs.ts';
import { updateStep, syncJobStatus, toggleChecklist } from './services/steps.ts';
import { postTxn } from './services/inventory.ts';
import { refreshAlerts } from './services/notifications.ts';
import tracker from './data/production-tracker.json' with { type: 'json' };
import ropeBook from './data/rope-workbook.json' with { type: 'json' };

export const DEMO_PASSWORD = 'umami123';

type Ev = { at: number; seq: number; fn: () => void };
const queue: Ev[] = [];
let seqN = 0;
const at = (date: string, hour: number, fn: () => void) =>
  queue.push({ at: new Date(`${date}T${String(hour).padStart(2, '0')}:${String((seqN * 7) % 50).padStart(2, '0')}:00+05:30`).getTime(), seq: seqN++, fn });

/** dd/mm/yy or dd-Mon-yyyy → yyyy-mm-dd */
export function sheetDate(s: string): string | null {
  if (!s?.trim()) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim());
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (m) {
    const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase()) + 1;
    return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}
const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** Normalised rope identity: SKU + thickness + colour (case and spacing differ across sheet rows). */
export const ropeKey = (sku: string, mm: string, color: string) => [sku, mm, color].map((x) => (x ?? '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');

export function seedDemo() {
  const T = today();
  tx(() => {
    // ── People (from the reference workspace) ────────────────────────────
    const role = (k: string) => get('SELECT id FROM roles WHERE key=?', k)!.id;
    const proc = (k: string) => get('SELECT id FROM job_processes WHERE key=?', k)!.id as number;
    const mkUser = (name: string, email: string, r: string, p: string | null, phone: string) =>
      insert('INSERT INTO users (name, email, phone, password_hash, role_id, primary_process_id, created_at) VALUES (?,?,?,?,?,?,?)', name, email, phone, hashPassword(DEMO_PASSWORD), role(r), p ? proc(p) : null, '2026-05-01T04:30:00.000Z');
    const admin = mkUser('Shubham Jain', 'shubham@umami.studio', 'admin', null, '+91 98200 11001');
    const staff = {
      rahul: mkUser('Rahul Mehta', 'rahul@umami.studio', 'staff', 'iron', '+91 98200 12001'),
      karan: mkUser('Karan Patel', 'karan@umami.studio', 'staff', 'iron', '+91 98200 12002'),
      amit: mkUser('Amit Shah', 'amit@umami.studio', 'staff', 'rope', '+91 98200 12003'),
      neha: mkUser('Neha Kapoor', 'neha@umami.studio', 'staff', 'fabric', '+91 98200 12004'),
      pooja: mkUser('Pooja Rao', 'pooja@umami.studio', 'staff', 'fabric', '+91 98200 12005'),
    };
    const authUser = (id: number): AuthUser =>
      get(`SELECT u.id, u.name, u.email, r.key AS role, u.primary_process_id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?`, id) as AuthUser;
    const A = authUser(admin);
    const team: Record<string, number[]> = { iron: [staff.rahul, staff.karan], rope: [staff.amit], fabric: [staff.neha, staff.pooja], tile: [staff.karan] };
    const rot: Record<string, number> = {};
    const pick = (k: string) => team[k][(rot[k] = (rot[k] ?? -1) + 1) % team[k].length];

    // ── Rope inventory: the real stock workbook (metres) ─────────────────
    const ropeMat = new Map<string, number>();
    const workbookStart = '2026-08-01';
    for (const r of (ropeBook as any).stock_master as Record<string, string>[]) {
      const sku = r['Rope Type (SKU)']?.trim() || 'Unlabelled';
      if (!r.mm?.trim() && !r.Color?.trim() && sku === 'Unlabelled') continue;
      const key = ropeKey(sku, r.mm, r.Color);
      const opening = Number(r['Opening Stock (m)'] || 0);
      const bought = Number(r['Total Purchased (m)'] || 0);
      const out = Number(r['Total Outward (m)'] || 0);
      let id = ropeMat.get(key);
      if (!id) {
        const color = r.Color?.trim() || null;
        const code = `R-${String(ropeMat.size + 1).padStart(3, '0')}`;
        id = insert(
          'INSERT INTO materials (code, name, category, variant, color, unit, reorder_level, supplier, location) VALUES (?,?,?,?,?,?,?,?,?)',
          code, [sku, r.mm?.trim(), color].filter(Boolean).join(' · '), 'rope', `${sku} · ${r.mm?.trim() ?? ''}`, color, 'm', opening + bought > 0 ? 100 : 0, null, 'Rope store',
        );
        ropeMat.set(key, id);
      }
      const mid = id;
      at(workbookStart, 9, () => {
        if (opening > 0) postTxn({ materialId: mid, type: 'opening', quantity: opening, userId: admin, reference: 'ROPE WORKBOOK', notes: 'Opening stock from rope workbook', date: workbookStart });
        if (bought > 0) postTxn({ materialId: mid, type: 'incoming', quantity: bought, userId: admin, reference: 'ROPE WORKBOOK', notes: 'Total purchased per stock master', date: workbookStart });
        if (out > 0) postTxn({ materialId: mid, type: 'consumption', quantity: Math.min(out, opening + bought), userId: admin, reference: 'ROPE WORKBOOK', notes: 'Total outward per stock master', date: workbookStart });
      });
    }
    const rope = (sku: string, mm: string, color: string) => ropeMat.get(ropeKey(sku, mm, color));

    // ── Fabric (sample: no fabric workbook was supplied) ─────────────────
    const fabrics: [string, string, string, number, number][] = [
      ['FAB-IVB', 'Ivory boucle (sample)', 'Ivory', 180, 60],
      ['FAB-MCV', 'Moss canvas (sample)', 'Moss', 150, 50],
      ['FAB-CHA', 'Charcoal outdoor acrylic (sample)', 'Charcoal', 90, 40],
    ];
    const fab: Record<string, number> = {};
    for (const [code, name, color, open, reorder] of fabrics) {
      fab[code] = insert('INSERT INTO materials (code, name, category, variant, color, unit, reorder_level, location) VALUES (?,?,?,?,?,?,?,?)', code, name, 'fabric', 'Upholstery fabric', color, 'm', reorder, 'Fabric bay');
      at('2026-09-01', 9, () => postTxn({ materialId: fab[code], type: 'opening', quantity: open, userId: admin, notes: 'Opening stock (sample)', date: '2026-09-01' }));
    }
    at('2026-10-07', 11, () => postTxn({ materialId: fab['FAB-IVB'], type: 'incoming', quantity: 75, userId: staff.karan, reference: 'TX-208', notes: 'Fabric delivery', date: '2026-10-07' }));

    // ── Real orders: the Master Production Sheet ─────────────────────────
    const custId = new Map<string, number>();
    const customer = (name: string) => {
      const k = name.trim().toUpperCase();
      if (!custId.has(k)) custId.set(k, insert('INSERT INTO customers (name, created_at) VALUES (?,?)', name.trim(), '2026-05-01T05:00:00.000Z'));
      return custId.get(k)!;
    };
    const work = (s: string) => ({ 'In Progress': 'in_progress', Done: 'done', 'Not Required': 'not_required' } as Record<string, string>)[s] ?? 'not_started';
    const qc = (s: string) => ({ Approved: 'approved', Rejected: 'rejected', 'Not Required': 'not_required' } as Record<string, string>)[s] ?? 'pending';
    const mat = (req: string, status: string) =>
      req === 'Yes' ? { required: true, status: status === 'Received' ? 'received' : 'pending' } : { required: false, note: req && req !== 'No' ? req : undefined };

    const byOrder = new Map<string, any[]>();
    for (const r of tracker as any[]) byOrder.set(r.orderNo, [...(byOrder.get(r.orderNo) ?? []), r]);
    for (const [code, rows] of byOrder) {
      const r0 = rows[0];
      const od = sheetDate(r0.orderDate)!;
      const start = sheetDate(r0.commencement) ?? od;
      const deadline = sheetDate(r0.deadline) ?? addDays(od, 30);
      const items = rows.map((r: any) => {
        const procs: string[] = [];
        if (r.metalRequired === 'Yes' || !['Not Required', ''].includes(r.structureStatus)) procs.push('iron');
        if (r.ropeRequired === 'Yes') procs.push('rope');
        if (r.fabricRequired === 'Yes' || r.foamRequired === 'Yes') procs.push('fabric');
        if (r.tileRequired === 'Yes') procs.push('tile');
        return {
          sku: r.sku === 'CUSTOM' ? `CUSTOM-${r.product.replace(/\s+/g, '')}` : r.sku,
          name: r.product.charAt(0) + r.product.slice(1).toLowerCase(),
          quantity: r.qty,
          processes: procs.map((k) => ({ process_id: proc(k), assigned_to: pick(k), start_date: start, due_date: deadline })),
          materials: [],
          material_status: {
            metal: r.metalRequired === 'Yes' ? mat('Yes', r.metalStatus) : { required: false, note: 'Blank in tracker' },
            rope: mat(r.ropeRequired, r.ropeStatus),
            fabric: mat(r.fabricRequired, r.fabricStatus),
            foam: mat(r.foamRequired, r.foamStatus),
            tile: mat(r.tileRequired, r.tileStatus),
          },
          step_status: {
            iron: { frame: work(r.structureStatus), frame_qc: qc(r.structureQca), powder: work(r.powderStatus), powder_qc: qc(r.powderQca) },
            rope: { weaving: work(r.weavingStatus), weaving_qc: qc(r.weavingQca) },
            fabric: { upholstery: work(r.upholsteryStatus), upholstery_qc: qc(r.upholsteryQca) },
            tile: { tile: work(r.tileProductionStatus === 'Pending' || r.tileProductionStatus === 'Received' ? 'Not Started' : r.tileProductionStatus) },
          },
        };
      });
      at(od, 9, () => {
        createOrder(
          { customer_id: customer(r0.client), order_date: od, commencement_date: start, deadline, sky_date: addDays(deadline, -3), priority: 'normal', source: 'Production tracker', items } as any,
          A,
          { code },
        );
      });
      const oid = () => get('SELECT id FROM orders WHERE code=?', code)!.id;
      at(od, 10, () => transition(oid(), 'reviewed', { actorId: admin, actorRole: 'admin' }));
      at(od, 11, () => transition(oid(), 'preparing', { actorId: admin, actorRole: 'admin' }));
      at(start, 13, () => transition(oid(), 'ready_for_production', { actorId: admin, actorRole: 'admin', acknowledgeWarnings: true, note: 'Production commenced' }));
      at(start, 15, () => {
        // Units follow the imported step state: a job whose steps are all finished has all units done.
        for (const j of all('SELECT id, quantity FROM jobs WHERE order_id=?', oid())) {
          const steps = all('SELECT kind, status FROM job_steps WHERE job_id=?', j.id);
          const finished = steps.every((s) => ['done', 'approved', 'not_required'].includes(s.status));
          if (finished) run('UPDATE jobs SET completed_qty=? WHERE id=?', j.quantity, j.id);
          syncJobStatus(j.id, null);
        }
      });
    }

    // ── Sample orders from the reference workspace (every lifecycle stage) ──
    const sampleRope = rope('10 no leather 2h', '6mm', 'Ds grey') ?? [...ropeMat.values()][0];
    interface Sample {
      code: string; client: string; contact: string; source: string; sku: string; name: string; qty: number; od: string; sky: string; deadline: string;
      priority: 'normal' | 'high' | 'urgent'; target: string; notes: string; rope: number; fabric: number; fabricCode: string;
      done?: Partial<Record<'iron' | 'rope' | 'fabric', number>>; who: Record<'iron' | 'rope' | 'fabric', number>; frame: string; powder: string; dori: string;
    }
    const samples: Sample[] = [
      { code: 'UM-1043', client: 'Morrow Living', contact: 'Anya Dsouza · 98450 11233', source: 'Website', sku: 'UM-LC-LUMA', name: 'Lounge chair · Luma', qty: 16, od: '2026-09-15', sky: '2026-09-23', deadline: '2026-09-30', priority: 'normal', target: 'completed', notes: 'Natural rope, ivory cushions.', rope: 60, fabric: 40, fabricCode: 'FAB-IVB', who: { iron: staff.rahul, rope: staff.amit, fabric: staff.pooja }, frame: 'MS iron', powder: 'Matte black', dori: 'DS grey' },
      { code: 'UM-1044', client: 'Atelier One', contact: 'Kabir Rao · 98110 22014', source: 'Referral', sku: 'UM-BN-SORA', name: 'Bench · Sora', qty: 8, od: '2026-09-20', sky: '2026-10-01', deadline: '2026-10-04', priority: 'normal', target: 'ready_for_dispatch', notes: 'Client collecting via own transport.', rope: 30, fabric: 18, fabricCode: 'FAB-MCV', who: { iron: staff.karan, rope: staff.amit, fabric: staff.neha }, frame: 'CR', powder: 'Bronze', dori: 'DS grey' },
      { code: 'UM-1045', client: 'Nook & Nest', contact: 'Ira Kapoor · 98200 33015', source: 'Direct', sku: 'UM-ST-ARLO', name: 'Side table · Arlo', qty: 48, od: '2026-09-24', sky: '2026-10-05', deadline: '2026-10-08', priority: 'high', target: 'in_production', notes: 'Stone top from Jaipur supplier.', rope: 96, fabric: 0, fabricCode: '', done: { iron: 1, rope: 0.38 }, who: { iron: staff.rahul, rope: staff.amit, fabric: staff.pooja }, frame: 'MS iron', powder: 'Matte black', dori: 'DS grey' },
      { code: 'UM-1046', client: 'Studio North', contact: 'Rhea Thomas · 98111 72042', source: 'Website', sku: 'UM-AC-MIRA', name: 'Accent chair · Mira', qty: 20, od: '2026-09-28', sky: '2026-10-07', deadline: '2026-10-10', priority: 'urgent', target: 'quality_check', notes: 'QC check finish consistency and leg level.', rope: 40, fabric: 55, fabricCode: 'FAB-MCV', who: { iron: staff.karan, rope: staff.amit, fabric: staff.neha }, frame: 'MS iron', powder: 'Black', dori: 'Charcoal' },
      { code: 'UM-1047', client: 'The June House', contact: 'Tara Menon · 98450 66017', source: 'Trade show', sku: 'UM-DS-COVE', name: 'Dining set · Cove', qty: 12, od: '2026-10-03', sky: '2026-10-13', deadline: '2026-10-16', priority: 'normal', target: 'preparing', notes: 'Six chairs and table per set.', rope: 48, fabric: 30, fabricCode: 'FAB-CHA', who: { iron: staff.rahul, rope: staff.amit, fabric: staff.pooja }, frame: 'Aluminium', powder: 'Sand', dori: 'Natural' },
      { code: 'UM-1048', client: 'Casa Forma', contact: 'Maya Shah · 98765 41020', source: 'Direct', sku: 'UM-LC-LUMA', name: 'Lounge chair · Luma', qty: 36, od: '2026-10-02', sky: '2026-10-11', deadline: '2026-10-20', priority: 'high', target: 'in_production', notes: 'Natural oak frame, ivory rope finish.', rope: 82, fabric: 96, fabricCode: 'FAB-IVB', done: { iron: 1, rope: 0.67, fabric: 0.22 }, who: { iron: staff.rahul, rope: staff.amit, fabric: staff.neha }, frame: 'MS iron', powder: 'Ivory', dori: 'Ivory' },
    ];
    for (const s of samples) {
      const [contactName, phone] = s.contact.split(' · ');
      const cid = insert('INSERT INTO customers (name, contact_person, phone, created_at) VALUES (?,?,?,?)', s.client, contactName, phone, '2026-09-01T05:00:00.000Z');
      const procs = (['iron', 'rope', 'fabric'] as const).filter((k) => k !== 'fabric' || s.fabric > 0);
      const plan: Record<string, [number, number]> = { iron: [0, 0.4], rope: [0.35, 0.75], fabric: [0.5, 0.9] };
      const span = Math.max(4, Math.round((Date.parse(s.sky) - Date.parse(s.od)) / 864e5));
      at(s.od, 10, () =>
        createOrder(
          {
            customer_id: cid, order_date: s.od, commencement_date: addDays(s.od, 1), sky_date: s.sky, deadline: s.deadline, priority: s.priority, source: s.source, notes: s.notes,
            items: [{
              sku: s.sku, name: s.name, quantity: s.qty, frame_material: s.frame, powder_color: s.powder, dori_color: s.dori, rope_code: '10 no leather 2h · 6mm',
              rope_required: s.rope, fabric_code: s.fabricCode || null, fabric_company: s.fabric ? 'Textura Fabrics' : null, fabric_qty: s.fabric || null,
              seat_height: s.name.includes('table') ? null : '42 cm', back_cushion: s.fabric ? 'Yes' : null,
              processes: procs.map((k) => ({ process_id: proc(k), assigned_to: s.who[k], start_date: addDays(s.od, Math.round(span * plan[k][0])), due_date: addDays(s.od, Math.round(span * plan[k][1])) })),
              materials: [
                ...(sampleRope ? [{ process_id: proc('rope'), material_id: sampleRope, required_qty: s.rope }] : []),
                ...(s.fabric ? [{ process_id: proc('fabric'), material_id: fab[s.fabricCode], required_qty: s.fabric }] : []),
              ],
            }],
          } as any,
          A,
          { code: s.code },
        ),
      );
      const oid = () => get('SELECT id FROM orders WHERE code=?', s.code)!.id;
      const order = ['received', 'reviewed', 'preparing', 'ready_for_production', 'in_production', 'quality_check', 'ready_for_dispatch', 'dispatched', 'completed'];
      const reach = (stage: string) => order.indexOf(s.target) >= order.indexOf(stage);
      if (!reach('reviewed')) continue;
      at(s.od, 12, () => transition(oid(), 'reviewed', { actorId: admin, actorRole: 'admin', note: 'Specs and pricing confirmed' }));
      at(s.od, 14, () => transition(oid(), 'preparing', { actorId: admin, actorRole: 'admin' }));
      at(s.od, 16, () => {
        // Mark materials received for orders already in production.
        if (reach('ready_for_production')) run(`UPDATE item_materials SET status='received' WHERE required=1 AND order_item_id IN (SELECT id FROM order_items WHERE order_id=?)`, oid());
        for (const c of all(`SELECT id FROM order_checklist_items WHERE order_id=? AND stage='preparing'`, oid()).slice(0, reach('ready_for_production') ? 99 : 2)) toggleOrderChecklist(oid(), c.id, true, A);
      });
      if (!reach('ready_for_production')) continue;
      at(addDays(s.od, 1), 10, () => transition(oid(), 'ready_for_production', { actorId: admin, actorRole: 'admin', acknowledgeWarnings: true }));
      const finishAll = reach('quality_check');
      for (const k of procs) {
        const share = finishAll ? 1 : (s.done?.[k] ?? 0);
        if (!share) continue;
        const day = addDays(s.od, Math.max(1, Math.round(span * plan[k][1] * (finishAll ? 1 : 0.6))));
        const d = day > T ? T : day;
        at(d, 12, () => {
          const j = get('SELECT j.id, j.quantity, j.assigned_to FROM jobs j JOIN job_processes p ON p.id=j.process_id WHERE j.order_id=? AND p.key=?', oid(), k)!;
          const u = authUser(j.assigned_to);
          const stepKeys = all('SELECT key, kind FROM job_steps WHERE job_id=? ORDER BY sequence', j.id);
          // Walk the steps in order; for partial jobs stop before the final inspection.
          for (const st of stepKeys) {
            if (share < 1 && st === stepKeys[stepKeys.length - 1]) break;
            if (share < 1 && k !== 'iron' && st.kind === 'work') { updateStep(j.id, st.key, 'in_progress', null, u); break; }
            updateStep(j.id, st.key, st.kind === 'work' ? 'done' : 'approved', st.kind === 'qc' ? 'Checked against job sheet' : null, u);
          }
          if (k === 'iron') for (const c of all('SELECT key FROM job_checklist WHERE job_id=?', j.id).slice(0, share >= 1 ? 10 : 4)) toggleChecklist(j.id, c.key, true, u);
          const per = k === 'rope' ? s.rope / s.qty : k === 'fabric' ? s.fabric / s.qty : 0;
          const qty = Math.round(j.quantity * share);
          updateJob(j.id, { completed_qty: qty, material_used: per ? Math.round(per * qty * 10) / 10 : undefined, note: share >= 1 ? 'All units finished' : 'Batch finished' }, u);
        });
      }
      if (s.code === 'UM-1045')
        at(addDays(T, -2), 17, () => {
          const j = get(`SELECT j.id, j.assigned_to FROM jobs j JOIN job_processes p ON p.id=j.process_id WHERE j.order_id=? AND p.key='rope'`, oid())!;
          updateJob(j.id, { status: 'delayed', delay_reason: 'Waiting for 6mm DS grey rope — purchase pending', note: 'Weaving paused' }, authUser(j.assigned_to));
        });
      if (!reach('ready_for_dispatch')) continue;
      at(addDays(s.sky, 0), 17, () => recordQualityCheck(oid(), { result: 'passed', qty_checked: s.qty, qty_passed: s.qty, qty_rejected: 0, notes: 'Weave tension, welds and stitching checked' }, A));
      if (!reach('dispatched')) continue;
      at(addDays(s.sky, 1), 11, () => recordDispatch(oid(), { dispatched_at: `${addDays(s.sky, 1)}T11:30`, quantity: s.qty, transporter: 'Blue Dart', tracking_ref: `BD-${s.code.replace('-', '')}-28`, invoice_no: `UMS/26-27/${s.code.slice(3)}`, packages: Math.ceil(s.qty / 2) }, A));
      if (s.target === 'completed') at(addDays(s.sky, 3), 12, () => transition(oid(), 'completed', { actorId: admin, actorRole: 'admin', note: 'Delivery confirmed by client' }));
    }
    at('2026-10-06', 15, () => {
      const o = get(`SELECT id FROM orders WHERE code='UM-0138-26'`);
      if (o) setHold(o.id, true, 'Client revising cushion fabric — awaiting approval', admin);
    });

    // Replay in chronological order with the clock pinned.
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const nowMs = Date.now();
    for (const e of queue) {
      setClock(new Date(Math.min(e.at, nowMs - 60_000)));
      try {
        e.fn();
      } catch (err: any) {
        console.warn('seed step skipped:', new Date(e.at).toISOString(), err?.message ?? err, (err?.stack ?? '').split('\n')[1]);
      }
    }
    setClock(null);
    run(`UPDATE notifications SET read_at = created_at WHERE severity = 'info' AND created_at < ?`, addDays(T, -2));
  });
  return refreshAlerts();
}

// CLI: `npm run seed` wipes the database and loads the starting data.
if (process.argv[1]?.endsWith('seed.ts')) {
  if (process.argv.includes('--reset')) for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
  db();
  bootstrap();
  if (get('SELECT 1 FROM users LIMIT 1')) console.log('Database already has data. Use `npm run seed` (with --reset) to start over.');
  else {
    await seedDemo();
    const c = (t: string) => get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
    console.log(`Seeded: ${c('orders')} orders, ${c('order_items')} product lines, ${c('jobs')} job sheets, ${c('materials')} materials, ${c('inventory_transactions')} stock movements.`);
    console.log(`Sign in as shubham@umami.studio / ${DEMO_PASSWORD} (admin) or amit@umami.studio / ${DEMO_PASSWORD} (staff).`);
  }
}
