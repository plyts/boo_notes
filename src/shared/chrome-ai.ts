/**
 * Chrome's built-in AI (Gemini Nano, the Prompt API — `LanguageModel`, Chrome
 * 138+ in extensions): on the device, free, nothing sent anywhere. The model
 * is downloaded once by Chrome (options › Questions), on the computers that
 * can run it.
 */

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface ModelOptions {
  expectedInputs?: Array<{ type: 'text'; languages?: string[] }>;
  expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
  initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  monitor?(m: EventTarget): void;
  signal?: AbortSignal;
}

interface Session {
  prompt(input: string, options?: { responseConstraint?: object; signal?: AbortSignal }): Promise<string>;
  measureInputUsage?(input: string): Promise<number>;
  inputQuota?: number;
  inputUsage?: number;
  destroy(): void;
}

interface LanguageModelStatic {
  availability(options?: ModelOptions): Promise<Availability>;
  create(options?: ModelOptions): Promise<Session>;
}

const api = (): LanguageModelStatic | undefined => (globalThis as { LanguageModel?: LanguageModelStatic }).LanguageModel;

/** The language the model writes in: French when Chrome offers it, else English (translated afterwards). */
export type AiLang = 'fr' | 'en';

const optionsFor = (lang: AiLang): ModelOptions => ({
  expectedInputs: [{ type: 'text', languages: lang === 'fr' ? ['en', 'fr'] : ['en'] }],
  expectedOutputs: [{ type: 'text', languages: [lang] }],
});

export interface ChromeAiState {
  /** `unsupported`: this Chrome has no built-in AI (too old, or not in this context). */
  state: 'unsupported' | Availability;
  lang: AiLang | null;
}

/** Whether the model can answer here, and in which language. */
export async function chromeAiState(): Promise<ChromeAiState> {
  const lm = api();
  if (!lm) return { state: 'unsupported', lang: null };
  let fallback: ChromeAiState = { state: 'unavailable', lang: null };
  for (const lang of ['fr', 'en'] as const) {
    try {
      const state = await lm.availability(optionsFor(lang));
      if (state === 'available') return { state, lang };
      if (state !== 'unavailable' && fallback.state === 'unavailable') fallback = { state, lang };
    } catch {
      // This language is not supported: the next one.
    }
  }
  return fallback;
}

/**
 * Downloads the model (from a click: Chrome asks for a user gesture), with
 * its progress (0..1).
 */
export async function downloadChromeAi(lang: AiLang, onProgress: (ratio: number) => void): Promise<void> {
  const lm = api();
  if (!lm) throw new Error('l’IA intégrée n’existe pas dans ce navigateur (Chrome 138 ou plus récent)');
  const session = await lm.create({
    ...optionsFor(lang),
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onProgress((e as Event & { loaded?: number }).loaded ?? 0));
    },
  });
  session.destroy();
}

/** The answer's shape: the model writes nothing else. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    found: { type: 'boolean' },
    sources: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, quote: { type: 'string' } }, required: ['id', 'quote'] },
    },
  },
  required: ['answer', 'found', 'sources'],
};

export interface ChromeAiPrompt {
  system: string;
  /** Builds the request from as many characters of course as the model can take. */
  user(budget: number): string;
}

/** One question to the model: its reply (JSON, see ANSWER_SCHEMA). */
export function askChromeAi(lang: AiLang, prompt: ChromeAiPrompt, signal?: AbortSignal): Promise<string> {
  return promptChromeAi(lang, prompt, ANSWER_SCHEMA, signal);
}

/**
 * One request to the model, its reply shaped by `schema` (JSON). `prompt.user`
 * is built from as many characters as it can read (about 3 a token).
 */
export async function promptChromeAi(lang: AiLang, prompt: ChromeAiPrompt, schema: object, signal?: AbortSignal): Promise<string> {
  const lm = api();
  if (!lm) throw new Error('l’IA intégrée n’existe pas dans ce navigateur');
  const session = await lm.create({ ...optionsFor(lang), initialPrompts: [{ role: 'system', content: prompt.system }], signal });
  try {
    const room = session.inputQuota ? Math.max(1500, (session.inputQuota - (session.inputUsage ?? 0) - 700) * 3) : 12_000;
    let user = prompt.user(Math.min(room, 24_000));
    if (session.measureInputUsage && session.inputQuota) {
      for (let budget = Math.min(room, 24_000); budget > 1500; budget = Math.floor(budget * 0.7)) {
        user = prompt.user(budget);
        if ((await session.measureInputUsage(user)) + (session.inputUsage ?? 0) < session.inputQuota - 400) break;
      }
    }
    return await session.prompt(user, { responseConstraint: schema, signal });
  } finally {
    session.destroy();
  }
}

/**
 * How many characters of text the model reads in one request, its
 * instructions (`system`) and its reply left aside.
 */
export async function chromeAiRoom(lang: AiLang, system: string, reply = 1500): Promise<number> {
  const lm = api();
  if (!lm) throw new Error('l’IA intégrée n’existe pas dans ce navigateur');
  const session = await lm.create({ ...optionsFor(lang), initialPrompts: [{ role: 'system', content: system }] });
  try {
    if (!session.inputQuota) return 9_000;
    return Math.max(2_500, Math.min(24_000, (session.inputQuota - (session.inputUsage ?? 0) - reply) * 3));
  } finally {
    session.destroy();
  }
}

interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?(m: EventTarget): void }): Promise<{ translate(s: string): Promise<string>; destroy?(): void }>;
}

const translatorApi = (): TranslatorStatic | undefined => (globalThis as { Translator?: TranslatorStatic }).Translator;
const PAIRS = [
  { sourceLanguage: 'en', targetLanguage: 'fr' },
  { sourceLanguage: 'fr', targetLanguage: 'en' },
];

/** The model writes English: whether Chrome's translator (English ⇄ French) is ready to put its answers in French. */
export async function frenchReady(): Promise<boolean> {
  const t = translatorApi();
  if (!t) return false;
  try {
    return (await t.availability(PAIRS[0])) === 'available';
  } catch {
    return false;
  }
}

/**
 * Downloads what is missing for answers in French: the model, and the
 * translator English ⇄ French when the model writes English. Started from
 * one click (Chrome asks for a user gesture): everything at once.
 */
export async function prepareChromeAi(lang: AiLang, onProgress: (ratio: number) => void): Promise<void> {
  const parts: Array<Promise<unknown>> = [];
  const shares: number[] = [];
  const report = (i: number) => (ratio: number) => {
    shares[i] = ratio;
    onProgress(shares.reduce((a, b) => a + b, 0) / shares.length);
  };
  shares.push(0);
  parts.push(downloadChromeAi(lang, report(0)));
  const t = translatorApi();
  if (lang === 'en' && t) {
    for (const pair of PAIRS) {
      const i = shares.push(0) - 1;
      parts.push(
        t
          .availability(pair)
          .then((state) =>
            state === 'available' || state === 'unavailable'
              ? report(i)(1)
              : t.create({ ...pair, monitor: (m) => m.addEventListener('downloadprogress', (e) => report(i)((e as Event & { loaded?: number }).loaded ?? 0)) }).then((x) => x.destroy?.()),
          )
          .catch(() => report(i)(1)),
      );
    }
  }
  await Promise.all(parts);
}

/** A reply written in English, in French with Chrome's translator when it is ready (never downloaded here). */
export async function toFrench(text: string): Promise<string | null> {
  const t = (globalThis as { Translator?: { availability(o: object): Promise<string>; create(o: object): Promise<{ translate(s: string): Promise<string>; destroy?(): void }> } }).Translator;
  if (!t || !text.trim()) return null;
  try {
    if ((await t.availability({ sourceLanguage: 'en', targetLanguage: 'fr' })) !== 'available') return null;
    const tr = await t.create({ sourceLanguage: 'en', targetLanguage: 'fr' });
    const out = await tr.translate(text);
    tr.destroy?.();
    return out;
  } catch {
    return null;
  }
}
