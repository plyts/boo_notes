// « Connecter Notion » — the only server Boo Notes needs, and only for this: it
// holds the client secret of the public Notion integration (which must never be in the
// extension, where anyone could read it) and exchanges the code of the consent for the
// access token. It keeps nothing: the token goes straight back to the extension.
//   POST /token    { code, redirect_uri }  the consent's code → the access
//   POST /refresh  { refresh_token }       a new access when Notion no longer takes the current one
//   POST /revoke   { token }               « Déconnecter »: the access withdrawn in Notion too
//
// A Cloudflare Worker (free plan is plenty); see README.md next to it. Settings:
//   NOTION_CLIENT_ID, NOTION_CLIENT_SECRET   the public integration (notion.so/profile/integrations)
//   ALLOWED_EXTENSIONS (optional)            extension ids allowed, comma separated (else any)
//   NOTION_API (optional)                    another Notion API address (tests)

const REDIRECT = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/notion$/;

function cors(request) {
  const origin = request.headers.get('Origin') ?? '';
  return {
    // Only an extension may call it (its pages and service worker send their own origin).
    'Access-Control-Allow-Origin': origin.startsWith('chrome-extension://') ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request, status, data) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors(request), 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    if (request.method !== 'POST' || !['/token', '/refresh', '/revoke'].includes(url.pathname)) return json(request, 404, { error: 'not_found' });
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) return json(request, 500, { error: 'server_not_configured', error_description: 'NOTION_CLIENT_ID / NOTION_CLIENT_SECRET missing.' });
    let body;
    try {
      body = await request.json();
    } catch {
      return json(request, 400, { error: 'invalid_request' });
    }
    let grant;
    let endpoint = '/v1/oauth/token';
    if (url.pathname === '/revoke') {
      if (typeof body.token !== 'string' || !body.token) return json(request, 400, { error: 'invalid_request' });
      endpoint = '/v1/oauth/revoke';
      grant = { token: body.token };
    } else if (url.pathname === '/token') {
      const redirect = REDIRECT.exec(String(body.redirect_uri ?? ''));
      const allowed = String(env.ALLOWED_EXTENSIONS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!redirect || (allowed.length && !allowed.includes(redirect[1]))) return json(request, 400, { error: 'invalid_redirect_uri' });
      if (typeof body.code !== 'string' || !body.code) return json(request, 400, { error: 'invalid_request' });
      grant = { grant_type: 'authorization_code', code: body.code, redirect_uri: body.redirect_uri };
    } else {
      if (typeof body.refresh_token !== 'string' || !body.refresh_token) return json(request, 400, { error: 'invalid_request' });
      grant = { grant_type: 'refresh_token', refresh_token: body.refresh_token };
    }
    const res = await fetch(`${env.NOTION_API ?? 'https://api.notion.com'}${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(grant),
    });
    const data = await res.json().catch(() => ({ error: 'bad_gateway' }));
    return json(request, res.status, data);
  },
};
