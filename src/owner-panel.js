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

  // ---- Plan modal (centered dialog on desktop, bottom sheet on phones). Without JS the links open a full page. ----
  const DAY = 864e5, iso = t => new Date(t).toISOString().slice(0, 10);
  function initPlan(root) {
    root.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', e => {
      e.preventDefault();
      root.querySelectorAll('[data-tab]').forEach(x => { x.classList.toggle('on', x === t); x.setAttribute('aria-selected', x === t); });
      root.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== t.dataset.tab; });
    }));
    const f = root.querySelector('[data-plan-form]'); if (f) {
      const s = f.elements.start, en = f.elements.end, amt = f.elements.amount;
      const fill = () => { const r = f.querySelector('[name=plan]:checked'); if (!r) return; const d = Number(r.dataset.days), st = Date.parse(s.value + 'T00:00:00Z');
        amt.placeholder = r.dataset.usd ? '$' + r.dataset.usd + ' list' : 'amount';
        if (d && !isNaN(st)) en.value = iso(st + d * DAY); else if (!d) en.focus(); };
      f.querySelectorAll('[name=plan]').forEach(r => r.addEventListener('change', fill)); s.addEventListener('change', fill);
    }
    root.querySelectorAll('[name=until]').forEach(u => u.addEventListener('input', () => { const d = u.form.querySelector('[name=dur][value=date]'); if (d) d.checked = true; }));
  }
  document.querySelectorAll('.pm-page [data-pm]').forEach(initPlan);
  let dlg = null;
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-modal]');
    if (a && window.fetch && window.HTMLDialogElement) {
      e.preventDefault();
      document.querySelectorAll('details.pop[open]').forEach(o => (o.open = false));
      fetch(a.href + (a.href.includes('?') ? '&' : '?') + 'partial=1', { credentials: 'same-origin' }).then(r => r.ok ? r.text() : Promise.reject(r)).then(html => {
        if (!dlg) { dlg = document.createElement('dialog'); dlg.className = 'pm-dlg'; document.body.appendChild(dlg);
          dlg.addEventListener('click', ev => { if (ev.target === dlg) dlg.close(); }); }
        dlg.innerHTML = html; initPlan(dlg); dlg.showModal();
      }).catch(() => { location.href = a.href; });
      return;
    }
    const c = e.target.closest('[data-close]');
    if (c && dlg && dlg.open && dlg.contains(c)) { e.preventDefault(); dlg.close(); }
  });
  const sb = document.querySelector('.op-side'); const m = document.createElement('button'); m.className = 'op-burger btn ghost sm'; m.textContent = '☰ Menu'; m.onclick = () => sb.classList.toggle('open');
  const top = document.querySelector('.op-top'); top && top.prepend(m);
})();
