/* Order → materials → inventory → job sheets → Master production, and dispatch addresses.
   When an order is created, the rope, fabric and powder colour entered on its product lines are issued from stock:
   one inventory transaction per material (linked to the order and its job sheet), stock totals go down, each job
   sheet shows what was issued for it, and the order's Master production rows show whether the material is in hand. */
(() => {
  const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const today = () => new Date().toISOString().slice(0, 10);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  const ROPE_KEY = 'umami-rope-inventory-v1', TRACKER_KEY = 'umami-production-tracker-v1';
  const PROCESS_FOR = { Rope: 'Rope Work', Fabric: 'Fabric Work', 'Powder Color': 'Iron Work' };

  /* ---------- Stock levels ---------- */
  const inv = name => {
    let item = db.inventory.find(i => i.name === name);
    if (!item) { item = { name, unit: name === 'Powder Color' ? 'kg' : 'm', opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0 }; db.inventory.push(item); }
    return item;
  };
  const available = item => item.opening + item.incoming + item.adjustments - item.reserved - item.consumed - item.wastage;
  const ropeBalance = row => (row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null
    ? num(row['Opening Stock (m)']) + num(row['Total Purchased (m)']) - num(row['Total Outward (m)'])
    : num(row['Current Balance (m)']));
  function findRopeRow(code, colour) {
    const rows = ropeSheetData?.stock_master || [];
    const bySku = rows.filter(r => same(r['Rope Type (SKU)'], code));
    return bySku.find(r => colour && same(r.Color, colour)) || (bySku.length === 1 ? bySku[0] : null)
      || (colour ? rows.find(r => same(r.Color, colour) && same(String(r.mm).replace(/mm$/i, ''), String(code).replace(/mm$/i, ''))) : null);
  }

  /* ---------- Order form: powder colour quantity per product line ---------- */
  const baseOpenNewOrder = openNewOrder;
  openNewOrder = function () {
    baseOpenNewOrder();
    const form = document.querySelector('#order-form');
    form?.querySelectorAll('input[name=linePowderColor]').forEach(input => {
      input.closest('.field')?.insertAdjacentHTML('afterend', '<div class="field"><label>Powder required (kg)</label><input name="linePowderKg" type="number" min="0" step="0.1" placeholder="Kilograms"></div>');
    });
    form?.querySelectorAll('input[name=lineFabricQty]').forEach(input => { const l = input.closest('.field')?.querySelector('label'); if (l) l.textContent = 'Fabric required (m)'; });
    const lines = form?.querySelector('[data-extra-order-lines]');
    lines?.insertAdjacentHTML('afterend', '<div class="info-banner order-stock-note">Rope, fabric and powder colour entered for each product are taken out of inventory when the order is created and shown on its job sheets. Rope is matched to the rope stock by its size / code and dori colour.</div>');
  };
  window.openNewOrder = openNewOrder;

  /* ---------- Issue materials when an order is created ---------- */
  const baseSubmitOrder = submitOrder;
  submitOrder = function (form) {
    const before = new Set(db.orders.map(o => o.id));
    const powder = [...form.querySelectorAll('[data-order-line]')].map(row => num(row.querySelector('[name=linePowderKg]')?.value));
    baseSubmitOrder(form);
    const o = db.orders.find(x => !before.has(x.id));
    if (!o) return;
    (o.items || []).forEach((it, i) => { it.powderKg = powder[i] || 0; });
    addProductionSteps(o);
    issueMaterials(o);
  };
  window.submitOrder = submitOrder;

  // Steps, QC checkpoints and the iron checklist, as existing orders get when the page loads.
  function addProductionSteps(o) {
    for (const p of o.processes) {
      const first = p.status === 'In progress' ? 'In progress' : 'Not started';
      if (!p.steps) p.steps = p.name === 'Iron Work'
        ? [{ key: 'frame', label: 'Framework fabrication', status: first }, { key: 'powder', label: 'Powder coating', status: 'Not started' }]
        : [{ key: 'process', label: p.name, status: first }];
      if (!p.qc) p.qc = p.name === 'Iron Work'
        ? [{ key: 'frame', label: 'Framework inspection', status: 'Pending', note: '' }, { key: 'powder', label: 'Powder-coating inspection', status: 'Pending', note: '' }]
        : [{ key: 'process', label: `${p.name.split(' ')[0]} work inspection`, status: 'Pending', note: '' }];
      if (p.name === 'Iron Work' && !p.checklist && typeof IRON_QC_CHECKS !== 'undefined') p.checklist = IRON_QC_CHECKS.map(([key, label]) => ({ key, label, done: false }));
    }
  }

  function issueMaterials(o) {
    const actor = currentActor(), issued = [], shortages = [];
    let seq = 0;
    const job = material => { const p = o.processes.find(x => x.name === PROCESS_FOR[material]); return p ? jobId(o, p) : '—'; };
    const record = (material, qty, extra, detail) => {
      const t = { id: `TX-${Date.now().toString().slice(-6)}-${++seq}`, material, type: 'Outward', qty, unit: material === 'Powder Color' ? 'kg' : 'm', color: '', sku: '', mm: '', company: '', colorName: '', order: o.id, job: job(material), staff: actor, enteredBy: actor, date: today(), notes: `Issued for ${o.id}`, ...extra };
      db.transactions.unshift(t);
      issued.push({ material, qty, unit: t.unit, detail, tx: t.id, short: false });
      return issued[issued.length - 1];
    };

    for (const it of o.items || []) {
      const line = it.sku || it.name;
      const rope = num(it.ropeRequired);
      if (rope > 0) {
        const row = findRopeRow(it.ropeCode, it.doriColour);
        if (row) {
          const have = ropeBalance(row);
          const entry = record('Rope', rope, { sku: row['Rope Type (SKU)'], mm: String(row.mm || '').replace(/mm$/i, ''), color: row.Color || '', notes: `Issued for ${o.id} · ${line}` }, `${row['Rope Type (SKU)']} · ${row.mm} · ${row.Color} · ${line}`);
          row['Total Outward (m)'] = String(num(row['Total Outward (m)']) + rope);
          row['Current Balance (m)'] = String(have - rope);
          (ropeSheetData.outward_log ||= []).unshift({ Date: fmtDate(today(), { day: '2-digit', month: 'short', year: 'numeric' }), 'Rope Type (SKU)': row['Rope Type (SKU)'], mm: row.mm, Color: row.Color, 'Qty Out (m)': String(rope), 'Issued To': actor, 'Used For (Job/Product)': `${o.id} · ${line}`, Remarks: 'Issued on order creation' });
          if (have < rope) { entry.short = true; shortages.push(`Rope ${row['Rope Type (SKU)']} ${row.Color}: needs ${fmt(rope)} m, ${fmt(Math.max(0, have))} m in stock`); }
        } else {
          // Not in the rope stock sheet: still recorded against the order, flagged for the team to match.
          const entry = record('Rope', rope, { color: it.doriColour || '', notes: `Issued for ${o.id} · ${line} · rope ${it.ropeCode || 'code not given'} not found in rope stock` }, `${it.ropeCode || 'No code'}${it.doriColour ? ` · ${it.doriColour}` : ''} · ${line} (not in rope stock)`);
          inv('Rope').consumed += rope;
          entry.short = true;
          shortages.push(`Rope ${it.ropeCode || '(no code)'} ${it.doriColour || ''}: not found in rope stock`);
        }
      }
      const fabric = num(it.fabricRequired);
      if (fabric > 0) {
        const item = inv('Fabric'), have = available(item);
        const entry = record('Fabric', fabric, { company: it.fabricCompany || '', notes: `Issued for ${o.id} · ${line}${it.fabricCode ? ` · fabric ${it.fabricCode}` : ''}` }, `${[it.fabricCompany, it.fabricCode].filter(Boolean).join(' · ') || 'Fabric'} · ${line}`);
        item.consumed += fabric;
        if (have < fabric) { entry.short = true; shortages.push(`Fabric: needs ${fmt(fabric)} m, ${fmt(Math.max(0, have))} m in stock`); }
      }
      const powder = num(it.powderKg);
      if (powder > 0) {
        const item = inv('Powder Color'), have = available(item);
        const entry = record('Powder Color', powder, { colorName: it.powderColor || '', notes: `Issued for ${o.id} · ${line}` }, `${it.powderColor || 'Powder colour'} · ${line}`);
        item.consumed += powder;
        if (have < powder) { entry.short = true; shortages.push(`Powder ${it.powderColor || ''}: needs ${fmt(powder)} kg, ${fmt(Math.max(0, have))} kg in stock`); }
      }
    }

    // Job sheets: each process carries what was issued for it.
    for (const [material, processName] of Object.entries(PROCESS_FOR)) {
      const p = o.processes.find(x => x.name === processName);
      const total = issued.filter(x => x.material === material).reduce((n, x) => n + x.qty, 0);
      if (!p || !total) continue;
      if (material !== 'Powder Color' || !p.material) { p.material = material; p.required = total; }
      p.issued = total;
    }
    o.materialsIssued = issued;
    o.materials = { ...(o.materials || {}), Rope: issued.filter(x => x.material === 'Rope').reduce((n, x) => n + x.qty, 0), Fabric: issued.filter(x => x.material === 'Fabric').reduce((n, x) => n + x.qty, 0), 'Powder Color': issued.filter(x => x.material === 'Powder Color').reduce((n, x) => n + x.qty, 0) };

    // Master production: material status for this order's rows.
    const short = m => issued.some(x => x.material === m && x.short);
    const has = m => issued.some(x => x.material === m);
    for (const r of trackerRows.filter(r => r.orderNo === o.id)) {
      if (has('Rope')) { r.ropeRequired = 'Yes'; r.ropeStatus = short('Rope') ? 'Pending' : 'Received'; }
      if (has('Fabric')) { r.fabricRequired = 'Yes'; r.fabricStatus = short('Fabric') ? 'Pending' : 'Received'; }
      r.currentStatus = shortages.length ? 'Waiting for Material' : 'In Production';
      r.procurementDelay = shortages.length ? 'Material Order Delay' : 'On Track';
    }

    if (issued.length) addActivity(actor, o.id, `Materials issued from inventory: ${issued.map(x => `${x.material} ${fmt(x.qty)} ${x.unit}`).join(', ')}`);
    if (shortages.length) addActivity('System', o.id, `Material shortage: ${shortages.join('; ')}`);
    if (ropeSheetData) localStorage.setItem(ROPE_KEY, JSON.stringify(ropeSheetData));
    localStorage.setItem(TRACKER_KEY, JSON.stringify(trackerRows));
    persist();
    render();
    if (issued.length) toast(shortages.length ? `${o.id}: materials issued, but stock is short: ${shortages.join('; ')}.` : `${o.id}: ${issued.length} material ${issued.length === 1 ? 'entry' : 'entries'} taken from inventory.`);
  }

  /* ---------- Show issued materials on job sheets and the order ---------- */
  const issuedTable = (rows, note) => `<section class="panel materials-issued"><div class="panel-header"><div><h2>Materials issued from inventory</h2><p>${note}</p></div></div>
    ${rows.map(x => `<div class="issued-row"><div><strong>${esc(x.material)}</strong><small>${esc(x.detail)}</small>${x.short ? '<small class="stock-short">Stock short: check inventory</small>' : ''}</div><div class="issued-qty"><strong>−${fmt(x.qty)} ${x.unit}</strong><small>${esc(x.tx)}</small></div></div>`).join('')}</section>`;

  const baseOpenJob = openJob;
  openJob = function (id) {
    baseOpenJob(id);
    const j = getJobs().find(x => x.id === id), drawer = document.querySelector('#overlay-root .drawer');
    const material = j && Object.keys(PROCESS_FOR).find(m => PROCESS_FOR[m] === j.p.name);
    const rows = (j?.o.materialsIssued || []).filter(x => x.material === material);
    if (!drawer || !rows.length) return;
    const anchor = drawer.querySelector('.iron-job-sheet') || drawer.querySelector('.detail-facts');
    anchor?.insertAdjacentHTML('afterend', issuedTable(rows, 'Taken out of stock when the order was created. In job updates, record only extra material used beyond this.'));
  };
  window.openJob = openJob;

  const baseOpenOrder = openOrder;
  openOrder = function (id) {
    baseOpenOrder(id);
    const o = db.orders.find(x => x.id === id), drawer = document.querySelector('#overlay-root .drawer');
    if (!drawer || !o) return;
    if (o.materialsIssued?.length) drawer.querySelector('.detail-facts')?.insertAdjacentHTML('afterend', issuedTable(o.materialsIssued, 'Taken out of stock when the order was created.'));
    if (o.dispatch?.address) drawer.querySelector('.detail-facts')?.insertAdjacentHTML('afterend', `<section class="panel"><div class="panel-header"><div><h2>Delivery address</h2></div></div><p class="address-block">${esc(o.dispatch.address).replace(/\n/g, '<br>')}</p></section>`);
  };
  window.openOrder = openOrder;

  /* ---------- Dispatch: delivery address ---------- */
  const baseOpenDispatch = openDispatch;
  openDispatch = function (id) {
    baseOpenDispatch(id);
    const o = db.orders.find(x => x.id === id);
    const notes = document.querySelector('#dispatch-form textarea[name=notes]')?.closest('.field');
    notes?.insertAdjacentHTML('beforebegin', `<div class="field full"><label>Delivery address</label><textarea name="address" required placeholder="Full delivery address, with city and PIN code">${esc(o?.dispatch?.address || o?.address || '')}</textarea></div>`);
  };
  window.openDispatch = openDispatch;

  const baseSubmitDispatch = submitDispatch;
  submitDispatch = function (form) {
    const address = String(new FormData(form).get('address') || '').trim(), id = new FormData(form).get('id');
    baseSubmitDispatch(form);
    const o = db.orders.find(x => x.id === id);
    if (!o?.dispatch) return;
    o.dispatch.address = address;
    o.address = address;
    const rec = db.dispatches?.find(d => d.order === o.id);
    if (rec) rec.address = address;
    persist();
    render();
  };
  window.submitDispatch = submitDispatch;

  const baseRenderDispatch = renderDispatch;
  renderDispatch = function () {
    return baseRenderDispatch()
      .replace('<th>CARRIER / TRACKING</th>', '<th>CARRIER / TRACKING</th><th>DELIVERY ADDRESS</th>')
      .replace('colspan="8"', 'colspan="9"')
      .replace(/<tr data-order="([^"]+)">([\s\S]*?)<\/tr>/g, (row, id, cells) => {
        const o = db.orders.find(x => x.id === id), addr = o?.dispatch?.address || '';
        const at = cells.lastIndexOf('<td>');
        return `<tr data-order="${id}">${cells.slice(0, at)}<td class="address-cell">${addr ? esc(addr).replace(/\n/g, '<br>') : '—'}</td>${cells.slice(at)}</tr>`;
      });
  };
  window.renderDispatch = renderDispatch;

  render();
})();
