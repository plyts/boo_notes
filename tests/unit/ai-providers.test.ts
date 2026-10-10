import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, defaultModel, listModels, retryAfter } from '../../src/shared/ai-client';
import { originPattern, PROVIDERS, REMOTE_IDS } from '../../src/shared/ai-providers';
import { accountOf, normalizeQa } from '../../src/shared/qa-config';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('IA : les fournisseurs', () => {
  it('les paliers gratuits d’abord, puis Ollama, Claude et une adresse à soi', () => {
    expect(REMOTE_IDS).toEqual(['groq', 'openrouter', 'gemini', 'mistral', 'cerebras', 'ollama', 'claude', 'custom']);
    for (const id of ['groq', 'openrouter', 'gemini', 'mistral', 'cerebras'] as const) {
      expect(PROVIDERS[id]).toMatchObject({ tier: 'free', api: 'openai', key: 'required' });
      expect(PROVIDERS[id].keyUrl).toMatch(/^https:\/\//);
    }
    expect(PROVIDERS.ollama).toMatchObject({ tier: 'local', key: 'none', base: 'http://localhost:11434/v1' });
    expect(originPattern('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
    expect(originPattern('pas une adresse')).toBeNull();
  });

  it('l’ancienne configuration (une clé Claude) est reprise telle quelle', () => {
    const qa = normalizeQa({ provider: 'claude', key: 'sk-ant-1', model: 'claude-x', base: 'http://127.0.0.1:9' });
    expect(qa).toMatchObject({ provider: 'claude', key: 'sk-ant-1', model: 'claude-x', base: 'http://127.0.0.1:9' });
    expect(qa.accounts.claude).toEqual({ key: 'sk-ant-1', model: 'claude-x', base: 'http://127.0.0.1:9' });
  });

  it('un fournisseur sans clé ni modèle retombe sur l’IA de Chrome ; les autres clés sont gardées', () => {
    const qa = normalizeQa({ provider: 'groq', accounts: { groq: { key: '', model: 'llama' }, gemini: { key: 'AIza', model: 'gemini-2.5-flash' } } });
    expect(qa.provider).toBe('chrome');
    expect(qa.accounts.gemini).toEqual({ key: 'AIza', model: 'gemini-2.5-flash' });
    expect(accountOf(qa, 'gemini')).toEqual({ key: 'AIza', model: 'gemini-2.5-flash', base: PROVIDERS.gemini.base });
    // Ollama needs no key; one's own address needs its address.
    expect(normalizeQa({ provider: 'ollama', accounts: { ollama: { key: '', model: 'llama3.1' } } }).provider).toBe('ollama');
    expect(normalizeQa({ provider: 'custom', accounts: { custom: { key: '', model: 'm' } } }).provider).toBe('chrome');
    expect(normalizeQa({ provider: 'custom', accounts: { custom: { key: '', model: 'm', base: 'http://localhost:1234/v1' } } }).provider).toBe('custom');
    expect(normalizeQa({ provider: 'nimporte' }).provider).toBe('chrome');
  });

  it('le délai d’attente que le service indique après un 429', () => {
    const headers = (h: Record<string, string>) => ({ headers: { get: (n: string) => h[n.toLowerCase()] ?? null } });
    expect(retryAfter(headers({ 'retry-after': '12' }), '')).toBe(12);
    expect(retryAfter(headers({}), '{"error":{"message":"Rate limit reached … Please try again in 7.66s."}}')).toBeCloseTo(7.66);
    expect(retryAfter(headers({}), 'try again in 1m2.5s')).toBeCloseTo(62.5);
    expect(retryAfter(headers({}), '[{"error":{"details":[{"retryDelay":"20s"}]}}]')).toBe(20);
    expect(retryAfter(headers({ 'x-ratelimit-reset-tokens': '250ms' }), '')).toBeCloseTo(0.25);
    expect(retryAfter(headers({}), 'nothing said')).toBe(10);
  });
});

describe('IA : une requête « chat completions »', () => {
  const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it('la clé en Bearer, le système puis la question, la réponse lue', async () => {
    const fetchMock = vi.fn(async () => ok('{"a":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const reply = await chat({ id: 'groq', key: 'gsk_test', model: 'llama-3.3-70b-versatile', base: 'http://mock/v1' }, { system: 'S', user: 'U', maxTokens: 300 });
    expect(reply).toBe('{"a":1}');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://mock/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer gsk_test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'llama-3.3-70b-versatile', max_tokens: 300, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] });
  });

  it('limite du palier gratuit (429) : attend ce que le service dit, puis réessaie', async () => {
    vi.useFakeTimers();
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (n++ === 0 ? new Response('{"error":{"message":"Rate limit reached. Please try again in 3s."}}', { status: 429 }) : ok('fini'))),
    );
    const waits: number[] = [];
    const done = chat({ id: 'cerebras', key: 'k', model: 'm', base: 'http://mock/v1' }, { system: 'S', user: 'U', onWait: (s) => waits.push(s) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBe('fini');
    expect(waits).toEqual([3]);
  });

  it('demande trop longue pour ce palier (413) : dit « trop longue » (la transcription sera lue par parties)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Request too large for model on tokens per minute (TPM): Limit 6000, Requested 9000"}}', { status: 413 })));
    await expect(chat({ id: 'groq', key: 'k', model: 'm', base: 'http://mock/v1' }, { system: 'S', user: 'U' })).rejects.toMatchObject({ tooLarge: true, status: 413 });
  });

  it('clé refusée : dit laquelle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 })));
    await expect(chat({ id: 'gemini', key: 'bad', model: 'm', base: 'http://mock' }, { system: 'S', user: 'U' })).rejects.toThrow('clé Google Gemini refusée');
  });

  it('les modèles : OpenRouter ne propose que ses gratuits, le suggéré d’abord ; Gemini sans « models/ »', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('openrouter')
          ? new Response(
              JSON.stringify({
                data: [
                  { id: 'openai/gpt-4o', name: 'GPT-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
                  { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (free)' },
                  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
                ],
              }),
            )
          : new Response(JSON.stringify({ data: [{ id: 'models/text-embedding-004' }, { id: 'models/gemini-2.0-flash' }, { id: 'models/gemini-2.5-flash' }] })),
      ),
    );
    const free = await listModels({ id: 'openrouter', key: 'sk-or' });
    expect(free.map((m) => m.id)).toEqual(['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free']);
    expect(defaultModel('openrouter', free)).toBe('meta-llama/llama-3.3-70b-instruct:free');
    const gemini = await listModels({ id: 'gemini', key: 'AIza' });
    expect(gemini.map((m) => m.id)).toEqual(['gemini-2.5-flash', 'gemini-2.0-flash']);
  });
});
