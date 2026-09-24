import type { Cue, Transcript } from '../shared/transcript';
import type { CuePatch } from '../shared/transcript-store';

/**
 * On-device translation of the subtitles, cue by cue as they arrive, with
 * Chrome's built-in Translator and LanguageDetector (Chrome 138+): nothing is
 * sent to a third-party service. Without them, the user translates by hand.
 */
interface TranslatorLike {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?(m: EventTarget): void;
  }): Promise<TranslatorLike>;
}

interface DetectorStatic {
  create(): Promise<{ detect(text: string): Promise<Array<{ detectedLanguage: string; confidence: number }>> }>;
}

export type TranslateStatus =
  | { state: 'off' }
  | { state: 'unsupported' }
  | { state: 'unavailable'; pair: string }
  | { state: 'same' }
  | { state: 'detecting' }
  | { state: 'downloading'; progress: number }
  | { state: 'working'; done: number; total: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export interface TranslatorHooks {
  /** Translations to store, and the detected language of the subtitles. */
  patch(patches: CuePatch[], lang?: string): void;
  status(s: TranslateStatus): void;
}

const api = () => (globalThis as { Translator?: TranslatorStatic }).Translator;
const detectorApi = () => (globalThis as { LanguageDetector?: DetectorStatic }).LanguageDetector;

const base = (lang: string) => lang.split('-')[0].toLowerCase();

export class CueTranslator {
  private enabled = false;
  private target = 'fr';
  private translator: TranslatorLike | null = null;
  private pair = '';
  /** Language detected on the device while the store has none yet. */
  private detected = '';
  private transcript: Transcript | null = null;
  private running = false;
  private startAt = 0;
  /** Cues already sent to the translator (never twice, even before the store echoes them). */
  private readonly done = new Set<string>();
  /** Translations written in another language than the one now chosen: translated again. */
  private stale = new Set<string>();
  private status: TranslateStatus = { state: 'off' };

  constructor(private readonly hooks: TranslatorHooks) {}

  static get supported(): boolean {
    return typeof api() !== 'undefined';
  }

  get state(): TranslateStatus {
    return this.status;
  }

  private setStatus(s: TranslateStatus): void {
    this.status = s;
    this.hooks.status(s);
  }

  /** Switched on by the user (a click: model downloads need that gesture). */
  async enable(target: string): Promise<void> {
    if (target !== this.target) this.done.clear();
    this.enabled = true;
    this.target = target;
    this.markStale();
    if (!CueTranslator.supported) {
      this.setStatus({ state: 'unsupported' });
      return;
    }
    await this.prepare();
    this.run();
  }

  disable(): void {
    this.enabled = false;
    this.translator?.destroy?.();
    this.translator = null;
    this.pair = '';
    this.setStatus({ state: 'off' });
  }

  /** New transcript content (another note: `reset`). */
  update(t: Transcript | null, currentTime: number | null, reset = false): void {
    if (reset || t?.noteId !== this.transcript?.noteId) {
      this.done.clear();
      this.detected = '';
      if (this.pair && t && this.pair !== `${t.lang}>${this.target}`) {
        this.translator?.destroy?.();
        this.translator = null;
        this.pair = '';
      }
    }
    const other = t?.noteId !== this.transcript?.noteId;
    this.transcript = t;
    if (other) this.markStale();
    if (currentTime !== null) this.startAt = currentTime;
    if (this.enabled) this.run();
  }

  private markStale(): void {
    const t = this.transcript;
    this.stale = new Set(t && t.target && base(t.target) !== base(this.target) ? t.cues.filter((c) => c.tr).map((c) => c.id) : []);
  }

  private async prepare(): Promise<boolean> {
    const t = this.transcript;
    const T = api();
    if (!t || !T) return false;
    let lang = t.lang || this.detected;
    if (!lang) {
      lang = await this.detect(t.cues);
      if (!lang) {
        this.setStatus({ state: 'unavailable', pair: `?>${this.target}` });
        return false;
      }
      this.detected = lang;
      this.hooks.patch([], lang);
    }
    if (base(lang) === base(this.target)) {
      this.setStatus({ state: 'same' });
      return false;
    }
    const pair = `${lang}>${this.target}`;
    if (this.translator && this.pair === pair) return true;
    try {
      const availability = await T.availability({ sourceLanguage: lang, targetLanguage: this.target });
      if (availability === 'unavailable') {
        this.setStatus({ state: 'unavailable', pair });
        return false;
      }
      if (availability !== 'available') this.setStatus({ state: 'downloading', progress: 0 });
      this.translator = await T.create({
        sourceLanguage: lang,
        targetLanguage: this.target,
        monitor: (m) =>
          m.addEventListener('downloadprogress', (e) => this.setStatus({ state: 'downloading', progress: (e as ProgressEvent).loaded })),
      });
      this.pair = pair;
      this.setStatus({ state: 'ready' });
      return true;
    } catch (e) {
      this.setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  private async detect(cues: Cue[]): Promise<string> {
    const D = detectorApi();
    if (!D || !cues.length) return '';
    this.setStatus({ state: 'detecting' });
    try {
      const detector = await D.create();
      const sample = cues
        .slice(0, 40)
        .map((c) => c.text)
        .join(' ')
        .slice(0, 2000);
      const [best] = await detector.detect(sample);
      return best && best.confidence > 0.5 && best.detectedLanguage !== 'und' ? best.detectedLanguage : '';
    } catch {
      return '';
    }
  }

  /** Translates the cues without translation: from the moment being watched on, then the earlier ones. */
  private run(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      try {
        while (this.enabled) {
          if (!(await this.prepare())) break;
          const t = this.transcript;
          if (!t) break;
          const todo = t.cues.filter((c) => (!c.tr || this.stale.has(c.id)) && !this.done.has(c.id));
          if (!todo.length) {
            this.setStatus({ state: 'ready' });
            break;
          }
          todo.sort((a, b) => Number(a.end < this.startAt) - Number(b.end < this.startAt) || a.start - b.start);
          const batch = todo.slice(0, 12);
          const patches: CuePatch[] = [];
          for (const c of batch) {
            this.done.add(c.id);
            try {
              patches.push({ id: c.id, tr: (await this.translator!.translate(c.text)).trim() });
            } catch {
              // One untranslatable line (too long, odd characters) does not stop the rest.
            }
            if (!this.enabled) break;
          }
          if (patches.length) this.hooks.patch(patches);
          const total = t.cues.length;
          this.setStatus({ state: 'working', done: total - todo.length + batch.length, total });
        }
      } finally {
        this.running = false;
      }
    })();
  }
}
