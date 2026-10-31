// AES-256-GCM for tokens at rest. ENCRYPTION_KEY / SESSION_SECRET come from env, or are generated once
// and persisted in the data directory (/data on Railway) so they survive restarts.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

function persisted(envName, file) {
  if (process.env[envName]) return process.env[envName];
  const p = path.join(DATA_DIR, file);
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  // migrate from older versions that kept the key in the database
  const legacy = envName === 'ENCRYPTION_KEY' && (process.env.APP_SECRET || (db.prepare("SELECT value FROM settings WHERE key='__app_secret'").get() || {}).value);
  const v = legacy || crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(p, v, { mode: 0o600 });
  return v;
}
let _enc, _ses;
const encryptionKey = () => _enc || (_enc = persisted('ENCRYPTION_KEY', '.encryption_key'));
const sessionSecret = () => _ses || (_ses = persisted('SESSION_SECRET', '.session_secret'));
const key = () => crypto.createHash('sha256').update(encryptionKey()).digest();

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split(':');
  if (v !== 'v1') return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
module.exports = { encrypt, decrypt, appSecret: sessionSecret, sessionSecret, encryptionKey };
