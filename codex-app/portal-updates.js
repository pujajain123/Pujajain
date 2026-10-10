/* Inventory, accountability, and WhatsApp report handoff enhancements. */
(() => {
  const FABRIC_COMPANIES = ['Agora', 'SUNBRELLA', 'D’Decor', 'Gaurika', 'Asadeep', 'Sun N Joy', 'Others'];
  const WHATSAPP_REPORT_TO = '919833628272';
  const safeNumber = value => {
    const n = parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const inventoryItem = name => db.inventory.find(item => item.name === name);
  function customSelect(name, id, options, selectedValue) {
    const selected = options.find(option => option.value === selectedValue) || options[0];
    return `<div class="app-select" data-custom-select><input type="hidden" name="${esc(name)}" ${id ? `id="${esc(id)}"` : ''} value="${esc(selected.value)}"><button class="app-select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">${esc(selected.label)}</button><div class="app-select-menu" role="listbox" hidden>${options.map(option => `<button class="app-select-option ${option.value === selected.value ? 'selected' : ''}" type="button" role="option" aria-selected="${option.value === selected.value}" data-custom-option="${esc(option.value)}">${esc(option.label)}${option.value === selected.value ? '<span>✓</span>' : ''}</button>`).join('')}</div></div>`;
  }
  function enhanceNativeSelects(root = document) {
    root.querySelectorAll('select:not(.app-select-native)').forEach(select => {
      const options = [...select.options].map(option => ({ value: option.value, label: option.textContent.trim() }));
      const selectedValue = select.value;
      const selected = options.find(option => option.value === selectedValue) || options[0];
      const control = document.createElement('div');
      control.className = 'app-select';
      control.dataset.customSelect = '';
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'app-select-trigger';
      trigger.textContent = selected?.label || '';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      const menu = document.createElement('div');
      menu.className = 'app-select-menu';
      menu.setAttribute('role', 'listbox');
      menu.hidden = true;
      options.forEach(option => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `app-select-option${option.value === selectedValue ? ' selected' : ''}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(option.value === selectedValue));
        item.dataset.customOption = option.value;
        item.textContent = option.label;
        if (option.value === selectedValue) item.insertAdjacentHTML('beforeend', '<span>✓</span>');
        menu.append(item);
      });
      select.classList.add('app-select-native');
      select.setAttribute('aria-hidden', 'true');
      select.tabIndex = -1;
      select.parentNode.insertBefore(control, select);
      control.append(select, trigger, menu);
    });
  }
  const stockFromWorkbook = () => (ropeSheetData?.stock_master || []).reduce((sum, row) => {
    const opening = safeNumber(row['Opening Stock (m)']);
    const purchased = safeNumber(row['Total Purchased (m)']);
    const outward = safeNumber(row['Total Outward (m)']);
    return sum + (row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null
      ? opening + purchased - outward
      : safeNumber(row['Current Balance (m)']));
  }, 0);

  // Keep exactly the three requested material categories in the inventory UI.
  db.inventory = ['Rope', 'Fabric', 'Powder Color'].map(name => inventoryItem(name) || ({
    name,
    unit: name === 'Rope' ? 'm' : name === 'Fabric' ? 'm' : 'kg',
    opening: 0, incoming: 0, adjustments: 0, reserved: 0, consumed: 0, wastage: 0, reorder: 0,
  }));
  db.transactions ||= [];
  db.activity ||= [];
  if (!db.inventoryUnitMigrationV1) {
    inventoryItem('Rope').unit = 'm';
    db.inventoryUnitMigrationV1 = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  // Clearly marked sample audit events demonstrate staff attribution in this demo.
  if (!db.sampleAuditEventsAdded) {
    const now = new Date();
    const at = minutesAgo => new Date(now.getTime() - minutesAgo * 60000).toISOString();
    const sampleDate = now.toISOString().slice(0, 10);
    const sampleOrder = db.orders.find(order => order.id === 'UM-1047');
    if (sampleOrder) { sampleOrder.createdBy = 'Rahul Mehta'; sampleOrder.createdByDemo = true; }
    inventoryItem('Fabric').incoming += 18;
    db.transactions.unshift({ id: 'TX-DEMO-001', material: 'Fabric', type: 'Incoming', qty: 18, unit: 'm', company: 'Agora', order: '—', job: '—', staff: 'Neha Kapoor', enteredBy: 'Neha Kapoor', date: sampleDate, notes: 'Sample entry for staff accountability', demo: true });
    db.activity.unshift(
      { time: at(15), actor: 'Neha Kapoor', entity: 'Fabric', text: 'DEMO · Incoming fabric transaction TX-DEMO-001 recorded · Agora · 18 m' },
      { time: at(34), actor: 'Amit Shah', entity: 'UM-1048', text: 'DEMO · Product colour detail updated · Natural cotton rope' },
      { time: at(57), actor: 'Rahul Mehta', entity: 'UM-1047', text: 'DEMO · Order specification entered · Dining set production note' },
    );
    db.sampleAuditEventsAdded = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  function renderInventory() {
    const fabric = inventoryItem('Fabric');
    const powder = inventoryItem('Powder Color');
    const summaries = [
      { name: 'Rope', unit: 'm', available: stockFromWorkbook(), note: 'Imported stock by SKU, colour and millimetre size' },
      { name: 'Fabric', unit: 'm', available: fabric.opening + fabric.incoming + fabric.adjustments - fabric.reserved - fabric.consumed - fabric.wastage, note: 'Track supplier and fabric metres on each transaction' },
      { name: 'Powder Color', unit: 'kg', available: powder.opening + powder.incoming + powder.adjustments - powder.reserved - powder.consumed - powder.wastage, note: 'Track each manually entered colour and its weight' },
    ];
    const rows = [...db.transactions].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const transactionDetails = t => [t.sku && `SKU ${t.sku}`, t.mm && `${t.mm} mm`, t.color && `Colour ${t.color}`, t.company && t.company, t.colorName && `Colour ${t.colorName}`].filter(Boolean).join(' · ') || '—';
    return `${header('OPERATIONS', 'Inventory', 'Rope, fabric and powder colour stock with a traceable staff ledger.', button('Add transaction', 'new-transaction', 'primary-button', '＋'))}
      <div class="stock-grid inventory-category-grid">${summaries.map(s => `<section class="stock-card inventory-category-card"><div class="stock-card-top"><div><h2>${s.name}</h2><p>${esc(s.note)}</p></div>${chip(s.available > 0 ? 'In stock' : 'No stock recorded')}</div><div class="stock-number">${s.available.toLocaleString('en-IN', { maximumFractionDigits: 1 })}<span class="stock-unit"> ${s.unit} on hand</span></div><button class="compact-button" type="button" data-inventory-start="${s.name}">Add ${s.name} transaction</button></section>`).join('')}</div>
      <section class="panel table-panel inventory-ledger"><div class="panel-header"><div><h2>Transaction and staff history</h2><p>Each entry records who entered it and its material details.</p></div><span class="eyebrow">${rows.length} RECORDS</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>TRANSACTION</th><th>INVENTORY</th><th>DETAILS</th><th>MOVEMENT</th><th>ORDER / JOB</th><th>ENTERED BY</th><th>DATE</th></tr></thead><tbody>${rows.length ? rows.map(t => `<tr><td class="id-cell">${esc(t.id)}${t.demo ? '<small style="display:block;color:#b87824">DEMO</small>' : ''}</td><td>${esc(t.material)}</td><td>${esc(transactionDetails(t))}</td><td>${esc(t.type)} · ${t.type === 'Outward' || t.type === 'Consumption' || t.type === 'Wastage' ? '−' : '+'}${esc(t.qty)} ${esc(t.unit || inventoryItem(t.material)?.unit || '')}</td><td>${esc(t.order || '—')}<small style="display:block;color:#9ca49f;margin-top:3px">${esc(t.job || '—')}</small></td><td>${esc(t.enteredBy || t.staff || 'Unknown')}</td><td>${fmtDate(t.date)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty-state">No inventory transactions yet.</td></tr>'}</tbody></table></div></section>
      <details class="inventory-source-details"><summary>Rope workbook detail · stock master, purchase log and outward log</summary>${renderRopeInventory()}</details>`;
  }
  window.renderInventory = renderInventory;

  function updateInventoryFields(select) {
    if (!select) return;
    const material = select.value;
    document.querySelectorAll('[data-inventory-field]').forEach(field => {
      const show = field.dataset.inventoryField === (material === 'Powder Color' ? 'powder' : material.toLowerCase());
      field.hidden = !show;
      const input = field.querySelector('input,select');
      if (input) {
        input.required = show;
        if (!show && input.type !== 'hidden') input.value = input.tagName === 'SELECT' ? input.options[0]?.value || '' : '';
      }
    });
    const label = document.querySelector('#inventory-quantity-label');
    if (label) label.textContent = material === 'Powder Color' ? 'Weight (kg)' : material === 'Rope' ? 'Rope quantity (m)' : 'Fabric quantity (m)';
    const quantity = document.querySelector('#transaction-form [name="qty"]');
    if (quantity) quantity.placeholder = material === 'Powder Color' ? 'Weight in kilograms' : 'Quantity in metres';
  }

  function updateRopeWorkbook(d) {
    if (!ropeSheetData) return;
    const masters = ropeSheetData.stock_master || (ropeSheetData.stock_master = []);
    let row = masters.find(item => String(item['Rope Type (SKU)'] || '').trim().toLowerCase() === d.sku.trim().toLowerCase()
      && String(item.mm || '').trim().toLowerCase() === `${d.mm}mm`.toLowerCase()
      && String(item.Color || '').trim().toLowerCase() === d.color.trim().toLowerCase());
    if (!row) {
      row = { 'Rope Type (SKU)': d.sku, mm: `${d.mm}mm`, Color: d.color, 'Opening Stock (m)': '0', 'Total Purchased (m)': '0', 'Total Outward (m)': '0', 'Current Balance (m)': '0', '': '' };
      masters.push(row);
    }
    const purchased = safeNumber(row['Total Purchased (m)']);
    const outward = safeNumber(row['Total Outward (m)']);
    const current = row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null
      ? safeNumber(row['Opening Stock (m)']) + purchased - outward
      : safeNumber(row['Current Balance (m)']);
    if (d.type === 'Incoming') {
      row['Total Purchased (m)'] = String(purchased + d.qty);
      row['Current Balance (m)'] = String(current + d.qty);
      (ropeSheetData.purchase_log ||= []).unshift({ Date: fmtDate(d.date, { day: '2-digit', month: 'short', year: 'numeric' }), 'Rope Type (SKU)': d.sku, mm: `${d.mm}mm`, Color: d.color, 'Qty Purchased (m)': String(d.qty), Supplier: '', 'Invoice/Bill No.': '', 'Rate (per m)': '', Remarks: d.notes || `Entered by ${d.enteredBy}` });
    } else if (d.type === 'Outward') {
      row['Total Outward (m)'] = String(outward + d.qty);
      row['Current Balance (m)'] = String(current - d.qty);
      (ropeSheetData.outward_log ||= []).unshift({ Date: fmtDate(d.date, { day: '2-digit', month: 'short', year: 'numeric' }), 'Rope Type (SKU)': d.sku, mm: `${d.mm}mm`, Color: d.color, 'Qty Out (m)': String(d.qty), 'Issued To': d.enteredBy, 'Used For (Job/Product)': d.order, Remarks: d.notes || '' });
    }
    localStorage.setItem('umami-rope-inventory-v1', JSON.stringify(ropeSheetData));
  }

  function submitTransaction(form) {
    const d = Object.fromEntries(new FormData(form));
    const material = d.material;
    const qty = Number(d.qty);
    const actor = currentActor();
    const item = inventoryItem(material);
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (material === 'Rope') updateRopeWorkbook({ ...d, qty, enteredBy: actor });
    else if (d.type === 'Incoming') item.incoming += qty;
    else if (d.type === 'Outward') item.consumed += qty;
    else item.adjustments += qty;
    const transaction = {
      id: `TX-${Date.now()}`, material, type: d.type, qty, unit: material === 'Powder Color' ? 'kg' : 'm',
      color: material === 'Rope' ? d.color || '' : '', sku: material === 'Rope' ? d.sku || '' : '', mm: material === 'Rope' ? d.mm || '' : '', company: material === 'Fabric' ? d.company || '' : '', colorName: material === 'Powder Color' ? d.colorName || '' : '',
      order: d.order || '—', job: '—', staff: actor, enteredBy: actor, date: d.date,
      notes: d.notes || '',
    };
    db.transactions.unshift(transaction);
    addActivity(actor, d.order && d.order !== '—' ? d.order : material, `${material} ${d.type.toLowerCase()} transaction · ${qty} ${transaction.unit}${d.sku ? ` · ${d.sku}` : ''}${d.company ? ` · ${d.company}` : ''}${d.colorName ? ` · ${d.colorName}` : ''}`);
    document.querySelector('#overlay-root').innerHTML = '';
    save();
    toast(`${material} transaction saved by ${actor}.`);
  }

  const originalRenderOrders = renderOrders;
  renderOrders = function () {
    return originalRenderOrders()
      .replace('<th>DEADLINE</th><th>PROGRESS</th>', '<th>DEADLINE</th><th>CREATED BY</th><th>PROGRESS</th>')
      .replace(/<tr data-order="([^"]+)">(.*?)<\/tr>/g, (match, id) => {
        const order = db.orders.find(o => o.id === id);
        return match.replace('<td class="progress-cell">', `<td>${esc(order?.createdBy || 'Unknown')}${order?.createdByDemo ? '<small style="display:block;color:#b87824">DEMO</small>' : ''}</td><td class="progress-cell">`);
      });
  };

  const originalOpenOrder = openOrder;
  openOrder = function (id) {
    originalOpenOrder(id);
    const order = db.orders.find(item => item.id === id);
    if (order?.createdByDemo) {
      const creator = document.querySelector('#overlay-root .order-audit > div:first-child strong');
      if (creator && !creator.parentElement.querySelector('.audit-demo-note')) creator.insertAdjacentHTML('afterend', '<small class="audit-demo-note">DEMO</small>');
    }
  };
  window.openOrder = openOrder;

  function monthlyReportText() {
    const today = new Date();
    const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = today.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    const orders = db.orders.filter(o => String(o.orderDate || '').startsWith(monthKey));
    const completed = orders.filter(o => o.stage === 'Completed').length;
    const late = orders.filter(isLate).length;
    const jobs = getJobs();
    const contributors = [...new Set(db.activity.filter(a => String(a.time || '').startsWith(monthKey)).map(a => a.actor).filter(a => a && a !== 'System'))].slice(0, 4);
    return [
      `Umami Studios · Monthly operations report · ${monthLabel}`,
      `Orders raised: ${orders.length}`,
      `Completed: ${completed} · Active overdue: ${late}`,
      `Production jobs completed: ${jobs.filter(j => j.p.status === 'Completed').length}/${jobs.length}`,
      `Inventory transactions: ${db.transactions.filter(t => String(t.date || '').startsWith(monthKey)).length}`,
      contributors.length ? `Team activity: ${contributors.join(', ')}` : '',
      'Generated from the Umami Studios operations portal.',
    ].filter(Boolean).join('\n');
  }

  function openWhatsAppReport() {
    const link = document.createElement('a');
    link.href = `https://wa.me/${WHATSAPP_REPORT_TO}?text=${encodeURIComponent(monthlyReportText())}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
    addActivity(currentActor(), 'Reports', `Opened monthly report draft for WhatsApp recipient +91 98336 28272`);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    toast('WhatsApp opened with the monthly report ready to review and send.');
  }

  const originalRenderReports = renderReports;
  renderReports = function () {
    const schedule = db.whatsappMonthly || { enabled: false, day: 1 };
    const reportDays = Array.from({ length: 28 }, (_, i) => i + 1).map(day => ({
      value: String(day),
      label: `${day}${day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'} of the month`,
    }));
    const rangeOptions = ['Last 30 days', 'Last 7 days', 'This quarter', 'All time'].map(value => ({ label: value, value }));
    const base = originalRenderReports().replace(/<select id="report-range">[\s\S]*?<\/select>/, customSelect('reportRange', 'report-range', rangeOptions, rangeOptions[0].value));
    return `${base}<section class="panel whatsapp-report-panel"><div class="panel-header"><div><div class="eyebrow">WHATSAPP REPORTS</div><h2>Monthly report delivery</h2><p>Recipient: +91 98336 28272</p></div><button type="button" class="primary-button" data-send-whatsapp-report>Open report in WhatsApp ↗</button></div><form id="whatsapp-schedule-form" class="whatsapp-schedule"><label class="checkbox-line"><input name="enabled" type="checkbox" ${schedule.enabled ? 'checked' : ''}> Request automatic monthly delivery</label><label class="field"><span>Send day each month</span>${customSelect('day', '', reportDays, String(schedule.day))}</label><button class="secondary-button">Save schedule preference</button></form><div class="info-banner">${schedule.enabled ? 'Preference saved locally. Automatic delivery is not connected yet.' : 'Automatic sending needs a server scheduler and WhatsApp Business API credentials. This browser-only portal cannot send reports while closed.'} The WhatsApp button opens a prepared draft; WhatsApp requires its Send action.</div></section>`;
  };

  const originalExportCSV = exportCSV;
  exportCSV = function () {
    const rows = [['Order ID', 'Client', 'Product', 'Quantity', 'Stage', 'Deadline', 'Progress', 'Created by', 'Last updated by'],
      ...db.orders.map(o => [o.id, o.client, o.product, o.qty, o.stage, o.deadline, `${progress(o)}%`, o.createdBy || 'Unknown', o.updatedBy || '—'])];
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'umami-order-report.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Order and staff accountability report exported.');
  };

  openTransaction = function (material) {
    const selected = ['Rope', 'Fabric', 'Powder Color'].includes(material) ? material : 'Rope';
    // Build this form directly; the legacy form is bypassed so role attribution cannot be edited.
    const selectMaterial = selected;
    const formHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">INVENTORY · ${db.role === 'Staff' ? 'STAFF ENTRY' : 'ADMIN ENTRY'}</div><h2>Record an inventory transaction</h2><p>Required details are recorded with the current user.</p></div><button class="close-button" data-close>×</button></div><form id="transaction-form"><div class="form-grid"><div class="field"><label>Inventory category</label>${customSelect('material', 'inventory-material', ['Rope','Fabric','Powder Color'].map(name=>({label:name,value:name})), selectMaterial)}</div><div class="field"><label>Transaction type</label>${customSelect('type', '', ['Incoming','Outward'].map(name=>({label:name,value:name})), 'Incoming')}</div><div class="field" data-inventory-field="rope"><label>Colour</label><input name="color" placeholder="Enter rope colour" required></div><div class="field" data-inventory-field="rope"><label>SKU</label><input name="sku" placeholder="Rope SKU / type" required></div><div class="field" data-inventory-field="rope"><label>Rope size (mm)</label><input name="mm" type="number" min="0.1" step="0.1" placeholder="e.g. 8" required></div><div class="field" data-inventory-field="fabric"><label>Company</label>${customSelect('company', '', FABRIC_COMPANIES.map(name=>({label:name,value:name})), FABRIC_COMPANIES[0])}</div><div class="field" data-inventory-field="powder"><label>Colour name</label><input name="colorName" placeholder="Enter powder colour" required></div><div class="field"><label id="inventory-quantity-label">${selectMaterial==='Powder Color'?'Weight (kg)':selectMaterial==='Rope'?'Rope quantity (m)':'Fabric quantity (m)'}</label><input name="qty" type="number" min="0.1" step="0.1" required></div><div class="field"><label>Related order (optional)</label>${customSelect('order', '', [{label:'None',value:'—'}, ...db.orders.map(o=>({label:`${o.id} · ${o.client}`,value:o.id}))], '—')}</div><div class="field"><label>Entered by</label><input value="${esc(currentActor())}" readonly></div><div class="field"><label>Date</label><input name="date" type="date" value="${new Date().toISOString().slice(0,10)}" required></div><div class="field full"><label>Notes (optional)</label><textarea name="notes"></textarea></div></div><div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save transaction</button></div></form></section></div>`;
    document.querySelector('#overlay-root').innerHTML = formHTML;
    updateInventoryFields(document.querySelector('#inventory-material'));
  };
  window.openTransaction = openTransaction;
  window.submitTransaction = submitTransaction;

  document.addEventListener('change', event => {
    if (event.target.id === 'inventory-material') updateInventoryFields(event.target);
  });
  document.addEventListener('click', event => {
    const option = event.target.closest('[data-custom-option]');
    if (option) {
      const control = option.closest('[data-custom-select]');
      const value = control.querySelector('input[type="hidden"]');
      const nativeSelect = control.querySelector('select.app-select-native');
      const trigger = control.querySelector('.app-select-trigger');
      if (value) value.value = option.dataset.customOption;
      if (nativeSelect) nativeSelect.value = option.dataset.customOption;
      trigger.textContent = option.textContent.replace('✓', '').trim();
      trigger.setAttribute('aria-expanded', 'false');
      control.querySelector('.app-select-menu').hidden = true;
      control.querySelectorAll('[data-custom-option]').forEach(item => {
        const selected = item.dataset.customOption === value.value;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      if (value) value.dispatchEvent(new Event('change', { bubbles: true }));
      if (nativeSelect) nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const trigger = event.target.closest('.app-select-trigger');
    if (trigger) {
      const control = trigger.closest('[data-custom-select]');
      document.querySelectorAll('.app-select-menu:not([hidden])').forEach(menu => {
        menu.hidden = true;
        menu.previousElementSibling?.setAttribute('aria-expanded', 'false');
      });
      const menu = control.querySelector('.app-select-menu');
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      return;
    }
    document.querySelectorAll('.app-select-menu:not([hidden])').forEach(menu => {
      menu.hidden = true;
      menu.previousElementSibling?.setAttribute('aria-expanded', 'false');
    });
    const start = event.target.closest('[data-inventory-start]');
    if (start) openTransaction(start.dataset.inventoryStart);
    if (event.target.closest('[data-send-whatsapp-report]')) openWhatsAppReport();
  });
  document.addEventListener('submit', event => {
    if (event.target.id === 'whatsapp-schedule-form') {
      event.preventDefault();
      const form = new FormData(event.target);
      db.whatsappMonthly = { enabled: form.has('enabled'), day: Number(form.get('day')) || 1, recipient: WHATSAPP_REPORT_TO, updatedBy: currentActor(), updatedAt: new Date().toISOString() };
      addActivity(currentActor(), 'Reports', `Monthly WhatsApp report preference ${db.whatsappMonthly.enabled ? 'enabled' : 'disabled'} for day ${db.whatsappMonthly.day}`);
      save();
      toast('Monthly report preference saved. Delivery still needs server and WhatsApp API setup.');
    }
  });

  const previousRender = render;
  render = function () {
    previousRender();
    enhanceNativeSelects();
  };
  window.render = render;
  const selectObserver = new MutationObserver(() => enhanceNativeSelects());
  selectObserver.observe(document.body, { childList: true, subtree: true });
  render();
})();
