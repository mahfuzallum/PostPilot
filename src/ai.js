const S = require('./settings');
const { AsyncLocalStorage } = require('async_hooks');
// A user's own OpenAI key (Settings) wins; otherwise the server OPENAI_API_KEY env var is used.
const als = new AsyncLocalStorage();
const keyNow = () => (als.getStore() || {}).key || S.get('openai_key');
const withKey = (key, fn) => als.run({ key: key || null }, fn);
async function testKey(key) {
  const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).error.message; } catch {} throw new Error(m); }
  return true;
}
async function chat(messages, json = false) {
  const key = keyNow(); if (!key) throw new Error('Add your own OpenAI API key in Settings → AI writing to use AI');
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: S.get('openai_model') || 'gpt-4o-mini', messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }) });
  const j = await r.json(); if (!r.ok) throw new Error('OpenAI: ' + (j.error && j.error.message));
  return j.choices[0].message.content.trim();
}
const generate = (topic, tone, lang) => chat([
  { role: 'system', content: 'You write engaging, original Threads posts under 480 characters. No hashtag spam. Output only the post text.' },
  { role: 'user', content: `Topic: ${topic}\nTone: ${tone || 'friendly'}\nLanguage: ${lang || 'English'}` }]);

// Heuristic pattern summary (used when no OpenAI key)
function heuristics(items) {
  if (!items.length) return { summary: 'No items.', patterns: {} };
  const len = items.map(i => i.text.length); const avg = Math.round(len.reduce((a, b) => a + b, 0) / len.length);
  const firstLines = items.map(i => i.text.split('\n')[0]);
  const q = firstLines.filter(l => /\?/.test(l)).length, num = firstLines.filter(l => /^\s*\d|\b\d+\s+(ways|tips|things|reasons)/i.test(l)).length;
  const lists = items.filter(i => /\n\s*([-•*]|\d+[.)])/.test(i.text)).length;
  const media = {}; items.forEach(i => { media[i.media] = (media[i.media] || 0) + 1; });
  const pct = n => Math.round(100 * n / items.length) + '%';
  const patterns = { avgLength: avg, questionHooks: pct(q), numberHooks: pct(num), listStructure: pct(lists), media };
  return { patterns, summary: `Avg length ${avg} chars. Hooks: ${pct(q)} open with a question, ${pct(num)} with a number/list promise. ${pct(lists)} use list structure. Media mix: ${Object.entries(media).map(([k, v]) => k + ' ' + v).join(', ')}.` };
}
async function summarize(items) {
  const h = heuristics(items);
  if (!keyNow()) return { ...h, by: 'heuristics' };
  try {
    const sample = items.slice(0, 25).map((i, n) => `${n + 1}. [${i.media}, score ${i.score}] ${i.text.slice(0, 280)}`).join('\n');
    const s = await chat([{ role: 'system', content: 'Analyse top social posts. Describe hook styles, structure, length and media patterns in 5-7 bullet points. Do not quote posts.' }, { role: 'user', content: sample }]);
    return { ...h, summary: s, by: 'openai' };
  } catch (e) { return { ...h, by: 'heuristics', note: e.message }; }
}
async function draftFromPattern(summary, topic) {
  if (keyNow()) return chat([
    { role: 'system', content: 'Write ONE original Threads post (<480 chars) applying the described patterns. Never copy or paraphrase any existing post; create new wording.' },
    { role: 'user', content: `Patterns:\n${summary}\n\nMy topic: ${topic}` }]);
  return `${topic ? topic + ' — ' : ''}here's what most people miss:\n\n1. Start small\n2. Stay consistent\n3. Share what you learn\n\nWhich one are you working on this week?`;
}
module.exports = { withKey, testKey, keyNow, generate, summarize, draftFromPattern, heuristics };
