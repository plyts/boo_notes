import type { StorageAreaLike } from './store';
import {
  addCoverage,
  annotateCues,
  carryAnnotations,
  emptyTranscript,
  mergeCues,
  sortCues,
  SOURCE_RANK,
  type Cue,
  type CuePatch,
  type Transcript,
  type TranscriptSource,
} from './transcript';

export type { CuePatch };

/**
 * Transcripts in chrome.storage.local, next to the notes:
 *
 *   transcript:<noteId>  → Transcript
 *   sync:transcripts     → { [noteId]: rev }  transcripts waiting for the desktop app
 */
const transcriptKey = (id: string) => `transcript:${id}`;
const OUTBOX = 'sync:transcripts';

/** What the page knows about the subtitles it collects. */
export interface TranscriptInfo {
  lang: string;
  label: string;
  source: TranscriptSource;
  complete: boolean;
  duration: number;
  /** Stretch of the media just watched with captions shown (live capture). */
  covered?: [number, number];
}

export class TranscriptStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageAreaLike) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(noteId: string): Promise<Transcript | null> {
    const res = await this.area.get(transcriptKey(noteId));
    return (res[transcriptKey(noteId)] as Transcript | undefined) ?? null;
  }

  /**
   * Cues collected by the page. `replace`: the whole list of a subtitles file
   * (else new or updated cues of a live capture). A weaker source never
   * overwrites a better one; a better one takes over, keeping the user's
   * translations and comments.
   */
  put(noteId: string, info: TranscriptInfo, incoming: Cue[], replace: boolean): Promise<Transcript> {
    return this.exclusive(async () => {
      const prev = await this.get(noteId);
      let t = prev ?? emptyTranscript(noteId, { lang: info.lang, label: info.label, source: info.source });
      const rank = SOURCE_RANK[info.source];
      const prevRank = prev?.cues.length ? SOURCE_RANK[prev.source] : -1;
      if (rank < prevRank) {
        // A live capture while a subtitles file is known: only the duration may help.
        if (!info.duration || t.duration) return t;
        t = { ...t, duration: info.duration };
      } else {
        // A whole list replaces the cues (translations and comments carried over); a live capture adds to them.
        const cues = replace ? carryAnnotations(t.cues, sortCues(incoming.map((c) => ({ ...c })))) : mergeCues(t.cues, incoming);
        t = {
          ...t,
          lang: info.lang || t.lang,
          label: info.label || t.label,
          source: info.source,
          complete: info.complete,
          duration: info.duration || t.duration,
          covered: info.covered ? addCoverage(t.covered, info.covered[0], info.covered[1]) : t.covered,
          cues,
        };
      }
      return this.write(t);
    });
  }

  /** Translations and comments typed by the user (or the translator), and the languages. */
  annotate(noteId: string, patches: CuePatch[], langs: { lang?: string; target?: string } = {}): Promise<Transcript | null> {
    return this.exclusive(async () => {
      const prev = await this.get(noteId);
      if (!prev) return null;
      const cues = annotateCues(prev.cues, patches);
      return this.write({ ...prev, cues, lang: langs.lang ?? prev.lang, target: langs.target ?? prev.target });
    });
  }

  /** Stored as is (received from the desktop app, or a subtitles file). */
  replace(t: Transcript, queue = true): Promise<Transcript> {
    return this.exclusive(async () => (queue ? this.write(t) : (await this.area.set({ [transcriptKey(t.noteId)]: t }), t)));
  }

  private async write(t: Transcript): Promise<Transcript> {
    const next: Transcript = { ...t, updatedAt: Date.now(), rev: t.rev + 1 };
    const res = await this.area.get(OUTBOX);
    const outbox = (res[OUTBOX] as Record<string, number> | undefined) ?? {};
    outbox[t.noteId] = next.rev;
    await this.area.set({ [transcriptKey(t.noteId)]: next, [OUTBOX]: outbox });
    return next;
  }

  async getOutbox(): Promise<Record<string, number>> {
    const res = await this.area.get(OUTBOX);
    return (res[OUTBOX] as Record<string, number> | undefined) ?? {};
  }

  markSynced(noteId: string, rev: number): Promise<void> {
    return this.exclusive(async () => {
      const outbox = await this.getOutbox();
      if (outbox[noteId] !== undefined && outbox[noteId] <= rev) {
        delete outbox[noteId];
        await this.area.set({ [OUTBOX]: outbox });
      }
    });
  }

  requeueAll(): Promise<void> {
    return this.exclusive(async () => {
      const all = await this.area.get(null);
      const outbox = await this.getOutbox();
      for (const key of Object.keys(all)) if (key.startsWith('transcript:')) outbox[key.slice(11)] ??= 0;
      await this.area.set({ [OUTBOX]: outbox });
    });
  }

  remove(noteId: string): Promise<void> {
    return this.exclusive(() => this.area.remove(transcriptKey(noteId)));
  }
}
