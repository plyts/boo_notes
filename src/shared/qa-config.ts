import { isRemote, PROVIDERS, type AiProviderId, type RemoteId } from './ai-providers';

/**
 * Which AI writes the answers to the questions and the summaries
 * (options › IA): Chrome's built-in AI (on the device, the default), a
 * provider reached with the user's own key — free tiers (Groq, OpenRouter,
 * Gemini, Mistral, Cerebras), Ollama on this computer, Claude, an
 * OpenAI-compatible address — or none (the closest passages, no AI).
 * Kept in `chrome.storage.local`: the keys never leave this browser (not
 * synced with the Google account).
 */

export const QA_KEY = 'qa:config';

/** What a provider needs: its key, the model chosen, another address (Ollama elsewhere, one's own service, tests). */
export interface AiAccount {
  key: string;
  model: string;
  base?: string;
}

export interface QaConfig {
  provider: AiProviderId;
  /** Every provider set up, kept when another one is chosen. */
  accounts: Partial<Record<RemoteId, AiAccount>>;
  /** The chosen provider's key, model and address (as before several providers: read by older code and tests). */
  key: string;
  model: string;
  base?: string;
}

export const DEFAULT_QA: QaConfig = { provider: 'chrome', accounts: {}, key: '', model: '' };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** A provider is ready once it has what it needs: a model, its key, its address. */
export function accountReady(id: RemoteId, a: AiAccount | undefined): a is AiAccount {
  if (!a?.model) return false;
  const p = PROVIDERS[id];
  if (p.key === 'required' && !a.key) return false;
  if (!p.base && !a.base) return false;
  return true;
}

export function normalizeQa(raw: unknown): QaConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const accounts: Partial<Record<RemoteId, AiAccount>> = {};
  const given = (r.accounts && typeof r.accounts === 'object' ? r.accounts : {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(given)) {
    if (!isRemote(id) || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const base = str(v.base);
    accounts[id] = { key: str(v.key), model: str(v.model), ...(base ? { base } : {}) };
  }
  // Before several providers: one Claude key, model and address at the top.
  const legacyKey = str(r.key);
  const legacyModel = str(r.model);
  const legacyBase = str(r.base);
  if (!r.accounts && (legacyKey || legacyModel || legacyBase)) {
    accounts.claude = { key: legacyKey, model: legacyModel, ...(legacyBase ? { base: legacyBase } : {}) };
  }
  let provider: AiProviderId = r.provider === 'none' ? 'none' : isRemote(r.provider) ? r.provider : 'chrome';
  // A provider without what it needs falls back to Chrome's AI.
  if (isRemote(provider) && !accountReady(provider, accounts[provider])) provider = 'chrome';
  const active = isRemote(provider) ? accounts[provider] : undefined;
  return {
    provider,
    accounts,
    key: active?.key ?? '',
    model: active?.model ?? '',
    ...(active?.base ? { base: active.base } : {}),
  };
}

/** The account of a provider, with its address (its own, or the provider's). */
export function accountOf(qa: QaConfig, id: RemoteId): (AiAccount & { base: string }) | null {
  const a = qa.accounts[id];
  if (!accountReady(id, a)) return null;
  return { ...a, base: a.base || PROVIDERS[id].base };
}

export async function loadQa(): Promise<QaConfig> {
  const res = await chrome.storage.local.get(QA_KEY);
  return normalizeQa(res[QA_KEY]);
}

async function store(next: QaConfig): Promise<QaConfig> {
  const { key: _k, model: _m, base: _b, ...rest } = next;
  const out = normalizeQa(rest);
  await chrome.storage.local.set({ [QA_KEY]: out });
  return out;
}

/** Chooses the provider (one set up, Chrome's AI, or none). */
export async function chooseProvider(provider: AiProviderId): Promise<QaConfig> {
  return store({ ...(await loadQa()), provider });
}

/** Sets up a provider (its key, model, address) — and chooses it when `use`. */
export async function saveAccount(id: RemoteId, patch: Partial<AiAccount>, use = true): Promise<QaConfig> {
  const qa = await loadQa();
  const before = qa.accounts[id] ?? { key: '', model: '' };
  const merged: AiAccount = { ...before, ...patch };
  if (!merged.base) delete merged.base;
  return store({ ...qa, accounts: { ...qa.accounts, [id]: merged }, provider: use ? id : qa.provider });
}

/** Forgets a provider's key (Chrome's AI takes over if it was the one chosen). */
export async function removeAccount(id: RemoteId): Promise<QaConfig> {
  const qa = await loadQa();
  const { [id]: _gone, ...accounts } = qa.accounts;
  return store({ ...qa, accounts, provider: qa.provider === id ? 'chrome' : qa.provider });
}
