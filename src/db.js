const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, is_admin INTEGER DEFAULT 0,
  plan TEXT DEFAULT 'free', plan_until INTEGER DEFAULT 0, plan_source TEXT, stripe_customer TEXT,
  theme TEXT DEFAULT 'default', font TEXT DEFAULT 'inter', mode TEXT DEFAULT 'dark', low_reach INTEGER DEFAULT 15, subreddits TEXT DEFAULT '',
  created INTEGER);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT NOT NULL,
  ext_id TEXT, username TEXT, token_enc TEXT, refresh_enc TEXT, expires_at INTEGER, created INTEGER,
  UNIQUE(user_id, platform));
CREATE TABLE IF NOT EXISTS oauth_state (state TEXT PRIMARY KEY, user_id INTEGER, platform TEXT, verifier TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, platform TEXT DEFAULT 'threads',
  text TEXT, media_type TEXT DEFAULT 'TEXT', media_urls TEXT DEFAULT '[]', image_ids TEXT DEFAULT '[]', link TEXT, link_reply INTEGER DEFAULT 0,
  disclosure INTEGER DEFAULT 1, scheduled_at INTEGER, status TEXT DEFAULT 'scheduled', attempts INTEGER DEFAULT 0,
  next_try INTEGER, locked_at INTEGER, ext_id TEXT, reply_ext_id TEXT, permalink TEXT, error TEXT, published_at INTEGER,
  views INTEGER, likes INTEGER, replies INTEGER, reposts INTEGER, insights_at INTEGER, deleted_at INTEGER,
  batch_id TEXT, auto_slot INTEGER DEFAULT 0, created INTEGER);
CREATE INDEX IF NOT EXISTS posts_due ON posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, hash TEXT NOT NULL,
  url TEXT, source TEXT, score REAL, used INTEGER DEFAULT 0, created INTEGER, UNIQUE(user_id, hash));
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, user_id INTEGER, provider TEXT, ext_id TEXT, plan TEXT, amount REAL, status TEXT, created INTEGER,
  UNIQUE(provider, ext_id));
CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, link TEXT, seen INTEGER DEFAULT 0, created INTEGER);
`);


// lightweight migrations
for (const col of ["disabled INTEGER DEFAULT 0", "ban_reason TEXT", "display_name TEXT", "def_smode TEXT DEFAULT 'exact'", "def_disclosure INTEGER DEFAULT 1",
  "notify_fail INTEGER DEFAULT 1", "notify_renew INTEGER DEFAULT 1", "last_login INTEGER", "last_ip TEXT", "last_country TEXT", "last_seen INTEGER", "push_enabled INTEGER DEFAULT 1", "tz TEXT", "openai_key_enc TEXT", "plan_start INTEGER", "email_post_deleted INTEGER DEFAULT 1", "email_expiry INTEGER DEFAULT 1", "email_payment INTEGER DEFAULT 1", "expired_mailed INTEGER", "reminded_until INTEGER", "tz_auto INTEGER"])
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch (e) { /* already there */ }
db.exec(`
CREATE TABLE IF NOT EXISTS login_events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT DEFAULT 'login', ts INTEGER NOT NULL, ip TEXT, country TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS login_events_ts ON login_events(ts);
CREATE TABLE IF NOT EXISTS ban_log (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, action TEXT NOT NULL, reason TEXT, by TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments_ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT, amount REAL NOT NULL, currency TEXT DEFAULT 'USD', source TEXT, external_id TEXT UNIQUE, note TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_ts ON payments_ledger(ts);
CREATE TABLE IF NOT EXISTS subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  amount REAL, source TEXT, status TEXT DEFAULT 'active', ledger_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS email_log (id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT, to_addr TEXT, subject TEXT, status TEXT, error TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plan_log (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, action TEXT NOT NULL, plan TEXT, detail TEXT, by TEXT, ts INTEGER NOT NULL);
`);
for (const col of ['subreddit TEXT', "reddit_kind TEXT DEFAULT 'self'", 'target_group TEXT'])
  try { db.exec('ALTER TABLE posts ADD COLUMN ' + col); } catch (e) { /* already there */ }
module.exports = { db, DATA_DIR };
