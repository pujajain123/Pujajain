import { run, now } from './db.ts';

/**
 * Sends account emails through Resend (https://resend.com) when RESEND_API_KEY and MAIL_FROM are set.
 * Every message is also kept in email_outbox, so nothing is lost while email is not configured;
 * admins always see the link on screen to copy as well.
 */
export async function sendMail(to: string, subject: string, body: string): Promise<{ sent: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  let status = 'not_configured', error: string | undefined;
  if (key && from) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text: body }),
      });
      status = res.ok ? 'sent' : 'failed';
      if (!res.ok) error = `Email service answered ${res.status}`;
    } catch (e) {
      status = 'failed';
      error = (e as Error).message;
    }
  }
  run('INSERT INTO email_outbox (created_at, to_addr, subject, body, status, error) VALUES (?,?,?,?,?,?)', now(), to, subject, body, status, error ?? null);
  if (status !== 'sent' && process.env.NODE_ENV !== 'test') console.log(`[mail:${status}] to ${to}: ${subject}\n${body}\n`);
  return { sent: status === 'sent', error: status === 'not_configured' ? 'Email is not set up yet' : error };
}

const loginLine = (login?: string) => (login && login.endsWith('@umami.app') ? `Their login ID is ${login}.\n` : '');

export function inviteEmail(name: string, link: string, login?: string) {
  return {
    subject: `Set the password for ${name} · Umami Studio Operations`,
    body: `Hi ${name},\n\nYou have been given access to the Umami Studio operations dashboard.\n${loginLine(login)}Set the password here (the link works once and expires in 48 hours):\n\n${link}\n\nIf you were not expecting this, ignore this email.`,
  };
}

export function resetEmail(name: string, link: string, login?: string) {
  return {
    subject: `Reset the password for ${name} · Umami Studio Operations`,
    body: `Hi ${name},\n\nAn admin has reset the password for the Umami Studio operations dashboard.\n${loginLine(login)}Choose a new password here (the link works once and expires in 48 hours):\n\n${link}`,
  };
}
