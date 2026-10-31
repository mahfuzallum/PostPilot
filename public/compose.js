// Composer: custom calendar picker, typed/wheel/clock time picker, time zone conversion, live tabbed preview.
// Everything here is self-hosted vanilla JS (no CDN, CSP script-src 'self').
(function () {
  const form = document.getElementById('compose'); if (!form) return;
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pad = n => String(n).padStart(2, '0');
  const when = $('[name=when]', form), tzw = $('#exactbox [data-tzp]'), out = $('#tzout'), err = $('#time-err');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const st = { y: null, m: null, d: null, h: null, min: null };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when.value)) { const [d, t] = when.value.split('T'); [st.y, st.m, st.d] = d.split('-').map(Number); [st.h, st.min] = t.split(':').map(Number); }
  const zone = () => (tzw && tzw.dataset.value) || 'Asia/Dhaka';
  const offset = (tz, at) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at; };
  const epoch = () => { if (st.y == null || st.h == null) return null; const g = Date.UTC(st.y, st.m - 1, st.d, st.h, st.min); return g - offset(zone(), g - offset(zone(), g)); };
  const todayIn = () => { const n = new Date(Date.now() + offset(zone(), Date.now())); return [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()]; };
  const fmtZ = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
  const to12 = (h, m) => `${pad(((h + 11) % 12) + 1)}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
  function sync() {
    when.value = st.y != null && st.h != null ? `${st.y}-${pad(st.m)}-${pad(st.d)}T${pad(st.h)}:${pad(st.min)}` : '';
    $('#date-in .v').textContent = st.y != null ? new Date(Date.UTC(st.y, st.m - 1, st.d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Pick a date';
    const e = epoch(); if (!out) return;
    if (e == null) { out.innerHTML = ''; return; }
    const zs = [...new Set([zone(), 'America/New_York', 'Asia/Dhaka'])];
    out.innerHTML = zs.map(z => `<span class="tzchip ${z === zone() ? 'me' : ''}"><small>${z.split('/').pop().replace(/_/g, ' ')}</small><b>${fmtZ(e, z)}</b></span>`).join('') + (e < Date.now() ? '<span class="field-err">This time is in the past</span>' : '');
  }
  /* ----- calendar picker ----- */
  const dp = $('#datepk'), dbtn = $('#date-in'), cal = $('.pop-cal', dp);
  let view = null;
  function drawCal() {
    const [ty, tm, td] = todayIn(); if (!view) view = { y: st.y || ty, m: st.m || tm };
    const first = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(view.y, view.m, 0)).getUTCDate();
    let cells = '<span></span>'.repeat(first);
    for (let d = 1; d <= days; d++) {
      const past = view.y < ty || (view.y === ty && (view.m < tm || (view.m === tm && d < td)));
      const on = st.y === view.y && st.m === view.m && st.d === d, today = view.y === ty && view.m === tm && d === td;
      cells += `<button type="button" class="day ${on ? 'on' : ''} ${today ? 'today' : ''}" data-d="${d}" ${past ? 'disabled' : ''} aria-label="${MONTHS[view.m - 1]} ${d}">${d}</button>`;
    }
    cal.innerHTML = `<div class="cal-h"><button type="button" class="nav-b" data-nav="-1" aria-label="Previous month">‹</button><b>${MONTHS[view.m - 1]} ${view.y}</b><button type="button" class="nav-b" data-nav="1" aria-label="Next month">›</button></div>
      <div class="cal-g">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(x => `<i>${x}</i>`).join('')}${cells}</div>
      <div class="cal-f"><button type="button" class="btn ghost sm" data-q="0">Today</button><button type="button" class="btn ghost sm" data-q="1">Tomorrow</button></div>`;
  }
  const openCal = o => { cal.hidden = !o; dbtn.setAttribute('aria-expanded', o); if (o) { closeTime(); view = null; drawCal(); } };
  dbtn.addEventListener('click', () => openCal(cal.hidden));
  cal.addEventListener('click', e => {
    const n = e.target.closest('[data-nav]'); if (n) { view.m += +n.dataset.nav; if (view.m < 1) { view.m = 12; view.y--; } if (view.m > 12) { view.m = 1; view.y++; } drawCal(); return; }
    const q = e.target.closest('[data-q]'); if (q) { const [y, m, d] = todayIn(); const t = new Date(Date.UTC(y, m - 1, d + +q.dataset.q)); st.y = t.getUTCFullYear(); st.m = t.getUTCMonth() + 1; st.d = t.getUTCDate(); openCal(false); sync(); return; }
    const d = e.target.closest('.day'); if (d && !d.disabled) { st.y = view.y; st.m = view.m; st.d = +d.dataset.d; openCal(false); sync(); }
  });
  /* ----- time picker: typed input + wheel columns + clock face ----- */
  const tp = $('#timepk'), tin = $('#time-in'), tbtn = $('.pk-btn', tp), pop = $('.pop-time', tp);
  let clockMode = 'h';
  function parseTime(v) {
    const m = String(v).trim().toUpperCase().match(/^(\d{1,2})(?::?(\d{2}))?\s*(AM|PM|A|P)?$/); if (!m) return null;
    let h = +m[1], mi = m[2] == null ? 0 : +m[2]; const ap = m[3];
    if (mi > 59) return null;
    if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap[0] === 'P' ? 12 : 0); } else if (h > 23) return null;
    return [h, mi];
  }
  function setTime(h, mi, fromInput) { st.h = h; st.min = mi; if (!fromInput) tin.value = to12(h, mi); err.textContent = ''; tin.removeAttribute('aria-invalid'); sync(); if (!pop.hidden) drawTime(); }
  tin.addEventListener('blur', () => { if (!tin.value.trim()) return; const r = parseTime(tin.value); if (!r) { err.textContent = 'Enter a valid time like 09:30 PM'; tin.setAttribute('aria-invalid', 'true'); return; } setTime(r[0], r[1]); });
  tin.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tin.blur(); } if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const base = st.h == null ? [9, 0] : [st.h, st.min]; const t = (base[0] * 60 + base[1] + (e.key === 'ArrowUp' ? 5 : -5) + 1440) % 1440; setTime(Math.floor(t / 60), t % 60); } });
  const wheel = (name, items, cur) => `<div class="wheel" data-w="${name}" tabindex="0" aria-label="${name}">${items.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  function drawTime() {
    const h = st.h == null ? 9 : st.h, mi = st.min == null ? 0 : st.min, h12 = ((h + 11) % 12) + 1, pm = h >= 12;
    const R = 92, C = 110, nums = clockMode === 'h' ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
    const curV = clockMode === 'h' ? h12 : mi, ang = (clockMode === 'h' ? (h12 % 12) * 30 : mi * 6) * Math.PI / 180;
    const hx = C + Math.sin(ang) * (R - 14), hy = C - Math.cos(ang) * (R - 14);
    pop.innerHTML = `<div class="tp-head"><button type="button" class="tp-seg ${clockMode === 'h' ? 'on' : ''}" data-mode="h">${pad(h12)}</button>:<button type="button" class="tp-seg ${clockMode === 'm' ? 'on' : ''}" data-mode="m">${pad(mi)}</button>
      <div class="ampm"><button type="button" data-ap="AM" class="${pm ? '' : 'on'}">AM</button><button type="button" data-ap="PM" class="${pm ? 'on' : ''}">PM</button></div></div>
      <div class="tp-body"><svg class="clock" viewBox="0 0 220 220" role="img" aria-label="Clock face"><circle cx="${C}" cy="${C}" r="104" class="face"/><line x1="${C}" y1="${C}" x2="${hx}" y2="${hy}" class="hand"/><circle cx="${C}" cy="${C}" r="4" class="pin"/><circle cx="${hx}" cy="${hy}" r="17" class="knob"/>
      ${nums.map((n, i) => { const a = i * 30 * Math.PI / 180, x = C + Math.sin(a) * (R - 14), y = C - Math.cos(a) * (R - 14); return `<text x="${x}" y="${y + 5}" data-n="${n}" class="${n === curV ? 'sel' : ''}">${clockMode === 'h' ? n : pad(n)}</text>`; }).join('')}</svg>
      <div class="wheels">${wheel('hour', [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(n => [n, pad(n)]), h12)}${wheel('minute', Array.from({ length: 12 }, (_, i) => [i * 5, pad(i * 5)]), mi - mi % 5)}${wheel('period', [['AM', 'AM'], ['PM', 'PM']], pm ? 'PM' : 'AM')}</div></div>
      <div class="tp-foot"><span class="small muted">Scroll the columns or click the clock</span><button type="button" class="btn sm" data-done>Done</button></div>`;
    $$('.wheel', pop).forEach(w => { const on = $('.on', w); if (on) w.scrollTop = on.offsetTop - w.clientHeight / 2 + on.clientHeight / 2; });
  }
  const from12 = (h12, pm) => (h12 % 12) + (pm ? 12 : 0);
  function closeTime() { pop.hidden = true; tbtn.setAttribute('aria-expanded', 'false'); }
  tbtn.addEventListener('click', () => { if (pop.hidden) { const cur = tin.value.trim() && parseTime(tin.value); if (cur) { st.h = cur[0]; st.min = cur[1]; sync(); } openCal(false); pop.hidden = false; tbtn.setAttribute('aria-expanded', 'true'); clockMode = 'h'; drawTime(); } else closeTime(); });
  tin.addEventListener('focus', () => { if (pop.hidden) tbtn.click(); });
  // clock face: pick by clicking/dragging anywhere on the dial
  function dialPick(e) {
    const svg = $('.clock', pop); if (!svg) return; const r = svg.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * 220 - 110, y = (e.clientY - r.top) / r.height * 220 - 110;
    let deg = Math.atan2(x, -y) * 180 / Math.PI; if (deg < 0) deg += 360;
    const h = st.h == null ? 9 : st.h, mi = st.min == null ? 0 : st.min;
    if (clockMode === 'h') { const h12 = Math.round(deg / 30) % 12 || 12; setTime(from12(h12, h >= 12), mi); }
    else setTime(h, (Math.round(deg / 6) % 60));
  }
  let drag = false;
  pop.addEventListener('pointerdown', e => { if (e.target.closest('.clock')) { drag = true; dialPick(e); e.preventDefault(); } });
  pop.addEventListener('pointermove', e => { if (drag) dialPick(e); });
  document.addEventListener('pointerup', () => { if (drag) { drag = false; if (clockMode === 'h') { clockMode = 'm'; drawTime(); } } });
  pop.addEventListener('click', e => {
    const h = st.h == null ? 9 : st.h, mi = st.min == null ? 0 : st.min;
    const m = e.target.closest('[data-mode]'); if (m) { clockMode = m.dataset.mode; drawTime(); return; }
    const ap = e.target.closest('[data-ap]'); if (ap) { setTime(from12(((h + 11) % 12) + 1, ap.dataset.ap === 'PM'), mi); return; }
    const b = e.target.closest('.wheel button'); if (b) { const w = b.parentElement.dataset.w, v = b.dataset.v;
      if (w === 'hour') setTime(from12(+v, h >= 12), mi); else if (w === 'minute') setTime(h, +v); else setTime(from12(((h + 11) % 12) + 1, v === 'PM'), mi); return; }
    if (e.target.closest('[data-done]')) { if (st.h == null) setTime(h, mi); closeTime(); }
  });
  // scroll-wheel columns: wheel/trackpad steps one item at a time
  pop.addEventListener('wheel', e => { const w = e.target.closest('.wheel'); if (!w) return; e.preventDefault();
    const btns = $$('button', w), i = btns.findIndex(b => b.classList.contains('on')), n = btns[Math.max(0, Math.min(btns.length - 1, i + (e.deltaY > 0 ? 1 : -1)))]; if (n) n.click(); }, { passive: false });
  pop.addEventListener('keydown', e => { const w = e.target.closest('.wheel'); if (!w || !/Arrow(Up|Down)/.test(e.key)) return; e.preventDefault();
    const btns = $$('button', w), i = btns.findIndex(b => b.classList.contains('on')); const n = btns[Math.max(0, Math.min(btns.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]; n && n.click(); $(`.wheel[data-w=${w.dataset.w}]`, pop).focus(); });
  document.addEventListener('click', e => { if (!e.target.closest('#timepk')) closeTime(); if (!e.target.closest('#datepk')) { cal.hidden = true; dbtn.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeTime(); cal.hidden = true; } });
  tzw && tzw.addEventListener('tzchange', sync);
  if (st.h != null) tin.value = to12(st.h, st.min);
  form.addEventListener('submit', e => { const sm = ($('[name=smode]:checked', form) || {}).value; if (sm !== 'exact') return;
    if (tin.value.trim()) { const r = parseTime(tin.value); if (r) setTime(r[0], r[1]); }
    if (!when.value) { e.preventDefault(); e.stopImmediatePropagation(); err.textContent = st.y == null ? 'Pick a date' : 'Enter a valid time like 09:30 PM'; (st.y == null ? dbtn : tin).focus(); } }, true);
  const batch = $('[name=batch]', form); batch && batch.addEventListener('change', () => { $('#batchbox').hidden = batch.value !== '2'; });
  sync();

  /* ----- live preview ----- */
  const accs = JSON.parse(form.dataset.accounts || '[]'), ta = $('[name=text]', form), pv = $('#pv'), note = $('#pvnote'), counters = $('#counters');
  const LIM = { threads: 500, x: 280, reddit: 300 };
  let tab = 'threads';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const media = () => { const lib = $$('[name=image_ids]:checked', form).map(c => { const m = c.parentElement.querySelector('img,video'); return m && m.getAttribute('src'); }).filter(Boolean);
    return [...lib, ...$('[name=media_urls]', form).value.split(/\s+/).filter(u => /^https:\/\//.test(u))]; };
  const fullText = () => { const l = $('[name=link]', form).value.trim(), inReply = $('[name=link_reply]', form).checked, disc = $('[name=disclosure]', form).checked && l;
    let main = ta.value; if (l && !inReply) main += `\n\n${l}`; if (disc) main += '\n#ad'; return { main, reply: l && inReply ? l : '' }; };
  function who(p) { const sel = $$(`#pt-inputs [name=accounts][data-plat=${p}]`, form).map(c => +c.value);
    return accs.find(a => a.p === p && (!sel.length || sel.includes(a.id))) || { u: p === 'x' ? 'yourhandle' : p === 'reddit' ? 'your_username' : 'yourname', av: '' }; }
  const av = a => a.av ? `<img class="pv-av" src="${esc(a.av)}" alt="" referrerpolicy="no-referrer">` : `<span class="pv-av">${esc((a.u || '?')[0].toUpperCase())}</span>`;
  const imgs = list => !list.length ? '' : `<div class="pv-media n${Math.min(list.length, 4)}">${list.slice(0, 4).map((u, i) => /\.(mp4|mov)(\?|$)/i.test(u) ? `<video src="${esc(u)}" muted></video>` : `<img src="${esc(u)}" alt="">`).join('')}${list.length > 4 ? `<span class="more">+${list.length - 4}</span>` : ''}</div>`;
  function render() {
    const { main, reply } = fullText(), m = media(), mt = $('[name=media_type]', form).value, shown = mt === 'TEXT' ? [] : m, a = who(tab), len = main.length;
    counters.innerHTML = Object.entries(LIM).map(([k, lim]) => { const n = k === 'reddit' ? Math.min(ta.value.split('\n')[0].length, 999) : main.length; return `<span class="cnt ${n > lim ? 'over' : n > lim * .9 ? 'near' : ''}">${k === 'x' ? 'X' : k[0].toUpperCase() + k.slice(1)}${k === 'reddit' ? ' title' : ''} <b>${n}</b>/${lim}</span>`; }).join('');
    const body = esc(main).replace(/\n/g, '<br>') || '<span class="muted">Start typing to see your post…</span>';
    if (tab === 'threads') pv.innerHTML = `<div class="pv-card th">${av(a)}<div class="pv-c"><div class="pv-h"><b>${esc(a.u)}</b><span class="muted">now</span></div><div class="pv-t">${body}</div>${imgs(shown)}<div class="pv-act">♡ &nbsp; 💬 &nbsp; 🔁 &nbsp; ✈︎</div>
      ${reply ? `<div class="pv-reply">${av(a)}<div><b>${esc(a.u)}</b><div class="pv-t">${esc(reply)}</div></div></div>` : ''}</div></div>`;
    else if (tab === 'x') pv.innerHTML = `<div class="pv-card x">${av(a)}<div class="pv-c"><div class="pv-h"><b>${esc(a.u)}</b><span class="muted">@${esc(a.u)} · now</span></div><div class="pv-t">${body}</div>${imgs(shown)}<div class="pv-act">💬 &nbsp; 🔁 &nbsp; ♡ &nbsp; 📊</div></div></div>`;
    else { const [title, ...rest] = (ta.value || '').split('\n'); pv.innerHTML = `<div class="pv-card rd"><div class="pv-vote">▲<b>1</b>▼</div><div class="pv-c"><div class="pv-h small muted">r/${esc(($('#subreddit') || {}).value || 'yoursubreddit')} · Posted by u/${esc(a.u)} · now</div><div class="pv-title">${esc(title) || '<span class="muted">Title (first line)</span>'}</div><div class="pv-t">${esc(rest.join('\n')).replace(/\n/g, '<br>')}</div>${imgs(shown)}<div class="pv-act">💬 Comments &nbsp; ↗ Share</div></div></div>`; }
    const picked = plats().includes(tab), nm = { threads: 'Threads', x: 'X', reddit: 'Reddit' }[tab];
    const lim = LIM[tab], n = tab === 'reddit' ? (ta.value.split('\n')[0] || '').length : len;
    note.textContent = `${n}/${lim} ${tab === 'reddit' ? 'title characters' : 'characters'}${n > lim ? ` — too long for ${nm}` : ''}${reply && tab !== 'reddit' ? ' · link posted as first reply' : ''} · ${picked ? `will be posted to ${nm}` : `${nm} is not ticked, so this is a preview only`}`;
    counters.querySelectorAll('.cnt').forEach((c, i) => c.classList.toggle('dim', !plats().includes(Object.keys(LIM)[i])));
  }
  $$('.tab').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; $$('.tab').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); }); render(); }));
  /* ----- Post to: summary chips + two-step modal (platforms -> accounts) ----- */
  const NM = { threads: 'Threads', x: 'X', reddit: 'Reddit' }, ORDER = ['threads', 'x', 'reddit'];
  const inputsBox = $('#pt-inputs'), chipsBox = $('#pt-chips'), openBtn = $('#pt-open');
  const applied = () => $$('[name=accounts]', inputsBox).map(i => ({ id: +i.value, p: i.dataset.plat }));
  const plats = () => [...new Set(applied().map(a => a.p))];
  const terr = $('#target-err'), rbox = $('#redditbox'), sub = $('#subreddit');
  function syncTargets() {
    const pl = plats(); if (rbox) { rbox.hidden = !pl.includes('reddit'); if (sub) sub.required = pl.includes('reddit'); }
    if (pl.length && terr) terr.textContent = '';
    $$('.tab').forEach(t => t.classList.toggle('picked', pl.includes(t.dataset.tab)));
    if (pl.length && !pl.includes(tab)) setTab(pl[0]);
  }
  function setTab(t) { tab = t; $$('.tab').forEach(x => { x.classList.toggle('on', x.dataset.tab === t); x.setAttribute('aria-selected', x.dataset.tab === t); }); }
  const modal = $('#ptm');
  if (modal) {
    document.body.appendChild(modal); // escape the card's stacking/containing block so the overlay covers the viewport
    const box = $('.ptm-box', modal), steps = $$('.ptm-step', modal), cards = $$('button.pcard', modal), merr = $('#ptm-err');
    const accBoxes = () => $$('.pm-acc', modal).filter(c => !c.disabled), allPlat = $('#ptm-allplat'), allAcc = $('#ptm-allacc');
    const nextB = $('#ptm-next'), backB = $('#ptm-back'), applyB = $('#ptm-apply');
    let step = 1, lastFocus = null;
    const selPlats = () => cards.filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.plat);
    const pressCard = (c, on) => { c.setAttribute('aria-pressed', on); c.classList.toggle('on', on); };
    function syncModal() {
      const sp = selPlats();
      allPlat.checked = cards.length > 0 && sp.length === cards.length; allPlat.indeterminate = sp.length > 0 && sp.length < cards.length;
      nextB.disabled = !sp.length;
      $$('.pmg', modal).forEach(g => { g.hidden = !sp.includes(g.dataset.plat); const mine = accBoxes().filter(c => c.dataset.plat === g.dataset.plat), n = mine.filter(c => c.checked).length, pa = $('.pm-pall', g);
        pa.checked = mine.length > 0 && n === mine.length; pa.indeterminate = n > 0 && n < mine.length; pa.disabled = !mine.length; });
      const vis = accBoxes().filter(c => sp.includes(c.dataset.plat)), n = vis.filter(c => c.checked).length;
      allAcc.checked = vis.length > 0 && n === vis.length; allAcc.indeterminate = n > 0 && n < vis.length;
      applyB.textContent = n ? `Apply (${n})` : 'Apply'; applyB.setAttribute('aria-label', n ? `Apply ${n} account${n > 1 ? 's' : ''}` : 'Apply');
      if (n || step === 1) merr.textContent = '';
    }
    function go(n) {
      step = n; steps.forEach(s => { s.hidden = +s.dataset.step !== n; });
      $$('.ptm-steps li', modal).forEach((li, i) => li.classList.toggle('on', i < n));
      $('#ptm-n').textContent = n; $('#ptm-sd').textContent = n === 1 ? 'Pick platforms' : 'Pick accounts';
      backB.hidden = n === 1; nextB.hidden = n === 2; applyB.hidden = n === 1;
      if (n === 2) selPlats().forEach(p => { const mine = accBoxes().filter(c => c.dataset.plat === p); if (mine.length && !mine.some(c => c.checked)) mine[0].checked = true; });
      syncModal(); const f = n === 1 ? (cards.find(c => c.classList.contains('on')) || cards[0] || allPlat) : (accBoxes().find(c => !c.closest('.pmg').hidden) || allAcc); f && f.focus();
    }
    function open() {
      const ap = applied(), ids = ap.map(a => a.id);
      cards.forEach(c => pressCard(c, ap.some(a => a.p === c.dataset.plat)));
      $$('.pm-acc', modal).forEach(c => { c.checked = ids.includes(+c.value); });
      lastFocus = document.activeElement; modal.hidden = false; document.body.classList.add('modal-open');
      requestAnimationFrame(() => modal.classList.add('show')); go(1);
    }
    function close() { modal.classList.remove('show'); document.body.classList.remove('modal-open'); setTimeout(() => { modal.hidden = true; }, 180); if (lastFocus) lastFocus.focus(); }
    function apply() {
      const sp = selPlats(), pick = accBoxes().filter(c => c.checked && sp.includes(c.dataset.plat));
      if (!pick.length) { merr.textContent = 'Choose at least one account.'; return; }
      inputsBox.innerHTML = pick.map(c => `<input type="hidden" name="accounts" value="${c.value}" data-plat="${c.dataset.plat}">`).join('');
      renderChips(); close(); syncTargets(); render();
    }
    function renderChips() {
      const ap = applied();
      chipsBox.innerHTML = ap.length ? ORDER.filter(p => ap.some(a => a.p === p)).map(p => { const n = ap.filter(a => a.p === p).length; return `<span class="pchip"><span class="pdot ${p}"></span>${NM[p]} · ${n} account${n > 1 ? 's' : ''}</span>`; }).join('') : '<span class="muted pt-empty">Choose where to post</span>';
      openBtn.textContent = ap.length ? 'Edit' : 'Choose';
    }
    openBtn.addEventListener('click', open);
    modal.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) return close();
      const c = e.target.closest('button.pcard'); if (c) { pressCard(c, c.getAttribute('aria-pressed') !== 'true'); syncModal(); return; }
      if (e.target === nextB && !nextB.disabled) return go(2);
      if (e.target === backB) return go(1);
      if (e.target === applyB) return apply();
    });
    modal.addEventListener('change', e => {
      const t = e.target;
      if (t === allPlat) cards.forEach(c => pressCard(c, allPlat.checked));
      else if (t === allAcc) accBoxes().filter(c => !c.closest('.pmg').hidden).forEach(c => { c.checked = allAcc.checked; });
      else if (t.classList.contains('pm-pall')) accBoxes().filter(c => c.dataset.plat === t.dataset.plat).forEach(c => { c.checked = t.checked; });
      syncModal(); e.stopPropagation();
    });
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return close(); }
      if (e.key === 'Tab') { const f = $$('button,a[href],input', box).filter(x => !x.disabled && x.offsetParent !== null); if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
      if (step === 1 && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && e.target.classList.contains('pcard')) { e.preventDefault(); const i = cards.indexOf(e.target), d = /Down|Right/.test(e.key) ? 1 : -1; cards[(i + d + cards.length) % cards.length].focus(); }
      if (e.key === 'Enter' && e.target.type === 'checkbox') { e.preventDefault(); step === 1 ? (!nextB.disabled && go(2)) : apply(); }
    });
  }
  form.addEventListener('submit', e => {
    if ($('[name=id]', form).value) return;
    const pl = plats(), first = (ta.value.split('\n')[0] || '').trim(), { main } = fullText(); let msg = '';
    if (!pl.length) { msg = 'Choose at least one platform to post to.'; if (openBtn) openBtn.focus(); }
    else if (pl.includes('reddit') && !(sub && sub.value.trim())) { msg = 'Subreddit is required when posting to Reddit.'; sub && sub.focus(); }
    else if (pl.includes('reddit') && first.length > 300) msg = `Reddit title (first line) is ${first.length}/300 characters.`;
    else { const over = pl.filter(p => p !== 'reddit' && main.length > LIM[p]); if (over.length) msg = `Too long for ${over.map(p => p === 'x' ? 'X' : 'Threads').join(' and ')}: ${main.length} characters (max ${LIM[over[0]]}).`; }
    if (msg) { e.preventDefault(); e.stopImmediatePropagation(); terr.textContent = msg; terr.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }, true);
  syncTargets();
  form.addEventListener('input', render); form.addEventListener('change', render); render();
})();
