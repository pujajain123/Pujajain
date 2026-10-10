import type { Request } from 'express';
import { all, get, run, now, tx, type Row } from './db.ts';
import {
  HttpError, type Me, type Role, hashPassword, generatePassword, generateLoginId, issueToken, setPasswordLink,
  revokeSessions, logAuthEvent, appUrl,
} from './auth.ts';
import { sendMail, inviteEmail, resetEmail } from './mailer.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** A shared team inbox: staff entered with it get their own generated login ID, and their links are emailed there. */
export const SHARED_INBOX = (process.env.OPS_SHARED_STAFF_EMAIL ?? 'admin@umamistudio.in').trim().toLowerCase();
const mailTo = (u: Row) => u.notify_email || (u.has_email ? u.email : null);

export const publicUser = (u: Row) => ({
  id: u.id, name: u.name, email: u.email, hasEmail: !!u.has_email, notifyEmail: u.notify_email || null, role: u.role, status: u.status,
  mustChangePassword: !!u.must_change_password, createdAt: u.created_at, lastLoginAt: u.last_login_at, disabledAt: u.disabled_at,
});
const userById = async (id: number) => publicUser(await get('SELECT * FROM users WHERE id=?', id));

export const listUsers = async () => (await all(`SELECT * FROM users ORDER BY role, status='disabled', name`)).map(publicUser);

function cleanName(name: unknown) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 80) throw new HttpError(400, 'Enter the person\'s name (2–80 characters).');
  return n;
}

/**
 * Create an account. With an email: the person gets a single-use set-password link (also returned to show the admin).
 * With the shared staff inbox: they get their own generated login ID, and the link is emailed to the inbox.
 * Without an email: a unique @umami.app login and a random password are generated; the password is returned once.
 */
export async function createUser(actor: Me | null, input: { name: unknown; email?: unknown; role?: Role }, req?: Request) {
  const name = cleanName(input.name);
  const role: Role = input.role === 'admin' ? 'admin' : 'staff';
  const email = String(input.email ?? '').trim().toLowerCase();
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'That email address does not look right.');
  if (email.endsWith('@umami.app')) throw new HttpError(400, 'Use the person\'s real email, or leave it empty to generate a login ID.');
  const shared = !!email && email === SHARED_INBOX;
  if (email && !shared && await get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with this email already exists.');
  if (await get(`SELECT 1 FROM users WHERE lower(name)=lower(?) AND status<>'disabled'`, name)) throw new HttpError(409, `${name} already has an account. Use a different name, e.g. with a surname.`);

  if (email) {
    const { id, token, login } = await tx(async () => {
      const login = shared ? await generateLoginId(name) : email;
      const r = await run(`INSERT INTO users (name, email, has_email, notify_email, role, status, created_at, created_by) VALUES (?,?,?,?,?,'invited',?,?) RETURNING id`,
        name, login, shared ? 0 : 1, shared ? email : null, role, now(), actor?.id ?? null);
      const id = Number(r.rows[0].id);
      return { id, login, token: await issueToken(id, 'invite', actor?.id ?? null) };
    });
    const link = setPasswordLink(token, req);
    const mail = await sendMail(email, ...Object.values(inviteEmail(name, link, login)) as [string, string]);
    await logAuthEvent('invited', id, actor?.id ?? null, shared ? `${login} via ${email}` : email);
    return { user: await userById(id), ...(shared ? { loginId: login } : {}), inviteLink: link, sentTo: email, emailSent: mail.sent, emailError: mail.error };
  }

  const password = generatePassword();
  const { id, loginId } = await tx(async () => {
    const loginId = await generateLoginId(name);
    const r = await run(`INSERT INTO users (name, email, has_email, role, status, password_hash, must_change_password, created_at, created_by) VALUES (?,?,0,?,'active',?,1,?,?) RETURNING id`,
      name, loginId, role, hashPassword(password), now(), actor?.id ?? null);
    return { id: Number(r.rows[0].id), loginId };
  });
  await logAuthEvent('created_with_login_id', id, actor?.id ?? null, loginId);
  return { user: await userById(id), loginId, password, loginLink: `${appUrl(req)}/login` };
}

async function target(id: unknown) {
  const n = Number(id);
  const u = Number.isInteger(n) ? await get('SELECT * FROM users WHERE id=?', n) : null;
  if (!u) throw new HttpError(404, 'User not found.');
  return u;
}

export async function resetPassword(actor: Me, id: unknown, req?: Request) {
  const u = await target(id);
  if (u.status === 'disabled') throw new HttpError(400, 'Enable this account before resetting its password.');
  if (mailTo(u)) {
    const token = await issueToken(u.id, u.status === 'invited' ? 'invite' : 'reset', actor.id);
    const link = setPasswordLink(token, req);
    const mail = await sendMail(mailTo(u), ...Object.values((u.status === 'invited' ? inviteEmail : resetEmail)(u.name, link, u.email)) as [string, string]);
    if (u.status === 'active') { await run('UPDATE users SET password_hash=NULL WHERE id=?', u.id); await revokeSessions(u.id); }
    await logAuthEvent('reset_link_issued', u.id, actor.id);
    return { user: await userById(u.id), ...(u.notify_email ? { loginId: u.email } : {}), resetLink: link, sentTo: mailTo(u), emailSent: mail.sent, emailError: mail.error };
  }
  const password = generatePassword();
  await run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', hashPassword(password), u.id);
  await revokeSessions(u.id);
  await logAuthEvent('password_reset', u.id, actor.id);
  return { user: await userById(u.id), loginId: u.email, password, loginLink: `${appUrl(req)}/login` };
}

export async function setStatus(actor: Me, id: unknown, enable: boolean) {
  const u = await target(id);
  if (u.id === actor.id && !enable) throw new HttpError(400, 'You cannot disable your own account.');
  if (!enable && u.role === 'admin') {
    const others = (await get(`SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND status='active' AND id<>?`, u.id)).n;
    if (!others) throw new HttpError(400, 'Keep at least one active admin.');
  }
  if (enable) {
    if (u.status !== 'disabled') return publicUser(u);
    await run(`UPDATE users SET status=?, disabled_at=NULL WHERE id=?`, u.password_hash ? 'active' : 'invited', u.id);
  } else {
    await tx(async () => {
      await run(`UPDATE users SET status='disabled', disabled_at=? WHERE id=?`, now(), u.id);
      await run('UPDATE auth_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', now(), u.id);
      await revokeSessions(u.id);
    });
  }
  await logAuthEvent(enable ? 'enabled' : 'disabled', u.id, actor.id);
  return userById(u.id);
}
