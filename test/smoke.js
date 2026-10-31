// Smoke test: node test/smoke.js  (uses a temp DATA_DIR and a mocked Threads client)
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
// Credentials come ONLY from environment variables (Railway Variables). Reddit deliberately left unset.
Object.assign(process.env, { THREADS_APP_ID: '123', THREADS_APP_SECRET: 'topsecret', X_CLIENT_ID: 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4', X_CLIENT_SECRET: 'xs' });
delete process.env.REDDIT_CLIENT_ID; delete process.env.REDDIT_CLIENT_SECRET; delete process.env.ADMIN_PATH;
const app = require('../src/server');
const { db } = require('../src/db');
const S = require('../src/settings');
const threads = require('../src/platforms/threads');
const accounts = require('../src/accounts');
const W = require('../src/worker');
const P = require('../src/payments');
const reddit = require('../src/platforms/reddit');
const { autoSlots, nyHour } = require('../src/schedule');

const calls = [];
let n = 0;
threads.setClient({ mock: true,
  publishingLimit: async () => ({ used: 3, total: 250 }),
  container: async (uid, tok, p) => { calls.push(['container', p]); return 'c' + (++n); },
  waitReady: async () => {}, publish: async (uid, tok, c) => { calls.push(['publish', c]); return 'm' + c; },
  permalink: async id => 'https://www.threads.net/@demo/post/' + id,
  insights: async () => ({ views: 9, likes: 1, replies: 0, reposts: 0 }),
  refresh: async () => ({ token: 'refreshed', expiresIn: 5184000 }), remove: async () => ({ success: true }), keywordSearch: async () => [] });

let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✔', m); };
async function main() {
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const jar = {}; const f = async (u, o = {}, who = 'a') => { const r = await fetch(base + u, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: jar[who] || '' } }); const sc = r.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0]; return r; };
  const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

  console.log('Auth');
  ok((await f('/healthz')).status === 200, 'healthz 200');
  ok((await f('/')).status === 200, 'landing renders');
  const sp = await (await f('/signup')).text();
  ok(!/admin|API key/i.test(sp), 'signup is a normal signup (no first-user admin message)');
  let r = await f('/signup', form({ email: 'admin@x.com', password: 'password123' }));
  ok(r.headers.get('location') === '/connect', 'first user -> normal user, goes to Accounts');
  ok((await f('/signup', form({ email: 'free@x.com', password: 'password123' }), 'b')).headers.get('location') === '/connect', 'second user is regular');
  const admin = db.prepare("SELECT * FROM users WHERE email='admin@x.com'").get(), free = db.prepare("SELECT * FROM users WHERE email='free@x.com'").get();
  ok(admin.is_admin === 0 && !P.isPremium(admin), 'no automatic admin/premium for first signup');
  P.extend(admin.id, 'monthly', 'test');
  ok((await f('/admin/settings', {}, 'a')).status === 404, 'old /admin/settings credential page removed (404)');
  ok((await f('/login', form({ email: 'free@x.com', password: 'wrong' }), 'c')).headers.get('location') === '/login', 'bad password rejected');

  console.log('Env-only credentials');
  ok(S.get('threads_app_secret') === 'topsecret' && !db.prepare("SELECT 1 FROM settings WHERE key LIKE '%secret%' OR key LIKE '%client%' OR key LIKE '%app_id%'").get(), 'credentials read from env, never stored in DB');
  ok((() => { try { S.set('x_client_secret', 'nope'); return false; } catch (e) { return true; } })(), 'credentials cannot be written through the app');

  console.log('Scheduler + worker (mock Threads)');
  for (const u of [admin, free]) accounts.save(u.id, 'threads', { extId: 'tu' + u.id, username: 'demo' + u.id, token: 'tok', expiresIn: 3 * 86400 });
  ok(db.prepare('SELECT token_enc FROM accounts LIMIT 1').get().token_enc.startsWith('v1:'), 'platform token encrypted');
  const accOf = u => String(accounts.get(u.id, 'threads').id);
  const when = new Date(Date.now() + 6 * 3600e3 + 2 * 60e3).toISOString().slice(0, 16); // 2 min ahead in Dhaka local
  r = await f('/compose', form({ accounts: accOf(admin), text: 'Hello Threads', media_type: 'TEXT', link: 'https://example.com/aff', link_reply: '1', disclosure: '1', smode: 'exact', when, tz: 'Asia/Dhaka', batch: '1' }));
  ok(r.headers.get('location') === '/queue', 'scheduled post created');
  const post = db.prepare('SELECT * FROM posts ORDER BY id DESC').get();
  ok(Math.abs(post.scheduled_at - (Date.now() + 2 * 60e3)) < 61e3, 'Dhaka local time parsed correctly');
  await W.tick(Date.now()); ok(db.prepare('SELECT status FROM posts WHERE id=?').get(post.id).status === 'scheduled', 'not posted before its time');
  db.prepare('UPDATE posts SET scheduled_at=? WHERE id=?').run(Date.now() - 1000, post.id);
  await Promise.all([W.publishOne(db.prepare('SELECT * FROM posts WHERE id=?').get(post.id)), W.publishOne(db.prepare('SELECT * FROM posts WHERE id=?').get(post.id))]);
  const pub = db.prepare('SELECT * FROM posts WHERE id=?').get(post.id);
  ok(pub.status === 'published' && pub.ext_id && pub.reply_ext_id, 'worker published post + link reply');
  ok(calls.filter(c => c[0] === 'publish').length === 2, 'idempotent: concurrent workers published only once (post + reply)');
  const reply = calls.find(c => c[0] === 'container' && c[1].reply_to_id);
  ok(reply && reply[1].text.includes('#ad / affiliate') && reply[1].text.includes('example.com'), 'link reply carries #ad / affiliate disclosure');
  ok(!calls[0][1].text.includes('example.com'), 'main post does not contain the link when link-in-reply');

  console.log('Missed + retry + carousel/video');
  db.prepare("INSERT INTO posts(user_id,text,scheduled_at,status,created) VALUES(?,?,?,?,?)").run(admin.id, 'old', Date.now() - 20 * 60e3, 'scheduled', Date.now());
  db.prepare("INSERT INTO posts(user_id,text,scheduled_at,status,created) VALUES(?,?,?,?,?)").run(admin.id, 'slightly late', Date.now() - 10 * 60e3, 'scheduled', Date.now());
  db.prepare("INSERT INTO posts(user_id,text,media_type,media_urls,scheduled_at,status,created) VALUES(?,?,?,?,?,?,?)").run(admin.id, 'carousel', 'CAROUSEL', JSON.stringify(['https://a/1.jpg', 'https://a/2.mp4']), Date.now() - 1000, 'scheduled', Date.now());
  await W.tick();
  ok(db.prepare("SELECT status FROM posts WHERE text='old'").get().status === 'missed', '>15 min late => missed');
  ok(db.prepare("SELECT status FROM posts WHERE text='slightly late'").get().status === 'published', '<15 min late => posted');
  ok(db.prepare("SELECT status FROM posts WHERE text='carousel'").get().status === 'published' && calls.some(c => c[1] && c[1].media_type === 'CAROUSEL'), 'carousel (image+video) published');
  const orig = threads.client.publish; threads.client.publish = async () => { throw new Error('API down'); };
  db.prepare("INSERT INTO posts(user_id,text,scheduled_at,status,created) VALUES(?,?,?,?,?)").run(admin.id, 'flaky', Date.now() - 1000, 'scheduled', Date.now());
  await W.tick(); const fl = db.prepare("SELECT * FROM posts WHERE text='flaky'").get();
  ok(fl.status === 'scheduled' && fl.attempts === 1 && fl.next_try > Date.now(), 'failure => retry with backoff');
  threads.client.publish = orig;
  const ql = threads.client.publishingLimit; threads.client.publishingLimit = async () => ({ used: 250, total: 250 });
  db.prepare("UPDATE posts SET next_try=NULL WHERE text='flaky'").run(); await W.tick();
  ok(/quota/i.test(db.prepare("SELECT error FROM posts WHERE text='flaky'").get().error), 'health check blocks when publishing quota is full');
  threads.client.publishingLimit = ql;

  console.log('Insights + token refresh');
  db.prepare('UPDATE posts SET published_at=? WHERE id=?').run(Date.now() - 7 * 3600e3, post.id); await W.tick();
  ok(db.prepare('SELECT views FROM posts WHERE id=?').get(post.id).views === 9, 'insights fetched after 6-7h');
  const tk = await accounts.token(admin.id, 'threads'); ok(tk.token === 'refreshed', 'Threads token auto-refreshed before expiry');

  console.log('Premium gating (server side)');
  ok((await f('/insights', {}, 'b')).status === 402, 'free user blocked from competitive analysis');
  ok((await f('/account/appearance', form({ theme: 'sunset' }), 'b')).status === 402, 'free user cannot set premium theme');
  ok(!(await (await f('/app', {}, 'b')).text()).includes('👁 9'), 'free dashboard hides reach analytics');
  ok((await f('/insights', {}, 'a')).status === 200, 'admin (premium) can open analysis');
  db.prepare('DELETE FROM posts WHERE user_id=?').run(free.id);
  for (let i = 0; i < 10; i++) await f('/compose', form({ accounts: accOf(free), text: 'p' + i, media_type: 'TEXT', smode: 'auto', batch: '1' }), 'b');
  ok(db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(free.id).c === 10, 'free user can schedule 10/month (auto slots)');
  await f('/compose', form({ accounts: accOf(free), text: 'eleven', media_type: 'TEXT', smode: 'auto', batch: '1' }), 'b');
  ok(db.prepare('SELECT COUNT(*) c FROM posts WHERE user_id=?').get(free.id).c === 10, '11th post blocked by free limit');
  const slots = db.prepare('SELECT scheduled_at FROM posts WHERE user_id=? ORDER BY scheduled_at').all(free.id).map(r => r.scheduled_at);
  ok(slots.slice(1).every((s, i) => s - slots[i] >= 3 * 3600e3 - 60e3), 'auto slots spaced >= 3h');
  ok(slots.every(s => nyHour(s) < 1 || nyHour(s) > 5), 'auto slots avoid 1-5am New York');

  console.log('Payments placeholder');
  const bill = await (await f('/billing', {}, 'b')).text();
  ok(['$7<small> / 1 month', '$16<small> / 3 months', '$30<small> / 6 months', '$50<small> / 1 year'].every(x => bill.includes(x)) && (bill.match(/data-choose="(monthly|quarterly|semiannual|yearly)">Choose plan</g) || []).length === 4 && !/disabled[^>]*>Coming soon/.test(bill), 'billing shows all 4 plans ($7/$16/$30/$50) with enabled Choose plan buttons');
  ok(/class="btn sm nav-upgrade"/.test(bill) || /Premium/.test(bill), 'Upgrade button in nav for free users');
  r = await f('/billing/checkout', form({ plan: 'monthly' }), 'b');
  const billAfter = await (await f('/billing', {}, 'b')).text();
  ok(r.headers.get('location') === '/billing' && /Online payment is coming soon - contact support to activate this plan/.test(billAfter), 'checkout hook without provider -> clean "coming soon, contact support" message');
  ok(db.prepare("SELECT COUNT(*) c FROM plan_intents WHERE status='pending'").get().c >= 1 && /Request received for <b>1 month<\/b>/.test(await (await f('/billing', {}, 'b')).text()), 'Choose plan records a pending plan request');
  const Pm = require('../src/payments'); Pm.setProvider({ checkout: async (u, p) => 'https://pay.example/' + p });
  r = await f('/billing/checkout', form({ plan: 'yearly' }), 'b'); ok(r.headers.get('location') === 'https://pay.example/yearly', 'checkout hook redirects to provider URL once a provider is plugged in'); Pm.setProvider(null);
  ok((await f('/webhooks/stripe', { method: 'POST', body: '{}' })).status === 404 && (await f('/webhooks/nowpayments', { method: 'POST', body: '{}' })).status === 404, 'Stripe/NOWPayments webhooks removed');
  ok(!/require\(['"](stripe|nowpayments)|api\.stripe\.com|nowpayments\.io|STRIPE_SECRET|NOWPAYMENTS_API/i.test(fs.readFileSync(path.join(__dirname, '../src/payments.js'), 'utf8')), 'payments.js has no processor SDK/API code (source labels only)');

  console.log('Manual delete');
  r = await f(`/posts/${post.id}/delete`, { method: 'POST' });
  ok(db.prepare('SELECT status FROM posts WHERE id=?').get(post.id).status === 'deleted', 'manual delete button works');
  ok((await f(`/posts/${post.id}/delete`, { method: 'POST' }, 'b')).status === 404, 'users cannot touch others\' posts');

  console.log('Connect buttons driven by env');
  const acB = await (await f('/connect', {}, 'b')).text();
  ok(!/client.?secret|client id|app secret|access token|paste|admin/i.test(acB) && !/<input[^>]+(token|secret)/i.test(acB), 'Accounts page: no credential fields, no admin wording');
  ok(/The site owner hasn't enabled Reddit yet/.test(acB) && /<button class="btn ghost sm" disabled[^>]*>Connect Reddit<\/button>/.test(acB) && !acB.includes('/oauth/reddit/start') && !/Coming soon/.test(acB), 'Reddit without env vars: disabled + Not available yet');
  ok(!acB.slice(acB.indexOf('data-platform="reddit"')).includes('publishing</span>') && /data-platform="threads"[^]*?publishing/.test(acB), 'publishing badge only on configured platforms');
  ok(/href="\/oauth\/threads\/start"/.test(acB) && /href="\/oauth\/x\/start"/.test(acB), 'Threads + X with env vars: Connect enabled');
  ok((await f('/oauth/reddit/start', {}, 'b')).headers.get('location') === '/connect', 'Connect for unconfigured platform refused');
  process.env.REDDIT_CLIENT_ID = 'envRedditId'; process.env.REDDIT_CLIENT_SECRET = 'envRedditSecret';
  ok((await (await f('/connect', {}, 'b')).text()).includes('/oauth/reddit/start'), 'setting env vars enables Connect (no restart of code paths needed)');
  r = await f('/oauth/reddit/start', {}, 'b'); let rl = r.headers.get('location') || '';
  ok(rl.startsWith('https://www.reddit.com/api/v1/authorize') && rl.includes('client_id=envRedditId') && decodeURIComponent(rl).includes(base + '/oauth/reddit/callback'), 'Reddit OAuth redirect built from env client id + real callback');
  rl = (await f('/oauth/threads/start', {}, 'b')).headers.get('location') || '';
  ok(rl.includes('client_id=123') && decodeURIComponent(rl).includes('/oauth/threads/callback'), 'Threads OAuth redirect built from env app id');
  process.env.APP_URL = 'https://pp.example.com';
  rl = (await f('/oauth/x/start', {}, 'b')).headers.get('location') || '';
  ok(decodeURIComponent(rl).includes('redirect_uri=https://pp.example.com/oauth/x/callback'), 'APP_URL env sets the callback base');
  delete process.env.APP_URL;
  r = await f('/oauth/x/start', {}, 'b'); const loc = r.headers.get('location') || '';
  ok(loc.startsWith('https://x.com/i/oauth2/authorize') && /code_challenge_method=S256/.test(loc) && /offline.access/.test(decodeURIComponent(loc)), 'X uses PKCE + offline.access');
  ok(/duration=permanent/.test(reddit.authorizeUrl({ clientId: 'a', redirect: 'b', state: 'c' })), 'Reddit asks for permanent refresh token');
  // proactive refresh (worker) + 401 retry for Reddit/X
  const xm = require('../src/platforms/x'); const origTok = xm.token; let refreshCalls = 0;
  xm.token = async () => { refreshCalls++; return { token: 'xnew' + refreshCalls, refresh: 'xr2', expiresIn: 7200 }; };
  accounts.save(free.id, 'x', { extId: '1', username: 'xu', token: 'xold', refresh: 'xr1', expiresIn: 60 });
  await accounts.refreshDue(); ok(refreshCalls === 1 && (await accounts.token(free.id, 'x')).token === 'xnew1', 'worker refreshes X token before expiry');
  let seen = []; const out = await accounts.withToken(free.id, 'x', async tk => { seen.push(tk); if (seen.length === 1) throw Object.assign(new Error('HTTP 401'), { status: 401 }); return 'ok'; });
  ok(out === 'ok' && seen[1] === 'xnew2', 'on 401 the token is refreshed and the call retried');
  xm.token = origTok;
  ok(require('crypto') && db.prepare("SELECT refresh_enc FROM accounts WHERE platform='x'").get().refresh_enc.startsWith('v1:'), 'refresh tokens stored encrypted');

  console.log('Hidden owner admin');
  const OP = require('../src/owner').adminPath();
  ok(/^\/owner-[0-9a-f]{24}$/.test(OP) && fs.readFileSync(path.join(process.env.DATA_DIR, '.admin_path'), 'utf8') === OP, 'default admin path is random /owner-<hex>, persisted in data dir');
  const nf = await (await f('/definitely-missing', {}, 'z')).text();
  for (const sub of ['/accounts', '/users', '/settings', '/schedule', '/competitors']) { const x = await f(OP + sub, {}, 'z'); ok(x.status === 404 && (await x.text()) === nf && !x.headers.get('x-robots-tag') && !x.headers.get('set-cookie'), `unauthenticated ${sub} -> same generic 404`); }
  ok((await (await f(OP, {}, 'o')).text()).includes('Create owner login'), 'first visit shows one-time setup');
  r = await f(OP + '/setup', form({ username: 'boss', password: 'correct-horse-9' }), 'o');
  ok(r.status === 302 && jar.o.startsWith('pp.owner='), 'owner created, separate pp.owner session cookie');
  ok((await f(OP + '/setup', form({ username: 'evil', password: 'another-pass-1' }), 'p')).status === 404 && db.prepare('SELECT COUNT(*) c FROM owners').get().c === 1, 'setup works only once');
  ok(/^\$2[aby]\$/.test(db.prepare('SELECT pw FROM owners').get().pw), 'owner password bcrypt-hashed');
  ok((await (await f(OP, {}, 'p')).text()).includes('Owner login') && !(await (await f(OP, {}, 'p')).text()).includes('Create owner'), 'afterwards only the login form');
  const dash = await (await f(OP, {}, 'o')).text();
  ok(['Platforms', 'Deleted by users', 'threads', 'reddit', 'x', 'Active · 24h', 'Expiring'] .every(x => dash.includes(x)), 'owner overview: KPI cards + per-platform analytics incl. user deletions');
  ok((await f(OP + '/accounts', {}, 'o')).status === 200 && (await f(OP + '/competitors', {}, 'o')).status === 200, 'owner accounts + competitor views');
  const q = db.prepare("INSERT INTO posts(user_id,text,scheduled_at,status,created) VALUES(?,?,?,?,?)").run(free.id, 'queued', Date.now() + 864e5, 'scheduled', Date.now()).lastInsertRowid;
  await f(`${OP}/schedule/${q}`, form({ text: 'edited by owner', at: '2030-01-02T03:04' }), 'o');
  const qp = db.prepare('SELECT * FROM posts WHERE id=?').get(q);
  ok(qp.text === 'edited by owner' && qp.scheduled_at === Date.parse('2030-01-02T03:04Z'), 'owner edits + reschedules a queued post');
  await f(`${OP}/schedule/${q}/cancel`, { method: 'POST' }, 'o');
  ok(db.prepare('SELECT status FROM posts WHERE id=?').get(q).status === 'canceled', 'owner cancels a queued post');
  db.prepare("UPDATE users SET plan='free', plan_until=0 WHERE id=?").run(free.id);
  await f(`${OP}/users/${free.id}/plan`, form({ plan: 'quarterly' }), 'o');
  ok(P.isPremium(db.prepare('SELECT * FROM users WHERE id=?').get(free.id)) && (await f('/insights', {}, 'b')).status === 200, 'owner plan override -> premium gating unlocked');
  await f(OP + '/settings', form({ app_name: 'MyBrand', default_tz: 'Asia/Dhaka', caption_default: 'Hi', free_limit: '12' }), 'o');
  ok(S.get('app_name') === 'MyBrand' && (await (await f('/')).text()).includes('MyBrand') && S.get('free_limit') === '12', 'owner app settings saved and applied');
  await f(`${OP}/users/${free.id}/disable`, { method: 'POST' }, 'o');
  ok((await f('/app', {}, 'b')).headers.get('location') === '/login' && (await f('/login', form({ email: 'free@x.com', password: 'password123' }), 'd')).headers.get('location') === '/login', 'owner disables a user');
  await f(`${OP}/users/${free.id}/enable`, { method: 'POST' }, 'o');
  for (let i = 0; i < 5; i++) ok((await f(OP + '/login', form({ username: 'boss', password: 'wrong' + i }), 'p')).status === 401, `bad owner login ${i + 1} rejected`);
  ok((await f(OP + '/login', form({ username: 'boss', password: 'correct-horse-9' }), 'p')).status === 429, 'rate limit: 6th attempt within 15 min blocked (429)');
  await f(OP + '/logout', { method: 'POST' }, 'o');
  ok((await f(OP + '/users', {}, 'o')).status === 404, 'logout ends owner session');

  console.log('No credential inputs / no admin links anywhere');
  const CRED = /<input[^>]+name="[^"]*(secret|key|client_id|app_id|token|password_api)[^"]*"/i;
  const pages = {};
  for (const [u, who] of [['/', 'z'], ['/signup', 'z'], ['/login', 'z'], ['/app', 'a'], ['/compose', 'a'], ['/queue', 'a'], ['/calendar', 'a'], ['/media', 'a'], ['/connect', 'a'], ['/insights', 'a'], ['/billing', 'a'], ['/settings', 'a'], ['/style.css', 'z'], ['/app.js', 'z']]) pages[u] = await (await f(u, {}, who)).text();
  const noOwnKey = x => x.replace(/<form[^>]+action="\/settings\/openai"[\s\S]*?<\/form>/, '');
  ok(Object.values(pages).every(x => !CRED.test(noOwnKey(x))), 'no secret/key/client_id/app_id inputs on any user page (only the user\'s own optional OpenAI key)');
  ok(Object.values(pages).every(x => !x.includes(OP) && !/owner-/.test(x)), 'admin path not linked from any public page, CSS or JS');
  ok((await f('/robots.txt')).status === 404 && (await f('/sitemap.xml')).status === 404, 'no robots.txt / sitemap revealing the path');
  r = await f(OP + '/login', form({}), 'q'); // still rate limited for this IP, but body must have no credential fields
  ok(!CRED.test(await r.text()), 'owner pages have no credential inputs');
  const sp2 = await (await f('/settings', {}, 'a')).text();
  ok(['Profile', 'Appearance', 'Posting defaults', 'Notifications'].every(x => sp2.includes(x)) && sp2.includes('id="savebar"') && !/secret|client id|app id|smtp/i.test(noOwnKey(sp2).replace(/<[^>]+>/g, ' ')), 'Settings page = personal preferences only (left nav, sticky save bar)');

  srv.close(); console.log(`\nALL ${pass} CHECKS PASSED`); process.exit(0);
}
main().catch(e => { console.error('FAILED:', e); process.exit(1); });
