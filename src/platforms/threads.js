// Meta Threads API client. Docs: https://developers.facebook.com/docs/threads
const { req, form } = require('./http');
const G = 'https://graph.threads.net/v1.0';
const SCOPES = 'threads_basic,threads_content_publish,threads_manage_insights';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const real = {
  authorizeUrl: ({ appId, redirect, state, extraScopes }) =>
    `https://threads.net/oauth/authorize?${form({ client_id: appId, redirect_uri: redirect, scope: SCOPES + (extraScopes || ''), response_type: 'code', state })}`,
  async exchangeCode({ appId, appSecret, redirect, code }) {
    const short = await req('https://graph.threads.net/oauth/access_token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirect, code }) });
    const long = await req(`https://graph.threads.net/access_token?${form({ grant_type: 'th_exchange_token', client_secret: appSecret, access_token: short.access_token })}`);
    return { token: long.access_token, expiresIn: long.expires_in, userId: String(short.user_id) };
  },
  async refresh(token) {
    const r = await req(`https://graph.threads.net/refresh_access_token?${form({ grant_type: 'th_refresh_token', access_token: token })}`);
    return { token: r.access_token, expiresIn: r.expires_in };
  },
  me: token => req(`${G}/me?fields=id,username,threads_profile_picture_url&access_token=${encodeURIComponent(token)}`),
  async publishingLimit(uid, token) {
    const r = await req(`${G}/${uid}/threads_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(token)}`);
    const d = (r.data || [])[0] || {};
    return { used: d.quota_usage || 0, total: (d.config && d.config.quota_total) || 250 };
  },
  async container(uid, token, params) {
    const r = await req(`${G}/${uid}/threads`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ ...params, access_token: token }) });
    return r.id;
  },
  async waitReady(id, token, maxMs = 300000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const r = await req(`${G}/${id}?fields=status,error_message&access_token=${encodeURIComponent(token)}`);
      if (r.status === 'FINISHED' || r.status === 'PUBLISHED') return;
      if (r.status === 'ERROR' || r.status === 'EXPIRED') throw new Error('Media processing failed: ' + (r.error_message || r.status));
      await sleep(5000);
    }
    throw new Error('Media processing timeout');
  },
  async publish(uid, token, creationId) {
    const r = await req(`${G}/${uid}/threads_publish`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ creation_id: creationId, access_token: token }) });
    return r.id;
  },
  permalink: async (id, token) => (await req(`${G}/${id}?fields=permalink&access_token=${encodeURIComponent(token)}`)).permalink,
  async insights(id, token) {
    const r = await req(`${G}/${id}/insights?metric=views,likes,replies,reposts&access_token=${encodeURIComponent(token)}`);
    const o = { views: 0, likes: 0, replies: 0, reposts: 0 };
    for (const m of r.data || []) o[m.name] = (m.values && m.values[0] && m.values[0].value) || (m.total_value && m.total_value.value) || 0;
    return o;
  },
  async remove(id, token) { return req(`${G}/${id}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' }); },
  async keywordSearch(token, q) {
    const r = await req(`${G}/keyword_search?${form({ q, search_type: 'TOP', fields: 'id,text,media_type,permalink,timestamp,username', access_token: token })}`);
    return r.data || [];
  },
};

// High level: create the right container type and publish. Returns { id, replyId }.
async function postThread(client, { uid, token, text, mediaType, mediaUrls, replyText }) {
  let creation;
  if (mediaType === 'IMAGE') creation = await client.container(uid, token, { media_type: 'IMAGE', image_url: mediaUrls[0], text });
  else if (mediaType === 'VIDEO') { creation = await client.container(uid, token, { media_type: 'VIDEO', video_url: mediaUrls[0], text }); await client.waitReady(creation, token); }
  else if (mediaType === 'CAROUSEL') {
    const kids = [];
    for (const u of mediaUrls.slice(0, 20)) {
      const isVid = /\.(mp4|mov)(\?|$)/i.test(u);
      const k = await client.container(uid, token, isVid ? { media_type: 'VIDEO', video_url: u, is_carousel_item: true } : { media_type: 'IMAGE', image_url: u, is_carousel_item: true });
      if (isVid) await client.waitReady(k, token);
      kids.push(k);
    }
    creation = await client.container(uid, token, { media_type: 'CAROUSEL', children: kids.join(','), text });
    await client.waitReady(creation, token).catch(() => {});
  } else creation = await client.container(uid, token, { media_type: 'TEXT', text });
  if (mediaType !== 'TEXT' && mediaType !== 'VIDEO') await sleep(client.mock ? 0 : 3000);
  const id = await client.publish(uid, token, creation);
  let replyId = null;
  if (replyText) {
    const rc = await client.container(uid, token, { media_type: 'TEXT', text: replyText, reply_to_id: id });
    await sleep(client.mock ? 0 : 3000);
    replyId = await client.publish(uid, token, rc);
  }
  return { id, replyId };
}

let active = real;
module.exports = { get client() { return active; }, setClient(c) { active = c || real; }, real, postThread, SCOPES, LIMIT: 500 };
