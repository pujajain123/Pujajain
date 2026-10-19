/* Stock by item: an individual inventory record for every rope (SKU, size and colour), every fabric (company and
   fabric code) and every powder colour, on the Inventory page.
   Rope records are the rows of the rope stock workbook. Fabric and powder records are worked out from the inventory
   ledger, so incoming entries, materials issued to orders and corrections all move the right record. Stock that was
   never recorded against a code (opening stock, older entries) is shown on its own line.
   Admins and staff can edit a record: correct the counted quantity, or fix its details (company, code, colour, size).
   Every edit is posted as a ledger adjustment with who made it and why, so nothing is overwritten. */
(() => {
  const KINDS = [['Rope', 'Rope', 'm'], ['Fabric', 'Fabric', 'm'], ['Powder Color', 'Powder colour', 'kg']];
  const FABRIC_COMPANIES = ['Agora', 'SUNBRELLA', 'D’Decor', 'Gaurika', 'Asadeep', 'Sun N Joy', 'Others'];
  const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const fmt = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const norm = s => String(s ?? '').trim().toLowerCase();
  const round = n => Math.round(n * 10) / 10;
  const unitOf = kind => (kind === 'Powder Color' ? 'kg' : 'm');
  const ropeBalance = row => (row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null
    ? num(row['Opening Stock (m)']) + num(row['Total Purchased (m)']) - num(row['Total Outward (m)'])
    : num(row['Current Balance (m)']));
  const aggregate = name => { const i = db.inventory.find(x => x.name === name); return i ? i.opening + i.incoming + i.adjustments - i.reserved - i.consumed - i.wastage : 0; };
  const signed = t => { const q = num(t.qty); return t.type === 'Incoming' || t.type === 'Adjustment' ? q : ['Outward', 'Consumption', 'Wastage'].includes(t.type) ? -q : 0; };

  /* ---------- Records ---------- */
  const size = v => norm(String(v ?? '').trim().replace(/\s*mm$/i, ''));
  const keyOf = (kind, v) => kind === 'Rope' ? `${norm(v.sku)}|${size(v.mm)}|${norm(v.color)}`
    : kind === 'Fabric' ? `${norm(v.company)}|${norm(v.code)}` : norm(v.colorName);
  function records(kind) {
    if (kind === 'Rope') {
      return (ropeSheetData?.stock_master || []).filter(r => r['Rope Type (SKU)']).map(r => {
        const v = { sku: String(r['Rope Type (SKU)']).trim(), mm: String(r.mm || '').trim().replace(/\s*mm$/i, '').trim(), color: String(r.Color || '').trim() };
        return { kind, key: keyOf(kind, v), ...v, title: `${v.sku}${v.mm ? ` · ${v.mm} mm` : ''}`, sub: v.color || 'No colour', onHand: ropeBalance(r), opening: num(r['Opening Stock (m)']), purchased: num(r['Total Purchased (m)']), outward: num(r['Total Outward (m)']) };
      });
    }
    const map = new Map();
    for (const t of db.transactions) {
      if (t.material !== kind || t.replacedBy) continue;
      const v = kind === 'Fabric' ? { company: String(t.company || '').trim(), code: String(t.code || '').trim() } : { colorName: String(t.colorName || '').trim() };
      if (!Object.values(v).some(Boolean)) continue;
      const key = keyOf(kind, v);
      const r = map.get(key) || { kind, key, ...v, onHand: 0, inQty: 0, outQty: 0, entries: 0, last: null };
      const q = signed(t);
      r.onHand += q; r.entries++;
      if (q > 0) r.inQty += q; else r.outQty -= q;
      if (!r.last || String(t.date) >= String(r.last.date)) r.last = t;
      map.set(key, r);
    }
    return [...map.values()].map(r => ({ ...r, onHand: round(r.onHand), title: kind === 'Fabric' ? (r.code || 'No fabric code') : r.colorName, sub: kind === 'Fabric' ? (r.company || 'No company') : 'Powder colour' }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }
  const findRecord = (kind, key) => records(kind).find(r => r.key === key);
  const unassigned = kind => kind === 'Rope' ? 0 : round(aggregate(kind) - records(kind).reduce((n, r) => n + r.onHand, 0));
  window.umamiStockRecords = records;

  /* ---------- Inventory page section ---------- */
  let tab = 'Fabric', filter = '', flashKey = '';
  const status = r => r.onHand < 0 ? '<span class="stock-flag short">Short</span>' : r.onHand === 0 ? '<span class="stock-flag empty">Out of stock</span>' : '';
  function section() {
    const unit = unitOf(tab), label = KINDS.find(k => k[0] === tab)[1];
    const q = norm(filter);
    let body;
    if (tab === 'Rope' && !ropeSheetData) body = '<div class="empty-state">Loading rope stock…</div>';
    else {
      const all = records(tab), list = all.filter(r => !q || norm(`${r.title} ${r.sub} ${r.sku || ''} ${r.color || ''} ${r.company || ''} ${r.code || ''} ${r.colorName || ''}`).includes(q));
      const rest = unassigned(tab);
      const rows = list.map(r => `<tr data-stock-key="${esc(`${tab}|${r.key}`)}" class="${flashKey === `${tab}|${r.key}` ? 'flash-row' : ''}"><td><strong>${esc(r.title)}</strong><small class="cell-sub">${esc(r.sub)}</small></td>
        <td class="num-cell"><strong>${fmt(r.onHand)} ${unit}</strong>${status(r)}</td>
        <td>${tab === 'Rope' ? `Opening ${fmt(r.opening)} · Bought ${fmt(r.purchased)} · Used ${fmt(r.outward)}` : `In ${fmt(r.inQty)} · Out ${fmt(r.outQty)} ${unit}<small class="cell-sub">${r.last ? `Last: ${esc(r.last.type)} by ${esc(r.last.enteredBy || r.last.staff || '—')} · ${fmtDate(r.last.date)}` : ''}</small>`}</td>
        <td class="row-actions"><button type="button" class="compact-button" data-stock-edit="${esc(`${tab}|${r.key}`)}">Edit</button></td></tr>`).join('');
      const restRow = tab !== 'Rope' && Math.abs(rest) >= 0.05 && !q ? `<tr class="unassigned-row"><td><strong>Not recorded by ${tab === 'Fabric' ? 'code' : 'colour'}</strong><small class="cell-sub">Opening stock and older entries without ${tab === 'Fabric' ? 'a company or code' : 'a colour name'}</small></td><td class="num-cell"><strong>${fmt(rest)} ${unit}</strong></td><td><small class="cell-sub">Use “Add item” to record counted stock by ${tab === 'Fabric' ? 'code' : 'colour'}.</small></td><td></td></tr>` : '';
      body = `<div class="table-wrap"><table class="data-table stock-items-table"><thead><tr><th>ITEM</th><th>ON HAND</th><th>MOVEMENT</th><th></th></tr></thead><tbody>${rows || restRow ? rows + restRow : `<tr><td colspan="4" class="empty-state">${q ? `No ${label.toLowerCase()} matches “${esc(filter)}”.` : `No ${label.toLowerCase()} items recorded yet. Use “Add item” to add one.`}</td></tr>`}</tbody></table></div>`;
    }
    return `<section class="panel stock-items" id="stock-items"><div class="panel-header"><div><h2>Stock by item</h2><p>Each rope, fabric and powder colour on its own. Admin and staff can correct a count or fix an item's details; every change is kept in the history.</p></div>
      <button type="button" class="primary-button" data-stock-add="${esc(tab)}">＋ Add ${esc(label.toLowerCase())} item</button></div>
      <div class="stock-items-bar"><div class="inv-category-tabs" role="tablist">${KINDS.map(([k, l]) => `<button type="button" role="tab" class="inv-tab ${k === tab ? 'active' : ''}" aria-selected="${k === tab}" data-stock-tab="${k}">${l} <span class="tab-count">${k === 'Rope' && !ropeSheetData ? '…' : records(k).length}</span></button>`).join('')}</div>
      <input type="search" class="filter-search" id="stock-items-filter" placeholder="Filter ${esc(label.toLowerCase())} items" value="${esc(filter)}" aria-label="Filter items"></div>${body}</section>`;
  }

  const baseRenderInventory = renderInventory;
  renderInventory = function () {
    const html = baseRenderInventory();
    const at = html.indexOf('<section class="panel table-panel inventory-ledger');
    return at < 0 ? html + section() : html.slice(0, at) + section() + html.slice(at);
  };
  window.renderInventory = renderInventory;

  function rerenderSection() {
    const el = document.querySelector('#stock-items');
    if (!el) return;
    el.outerHTML = section();
  }

  /* ---------- Edit / add an item ---------- */
  function identityFields(kind, v) {
    if (kind === 'Rope') return `<div class="field"><label>Rope SKU *</label><input name="sku" value="${esc(v.sku || '')}" required maxlength="60"></div><div class="field"><label>Size (mm) *</label><input name="mm" value="${esc(v.mm || '')}" required maxlength="20" placeholder="e.g. 8"></div><div class="field"><label>Colour${v.sku ? '' : ' *'}</label><input name="color" value="${esc(v.color || '')}" maxlength="60"></div>`;
    if (kind === 'Fabric') {
      const list = v.company && !FABRIC_COMPANIES.some(c => norm(c) === norm(v.company)) ? [v.company, ...FABRIC_COMPANIES] : FABRIC_COMPANIES;
      return `<div class="field"><label>Fabric company *</label><select name="company" required><option value="">Select company</option>${list.map(c => `<option ${norm(c) === norm(v.company) ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div><div class="field"><label>Fabric code</label><input name="code" value="${esc(v.code || '')}" maxlength="60" placeholder="e.g. AG-204"></div>`;
    }
    return `<div class="field"><label>Powder colour name *</label><input name="colorName" value="${esc(v.colorName || '')}" required maxlength="60"></div>`;
  }
  function openItem(kind, key) {
    const r = key ? findRecord(kind, key) : null;
    if (key && !r) return toast('This item was changed by someone else. Reload and try again.');
    const unit = unitOf(kind), label = KINDS.find(k => k[0] === kind)[1];
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">STOCK BY ITEM · ${esc(label.toUpperCase())}</div><h2>${r ? `Edit ${esc(r.title)}` : `Add ${esc(label.toLowerCase())} item`}</h2><p>${r ? `On hand now: ${fmt(r.onHand)} ${unit}. Enter what you counted; the difference is recorded as an adjustment.` : 'Record an item you have counted. It is added to stock as an adjustment.'}</p></div><button class="close-button" data-close>×</button></div>
      <form id="stock-item-form" data-kind="${esc(kind)}" data-key="${esc(key || '')}" novalidate><div class="form-grid">${identityFields(kind, r || {})}
      <div class="field"><label>Counted on hand (${unit}) *</label><input name="count" type="number" min="0" step="0.1" value="${r ? esc(Math.max(0, r.onHand)) : ''}" required></div>
      <div class="field full"><label>Reason *</label><input name="reason" required maxlength="200" placeholder="${r ? 'e.g. monthly stock count, wrong code typed' : 'e.g. opening stock count'}"></div></div>
      <div class="form-error" role="alert" hidden></div>
      <div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">${r ? 'Save changes' : 'Add item'}</button></div></form></section></div>`;
  }

  function submitItem(form) {
    const kind = form.dataset.kind, key = form.dataset.key, d = Object.fromEntries(new FormData(form));
    const error = form.querySelector('.form-error'), fail = msg => { error.textContent = msg; error.hidden = false; };
    const v = kind === 'Rope' ? { sku: String(d.sku || '').trim(), mm: String(d.mm || '').trim(), color: String(d.color || '').trim() }
      : kind === 'Fabric' ? { company: String(d.company || '').trim(), code: String(d.code || '').trim() } : { colorName: String(d.colorName || '').trim() };
    if (kind === 'Rope' && (!v.sku || !v.mm || (!key && !v.color))) return fail(key ? 'Enter the rope SKU and size.' : 'Enter the rope SKU, size in mm and colour.');
    if (kind === 'Fabric' && !v.company) return fail('Choose the fabric company.');
    if (kind === 'Powder Color' && !v.colorName) return fail('Enter the powder colour name.');
    const rawCount = String(d.count ?? '').trim();
    if (rawCount === '' || !Number.isFinite(Number(rawCount)) || Number(rawCount) < 0) return fail('Enter the counted quantity (zero or more).');
    if (Number(rawCount) > 1e7) return fail('That quantity looks too large.');
    const reason = String(d.reason || '').trim();
    if (!reason) return fail('Enter a reason for the change.');
    const count = round(Number(rawCount)), old = key ? findRecord(kind, key) : null;
    if (key && !old) return fail('This item was changed by someone else. Close and try again.');
    const newKey = keyOf(kind, v);
    if (newKey !== key && findRecord(kind, newKey)) return fail('An item with these details already exists. Edit that item instead.');

    const actor = currentActor(), unit = unitOf(kind), posted = [];
    let seq = 0;
    const post = (fields, qty, note) => {
      if (!qty) return;
      const t = { id: `TX-${Date.now().toString().slice(-6)}-S${++seq}`, material: kind, type: 'Adjustment', qty: round(qty), unit, color: '', sku: '', mm: '', company: '', code: '', colorName: '', order: '—', job: '—', staff: actor, enteredBy: actor, date: new Date().toISOString().slice(0, 10), notes: `${note} · ${reason}`, ...fields };
      window.umamiApplyStock?.(t, 1);
      db.transactions.unshift(t);
      posted.push(t);
    };
    const name = x => kind === 'Rope' ? `${x.sku} ${x.mm} mm ${x.color}` : kind === 'Fabric' ? `${x.company}${x.code ? ` ${x.code}` : ''}` : x.colorName;
    if (!old) post(v, count, 'New item counted');
    else if (newKey === key) post(v, count - old.onHand, `Stock count: ${fmt(old.onHand)} → ${fmt(count)} ${unit}`);
    else {
      const was = kind === 'Rope' ? { sku: old.sku, mm: old.mm, color: old.color } : kind === 'Fabric' ? { company: old.company, code: old.code } : { colorName: old.colorName };
      post(was, -old.onHand, `Moved to ${name(v)}`);
      post(v, count, `Moved from ${name(was)}`);
    }
    if (!posted.length) { document.querySelector('#overlay-root').innerHTML = ''; return toast('No changes to save.'); }
    addActivity(actor, kind, !old ? `${KINDS.find(k => k[0] === kind)[1]} item added: ${name(v)} · ${fmt(count)} ${unit} · ${reason}`
      : newKey === key ? `${name(v)} stock corrected: ${fmt(old.onHand)} → ${fmt(count)} ${unit} · ${reason}`
        : `Item details changed: ${name(old)} → ${name(v)} · ${fmt(count)} ${unit} on hand · ${reason}`);
    document.querySelector('#overlay-root').innerHTML = '';
    tab = kind; filter = ''; flashKey = `${kind}|${newKey}`;
    save();
    toast(!old ? 'Item added to stock.' : 'Item updated.');
    setTimeout(() => { flashKey = ''; }, 2500);
  }

  /* ---------- Events ---------- */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-stock-tab]');
    if (t) { tab = t.dataset.stockTab; filter = ''; rerenderSection(); return; }
    const ed = e.target.closest('[data-stock-edit]');
    if (ed) { const [kind, ...rest] = ed.dataset.stockEdit.split('|'); openItem(kind, rest.join('|')); return; }
    const add = e.target.closest('[data-stock-add]');
    if (add) openItem(add.dataset.stockAdd, '');
  });
  document.addEventListener('input', e => {
    if (e.target.id !== 'stock-items-filter') return;
    filter = e.target.value;
    const pos = e.target.selectionStart;
    rerenderSection();
    const f = document.querySelector('#stock-items-filter');
    f?.focus(); f?.setSelectionRange(pos, pos);
  });
  document.addEventListener('submit', e => {
    if (e.target.getAttribute('id') !== 'stock-item-form') return;
    e.preventDefault(); e.stopImmediatePropagation();
    submitItem(e.target);
  }, true);

  // Search results jump here: show the right tab and highlight the item.
  window.umamiShowStockItem = (kind, key) => {
    tab = kind; filter = ''; flashKey = `${kind}|${key}`;
    page = 'inventory';
    if (location.hash !== '#inventory') location.hash = '#inventory'; else render();
    setTimeout(() => {
      render();
      const row = document.querySelector(`[data-stock-key="${CSS.escape(`${kind}|${key}`)}"]`) || document.querySelector('#stock-items');
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => { flashKey = ''; }, 2500);
    }, 60);
  };

  render();
})();
