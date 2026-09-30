/**
 * The Claude API (Anthropic), called from the extension with the user's own
 * key: the models the key may use, and one message. The key and the request
 * go straight to Anthropic; nothing passes through another server.
 */

export const CLAUDE_API = 'https://api.anthropic.com';
const VERSION = '2023-06-01';

export interface ClaudeModel {
  id: string;
  name: string;
}

export class ClaudeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function headers(key: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': VERSION,
    // Called from the browser (an extension page), with the user's own key.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

/** What went wrong, said plainly. */
function explain(status: number, body: string): string {
  let detail = '';
  try {
    detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    detail = body.slice(0, 200);
  }
  if (status === 401) return 'clé API Claude refusée (vérifiez-la dans les options)';
  if (status === 403) return 'cette clé API n’a pas accès à ce modèle';
  if (status === 404) return `modèle introuvable${detail ? ` (${detail})` : ''}`;
  if (status === 429) return 'trop de demandes à l’API Claude pour le moment, réessayez dans un instant';
  if (status === 529 || status >= 500) return 'l’API Claude est momentanément indisponible';
  return detail || `erreur ${status} de l’API Claude`;
}

async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new ClaudeError(ctrl.signal.aborted ? 'l’API Claude n’a pas répondu à temps' : `API Claude injoignable (${e instanceof Error ? e.message : String(e)})`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** The models this key may use, the most recent first (as the API lists them). */
export async function listModels(key: string, base = CLAUDE_API): Promise<ClaudeModel[]> {
  const res = await call(`${base}/v1/models?limit=100`, { headers: headers(key) }, 20_000);
  const body = await res.text();
  if (!res.ok) throw new ClaudeError(explain(res.status, body), res.status);
  const data = (JSON.parse(body) as { data?: Array<{ id?: unknown; display_name?: unknown }> }).data ?? [];
  return data
    .filter((m): m is { id: string; display_name?: unknown } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id }));
}

export interface MessageRequest {
  key: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  base?: string;
}

/** One message to Claude: its text reply. */
export async function sendMessage(r: MessageRequest): Promise<string> {
  const res = await call(
    `${r.base ?? CLAUDE_API}/v1/messages`,
    {
      method: 'POST',
      headers: headers(r.key),
      body: JSON.stringify({
        model: r.model,
        max_tokens: r.maxTokens ?? 1024,
        system: r.system,
        messages: [{ role: 'user', content: r.user }],
      }),
    },
    90_000,
  );
  const body = await res.text();
  if (!res.ok) throw new ClaudeError(explain(res.status, body), res.status);
  const data = JSON.parse(body) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('');
}
