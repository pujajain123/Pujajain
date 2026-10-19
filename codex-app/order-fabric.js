/* Fabric per product line, split into seat, cushion and extra cushion.
   Each part has its own fabric code, fabric company and metres required. They are captured on the new order form,
   shown on the order, editable by admins (Edit order), and drive the Fabric Work job sheet and the stock issued from
   inventory. Older orders kept one fabric per line (fabricCode / fabricCompany / fabricRequired); that is read as the
   seat fabric. The old fields are kept in step (codes and companies joined, metres summed) for the views that use them. */
(() => {
  const PARTS = [['seat', 'Seat'], ['cushion', 'Cushion'], ['extraCushion', 'Extra cushion']];
  const FABRIC_COMPANIES = ['Agora', 'SUNBRELLA', 'D’Decor', 'Gaurika', 'Asadeep', 'Sun N Joy', 'Others'];
  const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const today = () => new Date().toISOString().slice(0, 10);
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const isAdmin = () => db.role !== 'Staff';
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

  /* ---------- Data helpers ---------- */
  function fabricsOf(it) {
    if (it?.fabrics) return Object.fromEntries(PARTS.map(([k]) => [k, { code: it.fabrics[k]?.code || '', company: it.fabrics[k]?.company || '', qty: num(it.fabrics[k]?.qty) }]));
    const legacy = { code: it?.fabricCode || '', company: it?.fabricCompany || '', qty: num(it?.fabricRequired) };
    return { seat: legacy, cushion: { code: '', company: '', qty: 0 }, extraCushion: { code: '', company: '', qty: 0 } };
  }
  const partsOf = it => { const f = fabricsOf(it); return PARTS.map(([key, label]) => ({ key, label, ...f[key] })); };
  const hasFabric = p => p.qty > 0 || p.code || p.company;
  const unique = list => [...new Set(list.filter(Boolean))];
  function setParts(it, parts) {
    it.fabrics = Object.fromEntries(PARTS.map(([k]) => [k, { code: String(parts[k]?.code || '').trim(), company: String(parts[k]?.company || '').trim(), qty: num(parts[k]?.qty) }]));
    const list = Object.values(it.fabrics);
    it.fabricRequired = Math.round(list.reduce((n, p) => n + p.qty, 0) * 10) / 10;
    it.fabricCode = unique(list.map(p => p.code)).join(' / ');
    it.fabricCompany = unique(list.map(p => p.company)).join(' / ');
  }
  const readParts = (root, prefix) => Object.fromEntries(PARTS.map(([k]) => [k, {
    code: root.querySelector(`[name="${prefix}-${k}-code"]`)?.value || '',
    company: root.querySelector(`[name="${prefix}-${k}-company"]`)?.value || '',
    qty: root.querySelector(`[name="${prefix}-${k}-qty"]`)?.value || '',
  }]));
  function validateParts(parts, where) {
    for (const [k, label] of PARTS) {
      const p = parts[k], raw = String(p.qty ?? '').trim();
      if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) return `${where}: ${label.toLowerCase()} fabric metres must be zero or more.`;
      if (num(raw) > 100000) return `${where}: ${label.toLowerCase()} fabric metres look too large.`;
      if (num(raw) > 0 && !String(p.company).trim()) return `${where}: choose the fabric company for the ${label.toLowerCase()}.`;
    }
    return '';
  }
  window.UmamiFabric = { PARTS, fabricsOf, partsOf, setParts, readParts };

  /* ---------- Form block: three rows of code / company / metres ---------- */
  const knownCodes = () => unique([
    ...db.orders.flatMap(o => (o.items || []).flatMap(it => partsOf(it).map(p => p.code))),
    ...db.transactions.filter(t => t.material === 'Fabric').map(t => t.code),
  ].map(c => String(c || '').trim())).sort();
  function partsBlock(prefix, values, title = 'Fabric') {
    const row = ([key, label]) => {
      const v = values?.[key] || { code: '', company: '', qty: '' };
      const companies = v.company && !FABRIC_COMPANIES.includes(v.company) ? [v.company, ...FABRIC_COMPANIES] : FABRIC_COMPANIES;
      return `<div class="fabric-part-row"><span class="fabric-part-name">${label}</span>
        <label class="fabric-part-field"><small>Fabric code</small><input name="${prefix}-${key}-code" list="fabric-code-list" value="${esc(v.code)}" placeholder="Code" aria-label="${label} fabric code"></label>
        <label class="fabric-part-field"><small>Fabric company</small><select name="${prefix}-${key}-company" aria-label="${label} fabric company"><option value="">Select company</option>${companies.map(c => `<option ${same(c, v.company) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="fabric-part-field"><small>Required (m)</small><input name="${prefix}-${key}-qty" type="number" min="0" step="0.1" value="${v.qty ? esc(v.qty) : ''}" placeholder="0" aria-label="${label} fabric required in metres"></label></div>`;
    };
    return `<div class="field full fabric-parts"><label>${title}</label><div class="fabric-parts-grid">${PARTS.map(row).join('')}</div></div>`;
  }
  const codeList = () => `<datalist id="fabric-code-list">${knownCodes().map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;

  /* ---------- New order form ---------- */
  function replaceLineFields(row) {
    const old = ['lineFabricCode', 'lineFabricCompany', 'lineFabricQty'].map(n => row.querySelector(`[name=${n}]`)?.closest('.field')).filter(Boolean);
    if (!old.length || row.querySelector('.fabric-parts')) return;
    old[0].insertAdjacentHTML('beforebegin', partsBlock('fab', null, 'Fabric · seat, cushion and extra cushion'));
    old.forEach(f => f.remove());
  }
  const baseOpenNewOrder = openNewOrder;
  openNewOrder = function () {
    baseOpenNewOrder();
    const form = document.querySelector('#order-form');
    if (!form) return;
    form.querySelectorAll('[data-order-line]').forEach(replaceLineFields);
    form.insertAdjacentHTML('beforeend', codeList());
    const note = form.querySelector('.order-stock-note');
    if (note) note.textContent = 'Rope, fabric and powder colour entered for each product are taken out of inventory when the order is created and shown on its job sheets. Fabric is issued separately for the seat, cushion and extra cushion. Rope is matched to the rope stock by its size / code and dori colour.';
  };
  window.openNewOrder = openNewOrder;

  // A copied product line starts with empty fabric parts.
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-add-order-line]')) return;
    setTimeout(() => {
      const rows = document.querySelectorAll('#order-form [data-order-line]'), row = rows[rows.length - 1];
      if (!row || rows.length < 2) return;
      row.querySelectorAll('.fabric-parts select').forEach(select => {
        select.value = '';
        const trigger = select.closest('[data-custom-select]')?.querySelector('.app-select-trigger');
        if (trigger) trigger.textContent = 'Select company';
        select.closest('[data-custom-select]')?.querySelectorAll('[data-custom-option]').forEach(o => { o.classList.toggle('selected', o.dataset.customOption === ''); o.querySelector('span')?.remove(); });
      });
    });
  });

  // Check the fabric parts before the order is created.
  document.addEventListener('submit', e => {
    if (e.target.getAttribute('id') !== 'order-form') return;
    const rows = [...e.target.querySelectorAll('[data-order-line]')];
    for (const [i, row] of rows.entries()) {
      const error = validateParts(readParts(row, 'fab'), `Product ${i + 1}`);
      if (error) { e.preventDefault(); e.stopImmediatePropagation(); toast(error); return; }
    }
  }, true);

  /* ---------- Order view: fabric details panel ---------- */
  const fabricJob = o => { const p = o.processes?.find(x => x.name === 'Fabric Work'); return p ? jobId(o, p) : ''; };
  function fabricPanel(o) {
    const rows = (o.items || []).flatMap((it, i) => partsOf(it).filter(hasFabric).map(p => ({ it, i, p })));
    const total = rows.reduce((n, r) => n + r.p.qty, 0), job = fabricJob(o);
    const actions = `${job ? `<button type="button" class="compact-button" data-job="${esc(job)}">Open fabric job sheet</button>` : ''}${isAdmin() ? `<button type="button" class="compact-button" data-edit-order="${esc(o.id)}">${rows.length ? 'Edit fabric' : 'Add fabric details'}</button>` : ''}`;
    const body = !o.items?.length
      ? '<p class="empty-note">This order has no product lines, so there is no fabric to split by seat and cushion.</p>'
      : rows.length
        ? `<div class="table-wrap"><table class="data-table fabric-table"><thead><tr><th>PRODUCT</th><th>PART</th><th>FABRIC CODE</th><th>COMPANY</th><th>REQUIRED</th></tr></thead><tbody>${rows.map(({ it, i, p }) => `<tr><td><strong>${esc(it.sku || `Product ${i + 1}`)}</strong><small class="cell-sub">${esc(it.name || '')}</small></td><td>${esc(p.label)}</td><td>${esc(p.code || '—')}</td><td>${esc(p.company || '—')}</td><td>${p.qty ? `${fmt(p.qty)} m` : '—'}</td></tr>`).join('')}</tbody><tfoot><tr><td colspan="4">Total fabric</td><td>${fmt(total)} m</td></tr></tfoot></table></div>`
        : '<p class="empty-note">No fabric added for the seat, cushion or extra cushion yet.</p>';
    return `<section class="panel fabric-details-panel"><div class="panel-header"><div><h2>Fabric details</h2><p>Seat, cushion and extra cushion fabric for each product.</p></div><div class="panel-actions">${actions}</div></div>${body}</section>`;
  }
  const baseOpenOrder = openOrder;
  openOrder = function (id) {
    baseOpenOrder(id);
    const o = db.orders.find(x => x.id === id), drawer = document.querySelector('#overlay-root .drawer');
    if (!o || !drawer) return;
    // The product cards showed one fabric per line; the fabric panel replaces those three facts.
    drawer.querySelectorAll('.order-line-facts > div').forEach(d => { if (/^FABRIC (CODE|COMPANY|REQUIRED)$/.test(d.querySelector('small')?.textContent || '')) d.remove(); });
    const anchor = drawer.querySelector('.order-lines-panel') || drawer.querySelector('.detail-facts');
    anchor?.insertAdjacentHTML('afterend', fabricPanel(o));
  };
  window.openOrder = openOrder;

  /* ---------- Edit order (admins): fabric per product line ---------- */
  const baseOpenEditOrder = openEditOrder;
  openEditOrder = function (id) {
    baseOpenEditOrder(id);
    const o = db.orders.find(x => x.id === id), form = document.querySelector('#edit-order-form');
    if (!o || !form || !isAdmin()) return;
    const card = form.closest('.modal-card');
    card?.classList.add('wide-modal');
    const blocks = o.items?.length
      ? o.items.map((it, i) => `<div class="fabric-edit-line"><div class="fabric-edit-head"><strong>Product ${i + 1} · ${esc(it.sku || 'No SKU')}</strong><span>${esc(it.name || '')} · ${esc(it.qty)} units</span></div>${partsBlock(`fabedit-${i}`, fabricsOf(it), 'Fabric')}</div>`).join('')
      : '<p class="empty-note">This order has no product lines, so fabric cannot be split by seat and cushion.</p>';
    const issued = Array.isArray(o.materialsIssued);
    form.querySelector('.form-actions')?.insertAdjacentHTML('beforebegin', `<section class="fabric-edit"><div class="panel-header"><div><h2>Fabric details</h2><p>Seat, cushion and extra cushion for each product.${issued ? ' Changing metres, code or company corrects the fabric taken out of inventory for this order.' : ''}</p></div></div>${blocks}${codeList()}</section>`);
  };
  window.openEditOrder = openEditOrder;

  const issuedEntry = (o, i, key) => o.materialsIssued?.find(x => x.material === 'Fabric' && x.line === i && (x.part || 'seat') === key)
    || (key === 'seat' ? o.materialsIssued?.find(x => x.material === 'Fabric' && x.line === undefined && String(x.detail || '').endsWith(` · ${o.items[i].sku || o.items[i].name}`)) : null);

  // Post the stock correction for one part: a changed fabric is returned and the new one issued; a changed amount moves the difference.
  function correctStock(o, i, key, label, before, after, reason) {
    const actor = currentActor(), it = o.items[i], line = it.sku || it.name, item = db.inventory.find(x => x.name === 'Fabric');
    const p = o.processes.find(x => x.name === 'Fabric Work'), job = p ? jobId(o, p) : '—';
    let seq = 0;
    const post = (type, qty, f, note) => {
      const t = { id: `TX-${Date.now().toString().slice(-6)}-F${i}${key[0]}${++seq}`, material: 'Fabric', type, qty, unit: 'm', color: '', sku: '', mm: '', company: f.company || '', code: f.code || '', colorName: '', order: o.id, job, staff: actor, enteredBy: actor, date: today(), notes: `${note} · ${o.id} · ${line} · ${label.toLowerCase()} fabric${f.code ? ` ${f.code}` : ''} · ${reason}` };
      db.transactions.unshift(t);
      if (item) { if (type === 'Outward') item.consumed += qty; else item.adjustments += qty; }
      return t;
    };
    const changedFabric = !same(before.code, after.code) || !same(before.company, after.company);
    const moves = [];
    if (changedFabric) {
      if (before.qty > 0) moves.push(post('Adjustment', before.qty, before, 'Returned to stock: fabric changed on order'));
      if (after.qty > 0) moves.push(post('Outward', after.qty, after, 'Issued for order'));
    } else if (after.qty > before.qty) moves.push(post('Outward', Math.round((after.qty - before.qty) * 10) / 10, after, 'Extra fabric issued for order'));
    else if (after.qty < before.qty) moves.push(post('Adjustment', Math.round((before.qty - after.qty) * 10) / 10, after, 'Returned to stock: less fabric needed'));
    if (!moves.length) return;
    // Keep the order's "materials issued" list in step with what is now out of stock for this part.
    let entry = issuedEntry(o, i, key);
    const detail = `${label} · ${[after.company, after.code].filter(Boolean).join(' · ') || 'Fabric'} · ${line}`;
    if (entry && after.qty > 0) Object.assign(entry, { qty: after.qty, detail, line: i, part: key, company: after.company, code: after.code, edited: true, adjustments: [...(entry.adjustments || []), ...moves.map(t => t.id)] });
    else if (entry) o.materialsIssued.splice(o.materialsIssued.indexOf(entry), 1);
    else if (after.qty > 0) o.materialsIssued.push({ material: 'Fabric', qty: after.qty, unit: 'm', detail, tx: moves[moves.length - 1].id, short: false, line: i, part: key, company: after.company, code: after.code });
  }

  function refreshFabricSheet(o) {
    const p = o.processes?.find(x => x.name === 'Fabric Work');
    if (!p?.sheet) return;
    const lines = p.sheet.lines;
    (o.items || []).forEach((it, i) => partsOf(it).forEach((part, n) => {
      const values = { part: part.label, fabricCode: part.code, fabricCompany: part.company, fabricRequired: part.qty || '' };
      const line = lines.find(l => l.item === i && l.partKey === part.key);
      if (line) Object.assign(line, values);
      else if (hasFabric(part)) lines.push({ item: i, partKey: part.key, sku: it.sku || '', product: it.name || '', qty: it.qty ?? '', dimensions: it.dimensions || '', ...values, photoData: n === 0 || !lines.some(l => l.item === i) ? it.photoData || '' : '' });
    }));
  }

  document.addEventListener('submit', e => {
    const form = e.target;
    if (form.getAttribute('id') !== 'edit-order-form' || !form.querySelector('.fabric-edit')) return;
    const o = db.orders.find(x => x.id === form.dataset.id);
    if (!o?.items?.length || !isAdmin()) return;
    const next = o.items.map((_, i) => readParts(form, `fabedit-${i}`));
    for (const [i, parts] of next.entries()) {
      const error = validateParts(parts, `Product ${i + 1}`);
      if (error) { e.preventDefault(); e.stopImmediatePropagation(); toast(error); return; }
    }
    const actor = currentActor(), stock = Array.isArray(o.materialsIssued), changes = [];
    o.items.forEach((it, i) => {
      const before = fabricsOf(it);
      setParts(it, next[i]);
      const after = fabricsOf(it);
      for (const [key, label] of PARTS) {
        const b = before[key], a = after[key];
        if (same(b.code, a.code) && same(b.company, a.company) && b.qty === a.qty) continue;
        const show = f => hasFabric(f) ? `${[f.company, f.code].filter(Boolean).join(' · ') || 'no code'} · ${fmt(f.qty)} m` : 'none';
        changes.push(`${it.sku || `Product ${i + 1}`} ${label.toLowerCase()} fabric: ${show(b)} → ${show(a)}`);
        if (stock) correctStock(o, i, key, label, b, a, 'edited by ' + actor);
      }
    });
    if (!changes.length) return;
    const total = o.items.reduce((n, it) => n + num(it.fabricRequired), 0);
    o.materials = { ...(o.materials || {}), Fabric: total };
    const p = o.processes.find(x => x.name === 'Fabric Work');
    if (p) { p.material = 'Fabric'; p.required = total; if (stock) p.issued = (o.materialsIssued || []).filter(x => x.material === 'Fabric').reduce((n, x) => n + num(x.qty), 0); }
    for (const r of (typeof trackerRows !== 'undefined' ? trackerRows : []).filter(r => r.orderNo === o.id)) { if (total > 0) { r.fabricRequired = 'Yes'; if (r.fabricStatus === 'Not Required') r.fabricStatus = 'Pending'; } }
    refreshFabricSheet(o);
    changes.forEach(c => addActivity(actor, o.id, c));
    if (stock) addActivity(actor, 'Fabric', `Fabric stock corrected for ${o.id} after the order's fabric was edited`);
    try { localStorage.setItem('umami-production-tracker-v1', JSON.stringify(trackerRows)); } catch (err) { /* storage blocked */ }
    persist();
  }, true);
})();
