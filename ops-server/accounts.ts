import type { Request } from 'express';
import { all, get, run, now, tx, type Row } from './db.ts';
import {
  HttpError, type Me, type Role, hashPassword, generatePassword, generateLoginId, issueToken, setPasswordLink,
  revokeSessions, logAuthEvent, appUrl,
} from './auth.ts';
import { sendMail, inviteEmail, resetEmail } from './mailer.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const publicUser = (u: Row) => ({
  id: u.id, name: u.name, email: u.email, hasEmail: !!u.has_email, role: u.role, status: u.status,
  mustChangePassword: !!u.must_change_password, createdAt: u.created_at, lastLoginAt: u.last_login_at, disabledAt: u.disabled_at,
});

export const listUsers = () => all('SELECT * FROM users ORDER BY role, status=\'disabled\', name').map(publicUser);

function cleanName(name: unknown) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (n.length < 2 || n.length > 80) throw new HttpError(400, 'Enter the person\'s name (2–80 characters).');
  return n;
}

/**
 * Create an account. With an email: the person gets a single-use set-password link (also returned to show the admin).
 * Without one: a unique @umami.app login and a random password are generated; the password is returned once.
 */
export async function createUser(actor: Me | null, input: { name: unknown; email?: unknown; role?: Role }, req?: Request) {
  const name = cleanName(input.name);
  const role: Role = input.role === 'admin' ? 'admin' : 'staff';
  const email = String(input.email ?? '').trim().toLowerCase();
  if (email && !EMAIL.test(email)) throw new HttpError(400, 'That email address does not look right.');
  if (email.endsWith('@umami.app')) throw new HttpError(400, 'Use the person\'s real email, or leave it empty to generate a login ID.');
  if (email && get('SELECT 1 FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with this email already exists.');
  if (get('SELECT 1 FROM users WHERE lower(name)=lower(?) AND status<>\'disabled\'', name)) throw new HttpError(409, `${name} already has an account. Use a different name, e.g. with a surname.`);

  if (email) {
    const { id, token } = tx(() => {
      const r = run(`INSERT INTO users (name, email, has_email, role, status, created_at, created_by) VALUES (?,?,1,?,'invited',?,?)`, name, email, role, now(), actor?.id ?? null);
      const id = Number(r.lastInsertRowid);
      return { id, token: issueToken(id, 'invite', actor?.id ?? null) };
    });
    const link = setPasswordLink(token, req);
    const mail = await sendMail(email, ...Object.values(inviteEmail(name, link)) as [string, string]);
    logAuthEvent('invited', id, actor?.id ?? null, email);
    return { user: publicUser(get('SELECT * FROM users WHERE id=?', id)), inviteLink: link, emailSent: mail.sent, emailError: mail.error };
  }

  const loginId = generateLoginId(name), password = generatePassword();
  const id = Number(run(`INSERT INTO users (name, email, has_email, role, status, password_hash, must_change_password, created_at, created_by) VALUES (?,?,0,?,'active',?,1,?,?)`,
    name, loginId, role, hashPassword(password), now(), actor?.id ?? null).lastInsertRowid);
  logAuthEvent('created_with_login_id', id, actor?.id ?? null, loginId);
  return { user: publicUser(get('SELECT * FROM users WHERE id=?', id)), loginId, password, loginLink: `${appUrl(req)}/login` };
}

function target(id: unknown) {
  const u = get('SELECT * FROM users WHERE id=?', Number(id));
  if (!u) throw new HttpError(404, 'User not found.');
  return u;
}

export async function resetPassword(actor: Me, id: unknown, req?: Request) {
  const u = target(id);
  if (u.status === 'disabled') throw new HttpError(400, 'Enable this account before resetting its password.');
  if (u.has_email) {
    const token = issueToken(u.id, u.status === 'invited' ? 'invite' : 'reset', actor.id);
    const link = setPasswordLink(token, req);
    const mail = await sendMail(u.email, ...Object.values((u.status === 'invited' ? inviteEmail : resetEmail)(u.name, link)) as [string, string]);
    if (u.status === 'active') { run('UPDATE users SET password_hash=NULL WHERE id=?', u.id); revokeSessions(u.id); }
    logAuthEvent('reset_link_issued', u.id, actor.id);
    return { user: publicUser(get('SELECT * FROM users WHERE id=?', u.id)), resetLink: link, emailSent: mail.sent, emailError: mail.error };
  }
  const password = generatePassword();
  run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', hashPassword(password), u.id);
  revokeSessions(u.id);
  logAuthEvent('password_reset', u.id, actor.id);
  return { user: publicUser(get('SELECT * FROM users WHERE id=?', u.id)), loginId: u.email, password, loginLink: `${appUrl(req)}/login` };
}

export function setStatus(actor: Me, id: unknown, enable: boolean) {
  const u = target(id);
  if (u.id === actor.id && !enable) throw new HttpError(400, 'You cannot disable your own account.');
  if (!enable && u.role === 'admin') {
    const admins = get(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active' AND id<>?`, u.id).n;
    if (!admins) throw new HttpError(400, 'Keep at least one active admin.');
  }
  if (enable) {
    if (u.status !== 'disabled') return publicUser(u);
    run(`UPDATE users SET status=?, disabled_at=NULL WHERE id=?`, u.password_hash ? 'active' : 'invited', u.id);
  } else {
    run(`UPDATE users SET status='disabled', disabled_at=? WHERE id=?`, now(), u.id);
    run('UPDATE auth_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', now(), u.id);
    revokeSessions(u.id);
  }
  logAuthEvent(enable ? 'enabled' : 'disabled', u.id, actor.id);
  return publicUser(get('SELECT * FROM users WHERE id=?', u.id));
}
