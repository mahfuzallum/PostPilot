// Per-user OAuth accounts. Tokens are AES-256-GCM encrypted at rest and refreshed automatically.
// End users never see or type tokens: they only click Connect / Disconnect.
const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const S = require('./settings');
const threads = require('./platforms/threads');
const reddit = require('./platforms/reddit');
const x = require('./platforms/x');
const google = require('./platforms/google');

try { db.exec('ALTER TABLE accounts ADD COLUMN avatar TEXT'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN status TEXT'); } catch {}

// How long before expiry we refresh proactively.
const AHEAD = { threads: 7 * 864e5, reddit: 10 * 60e3, x: 10 * 60e3, google: 10 * 60e3 };

// Multiple accounts per platform are allowed (UNIQUE user_id+platform+ext_id). Re-connecting the same
// external account updates it in place. Most functions take an optional accountId; without it the
// user's first (oldest) account for that platform is used.
(function migrateMulti() {
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='accounts'").get() || {}).sql || '';
  if (!/UNIQUE\s*\(\s*user_id\s*,\s*platform\s*\)/i.test(sql)) return;
  db.exec(`BEGIN; ALTER TABLE accounts RENAME TO accounts_old;
  CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL,
    ext_id TEXT, username TEXT, token_enc TEXT, refresh_enc TEXT, expires_at INTEGER, created INTEGER, avatar TEXT, status TEXT,
    UNIQUE(user_id, platform, ext_id));
  INSERT INTO accounts SELECT id,user_id,platform,ext_id,username,token_enc,refresh_enc,expires_at,created,avatar,status FROM accounts_old;
  DROP TABLE accounts_old; COMMIT;`);
})();
try { db.exec('ALTER TABLE posts ADD COLUMN account_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE accounts ADD COLUMN scope TEXT'); } catch {}

function save(userId, platform, { extId, username, token, refresh, expiresIn, avatar, scope }) {
  extId = String(extId || platform);
  db.prepare(`INSERT INTO accounts(user_id,platform,ext_id,username,token_enc,refresh_enc,expires_at,created,avatar,status,scope) VALUES(?,?,?,?,?,?,?,?,?,'ok',?)
    ON CONFLICT(user_id,platform,ext_id) DO UPDATE SET username=excluded.username,token_enc=excluded.token_enc,
    refresh_enc=COALESCE(excluded.refresh_enc,accounts.refresh_enc),expires_at=excluded.expires_at,avatar=COALESCE(excluded.avatar,accounts.avatar),scope=COALESCE(excluded.scope,accounts.scope),status='ok'`)
    .run(userId, platform, extId, username, encrypt(token), encrypt(refresh), expiresIn ? Date.now() + expiresIn * 1000 : null, Date.now(), avatar || null, scope || null);
  return db.prepare('SELECT id FROM accounts WHERE user_id=? AND platform=? AND ext_id=?').get(userId, platform, extId).id;
}
const get = (userId, platform, id) => id
  ? db.prepare('SELECT * FROM accounts WHERE user_id=? AND platform=? AND id=?').get(userId, platform, id)
  : db.prepare('SELECT * FROM accounts WHERE user_id=? AND platform=? ORDER BY id LIMIT 1').get(userId, platform);
const all = (userId, platform) => db.prepare('SELECT * FROM accounts WHERE user_id=? AND platform=? ORDER BY id').all(userId, platform);
const list = userId => db.prepare('SELECT id,platform,username,avatar,status,scope,expires_at,created FROM accounts WHERE user_id=? ORDER BY platform,id').all(userId);
const remove = (userId, id) => db.prepare('DELETE FROM accounts WHERE user_id=? AND id=?').run(userId, id).changes;
const markStatus = (userId, platform, s, id) => { const a = get(userId, platform, id); if (a) db.prepare('UPDATE accounts SET status=? WHERE id=?').run(s, a.id); };

// Exchange the stored refresh credential for a new access token and save it.
async function refresh(userId, platform, id) {
  const a = get(userId, platform, id);
  if (!a) throw new Error(`${platform} not connected`);
  let r;
  try {
    if (platform === 'threads') {
      if (a.expires_at && a.expires_at < Date.now()) throw new Error('Threads login expired - click Reconnect');
      r = await threads.client.refresh(decrypt(a.token_enc)); // th_refresh_token: new 60-day token
    } else {
      const rt = decrypt(a.refresh_enc); if (!rt) throw new Error(`${platform} login expired - click Reconnect`);
      if (platform === 'x') r = await x.token(S.get('x_client_id'), S.get('x_client_secret'), { grant_type: 'refresh_token', refresh_token: rt });
      else if (platform === 'reddit') r = await reddit.token(S.get('reddit_client_id'), S.get('reddit_client_secret'), { grant_type: 'refresh_token', refresh_token: rt });
      else if (platform === 'google') r = await google.token({ grant_type: 'refresh_token', refresh_token: rt, client_id: S.get('google_client_id'), client_secret: S.get('google_client_secret') });
      else throw new Error('Unknown platform');
    }
  } catch (e) { if (e.status === 400 || e.status === 401 || /expired|Reconnect/.test(e.message)) markStatus(userId, platform, 'reconnect', a.id); throw e; }
  save(userId, platform, { extId: a.ext_id, username: a.username, token: r.token, refresh: r.refresh, expiresIn: r.expiresIn, scope: r.scope });
  return r.token;
}

// Returns a valid access token, refreshing first if it expires soon.
async function token(userId, platform, id) {
  const a = get(userId, platform, id);
  if (!a) throw new Error(`${platform} not connected`);
  const soon = a.expires_at && a.expires_at - Date.now() < (AHEAD[platform] || 120e3);
  const t = soon ? await refresh(userId, platform, a.id) : decrypt(a.token_enc);
  return { token: t, account: get(userId, platform, a.id) };
}

const isAuthErr = e => e && (e.status === 401 || (e.data && e.data.error && e.data.error.code === 190));
// Run fn(token, account); if the provider answers 401 (token revoked/expired early), refresh once and retry.
async function withToken(userId, platform, fn, id) {
  const { token: t, account } = await token(userId, platform, id);
  try { return await fn(t, account); }
  catch (e) {
    if (!isAuthErr(e)) throw e;
    const nt = await refresh(userId, platform, account.id);
    return fn(nt, get(userId, platform, account.id));
  }
}

// Worker: refresh every account that will expire soon (all platforms).
async function refreshDue(log = () => {}) {
  const now = Date.now(); let n = 0;
  for (const a of db.prepare("SELECT id,user_id,platform,expires_at FROM accounts WHERE expires_at IS NOT NULL AND COALESCE(status,'ok')='ok'").all()) {
    if (a.expires_at - now > (AHEAD[a.platform] || 120e3)) continue;
    try { await refresh(a.user_id, a.platform, a.id); n++; log(`refreshed ${a.platform} token for user ${a.user_id}`); } catch (e) { log('refresh failed', a.platform, a.user_id, e.message); }
  }
  return n;
}
// Publishing needs a write scope. Accounts connected before posting existed (read-only) must reconnect.
const WRITE = { x: 'tweet.write', reddit: 'submit' };
const canPost = a => !!a && (a.platform === 'threads' || (WRITE[a.platform] && String(a.scope || '').split(/[\s,]+/).includes(WRITE[a.platform])));
module.exports = { canPost, WRITE, save, get, all, list, remove, markStatus, token, refresh, withToken, refreshDue, isAuthErr, AHEAD };
