// ============================================================================
// PAYMENTS: built-in ledger + subscription tracking (no payment-processor SDKs).
//
// Every confirmed payment becomes one row in `payments_ledger` and one row in
// `subscriptions`, and extends the user's Premium (`users.plan` / `plan_until`).
//
// recordPayment({ userId, plan, amount, currency, source, externalId, paidAt, startAt, note, by })
//   userId     required  users.id
//   plan       required  'monthly' | 'quarterly' | 'semiannual' | 'yearly'
//   amount     optional  defaults to the plan list price (USD)
//   currency   optional  default 'USD'
//   source     optional  'manual' | 'stripe' | 'nowpayments' | 'other' (default 'manual')
//   externalId optional  provider payment id; a repeated externalId is ignored (idempotent)
//   paidAt     optional  ms timestamp, default now
//   startAt    optional  custom subscription start (ms). Default: the current expiry when Premium is
//                        still active (so time is added on top), otherwise paidAt.
// Returns { duplicate, ledgerId, subscriptionId, start, end }.
//
// Plugging in a provider later (example only, no SDK code here):
//   app.post('/hooks/payment', express.raw({ type: '*/*' }), (req, res) => {
//     // 1. verify the provider signature (Stripe-Signature / x-nowpayments-sig) with its secret from env
//     // 2. map the event to a user + plan, then:
//     //    P.recordPayment({ userId, plan, amount, currency, source: 'stripe', externalId: event.id });
//     res.json({ ok: true });
//   });
// ============================================================================
const { db } = require('./db');

const PLANS = {
  monthly: { usd: 7, days: 30, label: '1 month', months: 1 },
  quarterly: { usd: 16, days: 90, label: '3 months', months: 3 },
  semiannual: { usd: 30, days: 180, label: '6 months', months: 6 },
  yearly: { usd: 50, days: 365, label: '1 year', months: 12 },
};
const SOURCES = ['manual', 'stripe', 'nowpayments', 'other'];
const DAY = 864e5;

// Pause = premium OFF for a while (paused_until NULL = indefinitely). Temporary premium = ON until temp_until,
// independent of the paid plan. Both are time-based, so they take effect immediately; the worker's
// planHousekeeping() clears them, extends expiry when asked, and writes the history entries.
const isPaused = (u, now = Date.now()) => !!u && !!u.paused_at && (!u.paused_until || u.paused_until > now);
const hasTemp = (u, now = Date.now()) => !!u && (u.temp_until || 0) > now;
const isPremium = u => { const now = Date.now(); return !!u && !isPaused(u, now) && ((u.plan !== 'free' && (u.plan_until || 0) > now) || hasTemp(u, now)); };
// Same rule in SQL for list filters / counts (alias u). now is a number, never user input.
const premiumSQL = now => `(NOT (u.paused_at IS NOT NULL AND (u.paused_until IS NULL OR u.paused_until>${+now})) AND ((u.plan!='free' AND u.plan_until>${+now}) OR COALESCE(u.temp_until,0)>${+now}))`;
const log = (userId, action, plan, detail, by) =>
  db.prepare('INSERT INTO plan_log(user_id,action,plan,detail,by,ts) VALUES(?,?,?,?,?,?)').run(userId, action, plan || null, detail || null, by || null, Date.now());

const CUSTOM = { usd: 0, days: 30, label: 'Custom', months: 1 };
const recordPayment = db.transaction(({ userId, plan, amount, currency = 'USD', source = 'manual', externalId = null, paidAt, startAt, endAt, note = null, by = null } = {}) => {
  const p = plan === 'custom' ? CUSTOM : PLANS[plan]; if (!p) throw new Error('Unknown plan: ' + plan);
  if (plan === 'custom' && !endAt) throw new Error('Custom plan needs an expiry date');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId); if (!u) throw new Error('Unknown user');
  if (externalId) { const ex = db.prepare('SELECT id FROM payments_ledger WHERE external_id=?').get(String(externalId)); if (ex) return { duplicate: true, ledgerId: ex.id }; }
  const now = paidAt || Date.now();
  const amt = amount == null || amount === '' || isNaN(Number(amount)) ? p.usd : Math.max(0, Math.round(Number(amount) * 100) / 100);
  const src = SOURCES.includes(source) ? source : 'other';
  const start = startAt || (isPremium(u) ? u.plan_until : now);
  const end = endAt && endAt > start ? endAt : start + p.days * DAY;
  const lid = db.prepare('INSERT INTO payments_ledger(user_id,plan,amount,currency,source,external_id,note,ts) VALUES(?,?,?,?,?,?,?,?)')
    .run(userId, plan, amt, currency, src, externalId ? String(externalId) : null, note, now).lastInsertRowid;
  const sid = db.prepare("INSERT INTO subscriptions(user_id,plan,start_at,end_at,amount,source,status,ledger_id,created) VALUES(?,?,?,?,?,?,'active',?,?)")
    .run(userId, plan, start, end, amt, src, lid, Date.now()).lastInsertRowid;
  db.prepare('UPDATE users SET plan=?, plan_until=?, plan_source=?, plan_start=COALESCE(CASE WHEN plan_until>? THEN plan_start END, ?) WHERE id=?').run(plan, end, src, Date.now(), start, userId);
  db.prepare("UPDATE plan_intents SET status='granted', resolved=? WHERE user_id=? AND status='pending'").run(Date.now(), userId);
  log(userId, 'grant', plan, `$${amt} ${currency} via ${src}; ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`, by);
  return { duplicate: false, ledgerId: lid, subscriptionId: sid, start, end };
});

function revoke(userId, by, reason) {
  const now = Date.now();
  db.prepare("UPDATE subscriptions SET status='revoked', end_at=MIN(end_at, ?) WHERE user_id=? AND status='active' AND end_at>?").run(now, userId, now);
  db.prepare("UPDATE users SET plan='free', plan_until=NULL, plan_start=NULL, paused_at=NULL, paused_until=NULL, pause_extend=NULL, temp_until=NULL, temp_from=NULL WHERE id=?").run(userId);
  log(userId, 'revoke', null, reason || null, by);
}

// Back-compat helper: extend without money changing hands (recorded as a $0 manual entry).
const extend = (userId, plan, source = 'manual') => recordPayment({ userId, plan, amount: 0, source: SOURCES.includes(source) ? source : 'manual', note: 'complimentary' });

function stats(now = Date.now()) {
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM payments_ledger').get();
  const byPlan = db.prepare('SELECT plan, COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments_ledger GROUP BY plan ORDER BY s DESC').all();
  const bySource = db.prepare('SELECT source, COUNT(*) n, COALESCE(SUM(amount),0) s FROM payments_ledger GROUP BY source ORDER BY s DESC').all();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); d.setUTCMonth(d.getUTCMonth() - i);
    const e = new Date(d); e.setUTCMonth(e.getUTCMonth() + 1);
    months.push({ key: d.toISOString().slice(0, 7), label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), s: db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments_ledger WHERE ts>=? AND ts<?').get(+d, +e).s });
  }
  // MRR: each active subscription contributes its amount spread over its plan length in months.
  const mrr = db.prepare("SELECT s.plan, s.amount FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.status='active' AND s.start_at<=? AND s.end_at>?").all(now, now)
    .reduce((a, s) => a + (s.amount || 0) / ((PLANS[s.plan] || { months: 1 }).months), 0);
  const perUser = db.prepare('SELECT u.id, u.email, COUNT(l.id) n, COALESCE(SUM(l.amount),0) s, MAX(l.ts) last FROM payments_ledger l JOIN users u ON u.id=l.user_id GROUP BY u.id ORDER BY s DESC').all();
  return { total: total.s, count: total.n, byPlan, bySource, months, mrr: Math.round(mrr * 100) / 100, perUser };
}

// ---------------------------------------------------------------------------
// CHECKOUT HOOK. "Choose plan" on /billing POSTs to /billing/checkout, which calls checkout(user, plan, baseUrl).
// To plug in Stripe / NOWPayments later, assign a provider (no SDK code lives here):
//   require('./payments').setProvider({ name: 'stripe', async checkout(user, plan, baseUrl) { return 'https://checkout-url' } });
// The returned URL is where the user is redirected. Confirmed payments then call recordPayment(...).
// With no provider, checkout() throws { notImplemented } and the server records a plan request (intent)
// that the owner sees in the admin panel and can grant manually.
// ---------------------------------------------------------------------------
db.exec(`CREATE TABLE IF NOT EXISTS plan_intents (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL, amount REAL, status TEXT DEFAULT 'pending', created INTEGER, resolved INTEGER)`);
let provider = null;
const setProvider = p => { provider = p && typeof p.checkout === 'function' ? p : null; };
const available = () => !!provider;
async function checkout(user, plan, baseUrl) {
  if (!provider) { const e = new Error('Online payment is coming soon'); e.notImplemented = true; throw e; }
  return provider.checkout(user, plan, baseUrl);
}
function recordIntent(userId, plan) {
  if (!PLANS[plan]) throw new Error('Unknown plan: ' + plan);
  const ex = db.prepare("SELECT id FROM plan_intents WHERE user_id=? AND status='pending'").get(userId);
  if (ex) { db.prepare('UPDATE plan_intents SET plan=?, amount=?, created=? WHERE id=?').run(plan, PLANS[plan].usd, Date.now(), ex.id); return ex.id; }
  log(userId, 'intent', plan, `requested ${PLANS[plan].label} ($${PLANS[plan].usd})`, 'user');
  return db.prepare("INSERT INTO plan_intents(user_id,plan,amount,status,created) VALUES(?,?,?,'pending',?)").run(userId, plan, PLANS[plan].usd, Date.now()).lastInsertRowid;
}
const pendingIntent = userId => db.prepare("SELECT * FROM plan_intents WHERE user_id=? AND status='pending' ORDER BY id DESC").get(userId);
const pendingIntents = () => db.prepare("SELECT i.*, u.email FROM plan_intents i JOIN users u ON u.id=i.user_id WHERE i.status='pending' ORDER BY i.created DESC").all();
const resolveIntent = (id, status) => db.prepare("UPDATE plan_intents SET status=?, resolved=? WHERE id=? AND status='pending'").run(status, Date.now(), id).changes;

const day = ms => new Date(ms).toISOString().slice(0, 10);
// until: ms timestamp, or null = indefinitely. extend: add the paused days to plan_until on resume.
function pause(userId, { until = null, extend = false, by = null } = {}) {
  const now = Date.now();
  db.prepare('UPDATE users SET paused_at=?, paused_until=?, pause_extend=? WHERE id=?').run(now, until, extend ? 1 : 0, userId);
  log(userId, 'pause', null, `${until ? 'until ' + day(until) : 'indefinitely'}${extend ? '; expiry extended on resume' : ''}`, by);
}
function resume(userId, { by = null, at = Date.now(), auto = false } = {}) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(userId); if (!u || !u.paused_at) return null;
  const end = Math.min(at, u.paused_until || at), days = Math.max(0, end - u.paused_at);
  let until = u.plan_until;
  if (u.pause_extend && u.plan !== 'free' && u.plan_until) { until = u.plan_until + days; db.prepare("UPDATE subscriptions SET end_at=end_at+? WHERE user_id=? AND status='active' AND end_at=?").run(days, userId, u.plan_until); }
  db.prepare('UPDATE users SET paused_at=NULL, paused_until=NULL, pause_extend=NULL, plan_until=? WHERE id=?').run(until, userId);
  log(userId, auto ? 'auto_resume' : 'resume', u.plan, `paused ${Math.round(days / DAY * 10) / 10} days${u.pause_extend && until !== u.plan_until ? '; expiry moved to ' + day(until) : ''}`, by || (auto ? 'system' : null));
  return { until, pausedMs: days };
}
function grantTemp(userId, { until, by = null } = {}) {
  if (!until || until <= Date.now()) throw new Error('Pick a future end date');
  db.prepare('UPDATE users SET temp_until=?, temp_from=? WHERE id=?').run(until, Date.now(), userId);
  log(userId, 'temp_on', null, 'temporary premium until ' + day(until), by);
}
function endTemp(userId, { by = null, auto = false } = {}) {
  db.prepare('UPDATE users SET temp_until=NULL, temp_from=NULL WHERE id=?').run(userId);
  log(userId, auto ? 'temp_auto_end' : 'temp_off', null, auto ? 'temporary premium ended' : 'temporary premium removed', by || (auto ? 'system' : null));
}
// Worker: resume finished pauses and end finished temporary grants. Returns what it did.
function planHousekeeping(now = Date.now()) {
  const done = { resumed: [], tempEnded: [] };
  for (const u of db.prepare('SELECT id FROM users WHERE paused_at IS NOT NULL AND paused_until IS NOT NULL AND paused_until<=?').all(now)) { resume(u.id, { at: now, auto: true }); done.resumed.push(u.id); }
  for (const u of db.prepare('SELECT id FROM users WHERE temp_until IS NOT NULL AND temp_until<=?').all(now)) { endTemp(u.id, { auto: true }); done.tempEnded.push(u.id); }
  if (done.resumed.length || done.tempEnded.length) try { require('./audit').audit(null, { type: 'system', name: 'worker' }, 'plan.housekeeping', null, `resumed ${done.resumed.join(',') || '-'}; temp ended ${done.tempEnded.join(',') || '-'}`); } catch (e) { /* audit optional */ }
  return done;
}
module.exports = { isPaused, hasTemp, premiumSQL, pause, resume, grantTemp, endTemp, planHousekeeping, CUSTOM, PLANS, SOURCES, isPremium, recordPayment, revoke, extend, stats, available, checkout, setProvider, recordIntent, pendingIntent, pendingIntents, resolveIntent };

// Owner integration hook: call when a provider reports a failed charge. Emails the user (if opted in)
// and records it in the plan history. details: { plan, amount, reason, externalId }
async function notifyPaymentFailed(userId, details = {}) {
  const { notify, T } = require('./mailer');
  log(userId, 'payment_failed', details.plan, `${details.amount != null ? '$' + details.amount + ' ' : ''}${details.reason || ''}`.trim(), 'system');
  return notify(userId, 'payment_failed', T.paymentFailed(details));
}
module.exports.notifyPaymentFailed = notifyPaymentFailed;
