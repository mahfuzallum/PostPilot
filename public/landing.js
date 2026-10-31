// Landing page: scroll reveal, live time-zone demo. Respects prefers-reduced-motion.
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const els = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) els.forEach(e => e.classList.add('in'));
  else { const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12, rootMargin: '0px 0px -40px 0px' }); els.forEach(e => io.observe(e)); }
  const out = document.getElementById('tz-out'), w = document.querySelector('#tzdemo [data-tzp]');
  if (!out || !w) return;
  const offset = (tz, at) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value])); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at; };
  const nyAt = hh => { const now = new Date(), g = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, 0); return g - offset('America/New_York', g - offset('America/New_York', g)); };
  const fmt = (ms, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  const draw = () => { const tz = w.dataset.value || 'UTC';
    out.innerHTML = [19, 20, 21, 22].map(hh => `<div class="slot"><span>${fmt(nyAt(hh), 'America/New_York')} <small>New York</small></span><b>${fmt(nyAt(hh), tz)}</b><small>${tz.replace(/_/g, ' ')}</small></div>`).join(''); };
  w.addEventListener('tzchange', draw); draw();
})();
