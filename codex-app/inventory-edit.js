/* Editing inventory entries and correcting stock counts.
   An edit never overwrites history: the original entry stays in the ledger (marked as replaced), its effect on
   stock is reversed, and the corrected entry is posted with who edited it and why. Admins can edit any entry,
   staff only their own. "Adjust stock" posts an adjustment for the difference to a counted quantity. */
(() => {
  const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const FABRIC_COMPANIES = ['Agora', 'SUNBRELLA', 'D’Decor', 'Gaurika', 'Asadeep', 'Sun N Joy', 'Others'];
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  const isAdmin = () => db.role !== 'Staff';
  const canEdit = t => !t.replacedBy && !t.demo && (isAdmin() || t.enteredBy === currentActor() || t.staff === currentActor());
  const inv = name => db.inventory.find(i => i.name === name);
  const onHand = item => item.opening + item.incoming + item.adjustments - item.reserved - item.consumed - item.wastage;

  /* Apply (sign 1) or reverse (sign -1) an entry's effect on stock, as the server does. */
  function applyLocal(t, sign) {
    const q = sign * num(t.qty);
    if (t.material === 'Rope' && t.sku && (t.type === 'Incoming' || t.type === 'Outward' || t.type === 'Adjustment') && ropeSheetData) {
      const rows = ropeSheetData.stock_master || (ropeSheetData.stock_master = []);
      const size = v => String(v ?? '').trim().replace(/\s*mm$/i, '').trim().toLowerCase();
      let row = rows.find(r => same(r['Rope Type (SKU)'], t.sku) && size(r.mm) === size(t.mm) && same(r.Color, t.color));
      if (!row) { row = { 'Rope Type (SKU)': t.sku, mm: `${t.mm}mm`, Color: t.color, 'Opening Stock (m)': '0', 'Total Purchased (m)': '0', 'Total Outward (m)': '0', 'Current Balance (m)': '0', '': '' }; rows.push(row); }
      const current = row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null
        ? num(row['Opening Stock (m)']) + num(row['Total Purchased (m)']) - num(row['Total Outward (m)']) : num(row['Current Balance (m)']);
      if (t.type === 'Incoming') { row['Total Purchased (m)'] = String(num(row['Total Purchased (m)']) + q); row['Current Balance (m)'] = String(current + q); }
      else if (t.type === 'Adjustment') row['Current Balance (m)'] = String(current + q); // a stock count correction
      else { row['Total Outward (m)'] = String(num(row['Total Outward (m)']) + q); row['Current Balance (m)'] = String(current - q); }
      localStorage.setItem('umami-rope-inventory-v1', JSON.stringify(ropeSheetData));
      return;
    }
    const item = inv(t.material);
    if (!item) return;
    if (t.type === 'Incoming') item.incoming += q;
    else if (t.type === 'Outward' || t.type === 'Consumption') item.consumed += q;
    else if (t.type === 'Wastage') item.wastage += q;
    else item.adjustments += q;
  }

  window.umamiApplyStock = applyLocal;

  /* ---------- Ledger: hide replaced entries, add Edit, mark edited ones; Adjust stock on the cards ---------- */
  const baseRenderInventory = window.renderInventory;
  window.renderInventory = renderInventory = function () {
    const all = db.transactions;
    db.transactions = all.filter(t => !t.replacedBy);
    let html;
    try { html = baseRenderInventory(); } finally { db.transactions = all; }
    const byId = new Map(all.map(t => [t.id, t]));
    html = html
      .replace('<th>DATE</th></tr>', '<th>DATE</th><th></th></tr>')
      .replace('colspan="7" class="empty-state"', 'colspan="8" class="empty-state"')
      .replace(/<tr><td class="id-cell">([^<]+)([\s\S]*?)<\/tr>/g, (row, id, rest) => {
        const t = byId.get(id.trim());
        if (!t) return row;
        const tag = t.replaces ? `<small class="edited-tag" title="${esc(`Edited by ${t.editedBy || ''}${t.reason ? ' · ' + t.reason : ''}`)}">EDITED</small>` : '';
        return `<tr><td class="id-cell">${id}${tag}${rest.replace('· +-', '· −')}<td>${canEdit(t) ? `<button type="button" class="compact-button" data-tx-edit="${esc(t.id)}">Edit</button>` : ''}</td></tr>`;
      });
    for (const name of ['Fabric', 'Powder Color']) {
      html = html.replace(`data-inventory-start="${name}">Add ${name} transaction</button>`, `data-inventory-start="${name}">Add ${name} transaction</button><button class="compact-button" type="button" data-stock-adjust="${name}">Adjust stock</button>`);
    }
    return html;
  };

  /* ---------- Edit an entry ---------- */
  function fields(t) {
    if (t.type === 'Adjustment') return `<div class="field"><label>Adjustment (${t.unit || (t.material === 'Powder Color' ? 'kg' : 'm')}, use − to reduce)</label><input name="qty" type="number" step="0.1" value="${esc(t.qty)}" required></div>`;
    const typeSel = `<div class="field"><label>Movement</label><select name="type">${['Incoming', 'Outward'].map(x => `<option ${x === (t.type === 'Consumption' ? 'Outward' : t.type) ? 'selected' : ''}>${x}</option>`).join('')}</select></div>`;
    if (t.material === 'Rope') return `${typeSel}<div class="field"><label>Colour</label><input name="color" value="${esc(t.color)}"></div><div class="field"><label>SKU</label><input name="sku" value="${esc(t.sku)}"></div><div class="field"><label>MM (rope size)</label><input name="mm" value="${esc(t.mm)}"></div><div class="field"><label>Quantity (m)</label><input name="qty" type="number" min="0.1" step="0.1" value="${esc(t.qty)}" required></div>`;
    if (t.material === 'Fabric') return `${typeSel}<div class="field"><label>Company</label><select name="company">${FABRIC_COMPANIES.map(c => `<option ${same(c, t.company) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div><div class="field"><label>Fabric code</label><input name="code" value="${esc(t.code || '')}" maxlength="60"></div><div class="field"><label>Meters</label><input name="qty" type="number" min="0.1" step="0.1" value="${esc(t.qty)}" required></div>`;
    return `${typeSel}<div class="field"><label>Colour name</label><input name="colorName" value="${esc(t.colorName)}"></div><div class="field"><label>Weight (kg)</label><input name="qty" type="number" min="0.1" step="0.1" value="${esc(t.qty)}" required></div>`;
  }

  function openEdit(id) {
    const t = db.transactions.find(x => x.id === id);
    if (!t || !canEdit(t)) return toast('This entry cannot be edited.');
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">EDIT INVENTORY ENTRY · ${esc(t.id)}</div><h2>${esc(t.material)}${t.order && t.order !== '—' ? ` · ${esc(t.order)}` : ''}</h2><p>Entered by ${esc(t.enteredBy || t.staff || 'Unknown')} on ${fmtDate(t.date)}. The original stays in the history; stock is corrected.</p></div><button class="close-button" data-close>×</button></div>
      <form id="tx-edit-form"><input type="hidden" name="replaces" value="${esc(t.id)}"><div class="form-grid">${fields(t)}<div class="field full"><label>Reason for the change</label><input name="reason" required placeholder="e.g. wrong quantity typed"></div></div>
      <div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save changes</button></div></form></section></div>`;
  }

  function submitEdit(form) {
    const d = Object.fromEntries(new FormData(form)), old = db.transactions.find(x => x.id === d.replaces);
    if (!old || !canEdit(old)) return toast('This entry cannot be edited.');
    const qty = num(d.qty);
    if (old.type === 'Adjustment' ? qty === 0 : qty <= 0) return toast('Enter a quantity.');
    const actor = currentActor();
    const t = {
      ...old, id: `TX-${Date.now().toString().slice(-6)}-E`, qty, type: old.type === 'Adjustment' ? 'Adjustment' : d.type || old.type,
      color: d.color ?? old.color, sku: d.sku ?? old.sku, mm: d.mm ?? old.mm, company: d.company ?? old.company, code: d.code ?? old.code ?? '', colorName: d.colorName ?? old.colorName,
      replaces: old.id, editedBy: actor, editedAt: new Date().toISOString(), reason: d.reason, staff: old.staff, enteredBy: old.enteredBy,
    };
    delete t.replacedBy;
    applyLocal(old, -1);
    applyLocal(t, 1);
    old.replacedBy = t.id;
    db.transactions.unshift(t);
    addActivity(actor, old.material, `Edited inventory entry ${old.id} → ${t.id}: ${old.type} ${fmt(old.qty)} → ${t.type} ${fmt(qty)} ${t.unit || ''} · ${d.reason}`);
    document.querySelector('#overlay-root').innerHTML = '';
    save();
    toast(`Entry updated. Stock corrected by ${fmt(Math.abs((t.type === old.type ? qty - num(old.qty) : qty + num(old.qty))))} ${t.unit || ''}.`);
  }

  /* ---------- Adjust stock to a counted quantity ---------- */
  function openAdjust(name) {
    const item = inv(name);
    if (!item) return;
    const unit = name === 'Powder Color' ? 'kg' : 'm';
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">ADJUST STOCK</div><h2>${esc(name)}</h2><p>The system shows ${fmt(onHand(item))} ${unit} on hand. Enter what you actually counted; the difference is recorded as an adjustment.</p></div><button class="close-button" data-close>×</button></div>
      <form id="stock-adjust-form"><input type="hidden" name="material" value="${esc(name)}"><div class="form-grid"><div class="field"><label>Counted stock (${unit})</label><input name="count" type="number" min="0" step="0.1" value="${esc(onHand(item))}" required></div><div class="field full"><label>Reason</label><input name="reason" required placeholder="e.g. monthly stock count"></div></div>
      <div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save adjustment</button></div></form></section></div>`;
  }

  function submitAdjust(form) {
    const d = Object.fromEntries(new FormData(form)), item = inv(d.material);
    if (!item) return;
    const delta = Math.round((num(d.count) - onHand(item)) * 10) / 10;
    if (!delta) { document.querySelector('#overlay-root').innerHTML = ''; return toast('Stock already matches the count.'); }
    const actor = currentActor(), unit = d.material === 'Powder Color' ? 'kg' : 'm';
    const t = { id: `TX-${Date.now().toString().slice(-6)}-A`, material: d.material, type: 'Adjustment', qty: delta, unit, color: '', sku: '', mm: '', company: '', colorName: '', order: '—', job: '—', staff: actor, enteredBy: actor, date: new Date().toISOString().slice(0, 10), notes: d.reason };
    applyLocal(t, 1);
    db.transactions.unshift(t);
    addActivity(actor, d.material, `${d.material} stock adjusted by ${delta > 0 ? '+' : ''}${fmt(delta)} ${unit} to ${fmt(num(d.count))} ${unit} · ${d.reason}`);
    document.querySelector('#overlay-root').innerHTML = '';
    save();
    toast(`${d.material} stock set to ${fmt(num(d.count))} ${unit}.`);
  }

  document.addEventListener('click', e => {
    const edit = e.target.closest('[data-tx-edit]');
    if (edit) return openEdit(edit.dataset.txEdit);
    const adj = e.target.closest('[data-stock-adjust]');
    if (adj) openAdjust(adj.dataset.stockAdjust);
  });
  document.addEventListener('submit', e => {
    const id = e.target.getAttribute('id');
    if (id !== 'tx-edit-form' && id !== 'stock-adjust-form') return;
    e.preventDefault(); e.stopImmediatePropagation();
    id === 'tx-edit-form' ? submitEdit(e.target) : submitAdjust(e.target);
  }, true);

  render();
})();
