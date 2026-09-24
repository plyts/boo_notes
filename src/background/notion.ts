import { countNotes, linkedTitles, normalizeTitle } from '../shared/markdown';
import type { NotionStatus } from '../shared/messages';
import { explainNotionError, NotionError, type NotionClientOptions } from '../shared/notion/client';
import { NotionEngine, type NotionLink, type NotionSource, type SyncItem } from '../shared/notion/engine';
import { positionLabel, progressRatio, studyStatus } from '../shared/study';
import type { MediaProgress, Note, NoteStore, StorageAreaLike } from '../shared/store';
import { TranscriptStore } from '../shared/transcript-store';

/**
 * Direct Notion sync from the browser, for when the desktop app is closed
 * (or not installed): the same engine as the desktop app, over the notes of
 * chrome.storage. The connection is either shared by the desktop app
 * (`notion.config`) or set in the options page.
 *
 *   notion:config        → NotionConfig
 *   notion:link:<noteId> → NotionLink (page of the note, blocks written)
 *   notion:pending       → { [noteId]: { kind: 'content' | 'progress', at } } notes to write
 *   notion:state         → { lastSyncAt, lastError }
 */
export interface NotionConfig {
  token: string;
  databaseId: string | null;
  databaseUrl: string | null;
  /** Page holding the database (inline table). */
  parentId: string | null;
  workspace: string | null;
  origin: 'desktop' | 'extension';
  apiBase?: string;
}

/** Connection shared by the desktop app (`notion.config` message). */
export interface SharedNotionConfig {
  token: string;
  databaseId: string;
  databaseUrl?: string | null;
  parentId?: string | null;
  workspace?: string | null;
  apiBase?: string;
}

type PendingKind = 'content' | 'progress';
/** `at`: when it was queued, so a change made during its sync is not dropped. */
type Pending = Record<string, { kind: PendingKind; at: number }>;

const CONFIG_KEY = 'notion:config';
const PENDING_KEY = 'notion:pending';
const STATE_KEY = 'notion:state';
const LINK_PREFIX = 'notion:link:';
const linkKey = (id: string) => `${LINK_PREFIX}${id}`;

let lastStamp = 0;
/** Strictly increasing time stamp. */
function stamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Base64 data URL → bytes. */
function dataUrlBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A note of the extension as the Notion engine sees it. */
export function noteToSyncItem(note: Note, progress: MediaProgress | null): SyncItem {
  const kind = note.kind ?? 'video';
  const noteCount = countNotes(note.markdown);
  const shape = { kind, progress: progress ?? undefined, noteCount, size: note.markdown.trim().length };
  return {
    id: note.id,
    kind,
    platform: note.platform,
    title: note.title,
    source: note.url,
    rev: note.rev,
    updatedAt: note.updatedAt,
    status: studyStatus(shape),
    ratio: progressRatio(shape),
    position: positionLabel(shape),
    noteCount,
    nextReview: null,
    body: note.markdown,
    links: linkedTitles(note.markdown),
    // Filed in the panel: « Cours » and « Chapitre » columns (cleared when unfiled).
    ...(note.placedAt ? { course: note.course ?? null, chapter: note.chapter ?? null } : {}),
  };
}

export interface ExtensionNotionOptions {
  area: StorageAreaLike;
  store: NoteStore;
  /** True while the desktop app is connected and writes to Notion itself. */
  desktopHandlesNotion(): boolean;
  /** A note got (or changed) its Notion page: the desktop app should learn the mapping. */
  onLinked?(noteId: string): void;
  onStatus?(status: NotionStatus): void;
  /** Delay before writing a changed note (ms). */
  debounceMs?: number;
  clientOptions?: Partial<NotionClientOptions>;
}

export class ExtensionNotion {
  readonly engine: NotionEngine;
  private config: NotionConfig | null = null;
  private loaded: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private syncing = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Test hook: Notion API of the E2E mock. */
  apiBase: string | undefined;

  constructor(private readonly opts: ExtensionNotionOptions) {
    this.engine = new NotionEngine({
      source: this.source(),
      getConfig: () => ({
        token: this.config?.token ?? '',
        parentId: this.config?.parentId ?? null,
        databaseId: this.config?.databaseId ?? null,
        apiBase: this.config?.apiBase ?? this.apiBase,
      }),
      saveDatabase: async (databaseId, url) => {
        if (!this.config) return;
        this.config = { ...this.config, databaseId, databaseUrl: url ?? this.config.databaseUrl };
        await this.opts.area.set({ [CONFIG_KEY]: this.config });
      },
      clientOptions: opts.clientOptions,
      // A linked note got its page: its content follows.
      onPageCreated: (id) => void this.enqueue(id),
    });
  }

  /** Serialises the read-modify-write of the pending list. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private load(): Promise<void> {
    this.loaded ??= this.opts.area.get(CONFIG_KEY).then((res) => {
      this.config = (res[CONFIG_KEY] as NotionConfig | undefined) ?? null;
    });
    return this.loaded;
  }

  private source(): NotionSource {
    const { area, store } = this.opts;
    return {
      item: async (id) => {
        const note = await store.getNote(id);
        if (!note) return null;
        const transcript = await new TranscriptStore(area).get(id);
        return { ...noteToSyncItem(note, await store.getProgress(id)), transcript };
      },
      getLink: (id) => this.link(id),
      setLink: async (id, link) => {
        if (link) await area.set({ [linkKey(id)]: link });
        else await area.remove(linkKey(id));
      },
      resolveTitle: async (title) => this.findByTitle(title),
      readAsset: async (path) => {
        if (path.startsWith('source:')) return null;
        const asset = await store.getAsset(path);
        return asset ? dataUrlBytes(asset.dataUrl) : null;
      },
      clearLinks: () => this.clearLinks(),
    };
  }

  /** Note id of a `[[Titre]]` among the notes of the extension. */
  async findByTitle(title: string): Promise<string | null> {
    const key = normalizeTitle(title);
    if (!key) return null;
    const index = await this.opts.store.listNotes();
    const hit = Object.entries(index).find(([, s]) => normalizeTitle(s.title) === key);
    return hit?.[0] ?? null;
  }

  async link(id: string): Promise<NotionLink | undefined> {
    return (await this.opts.area.get(linkKey(id)))[linkKey(id)] as NotionLink | undefined;
  }

  private async clearLinks(): Promise<void> {
    const all = await this.opts.area.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(LINK_PREFIX));
    if (keys.length) await this.opts.area.remove(keys);
    this.engine.reset();
  }

  async isConfigured(): Promise<boolean> {
    await this.load();
    return Boolean(this.config?.token && (this.config.databaseId || this.config.parentId));
  }

  async status(): Promise<NotionStatus> {
    await this.load();
    const res = await this.opts.area.get([PENDING_KEY, STATE_KEY]);
    const state = (res[STATE_KEY] as { lastSyncAt?: number; lastError?: string | null } | undefined) ?? {};
    return {
      configured: await this.isConfigured(),
      origin: this.config?.origin ?? null,
      workspace: this.config?.workspace ?? null,
      databaseUrl: this.config?.databaseUrl ?? null,
      pending: Object.keys((res[PENDING_KEY] as Pending | undefined) ?? {}).length,
      syncing: this.syncing,
      lastSyncAt: state.lastSyncAt ?? null,
      lastError: state.lastError ?? null,
    };
  }

  private async emit(): Promise<void> {
    if (this.opts.onStatus) this.opts.onStatus(await this.status());
  }

  private async setState(patch: { lastSyncAt?: number; lastError?: string | null }): Promise<void> {
    const res = await this.opts.area.get(STATE_KEY);
    const state = (res[STATE_KEY] as Record<string, unknown> | undefined) ?? {};
    await this.opts.area.set({ [STATE_KEY]: { ...state, ...patch } });
  }

  // --- Connection ---------------------------------------------------------------------------------

  /** Options page: an integration secret and the page that will hold the notes table. */
  async connect(token: string, target: string): Promise<NotionStatus> {
    await this.load();
    const previous = this.config;
    this.config = {
      token: token.trim(),
      databaseId: null,
      databaseUrl: null,
      parentId: null,
      workspace: null,
      origin: 'extension',
      ...(this.apiBase ? { apiBase: this.apiBase } : {}),
    };
    this.engine.reset();
    try {
      const res = await this.engine.connect(token, target);
      this.config = { ...this.config, databaseId: res.databaseId, databaseUrl: res.url, parentId: res.parentId, workspace: res.workspace };
    } catch (e) {
      this.config = previous;
      this.engine.reset();
      throw e;
    }
    if (previous?.databaseId !== this.config.databaseId) await this.clearLinks();
    await this.opts.area.set({ [CONFIG_KEY]: this.config });
    await this.setState({ lastError: null });
    await this.emit();
    return this.status();
  }

  async disconnect(): Promise<NotionStatus> {
    await this.load();
    this.config = null;
    this.engine.reset();
    await this.opts.area.remove([CONFIG_KEY, PENDING_KEY, STATE_KEY]);
    await this.emit();
    return this.status();
  }

  /** Connection shared by the desktop app (null: not shared, or Notion disconnected there). */
  async applyDesktopConfig(shared: SharedNotionConfig | null): Promise<void> {
    await this.load();
    if (!shared) {
      // A connection set in the options stays; one received from the app follows the app.
      if (this.config?.origin === 'desktop') {
        this.config = null;
        this.engine.reset();
        await this.opts.area.remove(CONFIG_KEY);
        await this.emit();
      }
      return;
    }
    const next: NotionConfig = {
      token: shared.token,
      databaseId: shared.databaseId,
      databaseUrl: shared.databaseUrl ?? null,
      parentId: shared.parentId ?? null,
      workspace: shared.workspace ?? null,
      origin: 'desktop',
      ...(shared.apiBase ? { apiBase: shared.apiBase } : {}),
    };
    const same =
      this.config &&
      this.config.token === next.token &&
      this.config.databaseId === next.databaseId &&
      this.config.databaseUrl === next.databaseUrl &&
      this.config.origin === next.origin;
    if (same) return;
    if (this.config?.databaseId && this.config.databaseId !== next.databaseId) await this.clearLinks();
    this.config = next;
    this.engine.reset();
    await this.opts.area.set({ [CONFIG_KEY]: next });
    await this.emit();
  }

  /** Mapping of a note synced by the desktop app: the newest one wins. */
  async applyDesktopLink(noteId: string, link: NotionLink): Promise<void> {
    if (!link?.pageId || !Array.isArray(link.blocks)) return;
    const current = await this.link(noteId);
    if (current && current.syncedAt >= link.syncedAt) return;
    await this.opts.area.set({ [linkKey(noteId)]: link });
  }

  // --- Sync ---------------------------------------------------------------------------------------

  /** A note changed: written to Notion after a short delay, unless the desktop app does it. */
  async enqueue(noteId: string, kind: PendingKind = 'content'): Promise<void> {
    if (!(await this.isConfigured())) return;
    const added = await this.exclusive(async () => {
      const res = await this.opts.area.get(PENDING_KEY);
      const pending = (res[PENDING_KEY] as Pending | undefined) ?? {};
      const kept = pending[noteId]?.kind === 'content' ? 'content' : kind;
      pending[noteId] = { kind: kept, at: stamp() };
      await this.opts.area.set({ [PENDING_KEY]: pending });
      return true;
    });
    if (!added) return;
    this.schedule();
    await this.emit();
  }

  async hasPending(): Promise<boolean> {
    const res = await this.opts.area.get(PENDING_KEY);
    return Object.keys((res[PENDING_KEY] as Pending | undefined) ?? {}).length > 0;
  }

  schedule(delay = this.opts.debounceMs ?? 5000): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Writes the pending notes (one flush at a time). */
  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (!(await this.isConfigured())) return;
    const res = await this.opts.area.get(PENDING_KEY);
    const pending = { ...((res[PENDING_KEY] as Pending | undefined) ?? {}) };
    const ids = Object.keys(pending);
    if (!ids.length) return;
    if (this.opts.desktopHandlesNotion()) {
      // The app received the notes and writes them itself.
      await this.exclusive(() => this.opts.area.remove(PENDING_KEY));
      await this.emit();
      return;
    }
    this.syncing = true;
    await this.emit();
    try {
      for (const id of ids) {
        try {
          if (pending[id].kind === 'progress' && (await this.link(id))) await this.engine.syncProperties(id);
          else await this.engine.syncItem(id);
          await this.done(id, pending[id].at);
          await this.setState({ lastSyncAt: Date.now(), lastError: null });
          this.opts.onLinked?.(id);
        } catch (e) {
          await this.setState({ lastError: explainNotionError(e) });
          // Bad secret, page no longer shared…: the others would fail the same way.
          if (e instanceof NotionError && (e.status === 401 || e.status === 403)) break;
          if (!(e instanceof NotionError)) break; // Offline.
        }
      }
    } finally {
      this.syncing = false;
      await this.emit();
    }
  }

  /** Drops a pending entry, unless the note changed again meanwhile (`at`: queued before the sync). */
  private done(id: string, at: number): Promise<void> {
    return this.exclusive(async () => {
      const res = await this.opts.area.get(PENDING_KEY);
      const pending = (res[PENDING_KEY] as Pending | undefined) ?? {};
      if (!pending[id] || pending[id].at > at) return;
      delete pending[id];
      await this.opts.area.set({ [PENDING_KEY]: pending });
    });
  }

  /** "Envoyer vers Notion", now. */
  async syncNow(noteId: string): Promise<{ url: string | null }> {
    if (!(await this.isConfigured())) throw new Error('Notion n’est pas connecté (réglages de l’extension ou app Desktop)');
    this.syncing = true;
    await this.emit();
    const started = stamp();
    try {
      const res = await this.engine.syncItem(noteId);
      await this.done(noteId, started);
      await this.setState({ lastSyncAt: Date.now(), lastError: null });
      this.opts.onLinked?.(noteId);
      return { url: res.url };
    } catch (e) {
      const message = explainNotionError(e);
      await this.setState({ lastError: message });
      throw new Error(message);
    } finally {
      this.syncing = false;
      await this.emit();
    }
  }

  async syncAll(): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    for (const id of Object.keys(await this.opts.store.listNotes())) {
      try {
        await this.syncNow(id);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  /** Notion page of a note known only by its title (a revision sheet of the desktop app). */
  async pageUrlByTitle(title: string): Promise<string | null> {
    if (!(await this.isConfigured())) return null;
    const id = await this.findByTitle(title);
    if (id) {
      const link = await this.link(id);
      if (link?.url) return link.url;
    }
    const client = this.engine.client();
    const databaseId = await this.engine.ensureDatabase(client);
    const res = await client.queryDatabase(databaseId, { filter: { property: 'Nom', title: { equals: title.trim() } }, page_size: 1 });
    const page = res.results.find((p) => !p.archived && !p.in_trash);
    return page?.url ?? null;
  }
}
