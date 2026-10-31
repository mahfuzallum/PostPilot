// Audit trail: every meaningful user and owner action (who, what, target, when, IP).
const { db } = require('./db');
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor_type TEXT NOT NULL, actor TEXT, actor_id INTEGER,
  action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit_log(ts);`);
const ipOf = req => req ? String(req.ip || '').replace(/^::ffff:/, '') : null;
// actor: { type: 'user'|'owner'|'system', id, name }
function audit(req, actor, action, target = null, detail = null) {
  db.prepare('INSERT INTO audit_log(ts,actor_type,actor,actor_id,action,target,detail,ip) VALUES(?,?,?,?,?,?,?,?)')
    .run(Date.now(), actor.type, actor.name || null, actor.id || null, action, target == null ? null : String(target), detail == null ? null : String(detail).slice(0, 500), ipOf(req));
}
const asUser = u => ({ type: 'user', id: u.id, name: u.email });
function query({ q, action, actorType, days, limit = 50, offset = 0 } = {}) {
  const w = [], a = [];
  if (q) { w.push('(actor LIKE ? OR target LIKE ? OR detail LIKE ? OR ip LIKE ?)'); a.push(...Array(4).fill(`%${q}%`)); }
  if (action) { w.push('action LIKE ?'); a.push(action + '%'); }
  if (actorType) { w.push('actor_type=?'); a.push(actorType); }
  if (days) { w.push('ts>=?'); a.push(Date.now() - days * 864e5); }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return { total: db.prepare(`SELECT COUNT(*) c FROM audit_log ${where}`).get(...a).c,
    rows: db.prepare(`SELECT * FROM audit_log ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...a, limit, offset) };
}
const prune = (days = 365) => db.prepare('DELETE FROM audit_log WHERE ts<?').run(Date.now() - days * 864e5).changes;
module.exports = { audit, asUser, query, prune };
