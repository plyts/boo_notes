import { appendBlock } from './markdown';
import { noteSlug, type MediaKind, type Platform } from './platforms';
import { formatTimecode } from './time';

/**
 * Local-first storage (chrome.storage.local). Notes are always written here
 * first; the desktop sync only mirrors them.
 *
 *   note:<noteId>   → Note
 *   asset:<path>    → AssetRecord (screenshot as data URL)
 *   notes:index     → { [noteId]: NoteSummary }
 *   progress:<id>   → MediaProgress (last playback position, course tracking)
 *   sync:outbox     → { [noteId]: rev }  notes waiting for the desktop app
 *   sync:assets     → { [path]: true }   screenshots already sent
 *   sync:progress   → { [noteId]: true } progress not yet sent to the desktop app
 */
export interface MediaProgress {
  /** Seconds (media) — the desktop app also uses it for PDF pages. */
  position: number;
  duration: number;
  updatedAt: number;
}

export interface Note {
  id: string;
  platform: Platform;
  /** Absent on notes created before audio / PDF support: video. */
  kind?: MediaKind;
  url: string;
  title: string;
  markdown: string;
  createdAt: number;
  updatedAt: number;
  /** Incremented on every save; the desktop app acknowledges by rev. */
  rev: number;
  /** Editor instance that wrote the last revision (to ignore our own echoes). */
  lastWriter?: string;
  /** Filing in the desktop library: course and chapter titles (created there if missing). */
  course?: string;
  chapter?: string;
  /** When the filing last changed (the latest filing wins, app or browser). */
  placedAt?: number;
}

/** A course of the library, as offered to file a note in. */
export interface CourseOption {
  title: string;
  emoji?: string;
  chapters: string[];
}

export interface NoteMeta {
  platform: Platform;
  url: string;
  title: string;
  kind?: MediaKind;
}

export interface NoteSummary extends NoteMeta {
  updatedAt: number;
  progress?: MediaProgress;
  course?: string;
  chapter?: string;
}

export interface AssetRecord {
  path: string;
  noteId: string;
  mime: string;
  dataUrl: string;
  width: number;
  height: number;
  /** Video position of the frame, in seconds. */
  time: number;
  createdAt: number;
}

/** The subset of chrome.storage.StorageArea we rely on (in-memory fake in tests). */
export interface StorageAreaLike {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

const noteKey = (id: string) => `note:${id}`;
const assetKey = (path: string) => `asset:${path}`;
const INDEX = 'notes:index';
const OUTBOX = 'sync:outbox';
const SYNCED_ASSETS = 'sync:assets';
const PENDING_PROGRESS = 'sync:progress';
const progressKey = (id: string) => `progress:${id}`;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export class NoteStore {
  /** Serialises read-modify-write sequences so concurrent saves never lose data. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageAreaLike) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async getNote(id: string): Promise<Note | null> {
    const res = await this.area.get(noteKey(id));
    return (res[noteKey(id)] as Note | undefined) ?? null;
  }

  /** Existing note, or an unsaved blank one carrying the page metadata. */
  async getOrDraft(id: string, meta: NoteMeta): Promise<Note> {
    const existing = await this.getNote(id);
    if (existing) return existing;
    const now = Date.now();
    return { id, ...meta, markdown: '', createdAt: now, updatedAt: now, rev: 0 };
  }

  saveNote(id: string, meta: NoteMeta, markdown: string, writer?: string): Promise<Note> {
    return this.exclusive(() => this.write(id, meta, () => markdown, writer));
  }

  appendToNote(id: string, meta: NoteMeta, block: string, writer?: string): Promise<Note> {
    return this.exclusive(() => this.write(id, meta, (current) => appendBlock(current, block), writer));
  }

  /** Rewrites an existing note (null when there is none, or nothing changed). */
  transformNote(id: string, update: (markdown: string) => string, writer?: string): Promise<Note | null> {
    return this.exclusive(async () => {
      const prev = await this.getNote(id);
      if (!prev || update(prev.markdown) === prev.markdown) return null;
      return this.write(id, { platform: prev.platform, url: prev.url, title: prev.title, kind: prev.kind }, update, writer);
    });
  }

  /** Files the note in a course › chapter (null: unfiled). */
  placeNote(id: string, meta: NoteMeta, place: { course: string; chapter: string } | null): Promise<Note> {
    const course = place?.course.trim().slice(0, 120);
    const chapter = place?.chapter.trim().slice(0, 120);
    if (place && !course) throw new Error('Nom de cours manquant');
    return this.exclusive(() =>
      this.write(id, meta, (current) => current, undefined, {
        course: course || undefined,
        chapter: course ? chapter || 'Chapitre 1' : undefined,
        placedAt: Date.now(),
      }),
    );
  }

  private async write(
    id: string,
    meta: NoteMeta,
    update: (current: string) => string,
    writer?: string,
    patch: Partial<Pick<Note, 'course' | 'chapter' | 'placedAt'>> = {},
  ): Promise<Note> {
    const prev = await this.getOrDraft(id, meta);
    const note: Note = {
      ...prev,
      // Keep a known title if the page could not provide one this time.
      title: meta.title || prev.title,
      url: meta.url || prev.url,
      platform: meta.platform,
      kind: meta.kind ?? prev.kind,
      markdown: update(prev.markdown),
      updatedAt: Date.now(),
      rev: prev.rev + 1,
      lastWriter: writer,
      ...patch,
    };
    if ('course' in patch && patch.course === undefined) {
      delete note.course;
      delete note.chapter;
    }
    const res = await this.area.get([INDEX, OUTBOX]);
    const index = (res[INDEX] as Record<string, NoteSummary> | undefined) ?? {};
    const outbox = (res[OUTBOX] as Record<string, number> | undefined) ?? {};
    index[id] = {
      ...index[id],
      platform: note.platform,
      kind: note.kind,
      url: note.url,
      title: note.title,
      updatedAt: note.updatedAt,
      course: note.course,
      chapter: note.chapter,
    };
    outbox[id] = note.rev;
    await this.area.set({ [noteKey(id)]: note, [INDEX]: index, [OUTBOX]: outbox });
    return note;
  }

  async listNotes(): Promise<Record<string, NoteSummary>> {
    const res = await this.area.get(INDEX);
    return (res[INDEX] as Record<string, NoteSummary> | undefined) ?? {};
  }

  /**
   * Records the playback position of a media that has a note (course
   * tracking). Returns null when there is no note yet: watching alone is
   * never tracked.
   */
  saveProgress(id: string, position: number, duration: number): Promise<MediaProgress | null> {
    return this.exclusive(async () => {
      const res = await this.area.get([INDEX, PENDING_PROGRESS]);
      const index = (res[INDEX] as Record<string, NoteSummary> | undefined) ?? {};
      if (!index[id]) return null;
      const progress: MediaProgress = {
        position: Math.max(0, position),
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        updatedAt: Date.now(),
      };
      index[id] = { ...index[id], progress };
      const pending = (res[PENDING_PROGRESS] as Record<string, true> | undefined) ?? {};
      pending[id] = true;
      await this.area.set({ [progressKey(id)]: progress, [INDEX]: index, [PENDING_PROGRESS]: pending });
      return progress;
    });
  }

  async getProgress(id: string): Promise<MediaProgress | null> {
    const res = await this.area.get(progressKey(id));
    return (res[progressKey(id)] as MediaProgress | undefined) ?? null;
  }

  async pendingProgress(): Promise<string[]> {
    const res = await this.area.get(PENDING_PROGRESS);
    return Object.keys((res[PENDING_PROGRESS] as Record<string, true> | undefined) ?? {});
  }

  clearPendingProgress(id: string): Promise<void> {
    return this.exclusive(async () => {
      const res = await this.area.get(PENDING_PROGRESS);
      const pending = (res[PENDING_PROGRESS] as Record<string, true> | undefined) ?? {};
      if (!pending[id]) return;
      delete pending[id];
      await this.area.set({ [PENDING_PROGRESS]: pending });
    });
  }

  saveAsset(input: Omit<AssetRecord, 'path' | 'createdAt'>): Promise<AssetRecord> {
    return this.exclusive(async () => {
      const ext = EXT[input.mime] ?? 'png';
      const tc = formatTimecode(input.time).replace(/:/g, '-');
      const rand = Math.random().toString(36).slice(2, 6);
      const record: AssetRecord = {
        ...input,
        path: `assets/${noteSlug(input.noteId)}-${tc}-${rand}.${ext}`,
        createdAt: Date.now(),
      };
      await this.area.set({ [assetKey(record.path)]: record });
      return record;
    });
  }

  async getAsset(path: string): Promise<AssetRecord | null> {
    const res = await this.area.get(assetKey(path));
    return (res[assetKey(path)] as AssetRecord | undefined) ?? null;
  }

  // --- Sync bookkeeping -------------------------------------------------

  async getOutbox(): Promise<Record<string, number>> {
    const res = await this.area.get(OUTBOX);
    return (res[OUTBOX] as Record<string, number> | undefined) ?? {};
  }

  /** Drops the entry only if no newer revision was saved in the meantime. */
  markSynced(id: string, rev: number): Promise<void> {
    return this.exclusive(async () => {
      const outbox = await this.getOutbox();
      if (outbox[id] !== undefined && outbox[id] <= rev) {
        delete outbox[id];
        await this.area.set({ [OUTBOX]: outbox });
      }
    });
  }

  /** Sends a note to the desktop app again (its Notion mapping changed). */
  requeue(id: string): Promise<void> {
    return this.exclusive(async () => {
      const note = await this.getNote(id);
      if (!note) return;
      const outbox = await this.getOutbox();
      outbox[id] = Math.max(outbox[id] ?? 0, note.rev);
      await this.area.set({ [OUTBOX]: outbox });
    });
  }

  /** Re-queues every note (e.g. the desktop app asked for a full resync). */
  requeueAll(): Promise<void> {
    return this.exclusive(async () => {
      const index = await this.listNotes();
      const outbox = await this.getOutbox();
      for (const id of Object.keys(index)) outbox[id] ??= 0;
      await this.area.set({ [OUTBOX]: outbox, [SYNCED_ASSETS]: {} });
    });
  }

  async isAssetSynced(path: string): Promise<boolean> {
    const res = await this.area.get(SYNCED_ASSETS);
    return Boolean((res[SYNCED_ASSETS] as Record<string, true> | undefined)?.[path]);
  }

  markAssetSynced(path: string): Promise<void> {
    return this.exclusive(async () => {
      const res = await this.area.get(SYNCED_ASSETS);
      const synced = (res[SYNCED_ASSETS] as Record<string, true> | undefined) ?? {};
      synced[path] = true;
      await this.area.set({ [SYNCED_ASSETS]: synced });
    });
  }

  /** Deletes every note, screenshot and sync marker. */
  clearAll(): Promise<void> {
    return this.exclusive(async () => {
      const all = await this.area.get(null);
      const keys = Object.keys(all).filter(
        (k) =>
          k.startsWith('note:') ||
          k.startsWith('asset:') ||
          k.startsWith('progress:') ||
          k.startsWith('transcript:') ||
          k === 'sync:transcripts' ||
          [INDEX, OUTBOX, SYNCED_ASSETS, PENDING_PROGRESS].includes(k),
      );
      if (keys.length) await this.area.remove(keys);
    });
  }
}
