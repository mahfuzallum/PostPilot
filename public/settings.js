// Settings: section nav highlighting, sticky unsaved-changes bar, OpenAI key test.
(function () {
  const f = document.getElementById('setform'); if (!f) return;
  const bar = document.getElementById('savebar'), tzNames = [...f.querySelectorAll('[data-tzp] input[type=hidden]')].map(i => i.name), snap = () => { const d = new FormData(f); tzNames.forEach(n => d.delete(n)); return new URLSearchParams(d).toString(); }; // time zone saves itself instantly
  let base = snap();
  const check = () => { bar.hidden = snap() === base; document.body.classList.toggle('has-savebar', !bar.hidden); };
  f.addEventListener('input', check); f.addEventListener('change', check); f.addEventListener('tzchange', () => setTimeout(() => { if (!f.dataset.ready) { base = snap(); f.dataset.ready = 1; } check(); }));
  bar.querySelector('[data-reset]').addEventListener('click', () => location.reload());
  window.addEventListener('beforeunload', e => { if (!bar.hidden && !f.dataset.submitting) { e.preventDefault(); e.returnValue = ''; } });
  f.addEventListener('submit', () => { f.dataset.submitting = 1; });
  setTimeout(() => { base = snap(); check(); }, 0);
  const links = [...document.querySelectorAll('.set-nav a')], secs = links.map(a => document.querySelector(a.getAttribute('href')));
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) links.forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + e.target.id)); }), { rootMargin: '-30% 0px -60% 0px' });
  secs.forEach(s => s && io.observe(s));
  const tb = document.querySelector('[data-test-key]'), stat = document.getElementById('keystat');
  tb && tb.addEventListener('click', async () => {
    tb.classList.add('loading'); tb.disabled = true;
    try { const r = await fetch('/settings/openai', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ test: 1, key: document.getElementById('ok').value.trim() }) });
      const j = await r.json(); stat.textContent = j.ok ? '✅ Key works' : '❌ ' + (j.error || 'Key rejected'); window.ppToast(j.ok ? 'OpenAI key works' : 'Key test failed', j.ok ? 'ok' : 'err');
    } catch (e) { stat.textContent = '❌ Could not reach OpenAI'; } finally { tb.classList.remove('loading'); tb.disabled = false; }
  });
})();
