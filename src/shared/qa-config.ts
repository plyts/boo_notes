/**
 * How the questions of the notes are answered (options › Questions): by
 * Claude with the user's own API key, or without AI (the closest passages of
 * the course). Kept in `chrome.storage.local`: the key never leaves this
 * browser (not synced with the Google account).
 */

export const QA_KEY = 'qa:config';

export interface QaConfig {
  /** `claude`: an answer written by Claude (key and model needed); `extracts`: the closest passages, no AI. */
  provider: 'claude' | 'extracts';
  key: string;
  model: string;
  /** Tests / proxy: another address for the API. */
  base?: string;
}

export const DEFAULT_QA: QaConfig = { provider: 'extracts', key: '', model: '' };

export function normalizeQa(raw: unknown): QaConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const key = str(r.key);
  const model = str(r.model);
  const base = str(r.base);
  const provider = r.provider === 'claude' && key && model ? 'claude' : 'extracts';
  return { provider, key, model, ...(base ? { base } : {}) };
}

export async function loadQa(): Promise<QaConfig> {
  const res = await chrome.storage.local.get(QA_KEY);
  return normalizeQa(res[QA_KEY]);
}

export async function saveQa(patch: Partial<QaConfig>): Promise<QaConfig> {
  const next = normalizeQa({ ...(await loadQa()), ...patch });
  await chrome.storage.local.set({ [QA_KEY]: next });
  return next;
}
