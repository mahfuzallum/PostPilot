const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { db, DATA_DIR } = require('./db');
const S = require('./settings');
const { appSecret, encrypt, decrypt } = require('./crypto');
const activity = require('./activity');
const { audit, asUser } = require('./audit');
const mailer = require('./mailer');
const accounts = require('./accounts');
const threads = require('./platforms/threads');
const reddit = require('./platforms/reddit');
const xapi = require('./platforms/x');
const google = require('./platforms/google');
const media = require('./media');
const ai = require('./ai');
const P = require('./payments');
const W = require('./worker');
const { fmt, parseLocal, autoSlots, DHAKA, NY } = require('./schedule');
const { h, t, layout, landing, pricingCards, PREMIUM_THEMES, tzPicker, validTz, TZ_PRESETS } = require('./views');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Strict CSP: everything is self-hosted (no CDNs). Inline styles are allowed for layout attributes only; no inline scripts.
app.use((req, res, next) => {
  res.set({ 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https:",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});

/* ---------- session store in SQLite ---------- */
class SqliteStore extends session.Store {
  get(sid, cb) { const r = db.prepare('SELECT data,expires FROM sessions WHERE sid=?').get(sid); cb(null, r && r.expires > Date.now() ? JSON.parse(r.data) : null); }
  set(sid, s, cb) { const exp = s.cookie && s.cookie.expires ? new Date(s.cookie.expires).getTime() : Date.now() + 864e5 * 30; db.prepare('INSERT INTO sessions(sid,data,expires) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(sid, JSON.stringify(s), exp); cb && cb(null); }
  destroy(sid, cb) { db.prepare('DELETE FROM sessions WHERE sid=?').run(sid); cb && cb(null); }
  touch(sid, s, cb) { this.set(sid, s, cb); }
}
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600e3).unref();

const baseUrl = req => (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : `${req.protocol}://${req.get('host')}`)).replace(/\/$/, '');

/* ---------- webhooks need raw body (before json parser) ---------- */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true, time: new Date().toISOString() }); });
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));
app.use('/u', express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '30d' }));

const ADMIN_PATH = require('./owner')(app, { SqliteStore });
app.use(session({ store: new SqliteStore(), secret: appSecret(), resave: false, saveUninitialized: false, name: 'pp.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 30 * 864e5 } }));
app.use((req, res, next) => {
  if (req.session.uid) req.user = db.prepare('SELECT * FROM users WHERE id=? AND COALESCE(disabled,0)=0').get(req.session.uid);
  req.premium = P.isPremium(req.user);
  if (req.session.flash) { req.flash = req.session.flash; delete req.session.flash; }
  if (req.user) req.notices = db.prepare('SELECT * FROM notices WHERE user_id=? AND seen=0 ORDER BY id DESC LIMIT 3').all(req.user.id);
  res.page = (title, body, opt) => res.send(layout(req, title, body, opt));
  if (req.user) activity.touch(req.user);
  let key = null; if (req.user && req.user.openai_key_enc) try { key = decrypt(req.user.openai_key_enc); } catch {}
  ai.withKey(key, next);
});
const U = (req, action, target, detail) => req.user && audit(req, asUser(req.user), action, target, detail);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const auth = (req, res, next) => req.user ? next() : res.redirect('/login');
const premium = (req, res, next) => {
  if (req.premium) return next();
  if (req.path.startsWith('/api/')) return res.status(402).json({ error: 'Premium required' });
  res.status(402).page('Premium', `<div class="card" style="text-align:center;padding:50px"><h1>🔒 ${t('Premium feature')}</h1><p class="muted">Dashboard analytics, competitor analysis and premium themes need Premium.</p><a class="btn" href="/billing">Upgrade</a></div>`);
};
const ts = ms => ms ? `🇧🇩 ${fmt(ms, DHAKA)}<br><span class="muted small">🇺🇸 ${fmt(ms, NY)}</span>` : '—';

/* ---------- marketing + auth ---------- */
app.get('/', (req, res) => res.send(landing(req)));
const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;
function authForm(kind, req) {
  const sign = kind === 'signup';
  return `<div class="card" style="max-width:440px;margin:30px auto"><h1 style="margin-top:0">${sign ? t('Create account') : t('Log in')}</h1>
  ${sign ? '<p class="muted small">Free forever plan. No card required.</p>' : ''}
  <form method="post">${sign && P.PLANS[req.query.plan] ? `<input type="hidden" name="plan" value="${req.query.plan}"><p class="small muted">After signing up you'll pick the <b>${h(P.PLANS[req.query.plan].label)}</b> plan on Billing.</p>` : ''}<label>${t('Email')}</label><input name="email" type="email" required autocomplete="email">
  <label>${t('Password')}</label><input name="password" type="password" minlength="8" required autocomplete="${sign ? 'new-password' : 'current-password'}">
  <div style="margin-top:20px"><button class="btn" type="submit" style="width:100%">${sign ? 'Create account' : 'Log in'}</button></div></form>
  <p class="muted small" style="text-align:center">${sign ? '<a href="/login">Have an account? Log in</a>' : '<a href="/signup">New here? Sign up</a>'}</p></div>`;
}
const regOpen = () => S.get('registration_open') !== '0';
const closedCard = `<div class="card" style="max-width:440px;margin:30px auto;text-align:center"><div style="font-size:2.4rem">🔒</div><h1 style="margin:6px 0">Registration is currently closed</h1><p class="muted">New signups are paused right now. Please check back later.</p><a class="btn ghost" href="/login">Log in instead</a></div>`;
app.get('/signup', (req, res) => res.page('Sign up', regOpen() ? authForm('signup', req) : closedCard));
app.get('/login', (req, res) => res.page('Log in', authForm('login', req)));
app.post('/signup', (req, res) => {
  if (!regOpen()) return res.status(403).page('Sign up', closedCard);
  const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || pw.length < 8) { flash(req, 'err', 'Valid email and 8+ character password required'); return res.redirect('/signup'); }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) { flash(req, 'err', 'Email already registered'); return res.redirect('/signup'); }
  const r = db.prepare('INSERT INTO users(email,pw,created) VALUES(?,?,?)').run(email, bcrypt.hashSync(pw, 11), Date.now());
  activity.record(r.lastInsertRowid, req, 'signup'); audit(req, { type: 'user', id: r.lastInsertRowid, name: email }, 'user.signup');
  req.session.regenerate(() => { req.session.uid = r.lastInsertRowid; res.redirect(P.PLANS[req.body.plan] ? `/billing?plan=${req.body.plan}#plans` : '/connect'); });
});
app.post('/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body.email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.pw)) { flash(req, 'err', 'Wrong email or password'); return res.redirect('/login'); }
  if (u.disabled) { audit(req, asUser(u), 'user.login_blocked', null, 'banned'); flash(req, 'err', 'This account has been suspended. Contact support if you think this is a mistake.'); return res.redirect('/login'); }
  activity.record(u.id, req, 'login'); audit(req, asUser(u), 'user.login');
  req.session.regenerate(() => { req.session.uid = u.id; res.redirect('/app'); });
});
app.get('/logout', (req, res) => (U(req, 'user.logout'), req.session.destroy(() => res.redirect('/'))));

/* ---------- dashboard ---------- */
app.get('/app', auth, (req, res) => {
  const u = req.user, q = (sql, ...a) => db.prepare(sql).get(u.id, ...a);
  const published = q("SELECT COUNT(*) c FROM posts WHERE user_id=? AND published_at IS NOT NULL").c;
  const deleted = q("SELECT COUNT(*) c FROM posts WHERE user_id=? AND status='deleted'").c;
  const scheduled = q("SELECT COUNT(*) c FROM posts WHERE user_id=? AND status='scheduled'").c;
  const views = req.premium ? q("SELECT COALESCE(SUM(views),0) v FROM posts WHERE user_id=?").v : null;
  const recent = db.prepare("SELECT * FROM posts WHERE user_id=? AND status IN ('published','deleted','failed','missed') ORDER BY COALESCE(published_at,scheduled_at) DESC LIMIT 25").all(u.id);
  const acc = Object.fromEntries(accounts.list(u.id).map(a => [a.platform, a]));
  const th = req.premium ? q("SELECT COUNT(*) n, COALESCE(SUM(views),0) v, COALESCE(SUM(likes),0) l, COALESCE(SUM(replies),0) r, COALESCE(SUM(reposts),0) rp FROM posts WHERE user_id=? AND published_at IS NOT NULL") : { n: '•', v: '•', l: '•', r: '•', rp: '•' };
  const lockWrap = html => req.premium ? html : `<div class="locked"><div class="blur">${html}</div><div class="lockmsg"><div><b>🔒 ${t('Premium analytics')}</b><br><a class="btn sm" href="/billing" style="margin-top:10px">Upgrade</a></div></div></div>`;
  const rows = recent.map(p => {
    const low = req.premium && p.insights_at && p.status === 'published' && (p.views || 0) < u.low_reach;
    return `<tr><td><span class="pill ${p.status}">${p.status}</span>${low ? ` <span class="pill low" title="Info only">⚠ low reach</span>` : ''}</td>
    <td style="max-width:340px">${h((p.text || '').slice(0, 120))}${p.permalink ? ` <a href="${h(p.permalink)}" target="_blank" rel="noopener">↗</a>` : ''}<div class="muted small">${p.media_type}${p.error ? ' · ' + h(p.error) : ''}</div></td>
    <td>${ts(p.published_at || p.scheduled_at)}</td>
    <td>${req.premium ? (p.insights_at ? `👁 ${p.views} · ❤ ${p.likes} · 💬 ${p.replies} · 🔁 ${p.reposts}` : '<span class="muted small">pending (6–7h)</span>') : '🔒'}</td>
    <td>${p.status === 'published' ? `<form method="post" action="/posts/${p.id}/delete" data-confirm="Delete this post?"><button class="btn danger sm" type="submit">Delete</button></form>` : ''}</td></tr>`; }).join('');
  res.page('Dashboard', `<div class="page-h"><h1>${t('Dashboard')}</h1><div class="row" style="flex:none"><span class="pill">${req.premium ? '⭐ Premium' : 'Free'}</span><a class="btn" href="/compose">+ New post</a></div></div>
  <div class="grid g4"><div class="card stat"><div class="n">${published}</div><div class="l">${t('Published')}</div></div>
  ${lockWrap(`<div class="card stat"><div class="n">${views == null ? '12.4k' : views.toLocaleString()}</div><div class="l">${t('Reached (total views)')}</div></div>`)}
  <div class="card stat"><div class="n">${deleted}</div><div class="l">${t('Deleted (manual)')}</div></div>
  <div class="card stat"><div class="n">${scheduled}</div><div class="l">${t('In queue')}</div></div></div>
  <h2 style="margin-top:34px">${t('Per platform')}</h2>
  ${lockWrap(`<div class="grid g3"><div class="card"><h3 style="margin-top:0">Threads ${S.ready('threads') ? '<span class="pill published">publishing</span>' : '<span class="pill">Not available yet</span>'}</h3><p class="muted small">${acc.threads ? '@' + h(acc.threads.username) : 'not connected'}</p>
   <div>📝 ${th.n} posts · 👁 ${th.v} views<br>❤ ${th.l} · 💬 ${th.r} · 🔁 ${th.rp}</div></div>
   <div class="card"><h3 style="margin-top:0">Reddit ${S.ready('reddit') ? '<span class="pill published">publishing</span>' : '<span class="pill">Not available yet</span>'}</h3><p class="muted small">${acc.reddit ? 'u/' + h(acc.reddit.username) : 'not connected'}</p><div class="small">Posts you schedule, plus subreddit top/rising. Never comments or votes.</div><a class="btn ghost sm" href="/insights" style="margin-top:10px">Open analysis</a></div>
   <div class="card"><h3 style="margin-top:0">X ${S.ready('x') ? '<span class="pill published">publishing</span>' : '<span class="pill">Not available yet</span>'}</h3><p class="muted small">${acc.x ? '@' + h(acc.x.username) : 'not connected'}</p><div class="small">Posts you schedule, plus recent search (24h) for analysis. No auto-engagement.</div><a class="btn ghost sm" href="/insights" style="margin-top:10px">Open analysis</a></div></div>`)}
  <div class="page-h" style="margin-top:34px"><h2 style="margin:0">${t('Recent posts')}</h2>
  ${req.premium ? `<form method="post" action="/account/lowreach" class="row" style="flex:none" data-noload="1"><label class="small" style="margin:0;white-space:nowrap">Low-reach flag below</label><input name="v" type="number" min="0" value="${u.low_reach}" style="width:90px"><button class="btn ghost sm">Save</button></form>` : ''}</div>
  <div class="card tbl"><table><thead><tr><th>Status</th><th>Post</th><th>Time</th><th>Reach</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan=5 class="muted">No posts yet</td></tr>'}</tbody></table>
  <p class="muted small">Low-reach flag is information only — nothing is deleted automatically.</p></div>`, { active: '/app' });
});
app.post('/account/lowreach', auth, premium, (req, res) => { db.prepare('UPDATE users SET low_reach=? WHERE id=?').run(Math.max(0, parseInt(req.body.v) || 15), req.user.id); res.redirect('/app'); });
app.post('/account/mode', auth, (req, res) => { db.prepare('UPDATE users SET mode=? WHERE id=?').run(req.body.mode === 'light' ? 'light' : 'dark', req.user.id); res.json({ ok: true }); });
// Appearance applies instantly in the browser and is persisted here (JSON or form). Premium themes/fonts need Premium.
app.post('/account/appearance', auth, (req, res) => {
  const b = req.body, u = req.user, set = {};
  if (b.mode) set.mode = b.mode === 'light' ? 'light' : 'dark';
  if (b.theme) { if (b.theme !== 'default' && !req.premium) return res.status(402).json({ ok: false, error: 'Premium themes need Premium' }); set.theme = ['default', ...PREMIUM_THEMES].includes(b.theme) ? b.theme : 'default'; }
  if (b.font) { if (b.font !== 'inter' && !req.premium) return res.status(402).json({ ok: false, error: 'Premium fonts need Premium' }); set.font = ['inter', 'serif', 'rounded'].includes(b.font) ? b.font : 'inter'; }
  const k = Object.keys(set); if (k.length) { db.prepare(`UPDATE users SET ${k.map(x => x + '=?').join(',')} WHERE id=?`).run(...k.map(x => set[x]), u.id); U(req, 'settings.appearance', null, JSON.stringify(set)); }
  if (/json/.test(req.get('accept') || '')) return res.json({ ok: true, ...set });
  flash(req, 'ok', 'Appearance saved'); res.redirect('/settings#appearance');
});
app.post('/account/tz', auth, (req, res) => { if (!validTz(req.body.tz)) return res.status(400).json({ ok: false }); db.prepare('UPDATE users SET tz=?, tz_auto=? WHERE id=?').run(req.body.tz, req.body.auto ? 1 : 0, req.user.id); U(req, 'settings.timezone', null, req.body.tz + (req.body.auto ? ' (auto-detected)' : '')); res.json({ ok: true }); });
app.post('/notices/seen', auth, (req, res) => { db.prepare('UPDATE notices SET seen=1 WHERE user_id=?').run(req.user.id); res.redirect('back'); });

/* ---------- posts ---------- */
app.post('/posts/:id/delete', auth, async (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id=? AND user_id=?').get(req.params.id, req.user.id); if (!p) return res.sendStatus(404);
  let note = 'Deleted';
  if (p.ext_id) { try { const { token } = await accounts.token(req.user.id, 'threads', p.account_id); await threads.client.remove(p.ext_id, token); if (p.reply_ext_id) await threads.client.remove(p.reply_ext_id, token).catch(() => {}); }
    catch (e) { note = `Marked deleted here, but Threads said: ${h(e.message)}. Please delete it in the Threads app too.`; } }
  db.prepare("UPDATE posts SET status='deleted', deleted_at=? WHERE id=?").run(Date.now(), p.id); U(req, 'post.delete', 'post#' + p.id);
  mailer.notify(req.user.id, 'post_deleted', mailer.T.postDeleted({ text: p.text, by: 'user' })).catch(() => {});
  flash(req, 'ok', note); res.redirect('/app');
});
app.post('/posts/:id/cancel', auth, (req, res) => { U(req, 'post.cancel', 'post#' + req.params.id); db.prepare("UPDATE posts SET status='canceled' WHERE id=? AND user_id=? AND status IN ('scheduled','failed','missed')").run(req.params.id, req.user.id); res.redirect('/queue'); });
app.post('/posts/:id/retry', auth, (req, res) => { U(req, 'post.retry', 'post#' + req.params.id); db.prepare("UPDATE posts SET status='scheduled', attempts=0, next_try=NULL, error=NULL, scheduled_at=? WHERE id=? AND user_id=? AND status IN ('failed','missed')").run(Date.now() + 60e3, req.params.id, req.user.id); res.redirect('/queue'); });

function monthCount(uid) { const d = new Date(); return db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=? AND created >= ?').get(uid, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).c; }
const PLATS = ['threads', 'x', 'reddit'], PNAME = { threads: 'Threads', x: 'X', reddit: 'Reddit' }, PLIMIT = { threads: 500, x: 280, reddit: 300 };
// "Post to": one pill toggle per platform, per-account checkboxes underneath, an "All" shortcut, Reddit subreddit + post kind.
function targetPicker(req, p, accs, chosen, avatar) {
  const editing = !!p.id;
  const okChosen = accs.filter(a => chosen.includes(a.id) && (accounts.canPost(a) || editing));
  const chips = PLATS.map(pl => { const n = okChosen.filter(a => a.platform === pl).length; return n ? `<span class="pchip"><span class="pdot ${pl}"></span>${PNAME[pl]} · ${n} account${n > 1 ? 's' : ''}</span>` : ''; }).join('');
  const hidden = okChosen.map(a => `<input type="hidden" name="accounts" value="${a.id}" data-plat="${a.platform}">`).join('');
  const sum = `<div class="ptsum"><div class="ptchips" id="pt-chips" aria-live="polite">${chips || '<span class="muted pt-empty">Choose where to post</span>'}</div>
   ${editing ? '' : `<button type="button" class="btn ghost sm" id="pt-open" aria-haspopup="dialog" aria-controls="ptm">${chips ? 'Edit' : 'Choose'}</button>`}</div><div id="pt-inputs">${hidden}</div>`;
  const cards = PLATS.map(pl => {
    const list = accs.filter(a => a.platform === pl), usable = list.filter(accounts.canPost), ro = list.length - usable.length;
    const meta = !list.length ? 'Not connected' : `${usable.length} account${usable.length === 1 ? '' : 's'} ready${ro ? ` · ${ro} read-only` : ''}`;
    const inner = `<span class="plogo ${pl}" aria-hidden="true">${pl === 'threads' ? '@' : pl === 'x' ? '𝕏' : 'r/'}</span><span class="pc-t"><b>${PNAME[pl]}</b><small>${meta}</small><small class="muted">Limit ${PLIMIT[pl]}${pl === 'reddit' ? ' (title)' : ''} characters</small></span>`;
    return usable.length
      ? `<button type="button" class="pcard" data-plat="${pl}" aria-pressed="false">${inner}<i class="pc-check" aria-hidden="true"></i></button>`
      : `<div class="pcard off" data-plat="${pl}" aria-disabled="true">${inner}<a class="btn ghost sm" href="${list.length ? `/oauth/${pl}/start` : '/connect'}">${list.length ? 'Reconnect' : 'Connect'}</a></div>`;
  }).join('');
  const groups = PLATS.map(pl => {
    const list = accs.filter(a => a.platform === pl); if (!list.length) return '';
    const rows = list.map(a => { const ok = accounts.canPost(a);
      return `<label class="target ${ok ? '' : 'off'}"><input type="checkbox" class="pm-acc" value="${a.id}" data-plat="${pl}" ${ok ? '' : 'disabled'}>${avatar(a)}<span><b>${pl === 'reddit' ? 'u/' : '@'}${h(a.username)}</b><small>${PNAME[pl]}${a.status === 'reconnect' ? ' · needs reconnect' : ''}</small></span>${ok ? '' : `<a class="pill failed recon" href="/oauth/${pl}/start">Reconnect to enable posting</a>`}</label>`; }).join('');
    return `<fieldset class="pmg" data-plat="${pl}" hidden><legend><span class="pdot ${pl}"></span>${PNAME[pl]}</legend><label class="pm-sel"><input type="checkbox" class="pm-pall" data-plat="${pl}"> Select all ${PNAME[pl]}</label><div class="targets">${rows}</div></fieldset>`;
  }).join('');
  const modal = editing ? '' : `<div class="ptm" id="ptm" hidden><div class="ptm-back" data-close></div>
   <div class="ptm-box" role="dialog" aria-modal="true" aria-labelledby="ptm-h" aria-describedby="ptm-d" tabindex="-1">
    <div class="ptm-head"><div><h2 id="ptm-h">Where should this post go?</h2><p id="ptm-d" class="small muted">Step <b id="ptm-n">1</b> of 2 · <span id="ptm-sd">Pick platforms</span></p></div><button type="button" class="ptm-x" data-close aria-label="Close">✕</button></div>
    <ol class="ptm-steps" aria-hidden="true"><li class="on">Platforms</li><li>Accounts</li></ol>
    <section class="ptm-step" data-step="1"><label class="switch-row"><input type="checkbox" id="ptm-allplat"> <span>Select all platforms</span></label><div class="pcards">${cards}</div></section>
    <section class="ptm-step" data-step="2" hidden><label class="switch-row"><input type="checkbox" id="ptm-allacc"> <span>Select all accounts</span></label><div class="pmgs">${groups}</div></section>
    <p class="field-err" id="ptm-err" aria-live="polite"></p>
    <div class="ptm-foot"><button type="button" class="btn ghost" id="ptm-cancel" data-close>Cancel</button><span class="sp"></span><button type="button" class="btn ghost" id="ptm-back" hidden>Back</button><button type="button" class="btn" id="ptm-next">Next</button><button type="button" class="btn" id="ptm-apply" hidden>Apply</button></div>
   </div></div>`;
  const sub = h((p.subreddit || req.session.lastSub || ''));
  return `${sum}${modal}
   <p id="target-err" class="field-err" aria-live="polite"></p>
   <div id="redditbox" class="redditbox" ${okChosen.some(a => a.platform === 'reddit') ? '' : 'hidden'}>
    <label for="subreddit">Subreddit <span class="req">required for Reddit</span></label><div class="prefix-in"><span>r/</span><input id="subreddit" name="subreddit" value="${sub}" placeholder="socialmedia" pattern="[A-Za-z0-9_]{2,21}" autocomplete="off"></div>
    <div class="seg sm"><label><input type="radio" name="reddit_kind" value="self" ${p.reddit_kind === 'link' ? '' : 'checked'}><span>Text post</span></label><label><input type="radio" name="reddit_kind" value="link" ${p.reddit_kind === 'link' ? 'checked' : ''}><span>Link post (uses the Link field)</span></label></div>
    <p class="help">The first line of your text becomes the Reddit title (max 300). Follow each subreddit's rules.</p></div>
   <p class="small muted">${editing ? 'Editing keeps the original platform and account.' : 'One post is created per selected account, so each platform has its own queue entry, retries and stats.'}</p>`;
}
function composeForm(req, p = {}) {
  const imgs = db.prepare('SELECT * FROM images WHERE user_id=? AND used=0 ORDER BY score DESC, id DESC LIMIT 40').all(req.user.id);
  const sel = new Set(JSON.parse(p.image_ids || '[]'));
  const tz = req.user.tz || '';
  const freeLeft = req.premium ? null : Math.max(0, Number(S.get('free_limit')) - monthCount(req.user.id));
  const opt = (v, l, cur) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`;
  const accs = accounts.list(req.user.id).filter(a => PLATS.includes(a.platform)), th = accs.filter(a => a.platform === 'threads');
  const chosen = p.account_id ? [p.account_id] : (req.session.lastTargets || th.filter(accounts.canPost).slice(0, 1).map(a => a.id));
  const avatar = a => a.avatar ? `<img class="ava" src="${h(a.avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="ava">${h((a.username || '?')[0].toUpperCase())}</span>`;
  const accData = h(JSON.stringify(accs.map(a => ({ id: a.id, p: a.platform, u: a.username, av: a.avatar || '' }))));
  const tzWhen = p.scheduled_at && tz ? new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(p.scheduled_at)).replace(' ', 'T') : '';
  return `<div class="page-h"><h1>${p.id ? t('Edit post') : t('Compose & schedule')}</h1>${freeLeft != null ? `<span class="pill">${freeLeft} free posts left this month</span>` : ''}</div>
  ${accs.some(accounts.canPost) ? '' : '<div class="alert info">Connect a Threads, X or Reddit account first to publish. <a href="/connect">Connect →</a></div>'}
  <form method="post" action="/compose" class="compose-grid" id="compose" data-accounts="${accData}" data-at="${p.scheduled_at || ''}"><input type="hidden" name="id" value="${p.id || ''}">
  <div class="card"><h3 class="ct" id="postto-h">Post to</h3>
   ${targetPicker(req, p, accs, chosen, avatar)}
   <div class="seg" style="margin-top:14px"><label><input type="radio" name="wmode" value="manual" checked><span>✍️ Manual</span></label><label><input type="radio" name="wmode" value="ai"><span>🤖 AI</span></label></div>
   <div id="aibox" hidden class="card" style="margin-top:12px;padding:14px">${ai.keyNow() ? '' : '<p class="small muted">Add your OpenAI key in <a href="/settings#ai">Settings → AI writing</a> to generate drafts.</p>'}
    <label for="topic">Topic</label><input id="topic" placeholder="e.g. productivity tips for freelancers"><label for="tone">Tone</label><select id="tone"><option>friendly</option><option>bold</option><option>funny</option><option>professional</option></select>
    <button type="button" class="btn sm" id="genbtn" style="margin-top:12px">Generate</button></div>
   <label for="ptext">${t('Post text')} <span id="cc" class="muted small"></span></label><textarea id="ptext" name="text" maxlength="500" required>${h(p.text || req.session.draft || S.get('caption_default') || '')}</textarea>
   <div class="counters" id="counters"></div>
   <label>${t('Post type')}</label><select name="media_type">${opt('TEXT', 'Text', p.media_type)}${opt('IMAGE', 'Image', p.media_type)}${opt('CAROUSEL', 'Carousel (2–20)', p.media_type)}${opt('VIDEO', 'Short video (Reels-style)', p.media_type)}</select>
   <label>${t('Pick from your media library (unused only)')}</label>
   <div class="imgs">${imgs.map(i => `<label class="it" style="margin:0"><input type="checkbox" name="image_ids" value="${i.id}" ${sel.has(i.id) ? 'checked' : ''} style="position:absolute;top:8px;right:8px;z-index:2">${/\.(mp4|mov)/i.test(i.url) ? `<video src="${h(i.url)}" muted style="width:100%;height:130px;object-fit:cover"></video>` : `<img src="${h(i.url)}" loading="lazy" alt="">`}<div class="meta">score ${i.score ?? '–'}</div></label>`).join('') || '<p class="muted small">No media yet. <a href="/media">Add images</a></p>'}</div>
   <label>…or public media URLs, one per line</label><textarea name="media_urls" style="min-height:70px" placeholder="https://res.cloudinary.com/...jpg">${h(JSON.parse(p.media_urls || '[]').filter(u => !imgs.some(i => i.url === u)).join('\n'))}</textarea>
   <label>${t('Link (optional)')}</label><input name="link" type="url" value="${h(p.link || '')}" placeholder="https://...">
   <label class="check"><input type="checkbox" name="link_reply" value="1" ${p.link_reply ? 'checked' : ''}> Post link as first reply</label>
   <label class="check"><input type="checkbox" name="disclosure" value="1" ${(p.id ? p.disclosure : req.user.def_disclosure) === 0 ? '' : 'checked'}> Add “#ad / affiliate” disclosure when a link is included</label></div>
  <div class="side-col"><div class="card"><h3 class="ct">When to post</h3>
   <div class="seg"><label><input type="radio" name="smode" value="exact" ${req.user.def_smode === 'auto' && !p.id ? '' : 'checked'}><span>📅 Exact time</span></label><label><input type="radio" name="smode" value="auto" ${req.user.def_smode === 'auto' && !p.id ? 'checked' : ''}><span>⚡ Auto slot (US prime)</span></label></div>
   <div id="exactbox"><input type="hidden" name="when" value="${tzWhen}">
    <div class="dt-row"><div class="picker" id="datepk"><label for="date-in">Date</label><button type="button" class="pk-field" id="date-in" aria-haspopup="dialog" aria-expanded="false"><span>📅</span><span class="v">Pick a date</span></button><div class="pop-cal" hidden role="dialog" aria-label="Choose date"></div></div>
    <div class="picker" id="timepk"><label for="time-in">Time</label><div class="pk-field time"><span>🕒</span><input id="time-in" inputmode="numeric" autocomplete="off" placeholder="09:30 PM" aria-describedby="time-err"><button type="button" class="pk-btn" aria-label="Open clock" aria-haspopup="dialog" aria-expanded="false">▾</button></div>
     <div class="pop-time" hidden role="dialog" aria-label="Choose time"></div></div></div>
    <p id="time-err" class="field-err" aria-live="polite"></p>
    <label>Time zone <span class="tz-auto small muted"></span></label>${tzPicker('tz', tz, 'compose-tz', true, req.user.tz_auto === 1)}
    <div id="tzout" class="tzout small"></div></div>
   <label>${t('Mode')}</label><select name="batch"><option value="1">Single post</option><option value="2">Batch of 2 posts</option></select>
   <div id="batchbox" hidden><label>Second post text (batch)</label><textarea name="text2" maxlength="500" style="min-height:80px"></textarea>
   <label>Gap between batch posts (minutes)</label><input type="number" name="gap" value="180" min="5"></div>
   <div style="margin-top:20px"><button class="btn lg shimmer" type="submit" style="width:100%">${p.id ? 'Save changes' : 'Schedule'}</button></div></div>
  <div class="card preview"><div class="row" style="justify-content:space-between"><h3 class="ct" style="margin:0">Live preview</h3><div class="tabs" role="tablist">${[['threads', 'Threads'], ['reddit', 'Reddit'], ['x', 'X']].map(([k, n], i) => `<button type="button" role="tab" class="tab ${i ? '' : 'on'}" data-tab="${k}" aria-selected="${!i}">${n}</button>`).join('')}</div></div>
   <div id="pv" class="pv"></div><p class="small muted" id="pvnote"></p></div></div></form>`;
}
app.get('/compose', auth, (req, res) => {
  const p = req.query.id ? db.prepare('SELECT * FROM posts WHERE id=? AND user_id=?').get(req.query.id, req.user.id) : undefined;
  const html = composeForm(req, p); delete req.session.draft; res.page('Compose', html, { active: '/compose', scripts: ['/compose.js'] });
});
app.post('/compose', auth, (req, res) => {
  const b = req.body, uid = req.user.id;
  try {
    const ids = [].concat(b.image_ids || []).map(Number).filter(Boolean);
    const libUrls = ids.length ? db.prepare(`SELECT id,url FROM images WHERE user_id=? AND used=0 AND id IN (${ids.map(() => '?').join(',')})`).all(uid, ...ids) : [];
    const urls = [...libUrls.map(i => i.url), ...String(b.media_urls || '').split(/\s+/).filter(u => /^https:\/\//.test(u))];
    const mt = ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'].includes(b.media_type) ? b.media_type : 'TEXT';
    if (mt === 'IMAGE' || mt === 'VIDEO') { if (urls.length < 1) throw new Error('Add 1 media item'); }
    if (mt === 'CAROUSEL' && (urls.length < 2 || urls.length > 20)) throw new Error('Carousel needs 2–20 items');
    const base = { media_type: mt, media_urls: JSON.stringify(mt === 'TEXT' ? [] : urls), image_ids: JSON.stringify(libUrls.map(i => i.id)), link: b.link || null, link_reply: b.link_reply ? 1 : 0, disclosure: b.disclosure ? 1 : 0 };
    const texts = [b.text, b.batch === '2' && !b.id ? (b.text2 || '') : null].filter(x => x != null);
    if (!texts[0] || !texts[0].trim()) throw new Error('Text required');
    // targets: one row per selected account (any platform). Editing keeps the original row's platform/account.
    const own = accounts.list(uid).filter(a => PLATS.includes(a.platform));
    const editRow = b.id ? db.prepare('SELECT * FROM posts WHERE id=? AND user_id=?').get(b.id, uid) : null;
    let targets = editRow ? [own.find(a => a.id === editRow.account_id) || { id: editRow.account_id, platform: editRow.platform || 'threads', scope: null, _legacy: true }]
      : [].concat(b.accounts || []).map(Number).map(id => own.find(a => a.id === id)).filter(Boolean);
    if (!editRow && !targets.length) throw new Error('Choose at least one platform account to post to');
    const blocked = targets.filter(a => !a._legacy && !accounts.canPost(a));
    if (blocked.length) throw new Error(`Reconnect ${blocked.map(a => PNAME[a.platform] + ' @' + h(a.username)).join(', ')} to enable posting`);
    const plats = [...new Set(targets.map(a => a.platform))];
    const sub = String(b.subreddit || '').trim().replace(/^\/?r\//i, '');
    if (plats.includes('reddit')) {
      if (!sub) throw new Error('Subreddit is required when posting to Reddit');
      if (!/^[A-Za-z0-9_]{2,21}$/.test(sub)) throw new Error('Subreddit name is not valid (letters, numbers, underscore, 2–21 chars)');
      if (b.reddit_kind === 'link' && !b.link) throw new Error('A Reddit link post needs the Link field');
    }
    const rkind = b.reddit_kind === 'link' ? 'link' : 'self';
    for (const tx of texts) { if (!tx.trim()) throw new Error('Text required');
      for (const pl of plats) {
        if (pl === 'reddit') { const r = W.redditParts({ ...base, text: tx, reddit_kind: rkind }); if (!r.title) throw new Error('Reddit needs a title: write it on the first line'); if (r.title.length > 300) throw new Error(`Reddit title is ${r.title.length} characters (max 300). Shorten the first line.`); }
        else { const r = W.buildTexts({ ...base, text: tx }, PLIMIT[pl]); if (r.overflow) throw new Error(`Too long for ${PNAME[pl]}: ${r.length} characters including link/disclosure (max ${PLIMIT[pl]}). Shorten it or untick ${PNAME[pl]}.`); }
      } }
    let times;
    if (b.smode === 'auto') {
      const taken = db.prepare("SELECT scheduled_at FROM posts WHERE user_id=? AND status='scheduled'").all(uid).map(r => r.scheduled_at);
      times = autoSlots(Date.now(), texts.length, taken);
    } else {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.when || '')) throw new Error('Choose a date and a valid time (HH:MM AM/PM)');
      const zone = validTz(b.tz) ? b.tz : (req.user.tz || DHAKA);
      if (validTz(b.tz) && b.tz !== req.user.tz) db.prepare('UPDATE users SET tz=? WHERE id=?').run(b.tz, uid);
      const at = parseLocal(b.when, zone);
      if (at < Date.now() - 60e3) throw new Error('Time is in the past');
      times = texts.map((_, i) => at + i * Math.max(5, Number(b.gap) || 180) * 60e3);
    }
    if (b.id) {
      const r = db.prepare("UPDATE posts SET text=?, media_type=?, media_urls=?, image_ids=?, link=?, link_reply=?, disclosure=?, scheduled_at=?, status='scheduled', attempts=0, next_try=NULL, error=NULL, auto_slot=?, subreddit=COALESCE(?,subreddit), reddit_kind=COALESCE(?,reddit_kind) WHERE id=? AND user_id=? AND status IN ('scheduled','failed','missed','canceled')")
        .run(texts[0], base.media_type, base.media_urls, base.image_ids, base.link, base.link_reply, base.disclosure, times[0], b.smode === 'auto' ? 1 : 0, plats.includes('reddit') ? sub : null, plats.includes('reddit') ? rkind : null, b.id, uid);
      if (!r.changes) throw new Error('This post can no longer be edited');
      U(req, 'post.edit', 'post#' + b.id, 'scheduled ' + new Date(times[0]).toISOString()); flash(req, 'ok', 'Updated'); return res.redirect('/queue');
    }
    if (!req.premium && monthCount(uid) + texts.length * targets.length > Number(S.get('free_limit'))) throw new Error(`Free plan limit reached (${S.get('free_limit')}/month). <a href="/billing">Upgrade</a>`);
    const batch = texts.length > 1 ? crypto.randomUUID() : null;
    const ins = db.prepare('INSERT INTO posts(user_id,platform,text,media_type,media_urls,image_ids,link,link_reply,disclosure,scheduled_at,batch_id,auto_slot,created,account_id,subreddit,reddit_kind,target_group) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const made = [], group = crypto.randomUUID();
    db.transaction(() => { for (const acc of targets) texts.forEach((tx, i) => made.push(ins.run(uid, acc.platform, tx, base.media_type, base.media_urls, base.image_ids, base.link, base.link_reply, base.disclosure, times[i], batch, b.smode === 'auto' ? 1 : 0, Date.now(), acc.id,
      acc.platform === 'reddit' ? sub : null, acc.platform === 'reddit' ? rkind : null, group).lastInsertRowid)); })();
    req.session.lastTargets = targets.map(a => a.id); if (sub) req.session.lastSub = sub;
    U(req, 'post.schedule', made.map(x => 'post#' + x).join(','), `${made.length} post(s) to ${plats.map(x => PNAME[x]).join(' + ')}, ${targets.length} account(s), first ${new Date(times[0]).toISOString()}`);
    const zt = req.user.tz || DHAKA;
    flash(req, 'ok', `Scheduled ${made.length} post(s) on ${plats.map(x => PNAME[x]).join(', ')} for ${times.map(x => fmt(x, zt) + ' (' + zt + ') / ' + fmt(x, NY) + ' NY').join('; ')}`);
    res.redirect('/queue');
  } catch (e) { flash(req, 'err', e.message); res.redirect('/compose' + (b.id ? '?id=' + b.id : '')); }
});
const retryInfo = p => {
  if (p.status === 'failed' && /^Needs reconnect/.test(p.error || '')) return '<div class="small"><a class="pill failed" href="/connect">Needs reconnect</a></div>';
  if (p.status === 'scheduled' && p.attempts && p.next_try) return `<div class="small retry">↻ Retry ${p.attempts}/${W.MAX_ATTEMPTS} · next ${fmt(p.next_try, req_tz(p))}</div>`;
  if (p.status === 'failed' && p.attempts) return `<div class="small muted">Gave up after ${p.attempts} tr${p.attempts > 1 ? 'ies' : 'y'}</div>`;
  return '';
};
const req_tz = () => DHAKA;
app.get('/queue', auth, (req, res) => {
  const rows = db.prepare("SELECT * FROM posts WHERE user_id=? AND status IN ('scheduled','posting','failed','missed') ORDER BY scheduled_at").all(req.user.id);
  res.page('Queue', `<div class="page-h"><h1>${t('Scheduled queue')}</h1><a class="btn" href="/compose">+ New</a></div>
  <div class="card tbl"><table><thead><tr><th>Status</th><th>Post</th><th>When</th><th></th></tr></thead><tbody>
  ${rows.map(p => `<tr><td><span class="pill ${p.status}">${p.status}</span>${p.auto_slot ? ' <span class="tag">auto</span>' : ''}${p.batch_id ? ' <span class="tag">batch</span>' : ''}${retryInfo(p)}</td>
   <td style="max-width:420px">${h((p.text || '').slice(0, 160))}<div class="muted small">${p.media_type}${p.link ? ' · 🔗' + (p.link_reply ? ' in reply' : '') : ''}${p.error ? ' · ⚠ ' + h(p.error) : ''}</div></td><td>${ts(p.scheduled_at)}</td>
   <td class="row" style="flex-wrap:nowrap;gap:6px">${p.status !== 'posting' ? `<a class="btn ghost sm" href="/compose?id=${p.id}">Edit</a>` : ''}${['failed', 'missed'].includes(p.status) ? `<form method="post" action="/posts/${p.id}/retry"><button class="btn sm">Retry</button></form>` : ''}
   ${p.status !== 'posting' ? `<form method="post" action="/posts/${p.id}/cancel"><button class="btn danger sm">Cancel</button></form>` : ''}</td></tr>`).join('') || '<tr><td colspan=4 class="muted">Queue is empty</td></tr>'}
  </tbody></table></div><p class="muted small">Worker checks every 30 seconds. Missed by more than 15 minutes (server offline) → marked “missed”, never posted late.</p>`, { active: '/queue' });
});
app.get('/calendar', auth, (req, res) => {
  const now = new Date(Date.now() + 6 * 3600e3);
  const [Y, M] = (/^\d{4}-\d{2}$/.test(req.query.m || '') ? req.query.m : now.toISOString().slice(0, 7)).split('-').map(Number);
  const start = Date.UTC(Y, M - 1, 1) - 6 * 3600e3, end = Date.UTC(Y, M, 1) - 6 * 3600e3;
  const posts = db.prepare("SELECT id,text,status,scheduled_at,published_at FROM posts WHERE user_id=? AND status NOT IN ('canceled') AND COALESCE(published_at,scheduled_at) BETWEEN ? AND ?").all(req.user.id, start, end);
  const byDay = {}; for (const p of posts) { const d = new Date((p.published_at || p.scheduled_at) + 6 * 3600e3).getUTCDate(); (byDay[d] = byDay[d] || []).push(p); }
  const first = new Date(Date.UTC(Y, M - 1, 1)).getUTCDay(), days = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const prev = new Date(Date.UTC(Y, M - 2, 1)).toISOString().slice(0, 7), next = new Date(Date.UTC(Y, M, 1)).toISOString().slice(0, 7);
  let cells = '<div class="d" style="visibility:hidden"></div>'.repeat(first);
  for (let d = 1; d <= days; d++) { const today = Y === now.getUTCFullYear() && M === now.getUTCMonth() + 1 && d === now.getUTCDate();
    cells += `<div class="d ${today ? 'today' : ''}"><span class="num">${d}</span>${(byDay[d] || []).map(p => `<a class="ev ${p.status}" href="/compose?id=${p.id}" title="${h(p.text)}">${new Date((p.published_at || p.scheduled_at) + 6 * 3600e3).toISOString().slice(11, 16)} ${h((p.text || '').slice(0, 30))}</a>`).join('')}</div>`; }
  res.page('Calendar', `<div class="page-h"><h1>${t('Calendar')} — ${new Date(Date.UTC(Y, M - 1, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h1>
  <div class="row" style="flex:none"><a class="btn ghost sm" href="?m=${prev}">← Prev</a><a class="btn ghost sm" href="?m=${next}">Next →</a></div></div>
  <p class="muted small">Times shown in Dhaka (UTC+6).</p>
  <div class="cal">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="muted small" style="text-align:center">${d}</div>`).join('')}${cells}</div>`, { active: '/calendar' });
});

/* ---------- AI ---------- */
app.post('/api/ai/generate', auth, async (req, res) => { try { res.json({ text: (await ai.generate(req.body.topic, req.body.tone, req.body.lang)).slice(0, 500) }); } catch (e) { res.json({ error: e.message }); } });
app.get('/api/slots', auth, (req, res) => res.json(autoSlots(Date.now(), Number(req.query.n) || 4).map(x => ({ at: x, dhaka: fmt(x, DHAKA), ny: fmt(x, NY) }))));

/* ---------- media ---------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
app.get('/media', auth, (req, res) => {
  const imgs = db.prepare('SELECT * FROM images WHERE user_id=? ORDER BY id DESC LIMIT 120').all(req.user.id);
  const hashes = db.prepare('SELECT hash FROM images WHERE user_id=?').all(req.user.id).map(r => r.hash);
  const g = accounts.get(req.user.id, 'google');
  res.page('Media', `<div class="page-h"><h1>${t('Media library')}</h1><span class="pill">${media.cloudinaryOn() ? '☁ Cloudinary' : '💾 Local volume (set Cloudinary in Settings)'}</span></div>
  ${req.query.up != null ? `<div class="alert ok">Uploaded ${h(req.query.up)} · skipped duplicates ${h(req.query.dup)}</div>` : ''}
  <div class="grid g2"><div class="card"><h3 style="margin-top:0">📁 ${t('Local folder mode')}</h3><p class="muted small">Choose a folder on your computer. Images are scored in your browser (resolution, contrast, sharpness); only the ones you select are uploaded.</p>
   <div class="row"><label class="btn ghost" style="margin:0;flex:none">Choose folder<input type="file" id="folder" webkitdirectory directory multiple hidden></label><button type="button" class="btn ghost" id="fsabtn" style="flex:none">Open folder (File System Access)</button></div>
   <p id="lstatus" class="small muted"></p><div class="imgs" id="lgrid"></div><button class="btn" id="upbtn" disabled style="margin-top:14px">Upload selected</button></div>
  <div class="card"><h3 style="margin-top:0">🎬 ${t('Upload video or single file')}</h3><form method="post" action="/media/upload" enctype="multipart/form-data"><input type="file" name="file" accept="image/*,video/mp4,video/quicktime" required><button class="btn sm" type="submit" style="margin-top:10px">Upload</button></form>
   <h3>☁ ${t('Google Drive (optional)')}</h3>${g ? `<form method="post" action="/media/drive"><label>Folder ID (from the Drive URL)</label><input name="folder" required><button class="btn sm" style="margin-top:10px">Import images</button></form>` : S.ready('google') ? '<a class="btn ghost sm" href="/oauth/google/start">Connect Google Drive</a>' : '<button class="btn ghost sm" disabled>Connect Google Drive</button> <span class="muted small">Not available yet</span>'}</div></div>
  <h2>${t('Library')} <span class="muted small">(used images are never reused</span></h2>
  <div class="imgs">${imgs.map(i => `<div class="it">${/\.(mp4|mov)/i.test(i.url) ? `<video src="${h(i.url)}" muted style="width:100%;height:130px;object-fit:cover"></video>` : `<img src="${h(i.url)}" loading="lazy" alt="">`}<div class="meta">${i.used ? '✅ used' : 'available'} · ${h(i.source)}${i.score != null ? ' · ' + i.score : ''}</div></div>`).join('') || '<p class="muted">Empty</p>'}</div>
  <div id="used-hashes" hidden data-h="${h(JSON.stringify(hashes))}"></div><script src="/images.js"></script>`, { active: '/media' });
});
app.post('/media/upload', auth, upload.single('file'), async (req, res) => {
  const json = !/text\/html/.test(req.get('accept') || '');
  try {
    if (!req.file || !/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime))$/.test(req.file.mimetype)) throw new Error('JPEG/PNG/WEBP or MP4/MOV only');
    const r = await media.store(req.user.id, req.file.buffer, req.file.mimetype, 'local', req.body.score ? Number(req.body.score) : null, baseUrl(req));
    json ? res.json(r) : res.redirect('/media?up=' + (r.duplicate ? 0 : 1) + '&dup=' + (r.duplicate ? 1 : 0));
  } catch (e) { json ? res.status(400).json({ error: e.message }) : (flash(req, 'err', h(e.message)), res.redirect('/media')); }
});
app.post('/media/drive', auth, async (req, res) => {
  try { const { token } = await accounts.token(req.user.id, 'google'); const files = await google.list(token, String(req.body.folder)); let n = 0;
    for (const f of files.slice(0, 30)) { const buf = await google.download(token, f.id); const r = await media.store(req.user.id, buf, f.mimeType, 'drive', null, baseUrl(req)); if (!r.duplicate) n++; }
    flash(req, 'ok', `Imported ${n} new images from Drive`);
  } catch (e) { flash(req, 'err', h(e.message)); }
  res.redirect('/media');
});

/* ---------- OAuth connect ---------- */
const redirectFor = (req, p) => `${baseUrl(req)}/oauth/${p}/callback`;
app.get('/connect', auth, (req, res) => {
  const all = accounts.list(req.user.id);
  const row = a => `<div class="acct-row">${a.avatar ? `<img class="ava" src="${h(a.avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="ava">${h((a.username || '?')[0].toUpperCase())}</span>`}
    <div class="grow"><b>@${h(a.username)}</b><div class="small muted">connected ${fmt(a.created, DHAKA).split(',')[0]}</div></div>
    ${a.status === 'reconnect' ? `<a class="pill failed" href="/oauth/${a.platform}/start">Needs reconnect</a>` : !accounts.canPost(a) ? `<a class="pill failed recon" href="/oauth/${a.platform}/start" title="Connected with read-only access before posting was added">Reconnect to enable posting</a>` : '<span class="pill published">Connected</span>'}
    <form method="post" action="/connect/account/${a.id}/disconnect" data-confirm="Disconnect @${h(a.username)}?"><button class="btn ghost sm" aria-label="Disconnect @${h(a.username)}">Disconnect</button></form></div>`;
  const card = (p, name, desc, badge) => { const list = all.filter(a => a.platform === p), ready = S.ready(p);
    const btn = !ready ? `<div class="na-box"><span class="na-ico" aria-hidden="true">🔒</span><div><b>Not available yet</b><p class="small muted">The site owner hasn't enabled ${name} yet. Once they do, a Connect button will appear here and you'll sign in on ${name}'s own page — you never need to enter any keys or passwords here.</p></div></div><button class="btn ghost sm" disabled aria-disabled="true">Connect ${name}</button>`
      : `<a class="btn ${list.length ? 'ghost' : ''}" href="/oauth/${p}/start">${list.length ? '+ Add another account' : 'Connect ' + name}</a>`;
    return `<div class="card" data-platform="${p}"><div class="row" style="justify-content:space-between"><h3 style="margin:0;flex:none">${name}</h3><span style="flex:none">${ready ? badge : ''}</span></div><p class="muted small">${desc}</p>
      <div class="acct-list">${list.map(row).join('') || '<p class="small muted">No accounts connected</p>'}</div>${list.length ? `<p class="small muted">${list.length} account${list.length > 1 ? 's' : ''}</p>` : ''}<div style="margin-top:12px">${btn}</div></div>`; };
  res.page('Accounts', `<div class="page-h"><h1>${t('Connected accounts')}</h1></div>
   <p class="muted">Click <b>Connect</b>, approve access on the platform's own login page, and you are done. You can connect several accounts per platform. To add a different account, sign in to it on the platform first (or switch accounts there) and click <b>Add another account</b>.</p><div class="grid g3">
   ${card('threads', 'Threads', 'Publishing: text, image, carousel, video. Insights for reach. Pick which account(s) to post to in the composer.', '<span class="pill published">publishing</span>')}
   ${card('x', 'X (Twitter)', 'Publishing: posts you write and schedule (text, up to 4 images). Recent search for analysis. Never likes, replies to others or follows.', '<span class="pill published">publishing</span>')}
   ${card('reddit', 'Reddit', 'Publishing: text or link posts to the subreddit you choose per post. Top/rising for analysis. Never comments or votes.', '<span class="pill published">publishing</span>')}</div>`, { active: '/connect' });
});
app.post('/connect/account/:id/disconnect', auth, (req, res) => {
  const a = db.prepare('SELECT platform,username FROM accounts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (a) { accounts.remove(req.user.id, req.params.id); U(req, 'account.disconnect', `${a.platform}:@${a.username}`); flash(req, 'ok', `@${h(a.username)} disconnected`); }
  res.redirect('/connect');
});
app.post('/connect/:p/disconnect', auth, (req, res) => { db.prepare('DELETE FROM accounts WHERE user_id=? AND platform=?').run(req.user.id, req.params.p); U(req, 'account.disconnect', req.params.p + ':all'); res.redirect('/connect'); });
app.get('/oauth/:p/start', auth, (req, res) => {
  if (['threads', 'reddit', 'x', 'google'].includes(req.params.p) && !S.ready(req.params.p)) { flash(req, 'err', 'This platform is not available yet.'); return res.redirect('/connect'); }
  const p = req.params.p, state = crypto.randomBytes(16).toString('hex'), redirect = redirectFor(req, p); let url, verifier = null;
  if (p === 'threads') url = threads.real.authorizeUrl({ appId: S.get('threads_app_id'), redirect, state, extraScopes: S.get('threads_keyword') === 'yes' ? ',threads_keyword_search' : '' });
  else if (p === 'reddit') url = reddit.authorizeUrl({ clientId: S.get('reddit_client_id'), redirect, state });
  else if (p === 'x') { const k = xapi.pkce(); verifier = k.verifier; url = xapi.authorizeUrl({ clientId: S.get('x_client_id'), redirect, state, challenge: k.challenge }); }
  else if (p === 'google') url = google.authorizeUrl({ clientId: S.get('google_client_id'), redirect, state });
  else return res.sendStatus(404);
  req.session.oauthReturn = p === 'google' ? '/media' : '/connect';
  db.prepare('INSERT INTO oauth_state(state,user_id,platform,verifier,created) VALUES(?,?,?,?,?)').run(state, req.user.id, p, verifier, Date.now());
  res.redirect(url);
});
app.get('/oauth/:p/callback', auth, async (req, res) => {
  const p = req.params.p, st = db.prepare('SELECT * FROM oauth_state WHERE state=? AND platform=?').get(String(req.query.state || ''), p);
  db.prepare('DELETE FROM oauth_state WHERE state=? OR created < ?').run(String(req.query.state || ''), Date.now() - 3600e3);
  try {
    if (!st || st.user_id !== req.user.id) throw new Error('Invalid or expired login state - try again');
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const code = String(req.query.code || '').replace(/#_$/, ''), redirect = redirectFor(req, p);
    if (p === 'threads') { const r = await threads.client.exchangeCode({ appId: S.get('threads_app_id'), appSecret: S.get('threads_app_secret'), redirect, code }); const me = await threads.client.me(r.token);
      accounts.save(req.user.id, 'threads', { extId: me.id || r.userId, username: me.username, avatar: me.threads_profile_picture_url, token: r.token, expiresIn: r.expiresIn }); }
    else if (p === 'reddit') { const r = await reddit.token(S.get('reddit_client_id'), S.get('reddit_client_secret'), { grant_type: 'authorization_code', code, redirect_uri: redirect }); const me = await reddit.me(r.token);
      accounts.save(req.user.id, 'reddit', { extId: me.id, username: me.name, avatar: String(me.icon_img || me.snoovatar_img || '').split('?')[0] || null, ...r }); }
    else if (p === 'x') { const r = await xapi.token(S.get('x_client_id'), S.get('x_client_secret'), { grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: st.verifier }); const me = await xapi.me(r.token);
      accounts.save(req.user.id, 'x', { extId: me.id, username: me.username, avatar: me.profile_image_url, ...r }); }
    else if (p === 'google') { const r = await google.token({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: S.get('google_client_id'), client_secret: S.get('google_client_secret') });
      accounts.save(req.user.id, 'google', { extId: 'drive', username: 'Google Drive', ...r }); return res.redirect('/media'); }
    U(req, 'account.connect', p); flash(req, 'ok', `${({ threads: 'Threads', reddit: 'Reddit', x: 'X' })[p] || p} connected`);
  } catch (e) { flash(req, 'err', `Connection failed: ${h(e.message)}`); }
  const back = req.session.oauthReturn || '/connect'; delete req.session.oauthReturn; res.redirect(back);
});
// Meta requires these callback URLs in the Threads app settings
app.post('/oauth/threads/uninstall', (req, res) => res.json({ ok: true }));
app.post('/oauth/threads/delete', (req, res) => { const code = crypto.randomBytes(8).toString('hex'); res.json({ url: `${baseUrl(req)}/healthz`, confirmation_code: code }); });

/* ---------- competitive analysis (premium) ---------- */
app.get('/insights', auth, premium, (req, res) => res.page('Competitors', insightsPage(req, null), { active: '/insights' }));
function insightsPage(req, out) {
  const acc = Object.fromEntries(accounts.list(req.user.id).map(a => [a.platform, 1]));
  const list = items => `<div class="tbl"><table><thead><tr><th>Score</th><th>Post</th><th>Metrics</th></tr></thead><tbody>${items.slice(0, 15).map(i => `<tr><td><b>${i.score}</b><div class="tag">${h(i.media)}</div></td><td style="max-width:520px">${h(i.text.slice(0, 220))} <a href="${h(i.url)}" target="_blank" rel="noopener">↗</a></td><td class="small">${Object.entries(i.metrics || {}).map(([k, v]) => `${k}: ${v ?? '–'}`).join('<br>')}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="page-h"><h1>${t('Competitive analysis')}</h1><span class="pill">Read-only research</span></div>
  <form method="post" action="/insights" class="card"><div class="grid g3">
   <div><label>X search (last 24h)</label><input name="xq" value="${h(req.body && req.body.xq || '')}" placeholder="productivity tips" ${acc.x ? '' : 'disabled'}>${acc.x ? '' : '<p class="small muted"><a href="/connect">Connect X</a></p>'}</div>
   <div><label>Subreddits (comma)</label><input name="subs" value="${h(req.user.subreddits)}" placeholder="Entrepreneur, socialmedia" ${acc.reddit ? '' : 'disabled'}>${acc.reddit ? '' : '<p class="small muted"><a href="/connect">Connect Reddit</a></p>'}</div>
   <div><label>Threads keyword</label><input name="tq" value="${h(req.body && req.body.tq || '')}" placeholder="side hustle"></div></div>
   <button class="btn" style="margin-top:16px">Analyse</button></form>
  ${out ? `<div class="card" style="margin-top:20px"><h2 style="margin-top:0">${t('Patterns')} <span class="tag">${out.sum.by}</span></h2><pre style="white-space:pre-wrap;font-family:inherit">${h(out.sum.summary)}</pre>
   <form method="post" action="/insights/draft" class="row"><input type="hidden" name="summary" value="${h(out.sum.summary)}"><input name="topic" placeholder="Your topic" required><button class="btn" style="flex:none">✨ Draft inspired by pattern</button></form>
   <p class="small muted">Drafts are original text — nothing is copied from these posts.</p></div>
   ${out.errors.map(e => `<div class="alert err" style="margin-top:12px">${h(e)}</div>`).join('')}
   ${out.x.length ? `<h3>X — top by engagement (24h)</h3>${list(out.x)}` : ''}${out.reddit.length ? `<h3>Reddit — top & rising</h3>${list(out.reddit)}` : ''}${out.threads ? `<h3>Threads keyword search</h3>${out.threads.length ? list(out.threads) : '<p class="muted">No results</p>'}` : ''}` : ''}`;
}
app.post('/insights', auth, premium, async (req, res) => {
  const out = { x: [], reddit: [], threads: null, errors: [] };
  const subs = String(req.body.subs || '').split(',').map(s => s.trim().replace(/^r\//, '')).filter(s => /^\w{2,21}$/.test(s)).slice(0, 5);
  if (req.body.subs != null) db.prepare('UPDATE users SET subreddits=? WHERE id=?').run(subs.join(', '), req.user.id), req.user.subreddits = subs.join(', ');
  if (req.body.xq) try { out.x = await accounts.withToken(req.user.id, 'x', tk => xapi.search(tk, String(req.body.xq))); } catch (e) { out.errors.push('X: ' + e.message); }
  for (const s of subs) try { out.reddit.push(...await accounts.withToken(req.user.id, 'reddit', async tk => [...await reddit.listing(tk, s, 'top'), ...await reddit.listing(tk, s, 'rising')])); } catch (e) { out.errors.push(`Reddit r/${s}: ${e.message}`); }
  out.reddit.sort((a, b) => b.score - a.score);
  if (req.body.tq) try { out.threads = (await accounts.withToken(req.user.id, 'threads', tk => threads.client.keywordSearch(tk, String(req.body.tq)))).map(p => ({ platform: 'threads', text: p.text || '', url: p.permalink, score: '–', media: (p.media_type || 'text').toLowerCase(), metrics: { by: '@' + p.username } })); }
    catch (e) { out.errors.push('Threads keyword search not available for this app/account (needs threads_keyword_search permission): ' + e.message); }
  out.sum = await ai.summarize([...out.x, ...out.reddit, ...(out.threads || [])]);
  res.page('Competitors', insightsPage(req, out), { active: '/insights' });
});
app.post('/insights/draft', auth, premium, async (req, res) => {
  try { req.session.draft = (await ai.draftFromPattern(String(req.body.summary || ''), String(req.body.topic || ''))).slice(0, 500); } catch (e) { flash(req, 'err', h(e.message)); }
  res.redirect('/compose');
});

/* ---------- billing ---------- */
app.get('/billing', auth, (req, res) => {
  const u = req.user, zt = u.tz || DHAKA;
  const subs = db.prepare('SELECT * FROM subscriptions WHERE user_id=? ORDER BY id DESC LIMIT 10').all(u.id);
  const pend = P.pendingIntent(u.id);
  const on = P.available(), left = u.plan_until ? u.plan_until - Date.now() : 0;
  res.page('Billing', `<div class="page-h"><h1>${t('Plan & billing')}</h1></div>
  ${req.query.ok ? '<div class="alert ok">Thanks! Your payment is being confirmed. Premium activates automatically when the provider confirms.</div>' : ''}
  <div class="card plan-now"><div><div class="muted small">Current plan</div><div class="big-plan">${req.premium ? `⭐ Premium <span class="pill published">${h(P.hasTemp(u) && !(u.plan !== 'free' && u.plan_until > Date.now()) ? 'Temporary' : (P.PLANS[u.plan] || {}).label || u.plan || 'active')}</span>` : P.isPaused(u) ? 'Paused' : 'Free'}</div>
   ${req.premium && !(u.plan !== 'free' && u.plan_until > Date.now()) ? `<div class="small muted">Temporary access</div>` : req.premium ? `<div class="small muted">Renews / ends ${fmt(u.plan_until, zt)} (${h(zt)}) · ${Math.ceil(left / 864e5)} days left</div>` : `<div class="small muted">${Math.max(0, Number(S.get('free_limit')) - monthCount(u.id))} of ${S.get('free_limit')} free posts left this month</div>`}</div>
   ${P.isPaused(u) ? `<div class="alert info" style="margin:0">⏸ Your plan is paused ${u.paused_until ? 'until ' + fmt(u.paused_until, zt) + ' (' + h(zt) + ')' : 'until the site owner resumes it'}. Premium features are off while paused${u.pause_extend ? ', and the paused days will be added to your expiry' : ''}.</div>` : ''}
   ${!P.isPaused(u) && P.hasTemp(u) ? `<div class="alert info" style="margin:0">⏱ Temporary Premium is on until ${fmt(u.temp_until, zt)} (${h(zt)}).</div>` : ''}
   ${pend ? `<p class="small muted" style="margin:0">Request received for <b>${h((P.PLANS[pend.plan] || {}).label || pend.plan)}</b>. The site owner will activate it.</p>` : ''}</div>
  <h2 style="margin-top:28px" id="plans">${req.premium ? 'Extend or change plan' : 'Choose a plan'}</h2>${pricingCards('buy', req.premium ? u.plan : null, req.query.plan)}
  ${on ? '' : '<p class="small muted">Online payment is coming soon. Choosing a plan sends a request to the site owner, who can activate it for you.</p>'}
  ${subs.length ? `<h2>History</h2><div class="card tbl"><table><thead><tr><th>Paid</th><th>Plan</th><th>Period</th><th>Amount</th><th>Status</th></tr></thead><tbody>${subs.map(x => `<tr><td>${fmt(x.created, zt)}</td><td>${h((P.PLANS[x.plan] || {}).label || x.plan)}</td><td class="small">${fmt(x.start_at, zt).split(',')[0]} → ${fmt(x.end_at, zt).split(',')[0]}</td><td>$${Number(x.amount).toFixed(2)}</td><td><span class="pill ${x.status === 'active' ? 'published' : ''}">${h(x.status)}</span></td></tr>`).join('')}</tbody></table></div>` : ''}
  <p class="small muted">Themes and fonts live in <a href="/settings#appearance">Settings → Appearance</a>.</p>`, { active: '/billing' });
});
const payErr = (req, res, e) => { flash(req, 'err', 'Payment error: ' + h(e.message)); res.redirect('/billing'); };
app.post('/billing/checkout', auth, async (req, res) => {
  try { res.redirect(303, await P.checkout(req.user, P.PLANS[req.body.plan] ? req.body.plan : 'monthly', baseUrl(req))); }
  catch (e) {
    if (!e.notImplemented) { flash(req, 'err', 'Payment error: ' + h(e.message)); return res.redirect('/billing'); }
    const plan = P.PLANS[req.body.plan] ? req.body.plan : 'monthly'; P.recordIntent(req.user.id, plan); U(req, 'billing.intent', null, plan);
    flash(req, 'info', `Online payment is coming soon - contact support to activate this plan. We've sent your request for the ${h(P.PLANS[plan].label)} plan ($${P.PLANS[plan].usd}) to the site owner.`); res.redirect('/billing');
  }
});

/* ---------- settings: personal preferences only (no app credentials, ever; the only key is the user's own optional OpenAI key) ---------- */
app.get('/settings', auth, (req, res) => {
  const u = req.user, prem = req.premium;
  const sw = (name, on, title, help) => `<label class="sw-row"><span><b>${title}</b><small>${help}</small></span><input type="checkbox" class="sw" name="${name}" value="1" ${on ? 'checked' : ''}></label>`;
  const themeBtn = (v, label, sw) => `<button type="button" class="theme-opt ${(u.theme || 'default') === v ? 'on' : ''}" data-appearance="theme" data-value="${v}" ${v !== 'default' && !prem ? 'disabled title="Premium"' : ''}><i style="background:${sw}"></i>${label}${v !== 'default' && !prem ? ' 🔒' : ''}</button>`;
  const keyMask = u.openai_key_enc ? (() => { try { const k = decrypt(u.openai_key_enc); return k.slice(0, 3) + '••••••••' + k.slice(-4); } catch { return '••••••••'; } })() : '';
  const nav = [['profile', '👤', 'Profile'], ['appearance', '🎨', 'Appearance'], ['posting', '🗓️', 'Posting defaults'], ['notifications', '🔔', 'Notifications'], ['ai', '🤖', 'AI writing']];
  res.page('Settings', `<div class="page-h"><h1>${t('Settings')}</h1></div>
  <div class="settings"><nav class="set-nav" aria-label="Settings sections">${nav.map(([id, i, l], n) => `<a href="#${id}" class="${n ? '' : 'on'}"><span>${i}</span>${l}</a>`).join('')}</nav>
  <div class="set-body">
  <form method="post" action="/settings" id="setform">
  <section class="card set-sec" id="profile"><h2>Profile</h2><p class="help">How you appear inside PostPilot. Your email is used to sign in and for notifications.</p>
   <label for="dn">Display name</label><input id="dn" name="display_name" maxlength="60" value="${h(u.display_name || '')}" placeholder="e.g. Studio Daily">
   <label>Email</label><input value="${h(u.email)}" disabled><p class="help">Email changes are handled by support.</p>
   <label>Time zone <span class="tz-auto small muted"></span></label>${tzPicker('tz', u.tz || '', 'set-tz', true, u.tz_auto === 1)}<p class="help">Used for scheduling and all times shown to you. Leave on auto-detect or pick your own.</p></section>
  <section class="card set-sec" id="appearance"><h2>Appearance</h2><p class="help">Changes apply instantly and are saved automatically. No save needed.</p>
   <label>Color mode</label><div class="opt-row">${['dark', 'light'].map(m => `<button type="button" class="theme-opt ${(u.mode || 'dark') === m ? 'on' : ''}" data-appearance="mode" data-value="${m}"><i class="mode-${m}"></i>${m === 'dark' ? 'Dark' : 'Light'}</button>`).join('')}</div>
   <label>Theme ${prem ? '' : '<span class="pill">Premium</span>'}</label><div class="opt-row">${themeBtn('default', 'Violet', 'linear-gradient(135deg,#7c5cff,#ff5ca8)')}${themeBtn('aurora', 'Aurora', 'linear-gradient(135deg,#10b981,#3b82f6)')}${themeBtn('sunset', 'Sunset', 'linear-gradient(135deg,#f97316,#e11d48)')}${themeBtn('ocean', 'Ocean', 'linear-gradient(135deg,#0ea5e9,#6366f1)')}</div>
   <label>Typography</label><div class="opt-row">${[['inter', 'Inter'], ['serif', 'Serif'], ['rounded', 'Rounded']].map(([v, l]) => `<button type="button" class="theme-opt ${(u.font || 'inter') === v ? 'on' : ''}" data-appearance="font" data-value="${v}" ${v !== 'inter' && !prem ? 'disabled' : ''}><i class="font-${v}">Aa</i>${l}${v !== 'inter' && !prem ? ' 🔒' : ''}</button>`).join('')}</div></section>
  <section class="card set-sec" id="posting"><h2>Posting defaults</h2><p class="help">Pre-filled every time you open the composer. You can still change them per post.</p>
   <label for="dsm">Default scheduling mode</label><select id="dsm" name="def_smode"><option value="exact" ${u.def_smode !== 'auto' ? 'selected' : ''}>Exact time</option><option value="auto" ${u.def_smode === 'auto' ? 'selected' : ''}>Auto slot (US prime time)</option></select>
   ${sw('def_disclosure', u.def_disclosure !== 0, 'Add #ad disclosure to posts with links', 'Recommended for affiliate links.')}
   <label for="lr">Flag posts as low reach below (views)</label><input id="lr" name="low_reach" type="number" min="0" value="${u.low_reach}"><p class="help">Only a flag on the dashboard. Nothing is deleted automatically.</p>
   <label for="subs">Default subreddits for analysis</label><input id="subs" name="subs" value="${h(u.subreddits)}" placeholder="Entrepreneur, socialmedia"><p class="help">Comma separated, without r/.</p></section>
  <section class="card set-sec" id="notifications"><h2>Notifications</h2><p class="help">In-app notices appear on your dashboard. Emails go to ${h(u.email)}${mailer.configured() ? '' : ' (email delivery is not enabled on this server yet)'}.</p>
   <h3 class="sub-h">In-app</h3>${sw('notify_fail', u.notify_fail !== 0, 'Failed or missed posts', 'Tell me when a post could not be published.')}${sw('notify_renew', u.notify_renew !== 0, 'Plan renewal reminders', 'A notice 3 days before Premium ends.')}
   <h3 class="sub-h">Email</h3>${sw('email_post_deleted', u.email_post_deleted !== 0, 'Post deleted', 'When a post is deleted by you or by an administrator.')}${sw('email_expiry', u.email_expiry !== 0, 'Subscription reminders', '3 days before Premium ends, and when it expires.')}${sw('email_payment', u.email_payment !== 0, 'Payment problems', 'If a payment fails or needs attention.')}</section>
  <div class="savebar" id="savebar" hidden><span>You have unsaved changes</span><div><button type="button" class="btn ghost sm" data-reset>Discard</button><button class="btn sm shimmer">Save changes</button></div></div></form>
  <section class="card set-sec" id="ai"><h2>AI writing</h2><p class="help">Optional. Use your own OpenAI API key for AI drafts and pattern summaries. It is stored encrypted and never shown again in full.${S.has('openai_key') ? ' Without a key, the server default is used.' : ''}</p>
   <form method="post" action="/settings/openai" class="key-form" id="keyform"><label for="ok">OpenAI API key</label>
    <div class="key-row"><input id="ok" name="key" type="password" autocomplete="off" spellcheck="false" placeholder="${keyMask ? h(keyMask) : 'sk-…'}"><button type="button" class="btn ghost sm" data-test-key>Test</button><button class="btn sm">Save key</button></div>
    <p class="help" id="keystat">${keyMask ? `✅ Saved key: <code>${h(keyMask)}</code>` : 'No key saved.'}</p></form>
   ${keyMask ? '<form method="post" action="/settings/openai/remove" data-confirm="Remove your OpenAI key?"><button class="btn ghost sm">Remove key</button></form>' : ''}</section>
  <p class="small muted">Social accounts are managed on <a href="/connect">Accounts</a>; your plan on <a href="/billing">Billing</a>.</p></div></div>`, { scripts: ['/settings.js'] });
});
app.post('/settings', auth, (req, res) => {
  const b = req.body, on = k => b[k] ? 1 : 0;
  const subs = String(b.subs || '').split(',').map(x => x.trim().replace(/^r\//i, '')).filter(x => /^[A-Za-z0-9_]{2,21}$/.test(x)).slice(0, 20);
  db.prepare(`UPDATE users SET display_name=?, tz=?, def_smode=?, def_disclosure=?, low_reach=?, subreddits=?, notify_fail=?, notify_renew=?, email_post_deleted=?, email_expiry=?, email_payment=? WHERE id=?`)
    .run(String(b.display_name || '').trim().slice(0, 60) || null, validTz(b.tz) ? b.tz : req.user.tz, b.def_smode === 'auto' ? 'auto' : 'exact', on('def_disclosure'), Math.max(0, parseInt(b.low_reach) || 15), subs.join(', '),
      on('notify_fail'), on('notify_renew'), on('email_post_deleted'), on('email_expiry'), on('email_payment'), req.user.id);
  U(req, 'settings.update', null, 'profile/posting/notifications');
  flash(req, 'ok', 'Settings saved'); res.redirect('/settings');
});
app.post('/settings/openai', auth, async (req, res) => {
  const key = String(req.body.key || '').trim(), json = /json/.test(req.get('accept') || '');
  if (req.body.test) { try { await ai.testKey(key || decrypt(req.user.openai_key_enc || '')); return res.json({ ok: true }); } catch (e) { return res.json({ ok: false, error: String(e.message).slice(0, 200) }); } }
  if (!/^sk-[A-Za-z0-9_\-]{16,}$/.test(key)) { if (json) return res.status(400).json({ ok: false, error: 'That does not look like an OpenAI key' }); flash(req, 'err', 'That does not look like an OpenAI key (starts with sk-)'); return res.redirect('/settings#ai'); }
  db.prepare('UPDATE users SET openai_key_enc=? WHERE id=?').run(encrypt(key), req.user.id); U(req, 'settings.openai_key', null, 'saved');
  flash(req, 'ok', 'OpenAI key saved (encrypted)'); res.redirect('/settings#ai');
});
app.post('/settings/openai/remove', auth, (req, res) => { db.prepare('UPDATE users SET openai_key_enc=NULL WHERE id=?').run(req.user.id); U(req, 'settings.openai_key', null, 'removed'); flash(req, 'ok', 'OpenAI key removed'); res.redirect('/settings#ai'); });

app.use((req, res) => res.status(404).page('Not found', `<div class="card" style="text-align:center"><h1>404</h1><p>Page not found</p><a class="btn" href="/">Home</a></div>`));
app.use((err, req, res, next) => { console.error(err); res.status(500).send('Server error'); });

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => {
    const base = (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : `http://localhost:${port}`)).replace(/\/$/, '');
    const lines = [`PostPilot is running on port ${port}`, `Data folder: ${DATA_DIR}`, '', `Owner admin path: ${ADMIN_PATH}`, `Owner admin URL:  ${base}${ADMIN_PATH}`, '',
      process.env.ADMIN_PATH ? 'Path comes from the ADMIN_PATH variable.' : `Path was auto-generated and saved in ${require('path').join(DATA_DIR, '.admin_path')}`,
      'First visit: create the owner username + password. Later: log in there.', 'Keep this URL private. It is never linked from the site.'];
    const w = Math.max(...lines.map(l => l.length)) + 2, bar = '='.repeat(w + 2);
    console.log(['', bar, ...lines.map(l => '| ' + l.padEnd(w - 1) + '|'), bar, ''].join('\n'));
  });
  W.start();
}
module.exports = app;
