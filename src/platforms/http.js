async function req(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const txt = await r.text();
    let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!r.ok) { const e = new Error(`HTTP ${r.status}: ${(data.error && (data.error.message || data.error)) || data.message || data.detail || txt.slice(0, 200)}`); e.status = r.status; e.data = data; throw e; }
    return data;
  } finally { clearTimeout(t); }
}
const form = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
module.exports = { req, form };
