// Reddit: OAuth login, submission of the user's own scheduled posts (/api/submit, 'submit' scope) and read-only analytics.
// Never comments, votes or follows.
const { req, form } = require('./http');
const UA = 'web:social-scheduler:1.0 (by PostPilot)';
const SCOPES = 'identity read submit';
module.exports = {
  SCOPES, WRITE_SCOPE: 'submit', TITLE_LIMIT: 300,
  authorizeUrl: ({ clientId, redirect, state }) => `https://www.reddit.com/api/v1/authorize?${form({ client_id: clientId, response_type: 'code', state, redirect_uri: redirect, duration: 'permanent', scope: SCOPES })}`,
  async token(clientId, secret, body) {
    const r = await req('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: form(body) });
    return { token: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in, scope: r.scope || null };
  },
  me: token => req('https://oauth.reddit.com/api/v1/me', { headers: { Authorization: 'bearer ' + token, 'User-Agent': UA } }),
  async listing(token, sub, kind) {
    const url = `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/${kind === 'rising' ? 'rising' : 'top'}?limit=25${kind === 'rising' ? '' : '&t=day'}`;
    const r = await req(url, { headers: { Authorization: 'bearer ' + token, 'User-Agent': UA } });
    return (r.data && r.data.children || []).map(c => c.data).map(d => ({
      platform: 'reddit', id: d.id, text: (d.title + (d.selftext ? '\n' + d.selftext.slice(0, 400) : '')), url: 'https://reddit.com' + d.permalink,
      score: d.score + d.num_comments * 2, metrics: { upvotes: d.score, comments: d.num_comments }, media: d.post_hint || (d.is_video ? 'video' : d.is_self ? 'text' : 'link'), sub }));
  },
  // kind 'self' (text post) or 'link'. Returns { id, url }.
  async submit(token, { sr, title, text, url, kind }) {
    const r = await req('https://oauth.reddit.com/api/submit', { method: 'POST', headers: { Authorization: 'bearer ' + token, 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ api_type: 'json', sr, title, kind: kind === 'link' ? 'link' : 'self', text: kind === 'link' ? null : text, url: kind === 'link' ? url : null, resubmit: 'true', sendreplies: 'true' }) });
    const j = r.json || {}; if (j.errors && j.errors.length) throw Object.assign(new Error('Reddit: ' + j.errors.map(e => e[1] || e[0]).join('; ')), { permanent: !/RATELIMIT/i.test(JSON.stringify(j.errors)) });
    const d = j.data || {}; return { id: d.name || d.id, url: d.url || null };
  },
};
