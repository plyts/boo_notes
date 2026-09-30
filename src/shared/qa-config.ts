/**
 * How the questions of the notes are answered (options › Questions): by
 * Chrome's built-in AI (on the device, the default), by Claude with the
 * user's own API key, or without AI (the closest passages of the course).
 * Kept in `chrome.storage.local`: the key never leaves this browser (not
 * synced with the Google account).
 */

export const QA_KEY = 'qa:config';

export interface QaConfig {
  /**
   * `chrome`: Chrome's built-in AI when this computer has it (else the
   * closest passages); `claude`: Claude (key and model needed); `none`: the
   * closest passages, no AI.
   */
  provider: 'chrome' | 'claude' | 'none';
  key: string;
  model: string;
  /** Tests / proxy: another address for the API. */
  base?: string;
}

export const DEFAULT_QA: QaConfig = { provider: 'chrome', key: '', model: '' };

export function normalizeQa(raw: unknown): QaConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const key = str(r.key);
  const model = str(r.model);
  const base = str(r.base);
  // Claude without its key falls back to the default (as the former « extracts »).
  const provider = r.provider === 'claude' && key && model ? 'claude' : r.provider === 'none' ? 'none' : 'chrome';
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
