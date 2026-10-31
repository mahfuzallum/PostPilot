// Feature tests (round 3): node test/features.js  — own temp DATA_DIR, mocked Threads + mocked mail transport.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ppf-'));
Object.assign(process.env, { THREADS_APP_ID: '123', THREADS_APP_SECRET: 'topsecret' });
for (const k of ['ADMIN_PATH', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'MAIL_FROM', 'REDDIT_CLIENT_ID', 'X_CLIENT_ID']) delete process.env[k];
process.env.GEOIP_LOOKUP = 'off';
const app = require('../src/server');
const { db } = require('../src/db');
const S = require('../src/settings');
const threads = require('../src/platforms/threads');
const accounts = require('../src/accounts');
const W = require('../src/worker');
const P = require('../src/payments');
const mailer = require('../src/mailer');
const activity = require('../src/activity');
const audit = require('../src/audit');
const ai = require('../src/ai');

let fail = null; let pubs = 0;
threads.setClient({ mock: true, publishingLimit: async () => ({ used: 0, total: 250 }),
  container: async () => { if (fail) throw fail; return 'c' + (++pubs); }, waitReady: async () => {}, publish: async (u, t, c) => 'm' + c,
  permalink: async id => 'https://www.threads.net/@demo/post/' + id, insights: async () => ({ views: 1, likes: 0, replies: 0, reposts: 0 }),
  refresh: async () => ({ token: 't', expiresIn: 5184000 }), remove: async () => ({ success: true }), keywordSearch: async () => [] });

const sent = []; let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✔', m); };
async function main() {
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const jar = {}; const f = async (u, o = {}, who = 'a') => { const r = await fetch(base + u, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: jar[who] || '' } }); const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0]; return r; };
  const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
  const uid = e => db.prepare('SELECT id FROM users WHERE email=?').get(e).id;

  console.log('Security headers + homepage');
  let r = await f('/', {}, 'z'); const home = await r.text(); const csp = r.headers.get('content-security-policy') || '';
  ok(/default-src 'self'/.test(csp) && /script-src 'self'(;|$)/.test(csp) && /frame-ancestors 'none'/.test(csp), 'CSP header: self only, no inline scripts');
  ok(!/<script(?![^>]*src=)/i.test(home) && !/\son[a-z]+="/i.test(home) && !/https?:\/\/(cdn|unpkg|fonts\.googleapis)/i.test(home), 'homepage: no inline scripts/handlers, no CDN');
  ok(['$7', '$16', '$30', '$50'].every(x => home.includes(x)) && /FAQ|Frequently/i.test(home) && home.includes('/landing.js'), 'homepage: 4 plans, FAQ, reveal script');
  ok(home.includes('demo_tz') && home.includes('prefers-reduced-motion') === false, 'homepage tz demo present');
  const css = await (await f('/style.css', {}, 'z')).text();
  ok(/prefers-reduced-motion/.test(css) && /max-width:\s*760px/.test(css), 'CSS: reduced motion + mobile breakpoints');

  console.log('Registration toggle');
  await f('/signup', form({ email: 'user1@example.com', password: 'password123' }), 'a');
  await f('/signup', form({ email: 'user2@example.com', password: 'password123' }), 'b');
  const u1 = uid('user1@example.com'), u2 = uid('user2@example.com');
  S.set('registration_open', '0');
  ok((await (await f('/signup', {}, 'n')).text()).includes('Registration is currently closed'), 'closed: signup page says "Registration is currently closed"');
  ok((await f('/signup', form({ email: 'user9@example.com', password: 'password123' }), 'n')).status === 403 && !db.prepare("SELECT 1 FROM users WHERE email='user9@example.com'").get(), 'closed: POST signup rejected (403), no user created');
  S.set('registration_open', '1');

  console.log('Activity log');
  r = await f('/login', { ...form({ email: 'user1@example.com', password: 'password123' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'cf-ipcountry': 'BD', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' } }, 'a');
  const ev = db.prepare('SELECT * FROM login_events WHERE user_id=? ORDER BY id DESC').get(u1);
  ok(ev && ev.country === 'BD' && ev.ua === 'Chrome · Windows' && db.prepare('SELECT last_country FROM users WHERE id=?').get(u1).last_country === 'BD', 'login recorded with IP, country, device');
  db.prepare('INSERT INTO login_events(user_id,kind,ts,ip,country,ua) VALUES(?,?,?,?,?,?)').run(u1, 'login', Date.now() - 91 * 864e5, '1.1.1.1', 'US', 'x');
  ok(activity.prune() === 1, 'activity older than 90 days pruned');

  console.log('Owner console');
  const OP = require('../src/owner').adminPath();
  await f(OP + '/setup', form({ username: 'boss', password: 'correct-horse-9' }), 'o');
  ok((await f(OP + '/login', form({ username: 'boss', password: 'correct-horse-9' }), 'o')).status === 302, 'owner logs in');
  const pages = {};
  for (const p of ['', '/users', '/revenue', '/activity', '/audit', '/bans', '/email', '/settings', `/users/${u1}`]) { const x = await f(OP + p, {}, 'o'); pages[p] = await x.text(); ok(x.status === 200 && !/<script(?![^>]*src=)/i.test(pages[p]), `owner ${p || '/'} renders (no inline script)`); }
  ok(/stored hashed/i.test(pages['/users']) && pages['/users'].includes('user1@example.com') && !/\$2[aby]\$/.test(pages['/users']), 'users table: masked password with "stored hashed", no hash leaked');
  ok(pages['/activity'].includes('BD'), 'activity page shows country');
  const nf = await (await f('/nope-404', {}, 'z')).text();
  for (const p of ['/revenue', '/activity', '/audit', '/audit.csv', '/email', '/email/status', '/bans', '/panel.js']) { const x = await f(OP + p, {}, 'z'); ok(x.status === 404 && (await x.text()) === nf, `logged-out ${p} -> identical 404`); }

  console.log('Ledger, grant, revoke, countdown, revenue');
  const a = P.recordPayment({ userId: u1, plan: 'monthly', externalId: 'ext-1', source: 'stripe' });
  const b = P.recordPayment({ userId: u1, plan: 'monthly', externalId: 'ext-1', source: 'stripe' });
  ok(!a.duplicate && b.duplicate && db.prepare('SELECT COUNT(*) c FROM payments_ledger WHERE user_id=?').get(u1).c === 1, 'recordPayment idempotent on externalId');
  const c = P.recordPayment({ userId: u1, plan: 'quarterly' });
  ok(c.start === a.end && c.end - a.end === 90 * 864e5, 'renewal stacks on top of the active period');
  ok(Object.keys(P.PLANS).length === 4 && P.PLANS.monthly.usd === 7 && P.PLANS.quarterly.usd === 16 && P.PLANS.semiannual.usd === 30 && P.PLANS.yearly.usd === 50, 'plans: $7 / $16 / $30 / $50');
  ok(P.stats().mrr > 0, 'MRR computed');
  await f(`${OP}/users/${u2}/grant`, form({ plan: 'yearly', amount: '50' }), 'o');
  ok(P.isPremium(db.prepare('SELECT * FROM users WHERE id=?').get(u2)) && db.prepare("SELECT 1 FROM audit_log WHERE action='plan.grant' AND target=?").get('user#' + u2), 'owner grant -> premium + audit');
  const up = await (await f(OP + '/users', {}, 'o')).text();
  ok(/class="cd[^"]*" data-until="\d+"/.test(up), 'users table: live expiry countdown');
  const rev = await (await f(OP + '/revenue', {}, 'o')).text();
  ok(rev.includes('<svg') && rev.includes('MRR') && rev.includes('$50'), 'revenue page: SVG chart, MRR, ledger');
  await f(`${OP}/users/${u2}/revoke`, { method: 'POST' }, 'o');
  ok(!P.isPremium(db.prepare('SELECT * FROM users WHERE id=?').get(u2)) && db.prepare("SELECT status FROM subscriptions WHERE user_id=?").get(u2).status === 'revoked' && db.prepare("SELECT 1 FROM plan_log WHERE user_id=? AND action='revoke'").get(u2), 'revoke ends Premium, logged in plan history');

  console.log('Ban with reason + history');
  await f(`${OP}/users/${u2}/ban`, form({ reason: 'Spam links' }), 'o');
  r = await f('/login', form({ email: 'user2@example.com', password: 'password123' }), 'b2');
  ok(r.headers.get('location') === '/login' && (await (await f('/login', {}, 'b2')).text()).includes('suspended'), 'banned user cannot log in (suspended message)');
  await f(`${OP}/users/${u2}/unban`, form({ reason: 'Appeal accepted' }), 'o');
  const bans = db.prepare('SELECT action,reason FROM ban_log WHERE user_id=? ORDER BY id').all(u2);
  ok(bans.length === 2 && bans[0].reason === 'Spam links' && bans[1].action === 'unban', 'ban history keeps both entries with reasons');
  ok((await (await f(OP + '/bans', {}, 'o')).text()).includes('Spam links'), 'ban history page');

  console.log('Multi-account + push toggle + retry');
  const acc1 = accounts.save(u1, 'threads', { extId: 'T1', username: 'brand_one', token: 'tk1', expiresIn: 5184000 });
  const acc2 = accounts.save(u1, 'threads', { extId: 'T2', username: 'brand_two', token: 'tk2', expiresIn: 5184000 });
  accounts.save(u1, 'x', { extId: 'X1', username: 'x_one', token: 'x1' }); accounts.save(u1, 'x', { extId: 'X2', username: 'x_two', token: 'x2' });
  const con = await (await f('/connect', {}, 'a')).text();
  ok(['brand_one', 'brand_two', 'x_one', 'x_two', 'Add another account'].every(s => con.includes(s)), 'accounts page lists multiple Threads + X accounts');
  const comp = await (await f('/compose', {}, 'a')).text();
  ok(comp.includes(`value="${acc1}"`) && comp.includes(`value="${acc2}"`) && /Reconnect to enable posting/.test(comp) && comp.includes('id="pv"') && comp.includes('/compose.js'), 'composer: target-account picker, preview, pickers');
  const when = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 16);
  await f('/compose', form([['text', 'hello both'], ['media_type', 'TEXT'], ['smode', 'exact'], ['when', when], ['tz', 'Asia/Kolkata'], ['accounts', acc1], ['accounts', acc2]].reduce((o, [k, v]) => (o.append(k, v), o), new URLSearchParams())), 'a');
  const mine = db.prepare("SELECT * FROM posts WHERE user_id=? AND text='hello both'").all(u1);
  ok(mine.length === 2 && new Set(mine.map(p => p.account_id)).size === 2, 'one post per selected account');
  ok(db.prepare('SELECT tz FROM users WHERE id=?').get(u1).tz === 'Asia/Kolkata', 'chosen timezone saved per user');
  await f('/compose', form({ accounts: acc1, text: 'bad time', media_type: 'TEXT', smode: 'exact', when: '7:99 PM' }), 'a');
  ok(!db.prepare("SELECT 1 FROM posts WHERE text='bad time'").get(), 'invalid time rejected');
  await f(`/connect/account/${acc2}/disconnect`, { method: 'POST' }, 'a');
  ok(!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(acc2) && db.prepare('SELECT 1 FROM accounts WHERE id=?').get(acc1), 'per-account disconnect keeps the others');
  db.prepare('DELETE FROM posts').run();
  const mk = () => db.prepare("INSERT INTO posts(user_id,account_id,text,media_type,media_urls,scheduled_at,status,attempts,created) VALUES(?,?,?,?,?,?,?,?,?)").run(u1, acc1, 'due', 'TEXT', '[]', Date.now() - 1000, 'scheduled', 0, Date.now()).lastInsertRowid;
  let pid = mk();
  await f(`${OP}/users/${u1}/push`, { method: 'POST' }, 'o');
  await W.tick();
  ok(db.prepare('SELECT status FROM posts WHERE id=?').get(pid).status === 'scheduled' && pubs === 0, 'Push off: worker skips the user');
  await f(`${OP}/users/${u1}/push`, { method: 'POST' }, 'o');
  ok(W.BACKOFF_MIN.join() === '2,5,15,60' && W.MAX_ATTEMPTS === 4, 'backoff 2/5/15/60 min, max 4 tries');
  ok(W.classify(Object.assign(new Error('x'), { status: 401 })) === 'auth' && W.classify(Object.assign(new Error('x'), { status: 400 })) === 'permanent' && W.classify(new Error('ETIMEDOUT')) === 'retry', 'error classification: auth / permanent / retry');
  fail = new Error('API down'); await W.tick();
  let p = db.prepare('SELECT * FROM posts WHERE id=?').get(pid);
  ok(p.status === 'scheduled' && p.attempts === 1 && p.next_try - Date.now() > 100e3 && p.next_try - Date.now() <= 120e3, 'temporary error: retry scheduled in 2 min');
  ok(/Retry 1\/4/.test(await (await f('/queue', {}, 'a')).text()), 'queue shows retry status');
  db.prepare('UPDATE posts SET next_try=0, attempts=3 WHERE id=?').run(pid); await W.tick();
  ok(db.prepare('SELECT status FROM posts WHERE id=?').get(pid).status === 'failed', 'gives up after 4 tries');
  pid = mk(); fail = Object.assign(new Error('Invalid parameter'), { status: 400 }); await W.tick();
  p = db.prepare('SELECT * FROM posts WHERE id=?').get(pid);
  ok(p.status === 'failed' && p.attempts === 1 && /Not retried/.test(p.error), 'permanent error not retried');
  pid = mk(); fail = Object.assign(new Error('HTTP 401'), { status: 401 }); await W.tick();
  ok(/Needs reconnect/.test(db.prepare('SELECT error FROM posts WHERE id=?').get(pid).error) && db.prepare('SELECT status FROM accounts WHERE id=?').get(acc1).status === 'reconnect', 'auth error -> "Needs reconnect"');
  fail = null;

  console.log('Email');
  ok(!mailer.status().configured && (await (await f(OP + '/email/status', {}, 'o')).json()).vars.SMTP_HOST === false, 'status: not configured, missing vars reported');
  ok(pages[''].includes('Email is not configured'), 'overview hint when email is not configured');
  ok((await mailer.notify(u1, 'post_deleted', mailer.T.postDeleted({ text: 'x' }))) === 'skipped', 'SMTP unset -> skipped and logged');
  Object.assign(process.env, { SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '587', SMTP_USER: 'owner@example.com', SMTP_PASS: 'abcd efgh ijkl mnop' });
  mailer.setTransport({ sendMail: async m => { sent.push(m); return { messageId: '1' }; } });
  const st = await (await f(OP + '/email/status', {}, 'o')).json();
  ok(st.configured && st.vars.SMTP_PASS === true && !JSON.stringify(st).includes('abcd') && !(await (await f(OP + '/email', {}, 'o')).text()).includes('abcd efgh'), 'status shows set/missing, never values');
  const tr = await (await f(OP + '/email/test', { ...form({ to: 'owner@example.com' }), headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' } }, 'o')).json();
  ok(tr.ok && sent.at(-1).to === 'owner@example.com' && sent.at(-1).from === 'owner@example.com', 'Send test email via (mocked) transport');
  const eh = pages['/email'];
  ok(eh.includes('https://myaccount.google.com/apppasswords') && eh.includes('https://myaccount.google.com/security') && eh.includes('data-copy-text="SMTP_HOST=smtp.gmail.com"') && /500 emails per day/.test(eh), 'email setup guide: links, copy chips, 500/day note');
  ok(/requireTLS: port !== 465/.test(fs.readFileSync(path.join(__dirname, '../src/mailer.js'), 'utf8')), '587 uses requireTLS, 465 uses secure');
  const d = db.prepare("INSERT INTO posts(user_id,text,scheduled_at,status,created) VALUES(?,?,?,?,?)").run(u1, 'to delete', Date.now() + 864e5, 'scheduled', Date.now()).lastInsertRowid;
  await f(`/posts/${d}/delete`, { method: 'POST' }, 'a'); await new Promise(r => setTimeout(r, 30));
  ok(sent.some(m => m.subject === 'Your post was deleted' && m.to === 'user1@example.com' && /<table|<div/.test(m.html)), 'post deleted -> HTML email');
  db.prepare('UPDATE users SET email_payment=0 WHERE id=?').run(u1);
  ok((await P.notifyPaymentFailed(u1, { plan: 'monthly', amount: 7, reason: 'Card declined' })) === 'opted_out', 'per-type opt-out respected');
  db.prepare('UPDATE users SET email_payment=1 WHERE id=?').run(u1);
  ok((await P.notifyPaymentFailed(u1, { plan: 'monthly', amount: 7, reason: 'Card declined' })) === 'sent' && sent.at(-1).subject === 'Payment failed', 'payment failed email');
  db.prepare("UPDATE users SET plan='monthly', plan_until=? WHERE id=?").run(Date.now() + 2 * 864e5, u2);
  await W.reminders(Date.now(), true);
  ok(sent.some(m => m.to === 'user2@example.com' && /3 days/.test(m.subject)), '3-day expiry reminder email');
  db.prepare("UPDATE users SET plan_until=? WHERE id=?").run(Date.now() - 1000, u2); await W.reminders(Date.now(), true);
  ok(sent.some(m => m.to === 'user2@example.com' && /expired/.test(m.subject)), 'expired email');
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']) delete process.env[k];

  console.log('Own OpenAI key');
  const KEY = 'sk-test' + 'A'.repeat(30) + 'wxyz';
  await f('/settings/openai', form({ key: KEY }), 'a');
  const enc = db.prepare('SELECT openai_key_enc FROM users WHERE id=?').get(u1).openai_key_enc;
  ok(enc && !enc.includes(KEY), 'user key stored encrypted');
  const sp = await (await f('/settings', {}, 'a')).text();
  ok(!sp.includes(KEY) && sp.includes('wxyz') && /type="password"/.test(sp), 'settings shows masked key only');
  ok(ai.withKey(KEY, () => ai.keyNow()) === KEY && ai.withKey(null, () => ai.keyNow()) !== KEY, 'per-request key with env fallback');
  ok((await f('/settings/openai', form({ key: 'nope' }), 'a')).status === 302 && db.prepare('SELECT openai_key_enc FROM users WHERE id=?').get(u1).openai_key_enc === enc, 'invalid key rejected');

  console.log('Settings + theme + timezone');
  ok(['Profile', 'Appearance', 'Posting defaults', 'Notifications', 'savebar', 'email_post_deleted', 'email_expiry', 'email_payment'].every(s => sp.includes(s)), 'settings: left nav, sticky save bar, email opt-outs');
  r = await f('/account/appearance', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ mode: 'light' }) }, 'a');
  ok(r.status === 200 && db.prepare('SELECT mode FROM users WHERE id=?').get(u1).mode === 'light', 'instant theme change via fetch');
  ok((await f('/account/tz', form({ tz: 'Not/AZone' }), 'a')).status === 400, 'invalid timezone rejected');

  console.log('Audit log');
  const all = audit.query({ days: 30, limit: 1000 });
  ok(['user.signup', 'user.login', 'owner.setup', 'owner.login', 'plan.grant', 'plan.revoke', 'user.ban', 'user.unban', 'user.push', 'post.delete', 'account.disconnect', 'email.test', 'settings.openai_key'].every(x => all.rows.some(r => r.action === x)), 'audit covers user + owner actions');
  const pg = await (await f(OP + '/audit?who=owner', {}, 'o')).text();
  const tb = pg.slice(pg.indexOf('<tbody>'));
  ok(tb.includes('user.ban') && !tb.includes('settings.openai_key') && pg.includes('class="pager') === pg.includes('class="pager'), 'audit filter by actor');
  for (let i = 0; i < 60; i++) audit.audit(null, { type: 'system', name: 'test' }, 'test.bulk', 'n' + i);
  const p1 = await (await f(OP + '/audit?action=test.bulk', {}, 'o')).text(), p2 = await (await f(OP + '/audit?action=test.bulk&page=2', {}, 'o')).text();
  const cnt = t => (t.slice(t.indexOf('<tbody>')).match(/>test\.bulk</g) || []).length;
  ok(cnt(p1) === 50 && cnt(p2) === 10, 'audit paginated (50 per page)');
  const csvR = await f(OP + '/audit.csv?days=30', {}, 'o'); const csv = await csvR.text();
  ok(/text\/csv/.test(csvR.headers.get('content-type')) && csv.startsWith('time_utc,actor_type,actor,action') && csv.includes('user.ban'), 'audit CSV export');
  ok(!/sk-test/.test(csv) && !/abcd efgh/.test(csv), 'no secrets in audit log');

  console.log('Multi-platform scheduling (Threads / X / Reddit, mocked APIs)');
  {
    const xapi = require('../src/platforms/x'), rd = require('../src/platforms/reddit');
    S.set('free_limit', '100000');
    const xw = accounts.save(u1, 'x', { extId: 'XW', username: 'x_writer', token: 'xw', refresh: 'xr', expiresIn: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' });
    const rw = accounts.save(u1, 'reddit', { extId: 'RW', username: 'red_writer', token: 'rw', refresh: 'rr', expiresIn: 86400, scope: 'identity read submit' });
    const xro = accounts.get(u1, 'x').id; // x_one: connected read-only earlier
    ok(accounts.canPost(accounts.get(u1, 'x', xw)) && accounts.canPost(accounts.get(u1, 'reddit', rw)) && !accounts.canPost(accounts.get(u1, 'x', xro)), 'write scope detection (tweet.write / submit)');
    ok(/tweet\.write/.test(decodeURIComponent(xapi.authorizeUrl({ clientId: 'c', redirect: 'r', state: 's', challenge: 'h' }))) && /scope=identity(\+|%20)read(\+|%20)submit/.test(rd.authorizeUrl({ clientId: 'c', redirect: 'r', state: 's' })) && /duration=permanent/.test(rd.authorizeUrl({ clientId: 'c', redirect: 'r', state: 's' })), 'OAuth asks for tweet.write and Reddit submit (permanent)');
    const cp = await (await f('/compose', {}, 'a')).text();
    ok(cp.includes('id="pt-chips"') && cp.includes('id="pt-open"') && /Threads · 1 account/.test(cp) && !/<div class="pcards">[\s\S]*<\/div>/.test(cp.slice(0, cp.indexOf('id="ptm"'))), 'composer: compact "Post to" summary chips + Choose/Edit button (platforms not inline)');
    ok(/id="ptm" hidden/.test(cp) && /role="dialog" aria-modal="true" aria-labelledby="ptm-h"/.test(cp) && ['threads', 'x', 'reddit'].every(pl => cp.includes(`class="pcard" data-plat="${pl}"`)) && cp.includes('id="ptm-allplat"') && cp.includes('id="ptm-allacc"') && (cp.match(/class="pm-pall"/g) || []).length === 3, 'modal: platform cards, select-all platforms, select-all accounts + per-platform select-all, aria-modal');
    ok(/<input type="hidden" name="accounts" value="\d+" data-plat="threads">/.test(cp) && !/class="pm-acc"[^>]*name=/.test(cp) && cp.includes('id="subreddit"') && /id="redditbox" class="redditbox" hidden/.test(cp) && /Reconnect to enable posting/.test(cp), 'applied selection lives in hidden inputs; modal boxes are not submitted; Reddit fields hidden until Reddit applied; reconnect prompt');
    ok(!/<script(?![^>]*src=)/i.test(cp) && !/\son[a-z]+="/i.test(cp), 'composer still has no inline scripts/handlers');
    ok(/Reconnect to enable posting/.test(await (await f('/connect', {}, 'a')).text()), 'accounts page: read-only account shows "Reconnect to enable posting"');
    const at = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 16);
    const send = async (pairs) => { const q = new URLSearchParams(); for (const [k, v] of Object.entries({ media_type: 'TEXT', smode: 'exact', when: at, tz: 'Asia/Dhaka' })) q.append(k, v); for (const [k, v] of pairs) q.append(k, v);
      const r = await f('/compose', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: q.toString() }, 'a'); const loc = r.headers.get('location');
      return { loc, page: loc === '/compose' ? await (await f('/compose', {}, 'a')).text() : '' }; };
    const rows = t => db.prepare('SELECT * FROM posts WHERE user_id=? AND text=? ORDER BY id').all(u1, t);
    let res = await send([['text', 'threads only'], ['accounts', acc1]]);
    ok(res.loc === '/queue' && rows('threads only').length === 1 && rows('threads only')[0].platform === 'threads', 'Threads only -> 1 Threads row');
    res = await send([['text', 'x only'], ['accounts', xw]]);
    ok(res.loc === '/queue' && rows('x only').length === 1 && rows('x only')[0].platform === 'x' && rows('x only')[0].account_id === xw, 'X only -> 1 X row');
    res = await send([['text', 'All three\nbody line'], ['accounts', acc1], ['accounts', xw], ['accounts', rw], ['subreddit', 'r/socialmedia'], ['reddit_kind', 'self']]);
    const all3 = rows('All three\nbody line');
    ok(res.loc === '/queue' && all3.length === 3 && ['threads', 'x', 'reddit'].every(pl => all3.some(r => r.platform === pl)) && new Set(all3.map(r => r.target_group)).size === 1, 'all three -> 3 rows (one per platform) in one group');
    ok(all3.find(r => r.platform === 'reddit').subreddit === 'socialmedia' && all3.filter(r => r.platform !== 'reddit').every(r => !r.subreddit), 'Reddit row stores the subreddit (r/ prefix stripped)');
    res = await send([['text', 'nothing ticked']]);
    ok(!rows('nothing ticked').length && /Choose at least one platform/.test(res.page), 'no target -> blocked with a clear message');
    res = await send([['text', 'no sub'], ['accounts', rw]]);
    ok(!rows('no sub').length && /Subreddit is required/.test(res.page), 'Reddit without subreddit -> blocked');
    res = await send([['text', 'bad sub'], ['accounts', rw], ['subreddit', 'no spaces allowed']]);
    ok(!rows('bad sub').length && /Subreddit name is not valid/.test(res.page), 'invalid subreddit name rejected');
    const long = 'L'.repeat(300);
    res = await send([['text', long], ['accounts', acc1], ['accounts', xw]]);
    ok(!rows(long).length && /Too long for X: 300 characters/.test(res.page), 'X 280 limit blocks scheduling (no partial rows)');
    res = await send([['text', long], ['accounts', acc1]]);
    ok(rows(long).length === 1, 'same 300-char text is fine for Threads only (500)');
    const tlong = 'T'.repeat(301) + '\nbody';
    res = await send([['text', tlong], ['accounts', rw], ['subreddit', 'test']]);
    ok(!rows(tlong).length && /Reddit title is 301 characters/.test(res.page), 'Reddit title over 300 blocked');
    res = await send([['text', 'read only x'], ['accounts', xro]]);
    ok(!rows('read only x').length && /Reconnect X @x_one to enable posting/.test(res.page), 'read-only X account cannot be targeted');
    res = await send([['text', 'link post\nbody'], ['accounts', rw], ['subreddit', 'test'], ['reddit_kind', 'link']]);
    ok(!rows('link post\nbody').length && /link post needs the Link field/.test(res.page), 'Reddit link post requires a link');

    // worker publishes each row on its own platform
    const xc = [], rc = []; const ox = { post: xapi.post, up: xapi.uploadMedia }, orr = rd.submit;
    xapi.post = async (tk, o) => { xc.push({ tk, ...o }); return { id: 'tw' + xc.length }; }; xapi.uploadMedia = async () => 'media1';
    rd.submit = async (tk, o) => { rc.push({ tk, ...o }); return { id: 't3_abc', url: 'https://www.reddit.com/r/socialmedia/comments/abc/' }; };
    pubs = 0; fail = null;
    db.prepare("UPDATE posts SET scheduled_at=? WHERE user_id=? AND status='scheduled' AND text IN ('All three\nbody line','x only')").run(Date.now() - 1000, u1);
    db.prepare("UPDATE posts SET status='canceled' WHERE user_id=? AND status='scheduled' AND text NOT IN ('All three\nbody line','x only')").run(u1);
    await W.tick();
    const after = rows('All three\nbody line');
    ok(after.every(r => r.status === 'published' && r.ext_id), 'worker published all 3 platform rows');
    ok(xc.length === 2 && xc.every(c => c.tk === 'xw' && c.text.length <= 280) && xc.some(c => c.text === 'All three\nbody line'), 'X: POST /2/tweets called with the user token and text');
    ok(rc.length === 1 && rc[0].sr === 'socialmedia' && rc[0].title === 'All three' && rc[0].text === 'body line' && rc[0].kind === 'self', 'Reddit: /api/submit with subreddit, first-line title, self text');
    ok(pubs === 1 && after.find(r => r.platform === 'x').permalink === 'https://x.com/x_writer/status/' + after.find(r => r.platform === 'x').ext_id, 'Threads published once; X permalink stored');
    ok(W.redditParts({ text: 'T\nB', link: 'https://e.com', reddit_kind: 'link', disclosure: 0 }).kind === 'link' && W.redditParts({ text: 'T\nB', link: 'https://e.com', reddit_kind: 'self', disclosure: 0 }).body === 'B\n\nhttps://e.com', 'Reddit link post vs self post body');
    // X media upload + link reply
    db.prepare("INSERT INTO posts(user_id,platform,account_id,text,media_type,media_urls,link,link_reply,disclosure,scheduled_at,status,attempts,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(u1, 'x', xw, 'with image', 'IMAGE', JSON.stringify(['https://e.com/a.jpg']), 'https://e.com/l', 1, 1, Date.now() - 1000, 'scheduled', 0, Date.now());
    xc.length = 0; await W.tick();
    ok(xc.length === 2 && xc[0].mediaIds[0] === 'media1' && xc[1].replyTo === 'tw1' && /#ad \/ affiliate/.test(xc[1].text), 'X: image uploaded via v2 media + link as first reply');
    // per-platform auth failure -> only that account flagged
    xapi.post = async () => { throw Object.assign(new Error('HTTP 401: Unauthorized'), { status: 401 }); };
    db.prepare("INSERT INTO posts(user_id,platform,account_id,text,media_type,media_urls,scheduled_at,status,attempts,created) VALUES(?,?,?,?,?,?,?,?,?,?)").run(u1, 'x', xw, 'x auth fail', 'TEXT', '[]', Date.now() - 1000, 'scheduled', 0, Date.now());
    accounts.markStatus(u1, 'threads', 'ok', acc1); accounts.markStatus(u1, 'x', 'ok', xw); db.prepare("UPDATE accounts SET refresh_enc=NULL WHERE id=?").run(xw);
    await W.tick();
    const xf = rows('x auth fail')[0];
    ok(xf.status === 'failed' && /^Needs reconnect/.test(xf.error) && accounts.get(u1, 'x', xw).status === 'reconnect' && accounts.get(u1, 'threads', acc1).status === 'ok', 'X 401 -> that X account needs reconnect, Threads untouched');
    // retry applies per platform
    xapi.post = async () => { throw new Error('ETIMEDOUT'); }; accounts.markStatus(u1, 'x', 'ok', xw);
    db.prepare("INSERT INTO posts(user_id,platform,account_id,text,media_type,media_urls,scheduled_at,status,attempts,created) VALUES(?,?,?,?,?,?,?,?,?,?)").run(u1, 'x', xw, 'x flaky', 'TEXT', '[]', Date.now() - 1000, 'scheduled', 0, Date.now());
    await W.tick(); const xr = rows('x flaky')[0];
    ok(xr.status === 'scheduled' && xr.attempts === 1 && xr.next_try > Date.now(), 'X temporary error -> auto-retry backoff');
    db.prepare("UPDATE posts SET status='canceled' WHERE text='x flaky'").run();
    xapi.post = ox.post; xapi.uploadMedia = ox.up; rd.submit = orr;
    const ownerStats = await (await f(OP, {}, 'o')).text();
    ok(/Reddit/.test(ownerStats) && /X/.test(ownerStats), 'owner panel still renders per-platform stats');
    S.set('free_limit', '10');
  }

  console.log('Platform setup, plan requests, timezone, pricing');
  {
    const ov = await (await f(OP, {}, 'o')).text();
    const sc = ov.slice(ov.indexOf('id="platform-setup"'), ov.indexOf('id="plan-requests"'));
    ok(sc.includes('Platform setup') && /<code>REDDIT_CLIENT_ID<\/code>/.test(sc) && /<code>REDDIT_CLIENT_SECRET<\/code>/.test(sc) && /\/oauth\/threads\/callback/.test(sc) && /\/oauth\/x\/callback/.test(sc) && /\/oauth\/reddit\/callback/.test(sc), 'owner Platform setup card lists missing Railway Variables + callback URLs');
    ok(!/<input|<textarea|<select/i.test(sc) && /https/.test(sc), 'Platform setup card is read-only (no inputs) and warns Threads needs https');
    P.recordIntent(u1, 'semiannual');
    const ov2 = await (await f(OP, {}, 'o')).text();
    ok(/id="plan-requests"/.test(ov2) && ov2.includes('user1@example.com') && /6 months/.test(ov2.slice(ov2.indexOf('id="plan-requests"'))), 'owner sees pending plan requests');
    const iid = db.prepare("SELECT id FROM plan_intents WHERE user_id=? AND status='pending'").get(u1).id;
    await f(OP + `/intents/${iid}/dismiss`, form({}), 'o'); ok(db.prepare('SELECT status FROM plan_intents WHERE id=?').get(iid).status === 'dismissed', 'owner can dismiss a plan request');
    P.recordIntent(u1, 'monthly'); P.recordPayment({ userId: u1, plan: 'monthly', amount: 0 }); ok(!P.pendingIntent(u1), 'granting a plan clears the pending request');
    const cp = await (await f('/compose', {}, 'a')).text();
    ok(/data-tzp data-cur="[^"]*" data-save="1"/.test(cp), 'compose time zone picker auto-saves detected zone');
    await f('/account/tz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tz: 'Asia/Dhaka', auto: 1 }) }, 'a');
    const uu = db.prepare("SELECT tz, tz_auto FROM users WHERE email='user1@example.com'").get();
    ok(uu.tz === 'Asia/Dhaka' && uu.tz_auto === 1, 'auto-detected zone saved to profile');
    ok(/Detected: /.test(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')) && /resolvedOptions\(\)\.timeZone/.test(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')), 'client shows "Detected: <zone>" from Intl');
    const home = await (await f('/', {}, 'z')).text();
    ok((home.match(/href="\/signup\?plan=(monthly|quarterly|semiannual|yearly)"/g) || []).length === 4, 'pricing plans link to signup for visitors');
    ok(/name="plan" value="yearly"/.test(await (await f('/signup?plan=yearly', {}, 'z')).text()), 'signup carries the chosen plan through to billing');
  }

  console.log('Admin path never public');
  for (const u of ['/', '/signup', '/login', '/app', '/compose', '/settings', '/billing', '/connect', '/style.css', '/app.js', '/landing.js', '/compose.js', '/settings.js']) {
    const t = await (await f(u, {}, 'a')).text(); ok(!t.includes(OP) && !/owner-[0-9a-f]{6}/.test(t), `${u} does not reveal the admin path`); }

  srv.close(); console.log(`\nALL ${pass} FEATURE CHECKS PASSED`); process.exit(0);
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
