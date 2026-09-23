import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { explainNotionError } from '../../../../src/shared/notion/client';
import {
  DATABASE_PROPERTIES,
  DATABASE_TITLE,
  NotionEngine,
  pageProperties,
  type NotionSource,
  type SyncItem,
} from '../../../../src/shared/notion/engine';
import type { NotionClientOptions } from '../../../../src/shared/notion/client';
import { positionLabel, progressRatio, studyStatus, type Library } from '../library';
import type { LibraryItem } from '../types';

export { DATABASE_PROPERTIES, DATABASE_TITLE, pageProperties };

export interface NotionConfig {
  token: string;
  /** Page holding the notes database (inline table). */
  parentId: string | null;
  databaseId: string | null;
  autoSync: boolean;
  apiBase?: string;
}

export interface NotionState {
  configured: boolean;
  syncing: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface NotionSyncOptions {
  library: Library;
  getConfig(): NotionConfig;
  /** Persists the database created / adopted by `connect()` or `ensureDatabase()`. */
  saveDatabase(databaseId: string, url: string | null): Promise<void>;
  clientOptions?: Partial<NotionClientOptions>;
  /** Debounce of automatic content syncs (ms). */
  debounceMs?: number;
  /** A note of the extension was synced: its Notion mapping can be sent back to the browser. */
  onSynced?(id: string): void;
  log?(message: string): void;
}

/** A library item as the Notion engine sees it. */
export async function toSyncItem(library: Library, item: LibraryItem): Promise<SyncItem> {
  return {
    id: item.id,
    kind: item.kind,
    platform: item.platform,
    title: item.title,
    source: item.source,
    rev: item.rev,
    updatedAt: item.updatedAt,
    status: studyStatus(item),
    ratio: progressRatio(item),
    position: positionLabel(item),
    noteCount: item.noteCount ?? 0,
    nextReview: item.review?.next ?? null,
    body: await library.readNote(item.id),
    highlights: item.highlights,
    links: item.links ?? [],
    uploadSource: item.origin === 'desktop' && item.kind === 'image',
  };
}

function librarySource(library: Library): NotionSource {
  return {
    item: async (id) => {
      const item = library.get(id);
      return item ? toSyncItem(library, item) : null;
    },
    getLink: async (id) => library.get(id)?.notion,
    setLink: (id, link) => library.setNotion(id, link),
    resolveTitle: async (title) => library.findByTitle(title)?.id ?? null,
    readAsset: async (path) => {
      try {
        if (path.startsWith('source:')) {
          const item = library.get(path.slice(7));
          return item?.origin === 'desktop' ? await readFile(item.source) : null;
        }
        return await readFile(library.assetPath(path));
      } catch {
        return null;
      }
    },
    clearLinks: () => library.clearNotion(),
  };
}

/**
 * Desktop side of the Notion sync: the shared engine over the library, with
 * automatic (debounced) syncs after changes and a state for the UI.
 */
export class NotionSync extends EventEmitter<{ state: [NotionState] }> {
  readonly engine: NotionEngine;
  private syncing = 0;
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: NotionSyncOptions) {
    super();
    this.engine = new NotionEngine({
      source: librarySource(opts.library),
      getConfig: () => opts.getConfig(),
      saveDatabase: (id, url) => opts.saveDatabase(id, url),
      clientOptions: opts.clientOptions,
      onPageCreated: (id) => {
        if (this.autoSyncEnabled()) this.schedule(id, 'content');
      },
      log: opts.log,
    });
    opts.library.on('changed', (id, reason) => {
      if (!id || !this.autoSyncEnabled()) return;
      const item = opts.library.get(id);
      if (reason === 'content' || reason === 'meta') this.schedule(id, 'content');
      else if (reason === 'progress' && item?.notion) this.schedule(id, 'progress');
    });
  }

  get state(): NotionState {
    return {
      configured: this.isConfigured(),
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }

  isConfigured(): boolean {
    return this.engine.isConfigured();
  }

  private autoSyncEnabled(): boolean {
    return this.isConfigured() && this.opts.getConfig().autoSync;
  }

  connect(token: string, target: string) {
    return this.engine.connect(token, target);
  }

  ensureDatabase(): Promise<string> {
    return this.engine.ensureDatabase();
  }

  /** Syncs an item now (waits for a sync of the same item already running). */
  syncItem(id: string): Promise<{ url: string | null; pageId: string }> {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    return this.track(() => this.engine.syncItem(id)).then((res) => {
      if (this.opts.library.get(id)?.origin === 'extension') this.opts.onSynced?.(id);
      return res;
    });
  }

  /** Updates the page properties only (progress changes often). */
  syncProgress(id: string): Promise<void> {
    return this.track(() => this.engine.syncProperties(id));
  }

  async syncAll(): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    for (const item of this.opts.library.list()) {
      try {
        await this.syncItem(item.id);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed };
  }

  /** Debounced automatic sync. */
  schedule(id: string, what: 'content' | 'progress'): void {
    const existing = this.timers.get(id);
    if (existing) {
      if (what === 'progress') return; // A content sync (which includes progress) is already due.
      clearTimeout(existing);
    }
    const delay = (this.opts.debounceMs ?? 6000) * (what === 'progress' ? 5 : 1);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        const job = what === 'content' ? this.syncItem(id) : this.syncProgress(id);
        job.catch((e: unknown) => this.opts.log?.(`Notion : ${explainNotionError(e)}`));
      }, delay),
    );
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Configuration changed (other token / database). */
  reset(): void {
    this.engine.reset();
    this.lastError = null;
    this.emit('state', this.state);
  }

  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.syncing++;
    this.emit('state', this.state);
    try {
      const result = await fn();
      this.lastSyncAt = Date.now();
      this.lastError = null;
      return result;
    } catch (e) {
      this.lastError = explainNotionError(e);
      throw new Error(this.lastError);
    } finally {
      this.syncing--;
      this.emit('state', this.state);
    }
  }
}
