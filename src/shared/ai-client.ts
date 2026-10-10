import { PROVIDERS, type ProviderInfo, type RemoteId } from './ai-providers';
import { ClaudeError, listModels as claudeModels, sendMessage as claudeMessage } from './claude';

/**
 * One request to a provider reached over the network, whatever its API:
 * Anthropic's Messages, or OpenAI's « chat completions » (Groq, OpenRouter,
 * Gemini, Mistral, Cerebras, Ollama, one's own address). A free tier's limit
 * reached (429) is waited out, as the service says, a few times; a request
 * too large for it says so (the caller reads the transcript in smaller parts).
 * The key and the request go straight to the provider.
 */

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The request is too large for this model or tier: send less. */
    readonly tooLarge = false,
  ) {
    super(message);
  }
}

export interface AiTarget {
  id: RemoteId;
  key: string;
  model: string;
  /** Address of the API (the provider's own when not set). */
  base?: string;
}

export interface ChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** The free tier's limit reached: Boo Notes waits `seconds` before trying again. */
  onWait?(seconds: number): void;
}

export interface AiModel {
  id: string;
  name: string;
}

const info = (t: AiTarget): ProviderInfo => PROVIDERS[t.id];
const baseOf = (t: AiTarget) => (t.base || info(t).base).replace(/\/+$/, '');

function headers(t: AiTarget): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (t.key) h.authorization = `Bearer ${t.key}`;
  // OpenRouter shows which application calls it.
  if (t.id === 'openrouter') {
    h['HTTP-Referer'] = 'https://github.com/plyts/boo_notes';
    h['X-Title'] = 'Boo Notes';
  }
  return h;
}

/** What the service says went wrong (OpenAI-shaped `{error: {message}}`, Gemini's arrays…). */
function detailOf(body: string): string {
  try {
    const data = JSON.parse(body) as unknown;
    const first = Array.isArray(data) ? data[0] : data;
    const e = (first as { error?: { message?: unknown } | string; message?: unknown })?.error ?? first;
    const msg = typeof e === 'string' ? e : (e as { message?: unknown })?.message;
    if (typeof msg === 'string' && msg) return msg;
  } catch {
    // Not JSON.
  }
  return body.replace(/\s+/g, ' ').slice(0, 200);
}

const TOO_LARGE = /context(?:[ _-]length| window)|too (?:large|long)|maximum (?:context|prompt)|reduce the length|request entity|tokens? per minute|TPM|input is too long/i;

function explain(t: AiTarget, status: number, body: string): AiError {
  const label = info(t).label;
  const detail = detailOf(body);
  if (status === 401) return new AiError(`clé ${label} refusée (vérifiez-la dans les options)`, status);
  if (status === 403) return new AiError(`${label} refuse cette demande${detail ? ` (${detail})` : ''}`, status);
  if (status === 404) return new AiError(`modèle ou adresse introuvable chez ${label}${detail ? ` (${detail})` : ''}`, status);
  if (status === 413 || ((status === 400 || status === 422) && TOO_LARGE.test(detail))) return new AiError(`demande trop longue pour ${label}`, status, true);
  if (status === 429) return new AiError(`limite du palier gratuit de ${label} atteinte${detail ? ` (${detail})` : ''}`, status, TOO_LARGE.test(detail) && /request too large|exceed/i.test(detail));
  if (status >= 500) return new AiError(`${label} est momentanément indisponible`, status);
  return new AiError(detail || `erreur ${status} de ${label}`, status);
}

/** Seconds to wait after a 429, as the service says (headers, then its message), else 10 s. */
export function retryAfter(res: { headers: { get(name: string): string | null } }, body: string): number {
  const header = res.headers.get('retry-after');
  if (header && /^\d+(\.\d+)?$/.test(header.trim())) return Number(header);
  const reset = res.headers.get('x-ratelimit-reset-requests') ?? res.headers.get('x-ratelimit-reset-tokens');
  const fromText = (text: string): number | null => {
    // « Please try again in 7.66s », « in 1m2.5s », « 250ms », Gemini's « retryDelay": "20s" ».
    const m = /(?:try again in|retry(?:Delay)?["']?\s*[:=]?\s*["']?|reset(?:s)? in)\s*(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)\b/i.exec(text) ?? /^(?:(\d+)m)?(\d+(?:\.\d+)?)(ms|s)$/i.exec(text.trim());
    if (!m) return null;
    const value = Number(m[2]) / (m[3].toLowerCase() === 'ms' ? 1000 : 1) + (m[1] ? Number(m[1]) * 60 : 0);
    return Number.isFinite(value) ? value : null;
  };
  return fromText(body) ?? (reset ? fromText(reset) : null) ?? 10;
}

async function call(url: string, init: RequestInit, timeoutMs: number, label: string, outer?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const stop = () => ctrl.abort();
  outer?.addEventListener('abort', stop);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (outer?.aborted) throw new AiError('arrêté', 0);
    throw new AiError(ctrl.signal.aborted ? `${label} n’a pas répondu à temps` : `${label} injoignable (${e instanceof Error ? e.message : String(e)})`, 0);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  }
}

/** When each provider was last asked (its free tier's pace). */
const lastAsked = new Map<RemoteId, number>();

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new AiError('arrêté', 0));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });

async function pace(t: AiTarget, signal?: AbortSignal): Promise<void> {
  const gap = info(t).gapMs;
  const wait = (lastAsked.get(t.id) ?? 0) + gap - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastAsked.set(t.id, Date.now());
}

/** Tries left after a 429, and the longest wait accepted (s). */
const RETRIES = 5;
const MAX_WAIT = 65;

/** One message to the provider: its text reply. */
export async function chat(t: AiTarget, r: ChatRequest): Promise<string> {
  const p = info(t);
  for (let attempt = 0; ; attempt++) {
    await pace(t, r.signal);
    if (p.api === 'anthropic') {
      try {
        return await claudeMessage({ key: t.key, model: t.model, system: r.system, user: r.user, base: t.base, maxTokens: r.maxTokens });
      } catch (e) {
        if (!(e instanceof ClaudeError)) throw e;
        if (e.status === 429 && attempt < RETRIES) {
          r.onWait?.(20);
          await sleep(20_000, r.signal);
          continue;
        }
        throw new AiError(e.message, e.status, e.status === 413 || TOO_LARGE.test(e.message));
      }
    }
    const res = await call(
      `${baseOf(t)}/chat/completions`,
      {
        method: 'POST',
        headers: headers(t),
        body: JSON.stringify({
          model: t.model,
          messages: [
            { role: 'system', content: r.system },
            { role: 'user', content: r.user },
          ],
          temperature: 0.2,
          max_tokens: r.maxTokens ?? 1500,
          stream: false,
        }),
      },
      180_000,
      p.label,
      r.signal,
    );
    const body = await res.text();
    if (res.ok) {
      const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : ((c as { text?: string }).text ?? ''))).join('');
      throw new AiError(`réponse vide de ${p.label}`, res.status);
    }
    const err = explain(t, res.status, body);
    if (res.status === 429 && !err.tooLarge && attempt < RETRIES) {
      const seconds = Math.min(MAX_WAIT, Math.max(1, Math.ceil(retryAfter(res, body))));
      r.onWait?.(seconds);
      await sleep(seconds * 1000, r.signal);
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(3000, r.signal);
      continue;
    }
    throw err;
  }
}

/** The models the key may use (OpenRouter: its free ones), the suggested first. */
export async function listModels(t: Omit<AiTarget, 'model'>): Promise<AiModel[]> {
  const p = PROVIDERS[t.id];
  if (p.api === 'anthropic') {
    try {
      return await claudeModels(t.key, t.base);
    } catch (e) {
      throw e instanceof ClaudeError ? new AiError(e.message, e.status) : e;
    }
  }
  const target = { ...t, model: '' };
  const res = await call(`${baseOf(target)}/models`, { headers: headers(target) }, 20_000, p.label);
  const body = await res.text();
  if (!res.ok) throw explain(target, res.status, body);
  type Raw = { id?: unknown; name?: unknown; display_name?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
  const parsed = JSON.parse(body) as { data?: Raw[]; models?: Raw[] };
  const raw = parsed.data ?? parsed.models ?? [];
  const free = (m: Raw) => String(m.id).endsWith(':free') || (String(m.pricing?.prompt) === '0' && String(m.pricing?.completion) === '0');
  const list = raw
    .filter((m): m is Raw & { id: string } => typeof m.id === 'string' && m.id.length > 0)
    .filter((m) => p.only !== 'free' || free(m))
    // Gemini lists « models/gemini-2.5-flash »: the id is the last part.
    .map((m) => {
      const id = m.id.replace(/^models\//, '');
      const name = typeof m.name === 'string' && m.name && !m.name.startsWith('models/') ? m.name : typeof m.display_name === 'string' && m.display_name ? m.display_name : id;
      return { id, name };
    })
    // Embeddings, speech, images: not for writing.
    .filter((m) => !/embed|whisper|tts|speech|image|vision-only|guard|moderation|transcribe|audio/i.test(m.id));
  const rank = (id: string) => {
    const i = p.models.indexOf(id);
    return i === -1 ? p.models.length : i;
  };
  return list.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The model to choose in a list: the suggested one there, else the first. */
export function defaultModel(id: RemoteId, list: readonly AiModel[]): string {
  return PROVIDERS[id].models.find((m) => list.some((x) => x.id === m)) ?? list[0]?.id ?? PROVIDERS[id].models[0] ?? '';
}
