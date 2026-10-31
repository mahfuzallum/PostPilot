// Reliable queue worker: every 30s. Idempotent via atomic status transitions (scheduled -> posting -> published/failed).
const { db } = require('./db');
const threads = require('./platforms/threads');
const xapi = require('./platforms/x');
const reddit = require('./platforms/reddit');
const accounts = require('./accounts');
const S = require('./settings');
const P = require('./payments');

// Auto-retry: up to 4 tries in total, waiting 2, 5, 15 then 60 minutes between them.
const BACKOFF_MIN = [2, 5, 15, 60];
const LATE_MS = 15 * 60e3, MAX_ATTEMPTS = 4, INSIGHT_AFTER = 6.5 * 3600e3;
const log = (...a) => console.log(new Date().toISOString(), '[worker]', ...a);

function withDisclosure(text, on) { const tag = '#ad / affiliate'; return on && !text.includes(tag) ? `${text}\n\n${tag}` : text; }
const LIMITS = { threads: 500, x: 280 };
const NAMES = { threads: 'Threads', x: 'X', reddit: 'Reddit' };
function buildTexts(p, limit = LIMITS[p.platform] || threads.LIMIT) {
  const hasLinkInText = /https?:\/\/\S+/i.test(p.text || '');
  let main = p.text || '', reply = null;
  if (p.link && p.link_reply) reply = withDisclosure(p.link, p.disclosure);
  else if (p.link) main = `${main}\n\n${p.link}`;
  if ((p.link && !p.link_reply) || hasLinkInText) main = withDisclosure(main, p.disclosure);
  return { main: main.slice(0, limit), reply: reply && reply.slice(0, limit), overflow: main.length > limit || (reply || '').length > limit, length: main.length };
}

async function health(userId, accountId) {
  // withToken refreshes proactively and retries once on HTTP 401 (expired/revoked token)
  let token, account;
  const lim = await accounts.withToken(userId, 'threads', (tk, acc) => { token = tk; account = acc; return threads.client.publishingLimit(acc.ext_id, tk); }, accountId); // also proves API reachable + token valid
  if (lim.used >= lim.total) throw Object.assign(new Error(`Publishing quota reached (${lim.used}/${lim.total} in 24h)`), { retryable: true });
  return { token, uid: account.ext_id, lim };
}

// 'auth' = token revoked/expired, 'permanent' = validation error that a retry cannot fix, else 'retry'.
function classify(e) {
  if (!e) return 'retry';
  if (e.retryable) return 'retry';
  if (accounts.isAuthErr(e) || /reconnect|not connected|expired/i.test(e.message || '')) return 'auth';
  const code = e.data && e.data.error && e.data.error.code;
  if (e.permanent || e.status === 400 || e.status === 422 || code === 100 || /too long|invalid|unsupported|required/i.test(e.message || '')) return 'permanent';
  return 'retry';
}
// Reddit: title = first line (max 300). Self post body = the rest + link/disclosure. Link post: URL = the link.
function redditParts(p) {
  const [first, ...rest] = String(p.text || '').split('\n'); const title = first.trim();
  let body = rest.join('\n').trim();
  const kind = p.reddit_kind === 'link' && p.link ? 'link' : 'self';
  if (kind === 'self' && p.link) body = `${body}${body ? '\n\n' : ''}${p.link}`;
  if (p.link && p.disclosure) body = withDisclosure(body, true);
  return { title, body, kind, url: kind === 'link' ? p.link : null, overflow: title.length > 300 || !title };
}
async function publishX(p) {
  return accounts.withToken(p.user_id, 'x', async (token, acc) => {
    if (!accounts.canPost(acc)) throw new Error('X account needs reconnect to enable posting (missing tweet.write)');
    const { main, reply } = buildTexts(p, 280);
    const urls = p.media_type === 'TEXT' ? [] : JSON.parse(p.media_urls || '[]');
    const mediaIds = []; for (const u of urls.slice(0, 4)) mediaIds.push(await xapi.uploadMedia(token, u));
    const r = await xapi.post(token, { text: main, mediaIds });
    let replyId = null; if (reply) replyId = (await xapi.post(token, { text: reply, replyTo: r.id })).id;
    return { id: r.id, replyId, link: `https://x.com/${acc.username}/status/${r.id}` };
  }, p.account_id);
}
async function publishReddit(p) {
  return accounts.withToken(p.user_id, 'reddit', async (token, acc) => {
    if (!accounts.canPost(acc)) throw new Error('Reddit account needs reconnect to enable posting (missing submit scope)');
    if (!p.subreddit) throw Object.assign(new Error('Subreddit required'), { permanent: true });
    const r = redditParts(p);
    const out = await reddit.submit(token, { sr: p.subreddit, title: r.title.slice(0, 300), text: r.body, url: r.url, kind: r.kind });
    return { id: out.id, replyId: null, link: out.url };
  }, p.account_id);
}
async function publishThreads(p) {
  const { token, uid } = await health(p.user_id, p.account_id);
  const { main, reply } = buildTexts(p, 500);
  const r = await threads.postThread(threads.client, { uid, token, text: main, mediaType: p.media_type, mediaUrls: JSON.parse(p.media_urls || '[]'), replyText: reply });
  let link = null; try { link = await threads.client.permalink(r.id, token); } catch {}
  return { id: r.id, replyId: r.replyId, link };
}
const PUBLISH = { threads: publishThreads, x: publishX, reddit: publishReddit };
async function publishOne(p) {
  const lock = db.prepare("UPDATE posts SET status='posting', locked_at=? WHERE id=? AND status='scheduled'").run(Date.now(), p.id);
  if (lock.changes !== 1) return 'skipped'; // someone else took it
  try {
    const plat = p.platform || 'threads', fn = PUBLISH[plat]; if (!fn) throw Object.assign(new Error('Unsupported platform ' + plat), { permanent: true });
    const r = await fn(p);
    db.prepare("UPDATE posts SET status='published', ext_id=?, reply_ext_id=?, permalink=?, published_at=?, error=NULL, locked_at=NULL WHERE id=?").run(r.id, r.replyId, r.link, Date.now(), p.id);
    const ids = JSON.parse(p.image_ids || '[]'); if (ids.length) db.prepare(`UPDATE images SET used=1 WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`).run(p.user_id, ...ids);
    log('published', p.id, r.id); return 'published';
  } catch (e) {
    const attempts = p.attempts + 1, kind = classify(e);
    const failNotice = msg => { if ((db.prepare('SELECT notify_fail FROM users WHERE id=?').get(p.user_id) || {}).notify_fail !== 0) db.prepare('INSERT INTO notices(user_id,text,link,created) VALUES(?,?,?,?)').run(p.user_id, msg, '/queue', Date.now()); };
    if (kind === 'auth') { // token revoked / expired: no retry, ask the user to reconnect
      const plat = p.platform || 'threads';
      if (p.account_id || accounts.get(p.user_id, plat)) accounts.markStatus(p.user_id, plat, 'reconnect', p.account_id);
      db.prepare("UPDATE posts SET status='failed', attempts=?, error=?, next_try=NULL, locked_at=NULL WHERE id=?").run(attempts, 'Needs reconnect: ' + e.message, p.id);
      failNotice(`A post could not be published because your ${NAMES[p.platform] || 'Threads'} login expired or lacks posting access. Reconnect on the Accounts page.`);
    } else if (kind === 'permanent' || attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE posts SET status='failed', attempts=?, error=?, next_try=NULL, locked_at=NULL WHERE id=?").run(attempts, (kind === 'permanent' ? 'Not retried: ' : '') + e.message, p.id);
      failNotice('A scheduled post failed' + (kind === 'permanent' ? ' (the platform rejected it).' : ' after 4 tries.') + ' Open the queue to edit or retry.');
    } else db.prepare("UPDATE posts SET status='scheduled', attempts=?, error=?, next_try=?, locked_at=NULL WHERE id=?").run(attempts, e.message, Date.now() + BACKOFF_MIN[attempts - 1] * 60e3, p.id);
    log('error', p.id, e.message); return 'error';
  }
}

let running = false;
async function tick(now = Date.now()) {
  if (running) return; running = true;
  try {
    try { require('./payments').planHousekeeping(now); } catch (e) { log('plan housekeeping: ' + e.message); }
    // posts never attempted and >15min late (server was down) => missed
    db.prepare("UPDATE posts SET status='missed', error='Server was offline at scheduled time (>15 min late)' WHERE status='scheduled' AND attempts=0 AND scheduled_at < ? AND user_id NOT IN (SELECT id FROM users WHERE COALESCE(push_enabled,1)=0 OR COALESCE(disabled,0)=1)").run(now - LATE_MS);
    // stale locks (crash mid-post): don't risk double posting -> mark for review
    db.prepare("UPDATE posts SET status='failed', error='Interrupted while posting - check the platform before retrying' WHERE status='posting' AND locked_at < ?").run(now - 15 * 60e3);
    const due = db.prepare("SELECT * FROM posts WHERE status='scheduled' AND scheduled_at <= ? AND (next_try IS NULL OR next_try <= ?) AND user_id IN (SELECT id FROM users WHERE COALESCE(push_enabled,1)=1 AND COALESCE(disabled,0)=0) ORDER BY scheduled_at LIMIT 10").all(now, now);
    for (const p of due) await publishOne(p);
    await insights(now); await refreshTokens(); await reminders(now);
  } catch (e) { log('tick failed', e.message); } finally { running = false; }
}

async function insights(now) {
  const rows = db.prepare("SELECT * FROM posts WHERE status='published' AND COALESCE(platform,'threads')='threads' AND insights_at IS NULL AND published_at <= ? LIMIT 20").all(now - INSIGHT_AFTER);
  for (const p of rows) {
    try { const m = await accounts.withToken(p.user_id, 'threads', tk => threads.client.insights(p.ext_id, tk), p.account_id);
      db.prepare('UPDATE posts SET views=?, likes=?, replies=?, reposts=?, insights_at=? WHERE id=?').run(m.views, m.likes, m.replies, m.reposts, now, p.id);
    } catch (e) { log('insights', p.id, e.message); if (now - p.published_at > 48 * 3600e3) db.prepare('UPDATE posts SET insights_at=? WHERE id=?').run(now, p.id); }
  }
}
let lastRefresh = 0;
// Proactive refresh for every platform (Threads 7 days ahead, Reddit/X/Google 10 min ahead). Runs every 5 min.
async function refreshTokens() {
  if (Date.now() - lastRefresh < 5 * 60e3) return; lastRefresh = Date.now();
  await accounts.refreshDue(log);
}
let lastRem = 0;
async function reminders(now, force = false) {
  if (!force && now - lastRem < 3600e3) return; lastRem = now;
  const { notify, T } = require('./mailer');
  // 3 days before the end: in-app notice + email (once per expiry date)
  for (const u of db.prepare("SELECT * FROM users WHERE plan!='free' AND plan_until BETWEEN ? AND ? AND COALESCE(reminded_until,0)!=plan_until").all(now, now + 3 * 864e5)) {
    db.prepare('UPDATE users SET reminded_until=? WHERE id=?').run(u.plan_until, u.id);
    if (u.notify_renew !== 0) db.prepare('INSERT INTO notices(user_id,text,link,created) VALUES(?,?,?,?)').run(u.id, 'Your Premium expires in less than 3 days. See Billing to renew.', '/billing', now);
    await notify(u.id, 'sub_expiring', T.subExpiring({ plan: u.plan, until: u.plan_until }));
  }
  // expired: email once, close the subscription rows
  for (const u of db.prepare("SELECT * FROM users WHERE plan!='free' AND plan_until IS NOT NULL AND plan_until<=? AND COALESCE(expired_mailed,0)!=plan_until").all(now)) {
    db.prepare('UPDATE users SET expired_mailed=? WHERE id=?').run(u.plan_until, u.id);
    db.prepare("UPDATE subscriptions SET status='expired' WHERE user_id=? AND status='active' AND end_at<=?").run(u.id, now);
    await notify(u.id, 'sub_expired', T.subExpired({ plan: u.plan }));
  }
  try { require('./activity').prune(now); } catch {}
}
function start() { log('started (30s interval)'); tick(); return setInterval(tick, 30e3); }
module.exports = { classify, reminders, BACKOFF_MIN, MAX_ATTEMPTS, refreshTokens, start, tick, publishOne, buildTexts, redditParts, LIMITS, withDisclosure, health };
