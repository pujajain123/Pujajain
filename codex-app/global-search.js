/* Header search: instant results across everything on the dashboard, as you type.
   Orders (ID, client, contact, products, SKUs, colours, rope and fabric codes, stage, notes, address, dispatch),
   job sheets, stock items (each rope, fabric and powder colour), inventory entries, staff, activity and pages.
   Results respect the signed-in role: staff only find the orders and job sheets they can open.
   Keyboard: Ctrl/⌘ K or / to focus, ↑ ↓ to move, Enter to open, Esc to close. */
(() => {
  const input = () => document.querySelector('#global-search');
  const norm = s => String(s ?? '').toLowerCase();
  const fmt = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const isStaff = () => db.role === 'Staff';
  const me = () => window.staffMember || '';
  const PAGES = { dashboard: 'Dashboard', orders: 'Orders', production: 'Master production', jobs: 'Job sheets', inventory: 'Inventory', dispatch: 'Dispatch', reports: 'Reports', staff: 'Staff', activity: 'Activity log', settings: 'Settings', guide: 'Operations guide' };
  const LIMITS = { Orders: 6, 'Job sheets': 5, 'Stock items': 6, 'Inventory entries': 4, Staff: 4, Activity: 3, Pages: 3 };
  let results = [], active = 0, lastQuery = '';

  const visibleOrders = () => isStaff() && me()
    ? db.orders.filter(o => o.createdBy === me() || o.processes?.some(p => p.assigned === me()))
    : db.orders;
  const pageVisible = key => { const a = document.querySelector(`.nav-link[data-page="${key}"]`); return a && a.style.display !== 'none'; };

  // Every word typed must appear somewhere in the item; items whose title starts with the query rank first.
  function match(words, haystack, title) {
    const h = norm(haystack);
    if (!words.every(w => h.includes(w))) return 0;
    const t = norm(title), q = words.join(' ');
    return t === q ? 100 : t.startsWith(q) ? 60 : t.includes(q) ? 40 : 20;
  }
  const orderText = o => [o.id, o.client, o.contact, o.product, o.stage, o.priority, o.source, o.notes, o.address, o.createdBy,
    o.dispatch && [o.dispatch.carrier, o.dispatch.tracking, o.dispatch.address],
    ...(o.items || []).flatMap(it => [it.sku, it.name, it.material, it.powderColor, it.doriColour, it.ropeCode, it.dimensions, it.tableTop,
      ...(window.UmamiFabric ? UmamiFabric.partsOf(it).flatMap(p => [p.code, p.company, (p.qty || p.code) && `${p.label} fabric`]) : [it.fabricCode, it.fabricCompany])]),
    ...(o.processes || []).map(p => p.assigned)].flat().filter(Boolean).join(' ');
  function orderSub(o, words) {
    // Say which product matched when the hit is inside a product line.
    const it = (o.items || []).find(x => words.some(w => norm([x.sku, x.name, x.powderColor, x.doriColour, x.ropeCode, ...(window.UmamiFabric ? UmamiFabric.partsOf(x).flatMap(p => [p.code, p.company]) : [])].join(' ')).includes(w)));
    return [`Order · ${o.stage}`, it ? `${it.sku || it.name}` : o.product, `due ${fmtDate(o.deadline)}`].filter(Boolean).join(' · ');
  }

  function search(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const out = [];
    const add = (group, score, item) => { if (score) out.push({ group, score, ...item }); };
    const orders = visibleOrders(), orderIds = new Set(orders.map(o => o.id));
    for (const o of orders) add('Orders', match(words, orderText(o), o.id) + match(words, o.client, o.client) / 4, { title: `${o.id} · ${o.client}`, sub: orderSub(o, words), act: { kind: 'order', id: o.id } });
    for (const j of getJobs().filter(j => orderIds.has(j.o.id))) add('Job sheets', match(words, [j.id, j.p.name, j.p.assigned, j.p.status, j.o.id, j.o.client, j.p.detail].join(' '), j.id), { title: `${j.id} · ${j.p.name}`, sub: `Job sheet · ${j.p.assigned || 'Unassigned'} · ${j.p.status} · ${j.o.client}`, act: { kind: 'job', id: j.id } });
    if (window.umamiStockRecords) {
      for (const [kind, label] of [['Rope', 'Rope'], ['Fabric', 'Fabric'], ['Powder Color', 'Powder colour']]) {
        const unit = kind === 'Powder Color' ? 'kg' : 'm';
        for (const r of umamiStockRecords(kind)) add('Stock items', match(words, [label, r.title, r.sub, r.sku, r.mm && `${r.mm}mm ${r.mm} mm`, r.color, r.company, r.code, r.colorName].join(' '), r.title), { title: `${r.title} · ${fmt(r.onHand)} ${unit}`, sub: `${label} · ${r.sub}`, act: { kind: 'stock', material: kind, key: r.key } });
      }
    }
    for (const m of db.inventory) {
      const label = m.name === 'Powder Color' ? 'Powder colour' : m.name;
      add('Stock items', match(words, `${m.name} ${label} inventory stock material`, label) / 2, { title: `${label} · ${fmt(typeof materialStock === 'function' ? materialStock(m.name) : 0)} ${m.unit} on hand`, sub: 'Inventory total', act: { kind: 'page', page: 'inventory' } });
    }
    for (const t of db.transactions.filter(t => !t.replacedBy)) {
      if (isStaff() && t.order && t.order !== '—' && !orderIds.has(t.order) && t.enteredBy !== me()) continue;
      const details = [t.sku, t.mm && `${t.mm} mm`, t.color, t.company, t.code, t.colorName].filter(Boolean).join(' · ');
      add('Inventory entries', match(words, [t.id, t.material, t.type, details, t.order, t.job, t.enteredBy, t.staff, t.notes].join(' '), t.id), { title: `${t.id} · ${t.material} ${t.type === 'Outward' ? '−' : '+'}${fmt(Math.abs(t.qty))} ${t.unit || ''}`, sub: [details, t.order !== '—' && t.order, t.enteredBy, fmtDate(t.date)].filter(Boolean).join(' · '), act: { kind: 'tx', id: t.id } });
    }
    if (!isStaff()) {
      for (const p of PEOPLE) add('Staff', match(words, `${p} staff team`, p), { title: p, sub: `Staff · ${getJobs().filter(j => j.p.assigned === p && j.p.status !== 'Completed').length} open jobs`, act: { kind: 'page', page: 'staff' } });
      for (const a of db.activity.slice(0, 400)) add('Activity', match(words, [a.actor, a.entity, a.text].join(' '), a.entity) / 3, { title: a.text, sub: `${a.actor} · ${a.entity} · ${new Date(a.time).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, act: /^UM-\d+$/.test(a.entity) ? { kind: 'order', id: a.entity } : { kind: 'page', page: 'activity' } });
    }
    for (const [key, label] of Object.entries(PAGES)) if (pageVisible(key)) add('Pages', match(words, `${label} ${key} page`, label), { title: label, sub: 'Go to page', act: { kind: 'page', page: key } });

    const groups = Object.keys(LIMITS);
    return groups.flatMap(g => out.filter(r => r.group === g).sort((a, b) => b.score - a.score).slice(0, LIMITS[g]));
  }

  /* ---------- Dropdown ---------- */
  const mark = (text, words) => {
    let html = esc(text);
    for (const w of [...words].sort((a, b) => b.length - a.length)) {
      const safe = esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (safe) html = html.replace(new RegExp(`(${safe})(?![^<]*>)`, 'gi'), '<mark>$1</mark>');
    }
    return html;
  };
  function place(box) {
    const anchor = input()?.closest('.searchbox');
    if (!anchor) return;
    const r = anchor.getBoundingClientRect(), width = Math.min(440, window.innerWidth - 20);
    box.style.top = `${Math.round(r.bottom + 6)}px`;
    box.style.left = `${Math.round(Math.max(10, Math.min(r.left, window.innerWidth - width - 10)))}px`;
    box.style.right = 'auto';
    box.style.width = `${width}px`;
  }
  function close() { document.querySelector('.search-results')?.remove(); results = []; input()?.setAttribute('aria-expanded', 'false'); }
  function show(q) {
    lastQuery = q;
    document.querySelector('.search-results')?.remove();
    if (!String(q).trim()) { results = []; return; }
    results = search(q);
    active = 0;
    const words = norm(q).split(/\s+/).filter(Boolean);
    let html = '', group = '';
    results.forEach((r, i) => {
      if (r.group !== group) { group = r.group; html += `<div class="gs-group">${esc(group)}</div>`; }
      html += `<div class="search-result gs-item${i === active ? ' active' : ''}" role="option" id="gs-${i}" data-gs-index="${i}" aria-selected="${i === active}"><strong>${mark(r.title, words)}</strong><small>${mark(r.sub, words)}</small></div>`;
    });
    const box = document.createElement('div');
    box.className = 'search-results global-search-results';
    box.setAttribute('role', 'listbox');
    box.innerHTML = html || `<div class="empty-state">No results for “${esc(q)}”.<small>Try an order ID, client, SKU, fabric code, rope colour or staff name.</small></div>`;
    document.body.appendChild(box);
    place(box);
    input()?.setAttribute('aria-expanded', 'true');
  }
  showSearch = show;
  window.showSearch = show;

  function setActive(i) {
    if (!results.length) return;
    active = (i + results.length) % results.length;
    document.querySelectorAll('.gs-item').forEach(el => { const on = Number(el.dataset.gsIndex) === active; el.classList.toggle('active', on); el.setAttribute('aria-selected', String(on)); if (on) el.scrollIntoView({ block: 'nearest' }); });
  }
  function go(r) {
    if (!r) return;
    const box = input();
    if (box) { box.value = ''; box.blur(); }
    close();
    const a = r.act;
    if (a.kind === 'order') openOrder(a.id);
    else if (a.kind === 'job') openJob(a.id);
    else if (a.kind === 'stock') window.umamiShowStockItem?.(a.material, a.key);
    else if (a.kind === 'tx') {
      document.querySelector('#overlay-root').innerHTML = '';
      page = 'inventory'; location.hash = '#inventory'; render();
      setTimeout(() => {
        const row = [...document.querySelectorAll('.inventory-ledger tbody tr')].find(tr => tr.querySelector('.id-cell')?.textContent.trim().startsWith(a.id));
        if (row) { row.classList.add('flash-row'); row.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => row.classList.remove('flash-row'), 2500); }
      }, 80);
    } else if (a.kind === 'page') {
      document.querySelector('#overlay-root').innerHTML = '';
      page = a.page; location.hash = `#${a.page}`; render();
    }
  }

  // Our own handlers run first and stop the older search handlers from also acting on the click.
  document.addEventListener('click', e => {
    const item = e.target.closest('.gs-item');
    if (item) { e.preventDefault(); e.stopPropagation(); go(results[Number(item.dataset.gsIndex)]); return; }
    if (!e.target.closest('.search-results') && !e.target.closest('.searchbox')) close();
  }, true);
  document.addEventListener('keydown', e => {
    const box = input();
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable)) {
      if (!box) return;
      e.preventDefault(); box.focus(); box.select();
      if (box.value) show(box.value);
      return;
    }
    if (e.target !== box) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!document.querySelector('.search-results')) show(box.value); else go(results[active]); }
    else if (e.key === 'Escape') { close(); box.blur(); }
  });
  document.addEventListener('focusin', e => { if (e.target === input() && e.target.value.trim() && !document.querySelector('.search-results')) show(e.target.value); });
  window.addEventListener('resize', () => { const box = document.querySelector('.global-search-results'); if (box) place(box); });

  const box = input();
  if (box) {
    box.setAttribute('role', 'combobox');
    box.setAttribute('aria-autocomplete', 'list');
    box.setAttribute('aria-expanded', 'false');
    box.placeholder = 'Search orders, SKUs, fabric, stock, staff…';
    const kbd = box.parentElement?.querySelector('kbd');
    if (kbd && !/Mac|iPhone|iPad/.test(navigator.platform || '')) kbd.textContent = 'Ctrl K';
  }
})();
