/**
 * The AIs that can write the answers to the questions and the summaries of
 * the courses: Chrome's built-in AI (on this computer), Claude (a paid key),
 * the free tiers of Groq, OpenRouter, Google Gemini, Mistral and Cerebras
 * (a free key), Ollama (on this computer), or any service speaking the
 * OpenAI « chat completions » API at an address of one's own.
 *
 * Each says how much transcript one request may carry (`budget`, in
 * characters: what its free tier takes in one go) and how long to leave
 * between two requests (`gapMs`: its free tier's requests per minute).
 */

export type AiProviderId = 'chrome' | 'claude' | 'groq' | 'openrouter' | 'gemini' | 'mistral' | 'cerebras' | 'ollama' | 'custom' | 'none';
/** The providers reached over the network (a key, an address). */
export type RemoteId = Exclude<AiProviderId, 'chrome' | 'none'>;

export interface ProviderInfo {
  id: RemoteId;
  label: string;
  /** `anthropic`: the Messages API; `openai`: chat completions (`/chat/completions`, `/models`). */
  api: 'anthropic' | 'openai';
  /** Address of the API (OpenAI-compatible: up to its version, `…/v1`). Empty: given by the user. */
  base: string;
  key: 'required' | 'optional' | 'none';
  /** `free`: a free tier with a key; `local`: on this computer; `paid`; `custom`: an address of one's own. */
  tier: 'free' | 'local' | 'paid' | 'custom';
  /** What its free tier gives, said in the options. */
  terms: string;
  /** Where to get a key (or the software). */
  keyUrl?: string;
  keyHint?: string;
  /** Models to choose first, the default first (when the service lists them). */
  models: readonly string[];
  /** Only these models are offered: `free` = OpenRouter's « :free » ones. */
  only?: 'free';
  /** Characters of transcript in one request. */
  budget: number;
  /** Pause between two requests (ms). */
  gapMs: number;
}

export const PROVIDERS: Readonly<Record<RemoteId, ProviderInfo>> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    api: 'openai',
    base: 'https://api.groq.com/openai/v1',
    key: 'required',
    tier: 'free',
    terms: 'Gratuit avec une clé : environ 30 requêtes par minute et quelques milliers de jetons par minute — les longues vidéos sont lues par parties.',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
    budget: 18_000,
    gapMs: 2_100,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    api: 'openai',
    base: 'https://openrouter.ai/api/v1',
    key: 'required',
    tier: 'free',
    terms: 'Les modèles « :free » sont gratuits : 20 requêtes par minute, 50 par jour (1 000 avec 10 $ de crédit).',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyHint: 'sk-or-…',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-chat-v3-0324:free', 'google/gemma-3-27b-it:free'],
    only: 'free',
    budget: 60_000,
    gapMs: 3_100,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    api: 'openai',
    base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: 'required',
    tier: 'free',
    terms: 'Palier gratuit de Google AI Studio : une dizaine de requêtes par minute, et un très grand contexte — un cours entier lu d’un coup.',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'AIza…',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
    budget: 400_000,
    gapMs: 6_500,
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    api: 'openai',
    base: 'https://api.mistral.ai/v1',
    key: 'required',
    tier: 'free',
    terms: 'Offre « Experiment » gratuite (une requête par seconde) ; modèles européens, bons en français.',
    keyUrl: 'https://console.mistral.ai/api-keys',
    models: ['mistral-small-latest', 'mistral-medium-latest', 'open-mistral-nemo'],
    budget: 80_000,
    gapMs: 1_200,
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    api: 'openai',
    base: 'https://api.cerebras.ai/v1',
    key: 'required',
    tier: 'free',
    terms: 'Gratuit avec une clé : très rapide, 30 requêtes par minute, contexte réduit — lu par parties.',
    keyUrl: 'https://cloud.cerebras.ai/',
    keyHint: 'csk-…',
    models: ['llama-3.3-70b', 'gpt-oss-120b', 'qwen-3-32b'],
    budget: 16_000,
    gapMs: 2_100,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (sur cet ordinateur)',
    api: 'openai',
    base: 'http://localhost:11434/v1',
    key: 'none',
    tier: 'local',
    terms: 'Gratuit et hors ligne : un modèle installé avec Ollama sur cet ordinateur. Si Ollama refuse l’extension, lancez-le avec OLLAMA_ORIGINS=chrome-extension://*.',
    keyUrl: 'https://ollama.com/download',
    models: ['llama3.1', 'qwen2.5', 'mistral'],
    budget: 12_000,
    gapMs: 0,
  },
  custom: {
    id: 'custom',
    label: 'Compatible OpenAI',
    api: 'openai',
    base: '',
    key: 'optional',
    tier: 'custom',
    terms: 'Tout service qui parle l’API OpenAI (« chat completions ») : LM Studio, DeepSeek, GitHub Models, Together… à son adresse.',
    models: [],
    budget: 24_000,
    gapMs: 0,
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    api: 'anthropic',
    base: 'https://api.anthropic.com',
    key: 'required',
    tier: 'paid',
    terms: 'Payant à l’usage, sur votre compte Anthropic ; lit un cours entier d’un coup.',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'sk-ant-…',
    models: [],
    budget: 300_000,
    gapMs: 0,
  },
};

/** In the order the options show them: free first, then on this computer, then paid and one's own. */
export const REMOTE_IDS: readonly RemoteId[] = ['groq', 'openrouter', 'gemini', 'mistral', 'cerebras', 'ollama', 'claude', 'custom'];

export function isRemote(id: unknown): id is RemoteId {
  return typeof id === 'string' && id in PROVIDERS;
}

export function providerLabel(id: AiProviderId): string {
  if (id === 'chrome') return 'IA de Chrome';
  if (id === 'none') return 'Sans IA';
  return PROVIDERS[id].label;
}

/** The origin a provider is reached at (`https://api.groq.com/*`), for the host permission. */
export function originPattern(base: string): string | null {
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
