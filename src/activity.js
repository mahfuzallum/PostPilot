// Login activity: who logged in, when, from which IP / country, with a short user-agent label.
const { db } = require('./db');
const RETAIN_MS = 90 * 864e5;
let geo; // lazy, optional (geoip-lite is an optionalDependency)
function geoLookup(ip) {
  if (process.env.GEOIP_LOOKUP === 'off') return null;
  if (geo === undefined) { try { geo = require('geoip-lite'); } catch { geo = null; } }
  try { return geo && ip ? (geo.lookup(ip) || {}).country || null : null; } catch { return null; }
}
function clientIp(req) { return String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, ''); }
function country(req) {
  const h = String(req.get('cf-ipcountry') || req.get('x-country') || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(h) && h !== 'XX' && h !== 'T1') return h;
  return geoLookup(clientIp(req)) || 'Unknown';
}
function shortUA(ua = '') {
  ua = String(ua);
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|node|python|bot/i.test(ua) ? 'Script/bot' : 'Other';
  const o = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
}
function record(userId, req, kind = 'login') {
  const now = Date.now(), ip = clientIp(req), c = country(req), ua = shortUA(req.get('user-agent'));
  db.prepare('INSERT INTO login_events(user_id,kind,ts,ip,country,ua) VALUES(?,?,?,?,?,?)').run(userId, kind, now, ip, c, ua);
  db.prepare('UPDATE users SET last_login=?, last_ip=?, last_country=?, last_seen=? WHERE id=?').run(now, ip, c, now, userId);
  return { ts: now, ip, country: c, ua };
}
function touch(user) { // "active" signal, written at most every 5 minutes per user
  const now = Date.now();
  if (user && (!user.last_seen || now - user.last_seen > 5 * 60e3)) db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now, user.id);
}
function prune(now = Date.now()) { return db.prepare('DELETE FROM login_events WHERE ts < ?').run(now - RETAIN_MS).changes; }
module.exports = { record, touch, prune, country, shortUA, clientIp, RETAIN_MS };
