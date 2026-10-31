const S = require('./settings');
const h = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = en => en;
const PREMIUM_THEMES = ['aurora', 'sunset', 'ocean'];
const { PLANS } = require('./payments');
const TZ_PRESETS = [['Asia/Dhaka', 'Bangladesh (Dhaka)'], ['Asia/Kolkata', 'India (Kolkata)'], ['America/New_York', 'US Eastern'], ['America/Chicago', 'US Central'], ['America/Los_Angeles', 'US Pacific'], ['Europe/London', 'UK (London)']];
const validTz = z => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return !!z && z.length < 64; } catch { return false; } };
// Timezone picker: presets + Custom (searchable IANA list filled in by the browser). Auto-detects when no saved value.
function tzPicker(name, cur, id = 'tzsel', save = false, autosaved = false) {
  const preset = TZ_PRESETS.some(([z]) => z === cur);
  return `<div class="tzp" data-tzp data-cur="${h(cur || '')}"${save ? ' data-save="1"' : ''}${autosaved ? ' data-autosaved="1"' : ''}><select id="${id}" data-tz-select aria-label="Time zone">${TZ_PRESETS.map(([z, l]) => `<option value="${z}" ${cur === z ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${cur && !preset ? 'selected' : ''}>Custom…</option></select>
   <input class="tz-custom" list="${id}-list" placeholder="Search time zones, e.g. Europe/Berlin" value="${cur && !preset ? h(cur) : ''}" ${cur && !preset ? '' : 'hidden'} aria-label="Custom time zone"><datalist id="${id}-list"></datalist>
   <input type="hidden" name="${name}" value="${h(cur || '')}"></div>`;
}

function layout(req, title, body, { landing = false, active = '', scripts = [] } = {}) {
  const u = req.user, prem = req.premium;
  const theme = u && prem && PREMIUM_THEMES.includes(u.theme) ? u.theme : 'default';
  const font = u && prem && u.font ? u.font : 'inter';
  const mode = u ? u.mode : '';
  const appLinks = [['/app', 'Dashboard'], ['/compose', 'Compose'], ['/queue', 'Queue'], ['/calendar', 'Calendar'],
    ['/media', 'Media'], ['/insights', 'Competitors'], ['/connect', 'Accounts'], ['/billing', 'Billing'], ['/settings', 'Settings']];
  const links = landing || !u
    ? `<a href="/#features">Features</a><a href="/#pricing">Pricing</a><a href="/#faq">FAQ</a>${u ? '<a href="/app">Open app</a>' : '<a href="/login">Log in</a>'}`
    : appLinks.map(([href, en]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${en}</a>`).join('') + (prem ? '' : '<a href="/billing#plans" class="btn sm nav-upgrade">⭐ Upgrade</a>') + '<a href="/logout">Logout</a>';
  const notices = (req.notices || []).map(n => `<div class="alert info">🔔 ${h(n.text)} ${n.link ? `<a href="${h(n.link)}">→</a>` : ''}</div>`).join('');
  const flash = req.flash ? `<div class="alert ${req.flash.type}" ${req.flash.type === 'ok' && active === '' && title === 'Settings' ? 'data-toast' : ''}>${req.flash.msg}</div>` : '';
  return `<!doctype html><html lang="en" data-theme="${theme}" data-font="${font}" ${mode ? `data-mode="${mode}"` : ''} data-touch="${prem ? 1 : 0}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · ${h(S.get('app_name'))}</title>
<meta name="description" content="Schedule posts to Threads, X and Reddit at New York prime time."><link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%237c5cff'/></svg>"></head><body>
<nav class="nav${landing || !u ? '' : ' app-nav'}"><div class="wrap"><a class="logo" href="/"><i></i>${h(S.get('app_name'))}</a>
<button class="btn ghost sm burger" data-burger aria-label="Open menu" aria-expanded="false">☰</button><div class="links">${links}</div>
<button class="btn ghost sm" data-toggle-mode aria-label="Toggle dark/light">◐</button>
${!u && landing ? '<a class="btn sm" href="/signup">Start free</a>' : ''}</div></nav>
${landing ? body : `<main class="wrap fade-in">${notices}${flash}${body}</main>`}
${landing ? '' : `<footer><div class="wrap row"><div>© ${new Date().getFullYear()} ${h(S.get('app_name'))} — ${t('Made for creators')}</div>
<div style="text-align:right" class="small"><a href="/#pricing">Pricing</a> · <a href="/#faq">FAQ</a> · <a href="/healthz">Status</a></div></div></footer>`}
<script src="/app.js"></script>${scripts.map(x => `<script src="${x}"></script>`).join('')}</body></html>`;
}


function pricingCards(cta = true, cur, sel) {
  const per = p => (PLANS[p].usd / PLANS[p].months).toFixed(2);
  const save = p => PLANS.monthly.usd * PLANS[p].months - PLANS[p].usd;
  const card = (p, title, best) => `<div class="card price ${best ? 'best' : ''}" data-plan="${p}">${save(p) > 0 ? `<span class="save">Save $${save(p)}</span>` : ''}<h3>${title}</h3>
   <div class="amt">$${PLANS[p].usd}<small> / ${PLANS[p].label}</small></div><div class="muted small">${PLANS[p].months > 1 ? `$${per(p)} / month` : 'Billed monthly'}</div>
   <ul><li>Unlimited scheduling</li><li>Reach analytics &amp; dashboard</li><li>Competitor analysis</li><li>Premium themes</li></ul>
   ${cta === 'buy' ? `${cur === p ? '<span class="pill published" style="display:inline-block;margin-bottom:8px">Current plan</span>' : ''}<form method="post" action="/billing/checkout"><input type="hidden" name="plan" value="${p}"><button class="btn ${best || sel === p ? '' : 'ghost'} shimmer" style="width:100%" data-choose="${p}">Choose plan</button></form>`
     : cta ? `<a class="btn ${best ? '' : 'ghost'} shimmer" href="${cta === 'user' ? `/billing?plan=${p}#plans` : `/signup?plan=${p}`}" style="width:100%">Choose plan</a>` : cur === p ? '<span class="pill published">Current plan</span>' : ''}</div>`;
  return `<div class="plans">
  <div class="card price"><h3>Free</h3><div class="amt">$0</div><div class="muted small">Forever</div>
   <ul><li>Connect Threads, Reddit, X</li><li>10 scheduled posts / month</li><li>Basic post list</li><li>Light &amp; dark mode</li></ul>
   ${cta === 'buy' ? (cur ? '' : '<span class="pill published">Your current plan</span>') : cta === 'user' ? '<a class="btn ghost" href="/app" style="width:100%">Open app</a>' : cta ? '<a class="btn ghost" href="/signup" style="width:100%">Start free</a>' : ''}</div>
  ${card('monthly', 'Monthly')}${card('quarterly', '3 months')}${card('semiannual', '6 months', true)}${card('yearly', 'Yearly')}</div>`;
}

const ICON = {
  threads: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.2 2C6.9 2 3.5 5.6 3.5 12s3.4 10 8.7 10c4.4 0 7.6-2.4 8.2-6.2l-2.3-.5c-.5 2.6-2.6 4.4-5.9 4.4-3.9 0-6.3-2.8-6.3-7.7s2.4-7.7 6.3-7.7c3 0 5 1.4 5.7 3.9l2.3-.6C19.3 3.9 16.3 2 12.2 2zm.4 6.3c-2.6 0-4.3 1.4-4.3 3.4 0 1.9 1.6 3.2 3.7 3.2 2.6 0 4-1.6 4.2-4.6.9.5 1.4 1.3 1.4 2.4l2.1-.3c-.1-2.4-1.6-4.1-3.8-4.5-.6-1-1.8-1.6-3.3-1.6zm-.4 2.2c1.1 0 1.8.4 2 1.3-.1 1.9-.9 2.9-2.3 2.9-1 0-1.6-.5-1.6-1.1 0-1.3 1-3.1 1.9-3.1z"/></svg>',
  reddit: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13.5" r="7.5" fill="currentColor"/><circle cx="18.6" cy="5.4" r="1.6" fill="currentColor"/><path d="M12 6l1.2-3.4 5 1.2" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="9.2" cy="13" r="1.2" fill="var(--bg)"/><circle cx="14.8" cy="13" r="1.2" fill="var(--bg)"/><path d="M9 16.3c1.7 1.2 4.3 1.2 6 0" stroke="var(--bg)" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.3-8.3L1.9 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.3 4.7H5.5l11.2 14.5z"/></svg>',
  drive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8.3 3h7.4l6.6 11.4-3.7 6.6H5.4l-3.7-6.6L8.3 3zm1.2 2L4 14.4h6.6L16 5H9.5zm8.2 1.4l-3.3 5.7 2.4 4.3 3.3-5.7-2.4-4.3zM6.6 16.4l-1.2 2.6h11.8l1.4-2.6H6.6z"/></svg>',
  openai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5L12 3.5zM12 3.5v8.5m0 0l7.4 4.25M12 12l-7.4 4.25"/></svg>'
};

function landing(req) {
  const feats = [
    ['🗓️', 'Exact-time scheduling', 'Pick a date on a real calendar and set the time with a clock face or typed input.'],
    ['⚡', 'Prime-time auto slots', 'Auto mode spaces posts every 3–4 hours, weighted to US evening prime time.'],
    ['🖼️', 'Every Threads format', 'Text, single image, carousels of up to 20 and short Reels-style video.'],
    ['👥', 'Multiple accounts', 'Connect several Threads, X and Reddit accounts and choose which ones each post goes to.'],
    ['📈', 'Reach tracking', 'Views, likes, replies and reposts fetched automatically after posting.'],
    ['🔍', 'Competitor patterns', 'Learn hooks and structure from top X, Reddit and Threads posts.'],
    ['🔁', 'Smart auto-retry', 'Temporary errors retry with backoff; expired logins are flagged for reconnect.'],
    ['🤖', 'AI writing, your key', 'Write by hand or with OpenAI using your own key, stored encrypted.'],
    ['🔒', 'Encrypted tokens', 'All platform tokens are AES-256-GCM encrypted at rest. Nothing to copy or paste.']];
  const faq = [
    ['Which platforms can post?', 'Threads, X and Reddit. Tick one or more platforms per post (for example Threads only, X only, or all three). Posting uses each platform\'s official API with your own login, and only posts you wrote and scheduled.'],
    ['Do I need any keys or setup?', 'No. Click Connect for each platform and approve on the platform’s own login page. There is nothing to copy or paste.'],
    ['Can I connect more than one account?', 'Yes. Connect as many Threads, X and Reddit accounts as you like and pick the target accounts per post.'],
    ['Which time zones are supported?', 'Every IANA time zone. Your zone is detected automatically, and you can override it in Settings.'],
    ['How do I pay?', 'Online checkout is coming soon. Until then, contact the site owner to activate Premium.'],
    ['Will the app delete my posts?', 'Never automatically. Low-reach posts are only flagged; deleting is always your choice.']];
  const steps = [['Connect', 'Click Connect and approve on Threads, X or Reddit. Done in 20 seconds.'], ['Write', 'Type your post or let AI draft it. Preview exactly how it looks on each platform.'], ['Schedule', 'Tick Threads, X, Reddit or all three, then pick a date and time in your own time zone, or let auto slots choose prime time.']];
  const benefits = [['5+ hrs', 'saved each week', 'Batch a week of posts in one sitting instead of posting live every evening.'], ['24/7', 'posting while you sleep', 'Hit US prime time from anywhere. The worker publishes on the minute.'], ['0', 'keys to paste', 'One-click OAuth connect. Tokens renew automatically in the background.'], ['100%', 'original drafts', 'Pattern analysis teaches structure, never copies other creators.']];
  return layout(req, 'Schedule Threads, X &amp; Reddit at prime time', `
<header class="hero2"><div class="mesh" aria-hidden="true"><i></i><i></i><i></i></div><div class="grain" aria-hidden="true"></div>
<div class="wrap hero-grid"><div class="hero-copy reveal"><div class="badge">✨ Post to Threads, X &amp; Reddit</div>
<h1>Post at <span class="g">prime time</span>, in every time zone, while you sleep</h1>
<p class="lead">Write by hand or with AI, schedule to the minute across multiple accounts, track reach and learn from top creators.</p>
<div class="cta-row"><a class="btn lg shimmer" href="/signup">Start free →</a><a class="btn ghost lg" href="#pricing">See pricing</a></div>
<p class="muted small">Free forever plan · No card required</p></div>
<div class="mock2 reveal" aria-hidden="true"><div class="mwin"><div class="mbar"><b></b><b></b><b></b><span>postpilot.app/app</span></div>
 <div class="mbody"><div class="mside"><i class="on"></i><i></i><i></i><i></i><i></i></div><div class="mmain">
  <div class="mkpis"><div><small>Published</small><b data-count="128">128</b></div><div><small>Views</small><b>48.2k</b></div><div><small>Engagement</small><b>6.4%</b></div></div>
  <div class="mchart">${[38, 52, 44, 67, 58, 80, 72, 94, 86, 100].map((v, i) => `<span style="--h:${v}%;--d:${i * 90}ms"></span>`).join('')}</div>
  <div class="mq"><div class="mrow"><span class="dot ok"></span><span class="ln w70"></span><em>9:30 PM ET</em></div><div class="mrow"><span class="dot sch"></span><span class="ln w55"></span><em>1:00 AM ET</em></div><div class="mrow typing"><span class="dot sch"></span><span class="ln w40"></span><em>Auto slot</em></div></div>
 </div></div></div><div class="float f1">📈 +312 views</div><div class="float f2">✅ Posted to @studio.daily</div></div></div>
<div class="wrap logos reveal"><span class="muted small">Works with</span>${[['threads', 'Threads'], ['x', 'X'], ['reddit', 'Reddit'], ['drive', 'Google Drive'], ['openai', 'OpenAI']].map(([k, n]) => `<span class="logo-i">${ICON[k]}${n}</span>`).join('')}</div></header>
<section id="features"><div class="wrap"><h2 class="reveal">Everything you need to grow</h2><p class="sub reveal">Built for creators who publish to a global audience on their own schedule.</p>
<div class="grid g3">${feats.map(([i, en, d], n) => `<div class="card feat lift reveal" style="--rd:${(n % 3) * 80}ms"><div class="ic">${i}</div><h3>${en}</h3><p class="muted small">${d}</p></div>`).join('')}</div></div></section>
<section id="how"><div class="wrap"><h2 class="reveal">How it works</h2><p class="sub reveal">Three steps. No setup, no keys.</p>
<div class="steps3">${steps.map(([a, b], i) => `<div class="step reveal" style="--rd:${i * 120}ms"><div class="num">${i + 1}</div><h3>${a}</h3><p class="muted">${b}</p></div>`).join('')}</div></div></section>
<section id="tzdemo"><div class="wrap"><div class="card tzdemo reveal"><div><h2 style="text-align:left;margin:0 0 6px">See prime time in your zone</h2><p class="muted" style="margin:0">US evening prime time (7–10 PM Eastern), converted live to your time zone.</p></div>
<div class="tzdemo-ctl"><label for="demo-tz">Your time zone</label>${tzPicker('demo_tz', '', 'demo-tz')}</div>
<div class="tzdemo-out" id="tz-out" aria-live="polite"></div></div></div></section>
<section id="benefits"><div class="wrap"><h2 class="reveal">Why creators switch</h2><p class="sub reveal">Real outcomes, not marketing fluff.</p>
<div class="grid g4">${benefits.map(([n, l, d], i) => `<div class="card benefit lift reveal" style="--rd:${i * 80}ms"><div class="big-n">${n}</div><b>${l}</b><p class="muted small">${d}</p></div>`).join('')}</div></div></section>
<section id="pricing"><div class="wrap"><h2 class="reveal">Simple pricing</h2><p class="sub reveal">$7 a month, or save up to $34 a year with longer plans.</p><div class="reveal">${pricingCards(req.user ? 'user' : true)}</div></div></section>
<section id="faq"><div class="wrap" style="max-width:780px"><h2 class="reveal">Questions</h2>
${faq.map(([q, a]) => `<details class="reveal"><summary>${q}</summary><p class="muted">${a}</p></details>`).join('')}</div></section>
<section><div class="wrap"><div class="cta-band reveal"><div class="mesh" aria-hidden="true"><i></i><i></i></div><h2>Ready to post smarter?</h2><p>Free forever plan. No card required.</p><a class="btn lg light shimmer" href="/signup">Create your account</a></div></div></section>
<footer class="foot"><div class="wrap foot-grid"><div><a class="logo" href="/"><i></i>${h(S.get('app_name'))}</a><p class="muted small">Schedule posts to Threads, X and Reddit at prime time and learn from top creators.</p></div>
<div><b>Product</b><a href="#features">Features</a><a href="#how">How it works</a><a href="#pricing">Pricing</a></div><div><b>Help</b><a href="#faq">FAQ</a><a href="/login">Log in</a><a href="/healthz">Status</a></div>
<div><b>Platforms</b><span>Threads</span><span>X</span><span>Reddit</span></div></div><div class="wrap muted small foot-b">© ${new Date().getFullYear()} ${h(S.get('app_name'))}. Made for creators.</div></footer>`, { landing: true, scripts: ['/landing.js'] });
}
module.exports = { h, t, layout, landing, pricingCards, PREMIUM_THEMES, TZ_PRESETS, tzPicker, validTz, ICON };
