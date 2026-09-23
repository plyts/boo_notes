/**
 * Small Notion REST client: authentication, rate limiting (Notion allows ~3
 * requests / s per integration), retries on 429 / 5xx and file uploads.
 * https://developers.notion.com/reference/intro
 */

export const NOTION_VERSION = '2022-06-28';
export const NOTION_API = 'https://api.notion.com';
/** Notion rejects requests with more children than this. */
export const MAX_CHILDREN = 100;

export class NotionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'NotionError';
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.code === 'object_not_found';
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === 'unauthorized';
  }
}

/** A message the user can act upon. */
export function explainNotionError(e: unknown): string {
  if (!(e instanceof NotionError)) {
    const msg = e instanceof Error ? e.message : String(e);
    return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)
      ? 'Notion est injoignable : vérifiez votre connexion Internet'
      : msg;
  }
  if (e.isUnauthorized) return 'Jeton Notion refusé : vérifiez le « secret » de votre intégration';
  if (e.status === 403 || e.code === 'restricted_resource')
    return 'Accès refusé : partagez la page Notion avec l’intégration (••• › Connexions)';
  if (e.isNotFound)
    return 'Page Notion introuvable : vérifiez le lien et partagez la page avec l’intégration (••• › Connexions)';
  if (e.status === 429) return 'Notion limite le nombre de requêtes : nouvel essai dans un instant';
  return `Notion : ${e.message}`;
}

/** Extracts a page / database id from a Notion URL or a raw id (dashed or not). */
export function parseNotionId(input: string): string | null {
  const text = input.trim();
  let candidate = text;
  try {
    const url = new URL(text);
    candidate = url.searchParams.get('p') ?? url.pathname;
  } catch {
    // Not a URL: a raw id.
  }
  const m = /([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})(?![0-9a-f])/i.exec(candidate);
  if (!m) return null;
  const hex = m[1].replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface NotionClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Minimum delay between two requests (ms). */
  minIntervalMs?: number;
  maxRetries?: number;
  /** Test hook: replaces setTimeout-based waits. */
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

export interface NotionPage {
  id: string;
  url?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Json;
}

export interface NotionBlock {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface NotionList<T> {
  results: T[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export class NotionClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minInterval: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly opts: NotionClientOptions) {
    this.baseUrl = (opts.baseUrl ?? NOTION_API).replace(/\/+$/, '');
    // Unbound, `fetch` throws "Illegal invocation" in browsers (extension service worker).
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.minInterval = opts.minIntervalMs ?? 350;
    this.maxRetries = opts.maxRetries ?? 4;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  me(): Promise<{ id: string; name?: string; bot?: { workspace_name?: string } }> {
    return this.request('GET', '/v1/users/me');
  }

  retrievePage(id: string): Promise<NotionPage> {
    return this.request('GET', `/v1/pages/${id}`);
  }

  retrieveDatabase(id: string): Promise<{ id: string; url?: string; archived?: boolean; in_trash?: boolean; properties: Json }> {
    return this.request('GET', `/v1/databases/${id}`);
  }

  createDatabase(body: Json): Promise<{ id: string; url?: string }> {
    return this.request('POST', '/v1/databases', body);
  }

  updateDatabase(id: string, body: Json): Promise<{ id: string }> {
    return this.request('PATCH', `/v1/databases/${id}`, body);
  }

  /** Pages of a database matching a filter (first page of results). */
  queryDatabase(id: string, body: Json): Promise<NotionList<NotionPage>> {
    return this.request('POST', `/v1/databases/${id}/query`, body);
  }

  createPage(body: Json): Promise<NotionPage> {
    return this.request('POST', '/v1/pages', body);
  }

  updatePage(id: string, body: Json): Promise<NotionPage> {
    return this.request('PATCH', `/v1/pages/${id}`, body);
  }

  /** Appends blocks (in batches of 100) and returns the created top-level blocks, in order. */
  async appendChildren(blockId: string, children: Json[]): Promise<NotionBlock[]> {
    const created: NotionBlock[] = [];
    for (let i = 0; i < children.length; i += MAX_CHILDREN) {
      const res = await this.request<NotionList<NotionBlock>>('PATCH', `/v1/blocks/${blockId}/children`, {
        children: children.slice(i, i + MAX_CHILDREN),
      });
      created.push(...res.results);
    }
    return created;
  }

  async listChildren(blockId: string): Promise<NotionBlock[]> {
    const out: NotionBlock[] = [];
    let cursor: string | null | undefined;
    do {
      const qs = `page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await this.request<NotionList<NotionBlock>>('GET', `/v1/blocks/${blockId}/children?${qs}`);
      out.push(...res.results);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return out;
  }

  deleteBlock(id: string): Promise<unknown> {
    return this.request('DELETE', `/v1/blocks/${id}`);
  }

  /** Uploads a file (≤ 20 MB) and returns its id, to reference from an image block. */
  async uploadFile(filename: string, contentType: string, data: Uint8Array): Promise<string> {
    const upload = await this.request<{ id: string; upload_url?: string }>('POST', '/v1/file_uploads', {
      mode: 'single_part',
      filename,
      content_type: contentType,
    });
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(data)], { type: contentType }), filename);
    const path = upload.upload_url
      ? upload.upload_url.replace(/^https?:\/\/[^/]+/, '')
      : `/v1/file_uploads/${upload.id}/send`;
    await this.request('POST', path, form);
    return upload.id;
  }

  /** Serialised, rate-limited request with retries. */
  request<T>(method: string, path: string, body?: Json | FormData): Promise<T> {
    const run = this.queue.then(() => this.send<T>(method, path, body));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send<T>(method: string, path: string, body?: Json | FormData): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minInterval - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.opts.token}`,
            'Notion-Version': NOTION_VERSION,
            ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw e;
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : {}) as T;
      }
      const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      let code = 'http_error';
      let message = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { code?: string; message?: string };
        code = data.code ?? code;
        message = data.message ?? message;
      } catch {
        // Not JSON.
      }
      throw new NotionError(res.status, code, message);
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}
