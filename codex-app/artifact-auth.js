/* Sign-in for the published (browser-only) dashboard.
   Accounts live in the page's shared database (the `db` capability) so every device sees the same logins;
   without it (local preview) they fall back to this browser's storage.
   - First visit: email → (staff inbox: pick your name) → create password → confirm → signed in.
   - Forgot password: the request goes to the admins; once an admin allows it, the person sets a new password
     with the same create → confirm screen. (This page cannot send emails.)
   Passwords are stored only as salted PBKDF2 hashes. This is a sign-in for the dashboard, not a server-side
   security boundary: the page and its data are only as private as who the link is shared with. */
(() => {
  const STAFF_INBOX = 'admin@umamistudio.in';
  const SEED_ACCOUNTS = [
    { id: 'khushboo', name: 'Khushboo', email: 'khushboo@umamistudio.in', role: 'admin' },
    { id: 'bhavya', name: 'Bhavya', email: 'bhavya@umamistudio.in', role: 'admin' },
    { id: 'akshay', name: 'Akshay', email: STAFF_INBOX, role: 'staff' },
    { id: 'manish', name: 'Manish', email: STAFF_INBOX, role: 'staff' },
  ];
  const SESSION_KEY = 'umami-session-v1', LOCAL_ACCOUNTS = 'umami-accounts-v1';
  const STAFF_PAGES = ['dashboard', 'orders', 'jobs', 'inventory', 'reports', 'guide'];
  const LOGO = document.querySelector('.brand-logo')?.getAttribute('src') || '';
  const norm = s => String(s || '').trim().toLowerCase();
  const slug = s => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'staff';

  /* ---------- Storage: shared page database, or this browser as a fallback ---------- */
  let store = null; // { all(), put(acc), patch(id, fields) }
  async function openStore() {
    let shared = null;
    try { shared = window.claude?.use ? await window.claude.use('db') : null; } catch (e) { shared = null; }
    if (shared) {
      const col = shared.collection('accounts');
      return {
        shared: true,
        async all() { const snap = await col.get(); return snap.docs.map(d => ({ id: d.id, ...d.data() })); },
        async put(acc) { const { id, ...body } = acc; await col.doc(id).set(body); },
        async patch(id, fields) { await col.doc(id).update(fields); },
      };
    }
    const read = () => { try { return JSON.parse(localStorage.getItem(LOCAL_ACCOUNTS)) || {}; } catch (e) { return {}; } };
    const write = v => { try { localStorage.setItem(LOCAL_ACCOUNTS, JSON.stringify(v)); } catch (e) { /* storage blocked */ } };
    return {
      shared: false,
      async all() { return Object.entries(read()).map(([id, a]) => ({ id, ...a })); },
      async put(acc) { const v = read(); const { id, ...body } = acc; v[id] = body; write(v); },
      async patch(id, fields) { const v = read(); v[id] = { ...v[id], ...fields }; write(v); },
    };
  }
  async function accounts() {
    const list = await store.all();
    // The developer-defined first accounts always exist; their saved state (password, status) comes from storage.
    for (const s of SEED_ACCOUNTS) if (!list.some(a => a.id === s.id)) list.push({ ...s, status: 'active' });
    return list;
  }
  const save = acc => store.put(acc);

  /* ---------- Password hashing (PBKDF2-SHA256) ---------- */
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  async function hashPassword(pw, saltHex) {
    const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256);
    return { salt: hex(salt), hash: hex(bits) };
  }
  function checkStrength(pw) {
    if (pw.length < 8) throw new Error('Use at least 8 characters.');
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new Error('Use at least one letter and one number.');
  }

  /* ---------- Screens ---------- */
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function screen(html) {
    document.body.classList.add('auth-mode');
    let root = document.querySelector('#auth-root');
    if (!root) { root = document.createElement('div'); root.id = 'auth-root'; document.body.prepend(root); }
    root.innerHTML = `<main class="auth-screen"><section class="auth-card">${LOGO ? `<img class="auth-logo" src="${LOGO}" alt="Umami Studio">` : ''}${html}</section><p class="auth-foot">Umami Studio · Operations</p></main>`;
    root.querySelector('input:not([readonly]):not([type=hidden]), select')?.focus();
    return root;
  }
  function bind(root, handler) {
    const form = root.querySelector('form'), error = root.querySelector('.auth-error'), button = form.querySelector('button[type=submit]');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      error.hidden = true;
      const label = button.textContent;
      button.disabled = true; button.textContent = 'Please wait…';
      try { await handler(Object.fromEntries(new FormData(form))); }
      catch (err) { error.textContent = err.message || 'Something went wrong. Try again.'; error.hidden = false; button.disabled = false; button.textContent = label; }
    });
  }
  const rules = '<p class="auth-hint">At least 8 characters, with a letter and a number.</p>';

  // Step 1: email (and, for the shared staff inbox, which person).
  async function showEmail(note = '', prefill = '') {
    const root = screen(`<h1>Sign in</h1><p class="auth-sub">Enter your email to continue.</p>
      ${note ? `<div class="auth-note">${escHtml(note)}</div>` : ''}
      <form class="auth-form"><label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escHtml(prefill)}" required></label>
      <div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Continue</button></form>
      <button type="button" class="text-button auth-link" data-forgot>Forgot password?</button>`);
    root.querySelector('[data-forgot]').addEventListener('click', () => showForgot(root.querySelector('[name=email]').value));
    bind(root, async d => {
      const matches = (await accounts()).filter(a => norm(a.email) === norm(d.email) && a.status !== 'disabled');
      if (!matches.length) throw new Error('This email does not have access. Ask an admin to add you.');
      if (matches.length === 1) return showPassword(matches[0]);
      showWho(matches, d.email);
    });
  }

  function showWho(matches, email, next = showPassword) {
    const root = screen(`<h1>Who are you?</h1><p class="auth-sub">${escHtml(email)} is the shared staff email. Choose your name.</p>
      <form class="auth-form"><label class="field"><span>Your name</span><select name="id" required>${matches.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name)}</option>`).join('')}</select></label>
      <div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Continue</button></form>
      <button type="button" class="text-button auth-link" data-back>Back</button>`);
    root.querySelector('[data-back]').addEventListener('click', () => showEmail('', email));
    bind(root, async d => next(matches.find(a => a.id === d.id)));
  }

  // Step 2: create a password (first time / after an allowed reset) or enter it.
  function showPassword(acc) {
    if (!acc.hash) {
      const root = screen(`<h1>Create your password</h1><p class="auth-sub">Hi ${escHtml(acc.name)}. Choose a password only you know.</p>
        <form class="auth-form"><label class="field"><span>Email</span><input value="${escHtml(acc.email)}" readonly autocomplete="username"></label>
        <label class="field"><span>Create password</span><input name="password" type="password" autocomplete="new-password" required></label>
        <label class="field"><span>Confirm password</span><input name="confirm" type="password" autocomplete="new-password" required></label>
        ${rules}<div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Create password and sign in</button></form>
        <button type="button" class="text-button auth-link" data-back>Back</button>`);
      root.querySelector('[data-back]').addEventListener('click', () => showEmail('', acc.email));
      return bind(root, async d => {
        if (d.password !== d.confirm) throw new Error('The two passwords do not match.');
        checkStrength(d.password);
        const fresh = (await accounts()).find(a => a.id === acc.id);
        if (fresh?.hash) throw new Error('A password was just set for this account. Go back and sign in.');
        const { salt, hash } = await hashPassword(d.password);
        const updated = { ...acc, ...fresh, salt, hash, status: 'active', resetRequested: false, passwordSetAt: new Date().toISOString() };
        await save(updated);
        signIn(updated);
      });
    }
    const root = screen(`<h1>Welcome back, ${escHtml(acc.name)}</h1><p class="auth-sub">${escHtml(acc.email)}</p>
      <form class="auth-form"><input type="hidden" name="u" value="${escHtml(acc.email)}" autocomplete="username">
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Sign in</button></form>
      <button type="button" class="text-button auth-link" data-forgot>Forgot password?</button>
      <button type="button" class="text-button auth-link" data-back>Use a different email</button>`);
    root.querySelector('[data-back]').addEventListener('click', () => showEmail());
    root.querySelector('[data-forgot]').addEventListener('click', () => requestReset(acc));
    bind(root, async d => {
      const { hash } = await hashPassword(d.password, acc.salt);
      if (hash !== acc.hash) throw new Error('That password is incorrect.');
      signIn(acc);
    });
  }

  // Forgot password: find the account by email, then ask the admins to allow a reset.
  function showForgot(prefill = '') {
    const root = screen(`<h1>Forgot password</h1><p class="auth-sub">Enter your email. Your request goes to the admins; once they allow it, you'll create a new password here.</p>
      <form class="auth-form"><label class="field"><span>Email</span><input name="email" type="email" autocapitalize="none" spellcheck="false" value="${escHtml(prefill)}" required></label>
      <div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Send reset request</button></form>
      <button type="button" class="text-button auth-link" data-back>Back to sign in</button>`);
    root.querySelector('[data-back]').addEventListener('click', () => showEmail());
    bind(root, async d => {
      const matches = (await accounts()).filter(a => norm(a.email) === norm(d.email) && a.status !== 'disabled');
      if (!matches.length) throw new Error('This email does not have access. Ask an admin to add you.');
      if (matches.length === 1) return requestReset(matches[0]);
      showWho(matches, d.email, requestReset);
    });
  }

  async function requestReset(acc) {
    await save({ ...acc, resetRequested: true, resetRequestedAt: new Date().toISOString() });
    const admins = SEED_ACCOUNTS.filter(a => a.role === 'admin').map(a => a.email).join(',');
    const mail = `mailto:${admins}?subject=${encodeURIComponent('Umami dashboard: password reset for ' + acc.name)}&body=${encodeURIComponent(`Hi, please allow a password reset for ${acc.name} (${acc.email}) in the Umami dashboard: Staff → Team logins → Allow reset.`)}`;
    const root = screen(`<h1>Request sent</h1><p class="auth-sub">The admins (Khushboo and Bhavya) will see your request on the dashboard. Once one of them allows it, come back here, enter your email and create a new password.</p>
      <a class="secondary-button auth-submit" href="${mail}" target="_blank" rel="noopener">Also email the admins</a>
      <button type="button" class="text-button auth-link" data-back>Back to sign in</button>`);
    root.querySelector('[data-back]').addEventListener('click', () => showEmail('', acc.email));
  }

  /* ---------- Session and roles ---------- */
  let me = null;
  function signIn(acc) {
    me = acc;
    team = null;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ id: acc.id, sig: String(acc.hash).slice(0, 16) })); } catch (e) { /* storage blocked */ }
    document.querySelector('#auth-root')?.remove();
    document.body.classList.remove('auth-mode');
    applyRole();
    toast(`Signed in as ${acc.name}.`);
  }
  function signOut() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ }
    me = null;
    location.hash = '#dashboard';
    showEmail('You have signed out.');
  }

  function applyRole() {
    const admin = me.role === 'admin';
    db.role = admin ? 'Admin' : 'Staff';
    window.staffMember = me.name;
    if (!PEOPLE.includes(me.name) && !admin) PEOPLE.push(me.name);
    for (const s of SEED_ACCOUNTS) if (s.role === 'staff' && !PEOPLE.includes(s.name)) PEOPLE.push(s.name);
    if (!admin && !STAFF_PAGES.includes(page)) { page = 'dashboard'; location.hash = '#dashboard'; }
    render();
  }

  currentActor = () => (me ? me.name : 'Admin');
  const baseRender = render;
  render = function () {
    if (me && me.role !== 'admin' && !STAFF_PAGES.includes(page)) { page = 'dashboard'; history.replaceState(null, '', '#dashboard'); }
    if (me) { db.role = me.role === 'admin' ? 'Admin' : 'Staff'; window.staffMember = me.name; }
    baseRender();
    if (!me) return;
    const profile = document.querySelector('.user-profile');
    if (profile) {
      profile.querySelector('strong').textContent = me.name;
      profile.querySelector('.avatar').textContent = me.name.slice(0, 2).toUpperCase();
      const label = profile.querySelector('#role-label'); if (label) label.textContent = me.role === 'admin' ? 'Administrator' : 'Staff';
      const more = profile.querySelector('.profile-more'); if (more) more.textContent = 'Account⌄';
    }
    const menu = document.querySelector('#role-menu');
    if (menu && !menu.querySelector('[data-account-logout]')) {
      menu.innerHTML = `<div class="role-menu-heading">${escHtml(me.email)}</div><button type="button" data-account-password><span class="role-menu-icon">⚿</span><span><strong>Change password</strong><small>Set a new password</small></span></button><button type="button" data-account-logout><span class="role-menu-icon staff">↪</span><span><strong>Sign out</strong><small>End this session</small></span></button>`;
    }
    if (me.role !== 'admin') {
      document.querySelectorAll('.nav-link').forEach(a => { a.style.display = STAFF_PAGES.includes(a.dataset.page) ? 'flex' : 'none'; });
      document.querySelectorAll('.nav-group').forEach(g => { g.style.display = [...g.querySelectorAll('.nav-link')].some(a => a.style.display !== 'none') ? '' : 'none'; });
      const picker = document.querySelector('#staff-person');
      if (picker) (picker.closest('.app-select') || picker).style.display = 'none';
      if (page === 'dashboard') { const crumb = document.querySelector('#breadcrumb'); if (crumb) crumb.textContent = 'My work'; }
    }
    if (me.role === 'admin' && page === 'staff') renderTeamPanel();
  };
  window.render = render;

  /* ---------- Account menu: change password, sign out ---------- */
  document.addEventListener('click', e => {
    if (e.target.closest('[data-account-logout]')) { document.querySelector('#role-menu').hidden = true; signOut(); }
    if (e.target.closest('[data-account-password]')) {
      document.querySelector('#role-menu').hidden = true;
      document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">YOUR ACCOUNT</div><h2>Change password</h2><p>${escHtml(me.email)}</p></div><button class="close-button" data-close>×</button></div>
        <form id="artifact-password-form"><div class="form-grid"><div class="field full"><label>Current password</label><input name="current" type="password" autocomplete="current-password" required></div><div class="field"><label>New password</label><input name="password" type="password" autocomplete="new-password" required></div><div class="field"><label>Confirm new password</label><input name="confirm" type="password" autocomplete="new-password" required></div></div>
        <p class="small-note">At least 8 characters, with a letter and a number.</p><div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Save password</button></div></form></section></div>`;
    }
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'artifact-password-form') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = Object.fromEntries(new FormData(e.target));
    try {
      const acc = (await accounts()).find(a => a.id === me.id);
      if ((await hashPassword(d.current, acc.salt)).hash !== acc.hash) throw new Error('Your current password is incorrect.');
      if (d.password !== d.confirm) throw new Error('The two new passwords do not match.');
      checkStrength(d.password);
      const { salt, hash } = await hashPassword(d.password);
      me = { ...acc, salt, hash, passwordSetAt: new Date().toISOString() };
      await save(me);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ id: me.id, sig: hash.slice(0, 16) }));
      document.querySelector('#overlay-root').innerHTML = '';
      toast('Password changed.');
    } catch (err) { toast(err.message); }
  }, true);

  /* ---------- Team logins (admin, Staff page) ---------- */
  let team = null, teamLoading = false;
  async function loadTeam() {
    if (teamLoading) return;
    teamLoading = true;
    try { team = await accounts(); } finally { teamLoading = false; }
    if (page === 'staff') render();
  }
  // Fresh list every time the Staff page is opened, so new reset requests show up.
  document.addEventListener('click', e => { if (e.target.closest('[data-page="staff"]')) team = null; }, true);
  function renderTeamPanel() {
    const host = document.querySelector('#page-content');
    // The older "Add staff member" button never created a login; the Team logins panel replaces it.
    host?.querySelector('.page-heading [data-action="add-staff"], header [data-action="add-staff"]')?.remove();
    host?.querySelectorAll('[data-action="add-staff"]').forEach(b => { if (!b.closest('.team-logins')) b.remove(); });
    if (!host || host.querySelector('.team-logins')) return;
    if (!team) { loadTeam(); return; }
    const state = a => a.status === 'disabled' ? '<span class="account-status disabled">Disabled</span>' : a.resetRequested ? '<span class="account-status invited">Reset requested</span>' : a.hash ? '<span class="account-status">Password set</span>' : '<span class="account-status invited">Not signed in yet</span>';
    const html = `<section class="panel team-logins team-accounts"><div class="panel-header"><div><div class="eyebrow">TEAM LOGINS</div><h2>Who can sign in</h2><p>Only these emails can sign in. Each person creates their own password the first time.</p></div><button type="button" class="primary-button" data-team-add>＋ Add staff</button></div>
      ${team.some(a => a.resetRequested && a.status !== 'disabled') ? '<div class="report-due"><strong>Password reset requested.</strong> Click <b>Allow reset</b> next to the person; they can then create a new password at sign-in.</div>' : ''}
      <div class="table-wrap"><table class="data-table"><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th></th></tr></thead><tbody>${team.map(a => `<tr><td><strong>${escHtml(a.name)}</strong>${a.id === me.id ? ' <small class="demo-tag" style="color:var(--muted)">YOU</small>' : ''}</td><td>${escHtml(a.email)}${norm(a.email) === STAFF_INBOX ? '<small style="display:block;color:#9ca49f">Shared staff email</small>' : ''}</td><td>${a.role === 'admin' ? 'Admin' : 'Staff'}</td><td>${state(a)}</td>
        <td class="account-actions">${a.status !== 'disabled' && (a.hash || a.resetRequested) && a.id !== me.id ? `<button type="button" class="compact-button" data-team-reset="${escHtml(a.id)}">Allow reset</button>` : ''}${a.id === me.id || a.role === 'admin' ? '' : a.status === 'disabled' ? `<button type="button" class="compact-button" data-team-enable="${escHtml(a.id)}">Enable</button>` : `<button type="button" class="compact-button" data-team-disable="${escHtml(a.id)}">Disable</button>`}</td></tr>`).join('')}</tbody></table></div>
      ${store.shared ? '' : '<p class="small-note">Preview mode: logins are saved in this browser only.</p>'}</section>`;
    const anchor = host.querySelector('.report-grid');
    anchor ? anchor.insertAdjacentHTML('beforebegin', html) : host.insertAdjacentHTML('beforeend', html);
  }
  document.addEventListener('click', async e => {
    const reset = e.target.closest('[data-team-reset]'), dis = e.target.closest('[data-team-disable]'), en = e.target.closest('[data-team-enable]');
    if (e.target.closest('[data-team-add]')) {
      document.querySelector('#overlay-root').innerHTML = `<div class="modal-backdrop center"><section class="modal-card"><div class="modal-heading"><div><div class="eyebrow">STAFF</div><h2>Add staff</h2><p>They create their own password the first time they sign in.</p></div><button class="close-button" data-close>×</button></div>
        <form id="team-add-form"><div class="form-grid"><div class="field full"><label>Name</label><input name="name" required maxlength="60" placeholder="e.g. Ravi"></div><div class="field full"><label>Email</label><input name="email" type="email" value="${STAFF_INBOX}" required></div></div>
        <p class="small-note">Leave the shared staff email (${STAFF_INBOX}) or enter their own. Their name must match the name used when assigning jobs.</p><div class="form-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button class="primary-button">Add staff</button></div></form></section></div>`;
      return;
    }
    if (!reset && !dis && !en) return;
    const id = (reset || dis || en).dataset[reset ? 'teamReset' : dis ? 'teamDisable' : 'teamEnable'];
    const acc = (await accounts()).find(a => a.id === id);
    if (!acc) return;
    if (reset && !confirm(`Allow ${acc.name} to create a new password? Their current password stops working.`)) return;
    if (dis && !confirm(`Disable ${acc.name}? They will not be able to sign in.`)) return;
    const next = reset ? { ...acc, hash: '', salt: '', resetRequested: false } : { ...acc, status: dis ? 'disabled' : 'active' };
    await save(next);
    addActivity(me.name, 'Accounts', reset ? `Allowed password reset for ${acc.name}` : `${dis ? 'Disabled' : 'Enabled'} sign-in for ${acc.name}`);
    toast(reset ? `${acc.name} can now create a new password at sign-in.` : `${acc.name} ${dis ? 'disabled' : 'enabled'}.`);
    team = null; render();
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'team-add-form') return;
    e.preventDefault(); e.stopImmediatePropagation();
    const d = Object.fromEntries(new FormData(e.target)), name = d.name.trim().replace(/\s+/g, ' ');
    const list = await accounts();
    if (name.length < 2) return toast('Enter their name.');
    if (list.some(a => norm(a.name) === norm(name) && a.status !== 'disabled')) return toast(`${name} already has a login.`);
    if (norm(d.email) !== STAFF_INBOX && list.some(a => norm(a.email) === norm(d.email))) return toast('That email already has a login.');
    let id = slug(name); for (let i = 2; list.some(a => a.id === id); i++) id = `${slug(name)}-${i}`;
    await save({ id, name, email: norm(d.email), role: 'staff', status: 'active' });
    if (!PEOPLE.includes(name)) PEOPLE.push(name);
    addActivity(me.name, 'Accounts', `Added staff login for ${name}`);
    document.querySelector('#overlay-root').innerHTML = '';
    toast(`${name} added. They sign in with ${norm(d.email)} and create their password.`);
    team = null; render();
  }, true);

  /* ---------- Show/hide button on every password box ---------- */
  const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  function addPasswordEyes(root = document) {
    root.querySelectorAll?.('input[type=password]:not([data-eye])').forEach(input => {
      input.dataset.eye = '1';
      const wrap = document.createElement('span');
      wrap.className = 'pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.append(input);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-eye';
      btn.setAttribute('aria-label', 'Show password');
      btn.innerHTML = EYE;
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.innerHTML = show ? EYE_OFF : EYE;
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        input.focus();
      });
      wrap.append(btn);
    });
  }
  new MutationObserver(() => addPasswordEyes()).observe(document.body, { childList: true, subtree: true });

  /* ---------- Start ---------- */
  screen('<h1>Loading…</h1><p class="auth-sub">Preparing sign-in.</p>');
  (async () => {
    store = await openStore();
    let session = null;
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { session = null; }
    const acc = session && (await accounts()).find(a => a.id === session.id);
    if (acc && acc.hash && acc.status !== 'disabled' && String(acc.hash).slice(0, 16) === session.sig) signIn(acc);
    else showEmail();
  })().catch(() => showEmail('Sign-in storage could not be reached. Try reloading the page.'));
})();
