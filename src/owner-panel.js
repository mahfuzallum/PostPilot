// Owner console helpers (served only to a logged-in owner): live countdowns, ban reason prompt, confirms, copy chips.
(function () {
  const pad = n => String(n).padStart(2, '0');
  function tick() {
    const now = Date.now();
    document.querySelectorAll('.cd[data-until]').forEach(el => {
      const ms = Number(el.dataset.until) - now;
      if (ms <= 0) { el.textContent = 'Expired'; el.className = 'cd exp'; return; }
      const d = Math.floor(ms / 864e5), hh = Math.floor(ms % 864e5 / 36e5), mm = Math.floor(ms % 36e5 / 6e4), ss = Math.floor(ms % 6e4 / 1e3);
      el.textContent = d ? `${d}d ${pad(hh)}h ${pad(mm)}m` : `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
      el.className = 'cd ' + (ms < 864e5 ? 'bad' : ms < 7 * 864e5 ? 'warn' : 'ok');
      el.title = new Date(Number(el.dataset.until)).toLocaleString();
    });
  }
  tick(); setInterval(tick, 1000);
  document.addEventListener('submit', e => {
    const f = e.target;
    if (f.dataset.reason) { const r = prompt(f.dataset.reason, ''); if (r === null) { e.preventDefault(); return; } f.querySelector('[name=reason]').value = r; }
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) e.preventDefault();
  }, true);
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy-text]'); if (!b) return;
    navigator.clipboard.writeText(b.dataset.copyText).then(() => { b.textContent = '✓ Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); });
  });
  document.querySelectorAll('[data-amount-src]').forEach(sel => {
    const amt = sel.form.querySelector('[name=amount]'), upd = () => { amt.placeholder = '$' + sel.selectedOptions[0].dataset.usd + ' (list)'; }; sel.addEventListener('change', upd); upd();
  });
  document.querySelectorAll('details.pop').forEach(d => d.addEventListener('toggle', () => { if (d.open) document.querySelectorAll('details.pop[open]').forEach(o => o !== d && (o.open = false)); }));
  const sb = document.querySelector('.op-side'); const m = document.createElement('button'); m.className = 'op-burger btn ghost sm'; m.textContent = '☰ Menu'; m.onclick = () => sb.classList.toggle('open');
  const top = document.querySelector('.op-top'); top && top.prepend(m);
})();
