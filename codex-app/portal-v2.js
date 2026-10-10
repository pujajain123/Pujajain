/* Inventory entry fields, staff entries report and the monthly CSV report. Loaded after portal-updates.js. */
(() => {
  const FABRIC_COMPANIES = ['Agora', 'SUNBRELLA', 'D’Decor', 'Gaurika', 'Asadeep', 'Sun N Joy', 'Others'];
  const CATEGORIES = ['Rope', 'Fabric', 'Powder Color'];
  const persist = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  const today = () => new Date().toISOString().slice(0, 10);
  const monthKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const unitFor = m => m === 'Powder Color' ? 'kg' : 'm';
  const saveFile = (name, blob) => window.umamiSaveFile ? window.umamiSaveFile(name, blob) : Promise.resolve(false);
  const csvBlob = rows => new Blob(['\uFEFF' + rows.map(r => r.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv' });

  /* ---------- Sample staff entries (clearly marked DEMO, removable from the Staff page) ---------- */
  if (!db.staffDemoV2) {
    const now = Date.now();
    const at = (days, hour) => { const d = new Date(now - days * 86400000); d.setHours(hour, 15, 0, 0); return d.toISOString(); };
    const day = days => at(days, 12).slice(0, 10);
    const tx = (id, days, material, staff, extra, qty) => ({ id, material, type: 'Incoming', qty, unit: unitFor(material), order: '—', job: '—', staff, enteredBy: staff, date: day(days), notes: 'Sample entry', demo: true, color: '', sku: '', mm: '', company: '', colorName: '', ...extra });
    const sampleTx = [
      tx('TX-DEMO-101', 1, 'Rope', 'Amit Shah', { color: 'Ivory', sku: 'PP-ROPE-IV', mm: '6' }, 250),
      tx('TX-DEMO-102', 2, 'Fabric', 'Neha Kapoor', { company: 'SUNBRELLA' }, 40),
      tx('TX-DEMO-103', 3, 'Powder Color', 'Rahul Mehta', { colorName: 'Matte Black' }, 25),
      tx('TX-DEMO-104', 5, 'Rope', 'Amit Shah', { color: 'Terracotta', sku: 'PP-ROPE-TC', mm: '8' }, 180),
      tx('TX-DEMO-105', 6, 'Fabric', 'Pooja Rao', { company: 'D’Decor' }, 22),
      tx('TX-DEMO-106', 8, 'Powder Color', 'Karan Patel', { colorName: 'Champagne Gold' }, 12)
    ];
    sampleTx.forEach(t => { const inv = db.inventory.find(i => i.name === t.material); if (inv && t.material !== 'Rope') inv.incoming += t.qty; });
    db.transactions.unshift(...sampleTx);
    const act = (days, hour, actor, entity, text) => ({ time: at(days, hour), actor, entity, text: `DEMO · ${text}`, demo: true });
    db.activity.push(
      act(1, 11, 'Amit Shah', 'Rope', 'Rope incoming transaction TX-DEMO-101 · Ivory · PP-ROPE-IV · 6 mm · 250 m'),
      act(1, 16, 'Amit Shah', 'JOB-1048-ROP', 'Rope Work: 18 → 24 units · In progress'),
      act(2, 10, 'Neha Kapoor', 'Fabric', 'Fabric incoming transaction TX-DEMO-102 · SUNBRELLA · 40 m'),
      act(2, 15, 'Pooja Rao', 'UM-1046', 'Order details updated · cushion fabric confirmed'),
      act(3, 9, 'Rahul Mehta', 'Powder Color', 'Powder Color incoming transaction TX-DEMO-103 · Matte Black · 25 kg'),
      act(3, 14, 'Rahul Mehta', 'JOB-1047-IRN', 'Iron work job sheet updated · pipe section and finish'),
      act(4, 12, 'Karan Patel', 'UM-1044', 'Dispatch details entered · vehicle and driver'),
      act(5, 11, 'Amit Shah', 'Rope', 'Rope incoming transaction TX-DEMO-104 · Terracotta · PP-ROPE-TC · 8 mm · 180 m'),
      act(6, 10, 'Pooja Rao', 'Fabric', 'Fabric incoming transaction TX-DEMO-105 · D’Decor · 22 m'),
      act(7, 13, 'Neha Kapoor', 'UM-1045', 'Order created · Side table · Arlo'),
      act(8, 12, 'Karan Patel', 'Powder Color', 'Powder Color incoming transaction TX-DEMO-106 · Champagne Gold · 12 kg'),
      act(9, 17, 'Pooja Rao', 'JOB-1046-FAB', 'Fabric Work: 12 → 20 units · Completed')
    );
    db.activity.sort((a, b) => String(b.time).localeCompare(String(a.time)));
    [['UM-1046', 'Pooja Rao'], ['UM-1045', 'Neha Kapoor']].forEach(([id, who]) => { const o = db.orders.find(x => x.id === id); if (o) { o.createdBy = who; o.createdByDemo = true; } });
    db.staffDemoV2 = true;
    persist();
  }

  /* ---------- Inventory: only the requested details per category ---------- */
  const ropeOptions = key => [...new Set((ropeSheetData?.stock_master || []).map(r => String(r[key] || '').trim()).filter(Boolean))].sort();

  function categoryFields(material) {
    if (material === 'Rope') return `
      <div class="field"><label>Colour</label><input name="color" list="rope-colours" placeholder="e.g. Ivory" required></div>
      <div class="field"><label>SKU</label><input name="sku" list="rope-skus" placeholder="Rope SKU" required></div>
      <div class="field"><label>MM (rope size)</label><input name="mm" type="number" min="0.1" step="0.1" placeholder="e.g. 6" required></div>
      <div class="field"><label>Rope purchased (m)</label><input name="qty" type="number" min="0.1" step="0.1" placeholder="Metres purchased" required></div>
      <datalist id="rope-colours">${ropeOptions('Color').map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="rope-skus">${ropeOptions('Rope Type (SKU)').map(c => `<option value="${esc(c)}">`).join('')}</datalist>`;
    if (material === 'Fabric') return `
      <div class="field"><label>Company</label><select name="company" required>${FABRIC_COMPANIES.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label>Meters</label><input name="qty" type="number" min="0.1" step="0.1" placeholder="Fabric metres" required></div>`;
    return `
      <div class="field"><label>Colour name</label><input name="colorName" placeholder="Enter powder colour" required></div>
      <div class="field"><label>Weight (kg)</label><input name="qty" type="number" min="0.1" step="0.1" placeholder="Kilograms" required></div>`;
  }

  openTransaction = function (material) {
    const selected = CATEGORIES.includes(material) ? material : 'Rope';
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">INVENTORY · ${db.role === 'Staff' ? 'STAFF ENTRY' : 'ADMIN ENTRY'}</div><h2>Add inventory transaction</h2><p>Recorded under ${esc(currentActor())} with today's date.</p></div><button class="close-button" data-close>×</button></div>
      <form id="transaction-form"><div class="inv-category-tabs" role="tablist">${CATEGORIES.map(c => `<button type="button" role="tab" class="inv-tab ${c === selected ? 'active' : ''}" aria-selected="${c === selected}" data-inv-category="${c}">${c}</button>`).join('')}</div>
      <input type="hidden" name="material" value="${selected}"><div class="form-grid" id="inv-fields">${categoryFields(selected)}</div>
      <div class="inv-entered-by">Entered by <strong>${esc(currentActor())}</strong> · ${fmtDate(today(), { day: 'numeric', month: 'short', year: 'numeric' })}</div>
      <div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save transaction</button></div></form></section></div>`;
  };
  window.openTransaction = openTransaction;

  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-inv-category]');
    if (!tab) return;
    const form = tab.closest('form'), material = tab.dataset.invCategory;
    form.querySelector('[name="material"]').value = material;
    form.querySelectorAll('[data-inv-category]').forEach(b => { b.classList.toggle('active', b === tab); b.setAttribute('aria-selected', String(b === tab)); });
    form.querySelector('#inv-fields').innerHTML = categoryFields(material);
  });

  function addRopePurchase(d) {
    if (!ropeSheetData) return;
    const masters = ropeSheetData.stock_master || (ropeSheetData.stock_master = []);
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    let row = masters.find(r => same(r['Rope Type (SKU)'], d.sku) && same(r.mm, `${d.mm}mm`) && same(r.Color, d.color));
    if (!row) { row = { 'Rope Type (SKU)': d.sku, mm: `${d.mm}mm`, Color: d.color, 'Opening Stock (m)': '0', 'Total Purchased (m)': '0', 'Total Outward (m)': '0', 'Current Balance (m)': '0', '': '' }; masters.push(row); }
    const purchased = num(row['Total Purchased (m)']), outward = num(row['Total Outward (m)']);
    const current = row['Current Balance (m)'] === '' || row['Current Balance (m)'] == null ? num(row['Opening Stock (m)']) + purchased - outward : num(row['Current Balance (m)']);
    row['Total Purchased (m)'] = String(purchased + d.qty);
    row['Current Balance (m)'] = String(current + d.qty);
    (ropeSheetData.purchase_log ||= []).unshift({ Date: fmtDate(d.date, { day: '2-digit', month: 'short', year: 'numeric' }), 'Rope Type (SKU)': d.sku, mm: `${d.mm}mm`, Color: d.color, 'Qty Purchased (m)': String(d.qty), Supplier: '', 'Invoice/Bill No.': '', 'Rate (per m)': '', Remarks: `Entered by ${d.enteredBy}` });
    localStorage.setItem('umami-rope-inventory-v1', JSON.stringify(ropeSheetData));
  }

  submitTransaction = function (form) {
    const d = Object.fromEntries(new FormData(form)), material = d.material, qty = num(d.qty), actor = currentActor();
    if (!CATEGORIES.includes(material) || qty <= 0) return;
    const t = { id: `TX-${Date.now().toString().slice(-6)}`, material, type: 'Incoming', qty, unit: unitFor(material), color: '', sku: '', mm: '', company: '', colorName: '', order: '—', job: '—', staff: actor, enteredBy: actor, date: today(), notes: '' };
    let detail;
    if (material === 'Rope') { Object.assign(t, { color: d.color.trim(), sku: d.sku.trim(), mm: d.mm }); addRopePurchase({ ...t, enteredBy: actor }); detail = `${t.color} · ${t.sku} · ${t.mm} mm · ${qty} m`; }
    else if (material === 'Fabric') { t.company = d.company; detail = `${t.company} · ${qty} m`; }
    else { t.colorName = d.colorName.trim(); detail = `${t.colorName} · ${qty} kg`; }
    if (material !== 'Rope') db.inventory.find(i => i.name === material).incoming += qty;
    db.transactions.unshift(t);
    addActivity(actor, material, `${material} incoming transaction ${t.id} · ${detail}`);
    document.querySelector('#overlay-root').innerHTML = '';
    save();
    toast(`${material} transaction saved by ${actor}.`);
  };
  window.submitTransaction = submitTransaction;

  /* ---------- Staff entries report ---------- */
  let staffFilter = { person: 'All', kind: 'All' };
  const kindOf = a => /^JOB-/.test(a.entity) ? 'Job sheet' : /^UM-/.test(a.entity) ? 'Order' : CATEGORIES.includes(a.entity) ? 'Inventory' : 'Other';
  const staffEntries = () => db.activity.filter(a => a.actor && a.actor !== 'System');

  function staffReportHtml() {
    const entries = staffEntries();
    const people = [...new Set([...PEOPLE, 'Shubham Jain', ...entries.map(a => a.actor)])];
    const rows = entries.filter(a => (staffFilter.person === 'All' || a.actor === staffFilter.person) && (staffFilter.kind === 'All' || kindOf(a) === staffFilter.kind));
    const count = (p, k) => entries.filter(a => a.actor === p && kindOf(a) === k).length;
    const ordersCreated = p => db.orders.filter(o => o.createdBy === p).length;
    const hasDemo = entries.some(a => a.demo) || db.transactions.some(t => t.demo);
    return `<section class="panel staff-report"><div class="panel-header"><div><div class="eyebrow">STAFF REPORT</div><h2>Who entered what</h2><p>Every order, job sheet and inventory entry with the staff member who made it.</p></div><div class="staff-report-actions">${hasDemo && db.role !== 'Staff' ? '<button type="button" class="secondary-button" data-clear-demo>Remove demo entries</button>' : ''}<button type="button" class="secondary-button" data-staff-report-csv>↓ Download staff report</button></div></div>
      <div class="table-wrap"><table class="data-table staff-summary"><thead><tr><th>STAFF</th><th>ORDERS CREATED</th><th>ORDER UPDATES</th><th>JOB SHEET UPDATES</th><th>INVENTORY ENTRIES</th><th>TOTAL ENTRIES</th></tr></thead><tbody>${people.map(p => `<tr><td><strong>${esc(p)}</strong></td><td>${ordersCreated(p)}</td><td>${count(p, 'Order')}</td><td>${count(p, 'Job sheet')}</td><td>${count(p, 'Inventory')}</td><td><strong>${entries.filter(a => a.actor === p).length}</strong></td></tr>`).join('')}</tbody></table></div>
      <div class="toolbar staff-report-toolbar"><select id="staff-report-person"><option value="All">All staff</option>${people.map(p => `<option ${staffFilter.person === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><select id="staff-report-kind">${['All', 'Order', 'Job sheet', 'Inventory', 'Other'].map(k => `<option value="${k}" ${staffFilter.kind === k ? 'selected' : ''}>${k === 'All' ? 'All entry types' : k}</option>`).join('')}</select><span class="spacer"></span><span class="eyebrow">${rows.length} ENTRIES</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>WHEN</th><th>STAFF</th><th>TYPE</th><th>REFERENCE</th><th>WHAT THEY ENTERED</th></tr></thead><tbody>${rows.slice(0, 60).map(a => `<tr><td>${fmtTime(a.time)}</td><td>${esc(a.actor)}</td><td>${kindOf(a)}</td><td class="id-cell">${esc(a.entity)}</td><td>${esc(String(a.text).replace(/^DEMO · /, ''))}${a.demo || String(a.text).startsWith('DEMO · ') ? '<small class="demo-tag">DEMO</small>' : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-state">No entries for this filter.</td></tr>'}</tbody></table></div>
      ${rows.length > 60 ? `<p class="small-note">Showing the latest 60 of ${rows.length}. Download the staff report for all entries.</p>` : ''}</section>`;
  }

  const staffBase = renderStaff;
  renderStaff = function () { return staffBase() + staffReportHtml(); };

  document.addEventListener('change', e => {
    if (e.target.id === 'staff-report-person') { staffFilter.person = e.target.value; render(); }
    if (e.target.id === 'staff-report-kind') { staffFilter.kind = e.target.value; render(); }
  });

  /* ---------- Reports: monthly CSV report with a spreadsheet preview ---------- */
  function periodRange(period) {
    const now = new Date();
    const start = period === 'last' ? new Date(now.getFullYear(), now.getMonth() - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
    return { key: monthKey(start), label: start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) };
  }

  // One sheet, in sections, so it opens directly in Excel.
  function reportRows(period) {
    const { key, label } = periodRange(period);
    const inMonth = v => String(v || '').startsWith(key);
    const jobs = getJobs();
    const tx = db.transactions.filter(t => inMonth(t.date));
    const total = m => tx.filter(t => t.material === m).reduce((s, t) => s + num(t.qty), 0);
    const active = db.orders.filter(o => !['Completed', 'Dispatched'].includes(o.stage));
    const entries = staffEntries().filter(a => inMonth(a.time));
    const people = [...new Set(entries.map(a => a.actor))];
    const blank = [''];
    return [
      [`Umami Studio · Operations report · ${label}`],
      [`Generated ${fmtTime(new Date().toISOString())} by ${currentActor()}`],
      blank,
      ['SUMMARY', 'Value'],
      ['New orders this month', db.orders.filter(o => inMonth(o.orderDate)).length],
      ['Active orders', active.length],
      ['Overdue active orders', active.filter(isLate).length],
      ['Completed or dispatched orders', db.orders.length - active.length],
      ['Job sheets completed', `${jobs.filter(j => j.p.status === 'Completed').length} of ${jobs.length}`],
      ['Delayed job sheets', jobs.filter(j => j.p.status === 'Delayed').length],
      ['Rope added (m)', total('Rope')],
      ['Fabric added (m)', total('Fabric')],
      ['Powder Color added (kg)', total('Powder Color')],
      blank,
      ['ORDERS', 'Client', 'Product', 'Qty', 'Stage', 'Deadline', 'Progress', 'Created by'],
      ...db.orders.map(o => [o.id, o.client, o.product, o.qty, o.stage, o.deadline, `${progress(o)}%`, o.createdBy || '']),
      blank,
      ['INVENTORY TRANSACTIONS', 'Date', 'Category', 'Details', 'Quantity', 'Unit', 'Entered by'],
      ...(tx.length ? tx.map(t => [t.id, t.date, t.material, [t.color, t.sku, t.mm && `${t.mm} mm`, t.company, t.colorName].filter(Boolean).join(' · '), t.qty, t.unit || unitFor(t.material), t.enteredBy || t.staff || '']) : [['No inventory transactions this month']]),
      blank,
      ['STAFF ENTRIES', 'Orders', 'Job sheets', 'Inventory', 'Other', 'Total'],
      ...(people.length ? people.map(p => { const c = k => entries.filter(a => a.actor === p && kindOf(a) === k).length; return [p, c('Order'), c('Job sheet'), c('Inventory'), c('Other'), entries.filter(a => a.actor === p).length]; }) : [['No staff entries this month']])
    ];
  }

  const colName = i => String.fromCharCode(65 + i);
  function sheetPreview(rows) {
    const width = Math.max(...rows.map(r => r.length));
    const isHead = r => r.length > 1 && /^[A-Z ]+$/.test(String(r[0]));
    return `<div class="csv-sheet"><table><thead><tr><th class="rn"></th>${Array.from({ length: width }, (_, i) => `<th>${colName(i)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, i) => `<tr class="${i === 0 ? 'title' : isHead(r) ? 'head' : ''}"><td class="rn">${i + 1}</td>${Array.from({ length: width }, (_, k) => `<td>${esc(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  const reportFile = period => `umami-report-${periodRange(period).key}.csv`;
  async function downloadReport(period, reason) {
    const ok = await saveFile(reportFile(period), csvBlob(reportRows(period)));
    if (!ok) return;
    db.reportLog = [{ period: periodRange(period).label, by: currentActor(), at: new Date().toISOString(), reason }, ...(db.reportLog || [])].slice(0, 20);
    if (period === 'last') db.monthlyReportSent = periodRange('last').key;
    addActivity(currentActor(), 'Reports', `${periodRange(period).label} report downloaded (CSV)`);
    persist();
    document.querySelector('.report-due-modal')?.remove();
    render();
    toast('Report downloaded. It opens in Excel.');
  }
  async function shareReport(period) {
    const file = new File([csvBlob(reportRows(period))], reportFile(period), { type: 'text/csv' });
    try { await navigator.share({ files: [file], title: `Umami report · ${periodRange(period).label}` }); addActivity(currentActor(), 'Reports', `${periodRange(period).label} report shared (CSV)`); persist(); }
    catch (err) { if (err?.name !== 'AbortError') toast('Sharing is not available here. Download the CSV instead.'); }
  }
  const canShareFiles = () => { try { return !!navigator.canShare?.({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] }); } catch (e) { return false; } };

  let reportPeriod = 'current';
  function reportPanel() {
    const s = db.monthlyReport || { enabled: false, day: 1 };
    const last = (db.reportLog || [])[0];
    return `<section class="panel csv-report-panel"><div class="panel-header"><div><div class="eyebrow">MONTHLY REPORT</div><h2>Report (CSV)</h2><p>Preview the report as a spreadsheet, then download it to open in Excel.</p></div>
      <div class="csv-report-actions"><select id="report-period"><option value="current" ${reportPeriod === 'current' ? 'selected' : ''}>This month (${periodRange('current').label})</option><option value="last" ${reportPeriod === 'last' ? 'selected' : ''}>Last month (${periodRange('last').label})</option></select>${canShareFiles() ? '<button type="button" class="secondary-button" data-report-share>Share CSV</button>' : ''}<button type="button" class="primary-button" data-report-download>↓ Download CSV</button></div></div>
      ${monthlyDue() ? `<div class="report-due"><strong>The ${periodRange('last').label} monthly report is due.</strong><button type="button" class="primary-button" data-report-download data-report-period="last" data-report-reason="scheduled">Download it now</button></div>` : ''}
      ${sheetPreview(reportRows(reportPeriod))}
      <form id="report-schedule-form" class="report-schedule"><label class="checkbox-line"><input name="enabled" type="checkbox" ${s.enabled ? 'checked' : ''}> Remind admins to download last month's report every month</label><label class="field inline"><span>On the</span><select name="day">${Array.from({ length: 28 }, (_, i) => i + 1).map(d => `<option value="${d}" ${Number(s.day) === d ? 'selected' : ''}>${d}${d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'} of the month</option>`).join('')}</select></label><button class="secondary-button">Save</button></form>
      <p class="small-note">${last ? `Last downloaded: ${esc(last.period)} report by ${esc(last.by)}, ${fmtTime(last.at)}.` : 'No report downloaded yet.'}</p></section>`;
  }

  const reportsBase = renderReports;
  renderReports = function () {
    return reportsBase().replace(/<section class="panel whatsapp-report-panel">[\s\S]*?<\/section>/, '') + reportPanel();
  };

  function monthlyDue() {
    const s = db.monthlyReport;
    if (!s?.enabled || db.role === 'Staff') return false;
    if (new Date().getDate() < Number(s.day || 1)) return false;
    return db.monthlyReportSent !== periodRange('last').key;
  }

  document.addEventListener('change', e => {
    if (e.target.id === 'report-period') { reportPeriod = e.target.value; render(); }
  });

  document.addEventListener('click', e => {
    const dl = e.target.closest('[data-report-download]');
    if (dl) { downloadReport(dl.dataset.reportPeriod || reportPeriod, dl.dataset.reportReason || 'manual'); return; }
    if (e.target.closest('[data-report-share]')) { shareReport(reportPeriod); return; }
    if (e.target.closest('[data-report-later]')) { document.querySelector('.report-due-modal')?.remove(); return; }
    if (e.target.closest('[data-staff-report-csv]')) {
      const rows = [['Date & time', 'Staff', 'Type', 'Reference', 'Entry', 'Sample data'], ...staffEntries().map(a => [fmtTime(a.time), a.actor, kindOf(a), a.entity, String(a.text).replace(/^DEMO · /, ''), a.demo || String(a.text).startsWith('DEMO · ') ? 'Yes' : ''])];
      saveFile(`umami-staff-report-${today()}.csv`, csvBlob(rows)).then(ok => ok && toast('Staff report downloaded.'));
      return;
    }
    if (e.target.closest('[data-clear-demo]')) {
      if (!confirm('Remove all sample (DEMO) entries from the staff report and inventory?')) return;
      db.transactions.filter(t => t.demo && t.material !== 'Rope').forEach(t => { const inv = db.inventory.find(i => i.name === t.material); if (inv) inv.incoming = Math.max(0, inv.incoming - num(t.qty)); });
      db.transactions = db.transactions.filter(t => !t.demo);
      db.activity = db.activity.filter(a => !a.demo && !String(a.text).startsWith('DEMO · '));
      db.orders.forEach(o => { if (o.createdByDemo) { o.createdBy = 'Shubham Jain'; delete o.createdByDemo; } });
      save();
      toast('Demo entries removed.');
    }
  });

  document.addEventListener('submit', e => {
    if (e.target.id !== 'report-schedule-form') return;
    e.preventDefault();
    const f = new FormData(e.target);
    db.monthlyReport = { enabled: f.has('enabled'), day: Number(f.get('day')) || 1, updatedBy: currentActor(), updatedAt: new Date().toISOString() };
    addActivity(currentActor(), 'Reports', `Monthly report reminder ${db.monthlyReport.enabled ? `set for day ${db.monthlyReport.day}` : 'turned off'}`);
    save();
    toast(db.monthlyReport.enabled ? `Monthly report reminder set for day ${db.monthlyReport.day}.` : 'Monthly report reminder turned off.');
  });

  // Download the order report through the viewer's download prompt where needed.
  exportCSV = function () {
    const rows = [['Order ID', 'Client', 'Product', 'Quantity', 'Stage', 'Deadline', 'Progress', 'Created by', 'Last updated by'],
      ...db.orders.map(o => [o.id, o.client, o.product, o.qty, o.stage, o.deadline, `${progress(o)}%`, o.createdBy || 'Unknown', o.updatedBy || '—'])];
    saveFile(`umami-order-report-${today()}.csv`, csvBlob(rows)).then(ok => ok && toast('Order report downloaded.'));
  };
  window.exportCSV = exportCSV;

  // Monthly reminder: when last month's report is due, ask the admin once per visit.
  function showDueModal() {
    if (!monthlyDue() || document.querySelector('.report-due-modal') || document.querySelector('#overlay-root .modal-backdrop')) return;
    const m = document.createElement('div');
    m.className = 'modal-backdrop center report-due-modal';
    m.innerHTML = `<section class="modal-card wide-card"><div class="modal-heading"><div><div class="eyebrow">MONTHLY REPORT DUE</div><h2>${periodRange('last').label} report</h2><p>Download the CSV to open it in Excel.</p></div></div>${sheetPreview(reportRows('last'))}<div class="form-actions"><button type="button" class="secondary-button" data-report-later>Remind me later</button><button type="button" class="primary-button" data-report-download data-report-period="last" data-report-reason="scheduled">↓ Download CSV</button></div></section>`;
    document.body.appendChild(m);
  }

  render();
  setTimeout(showDueModal, 800);
})();
