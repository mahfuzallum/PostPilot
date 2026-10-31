// Time helpers + auto-slot generator weighted to America/New_York prime time.
const NY = 'America/New_York', DHAKA = 'Asia/Dhaka';
function fmt(ms, tz) { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)); }
function tzOffsetMs(tz, at) {
  const d = new Date(at); const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - d.getTime() + d.getUTCMilliseconds() * 0;
}
// "2026-11-01T09:30" interpreted in tz -> epoch ms
function parseLocal(str, tz) {
  const [d, t] = String(str).split('T'); const [Y, M, D] = d.split('-').map(Number); const [h, m] = (t || '0:0').split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  return guess - tzOffsetMs(tz, guess - tzOffsetMs(tz, guess));
}
function nyHour(ms) { return Number(new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms))); }
// Weight per NY hour: prime 7-9, 11-13, 17-22.
const W = h => (h >= 7 && h <= 9) || (h >= 11 && h <= 13) ? 3 : (h >= 17 && h <= 22) ? 4 : (h >= 1 && h <= 5) ? 0.2 : 1;
function autoSlots(from, count, taken = [], rand = Math.random) {
  const out = []; let cursor = Math.max(from, ...taken.filter(t => t > from - 3 * 3600e3).map(t => t + 3 * 3600e3), from);
  while (out.length < count) {
    // candidates in the window 3h..4h after cursor (10-minute steps); choose by weight
    const c = []; for (let m = 180; m <= 240; m += 10) { const t = cursor + m * 60e3; c.push([t, W(nyHour(t))]); }
    if (!out.length && cursor === from) c.unshift([from + 10 * 60e3, W(nyHour(from + 10 * 60e3))]);
    const total = c.reduce((a, [, w]) => a + w, 0); let r = rand() * total, pick = c[0][0];
    for (const [t, w] of c) { if ((r -= w) <= 0) { pick = t; break; } }
    // if pick lands in dead hours (1-5am NY) jump ahead to 7am NY
    let guard = 0; while (W(nyHour(pick)) < 0.5 && guard++ < 8) pick += 3600e3;
    pick = Math.round(pick / 60e3) * 60e3; out.push(pick); cursor = pick;
  }
  return out;
}
module.exports = { fmt, parseLocal, autoSlots, NY, DHAKA, nyHour };
