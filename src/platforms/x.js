// X (Twitter): OAuth 2.0 PKCE login, publishing of the user's own scheduled posts (POST /2/tweets) and recent-search analytics.
// No auto-engagement: the app never likes, replies to others, follows or reposts.
const crypto = require('crypto');
const { req, form } = require('./http');
const b64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const auth = token => ({ Authorization: 'Bearer ' + token });
module.exports = {
  SCOPES, WRITE_SCOPE: 'tweet.write', LIMIT: 280,
  pkce() { const verifier = b64url(crypto.randomBytes(32)); return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) }; },
  authorizeUrl: ({ clientId, redirect, state, challenge }) => `https://x.com/i/oauth2/authorize?${form({ response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' })}`,
  async token(clientId, secret, body) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (secret) headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64');
    const r = await req('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body: form({ ...body, client_id: clientId }) });
    return { token: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in, scope: r.scope || null };
  },
  me: async token => (await req('https://api.x.com/2/users/me?user.fields=profile_image_url', { headers: { Authorization: 'Bearer ' + token } })).data,
  async search(token, q) {
    const start = new Date(Date.now() - 23.9 * 3600e3).toISOString();
    const r = await req(`https://api.x.com/2/tweets/search/recent?${form({ query: q + ' -is:retweet', max_results: 50, start_time: start, 'tweet.fields': 'public_metrics,created_at,attachments', expansions: 'attachments.media_keys', 'media.fields': 'type' })}`, { headers: { Authorization: 'Bearer ' + token } });
    const media = {}; for (const m of (r.includes && r.includes.media) || []) media[m.media_key] = m.type;
    return (r.data || []).map(t => { const m = t.public_metrics || {}; return {
      platform: 'x', id: t.id, text: t.text, url: `https://x.com/i/web/status/${t.id}`,
      score: (m.like_count || 0) + 2 * (m.retweet_count || 0) + 2 * (m.reply_count || 0) + (m.quote_count || 0),
      metrics: { likes: m.like_count, reposts: m.retweet_count, replies: m.reply_count, impressions: m.impression_count },
      media: t.attachments && t.attachments.media_keys ? media[t.attachments.media_keys[0]] || 'media' : 'text' }; }).sort((a, b) => b.score - a.score);
  },
  // v2 media upload (one image per call, needs media.write). Returns media_id.
  async uploadMedia(token, url) {
    const src = await fetch(url); if (!src.ok) throw Object.assign(new Error(`Could not download media (${src.status})`), { permanent: true });
    const type = src.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//.test(type)) throw Object.assign(new Error('X posting supports images only (no video yet)'), { permanent: true });
    const fd = new FormData(); fd.append('media', new Blob([await src.arrayBuffer()], { type }), 'upload'); fd.append('media_category', 'tweet_image');
    const r = await req('https://api.x.com/2/media/upload', { method: 'POST', headers: auth(token), body: fd, timeout: 60000 });
    return (r.data && (r.data.id || r.data.media_id)) || r.media_id_string;
  },
  // Publish one tweet the user wrote. Optional reply (e.g. the link as first reply) and up to 4 images.
  async post(token, { text, mediaIds = [], replyTo = null }) {
    const body = { text }; if (mediaIds.length) body.media = { media_ids: mediaIds.slice(0, 4) }; if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo };
    const r = await req('https://api.x.com/2/tweets', { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { id: r.data.id };
  },
};
