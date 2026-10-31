// App configuration. ALL credentials come ONLY from server environment variables (Railway Variables).
// Nothing secret is ever entered through the website. The database only stores values the app
// creates itself (e.g. Stripe price IDs and the auto-created webhook signing secret).
const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto');

const ENV = {
  threads_app_id: 'THREADS_APP_ID', threads_app_secret: 'THREADS_APP_SECRET', threads_keyword: 'THREADS_KEYWORD_SEARCH',
  reddit_client_id: 'REDDIT_CLIENT_ID', reddit_client_secret: 'REDDIT_CLIENT_SECRET',
  x_client_id: 'X_CLIENT_ID', x_client_secret: 'X_CLIENT_SECRET',
  openai_key: 'OPENAI_API_KEY', openai_model: 'OPENAI_MODEL',
  cloudinary_cloud: 'CLOUDINARY_CLOUD_NAME', cloudinary_key: 'CLOUDINARY_API_KEY', cloudinary_secret: 'CLOUDINARY_API_SECRET',
  google_client_id: 'GOOGLE_CLIENT_ID', google_client_secret: 'GOOGLE_CLIENT_SECRET',
  app_url: 'APP_URL',
};
const DEFAULTS = { free_limit: '10', app_name: 'PostPilot', default_tz: 'Asia/Dhaka', caption_default: '', openai_model: 'gpt-4o-mini', threads_keyword: 'no', registration_open: '1' };
// Non-credential app settings (app_name, default_tz, caption_default, free_limit) live in the DB and are
// edited by the owner on the hidden owner page.
const INTERNAL_SECRET = new Set();

function get(k, def = '') {
  if (ENV[k]) return process.env[ENV[k]] || DEFAULTS[k] || def;
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
  if (!r || r.value == null || r.value === '') return DEFAULTS[k] || def;
  return INTERNAL_SECRET.has(k) ? decrypt(r.value) : r.value;
}
function set(k, v) { // internal, app-generated values only
  if (ENV[k]) throw new Error(`${ENV[k]} is set via server environment variables only`);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, INTERNAL_SECRET.has(k) ? encrypt(v) : v);
}
const has = k => !!get(k);
const PLATFORM_READY = { threads: () => has('threads_app_id') && has('threads_app_secret'), reddit: () => has('reddit_client_id') && has('reddit_client_secret'), x: () => has('x_client_id'), google: () => has('google_client_id') && has('google_client_secret') };
const ready = p => !!(PLATFORM_READY[p] && PLATFORM_READY[p]());
const SETUP = { threads: { need: ['THREADS_APP_ID', 'THREADS_APP_SECRET'], optional: [], https: true },
  x: { need: ['X_CLIENT_ID'], optional: ['X_CLIENT_SECRET'] }, reddit: { need: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], optional: [] } };
// Read-only status for the owner panel: which Railway Variables are missing per platform (never values).
function setupStatus(appUrl) {
  const base = String(appUrl || process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');
  return Object.entries(SETUP).map(([p, c]) => ({ platform: p, ready: ready(p), missing: c.need.filter(v => !process.env[v]), optionalMissing: c.optional.filter(v => !process.env[v]),
    callback: (base || '<APP_URL>') + '/oauth/' + p + '/callback', httpsProblem: !!c.https && !!base && !/^https:/.test(base) }));
}
module.exports = { ENV, get, set, has, ready, SETUP, setupStatus };
