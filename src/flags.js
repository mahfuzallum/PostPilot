// Country flags from ISO 3166-1 alpha-2 codes using Unicode regional indicator symbols ("BD" -> 🇧🇩).
// Unknown / missing / non-ISO codes fall back to a globe.
const GLOBE = '🌐';
const names = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { return null; } })();
const norm = c => String(c || '').trim().toUpperCase();
const valid = c => /^[A-Z]{2}$/.test(c) && !['XX', 'ZZ', 'T1', 'A1', 'A2', 'O1', 'EU', 'AP'].includes(c);
function flagEmoji(code) { const c = norm(code); return valid(c) ? String.fromCodePoint(...[...c].map(x => 0x1F1E6 + x.charCodeAt(0) - 65)) : GLOBE; }
function countryName(code) {
  const c = norm(code); if (!valid(c)) return 'Unknown';
  try { const n = names && names.of(c); return n && n !== c ? n : c; } catch (e) { return c; }
}
// HTML-safe label: flag + name (code in a title tooltip).
const flagLabel = code => { const c = norm(code); return `<span class="flag" aria-hidden="true">${flagEmoji(c)}</span> <span title="${valid(c) ? c : 'Unknown country'}">${countryName(c)}</span>`; };
module.exports = { flagEmoji, countryName, flagLabel, GLOBE };
