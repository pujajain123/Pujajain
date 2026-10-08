import { get, insert, run } from './db.ts';
import { DEFAULT_STAGE_LABELS, ORDER_STAGES } from '../shared/domain.ts';

/**
 * Process-specific Job Sheet fields. These are the operational columns the production
 * team fills per process (see docs/DATA_MAPPING.md, "Job Sheet"). Admins can extend them
 * in Settings → Processes without a code change.
 */
export const PROCESS_FIELDS = {
  iron: [
    { key: 'frame_design', label: 'Frame design / drawing ref', type: 'text', section: 'Specification' },
    { key: 'metal', label: 'Metal', type: 'select', options: ['MS (Mild Steel)', 'SS 304', 'Aluminium', 'GI'], section: 'Specification' },
    { key: 'section_size', label: 'Pipe / section size', type: 'text', section: 'Specification' },
    { key: 'frame_dimensions', label: 'Frame dimensions (L×W×H)', type: 'text', section: 'Specification' },
    { key: 'welding', label: 'Welding type', type: 'select', options: ['MIG', 'TIG', 'Arc'], section: 'Process' },
    { key: 'finish', label: 'Finish', type: 'select', options: ['Powder coat', 'Paint', 'Galvanised', 'Raw'], section: 'Process' },
    { key: 'coat_color', label: 'Powder coat colour', type: 'text', section: 'Process' },
    { key: 'weight_per_unit', label: 'Frame weight / unit', type: 'number', unit: 'kg', section: 'Process' },
    { key: 'workshop', label: 'Workshop', type: 'select', options: ['In-house', 'Outsourced'], section: 'Process' },
    { key: 'vendor', label: 'Vendor (if outsourced)', type: 'text', section: 'Process' },
  ],
  rope: [
    { key: 'rope_type', label: 'Rope type', type: 'text', section: 'Specification' },
    { key: 'rope_color', label: 'Rope colour', type: 'text', section: 'Specification' },
    { key: 'thickness_mm', label: 'Thickness', type: 'number', unit: 'mm', section: 'Specification' },
    { key: 'weave_pattern', label: 'Weave pattern', type: 'select', options: ['Criss-cross', 'Basket', 'Herringbone', 'Parallel wrap', 'Macramé knot', 'Custom'], section: 'Specification' },
    { key: 'rope_per_unit', label: 'Rope per unit', type: 'number', unit: 'm', section: 'Process' },
    { key: 'weaver_team', label: 'Weaver team / karigar', type: 'text', section: 'Process' },
    { key: 'piece_rate', label: 'Piece rate', type: 'number', unit: '₹/unit', section: 'Process' },
  ],
  tile: [
    { key: 'top_material', label: 'Top material', type: 'select', options: ['Stone', 'Tile', 'Terrazzo', 'Wood', 'Glass'], section: 'Specification' },
    { key: 'top_size', label: 'Top size', type: 'text', section: 'Specification' },
    { key: 'thickness', label: 'Thickness', type: 'number', unit: 'mm', section: 'Specification' },
    { key: 'supplier', label: 'Supplier', type: 'text', section: 'Process' },
  ],
  fabric: [
    { key: 'fabric_type', label: 'Fabric type', type: 'text', section: 'Specification' },
    { key: 'fabric_code', label: 'Fabric code / shade', type: 'text', section: 'Specification' },
    { key: 'cushion_size', label: 'Cushion size', type: 'text', section: 'Specification' },
    { key: 'foam', label: 'Foam / filling', type: 'select', options: ['PU foam 32D', 'PU foam 40D', 'Quick-dry foam', 'Fibre fill', 'None'], section: 'Specification' },
    { key: 'cushion_thickness', label: 'Cushion thickness', type: 'number', unit: 'mm', section: 'Specification' },
    { key: 'fabric_per_unit', label: 'Fabric per unit', type: 'number', unit: 'm', section: 'Process' },
    { key: 'stitching', label: 'Stitching', type: 'select', options: ['Piping', 'Plain seam', 'Box (boxed edge)', 'Tufted'], section: 'Process' },
    { key: 'zip_cover', label: 'Removable cover (zip)', type: 'select', options: ['Yes', 'No'], section: 'Process' },
    { key: 'tailor', label: 'Tailor', type: 'text', section: 'Process' },
  ],
};

/** Production steps and QC gates per process (from the iron/rope/fabric job sheets and the production tracker). */
export const PROCESS_STEPS: Record<string, { key: string; label: string; kind: 'work' | 'qc' }[]> = {
  iron: [
    { key: 'frame', label: 'Framework fabrication', kind: 'work' },
    { key: 'frame_qc', label: 'Framework inspection', kind: 'qc' },
    { key: 'powder', label: 'Powder coating', kind: 'work' },
    { key: 'powder_qc', label: 'Powder-coating inspection', kind: 'qc' },
  ],
  rope: [
    { key: 'weaving', label: 'Weaving', kind: 'work' },
    { key: 'weaving_qc', label: 'Weaving inspection', kind: 'qc' },
  ],
  fabric: [
    { key: 'upholstery', label: 'Upholstery', kind: 'work' },
    { key: 'upholstery_qc', label: 'Upholstery inspection', kind: 'qc' },
  ],
  tile: [{ key: 'tile', label: 'Tile / stone work', kind: 'work' }],
};

/** QC checklist printed on the iron-work job sheet. */
export const IRON_CHECKLIST = [
  ['dimensions', 'Dimensions verified'],
  ['material', 'Material verified'],
  ['pipe', 'Pipe section verified'],
  ['welding', 'Welding quality approved'],
  ['grinding', 'Grinding & finishing complete'],
  ['powder', 'Powder coating approved'],
  ['level', 'Frame level & wobble-free'],
  ['surface', 'No dents / scratches'],
  ['hardware', 'Hardware / adjusters fitted'],
  ['final', 'Final approval'],
].map(([key, label]) => ({ key, label }));

export function bootstrap() {
  for (const [key, name] of [
    ['admin', 'Admin'],
    ['staff', 'Staff'],
  ])
    run('INSERT OR IGNORE INTO roles (key, name) VALUES (?,?)', key, name);

  ORDER_STAGES.forEach((key, i) =>
    run('INSERT OR IGNORE INTO order_stages (key, label, sequence) VALUES (?,?,?)', key, DEFAULT_STAGE_LABELS[key], i + 1),
  );

  const procs = [
    ['iron', 'Iron Work', 1, null],
    ['rope', 'Rope Work', 2, 'rope'],
    ['fabric', 'Fabric Work', 3, 'fabric'],
    ['tile', 'Tile / Stone Work', 4, null],
  ] as const;
  for (const [key, name, seq, cat] of procs) {
    if (!get('SELECT 1 FROM job_processes WHERE key=?', key))
      insert(
        'INSERT INTO job_processes (key, name, sequence, material_category, fields_json, steps_json, checklist_json) VALUES (?,?,?,?,?,?,?)',
        key, name, seq, cat, JSON.stringify(PROCESS_FIELDS[key]), JSON.stringify(PROCESS_STEPS[key]), JSON.stringify(key === 'iron' ? IRON_CHECKLIST : []),
      );
  }

  const defaults: Record<string, string> = {
    company_name: 'Umami Studios',
    order_prefix: 'UM-',
    approaching_days: '7',
    at_risk_days: '2',
    due_soon_days: '2',
  };
  for (const [k, v] of Object.entries(defaults)) run('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', k, v);
}
