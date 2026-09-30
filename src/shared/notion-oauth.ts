/**
 * « Connecter Notion »: Notion's own consent window (the public
 * integration of Boo Notes, OAuth), no secret to copy. The code it gives
 * back is exchanged for the access token by a small server holding the
 * client secret (tools/notion-oauth), which keeps nothing.
 *
 * The integration (its client id) and the exchange address are set when the
 * extension is built (notion-oauth.json, or BOO_NOTION_CLIENT_ID and
 * BOO_NOTION_OAUTH_URL): without them, the button explains it and the
 * integration secret remains the way to connect.
 */

export interface NotionOAuthConfig {
  clientId: string;
  /** The exchange server: `POST {exchangeUrl}` with `{ code, redirect_uri }`. */
  exchangeUrl: string;
  /** Tests: another consent page. */
  authorizeUrl?: string;
}

declare const __NOTION_OAUTH__: NotionOAuthConfig | null | undefined;

export const BUILT_IN_NOTION_OAUTH: NotionOAuthConfig | null =
  typeof __NOTION_OAUTH__ !== 'undefined' && __NOTION_OAUTH__?.clientId && __NOTION_OAUTH__.exchangeUrl ? __NOTION_OAUTH__ : null;

const AUTHORIZE = 'https://api.notion.com/v1/oauth/authorize';

export function authorizeUrl(cfg: NotionOAuthConfig, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', owner: 'user', redirect_uri: redirectUri, state });
  return `${cfg.authorizeUrl ?? AUTHORIZE}?${q}`;
}

/** The code of the consent, read from the address Notion sent back to. */
export function codeFrom(responseUrl: string, state: string): string {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new Error('réponse de Notion illisible');
  }
  const error = url.searchParams.get('error');
  if (error === 'access_denied') throw new Error('connexion annulée dans Notion');
  if (error) throw new Error(`Notion a refusé la connexion (${error})`);
  if (url.searchParams.get('state') !== state) throw new Error('réponse de Notion inattendue : recommencez');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('Notion n’a pas donné d’accès : recommencez');
  return code;
}

export interface NotionGrant {
  token: string;
  workspace: string | null;
  refreshToken?: string;
  /** The page of Boo Notes' template, copied into the workspace when chosen in the consent window. */
  templatePageId?: string;
}

type TokenResponse = {
  access_token?: string;
  workspace_name?: string;
  refresh_token?: string;
  duplicated_template_id?: string | null;
  error?: string;
  error_description?: string;
};

/** The other addresses of the exchange server, next to `/token`: `/refresh`, `/revoke`. */
export function exchangeEndpoint(cfg: NotionOAuthConfig, name: 'refresh' | 'revoke'): string {
  return new URL(name, cfg.exchangeUrl).href;
}

async function post(url: string, body: unknown, signal?: AbortSignal): Promise<{ res: Response; data: TokenResponse }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new Error(`serveur de connexion Notion injoignable (${e instanceof Error ? e.message : String(e)})`);
  }
  return { res, data: (await res.json().catch(() => ({}))) as TokenResponse };
}

function grantOf(res: Response, data: TokenResponse): NotionGrant {
  if (!res.ok || !data.access_token) throw new Error(`Notion n’a pas donné d’accès${data.error_description || data.error ? ` (${data.error_description ?? data.error})` : ''}`);
  return {
    token: data.access_token,
    workspace: data.workspace_name ?? null,
    ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    ...(data.duplicated_template_id ? { templatePageId: data.duplicated_template_id } : {}),
  };
}

/** The code exchanged for the access token, by the exchange server. */
export async function exchangeCode(cfg: NotionOAuthConfig, code: string, redirectUri: string): Promise<NotionGrant> {
  const { res, data } = await post(cfg.exchangeUrl, { code, redirect_uri: redirectUri });
  return grantOf(res, data);
}

/** A new access when Notion no longer takes the current one. */
export async function refreshAccess(cfg: NotionOAuthConfig, refreshToken: string): Promise<NotionGrant> {
  const { res, data } = await post(exchangeEndpoint(cfg, 'refresh'), { refresh_token: refreshToken });
  return grantOf(res, data);
}

/** « Déconnecter »: the access withdrawn on Notion's side too (true when Notion confirmed it). */
export async function revokeAccess(cfg: NotionOAuthConfig, token: string): Promise<boolean> {
  try {
    // Never holds « Déconnecter » up for long: already forgotten here.
    const { res } = await post(exchangeEndpoint(cfg, 'revoke'), { token }, AbortSignal.timeout(8000));
    return res.ok;
  } catch {
    return false;
  }
}
