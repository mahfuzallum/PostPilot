// Transactional email. SMTP settings come ONLY from env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM).
// When SMTP is not configured, messages are logged as "skipped" and nothing is sent.
const { db } = require('./db');
const S = require('./settings');
let transport;
const configured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
// Which variables are present (never their values).
const status = () => ({ configured: configured(), vars: Object.fromEntries(VARS.map(v => [v, !!process.env[v]])), port: Number(process.env.SMTP_PORT || 587) });
const fromAddr = () => process.env.MAIL_FROM || process.env.SMTP_USER; // Gmail rejects From addresses that are not your account or a verified alias
const setTransport = t => { transport = t; }; // tests inject a mock transport
function getTransport() {
  if (transport !== undefined) return transport;
  try {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 587);
    // 465 = implicit TLS; 587 (default) = STARTTLS, required (Gmail: smtp.gmail.com:587)
    transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
  } catch (e) { console.log('[mail] nodemailer unavailable:', e.message); transport = null; }
  return transport;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const appUrl = () => (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');

// Shared, inline-styled template (email clients ignore <style> blocks and external CSS).
function template({ title, intro, body = '', cta, ctaUrl, tone = '#7c5cff' }) {
  const app = esc(S.get('app_name')), link = ctaUrl && appUrl() ? appUrl() + ctaUrl : null;
  return `<!doctype html><html><body style="margin:0;background:#f4f5fb;font-family:Inter,Segoe UI,Arial,sans-serif;color:#14162b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fb;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(20,22,60,.08)">
<tr><td style="background:linear-gradient(135deg,#7c5cff,#ff5ca8);padding:22px 28px;color:#fff;font-weight:800;font-size:18px">${app}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 10px;font-size:22px;color:${tone}">${esc(title)}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3b3f5c">${esc(intro)}</p>${body}
${cta ? `<p style="margin:24px 0 6px"><a href="${esc(link || '#')}" style="display:inline-block;background:#7c5cff;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(cta)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:18px 28px;background:#fafbff;color:#8a8fae;font-size:12px;line-height:1.5">You received this because of your ${app} account. Change which emails you get in Settings → Notifications.</td></tr>
</table></td></tr></table></body></html>`;
}
const box = rows => `<table role="presentation" width="100%" style="background:#f6f7fd;border-radius:10px;padding:6px 14px;font-size:14px">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#8a8fae;width:38%">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>`;

const PREF = { post_deleted: 'email_post_deleted', sub_expiring: 'email_expiry', sub_expired: 'email_expiry', payment_failed: 'email_payment' };
// Returns the email_log status: 'sent' | 'skipped' | 'opted_out' | 'failed'
async function notify(userId, kind, msg) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId); if (!u) return 'failed';
  const logIt = (status, error) => { db.prepare('INSERT INTO email_log(user_id,kind,to_addr,subject,status,error,ts) VALUES(?,?,?,?,?,?,?)').run(userId, kind, u.email, msg.subject, status, error || null, Date.now()); return status; };
  if (PREF[kind] && u[PREF[kind]] === 0) return logIt('opted_out');
  if (!configured()) { console.log(`[mail] SMTP not configured; skipped "${msg.subject}" to user ${userId}`); return logIt('skipped'); }
  const t = getTransport(); if (!t) return logIt('failed', 'no transport');
  try { await t.sendMail({ from: fromAddr(), to: u.email, subject: msg.subject, html: msg.html, text: msg.text }); return logIt('sent'); }
  catch (e) { console.log('[mail] send failed:', e.message); return logIt('failed', e.message); }
}
const day = ms => new Date(ms).toLocaleString('en-GB', { timeZone: S.get('default_tz'), dateStyle: 'medium', timeStyle: 'short' });
const T = {
  postDeleted: ({ text, by }) => ({ subject: 'Your post was deleted', text: `A post was deleted ${by === 'owner' ? 'by the site owner' : 'from your account'}: "${(text || '').slice(0, 120)}"`,
    html: template({ title: 'A post was deleted', intro: by === 'owner' ? 'The site owner removed one of your posts.' : 'You deleted a post. This is a confirmation for your records.', body: box([['Post', (text || '').slice(0, 140) || '(no text)'], ['Deleted by', by === 'owner' ? 'Site owner' : 'You'], ['When', day(Date.now())]]), cta: 'Open your queue', ctaUrl: '/queue' }) }),
  subExpiring: ({ plan, until }) => ({ subject: 'Your Premium ends in 3 days', text: `Your Premium (${plan}) ends on ${day(until)}.`,
    html: template({ title: 'Premium ends in 3 days', intro: 'Renew to keep unlimited scheduling, analytics and premium themes.', body: box([['Plan', plan], ['Ends', day(until)]]), cta: 'Renew Premium', ctaUrl: '/billing', tone: '#d97706' }) }),
  subExpired: ({ plan }) => ({ subject: 'Your Premium has expired', text: `Your Premium (${plan}) has expired. You are now on the Free plan.`,
    html: template({ title: 'Premium has expired', intro: 'Your account is now on the Free plan. Scheduled posts above the free limit stay in your queue.', body: box([['Previous plan', plan], ['Now', 'Free']]), cta: 'See plans', ctaUrl: '/billing', tone: '#dc2626' }) }),
  paymentFailed: ({ plan, amount, reason }) => ({ subject: 'Payment failed', text: `A payment for ${plan || 'Premium'} failed. ${reason || ''}`,
    html: template({ title: 'Payment did not go through', intro: 'We could not complete your payment. No money was taken for this attempt.', body: box([['Plan', plan || 'Premium'], ['Amount', amount != null ? '$' + amount : '–'], ['Reason', reason || 'Declined by the provider']]), cta: 'Try again', ctaUrl: '/billing', tone: '#dc2626' }) }),
};
async function sendTest(to) {
  if (!configured()) return { ok: false, error: 'SMTP is not configured: set SMTP_HOST, SMTP_USER and SMTP_PASS in Railway Variables.' };
  const t = getTransport(); if (!t) return { ok: false, error: 'Mail transport unavailable' };
  try {
    await t.sendMail({ from: fromAddr(), to, subject: `${S.get('app_name')} test email`, text: 'SMTP works. This is a test email from your owner console.',
      html: template({ title: 'Email is working 🎉', intro: 'This test was sent from the owner console. Notification emails will now be delivered to your users.' }) });
    db.prepare('INSERT INTO email_log(user_id,kind,to_addr,subject,status,ts) VALUES(NULL,?,?,?,?,?)').run('test', to, 'test email', 'sent', Date.now());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
module.exports = { notify, template, T, configured, status, sendTest, setTransport, VARS };
