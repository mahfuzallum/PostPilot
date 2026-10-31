const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const S = require('./settings');

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const cloudinaryOn = () => S.has('cloudinary_cloud') && S.has('cloudinary_key') && S.has('cloudinary_secret');

async function uploadCloudinary(buf, mime) {
  const ts = Math.floor(Date.now() / 1000), folder = 'social-scheduler';
  const sig = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${ts}${S.get('cloudinary_secret')}`).digest('hex');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }));
  fd.append('api_key', S.get('cloudinary_key')); fd.append('timestamp', ts); fd.append('folder', folder); fd.append('signature', sig);
  const kind = /^video/.test(mime) ? 'video' : 'image';
  const r = await fetch(`https://api.cloudinary.com/v1_1/${S.get('cloudinary_cloud')}/${kind}/upload`, { method: 'POST', body: fd });
  const j = await r.json(); if (!r.ok) throw new Error('Cloudinary: ' + (j.error && j.error.message));
  return j.secure_url;
}

// Stores media and returns { id, url, duplicate }. Dedupe by SHA-256 per user; used images are never reused.
async function store(userId, buf, mime, source, score, baseUrl) {
  const hash = sha256(buf);
  const ex = db.prepare('SELECT * FROM images WHERE user_id=? AND hash=?').get(userId, hash);
  if (ex) return { id: ex.id, url: ex.url, duplicate: true, used: !!ex.used };
  let url;
  if (cloudinaryOn()) url = await uploadCloudinary(buf, mime);
  else { // fallback: serve from the Railway volume (must be publicly reachable for Threads)
    const ext = (mime.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('quicktime', 'mov');
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', `${hash}.${ext}`), buf);
    url = `${baseUrl}/u/${hash}.${ext}`;
  }
  const r = db.prepare('INSERT INTO images(user_id,hash,url,source,score,created) VALUES(?,?,?,?,?,?)').run(userId, hash, url, source, score || null, Date.now());
  return { id: r.lastInsertRowid, url, duplicate: false };
}
module.exports = { store, sha256, cloudinaryOn };
