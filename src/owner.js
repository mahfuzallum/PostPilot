// Hidden owner admin. Mounted at ADMIN_PATH (env) or a random /owner-<hex> path generated once and
// saved in the data directory. Nothing links here. Unknown or unauthenticated sub-paths fall through
// to the normal 404 page. NO credential fields: API keys live only in server environment variables.
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const S = require('./settings');
const P = require('./payments');
const { h } = require('./views');
const { flagLabel } = require('./flags');
const { sessionSecret } = require('./crypto');
const { audit } = require('./audit');
const mailer = require('./mailer');
audit.query = require('./audit').query;

db.exec(`CREATE TABLE IF NOT EXISTS owners (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, created INTEGER);`);

function adminPath() {
  let p = process.env.ADMIN_PATH;
  if (!p) {
    const f = path.join(DATA_DIR, '.admin_path');
    if (fs.existsSync(f)) p = fs.readFileSync(f, 'utf8').trim();
    else { p = '/owner-' + crypto.randomBytes(12).toString('hex'); fs.writeFileSync(f, p, { mode: 0o600 }); }
  }
  p = '/' + p.replace(/^\/+|\/+$/g, '');
  if (p.length < 8) throw new Error('ADMIN_PATH must be at least 8 characters');
  return p;
}

// login rate limit: 5 failed attempts per 15 minutes per IP
const WINDOW = 15 * 60e3, MAX = 5, fails = new Map();
const limited = ip => { const a = (fails.get(ip) || []).filter(t => t > Date.now() - WINDOW); fails.set(ip, a); return a.length >= MAX; };
const fail = ip => fails.set(ip, [...(fails.get(ip) || []), Date.now()]);

const PLATS = ['threads', 'reddit', 'x'];
const fmt = ms => ms ? new Date(ms).toLocaleString('en-GB', { timeZone: S.get('default_tz') || 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }) : '–';
const ownerCount = () => db.prepare('SELECT COUNT(*) c FROM owners').get().c;

module.exports = function mount(app, { SqliteStore }) {
  const base = adminPath();
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  r.use(session({ store: new SqliteStore(), secret: sessionSecret(), resave: false, saveUninitialized: false, name: 'pp.owner',
    cookie: { path: base, httpOnly: true, sameSite: 'strict', secure: 'auto', maxAge: 12 * 3600e3 } }));

  const NAV = [['', 'Overview', '◎'], ['/users', 'Users', '👥'], ['/activity', 'Activity', '⟲'], ['/revenue', 'Revenue', '$'], ['/bans', 'Ban history', '⛔'], ['/audit', 'Audit log', '☰'],
    ['/accounts', 'Accounts', '🔗'], ['/schedule', 'Schedules', '🗓'], ['/competitors', 'Top posts', '★'], ['/email', 'Email setup', '✉'], ['/settings', 'Settings', '⚙']];
  const page = (title, body, nav = true, cur = '') => `<!doctype html><html lang="en" data-mode="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${h(title)}</title><link rel="stylesheet" href="/style.css">${nav ? `<link rel="stylesheet" href="${base}/panel.css">` : ''}</head><body${nav ? ' class="op"' : ''}>
${nav ? `<aside class="op-side"><div class="op-brand"><i></i><div><b>${h(S.get('app_name'))}</b><span>Owner console</span></div></div>
<nav>${NAV.map(([p, l, ic]) => `<a href="${base}${p}" class="${cur === p ? 'on' : ''}"><span class="ic">${ic}</span>${l}</a>`).join('')}</nav>
<form method="post" action="${base}/logout" class="op-out"><button class="btn ghost sm" style="width:100%">Log out</button></form></aside>
<main class="op-main"><header class="op-top"><h1>${h(title.replace(/^Owner · /, ''))}</h1><span class="muted small">${new Date().toLocaleString('en-GB', { timeZone: S.get('default_tz'), dateStyle: 'full', timeStyle: 'short' })} · ${h(S.get('default_tz'))}</span></header>${body}</main>
<script src="${base}/panel.js"></script>` : `<main class="wrap" style="padding-top:24px">${body}</main>`}</body></html>`;
  const msg = req => req.session.msg ? (m => (delete req.session.msg, `<div class="alert ok">${h(m)}</div>`))(req.session.msg) : '';
  const authForm = (setup, err) => page(setup ? 'Owner setup' : 'Owner login', `<div class="card" style="max-width:420px;margin:40px auto">
   <h1 style="margin-top:0">${setup ? 'Create owner login' : 'Owner login'}</h1>${setup ? '<p class="muted small">One-time setup. This form disappears once an owner exists.</p>' : ''}
   ${err ? `<div class="alert err">${h(err)}</div>` : ''}
   <form method="post" action="${base}/${setup ? 'setup' : 'login'}"><label>Username</label><input name="username" required autocomplete="username" minlength="3">
   <label>Password</label><input name="password" type="password" required minlength="${setup ? 10 : 1}" autocomplete="${setup ? 'new-password' : 'current-password'}">
   <div style="margin-top:18px"><button class="btn" style="width:100%">${setup ? 'Create owner' : 'Log in'}</button></div></form></div>`, false);

  const hdr = res => res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
  r.get('/', (req, res, next) => {
    hdr(res);
    if (!ownerCount()) return res.send(authForm(true));
    if (!req.session.owner) return res.send(authForm(false));
    next();
  });
  r.post('/setup', (req, res) => {
    if (ownerCount()) return res.status(404).end(); // setup is one-time only
    const u = String(req.body.username || '').trim(), pw = String(req.body.password || '');
    if (u.length < 3 || pw.length < 10) return res.status(400).send(authForm(true, 'Username 3+ characters, password 10+ characters.'));
    const id = db.prepare('INSERT INTO owners(username,pw,created) VALUES(?,?,?)').run(u, bcrypt.hashSync(pw, 12), Date.now()).lastInsertRowid;
    audit(req, { type: 'owner', id, name: u }, 'owner.setup');
    req.session.regenerate(() => { req.session.owner = id; res.redirect(base); });
  });
  r.post('/login', (req, res) => {
    const ip = req.ip;
    if (limited(ip)) return res.status(429).send(authForm(false, 'Too many attempts. Try again in 15 minutes.'));
    const o = db.prepare('SELECT * FROM owners WHERE username=?').get(String(req.body.username || '').trim());
    if (!o || !bcrypt.compareSync(String(req.body.password || ''), o.pw)) { fail(ip); audit(req, { type: 'system', name: 'owner-login' }, 'owner.login_failed', String(req.body.username || '').slice(0, 60)); return res.status(401).send(authForm(false, 'Wrong username or password')); }
    fails.delete(ip); audit(req, { type: 'owner', id: o.id, name: o.username }, 'owner.login');
    req.session.regenerate(() => { req.session.owner = o.id; res.redirect(base); });
  });
  // everything below requires an owner session; otherwise -> generic 404 (fall through)
  r.use((req, res, next) => req.session.owner ? (hdr(res), next()) : next('router'));
  r.post('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('pp.owner', { path: base }); res.redirect(base); }));

  const who = req => { const o = db.prepare('SELECT username FROM owners WHERE id=?').get(req.session.owner); return { type: 'owner', id: req.session.owner, name: o ? o.username : 'owner' }; };
  const A = (req, action, target, detail) => audit(req, who(req), action, target, detail);
  const ago = ms => { if (!ms) return '–'; const d = Date.now() - ms; return d < 60e3 ? 'just now' : d < 3600e3 ? Math.floor(d / 60e3) + 'm ago' : d < 864e5 ? Math.floor(d / 3600e3) + 'h ago' : Math.floor(d / 864e5) + 'd ago'; };
  const usd = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const flag = c => flagLabel(c);
  const short = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: S.get('default_tz') || 'UTC' });
  const dIn = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '';
  const paidActive = u => u.plan !== 'free' && (u.plan_until || 0) > Date.now();
  // Extra status badges for temporary control (shown under the plan badge).
  const tempBadges = u => `${P.isPaused(u) ? `<span class="badge warn" title="Premium is off while paused">⏸ Paused ${u.paused_until ? 'until ' + short(u.paused_until) : 'indefinitely'}</span>` : ''}${P.hasTemp(u) ? `<span class="badge info" title="Premium is on temporarily, then reverts automatically">⏱ Temporary until ${short(u.temp_until)}</span>` : ''}`;
  const av = e => `<span class="av" style="--hue:${[...String(e)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}">${h(String(e || '?')[0].toUpperCase())}</span>`;
  const countdown = u => P.isPremium(u) ? `<span class="cd" data-until="${u.plan_until}">${fmt(u.plan_until)}</span>` : (u.plan !== 'free' && u.plan_until ? '<span class="cd exp">Expired</span>' : '<span class="muted small">Free</span>');
  const platsOf = id => db.prepare('SELECT platform, COUNT(*) n FROM accounts WHERE user_id=? GROUP BY platform').all(id);
  const platChips = id => platsOf(id).map(p => `<span class="chip ${p.platform}">${p.platform === 'x' ? 'X' : p.platform[0].toUpperCase() + p.platform.slice(1)}${p.n > 1 ? ' ×' + p.n : ''}</span>`).join(' ') || '<span class="muted small">none</span>';
  const card = (label, n, sub = '', tone = '') => `<div class="kpi ${tone}"><div class="l">${label}</div><div class="n">${n}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const pager = (url, total, pg, per) => { const pages = Math.max(1, Math.ceil(total / per)); return pages < 2 ? '' : `<div class="pager">${pg > 1 ? `<a class="btn ghost sm" href="${url}&page=${pg - 1}">← Prev</a>` : ''}<span class="muted small">Page ${pg} of ${pages} · ${total} rows</span>${pg < pages ? `<a class="btn ghost sm" href="${url}&page=${pg + 1}">Next →</a>` : ''}</div>`; };
  const qs = o => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  r.get('/panel.css', (req, res) => res.type('css').sendFile(path.join(__dirname, 'owner-panel.css')));
  r.get('/panel.js', (req, res) => res.type('js').sendFile(path.join(__dirname, 'owner-panel.js')));

  r.get('/', (req, res) => {
    const now = Date.now(), one = (sql, ...a) => db.prepare(sql).get(...a).c;
    const k = { total: one('SELECT COUNT(*) c FROM users'), d1: one('SELECT COUNT(*) c FROM users WHERE last_seen>?', now - 864e5), d7: one('SELECT COUNT(*) c FROM users WHERE last_seen>?', now - 7 * 864e5),
      prem: one("SELECT COUNT(*) c FROM users WHERE plan!='free' AND plan_until>?", now), exp: one("SELECT COUNT(*) c FROM users WHERE plan!='free' AND plan_until BETWEEN ? AND ?", now, now + 7 * 864e5),
      banned: one('SELECT COUNT(*) c FROM users WHERE disabled=1'), newW: one('SELECT COUNT(*) c FROM users WHERE created>?', now - 7 * 864e5) };
    const st = P.stats(now);
    const active = db.prepare('SELECT * FROM users WHERE last_seen>? ORDER BY last_seen DESC LIMIT 12').all(now - 7 * 864e5);
    const rows = PLATS.map(p => {
      const c = db.prepare(`SELECT SUM(status='published') pub, SUM(status='deleted') del, SUM(status='scheduled') q, SUM(status IN ('failed','missed')) bad, COALESCE(SUM(views),0) views FROM posts WHERE platform=?`).get(p);
      return `<tr><td><span class="chip ${p}">${p === 'x' ? 'X' : p}</span></td><td>${db.prepare('SELECT COUNT(*) c FROM accounts WHERE platform=?').get(p).c}</td><td>${c.pub || 0}</td><td>${(c.views || 0).toLocaleString()}</td><td>${c.del || 0}</td><td>${c.q || 0}</td><td>${c.bad || 0}</td></tr>`;
    }).join('');
    res.send(page('Owner · Overview', `${msg(req)}${mailer.configured() ? '' : `<div class="alert info">✉ Email is not configured, so users get no notification emails. <a href="${base}/email">Set up Gmail SMTP →</a></div>`}<div class="kpis">
      ${card('Total users', k.total, `+${k.newW} this week`)}${card('Active · 24h', k.d1, `${k.total ? Math.round(k.d1 / k.total * 100) : 0}% of users`, 'ok')}${card('Active · 7 days', k.d7, '', 'ok')}
      ${card('Premium', k.prem, `MRR ≈ ${usd(st.mrr)}`, 'pri')}${card('Expiring ≤ 7 days', k.exp, 'renewal window', k.exp ? 'warn' : '')}${card('Banned', k.banned, '', k.banned ? 'bad' : '')}</div>
    <div class="grid2"><section class="panel"><div class="ph"><h2>Active users</h2><a class="small" href="${base}/users">All users →</a></div><div class="tbl"><table><thead><tr><th>User</th><th>Plan</th><th>Last login</th><th>Country</th><th>Platforms</th></tr></thead><tbody>
      ${active.map(u => `<tr><td><a class="who" href="${base}/users/${u.id}">${av(u.email)}<span>${h(u.email)}<small>active ${ago(u.last_seen)}</small></span></a></td><td>${P.isPremium(u) ? `<span class="badge pri">${h(P.PLANS[u.plan] ? P.PLANS[u.plan].label : u.plan)}</span>` : '<span class="badge">Free</span>'}</td><td>${ago(u.last_login)}</td><td>${flag(u.last_country)}</td><td>${platChips(u.id)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No activity in the last 7 days</td></tr>'}</tbody></table></div></section>
    <section class="panel"><div class="ph"><h2>Revenue</h2><a class="small" href="${base}/revenue">Details →</a></div><div class="big">${usd(st.total)}</div><div class="muted small">all time · ${st.count} payments</div>${chart(st.months, 220)}</section></div>
    ${setupCard(req)}${intentsCard()}
    <section class="panel"><div class="ph"><h2>Platforms</h2></div><div class="tbl"><table><thead><tr><th>Platform</th><th>Accounts</th><th>Published</th><th>Views</th><th>Deleted by users</th><th>Queued</th><th>Failed/missed</th></tr></thead><tbody>${rows}</tbody></table></div></section>`, true, ''));
  });

  // Read-only platform setup status. Credentials are NEVER entered here: only Railway Variables.
  function setupCard(req) {
    const app = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : `${req.protocol}://${req.get('host')}`);
    const NAMES = { threads: 'Threads', x: 'X (Twitter)', reddit: 'Reddit' };
    const rows = S.setupStatus(app).map(s => `<div class="setup-row" data-setup="${s.platform}"><div class="setup-h"><b>${NAMES[s.platform]}</b>${s.ready ? '<span class="badge ok">Ready · users can connect</span>' : '<span class="badge bad">Not configured</span>'}</div>
      ${s.missing.length ? `<div class="small">Missing Railway Variables: ${s.missing.map(v => `<code>${v}</code>`).join(' ')}</div>` : '<div class="small muted">All required variables are set.</div>'}
      ${s.optionalMissing.length ? `<div class="small muted">Optional: ${s.optionalMissing.map(v => `<code>${v}</code>`).join(' ')} (needed if your X app is a confidential client)</div>` : ''}
      <div class="small">Callback URL to register: <code>${h(s.callback)}</code></div>
      ${s.platform === 'threads' ? `<div class="small ${s.httpsProblem ? 'warn-t' : 'muted'}">Threads (Meta) only accepts <b>https</b> callback URLs, so it will not work on http://localhost.</div>` : ''}</div>`).join('');
    return `<section class="panel setup-card" id="platform-setup"><div class="ph"><h2>Platform setup</h2><span class="small muted">read-only status</span></div>
      <p class="small muted">Users can only connect a platform after its variables are set in <b>Railway → your service → Variables</b> and the service is redeployed. Values are never shown or entered here.
      ${process.env.APP_URL ? '' : ' Tip: also set <code>APP_URL</code> (e.g. https://your-app.up.railway.app) so callback URLs are always correct.'}</p>${rows}</section>`;
  }
  function intentsCard() {
    const list = P.pendingIntents();
    return `<section class="panel" id="plan-requests"><div class="ph"><h2>Plan requests</h2><span class="small muted">${list.length} pending</span></div>
      <p class="small muted">Users who clicked "Choose plan" while online payment is off. Open the user and grant the plan after they pay you.</p>
      <div class="tbl"><table><thead><tr><th>User</th><th>Plan</th><th>Amount</th><th>Requested</th><th></th></tr></thead><tbody>
      ${list.map(i => `<tr><td><a href="${base}/users/${i.user_id}">${h(i.email)}</a></td><td>${h((P.PLANS[i.plan] || {}).label || i.plan)}</td><td>${usd(i.amount)}</td><td>${fmt(i.created)}</td><td class="row-act"><a class="btn sm" href="${base}/users/${i.user_id}/plan" data-modal>Grant…</a><form method="post" action="${base}/intents/${i.id}/dismiss"><button class="btn ghost sm">Dismiss</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No pending requests</td></tr>'}</tbody></table></div></section>`;
  }
  r.post('/intents/:id/dismiss', (req, res) => { P.resolveIntent(Number(req.params.id), 'dismissed'); A(req, 'billing.intent_dismissed', null, req.params.id); res.redirect(base + '#plan-requests'); });

  // inline SVG bar chart
  function chart(months, hgt = 240) {
    const W = 720, H = hgt, pad = 28, max = Math.max(1, ...months.map(m => m.s)), bw = (W - pad * 2) / months.length;
    return `<svg class="chart" viewBox="0 0 ${W} ${H + 24}" role="img" aria-label="Revenue by month"><defs><linearGradient id="bg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c5cff" stop-opacity=".55"/></linearGradient></defs>
    ${[0, .5, 1].map(f => `<line x1="${pad}" x2="${W - pad}" y1="${H - f * (H - 20)}" y2="${H - f * (H - 20)}" class="gl"/><text x="${pad - 6}" y="${H - f * (H - 20) + 4}" text-anchor="end" class="ax">${usd(Math.round(max * f))}</text>`).join('')}
    ${months.map((m, i) => { const bh = (m.s / max) * (H - 20), x = pad + i * bw + bw * .18; return `<rect x="${x}" y="${H - bh}" width="${bw * .64}" height="${Math.max(bh, m.s ? 2 : 0)}" rx="5" fill="url(#bg)"><title>${m.key}: ${usd(m.s)}</title></rect>${m.s ? `<text x="${x + bw * .32}" y="${H - bh - 6}" text-anchor="middle" class="val">${usd(m.s)}</text>` : ''}<text x="${x + bw * .32}" y="${H + 18}" text-anchor="middle" class="ax">${m.label}</text>`; }).join('')}</svg>`;
  }
  r.get('/accounts', (req, res) => {
    const list = db.prepare('SELECT a.id,a.platform,a.username,a.expires_at,a.created,u.email FROM accounts a JOIN users u ON u.id=a.user_id ORDER BY a.platform,u.email').all();
    res.send(page('Owner · Accounts', `${msg(req)}<div class="card tbl"><table><tr><th>User</th><th>Platform</th><th>Handle</th><th>Token expires</th><th></th></tr>
    ${list.map(a => `<tr><td>${h(a.email)}</td><td>${a.platform}</td><td>@${h(a.username || '')}</td><td>${fmt(a.expires_at)}</td><td><form method="post" action="${base}/accounts/${a.id}/disconnect"><button class="btn ghost sm">Disconnect</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet</td></tr>'}</table></div>`, true, '/accounts'));
  });
  r.post('/accounts/:id/disconnect', (req, res) => { A(req, 'account.disconnect', 'account#' + req.params.id, 'by owner'); db.prepare('DELETE FROM accounts WHERE id=?').run(req.params.id); req.session.msg = 'Account disconnected'; res.redirect(base + '/accounts'); });

  r.get('/schedule', (req, res) => {
    const list = db.prepare("SELECT p.*,u.email FROM posts p JOIN users u ON u.id=p.user_id WHERE p.status IN ('scheduled','failed','missed') ORDER BY p.scheduled_at LIMIT 300").all();
    const iso = ms => new Date(ms).toISOString().slice(0, 16);
    res.send(page('Owner · Schedules', `${msg(req)}<p class="small muted">Times are UTC in the editor.</p><div class="card tbl"><table><tr><th>User</th><th>Platform</th><th>Status</th><th>Text / time</th><th></th></tr>
    ${list.map(p => `<tr><td>${h(p.email)}</td><td>${p.platform}</td><td>${p.status}</td><td><form method="post" action="${base}/schedule/${p.id}" class="row"><textarea name="text" maxlength="500" style="min-height:60px">${h(p.text || '')}</textarea><input type="datetime-local" name="at" value="${iso(p.scheduled_at)}"><button class="btn sm">Save / reschedule</button></form></td>
    <td><form method="post" action="${base}/schedule/${p.id}/cancel"><button class="btn ghost sm">Cancel</button></form></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Queue is empty</td></tr>'}</table></div>`, true, '/schedule'));
  });
  r.post('/schedule/:id', (req, res) => {
    const at = Date.parse(String(req.body.at || '') + 'Z');
    db.prepare("UPDATE posts SET text=?, scheduled_at=?, status='scheduled', attempts=0, next_try=NULL, error=NULL WHERE id=? AND status IN ('scheduled','failed','missed')")
      .run(String(req.body.text || '').slice(0, 500), isNaN(at) ? Date.now() + 60e3 : at, req.params.id);
    A(req, 'post.edit', 'post#' + req.params.id, 'by owner'); req.session.msg = 'Post updated'; res.redirect(base + '/schedule');
  });
  r.post('/schedule/:id/cancel', (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
    const ch = db.prepare("UPDATE posts SET status='canceled' WHERE id=? AND status IN ('scheduled','failed','missed')").run(req.params.id).changes;
    if (ch && p) { A(req, 'post.delete', 'post#' + p.id, `by owner (user ${p.user_id})`); mailer.notify(p.user_id, 'post_deleted', mailer.T.postDeleted({ text: p.text, by: 'owner' })).catch(() => {}); }
    req.session.msg = 'Post removed from the queue'; res.redirect(base + '/schedule'); });

  r.get('/competitors', (req, res) => {
    const blocks = PLATS.map(p => {
      const top = db.prepare("SELECT p.text,p.views,p.likes,p.replies,p.permalink,p.media_type,u.email FROM posts p JOIN users u ON u.id=p.user_id WHERE p.platform=? AND p.status='published' ORDER BY COALESCE(p.views,0)+5*COALESCE(p.likes,0)+10*COALESCE(p.replies,0) DESC LIMIT 10").all(p);
      return `<h3>${p}</h3><div class="card tbl"><table><tr><th>Post</th><th>Type</th><th>Views</th><th>Likes</th><th>Replies</th><th>User</th></tr>${top.map(x => `<tr><td style="max-width:480px">${h((x.text || '').slice(0, 160))} ${x.permalink ? `<a href="${h(x.permalink)}" target="_blank" rel="noopener">↗</a>` : ''}</td><td>${h(x.media_type)}</td><td>${x.views ?? '–'}</td><td>${x.likes ?? '–'}</td><td>${x.replies ?? '–'}</td><td>${h(x.email)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No published posts yet</td></tr>'}</table></div>`;
    }).join('');
    res.send(page('Owner · Top posts', `<p class="muted">Top-performing posts across all accounts, ranked by views + likes + replies. Users run live X / Reddit / Threads competitor searches from their Competitors page.</p>${blocks}`, true, '/competitors'));
  });

  // Users: search, filter, sort, paginate (25/page), stats, CSV. Table on desktop, cards on narrow screens (CSS only).
  const userQuery = req => {
    const q = String(req.query.q || '').trim().slice(0, 100), f = ['premium', 'free', 'banned', 'expiring', 'paused'].includes(req.query.f) ? req.query.f : '';
    const now = Date.now(), w = [], a = [];
    if (q) { w.push('(u.email LIKE ? OR u.display_name LIKE ? OR u.last_ip LIKE ? OR u.last_country LIKE ?)'); a.push(...Array(4).fill(`%${q}%`)); }
    if (f === 'premium') w.push(P.premiumSQL(now));
    if (f === 'free') w.push('NOT ' + P.premiumSQL(now));
    if (f === 'paused') w.push('u.paused_at IS NOT NULL');
    if (f === 'banned') w.push('u.disabled=1');
    if (f === 'expiring') { w.push("u.plan!='free' AND u.plan_until BETWEEN ? AND ?"); a.push(now, now + 7 * 864e5); }
    return { q, f, where: w.length ? 'WHERE ' + w.join(' AND ') : '', args: a };
  };
  const SORTS = { user: 'lower(u.email)', plan: "(CASE WHEN {prem} THEN 1 ELSE 0 END)", expires: 'COALESCE(u.plan_until,0)', location: "COALESCE(u.last_country,'')", active: 'COALESCE(u.last_seen,0)', joined: 'u.created', status: 'u.disabled' };
  r.get('/users', (req, res) => {
    const { q, f, where, args } = userQuery(req), now = Date.now(), per = 25;
    const sort = SORTS[req.query.sort] ? req.query.sort : 'joined', dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const total = db.prepare(`SELECT COUNT(*) n FROM users u ${where}`).get(...args).n, pages = Math.max(1, Math.ceil(total / per)), pg = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
    const list = db.prepare(`SELECT u.* FROM users u ${where} ORDER BY ${SORTS[sort].replace('{prem}', P.premiumSQL(now))} ${dir}, u.id DESC LIMIT ? OFFSET ?`).all(...args, per, (pg - 1) * per);
    const st = db.prepare(`SELECT COUNT(*) total, SUM(last_seen>?) today, SUM(${P.premiumSQL(now)}) prem, SUM(disabled=1) banned, SUM(plan!='free' AND plan_until BETWEEN ? AND ?) exp, SUM(paused_at IS NOT NULL) paused FROM users u`).get(now - 864e5, now, now + 7 * 864e5);
    const qs = o => { const p = new URLSearchParams({ q, f, sort, dir: dir.toLowerCase(), page: pg, ...o }); for (const [k, v] of [...p]) if (!v || (k === 'page' && v === '1')) p.delete(k); const s = p.toString(); return `${base}/users${s ? '?' + s : ''}`; };
    const th = (key, label) => { const on = sort === key, nd = on && dir === 'DESC' ? 'asc' : 'desc'; return `<th aria-sort="${on ? (dir === 'ASC' ? 'ascending' : 'descending') : 'none'}"><a class="sort${on ? ' on' : ''}" href="${qs({ sort: key, dir: nd, page: 1 })}">${label}<i>${on ? (dir === 'ASC' ? '▲' : '▼') : '↕'}</i></a></th>`; };
    const chips = [['', 'All', st.total], ['premium', 'Premium', st.prem || 0], ['free', 'Free', (st.total || 0) - (st.prem || 0)], ['banned', 'Banned', st.banned || 0], ['expiring', 'Expiring soon', st.exp || 0], ['paused', 'Paused', st.paused || 0]];
    const row = u => { const prem = P.isPremium(u), name = u.display_name ? h(u.display_name) : h(u.email.split('@')[0]);
      return `<tr class="${u.disabled ? 'is-banned' : ''}">
      <td data-label="User"><a class="who" href="${base}/users/${u.id}">${av(u.display_name || u.email)}<span><b>${name}</b><small>${h(u.email)}</small><small>Joined ${fmt(u.created).split(',')[0]} · #${u.id}</small></span></a></td>
      <td data-label="Plan"><a class="plan-open" href="${base}/users/${u.id}/plan" data-modal title="Manage plan for ${h(u.email)}">${paidActive(u) ? `<span class="badge pri">★ ${h(planLabel(u.plan))}</span>` : P.hasTemp(u) ? '<span class="badge pri">★ Premium</span>' : '<span class="badge">Free</span>'}<span class="pen" aria-hidden="true">✎</span></a>${tempBadges(u) ? `<div class="u-sub u-badges">${tempBadges(u)}</div>` : ''}${prem && paidActive(u) ? `<div class="u-sub">${countdown(u)}</div>` : !prem && !P.isPaused(u) && u.plan !== 'free' && u.plan_until ? '<div class="u-sub"><span class="cd exp">Plan expired</span></div>' : ''}</td>
      <td data-label="Location"><span class="loc">${flag(u.last_country)}</span><div class="u-sub mono">${h(u.last_ip || '–')}</div></td>
      <td data-label="Last active"><span title="${fmt(u.last_seen)}">${ago(u.last_seen)}</span><div class="u-sub">${platChips(u.id)}</div></td>
      <td data-label="Password"><span class="mask" title="Stored hashed (bcrypt). It can never be shown.">••••••••</span></td>
      <td data-label="Status">${u.disabled ? `<span class="badge bad" title="${h(u.ban_reason || '')}">Banned</span>${u.ban_reason ? `<div class="u-sub clip" title="${h(u.ban_reason)}">${h(u.ban_reason)}</div>` : ''}` : '<span class="badge ok">Active</span>'}</td>
      <td data-label="Push"><form method="post" action="${base}/users/${u.id}/push"><button class="switch ${u.push_enabled === 0 ? '' : 'on'}" title="Automatic posting ${u.push_enabled === 0 ? 'off' : 'on'}" aria-label="Automatic posting for ${h(u.email)}" aria-pressed="${u.push_enabled !== 0}"><i></i></button></form></td>
      <td data-label="Actions" class="acts"><details class="pop"><summary class="btn ghost sm" aria-label="Actions for ${h(u.email)}">Manage ▾</summary><div class="popc">
        <a class="menu-link" href="${base}/users/${u.id}">👤 View profile &amp; history</a><a class="menu-link" href="${base}/activity?q=${encodeURIComponent(u.email)}">📈 View activity</a>
        <div class="menu-h">Plan</div>
        <a class="menu-link" href="${base}/users/${u.id}/plan" data-modal>⭐ ${paidActive(u) ? 'Change plan / expiry' : 'Grant plan'}…</a>
        ${P.isPaused(u) ? `<form method="post" action="${base}/users/${u.id}/resume"><button class="menu-link">▶ Resume plan now</button></form>` : `<a class="menu-link" href="${base}/users/${u.id}/plan?tab=pause" data-modal>⏸ Pause plan…</a>`}
        ${P.hasTemp(u) ? `<form method="post" action="${base}/users/${u.id}/temp-end" data-confirm="End temporary Premium for ${h(u.email)} now?"><button class="menu-link">⏹ End temporary Premium</button></form>` : `<a class="menu-link" href="${base}/users/${u.id}/plan?tab=temp" data-modal>⏱ Temporary Premium…</a>`}
        ${paidActive(u) ? `<form method="post" action="${base}/users/${u.id}/revoke" data-confirm="Revoke Premium for ${h(u.email)}?"><button class="menu-link danger">✕ Revoke plan</button></form>` : ''}
        <div class="menu-h">${u.disabled ? 'Unban' : 'Ban'}</div>
        <form method="post" action="${base}/users/${u.id}/${u.disabled ? 'unban' : 'ban'}"><input name="reason" maxlength="300" placeholder="${u.disabled ? 'Reason for unbanning (optional)' : 'Reason for banning'}" ${u.disabled ? '' : 'required'}><button class="btn ${u.disabled ? 'ghost' : 'danger'} sm" style="width:100%;margin-top:8px">${u.disabled ? 'Unban user' : 'Ban user'}</button></form>
      </div></details></td></tr>`; };
    const pager = pages > 1 ? `<nav class="pager" aria-label="Pages">${pg > 1 ? `<a class="btn ghost sm" href="${qs({ page: pg - 1 })}">← Prev</a>` : '<span class="btn ghost sm" aria-disabled="true">← Prev</span>'}<span class="muted small">Page ${pg} of ${pages}</span>${pg < pages ? `<a class="btn ghost sm" href="${qs({ page: pg + 1 })}">Next →</a>` : '<span class="btn ghost sm" aria-disabled="true">Next →</span>'}</nav>` : '';
    res.send(page('Owner · Users', `${msg(req)}
    <div class="stat-chips"><div class="schip"><span>Total users</span><b>${st.total || 0}</b></div><div class="schip ok"><span>Active today</span><b>${st.today || 0}</b></div><div class="schip pri"><span>Premium</span><b>${st.prem || 0}</b></div><div class="schip bad"><span>Banned</span><b>${st.banned || 0}</b></div></div>
    <section class="panel users-panel">
    <div class="u-tools"><form class="u-search" method="get" action="${base}/users" role="search"><input type="hidden" name="f" value="${h(f)}"><input type="hidden" name="sort" value="${sort}"><input type="hidden" name="dir" value="${dir.toLowerCase()}"><input type="search" name="q" value="${h(q)}" placeholder="Search name, email, IP or country" aria-label="Search users"><button class="btn sm">Search</button>${q ? `<a class="btn ghost sm" href="${qs({ q: '', page: 1 })}">Clear</a>` : ''}</form>
     <a class="btn ghost sm" href="${base}/users.csv?${new URLSearchParams({ q, f }).toString()}">⬇ Export CSV</a></div>
    <div class="u-seg" role="tablist" aria-label="Filter users">${chips.map(([v, l, n]) => `<a role="tab" aria-selected="${f === v}" class="${f === v ? 'on' : ''}" href="${qs({ f: v, page: 1 })}">${l}<em>${n}</em></a>`).join('')}</div>
    <p class="small muted u-count">${total ? `Showing ${(pg - 1) * per + 1}–${Math.min(total, pg * per)} of ${total}` : 'No users'}${q ? ` matching “${h(q)}”` : ''}</p>
    <div class="tbl utbl"><table class="users"><thead><tr>${th('user', 'User')}${th('plan', 'Plan')}${th('location', 'Location')}${th('active', 'Last active')}<th>Password</th>${th('status', 'Status')}<th>Push</th><th><span class="sr">Actions</span></th></tr></thead><tbody>
    ${list.map(row).join('') || '<tr><td colspan="8" class="muted empty">No users match these filters.</td></tr>'}</tbody></table></div>${pager}</section>
    <p class="small muted">Push off = the worker skips this user's scheduled posts (they stay in the queue). Passwords are bcrypt hashes and are never displayed.</p>`, true, '/users'));
  });
  r.get('/users.csv', (req, res) => {
    const { where, args } = userQuery(req), esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`, iso = ms => ms ? new Date(ms).toISOString() : '';
    const rows = db.prepare(`SELECT u.* FROM users u ${where} ORDER BY u.id`).all(...args);
    A(req, 'users.export', null, rows.length + ' rows');
    res.type('text/csv').set('Content-Disposition', `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(['id,email,name,plan,premium,plan_until,country,last_ip,registered,last_active,status,ban_reason,push'].concat(rows.map(u => [u.id, u.email, u.display_name, u.plan, P.isPremium(u) ? 'yes' : 'no', iso(u.plan_until), u.last_country, u.last_ip, iso(u.created), iso(u.last_seen), u.disabled ? 'banned' : 'active', u.ban_reason, u.push_enabled === 0 ? 'off' : 'on'].map(esc).join(','))).join('\n'));
  });
  const profActs = u => `<div class="prof-acts"><h2 class="prof-name">${h(u.display_name || u.email)}</h2><details class="pop"><summary class="btn sm" aria-label="Actions for ${h(u.email)}">Actions ▾</summary><div class="popc">
        <a class="menu-link" href="${base}/users/${u.id}/plan" data-modal data-act="plan">⭐ ${paidActive(u) ? 'Change plan / expiry' : 'Grant plan'}…</a>
        ${P.isPaused(u) ? `<form method="post" action="${base}/users/${u.id}/resume"><button class="menu-link">▶ Resume plan now</button></form>` : `<a class="menu-link" href="${base}/users/${u.id}/plan?tab=pause" data-modal data-act="pause">⏸ Pause plan…</a>`}
        ${P.hasTemp(u) ? `<form method="post" action="${base}/users/${u.id}/temp-end"><button class="menu-link">⏹ End temporary Premium</button></form>` : `<a class="menu-link" href="${base}/users/${u.id}/plan?tab=temp" data-modal data-act="temp">⏱ Temporary Premium…</a>`}
        ${paidActive(u) ? `<form method="post" action="${base}/users/${u.id}/revoke" data-confirm="Revoke Premium for ${h(u.email)}?"><button class="menu-link danger">✕ Revoke plan</button></form>` : ''}
      </div></details></div>`;
  r.get('/users/:id', (req, res, next) => {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!u) return next('router');
    const bans = db.prepare('SELECT * FROM ban_log WHERE user_id=? ORDER BY ts DESC').all(u.id), plans = db.prepare('SELECT * FROM plan_log WHERE user_id=? ORDER BY ts DESC LIMIT 50').all(u.id);
    const pays = db.prepare('SELECT * FROM payments_ledger WHERE user_id=? ORDER BY ts DESC').all(u.id), subs = db.prepare('SELECT * FROM subscriptions WHERE user_id=? ORDER BY start_at DESC').all(u.id);
    const logins = db.prepare('SELECT * FROM login_events WHERE user_id=? ORDER BY ts DESC LIMIT 20').all(u.id), accs = db.prepare('SELECT platform,username,status FROM accounts WHERE user_id=?').all(u.id);
    const tbl = (head, rows, empty) => `<div class="tbl"><table><thead><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;
    res.send(page('Owner · ' + u.email, `${msg(req)}${profActs(u)}<div class="kpis">${card('Subscription', P.isPaused(u) ? 'Paused' : P.isPremium(u) ? h(paidActive(u) ? planLabel(u.plan) : 'Temporary') : 'Free', (tempBadges(u) || countdown(u)) + ` <a class="btn ghost sm" href="${base}/users/${u.id}/plan" data-modal>Manage plan</a>`, P.isPremium(u) ? 'pri' : P.isPaused(u) ? 'warn' : '')}${card('Paid total', usd(pays.reduce((a, p) => a + p.amount, 0)), pays.length + ' payments')}${card('Last login', ago(u.last_login), flag(u.last_country) + ' · ' + h(u.last_ip || ''))}${card('Status', u.disabled ? 'Banned' : 'Active', h(u.ban_reason || ''), u.disabled ? 'bad' : 'ok')}</div>
    <div class="grid2"><section class="panel"><div class="ph"><h2>Subscriptions</h2></div>${tbl(['Plan', 'Start', 'End', 'Amount', 'Source', 'Status'], subs.map(s => `<tr><td>${h(s.plan)}</td><td>${fmt(s.start_at)}</td><td>${fmt(s.end_at)}</td><td>${usd(s.amount)}</td><td>${h(s.source)}</td><td><span class="badge ${s.status === 'active' ? 'ok' : ''}">${h(s.status)}</span></td></tr>`), 'No subscriptions')}</section>
    <section class="panel"><div class="ph"><h2>Ban history</h2></div>${tbl(['When', 'Action', 'Reason', 'By'], bans.map(b => `<tr><td>${fmt(b.ts)}</td><td><span class="badge ${b.action === 'ban' ? 'bad' : 'ok'}">${b.action}</span></td><td>${h(b.reason || '–')}</td><td>${h(b.by || '')}</td></tr>`), 'Never banned')}</section></div>
    <div class="grid2"><section class="panel"><div class="ph"><h2>Plan history</h2></div>${tbl(['When', 'Action', 'Detail', 'By'], plans.map(p => `<tr><td>${fmt(p.ts)}</td><td><span class="badge ${/pause/.test(p.action) ? 'warn' : /temp/.test(p.action) ? 'info' : /resume|grant/.test(p.action) ? 'ok' : /revoke/.test(p.action) ? 'bad' : ''}">${h(p.action.replace(/_/g, ' '))}</span> ${h(p.plan || '')}</td><td>${h(p.detail || '')}</td><td>${h(p.by || '')}</td></tr>`), 'No changes')}</section>
    <section class="panel"><div class="ph"><h2>Recent logins</h2></div>${tbl(['When', 'IP', 'Country', 'Device'], logins.map(l => `<tr><td>${fmt(l.ts)}</td><td class="mono">${h(l.ip)}</td><td>${flag(l.country)}</td><td>${h(l.ua)}</td></tr>`), 'No logins yet')}</section></div>
    <section class="panel"><div class="ph"><h2>Connected accounts</h2></div>${tbl(['Platform', 'Handle', 'Status'], accs.map(a => `<tr><td><span class="chip ${a.platform}">${a.platform}</span></td><td>@${h(a.username || '')}</td><td>${h(a.status || 'ok')}</td></tr>`), 'None')}</section>`, true, '/users'));
  });
  const back = (req, res, m) => { req.session.msg = m; res.redirect(303, String(req.get('referer') || '').includes(base) ? req.get('referer') : base + '/users'); };
  r.post('/users/:id/grant', (req, res, next) => {
    const id = Number(req.params.id), plan = String(req.body.plan || '');
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id) || !P.PLANS[plan]) return next('router');
    const startAt = req.body.start ? Date.parse(req.body.start + 'T00:00:00Z') : undefined;
    const r0 = P.recordPayment({ userId: id, plan, amount: req.body.amount, source: req.body.source || 'manual', startAt: isNaN(startAt) ? undefined : startAt, by: who(req).name });
    A(req, 'plan.grant', 'user#' + id, `${plan} until ${new Date(r0.end).toISOString().slice(0, 10)}`);
    back(req, res, `Premium granted until ${fmt(r0.end)}`);
  });
  r.post('/users/:id/revoke', (req, res) => { P.revoke(Number(req.params.id), who(req).name, 'revoked by owner'); A(req, 'plan.revoke', 'user#' + req.params.id); back(req, res, 'Premium revoked'); });
  r.post('/users/:id/plan', (req, res) => { // legacy simple form
    if (req.body.plan === 'free') { P.revoke(Number(req.params.id), who(req).name); A(req, 'plan.revoke', 'user#' + req.params.id); }
    else if (P.PLANS[req.body.plan]) { P.recordPayment({ userId: Number(req.params.id), plan: req.body.plan, source: 'manual', by: who(req).name }); A(req, 'plan.grant', 'user#' + req.params.id, req.body.plan); }
    back(req, res, 'Plan updated');
  });
  // ---- Plan modal: one panel for plan, dates, pause/resume and temporary premium ----
  const planLabel = k => k === 'custom' ? 'Custom' : P.PLANS[k] ? P.PLANS[k].label : k;
  const DAY = 864e5, parseDay = v => { const t = Date.parse(String(v || '') + 'T00:00:00Z'); return isNaN(t) ? null : t; };
  const planPanel = (u, tab) => {
    const prem = P.isPremium(u), paid = paidActive(u), cur = P.PLANS[u.plan] || u.plan === 'custom' ? u.plan : 'monthly';
    const startDef = paid ? u.plan_until : Date.now(), endDef = startDef + (P.PLANS[cur] || P.PLANS.monthly).days * DAY;
    const cards = [...Object.entries(P.PLANS).map(([k, p]) => [k, `$${p.usd}`, { monthly: 'Monthly', quarterly: '3 months', semiannual: '6 months', yearly: 'Yearly' }[k] || p.label, `${p.days} days`, p.days, p.usd]), ['custom', 'Custom', 'Any length', 'pick expiry', 0, '']];
    const T = (id, l) => `<a role="tab" href="${base}/users/${u.id}/plan?tab=${id}" data-tab="${id}" class="${tab === id ? 'on' : ''}" aria-selected="${tab === id}">${l}</a>`;
    const presets = (name, extra) => `<div class="pm-chips">${[1, 3, 7, 30].map((d, i) => `<label><input type="radio" name="${name}" value="${d}" ${i === 2 ? 'checked' : ''}><span>${d} day${d > 1 ? 's' : ''}</span></label>`).join('')}<label><input type="radio" name="${name}" value="date"><span>Until date</span></label>${extra || ''}</div>`;
    return `<div class="pm" data-pm>
    <header class="pm-h">${av(u.display_name || u.email)}<div class="pm-who"><b>${h(u.display_name || u.email.split('@')[0])}</b><small>${h(u.email)} · #${u.id} · ${flag(u.last_country)}</small></div>
     <div class="pm-cur"><small>Current plan</small><div>${paid ? `<span class="badge pri">★ ${h(planLabel(u.plan))}</span>` : prem ? '<span class="badge pri">★ Premium</span>' : '<span class="badge">Free</span>'} ${tempBadges(u)}</div><small>${u.plan_until ? (paid ? 'Expires ' : 'Expired ') + fmt(u.plan_until) : 'No paid plan yet'}</small></div>
     <a class="pm-x" href="${base}/users" data-close aria-label="Close">✕</a></header>
    <nav class="pm-tabs" role="tablist">${T('plan', '⭐ Plan &amp; expiry')}${T('pause', P.isPaused(u) ? '▶ Resume' : '⏸ Pause')}${T('temp', '⏱ Temporary Premium')}</nav>
    <section class="pm-pane" data-pane="plan" ${tab === 'plan' ? '' : 'hidden'}>
     <form method="post" action="${base}/users/${u.id}/plan-save" data-plan-form>
      <div class="pm-cards" role="radiogroup" aria-label="Plan">${cards.map(([k, price, name, sub, days, usdv]) => `<label class="pcard"><input type="radio" name="plan" value="${k}" data-days="${days}" data-usd="${usdv}" ${k === cur ? 'checked' : ''}><b>${price}</b><span>${name}</span><small>${sub}</small></label>`).join('')}</div>
      <div class="pm-grid">
       <div><label for="pm-s${u.id}">Start date</label><input id="pm-s${u.id}" type="date" name="start" value="${dIn(startDef)}" required></div>
       <div><label for="pm-e${u.id}">Expiry date</label><input id="pm-e${u.id}" type="date" name="end" value="${dIn(endDef)}" required></div>
       <div><label for="pm-a${u.id}">Amount (USD)</label><input id="pm-a${u.id}" type="number" step="0.01" min="0" name="amount" placeholder="$${(P.PLANS[cur] || { usd: 0 }).usd} list"></div>
       <div><label for="pm-o${u.id}">Source</label><select id="pm-o${u.id}" name="source">${P.SOURCES.map(x => `<option>${x}</option>`).join('')}</select></div>
       <div class="span2"><label for="pm-n${u.id}">Note <span class="muted small">(optional)</span></label><input id="pm-n${u.id}" name="note" maxlength="200" placeholder="e.g. paid via bKash, ref 123"></div>
      </div>
      <p class="hint" data-pm-hint>${paid ? 'Start defaults to the current expiry, so the new time is added on top.' : 'Start defaults to today.'} Expiry fills in from the plan; you can change it.</p>
      <div class="pm-foot">${paid ? `<button class="btn danger sm" form="pm-rv${u.id}">Revoke plan</button>` : '<span></span>'}<span class="grow"></span><a class="btn ghost sm" href="${base}/users" data-close>Cancel</a><button class="btn sm">Save plan</button></div>
     </form>${paid ? `<form id="pm-rv${u.id}" method="post" action="${base}/users/${u.id}/revoke" data-confirm="Revoke Premium for ${h(u.email)}?"></form>` : ''}
    </section>
    <section class="pm-pane" data-pane="pause" ${tab === 'pause' ? '' : 'hidden'}>
     ${P.isPaused(u) ? `<div class="pm-state warn"><b>⏸ Paused ${u.paused_until ? 'until ' + fmt(u.paused_until) : 'indefinitely'}</b><p class="small muted">Premium is off. Since ${fmt(u.paused_at)}.${u.pause_extend ? ' Paused days will be added to the expiry on resume.' : ''} ${u.paused_until ? 'Resumes automatically.' : ''}</p></div>
      <form method="post" action="${base}/users/${u.id}/resume" class="pm-foot"><span class="grow"></span><button class="btn sm">▶ Resume plan now</button></form>` : `
     <form method="post" action="${base}/users/${u.id}/pause">
      <p class="small muted" style="margin-top:0">Turns Premium <b>off</b> for a while without revoking it. It switches back on automatically when the pause ends. Separate from ban and push.</p>
      <label>Pause for</label>${presets('dur', '<label><input type="radio" name="dur" value="forever"><span>Indefinitely</span></label>')}
      <div class="pm-grid"><div><label for="pm-pu${u.id}">Until date <span class="muted small">(for “Until date”)</span></label><input id="pm-pu${u.id}" type="date" name="until" min="${dIn(Date.now() + DAY)}"></div>
       <div class="pm-check"><label><input type="checkbox" name="extend" value="1" ${paid ? 'checked' : ''}> Extend expiry by the paused days</label></div></div>
      <div class="pm-foot"><span class="grow"></span><a class="btn ghost sm" href="${base}/users" data-close>Cancel</a><button class="btn warn sm">⏸ Pause plan</button></div></form>`}
    </section>
    <section class="pm-pane" data-pane="temp" ${tab === 'temp' ? '' : 'hidden'}>
     ${P.hasTemp(u) ? `<div class="pm-state info"><b>⏱ Temporary Premium until ${fmt(u.temp_until)}</b><p class="small muted">Reverts automatically. Their paid plan (if any) is untouched.</p></div>` : ''}
     <form method="post" action="${base}/users/${u.id}/temp">
      <p class="small muted" style="margin-top:0">Turns Premium <b>on</b> temporarily (trial, apology, testing). It reverts automatically; no payment is recorded.</p>
      <label>${P.hasTemp(u) ? 'Change end' : 'Premium for'}</label>${presets('dur')}
      <div class="pm-grid"><div><label for="pm-tu${u.id}">Until date</label><input id="pm-tu${u.id}" type="date" name="until" min="${dIn(Date.now() + DAY)}"></div></div>
      <div class="pm-foot">${P.hasTemp(u) ? `<button class="btn danger sm" form="pm-te${u.id}">End now</button>` : ''}<span class="grow"></span><a class="btn ghost sm" href="${base}/users" data-close>Cancel</a><button class="btn sm">⏱ ${P.hasTemp(u) ? 'Update' : 'Turn on'} temporary Premium</button></div></form>
     ${P.hasTemp(u) ? `<form id="pm-te${u.id}" method="post" action="${base}/users/${u.id}/temp-end"></form>` : ''}
    </section></div>`;
  };
  const userOr404 = (req, next) => db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  r.get('/users/:id/plan', (req, res, next) => {
    const u = userOr404(req); if (!u) return next('router');
    const tab = ['plan', 'pause', 'temp'].includes(req.query.tab) ? req.query.tab : 'plan';
    if (req.query.partial === '1') return res.send(planPanel(u, tab));
    res.send(page('Owner · Plan for ' + u.email, `${msg(req)}<div class="pm-page">${planPanel(u, tab)}</div>`, true, '/users'));
  });
  const durUntil = (b, allowForever) => {
    if (allowForever && b.dur === 'forever') return { until: null };
    if (b.dur === 'date') { const t = parseDay(b.until); return t && t > Date.now() ? { until: t } : { err: 'Pick a future date' }; }
    const d = Number(b.dur); return [1, 3, 7, 30].includes(d) || (d > 0 && d <= 3650) ? { until: Date.now() + d * DAY } : { err: 'Pick a period' };
  };
  r.post('/users/:id/plan-save', (req, res, next) => {
    const u = userOr404(req), plan = String(req.body.plan || ''); if (!u || !(P.PLANS[plan] || plan === 'custom')) return next('router');
    const start = parseDay(req.body.start) || Date.now(), end = parseDay(req.body.end);
    if (plan === 'custom' && !end) return back(req, res, 'Custom plan needs an expiry date');
    if (end && end <= start) return back(req, res, 'Expiry must be after the start date');
    const r0 = P.recordPayment({ userId: u.id, plan, amount: req.body.amount, source: req.body.source || 'manual', startAt: start, endAt: end || undefined, note: String(req.body.note || '').trim().slice(0, 200) || null, by: who(req).name });
    A(req, 'plan.grant', 'user#' + u.id, `${plan} ${dIn(r0.start)} → ${dIn(r0.end)}`);
    back(req, res, `${planLabel(plan)} saved for ${u.email}: ${fmt(r0.start)} → ${fmt(r0.end)}`);
  });
  r.post('/users/:id/pause', (req, res, next) => {
    const u = userOr404(req); if (!u) return next('router');
    const d = durUntil(req.body, true); if (d.err) return back(req, res, d.err);
    P.pause(u.id, { until: d.until, extend: req.body.extend === '1', by: who(req).name });
    A(req, 'plan.pause', 'user#' + u.id, `${d.until ? 'until ' + dIn(d.until) : 'indefinitely'}${req.body.extend === '1' ? ' +extend' : ''}`);
    back(req, res, `Plan paused for ${u.email} ${d.until ? 'until ' + fmt(d.until) : 'indefinitely'}`);
  });
  r.post('/users/:id/resume', (req, res, next) => {
    const u = userOr404(req); if (!u) return next('router');
    const out = P.resume(u.id, { by: who(req).name }); A(req, 'plan.resume', 'user#' + u.id, out ? `after ${Math.round(out.pausedMs / DAY * 10) / 10} days` : 'not paused');
    back(req, res, out ? `Plan resumed for ${u.email}` : 'That plan was not paused');
  });
  r.post('/users/:id/temp', (req, res, next) => {
    const u = userOr404(req); if (!u) return next('router');
    const d = durUntil(req.body, false); if (d.err) return back(req, res, d.err);
    P.grantTemp(u.id, { until: d.until, by: who(req).name }); A(req, 'plan.temp_on', 'user#' + u.id, 'until ' + dIn(d.until));
    back(req, res, `Temporary Premium on for ${u.email} until ${fmt(d.until)}`);
  });
  r.post('/users/:id/temp-end', (req, res, next) => {
    const u = userOr404(req); if (!u) return next('router');
    P.endTemp(u.id, { by: who(req).name }); A(req, 'plan.temp_off', 'user#' + u.id); back(req, res, 'Temporary Premium ended');
  });
  const setBan = (req, res, ban) => {
    const id = Number(req.params.id), reason = String(req.body.reason || '').trim().slice(0, 300) || (ban ? 'No reason given' : null);
    db.prepare('UPDATE users SET disabled=?, ban_reason=? WHERE id=?').run(ban ? 1 : 0, ban ? reason : null, id);
    db.prepare('INSERT INTO ban_log(user_id,action,reason,by,ts) VALUES(?,?,?,?,?)').run(id, ban ? 'ban' : 'unban', reason, who(req).name, Date.now());
    if (ban) db.prepare('DELETE FROM sessions WHERE data LIKE ?').run(`%"uid":${id}%`);
    A(req, ban ? 'user.ban' : 'user.unban', 'user#' + id, reason);
    back(req, res, ban ? 'User banned' : 'User unbanned');
  };
  r.post('/users/:id/:act(ban|disable)', (req, res) => setBan(req, res, true));
  r.post('/users/:id/:act(unban|enable)', (req, res) => setBan(req, res, false));
  r.post('/users/:id/push', (req, res) => {
    const u = db.prepare('SELECT push_enabled FROM users WHERE id=?').get(req.params.id); const on = u && u.push_enabled === 0 ? 1 : 0;
    db.prepare('UPDATE users SET push_enabled=? WHERE id=?').run(on, req.params.id); A(req, 'user.push', 'user#' + req.params.id, on ? 'on' : 'off');
    back(req, res, `Automatic posting ${on ? 'enabled' : 'disabled'}`);
  });

  r.get('/activity', (req, res) => {
    const q = String(req.query.q || '').trim(), c = String(req.query.country || '').trim().toUpperCase(), days = Math.min(90, Number(req.query.days) || 30), pg = Math.max(1, Number(req.query.page) || 1), per = 50;
    const w = ['e.ts>=?'], a = [Date.now() - days * 864e5];
    if (q) { w.push('(u.email LIKE ? OR e.ip LIKE ?)'); a.push(`%${q}%`, `%${q}%`); }
    if (c) { w.push('e.country=?'); a.push(c); }
    const where = 'WHERE ' + w.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM login_events e JOIN users u ON u.id=e.user_id ${where}`).get(...a).c;
    const rows = db.prepare(`SELECT e.*, u.email FROM login_events e JOIN users u ON u.id=e.user_id ${where} ORDER BY e.ts DESC LIMIT ? OFFSET ?`).all(...a, per, (pg - 1) * per);
    const countries = db.prepare('SELECT country, COUNT(*) n FROM login_events WHERE ts>=? GROUP BY country ORDER BY n DESC LIMIT 8').all(Date.now() - days * 864e5);
    const maxC = Math.max(1, ...countries.map(x => x.n));
    res.send(page('Owner · Activity', `<form class="filters" method="get" action="${base}/activity"><input name="q" value="${h(q)}" placeholder="Email or IP"><input name="country" value="${h(c)}" placeholder="Country (e.g. BD)" maxlength="7" style="max-width:150px">
      <select name="days">${[1, 7, 30, 90].map(d => `<option value="${d}" ${d === days ? 'selected' : ''}>Last ${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select><button class="btn sm">Filter</button><a class="btn ghost sm" href="${base}/audit">Full audit log →</a></form>
    <div class="grid2 wide"><section class="panel"><div class="ph"><h2>Logins</h2><span class="muted small">${total} in range · kept 90 days</span></div><div class="tbl"><table><thead><tr><th>When</th><th>User</th><th>Type</th><th>IP</th><th>Country</th><th>Device</th></tr></thead><tbody>
      ${rows.map(e => `<tr><td>${fmt(e.ts)}<small class="muted d">${ago(e.ts)}</small></td><td><a class="who" href="${base}/users/${e.user_id}">${av(e.email)}<span>${h(e.email)}</span></a></td><td><span class="badge">${h(e.kind)}</span></td><td class="mono">${h(e.ip)}</td><td>${flag(e.country)}</td><td>${h(e.ua)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No logins match</td></tr>'}</tbody></table></div>${pager(`${base}/activity?${qs({ q, country: c, days })}`, total, pg, per)}</section>
    <section class="panel"><div class="ph"><h2>Top countries</h2></div>${countries.map(x => `<div class="bar"><span>${flag(x.country)}</span><i style="--w:${Math.round(x.n / maxC * 100)}%"></i><b>${x.n}</b></div>`).join('') || '<p class="muted small">No data</p>'}</section></div>`, true, '/activity'));
  });

  r.get('/revenue', (req, res) => {
    const st = P.stats(), now = Date.now();
    const recent = db.prepare('SELECT l.*, u.email FROM payments_ledger l JOIN users u ON u.id=l.user_id ORDER BY l.ts DESC LIMIT 25').all();
    const maxP = Math.max(1, ...st.byPlan.map(p => p.s));
    const payers = st.perUser.length;
    res.send(page('Owner · Revenue', `<div class="kpis">${card('Total revenue', usd(st.total), st.count + ' payments', 'pri')}${card('MRR estimate', usd(st.mrr), 'active subs ÷ plan months', 'ok')}${card('ARR run-rate', usd(st.mrr * 12))}${card('This month', usd(st.months[11].s), 'last month ' + usd(st.months[10].s))}${card('Paying users', payers, payers ? 'ARPU ' + usd(st.total / payers) : '')}${card('Active subs', db.prepare("SELECT COUNT(DISTINCT user_id) c FROM subscriptions WHERE status='active' AND start_at<=? AND end_at>?").get(now, now).c)}</div>
    <section class="panel"><div class="ph"><h2>Revenue by month</h2><span class="muted small">last 12 months · USD</span></div>${chart(st.months)}</section>
    <div class="grid2"><section class="panel"><div class="ph"><h2>By plan</h2></div>${Object.keys(P.PLANS).map(k => { const p = st.byPlan.find(x => x.plan === k) || { n: 0, s: 0 }; return `<div class="bar"><span>${P.PLANS[k].label} <small class="muted">$${P.PLANS[k].usd}</small></span><i style="--w:${Math.round(p.s / maxP * 100)}%"></i><b>${usd(p.s)} <small class="muted">· ${p.n}</small></b></div>`; }).join('')}
      <div class="ph" style="margin-top:18px"><h2>By source</h2></div>${st.bySource.map(s => `<div class="bar"><span>${h(s.source)}</span><i style="--w:${Math.round(s.s / Math.max(1, st.total) * 100)}%"></i><b>${usd(s.s)}</b></div>`).join('') || '<p class="muted small">No payments yet</p>'}</section>
    <section class="panel"><div class="ph"><h2>Revenue per user</h2></div><div class="tbl"><table><thead><tr><th>User</th><th>Payments</th><th>Total</th><th>Last paid</th></tr></thead><tbody>${st.perUser.map(u => `<tr><td><a class="who" href="${base}/users/${u.id}">${av(u.email)}<span>${h(u.email)}</span></a></td><td>${u.n}</td><td><b>${usd(u.s)}</b></td><td>${fmt(u.last)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No payments yet</td></tr>'}</tbody></table></div></section></div>
    <section class="panel"><div class="ph"><h2>Ledger</h2><span class="muted small">recorded via recordPayment() — owner grants and future provider webhooks</span></div><div class="tbl"><table><thead><tr><th>When</th><th>User</th><th>Plan</th><th>Amount</th><th>Source</th><th>Reference</th></tr></thead><tbody>${recent.map(l => `<tr><td>${fmt(l.ts)}</td><td>${h(l.email)}</td><td>${h(P.PLANS[l.plan] ? P.PLANS[l.plan].label : l.plan)}</td><td><b>${usd(l.amount)}</b> ${h(l.currency)}</td><td><span class="badge">${h(l.source)}</span></td><td class="mono small">${h(l.external_id || l.note || '–')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Empty</td></tr>'}</tbody></table></div></section>`, true, '/revenue'));
  });

  r.get('/bans', (req, res) => {
    const rows = db.prepare('SELECT b.*, u.email FROM ban_log b JOIN users u ON u.id=b.user_id ORDER BY b.ts DESC LIMIT 300').all();
    res.send(page('Owner · Ban history', `<section class="panel"><div class="tbl"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Reason</th><th>By</th></tr></thead><tbody>${rows.map(b => `<tr><td>${fmt(b.ts)}</td><td><a class="who" href="${base}/users/${b.user_id}">${av(b.email)}<span>${h(b.email)}</span></a></td><td><span class="badge ${b.action === 'ban' ? 'bad' : 'ok'}">${b.action}</span></td><td>${h(b.reason || '–')}</td><td>${h(b.by || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No bans yet</td></tr>'}</tbody></table></div></section>`, true, '/bans'));
  });

  const auditFilters = req => ({ q: String(req.query.q || '').trim(), action: String(req.query.action || '').trim(), actorType: ['user', 'owner', 'system'].includes(req.query.who) ? req.query.who : '', days: Math.min(365, Number(req.query.days) || 30) });
  r.get('/audit.csv', (req, res) => {
    const f = auditFilters(req), { rows } = audit.query({ ...f, limit: 50000 });
    const cell = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
    res.type('text/csv').set('Content-Disposition', `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(['time_utc,actor_type,actor,action,target,detail,ip', ...rows.map(x => [new Date(x.ts).toISOString(), x.actor_type, x.actor, x.action, x.target, x.detail, x.ip].map(cell).join(','))].join('\n'));
  });
  r.get('/audit', (req, res) => {
    const f = auditFilters(req), pg = Math.max(1, Number(req.query.page) || 1), per = 50, { total, rows } = audit.query({ ...f, limit: per, offset: (pg - 1) * per });
    const acts = db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map(x => x.action);
    const query = qs({ q: f.q, action: f.action, who: f.actorType, days: f.days });
    res.send(page('Owner · Audit log', `<form class="filters" method="get" action="${base}/audit"><input name="q" value="${h(f.q)}" placeholder="Actor, target, detail or IP">
      <select name="action"><option value="">All actions</option>${acts.map(a => `<option ${a === f.action ? 'selected' : ''}>${h(a)}</option>`).join('')}</select>
      <select name="who">${[['', 'Everyone'], ['user', 'Users'], ['owner', 'Owner'], ['system', 'System']].map(([v, l]) => `<option value="${v}" ${f.actorType === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select name="days">${[1, 7, 30, 90, 365].map(d => `<option value="${d}" ${d === f.days ? 'selected' : ''}>Last ${d} days</option>`).join('')}</select><button class="btn sm">Filter</button><a class="btn ghost sm" href="${base}/audit.csv?${query}">⇩ Export CSV</a></form>
    <section class="panel"><div class="tbl"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr></thead><tbody>
    ${rows.map(x => `<tr><td>${fmt(x.ts)}</td><td><span class="badge ${x.actor_type === 'owner' ? 'pri' : ''}">${x.actor_type}</span> ${h(x.actor || '')}</td><td class="mono">${h(x.action)}</td><td>${h(x.target || '–')}</td><td class="small">${h(x.detail || '')}</td><td class="mono">${h(x.ip || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing logged in this range</td></tr>'}</tbody></table></div>${pager(`${base}/audit?${query}`, total, pg, per)}</section>`, true, '/audit'));
  });

  r.get('/email', (req, res) => {
    const st = mailer.status(), result = req.session.mailResult; delete req.session.mailResult;
    const chip = (k, v) => `<div class="kv"><code id="v-${k}">${k}=${h(v)}</code><button type="button" class="btn ghost sm" data-copy-text="${h(k)}=${h(v)}">Copy</button></div>`;
    res.send(page('Owner · Email setup', `${result ? `<div class="alert ${result.ok ? 'ok' : 'err'}">${result.ok ? '✅ Test email sent to ' + h(result.to) + '. Check the inbox (and spam).' : '❌ ' + h(result.error)}</div>` : ''}
    <div class="grid2 wide"><section class="panel"><div class="ph"><h2>Gmail SMTP in 4 steps</h2><span class="muted small">about 5 minutes</span></div><ol class="steps">
      <li><b>Open Google Account Security</b><p>Sign in with the Gmail account that should send the emails.</p><a class="btn ghost sm" href="https://myaccount.google.com/security" target="_blank" rel="noopener">myaccount.google.com/security ↗</a></li>
      <li><b>Turn on 2-Step Verification</b><p>App Passwords only appear after 2-Step Verification is on.</p></li>
      <li><b>Create an App Password</b><p>Name it “${h(S.get('app_name'))}”. Google shows a 16-character password once. Copy it (spaces don't matter).</p><a class="btn ghost sm" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">myaccount.google.com/apppasswords ↗</a></li>
      <li><b>Add Railway Variables</b><p>Railway → your service → <b>Variables</b> → add these, then <b>Redeploy</b>:</p>
        ${chip('SMTP_HOST', 'smtp.gmail.com')}${chip('SMTP_PORT', '587')}${chip('SMTP_USER', 'you@gmail.com')}${chip('SMTP_PASS', 'your-16-char-app-password')}
        <p class="hint">Optional: <code>MAIL_FROM</code> (defaults to SMTP_USER). Gmail rejects other From addresses unless they are a verified alias. Port 587 uses STARTTLS; 465 uses SSL.</p></li></ol>
      <p class="hint">Free Gmail sends roughly <b>500 emails per day</b>. For more, use a transactional provider with the same variables.</p></section>
    <section class="panel"><div class="ph"><h2>Status</h2><span class="badge ${st.configured ? 'ok' : 'warn'}">${st.configured ? 'Configured' : 'Not configured'}</span></div>
      <ul class="vars">${mailer.VARS.map(v => `<li><code>${v}</code><span class="badge ${st.vars[v] ? 'ok' : v === 'MAIL_FROM' || v === 'SMTP_PORT' ? '' : 'bad'}">${st.vars[v] ? 'set' : v === 'MAIL_FROM' ? 'optional' : v === 'SMTP_PORT' ? 'default 587' : 'missing'}</span></li>`).join('')}</ul>
      <p class="hint">Values are never shown here. They are read from the server environment only.</p>
      <form method="post" action="${base}/email/test" style="margin-top:16px"><label>Send a test email to</label><div class="row"><input type="email" name="to" required placeholder="you@example.com"><button class="btn sm" style="flex:none" ${st.configured ? '' : 'disabled'}>Send test email</button></div></form>
      <div class="ph" style="margin-top:20px"><h2>Recent emails</h2></div><div class="tbl"><table><tbody>${db.prepare('SELECT * FROM email_log ORDER BY ts DESC LIMIT 8').all().map(e => `<tr><td>${ago(e.ts)}</td><td>${h(e.kind)}</td><td class="small">${h(e.to_addr || '')}</td><td><span class="badge ${e.status === 'sent' ? 'ok' : e.status === 'failed' ? 'bad' : ''}">${h(e.status)}</span></td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</tbody></table></div></section></div>`, true, '/email'));
  });
  r.get('/email/status', (req, res) => res.json(mailer.status()));
  r.post('/email/test', async (req, res) => {
    const to = String(req.body.to || '').trim();
    const out = /^\S+@\S+\.\S+$/.test(to) ? await mailer.sendTest(to) : { ok: false, error: 'Enter a valid email address' };
    A(req, 'email.test', to, out.ok ? 'sent' : out.error);
    if (req.get('accept') === 'application/json') return res.json(out);
    req.session.mailResult = { ...out, to }; res.redirect(303, base + '/email');
  });
  const FIELDS = [['app_name', 'App name'], ['default_tz', 'Default timezone (IANA, e.g. Asia/Dhaka)'], ['caption_default', 'Default caption text for new posts'], ['free_limit', 'Free posts per month']];
  r.get('/settings', (req, res) => {
    const open = S.get('registration_open') !== '0';
    res.send(page('Owner · Settings', `${msg(req)}<div class="grid2"><section class="panel"><div class="ph"><h2>Registration</h2><span class="badge ${open ? 'ok' : 'bad'}">${open ? 'Open' : 'Closed'}</span></div>
      <p class="hint">When closed, the signup page shows “Registration is currently closed” and new accounts cannot be created. Existing users can still log in.</p>
      <form method="post" action="${base}/settings/registration"><button class="switch lg ${open ? 'on' : ''}" aria-pressed="${open}"><i></i></button> <span>${open ? 'New signups allowed' : 'New signups blocked'}</span></form></section>
    <section class="panel"><div class="ph"><h2>App settings</h2></div><form method="post" action="${base}/settings">
    ${FIELDS.map(([k, l]) => `<label>${l}</label>${k === 'caption_default' ? `<textarea name="${k}" maxlength="500" style="min-height:90px">${h(S.get(k))}</textarea>` : `<input name="${k}" value="${h(S.get(k))}">`}`).join('')}
    <div style="margin-top:18px"><button class="btn">Save</button></div></form>
    <p class="hint">API keys and SMTP are not managed here. They are set once as server environment variables.</p></section></div>`, true, '/settings'));
  });
  r.post('/settings/registration', (req, res) => {
    const open = S.get('registration_open') === '0' ? '1' : '0'; S.set('registration_open', open);
    A(req, 'settings.registration', null, open === '1' ? 'open' : 'closed'); req.session.msg = `Registration ${open === '1' ? 'opened' : 'closed'}`; res.redirect(base + '/settings');
  });
  r.post('/settings', (req, res) => {
    const tz = String(req.body.default_tz || '').trim();
    let tzOk = true; try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (e) { tzOk = false; }
    S.set('app_name', String(req.body.app_name || 'PostPilot').trim().slice(0, 40) || 'PostPilot');
    if (tzOk && tz) S.set('default_tz', tz);
    S.set('caption_default', String(req.body.caption_default || '').slice(0, 500));
    S.set('free_limit', String(Math.max(0, Math.min(1000, parseInt(req.body.free_limit) || 10))));
    A(req, 'settings.update', null, `app_name=${S.get('app_name')} tz=${S.get('default_tz')} free_limit=${S.get('free_limit')}`);
    req.session.msg = tzOk ? 'Settings saved' : 'Saved (timezone not recognised, kept the old one)'; res.redirect(base + '/settings');
  });

  app.use(base, r);
  return base;
};
module.exports.adminPath = adminPath;
