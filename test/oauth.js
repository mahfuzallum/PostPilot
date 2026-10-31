// OAuth Connect end-to-end: fake platform env vars, real authorize URLs, mocked token exchange, encrypted token storage.
const os = require('os'), fs = require('fs'), path = require('path'), assert = require('assert');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ppo-'));
Object.assign(process.env, { THREADS_APP_ID: 'th-app-123', THREADS_APP_SECRET: 'th-secret', X_CLIENT_ID: 'x-client-abc', X_CLIENT_SECRET: 'x-secret',
  REDDIT_CLIENT_ID: 'rd-client-xyz', REDDIT_CLIENT_SECRET: 'rd-secret', APP_URL: 'https://example.up.railway.app', GEOIP_LOOKUP: 'off' });
delete process.env.ADMIN_PATH; delete process.env.RAILWAY_PUBLIC_DOMAIN;
const crypto = require('crypto');
const app = require('../src/server');
const { db } = require('../src/db');
const { decrypt } = require('../src/crypto');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✔', m); };
const APP = 'https://example.up.railway.app';
const ext = []; const realFetch = global.fetch;
global.fetch = async (url, o = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, o);
  ext.push({ url: u, o }); const J = b => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.startsWith('https://graph.threads.net/oauth/access_token')) return J({ access_token: 'th-short', user_id: '77' });
  if (u.startsWith('https://graph.threads.net/access_token')) return J({ access_token: 'th-LONG-token', expires_in: 5184000 });
  if (u.startsWith('https://graph.threads.net/v1.0/me')) return J({ id: '77', username: 'demo_threads' });
  if (u === 'https://api.x.com/2/oauth2/token') return J({ access_token: 'x-ACCESS-token', refresh_token: 'x-refresh', expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' });
  if (u.startsWith('https://api.x.com/2/users/me')) return J({ data: { id: '9', username: 'demo_x' } });
  if (u === 'https://www.reddit.com/api/v1/access_token') return J({ access_token: 'rd-ACCESS-token', refresh_token: 'rd-refresh', expires_in: 3600, scope: 'identity read submit' });
  if (u.startsWith('https://oauth.reddit.com/api/v1/me')) return J({ id: 'r1', name: 'demo_reddit' });
  return new Response('{}', { status: 404 });
};
(async () => {
  const srv = app.listen(0), base = `http://127.0.0.1:${srv.address().port}`; let jar = '';
  const f = async (u, o = {}) => { const r = await realFetch(base + u, { redirect: 'manual', ...o, headers: { ...(o.headers || {}), cookie: jar } }); const sc = r.headers.get('set-cookie'); if (sc) jar = sc.split(';')[0]; return r; };
  await f('/signup', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=oauth%40example.com&password=password123' });
  const page = await (await f('/connect')).text();
  ok(!/Not available yet|hasn't enabled/.test(page) && ['threads', 'x', 'reddit'].every(p => page.includes(`href="/oauth/${p}/start"`)), 'Accounts: all 3 Connect buttons enabled with env vars present');
  ok(!/<input[^>]+(secret|client_id|app_id)/i.test(page), 'Accounts: no credential fields');
  const urls = {};
  for (const p of ['threads', 'x', 'reddit']) { const r = await f(`/oauth/${p}/start`); ok(r.status === 302, `${p}: start redirects`); urls[p] = new URL(r.headers.get('location')); console.log('     ' + urls[p].href); }
  const T = urls.threads, X = urls.x, R = urls.reddit;
  ok(T.origin + T.pathname === 'https://threads.net/oauth/authorize' && T.searchParams.get('client_id') === 'th-app-123' && T.searchParams.get('redirect_uri') === APP + '/oauth/threads/callback' && T.searchParams.get('response_type') === 'code' && /threads_basic/.test(T.searchParams.get('scope')) && /threads_content_publish/.test(T.searchParams.get('scope')), 'Threads authorize URL, redirect_uri and scopes');
  ok(X.origin + X.pathname === 'https://x.com/i/oauth2/authorize' && X.searchParams.get('client_id') === 'x-client-abc' && X.searchParams.get('redirect_uri') === APP + '/oauth/x/callback' && X.searchParams.get('scope') === 'tweet.read tweet.write users.read media.write offline.access', 'X authorize URL, redirect_uri and scopes');
  ok(X.searchParams.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(X.searchParams.get('code_challenge')), 'X uses PKCE S256');
  ok(R.origin + R.pathname === 'https://www.reddit.com/api/v1/authorize' && R.searchParams.get('duration') === 'permanent' && R.searchParams.get('client_id') === 'rd-client-xyz' && R.searchParams.get('redirect_uri') === APP + '/oauth/reddit/callback' && R.searchParams.get('scope') === 'identity read submit', 'Reddit authorize URL, duration=permanent, scopes');
  // PKCE verifier matches the challenge
  const st = db.prepare("SELECT verifier FROM oauth_state WHERE platform='x'").get();
  ok(crypto.createHash('sha256').update(st.verifier).digest('base64url') === X.searchParams.get('code_challenge'), 'X PKCE verifier stored and matches challenge');
  // bad state is rejected
  let r = await f('/oauth/x/callback?state=bogus&code=1'); r = await f('/connect'); ok((await r.text()).includes('Invalid or expired login state'), 'callback rejects unknown state');
  for (const p of ['threads', 'x', 'reddit']) { const s = (p === 'x' ? (await f('/oauth/x/start'), new URL((await f('/oauth/x/start')).headers.get('location'))) : urls[p]).searchParams.get('state');
    const cb = await f(`/oauth/${p}/callback?state=${s}&code=CODE-${p}`); ok(cb.status === 302 && cb.headers.get('location') === '/connect', `${p}: callback exchanges code and returns to Accounts`); }
  const xt = ext.find(e => e.url === 'https://api.x.com/2/oauth2/token'), xb = new URLSearchParams(xt.o.body);
  ok(xb.get('code') === 'CODE-x' && xb.get('redirect_uri') === APP + '/oauth/x/callback' && xb.get('code_verifier') && /^Basic /.test(xt.o.headers.Authorization || ''), 'X token exchange sends code, redirect_uri, code_verifier, Basic auth');
  const rt = ext.find(e => e.url === 'https://www.reddit.com/api/v1/access_token'), rb = new URLSearchParams(rt.o.body);
  ok(rb.get('grant_type') === 'authorization_code' && rb.get('redirect_uri') === APP + '/oauth/reddit/callback' && /^Basic /.test(rt.o.headers.Authorization), 'Reddit token exchange uses Basic auth + redirect_uri');
  const tt = ext.find(e => e.url.startsWith('https://graph.threads.net/oauth/access_token')); ok(String(tt.o.body || tt.url).includes('CODE-threads'), 'Threads code exchanged');
  const rows = db.prepare('SELECT platform,username,token_enc,refresh_enc FROM accounts ORDER BY platform').all();
  ok(rows.length === 3 && rows.map(x => x.username).sort().join() === 'demo_reddit,demo_threads,demo_x', 'three accounts saved');
  ok(rows.every(x => !/ACCESS|LONG/.test(x.token_enc)) && decrypt(rows.find(x => x.platform === 'x').token_enc) === 'x-ACCESS-token' && decrypt(rows.find(x => x.platform === 'threads').token_enc) === 'th-LONG-token' && decrypt(rows.find(x => x.platform === 'reddit').refresh_enc) === 'rd-refresh', 'tokens stored encrypted and decrypt correctly');
  const after = await (await f('/connect')).text(); ok(['@demo_threads', '@demo_x', '@demo_reddit'].every(n => after.includes(n)), 'Accounts page lists connected accounts');
  srv.close(); console.log(`ALL ${pass} OAUTH CHECKS PASSED`); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
