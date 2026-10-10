/* Server mode start-up: sign-in, set-password and change-password screens, then the dashboard with server data. */
(() => {
  const APP_SCRIPTS = ['app.js', 'portal-updates.js', 'iron-job-sheet.js', 'portal-v2.js', 'server-sync.js'];
  const LOGO = '<img class="auth-logo" src="/umami-logo.png" alt="Umami Studio">';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(url, body) {
    const res = await fetch(url, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status, code: data.code });
    return data;
  }
  window.umamiApi = api;

  function screen(html) {
    document.body.classList.add('auth-mode');
    let root = document.querySelector('#auth-root');
    if (!root) { root = document.createElement('div'); root.id = 'auth-root'; document.body.prepend(root); }
    root.innerHTML = `<main class="auth-screen"><section class="auth-card">${LOGO}${html}</section><p class="auth-foot">Umami Studio · Operations</p></main>`;
    root.querySelector('input:not([readonly])')?.focus();
    return root;
  }
  const passwordRules = '<p class="auth-hint">At least 8 characters, with a letter and a number. Don\'t reuse a password from another person or site.</p>';
  function bindForm(root, handler) {
    const form = root.querySelector('form'), error = root.querySelector('.auth-error'), button = form.querySelector('button[type=submit]');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      error.hidden = true;
      const label = button.textContent;
      button.disabled = true; button.textContent = 'Please wait…';
      try { await handler(Object.fromEntries(new FormData(form))); }
      catch (err) { error.textContent = err.message; error.hidden = false; button.disabled = false; button.textContent = label; }
    });
  }
  const matchCheck = d => { if (d.password !== d.confirm) throw new Error('The two passwords do not match.'); };

  function showLogin(message) {
    history.replaceState(null, '', '/login');
    const root = screen(`<h1>Sign in</h1><p class="auth-sub">Use the email or login ID your admin gave you.</p>
      ${message ? `<div class="auth-note">${esc(message)}</div>` : ''}
      <form class="auth-form" autocomplete="on"><label class="field"><span>Email or login ID</span><input name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Sign in</button></form>
      <p class="auth-hint">Forgot your password? Ask an admin to reset it.</p>`);
    bindForm(root, async d => { await api('/api/auth/login', d); location.replace('/'); });
  }

  async function showSetPassword() {
    const token = new URLSearchParams(location.search).get('token') || '';
    let info;
    try { info = await api(`/api/auth/token?token=${encodeURIComponent(token)}`); }
    catch (err) { screen(`<h1>Link not valid</h1><div class="auth-error">${esc(err.message)}</div><a class="secondary-button auth-submit" href="/login">Go to sign in</a>`); return; }
    const root = screen(`<h1>${info.purpose === 'reset' ? 'Choose a new password' : 'Set your password'}</h1><p class="auth-sub">Hi ${esc(info.name)}. This link works once and expires ${esc(new Date(info.expiresAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}.</p>
      <form class="auth-form"><label class="field"><span>Email</span><input name="email" value="${esc(info.email)}" readonly aria-readonly="true" autocomplete="username"></label>
      <label class="field"><span>New password</span><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field"><span>Confirm password</span><input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>
      ${passwordRules}<div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Save password and sign in</button></form>`);
    bindForm(root, async d => { matchCheck(d); await api('/api/auth/set-password', { token, password: d.password }); location.replace('/'); });
  }

  function showChangePassword(user) {
    const root = screen(`<h1>Choose your own password</h1><p class="auth-sub">You signed in with a temporary password. Set a new one to continue.</p>
      <form class="auth-form"><label class="field"><span>Login ID</span><input value="${esc(user.email)}" readonly autocomplete="username"></label>
      <label class="field"><span>Temporary password</span><input name="current" type="password" autocomplete="current-password" required></label>
      <label class="field"><span>New password</span><input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <label class="field"><span>Confirm new password</span><input name="confirm" type="password" autocomplete="new-password" minlength="8" required></label>
      ${passwordRules}<div class="auth-error" role="alert" hidden></div><button class="primary-button auth-submit" type="submit">Save and continue</button>
      <button type="button" class="quiet-button auth-submit" data-auth-logout>Sign out</button></form>`);
    root.querySelector('[data-auth-logout]').addEventListener('click', async () => { await api('/api/auth/logout', {}); location.replace('/login'); });
    bindForm(root, async d => { matchCheck(d); await api('/api/auth/change-password', { current: d.current, password: d.password }); location.replace('/'); });
  }

  function loadScripts(list) {
    return list.reduce((p, src) => p.then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `/${src}`; s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
      document.body.appendChild(s);
    })), Promise.resolve());
  }

  async function start() {
    if (location.pathname === '/set-password') return showSetPassword();
    let me;
    try { me = (await api('/api/auth/me')).user; }
    catch (err) { return showLogin(); }
    if (me.mustChangePassword) return showChangePassword(me);
    const state = await api('/api/state');
    // The dashboard reads its data from browser storage at start-up; fill it from the server first.
    localStorage.setItem('umami-ops-v1', JSON.stringify(state.db));
    localStorage.setItem('umami-production-tracker-v1', JSON.stringify(state.tracker));
    if (state.rope) localStorage.setItem('umami-rope-inventory-v1', JSON.stringify(state.rope)); else localStorage.removeItem('umami-rope-inventory-v1');
    window.UMAMI_ME = me;
    window.UMAMI_SERVER = { revision: state.revision, people: state.people };
    if (location.pathname !== '/') history.replaceState(null, '', '/' + (location.hash || '#dashboard'));
    else if (!location.hash) history.replaceState(null, '', '/#dashboard');
    await loadScripts(APP_SCRIPTS);
  }

  start().catch(err => screen(`<h1>Could not load the dashboard</h1><div class="auth-error">${esc(err.message)}</div><button class="primary-button auth-submit" onclick="location.reload()">Try again</button>`));
})();
