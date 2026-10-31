// Optional Google Drive: list images in a folder (read-only) and import them.
const { req, form } = require('./http');
module.exports = {
  authorizeUrl: ({ clientId, redirect, state }) => `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.readonly', access_type: 'offline', prompt: 'consent', state })}`,
  async token(body) {
    const r = await req('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(body) });
    return { token: r.access_token, refresh: r.refresh_token, expiresIn: r.expires_in };
  },
  async list(token, folderId) {
    const q = `'${folderId.replace(/'/g, '')}' in parents and mimeType contains 'image/' and trashed=false`;
    const r = await req(`https://www.googleapis.com/drive/v3/files?${form({ q, fields: 'files(id,name,mimeType,thumbnailLink,imageMediaMetadata(width,height))', pageSize: 100 })}`, { headers: { Authorization: 'Bearer ' + token } });
    return r.files || [];
  },
  async download(token, id) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error('Drive download failed ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  },
};
