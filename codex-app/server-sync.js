/* Server mode: saves every change to the server, applies the signed-in user's role, and adds account management.
   Loaded after the dashboard scripts. The dashboard keeps working on its in-memory `db`; this layer sends each
   change (orders, inventory entries, activity, settings, tracker) to the API, which enforces who may do what. */
(() => {
  const me = window.UMAMI_ME;
  const isAdmin = me.role === 'admin';
  const KEYS = { ops: 'umami-ops-v1', tracker: 'umami-production-tracker-v1', rope: 'umami-rope-inventory-v1' };
  const STAFF_PAGES = ['dashboard', 'orders', 'jobs', 'inventory', 'guide'];
  const RESERVED = new Set(['orders', 'inventory', 'transactions', 'activity', 'role']);
  const rawSetItem = Storage.prototype.setItem;
  let revision = window.UMAMI_SERVER.revision;

  async function request(method, url, body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.replace('/login'); throw new Error('Signed out'); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'The server could not save this change.'), { status: res.status, code: data.code });
    return data;
  }

  /* ---------- Identity and role ---------- */
  currentActor = () => me.name;
  window.staffMember = me.name;
  PEOPLE.splice(0, PEOPLE.length, ...window.UMAMI_SERVER.people);
  const initials = me.name.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();

  const menu = document.querySelector('#role-menu');
  if (menu) menu.innerHTML = `<div class="role-menu-heading">${esc(me.email)}</div><button type="button" data-account-password><span class="role-menu-icon">⚿</span><span><strong>Change password</strong><small>Set a new password</small></span></button><button type="button" data-account-logout><span class="role-menu-icon staff">↪</span><span><strong>Sign out</strong><small>End this session</small></span></button>`;

  const baseRender = render;
  render = function () {
    if (!isAdmin && !STAFF_PAGES.includes(page)) { page = 'dashboard'; history.replaceState(null, '', '#dashboard'); }
    baseRender();
    const profile = document.querySelector('.user-profile');
    if (profile) {
      profile.querySelector('strong').textContent = me.name;
      profile.querySelector('.avatar').textContent = initials;
      const label = profile.querySelector('#role-label'); if (label) label.textContent = isAdmin ? 'Administrator' : 'Staff';
      const more = profile.querySelector('.profile-more'); if (more) more.textContent = 'Account⌄';
    }
    if (!isAdmin) {
      document.querySelectorAll('.nav-link').forEach(a => { if (!STAFF_PAGES.includes(a.dataset.page)) a.style.display = 'none'; });
      document.querySelectorAll('.nav-group').forEach(g => { g.style.display = [...g.querySelectorAll('.nav-link')].some(a => a.style.display !== 'none') ? '' : 'none'; });
      const picker = document.querySelector('#staff-person');
      if (picker) (picker.closest('.app-select') || picker).style.display = 'none';
      if (page === 'dashboard') { const crumb = document.querySelector('#breadcrumb'); if (crumb) crumb.textContent = 'My work'; }
    }
  };
  window.render = render;

  /* ---------- Change detection and saving ---------- */
  const actKey = a => `${a.time}|${a.actor}|${a.entity}|${a.text}`;
  const settingsOf = d => Object.fromEntries(Object.entries(d).filter(([k]) => !RESERVED.has(k)));
  const snapshot = () => ({
    orders: new Map(db.orders.map(o => [o.id, JSON.stringify(o)])),
    tx: new Set(db.transactions.map(t => t.id)),
    act: new Set(db.activity.map(actKey)),
    settings: JSON.stringify(settingsOf(db)),
    tracker: JSON.stringify(trackerRows),
  });
  let base = snapshot(), timer = null, running = false, again = false, failures = 0;

  const replaceInPlace = (target, source) => { Object.keys(target).forEach(k => delete target[k]); Object.assign(target, source); };
  function writeCache() {
    rawSetItem.call(localStorage, KEYS.ops, JSON.stringify(db));
    rawSetItem.call(localStorage, KEYS.tracker, JSON.stringify(trackerRows));
    if (ropeSheetData) rawSetItem.call(localStorage, KEYS.rope, JSON.stringify(ropeSheetData));
  }

  async function syncNow() {
    if (running) { again = true; return; }
    running = true;
    try {
      for (const o of db.orders) {
        const json = JSON.stringify(o), before = base.orders.get(o.id);
        if (before === json) continue;
        if (before === undefined) {
          if (!isAdmin) continue;
          const { order } = await request('POST', '/api/orders', { order: o });
          replaceInPlace(o, order);
        } else {
          const { order } = await request('PUT', `/api/orders/${encodeURIComponent(o.id)}`, { order: o, baseVersion: o._version });
          replaceInPlace(o, order);
        }
        base.orders.set(o.id, JSON.stringify(o));
      }
      for (const t of [...db.transactions].reverse()) {
        if (base.tx.has(t.id)) continue;
        const res = await request('POST', '/api/transactions', { transaction: t });
        replaceInPlace(t, res.transaction);
        db.inventory.splice(0, db.inventory.length, ...res.inventory);
        if (res.rope) ropeSheetData = res.rope;
        base.tx.add(t.id);
      }
      const newActs = db.activity.filter(a => !base.act.has(actKey(a)));
      if (newActs.length) {
        for (let i = 0; i < newActs.length; i += 50) await request('POST', '/api/activity', { entries: newActs.slice(i, i + 50).reverse() });
        newActs.forEach(a => base.act.add(actKey(a)));
      }
      const settings = JSON.stringify(settingsOf(db));
      if (settings !== base.settings && isAdmin) { await request('PUT', '/api/settings', { settings: settingsOf(db) }); }
      base.settings = settings;
      const tracker = JSON.stringify(trackerRows);
      if (tracker !== base.tracker && isAdmin) await request('PUT', '/api/tracker', { rows: trackerRows });
      base.tracker = tracker;
      writeCache();
      failures = 0;
      revision = (await request('GET', '/api/revision')).revision;
    } catch (err) {
      if (err.status === 409 || err.status === 403 || err.status === 404 || err.status === 400) {
        toast(err.message);
        await reloadState();
      } else if (err.message !== 'Signed out') {
        failures++;
        toast(failures > 1 ? 'Still not saved: no connection to the server. Retrying…' : 'Not saved yet: no connection to the server. Retrying…');
        setTimeout(schedule, Math.min(30000, 3000 * failures));
      }
    } finally {
      running = false;
      if (again) { again = false; schedule(); }
    }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(syncNow, 350); }

  // Every dashboard write goes through browser storage; use that as the signal to save to the server.
  Storage.prototype.setItem = function (key, value) {
    rawSetItem.call(this, key, value);
    if (this === localStorage && (key === KEYS.ops || key === KEYS.tracker)) schedule();
  };

  async function reloadState() {
    const state = await request('GET', '/api/state');
    db = state.db;
    trackerRows = state.tracker;
    if (state.rope) ropeSheetData = state.rope;
    PEOPLE.splice(0, PEOPLE.length, ...state.people);
    revision = state.revision;
    writeCache();
    base = snapshot();
    render();
  }
  window.umamiReload = reloadState;

  // Pick up other people's changes when nothing is being edited here.
  async function checkForUpdates() {
    if (running) return;
    try {
      const r = (await request('GET', '/api/revision')).revision;
      const busy = document.querySelector('#overlay-root')?.children.length || document.querySelector('.report-due-modal') || document.activeElement?.matches?.('input, textarea, select');
      if (r !== revision && !busy && !running) await reloadState();
    } catch (e) { /* offline: try again on the next tick */ }
  }
  setInterval(checkForUpdates, 15000);
  window.addEventListener('focus', checkForUpdates);

  /* ---------- Demo entries are removed on the server ---------- */
  document.addEventListener('click', async e => {
    if (!e.target.closest('[data-clear-demo]')) return;
    e.stopImmediatePropagation();
    if (!confirm('Remove all sample (DEMO) entries from the staff report and inventory?')) return;
    try { await request('POST', '/api/demo/clear', {}); await reloadState(); toast('Demo entries removed.'); } catch (err) { toast(err.message); }
  }, true);

  /* ---------- Account menu ---------- */
  document.addEventListener('click', async e => {
    if (e.target.closest('[data-account-logout]')) {
      await request('POST', '/api/auth/logout', {}).catch(() => {});
      Object.values(KEYS).forEach(k => localStorage.removeItem(k));
      location.replace('/login');
    }
    if (e.target.closest('[data-account-password]')) { document.querySelector('#role-menu').hidden = true; openChangePassword(); }
  });

  function openChangePassword() {
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">YOUR ACCOUNT</div><h2>Change password</h2><p>${esc(me.email)}</p></div><button class="close-button" data-close>×</button></div>
      <form id="account-password-form"><div class="form-grid"><div class="field full"><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div><div class="field"><label>New password</label><input name="password" type="password" minlength="8" autocomplete="new-password" required></div><div class="field"><label>Confirm new password</label><input name="confirm" type="password" minlength="8" autocomplete="new-password" required></div></div>
      <p class="small-note">At least 8 characters, with a letter and a number. Other devices you are signed in on will be signed out.</p><div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save password</button></div></form></section></div>`;
  }

  /* ---------- Staff accounts (admin) ---------- */
  let users = null, loadingUsers = false;
  async function loadUsers() {
    if (!isAdmin || loadingUsers) return;
    loadingUsers = true;
    try { users = (await request('GET', '/api/admin/users')).users; if (page === 'staff') render(); }
    catch (err) { toast(err.message); }
    finally { loadingUsers = false; }
  }
  const statusChip = s => `<span class="account-status ${s}">${s === 'active' ? 'Active' : s === 'invited' ? 'Invite sent' : 'Disabled'}</span>`;

  function accountsPanel() {
    if (!users) { loadUsers(); return '<section class="panel team-accounts"><div class="panel-header"><div><div class="eyebrow">TEAM ACCOUNTS</div><h2>Logins and access</h2></div></div><div class="empty-state">Loading accounts…</div></section>'; }
    return `<section class="panel team-accounts"><div class="panel-header"><div><div class="eyebrow">TEAM ACCOUNTS</div><h2>Logins and access</h2><p>Each person has their own login. Accounts are never deleted; disable them instead.</p></div><button type="button" class="primary-button" data-action="add-staff">＋ Add staff</button></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>NAME</th><th>LOGIN</th><th>ROLE</th><th>STATUS</th><th>LAST SIGN-IN</th><th></th></tr></thead><tbody>${users.map(u => `<tr><td><strong>${esc(u.name)}</strong>${u.id === me.id ? ' <small class="demo-tag" style="color:var(--muted)">YOU</small>' : ''}</td><td>${esc(u.email)}${u.hasEmail ? '' : '<small style="display:block;color:#9ca49f">Generated login ID</small>'}</td><td>${u.role === 'admin' ? 'Admin' : 'Staff'}</td><td>${statusChip(u.status)}${u.mustChangePassword && u.status === 'active' ? '<small style="display:block;color:#9ca49f">Must change password</small>' : ''}</td><td>${u.lastLoginAt ? fmtTime(u.lastLoginAt) : '—'}</td>
        <td class="account-actions">${u.status !== 'disabled' ? `<button type="button" class="compact-button" data-account-reset="${u.id}">${u.status === 'invited' ? 'New invite link' : 'Reset password'}</button>` : ''}${u.id === me.id ? '' : u.status === 'disabled' ? `<button type="button" class="compact-button" data-account-enable="${u.id}">Enable</button>` : `<button type="button" class="compact-button" data-account-disable="${u.id}">Disable</button>`}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  const staffBase = renderStaff;
  renderStaff = function () {
    const html = staffBase().replace(/<button[^>]*data-action="add-staff"[^>]*>[\s\S]*?<\/button>/, '');
    return isAdmin ? html.replace('<div class="report-grid">', `${accountsPanel()}<div class="report-grid">`) : html;
  };

  openStaffForm = function () {
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">STAFF</div><h2>Add staff</h2><p>Give a new team member their own login.</p></div><button class="close-button" data-close>×</button></div>
      <form id="add-staff-form"><div class="form-grid"><div class="field full"><label>Name <span style="color:var(--red)">*</span></label><input name="name" required maxlength="80" placeholder="e.g. Neha Kapoor"></div>
      <div class="field full"><label>Email (optional)</label><input name="email" type="email" placeholder="Their real email address"></div></div>
      <div class="info-banner">With an email, they get a link to set their own password. Without one, a login ID like <b>name@umami.app</b> and a temporary password are created for you to share.<br>Their name must match the name used when assigning jobs.</div>
      <div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Create login</button></div></form></section></div>`;
  };
  window.openStaffForm = openStaffForm;

  const copyRow = (label, value, secret) => `<div class="credential-row"><small>${label}</small><div><code>${esc(value)}</code><button type="button" class="compact-button" data-copy="${esc(value)}">Copy</button></div>${secret ? '<em>Shown only once. Copy it now.</em>' : ''}</div>`;
  function showCredentials(title, r) {
    const parts = [];
    if (r.password) {
      parts.push(copyRow('Login ID', r.loginId), copyRow('Temporary password', r.password, true), copyRow('Login link', r.loginLink));
      parts.push('<p class="small-note">They must choose their own password the first time they sign in.</p>');
    } else {
      const link = r.inviteLink || r.resetLink;
      parts.push(copyRow('Email', r.user.email), copyRow('Set-password link (single use, 48 hours)', link));
      parts.push(`<p class="small-note">${r.emailSent ? `The link was also emailed to ${esc(r.user.email)}.` : `The email could not be sent (${esc(r.emailError || 'email not set up')}). Share the link yourself.`}</p>`);
    }
    document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">LOGIN DETAILS</div><h2>${esc(title)}</h2><p>${esc(r.user.name)}</p></div><button class="close-button" data-close>×</button></div>${parts.join('')}<div class="form-actions"><button type="button" class="primary-button" data-close>Done</button></div></section></div>`;
  }

  document.addEventListener('submit', async e => {
    const f = e.target;
    if (f.id === 'add-staff-form') {
      e.preventDefault(); e.stopImmediatePropagation();
      const d = Object.fromEntries(new FormData(f)), btn = f.querySelector('.primary-button');
      btn.disabled = true;
      try {
        const r = await request('POST', '/api/admin/users', { name: d.name, email: d.email || undefined });
        users = null; await loadUsers();
        PEOPLE.includes(r.user.name) || PEOPLE.push(r.user.name);
        showCredentials('Staff login created', r);
      } catch (err) { toast(err.message); btn.disabled = false; }
    }
    if (f.id === 'account-password-form') {
      e.preventDefault(); e.stopImmediatePropagation();
      const d = Object.fromEntries(new FormData(f));
      if (d.password !== d.confirm) { toast('The two new passwords do not match.'); return; }
      try { await request('POST', '/api/auth/change-password', { current: d.current, password: d.password }); document.querySelector('#overlay-root').innerHTML = ''; toast('Password changed.'); }
      catch (err) { toast(err.message); }
    }
  }, true);

  document.addEventListener('click', async e => {
    const copy = e.target.closest('[data-copy]');
    if (copy) {
      try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = 'Copied'; setTimeout(() => (copy.textContent = 'Copy'), 1500); }
      catch (err) { const code = copy.previousElementSibling; const range = document.createRange(); range.selectNodeContents(code); getSelection().removeAllRanges(); getSelection().addRange(range); toast('Press Ctrl+C / ⌘C to copy.'); }
      return;
    }
    const reset = e.target.closest('[data-account-reset]'), dis = e.target.closest('[data-account-disable]'), en = e.target.closest('[data-account-enable]');
    if (!reset && !dis && !en) return;
    const id = (reset || dis || en).dataset[reset ? 'accountReset' : dis ? 'accountDisable' : 'accountEnable'];
    const u = users?.find(x => String(x.id) === id);
    try {
      if (reset) {
        if (!confirm(u?.status === 'invited' ? `Create a new invite link for ${u.name}? The old link stops working.` : `Reset the password for ${u?.name}? They will be signed out everywhere.`)) return;
        const r = await request('POST', `/api/admin/users/${id}/reset-password`, {});
        showCredentials(r.password ? 'Password reset' : u?.status === 'invited' ? 'New invite link' : 'Password reset link', r);
      } else if (dis) {
        if (!confirm(`Disable ${u?.name}? They will be signed out and cannot sign in until enabled again. Their records stay.`)) return;
        await request('POST', `/api/admin/users/${id}/disable`, {});
        toast(`${u?.name} disabled.`);
      } else {
        await request('POST', `/api/admin/users/${id}/enable`, {});
        toast(`${u?.name} enabled.`);
      }
      users = null; loadUsers();
    } catch (err) { toast(err.message); }
  });

  render();
})();
