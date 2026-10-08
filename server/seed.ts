/**
 * Demo data for Umami Studios. Instead of inserting rows directly, the seeder *replays*
 * realistic operations through the same services the app uses (create order → review →
 * prepare → job sheet updates → QC → dispatch), with the clock pinned to past dates.
 * The result is a coherent dataset: timelines, ledger balances and audit history all agree.
 */
import fs from 'node:fs';
import { all, db, DB_PATH, get, insert, run, tx } from './db.ts';
import { bootstrap } from './bootstrap.ts';
import { hashPassword, type AuthUser } from './auth.ts';
import { addDays, setClock, today } from './lib.ts';
import type { OrderStage, Priority } from '../shared/domain.ts';
import { createOrder } from './services/orderOps.ts';
import { recordDispatch, recordQualityCheck, toggleChecklist, addOrderNote } from './services/orderOps.ts';
import { transition, setHold, cancelOrder, stageLabel } from './services/orders.ts';
import { updateJob } from './services/jobs.ts';
import { postTxn, autoAllocateMaterial } from './services/inventory.ts';
import { refreshAlerts } from './services/notifications.ts';

export const DEMO_PASSWORD = 'umami123';

// Deterministic pseudo-random so the demo is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

type Ev = { at: number; seq: number; fn: () => void };
const queue: Ev[] = [];
let seqN = 0;
const at = (date: string, hour: number, fn: () => void) => {
  const minute = Math.floor(rand() * 50);
  queue.push({ at: new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`).getTime(), seq: seqN++, fn });
};

export function seedDemo() {
  const T = today();
  tx(() => {
    // ── People ───────────────────────────────────────────────────────────
    const role = (k: string) => get('SELECT id FROM roles WHERE key=?', k)!.id;
    const proc = (k: string) => get('SELECT id FROM job_processes WHERE key=?', k)!.id;
    const mkUser = (name: string, email: string, r: string, p: string | null, phone: string) =>
      insert(
        'INSERT INTO users (name, email, phone, password_hash, role_id, primary_process_id, created_at) VALUES (?,?,?,?,?,?,?)',
        name, email, phone, hashPassword(DEMO_PASSWORD), role(r), p ? proc(p) : null, `${addDays(T, -120)}T04:30:00.000Z`,
      );
    const admin = mkUser('Studio Admin', 'admin@umami.studio', 'admin', null, '+91 98200 11001');
    const ops = mkUser('Karan Mehta', 'karan@umami.studio', 'admin', null, '+91 98200 11002');
    const staff = {
      rahul: mkUser('Rahul', 'rahul@umami.studio', 'staff', 'iron', '+91 98200 12001'),
      sunil: mkUser('Sunil', 'sunil@umami.studio', 'staff', 'iron', '+91 98200 12002'),
      amit: mkUser('Amit', 'amit@umami.studio', 'staff', 'rope', '+91 98200 12003'),
      farida: mkUser('Farida', 'farida@umami.studio', 'staff', 'rope', '+91 98200 12004'),
      neha: mkUser('Neha', 'neha@umami.studio', 'staff', 'fabric', '+91 98200 12005'),
      pooja: mkUser('Pooja', 'pooja@umami.studio', 'staff', 'fabric', '+91 98200 12006'),
      vikram: mkUser('Vikram', 'vikram@umami.studio', 'staff', null, '+91 98200 12007'),
    };
    const authUser = (id: number): AuthUser => {
      const u = get(`SELECT u.id, u.name, u.email, r.key AS role, u.primary_process_id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?`, id)!;
      return u as AuthUser;
    };
    const A = authUser(admin);
    const K = authUser(ops);
    const team = { iron: [staff.rahul, staff.sunil], rope: [staff.amit, staff.farida], fabric: [staff.neha, staff.pooja] };

    // ── Clients ──────────────────────────────────────────────────────────
    const customers = [
      ['ABC Interiors', 'Meera Shah', '+91 98190 20001', 'projects@abcinteriors.in', 'Lower Parel', 'Mumbai'],
      ['Casa Verde Hospitality', 'Rohan D’Souza', '+91 98230 20002', 'purchase@casaverde.in', 'Candolim', 'Goa'],
      ['Studio Nine Architects', 'Ananya Rao', '+91 98450 20003', 'ananya@studionine.in', 'Indiranagar', 'Bengaluru'],
      ['Coastline Villas', 'Vivek Nair', '+91 94470 20004', 'vivek@coastlinevillas.com', 'Kovalam', 'Thiruvananthapuram'],
      ['Brew & Bloom Café', 'Sana Qureshi', '+91 99300 20005', 'sana@brewbloom.cafe', 'Bandra West', 'Mumbai'],
      ['Aranya Eco Retreat', 'Dev Malhotra', '+91 98100 20006', 'ops@aranyaretreat.in', 'Rishikesh', 'Dehradun'],
      ['Urban Nest Homes', 'Kavya Iyer', '+91 98840 20007', 'kavya@urbannest.in', 'Adyar', 'Chennai'],
      ['Saffron Courtyard Hotel', 'Arjun Singh', '+91 98290 20008', 'gm@saffroncourtyard.in', 'Civil Lines', 'Jaipur'],
      ['Palm Grove Resorts', 'Nikhil Menon', '+91 98950 20009', 'procurement@palmgrove.in', 'Kumarakom', 'Kottayam'],
      ['Mehra Residence', 'Ritu Mehra', '+91 98110 20010', 'ritu.mehra@gmail.com', 'Vasant Vihar', 'New Delhi'],
    ];
    const cust: Record<string, number> = {};
    for (const [name, contact, phone, email, area, city] of customers)
      cust[name] = insert(
        'INSERT INTO customers (name, contact_person, phone, email, address, city, created_at) VALUES (?,?,?,?,?,?,?)',
        name, contact, phone, email, `${area}, ${city}`, city, `${addDays(T, -120)}T05:00:00.000Z`,
      );

    // ── Materials (Rope Stock + Fabric Stock sheets) ────────────────────
    const mats: [string, string, string, string, string, string, number, string, string][] = [
      ['ROPE-OLF6-CHR', 'Olefin Rope 6mm — Charcoal', 'rope', '6mm Olefin, UV stabilised', 'Charcoal', 'kg', 60, 'Shree Ropes, Surat', 'Rack R1'],
      ['ROPE-OLF6-SND', 'Olefin Rope 6mm — Sand', 'rope', '6mm Olefin, UV stabilised', 'Sand', 'kg', 60, 'Shree Ropes, Surat', 'Rack R1'],
      ['ROPE-OLF8-NAT', 'Olefin Rope 8mm — Natural', 'rope', '8mm Olefin twisted', 'Natural', 'kg', 50, 'Shree Ropes, Surat', 'Rack R2'],
      ['ROPE-PEF12-IVY', 'PE Flat Rope 12mm — Ivory', 'rope', '12mm flat polyethylene', 'Ivory', 'kg', 40, 'Polywave Industries', 'Rack R3'],
      ['ROPE-PB5-TEA', 'Polyester Braided 5mm — Teal', 'rope', '5mm braided polyester', 'Teal', 'kg', 25, 'Polywave Industries', 'Rack R3'],
      ['ROPE-JUT10-NAT', 'Jute Rope 10mm — Natural', 'rope', '10mm 3-ply jute (indoor)', 'Natural', 'kg', 30, 'Bengal Jute Co.', 'Rack R4'],
      ['FAB-ACR280-ECR', 'Outdoor Acrylic 280 GSM — Ecru', 'fabric', 'Solution-dyed acrylic, 280 GSM', 'Ecru', 'm', 120, 'Textura Fabrics, Ahmedabad', 'Bay F1'],
      ['FAB-ACR280-CHR', 'Outdoor Acrylic 280 GSM — Charcoal', 'fabric', 'Solution-dyed acrylic, 280 GSM', 'Charcoal', 'm', 100, 'Textura Fabrics, Ahmedabad', 'Bay F1'],
      ['FAB-OLF-TER', 'Olefin Weave — Terracotta', 'fabric', 'Olefin basket weave, 300 GSM', 'Terracotta', 'm', 80, 'Textura Fabrics, Ahmedabad', 'Bay F2'],
      ['FAB-CNV-OLV', 'Waterproof Canvas — Olive', 'fabric', 'PU-coated canvas, 320 GSM', 'Olive', 'm', 60, 'Kohinoor Textiles', 'Bay F2'],
      ['FAB-STR-NVY', 'Acrylic Stripe — Navy/White', 'fabric', 'Striped acrylic, 260 GSM', 'Navy/White', 'm', 60, 'Textura Fabrics, Ahmedabad', 'Bay F3'],
    ];
    const mat: Record<string, number> = {};
    for (const [code, name, category, variant, color, unit, reorder, supplier, location] of mats)
      mat[code] = insert(
        'INSERT INTO materials (code, name, category, variant, color, unit, reorder_level, supplier, location) VALUES (?,?,?,?,?,?,?,?,?)',
        code, name, category, variant, color, unit, reorder, supplier, location,
      );
    const opening: Record<string, number> = {
      'ROPE-OLF6-CHR': 520, 'ROPE-OLF6-SND': 430, 'ROPE-OLF8-NAT': 210, 'ROPE-PEF12-IVY': 260, 'ROPE-PB5-TEA': 120, 'ROPE-JUT10-NAT': 90,
      'FAB-ACR280-ECR': 820, 'FAB-ACR280-CHR': 600, 'FAB-OLF-TER': 80, 'FAB-CNV-OLV': 260, 'FAB-STR-NVY': 240,
    };
    const openDate = addDays(T, -75);
    at(openDate, 9, () => {
      for (const [code, q] of Object.entries(opening))
        postTxn({ materialId: mat[code], type: 'opening', quantity: q, userId: admin, notes: 'Opening balance migrated from stock sheet', date: openDate, reference: 'STOCK-SHEET' });
    });
    const receipts: [number, string, number, string][] = [
      [-48, 'ROPE-OLF6-CHR', 300, 'INV/SR/2291'],
      [-40, 'FAB-ACR280-ECR', 400, 'TX/24-25/1180'],
      [-31, 'ROPE-OLF6-SND', 250, 'INV/SR/2344'],
      [-22, 'FAB-ACR280-CHR', 300, 'TX/24-25/1236'],
      [-15, 'ROPE-PEF12-IVY', 150, 'PW/0981'],
      [-6, 'ROPE-OLF6-CHR', 200, 'INV/SR/2417'],
    ];
    for (const [d, code, q, ref] of receipts)
      at(addDays(T, d), 11, () => {
        postTxn({ materialId: mat[code], type: 'incoming', quantity: q, userId: staff.vikram, reference: ref, notes: 'Received at store', date: addDays(T, d) });
        autoAllocateMaterial(mat[code]);
      });

    // ── Products ─────────────────────────────────────────────────────────
    const P = (k: string) => proc(k);
    const products: [string, string, string, string, [string, number | null][]][] = [
      ['UM-LC-01', 'Rope Lounge Chair', 'Seating', '78 × 82 × 74 cm', [['iron', null], ['rope', 2.4], ['fabric', 2.2]]],
      ['UM-DC-02', 'Rope Dining Chair', 'Seating', '52 × 58 × 84 cm', [['iron', null], ['rope', 1.6], ['fabric', 0.8]]],
      ['UM-DB-03', 'Woven Daybed', 'Lounging', '200 × 90 × 40 cm', [['iron', null], ['rope', 9], ['fabric', 6]]],
      ['UM-BS-04', 'Rope Bar Stool', 'Seating', '45 × 45 × 75 cm', [['iron', null], ['rope', 1.2]]],
      ['UM-SF-05', 'Outdoor Sofa — 3 Seater', 'Seating', '210 × 85 × 72 cm', [['iron', null], ['rope', 7.5], ['fabric', 7]]],
      ['UM-SW-06', 'Hanging Swing Chair', 'Lounging', 'Ø 95 × 125 cm', [['iron', null], ['rope', 3.5], ['fabric', 1.8]]],
      ['UM-ST-07', 'Rope Side Table', 'Tables', 'Ø 45 × 50 cm', [['iron', null], ['rope', 0.9]]],
      ['UM-CS-08', 'Outdoor Cushion Set', 'Soft furnishing', '60 × 60 cm (set of 4)', [['fabric', 3]]],
      ['UM-PS-09', 'Rope Planter Stand', 'Decor', '35 × 35 × 60 cm', [['iron', null], ['rope', 0.6]]],
    ];
    const prod: Record<string, { id: number; procs: [string, number | null][] }> = {};
    for (const [sku, name, cat, dims, procs] of products) {
      const id = insert('INSERT INTO products (sku, name, category, default_dimensions) VALUES (?,?,?,?)', sku, name, cat, dims);
      for (const [k, per] of procs) insert('INSERT INTO product_processes (product_id, process_id, material_per_unit) VALUES (?,?,?)', id, P(k), per);
      prod[sku] = { id, procs };
    }

    // ── Orders ───────────────────────────────────────────────────────────
    interface Spec {
      code: string;
      client: string;
      sku: string;
      qty: number;
      ago: number; // order date = today - ago
      lead: number; // deadline = order date + lead
      priority: Priority;
      source: string;
      rope?: string;
      fabric?: string;
      target: OrderStage | 'on_hold' | 'cancelled';
      progress?: Partial<Record<'iron' | 'rope' | 'fabric', number>>; // 0..1 for in-production orders
      delayRope?: string;
      partialDispatch?: number;
      reqOverride?: Partial<Record<'rope' | 'fabric', number>>;
      color?: string;
      finish?: string;
      notes?: string;
    }
    const specs: Spec[] = [
      // Completed history
      { code: 'UM-1001', client: 'Casa Verde Hospitality', sku: 'UM-LC-01', qty: 24, ago: 70, lead: 30, priority: 'high', source: 'Repeat client — email', rope: 'ROPE-OLF6-SND', fabric: 'FAB-ACR280-ECR', target: 'completed', color: 'Sand / Ecru' },
      { code: 'UM-1002', client: 'Brew & Bloom Café', sku: 'UM-BS-04', qty: 18, ago: 64, lead: 24, priority: 'normal', source: 'Instagram enquiry', rope: 'ROPE-OLF6-CHR', target: 'completed', color: 'Charcoal' },
      { code: 'UM-1003', client: 'Studio Nine Architects', sku: 'UM-DC-02', qty: 40, ago: 60, lead: 35, priority: 'normal', source: 'Architect referral', rope: 'ROPE-OLF6-CHR', fabric: 'FAB-ACR280-CHR', target: 'completed', color: 'Charcoal' },
      { code: 'UM-1004', client: 'Mehra Residence', sku: 'UM-SW-06', qty: 2, ago: 55, lead: 21, priority: 'low', source: 'Website', rope: 'ROPE-PEF12-IVY', fabric: 'FAB-STR-NVY', target: 'completed', color: 'Ivory' },
      { code: 'UM-1005', client: 'Palm Grove Resorts', sku: 'UM-DB-03', qty: 8, ago: 52, lead: 30, priority: 'high', source: 'Trade fair (IFFE)', rope: 'ROPE-OLF6-SND', fabric: 'FAB-ACR280-ECR', target: 'completed', color: 'Sand' },
      { code: 'UM-1006', client: 'Urban Nest Homes', sku: 'UM-ST-07', qty: 30, ago: 46, lead: 25, priority: 'normal', source: 'Repeat client — WhatsApp', rope: 'ROPE-JUT10-NAT', target: 'completed', color: 'Natural' },
      // Dispatched
      { code: 'UM-1007', client: 'Saffron Courtyard Hotel', sku: 'UM-DC-02', qty: 36, ago: 38, lead: 32, priority: 'high', source: 'Email RFQ', rope: 'ROPE-OLF6-SND', fabric: 'FAB-ACR280-ECR', target: 'dispatched', partialDispatch: 24, color: 'Sand / Ecru' },
      { code: 'UM-1008', client: 'Aranya Eco Retreat', sku: 'UM-PS-09', qty: 25, ago: 34, lead: 28, priority: 'normal', source: 'Website', rope: 'ROPE-JUT10-NAT', target: 'dispatched', color: 'Natural' },
      // Ready for dispatch / QC
      { code: 'UM-1009', client: 'Coastline Villas', sku: 'UM-LC-01', qty: 16, ago: 30, lead: 34, priority: 'normal', source: 'Architect referral', rope: 'ROPE-OLF6-CHR', fabric: 'FAB-ACR280-CHR', target: 'ready_for_dispatch', color: 'Charcoal' },
      { code: 'UM-1010', client: 'ABC Interiors', sku: 'UM-CS-08', qty: 20, ago: 21, lead: 22, priority: 'normal', source: 'Repeat client — email', fabric: 'FAB-STR-NVY', target: 'quality_check', color: 'Navy stripe' },
      { code: 'UM-1011', client: 'Casa Verde Hospitality', sku: 'UM-BS-04', qty: 24, ago: 26, lead: 30, priority: 'high', source: 'Repeat client — email', rope: 'ROPE-OLF6-SND', target: 'quality_check', color: 'Sand' },
      // In production — the heart of the demo
      { code: 'UM-1024', client: 'ABC Interiors', sku: 'UM-LC-01', qty: 50, ago: 7, lead: 19, priority: 'high', source: 'Email RFQ', rope: 'ROPE-OLF6-CHR', fabric: 'FAB-ACR280-ECR', target: 'in_production', progress: { iron: 1, rope: 0.7, fabric: 0 }, color: 'Charcoal / Ecru', notes: 'Client site handover on the 27th — no slippage possible.' },
      { code: 'UM-1025', client: 'Palm Grove Resorts', sku: 'UM-SF-05', qty: 12, ago: 24, lead: 22, priority: 'urgent', source: 'Repeat client — call', rope: 'ROPE-OLF8-NAT', fabric: 'FAB-ACR280-ECR', target: 'in_production', progress: { iron: 1, rope: 0.42, fabric: 0.25 }, delayRope: 'Waiting for 8mm natural rope — supplier dispatch delayed', color: 'Natural' },
      { code: 'UM-1026', client: 'Saffron Courtyard Hotel', sku: 'UM-SW-06', qty: 10, ago: 20, lead: 24, priority: 'high', source: 'Email RFQ', rope: 'ROPE-PEF12-IVY', fabric: 'FAB-ACR280-CHR', target: 'in_production', progress: { iron: 1, rope: 1, fabric: 0.6 }, color: 'Ivory / Charcoal' },
      { code: 'UM-1027', client: 'Studio Nine Architects', sku: 'UM-DC-02', qty: 60, ago: 12, lead: 30, priority: 'normal', source: 'Architect referral', rope: 'ROPE-OLF6-SND', fabric: 'FAB-ACR280-ECR', target: 'in_production', progress: { iron: 0.55, rope: 0.1, fabric: 0 }, color: 'Sand / Ecru' },
      { code: 'UM-1028', client: 'Coastline Villas', sku: 'UM-DB-03', qty: 25, ago: 9, lead: 26, priority: 'high', source: 'Website', rope: 'ROPE-OLF6-SND', fabric: 'FAB-OLF-TER', target: 'in_production', progress: { iron: 0.4 }, reqOverride: { fabric: 150 }, color: 'Sand / Terracotta' },
      { code: 'UM-1029', client: 'Brew & Bloom Café', sku: 'UM-ST-07', qty: 14, ago: 16, lead: 15, priority: 'normal', source: 'Instagram enquiry', rope: 'ROPE-PB5-TEA', target: 'in_production', progress: { iron: 1, rope: 0.5 }, color: 'Teal' },
      // Ready for production / preparing
      { code: 'UM-1030', client: 'Aranya Eco Retreat', sku: 'UM-LC-01', qty: 18, ago: 5, lead: 28, priority: 'normal', source: 'Website', rope: 'ROPE-JUT10-NAT', fabric: 'FAB-CNV-OLV', target: 'ready_for_production', color: 'Natural / Olive' },
      { code: 'UM-1031', client: 'Urban Nest Homes', sku: 'UM-DC-02', qty: 24, ago: 4, lead: 6, priority: 'urgent', source: 'Repeat client — WhatsApp', rope: 'ROPE-OLF6-CHR', fabric: 'FAB-ACR280-CHR', target: 'preparing', color: 'Charcoal' },
      { code: 'UM-1032', client: 'Mehra Residence', sku: 'UM-SF-05', qty: 2, ago: 3, lead: 30, priority: 'normal', source: 'Showroom walk-in', rope: 'ROPE-OLF8-NAT', fabric: 'FAB-STR-NVY', target: 'preparing', color: 'Natural / Navy stripe' },
      // Reviewed / received
      { code: 'UM-1033', client: 'Casa Verde Hospitality', sku: 'UM-DB-03', qty: 6, ago: 2, lead: 35, priority: 'normal', source: 'Repeat client — email', rope: 'ROPE-OLF6-SND', fabric: 'FAB-OLF-TER', target: 'reviewed', color: 'Sand / Terracotta' },
      { code: 'UM-1034', client: 'Palm Grove Resorts', sku: 'UM-PS-09', qty: 40, ago: 1, lead: 21, priority: 'low', source: 'Email RFQ', rope: 'ROPE-OLF6-CHR', target: 'received', color: 'Charcoal' },
      { code: 'UM-1035', client: 'ABC Interiors', sku: 'UM-SW-06', qty: 6, ago: 0, lead: 25, priority: 'normal', source: 'Call', rope: 'ROPE-PEF12-IVY', fabric: 'FAB-ACR280-ECR', target: 'received', color: 'Ivory / Ecru' },
      // Exceptions
      { code: 'UM-1036', client: 'Saffron Courtyard Hotel', sku: 'UM-LC-01', qty: 12, ago: 10, lead: 30, priority: 'normal', source: 'Email RFQ', rope: 'ROPE-OLF6-SND', fabric: 'FAB-ACR280-ECR', target: 'on_hold', color: 'Sand' },
      { code: 'UM-1037', client: 'Brew & Bloom Café', sku: 'UM-DC-02', qty: 20, ago: 14, lead: 20, priority: 'low', source: 'Instagram enquiry', rope: 'ROPE-OLF6-CHR', fabric: 'FAB-STR-NVY', target: 'cancelled', color: 'Charcoal' },
    ];

    const rotate: Record<string, number> = { iron: 0, rope: 0, fabric: 0 };
    const pick = (k: 'iron' | 'rope' | 'fabric') => team[k][rotate[k]++ % 2];
    const order = (s: Spec) => get('SELECT id FROM orders WHERE code=?', s.code)!.id;
    const jobOf = (s: Spec, k: string) => get('SELECT j.id, j.quantity, j.completed_qty, j.assigned_to FROM jobs j JOIN job_processes p ON p.id=j.process_id WHERE j.order_id=? AND p.key=?', order(s), k);

    for (const s of specs) {
      const od = addDays(T, -s.ago);
      const deadline = addDays(od, s.lead);
      const skyDate = addDays(deadline, -3);
      const p = prod[s.sku];
      const keys = p.procs.map(([k]) => k as 'iron' | 'rope' | 'fabric');
      // Plan process windows across the lead time: iron 0–35%, rope 30–70%, fabric 45–85%.
      const win: Record<string, [number, number]> = { iron: [0.08, 0.35], rope: [0.3, 0.7], fabric: [0.45, 0.85] };
      const d = (f: number) => addDays(od, Math.round(s.lead * f));

      at(od, 10, () => {
        createOrder(
          {
            customer_id: cust[s.client],
            po_number: `PO-${s.code.slice(3)}-${String(Math.floor(rand() * 900 + 100))}`,
            source: s.source,
            order_date: od,
            priority: s.priority,
            notes: s.notes ?? null,
            delivery_address: get('SELECT address FROM customers WHERE id=?', cust[s.client])!.address,
            sky_date: skyDate,
            deadline,
            items: [
              {
                product_id: p.id,
                quantity: s.qty,
                color: s.color ?? null,
                finish: keys.includes('iron') ? 'Powder coat — matte black' : null,
                specifications: null,
                processes: keys.map((k) => ({
                  process_id: P(k),
                  assigned_to: s.code === 'UM-1024' ? { iron: staff.rahul, rope: staff.amit, fabric: staff.neha }[k] : pick(k),
                  start_date: d(win[k][0]),
                  due_date: d(win[k][1]),
                  specs:
                    k === 'iron'
                      ? { metal: 'MS (Mild Steel)', section_size: '25 × 25 mm square', welding: 'MIG', finish: 'Powder coat', coat_color: 'Matte black', workshop: 'In-house' }
                      : k === 'rope'
                        ? { rope_type: get('SELECT variant FROM materials WHERE code=?', s.rope)?.variant, rope_color: s.color?.split('/')[0].trim(), weave_pattern: ['Criss-cross', 'Basket', 'Parallel wrap'][Math.floor(rand() * 3)], rope_per_unit: p.procs.find(([x]) => x === 'rope')?.[1] }
                        : { fabric_type: get('SELECT variant FROM materials WHERE code=?', s.fabric)?.variant, fabric_code: s.fabric, foam: 'Quick-dry foam', cushion_thickness: 100, stitching: 'Piping', zip_cover: 'Yes', fabric_per_unit: p.procs.find(([x]) => x === 'fabric')?.[1] },
                })),
                materials: keys
                  .filter((k) => k !== 'iron')
                  .map((k) => ({
                    process_id: P(k),
                    material_id: mat[(k === 'rope' ? s.rope : s.fabric)!],
                    required_qty: s.reqOverride?.[k as 'rope' | 'fabric'] ?? Math.round((p.procs.find(([x]) => x === k)![1] ?? 1) * s.qty * 1.05 * 10) / 10,
                  })),
              },
            ],
          },
          A,
          { code: s.code },
        );
      });
      if (s.target === 'received') continue;

      const reviewer = rand() > 0.5 ? A : K;
      at(addDays(od, s.ago > 0 ? 1 : 0), s.ago > 0 ? 10 : 15, () => transition(order(s), 'reviewed', { actorId: reviewer.id, actorRole: 'admin', note: 'Specs and pricing confirmed with client' }));
      if (s.target === 'reviewed') continue;

      const prepDay = addDays(od, Math.min(2, s.ago));
      at(prepDay, 11, () => transition(order(s), 'preparing', { actorId: K.id, actorRole: 'admin' }));
      at(prepDay, 15, () => {
        const items = all('SELECT id FROM order_checklist_items WHERE order_id=? AND stage=? ORDER BY sequence', order(s), 'preparing');
        const n = s.target === 'preparing' ? 2 : items.length;
        items.slice(0, n).forEach((c) => toggleChecklist(order(s), c.id, true, K));
      });
      if (s.target === 'cancelled') {
        at(addDays(od, 4), 12, () => cancelOrder(order(s), 'Client postponed café renovation indefinitely', A.id));
        continue;
      }
      if (s.target === 'on_hold') {
        at(addDays(od, 3), 12, () => transition(order(s), 'ready_for_production', { actorId: K.id, actorRole: 'admin', acknowledgeWarnings: true }));
        at(addDays(od, 4), 10, () => {
          const j = jobOf(s, 'iron')!;
          updateJob(j.id, { completed_qty: 4, note: 'First frames welded' }, authUser(j.assigned_to));
        });
        at(addDays(od, 5), 16, () => setHold(order(s), true, 'Client revising cushion colour — awaiting approval', A.id));
        continue;
      }
      if (s.target === 'preparing') continue;
      at(addDays(prepDay, s.ago > 3 ? 1 : 0), 17, () =>
        transition(order(s), 'ready_for_production', { actorId: K.id, actorRole: 'admin', acknowledgeWarnings: true, note: 'Materials checked, staff assigned' }),
      );
      if (s.target === 'ready_for_production') continue;

      // Production: each process progresses in a few updates inside its window, capped at "today".
      const finished = !['in_production'].includes(s.target);
      for (const k of keys) {
        const target = finished ? 1 : (s.progress?.[k] ?? 0);
        if (target <= 0) continue;
        const [w0, w1] = win[k];
        const steps = target === 1 ? 3 : 2;
        for (let i = 1; i <= steps; i++) {
          const frac = w0 + ((w1 - w0) * i) / steps;
          let day = d(frac);
          if (day > T) day = addDays(T, -(steps - i));
          if (day < prepDay) day = prepDay;
          const share = (target * i) / steps;
          at(day, 12 + i * 2, () => {
            const j = jobOf(s, k)!;
            const qty = Math.min(j.quantity, Math.round(j.quantity * share));
            if (qty <= j.completed_qty) return;
            const per = p.procs.find(([x]) => x === k)?.[1];
            const used = per ? Math.round(per * (qty - j.completed_qty) * (1 + rand() * 0.04) * 10) / 10 : undefined;
            const waste = per && rand() > 0.6 ? Math.round(per * (qty - j.completed_qty) * 0.03 * 10) / 10 : undefined;
            const notes = {
              iron: ['Frames cut and welded', 'Grinding done, sent for powder coat', 'Powder coat received, frames checked'],
              rope: ['Weaving started on first batch', 'Second batch woven', 'Final pieces woven and tensioned'],
              fabric: ['Cutting done', 'Stitching in progress', 'Cushions filled and finished'],
            }[k];
            updateJob(j.id, { completed_qty: qty, material_used: used, wastage: waste, note: notes[Math.min(i - 1, 2)] }, authUser(j.assigned_to));
          });
        }
      }
      if (s.delayRope) {
        at(addDays(T, -2), 18, () => {
          const j = jobOf(s, 'rope')!;
          updateJob(j.id, { status: 'delayed', delay_reason: s.delayRope, note: 'Stopped — 8mm rope finished, rest of order cannot be woven' }, authUser(j.assigned_to));
        });
        at(addDays(T, -2), 19, () => {
          const oid = order(s);
          insert(
            'INSERT INTO material_incoming (material_id, quantity, supplier, expected_date, reference, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
            mat['ROPE-OLF8-NAT'], 120, 'Shree Ropes, Surat', addDays(T, 2), 'PO/ROPE/0412', K.id, new Date().toISOString(),
          );
          addOrderNote(oid, 'Spoke to Shree Ropes — 120 kg of 8mm natural promised by day after tomorrow. Fabric team to continue meanwhile.', K);
        });
      }
      if (s.target === 'in_production') continue;

      // QC
      const qcDay = (() => {
        const x = d(0.88);
        return x > T ? T : x;
      })();
      if (s.target === 'quality_check') continue;
      at(qcDay, 20, () => recordQualityCheck(order(s), { result: 'passed', qty_checked: s.qty, qty_passed: s.qty, qty_rejected: 0, notes: 'Weave tension, welds and stitching checked' }, authUser(staff.vikram)));
      at(qcDay, 21, () => {
        const items = all('SELECT id FROM order_checklist_items WHERE order_id=? AND stage=? ORDER BY sequence', order(s), 'ready_for_dispatch');
        items.slice(0, s.target === 'ready_for_dispatch' ? 2 : items.length).forEach((c) => toggleChecklist(order(s), c.id, true, authUser(staff.vikram)));
      });
      if (s.target === 'ready_for_dispatch') continue;

      const dispDay = (() => {
        const x = d(0.95);
        return x > T ? T : x < addDays(qcDay, 1) ? addDays(qcDay, 1) : x;
      })();
      at(dispDay, 11, () =>
        recordDispatch(
          order(s),
          {
            dispatched_at: `${dispDay}T11:30`,
            quantity: s.partialDispatch ?? s.qty,
            transporter: ['VRL Logistics', 'Gati', 'Safexpress', 'Own tempo'][Math.floor(rand() * 4)],
            vehicle_no: `MH 04 ${['AB', 'KX', 'GT'][Math.floor(rand() * 3)]} ${Math.floor(rand() * 9000 + 1000)}`,
            tracking_ref: `LR${Math.floor(rand() * 900000 + 100000)}`,
            invoice_no: `UMS/26-27/${s.code.slice(3)}`,
            eway_bill: `${Math.floor(rand() * 9e11 + 1e11)}`,
            packages: Math.ceil((s.partialDispatch ?? s.qty) / 2),
            notes: s.partialDispatch ? 'First lot — balance after cushion re-stitch' : 'Wrapped in bubble + corrugated, corners protected',
          },
          K,
        ),
      );
      if (s.target === 'dispatched') continue;
      at(addDays(dispDay, 2), 12, () => transition(order(s), 'completed', { actorId: A.id, actorRole: 'admin', note: 'Delivery confirmed by client' }));
    }

    // Replay the events in chronological order with the clock pinned.
    queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const nowMs = Date.now();
    for (const e of queue) {
      setClock(new Date(Math.min(e.at, nowMs - 60_000)));
      try {
        e.fn();
      } catch (err: any) {
        console.warn('seed step skipped:', err?.message ?? err);
      }
    }
    setClock(null);

    // Pending incoming for the fabric shortage story.
    insert(
      'INSERT INTO material_incoming (material_id, quantity, supplier, expected_date, reference, created_by) VALUES (?,?,?,?,?,?)',
      mat['FAB-OLF-TER'], 200, 'Textura Fabrics, Ahmedabad', addDays(T, 4), 'PO/FAB/0388', ops,
    );
    // Older info notifications are considered read.
    run(`UPDATE notifications SET read_at = created_at WHERE created_at < ? AND severity = 'info'`, addDays(T, -2));
    void stageLabel;
  });
  return refreshAlerts();
}

// CLI: `npm run seed` wipes the database and loads demo data.
if (process.argv[1]?.endsWith('seed.ts')) {
  if (process.argv.includes('--reset')) {
    for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
  }
  db();
  bootstrap();
  if (get('SELECT 1 FROM users LIMIT 1')) {
    console.log('Database already has data. Use `npm run seed` (with --reset) to start over.');
  } else {
    await seedDemo();
    const c = (t: string) => get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n;
    console.log(`Seeded: ${c('orders')} orders, ${c('jobs')} job sheets, ${c('inventory_transactions')} stock movements, ${c('activity_logs')} audit entries.`);
    console.log(`Sign in as admin@umami.studio / ${DEMO_PASSWORD} (admin) or amit@umami.studio / ${DEMO_PASSWORD} (staff).`);
  }
}
