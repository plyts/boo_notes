import { countNotes, linkedTitles, normalizeTitle } from '../shared/markdown';
import type { NotionPlace, NotionStatus } from '../shared/messages';
import { explainNotionError, NotionClient, NotionError, type NotionClientOptions } from '../shared/notion/client';
import { DATABASE_TITLE, DEFAULT_VAULT_NAME, NotionEngine, type CourseEntry, type CoursePageLink, type NotionLink, type NotionSource, type NotionVault, type SyncItem } from '../shared/notion/engine';
import { positionLabel, progressRatio, studyStatus } from '../shared/study';
import { courseSummaryKey, summaryKey, type CourseSummary, type LessonSummary } from '../shared/summary';
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
  /** How it was connected: Notion's consent (OAuth), or an integration secret. */
  via?: 'oauth' | 'secret';
  /** OAuth: to renew the access when Notion asks. */
  refreshToken?: string;
  databaseId: string | null;
  databaseUrl: string | null;
  /** Page holding the database (inline table). */
  parentId: string | null;
  workspace: string | null;
  /** The vault: its name (the page holding the table and the course pages) and address. */
  vaultName?: string | null;
  vaultUrl?: string | null;
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

/** Where a note stands in Notion (options › Données). */
export interface NoteNotionState {
  state: 'synced' | 'pending' | 'error' | 'new';
  url?: string;
  error?: string;
}

type PendingKind = 'content' | 'progress';
/** `at`: when it was queued, so a change made during its sync is not dropped. */
type Pending = Record<string, { kind: PendingKind; at: number }>;

const CONFIG_KEY = 'notion:config';
const PENDING_KEY = 'notion:pending';
const STATE_KEY = 'notion:state';
const LINK_PREFIX = 'notion:link:';
const linkKey = (id: string) => `${LINK_PREFIX}${id}`;
const COURSE_PREFIX = 'notion:course:';
const coursePageKey = (key: string) => `${COURSE_PREFIX}${key}`;

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
  /** OAuth: a new access when Notion no longer takes the current one (null: impossible). */
  renewAccess?(refreshToken: string): Promise<{ token: string; refreshToken?: string } | null>;
}

/** Notion's consent, as given back by the exchange server. */
export interface NotionGrantLike {
  token: string;
  refreshToken?: string;
  /** Boo Notes' template page, copied into the workspace during the consent. */
  templatePageId?: string;
}

const PLACE_HINT = /boo\s*notes|cours|notes|études|etudes|révision|revision/i;

/**
 * Where to make a new vault, without asking: in the page shared whose name
 * speaks of courses or notes, else the first one shared (the top of the
 * workspace first). Tables are not places for a page.
 */
export function pickVaultParent(places: NotionPlace[]): NotionPlace | null {
  const pages = places.filter((p) => p.kind === 'page');
  return pages.find((p) => PLACE_HINT.test(p.title)) ?? pages[0] ?? null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sameId = (a: string, b: string) => a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();

export class ExtensionNotion {
  readonly engine: NotionEngine;
  private config: NotionConfig | null = null;
  private loaded: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private syncing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private renewing: Promise<boolean> | null = null;
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

  /** The connection changed in the storage (written elsewhere): read again at the next use. */
  refresh(): void {
    this.loaded = null;
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
        const summary = ((await area.get(summaryKey(id)))[summaryKey(id)] as LessonSummary | undefined) ?? null;
        return { ...noteToSyncItem(note, await store.getProgress(id)), transcript, summary };
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
      courseEntries: (course) => this.courseEntries(course),
      getCoursePage: async (key) => (await area.get(coursePageKey(key)))[coursePageKey(key)] as CoursePageLink | undefined,
      setCoursePage: async (key, link) => {
        if (link) await area.set({ [coursePageKey(key)]: link });
        else await area.remove(coursePageKey(key));
      },
      courseSummary: async (course) => {
        const key = courseSummaryKey(normalizeTitle(course));
        return ((await area.get(key))[key] as CourseSummary | undefined) ?? null;
      },
    };
  }

  /** The lessons of a course (null: the notes filed in none), in the order they were begun. */
  private async courseEntries(course: string | null): Promise<CourseEntry[]> {
    const { store } = this.opts;
    const want = course ? normalizeTitle(course) : null;
    const index = await store.listNotes();
    const out: Array<CourseEntry & { at: number }> = [];
    for (const [id, summary] of Object.entries(index)) {
      if ((summary.course ? normalizeTitle(summary.course) : null) !== want) continue;
      const note = await store.getNote(id);
      if (!note) continue;
      const item = noteToSyncItem(note, await store.getProgress(id));
      out.push({ id, title: item.title, kind: item.kind, chapter: note.chapter ?? null, status: item.status, ratio: item.ratio, at: note.createdAt });
    }
    return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...e }) => e);
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
    const keys = Object.keys(all).filter((k) => k.startsWith(LINK_PREFIX) || k.startsWith(COURSE_PREFIX));
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
      via: this.config ? (this.config.via ?? 'secret') : null,
      workspace: this.config?.workspace ?? null,
      vault: this.config ? (this.config.vaultName ?? null) : null,
      vaultUrl: this.config?.vaultUrl ?? null,
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

  /**
   * The pages (and the table of a former connection) this token may write
   * to: where to put the notes table. The table first, then the pages at
   * the top of the workspace.
   */
  async places(token: string): Promise<NotionPlace[]> {
    await this.load();
    const client = new NotionClient({ token, baseUrl: this.config?.apiBase ?? this.apiBase, ...this.opts.clientOptions });
    let found;
    try {
      found = await client.search({ page_size: 100 });
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    type Item = { object?: string; id?: string; archived?: boolean; in_trash?: boolean; parent?: { type?: string }; icon?: { emoji?: string } | null; title?: Array<{ plain_text?: string; text?: { content?: string } }>; properties?: Record<string, { title?: Array<{ plain_text?: string; text?: { content?: string } }> }> };
    const text = (rich: Array<{ plain_text?: string; text?: { content?: string } }> | undefined) => (rich ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('').trim();
    const out: Array<NotionPlace & { rank: number }> = [];
    for (const raw of found.results as Item[]) {
      if (!raw.id || raw.archived || raw.in_trash) continue;
      if (raw.object === 'database') {
        const title = text(raw.title);
        if (title === DATABASE_TITLE) out.push({ id: raw.id, kind: 'database', title, rank: 0 });
        continue;
      }
      if (raw.object !== 'page' || raw.parent?.type === 'database_id') continue;
      const title = text(Object.values(raw.properties ?? {}).find((p) => p.title)?.title) || 'Sans titre';
      out.push({ id: raw.id, kind: 'page', title, ...(raw.icon?.emoji ? { icon: raw.icon.emoji } : {}), rank: raw.parent?.type === 'workspace' ? 1 : 2 });
    }
    return out.sort((a, b) => a.rank - b.rank).map(({ rank: _r, ...p }) => p);
  }

  /**
   * Takes a connection: the access, then `setup` (the vault and its table
   * found or made). Nothing changes when it fails.
   */
  private async adopt(
    token: string,
    access: { via?: 'oauth' | 'secret'; refreshToken?: string },
    setup: () => Promise<{ workspace?: string | null; databaseId: string; url: string | null; parentId: string | null; vaultName: string | null; vaultUrl: string | null }>,
  ): Promise<NotionStatus> {
    await this.load();
    const previous = this.config;
    this.config = {
      token: token.trim(),
      via: access.via ?? 'secret',
      ...(access.refreshToken ? { refreshToken: access.refreshToken } : {}),
      databaseId: null,
      databaseUrl: null,
      parentId: null,
      workspace: null,
      origin: 'extension',
      ...(this.apiBase ? { apiBase: this.apiBase } : {}),
    };
    this.engine.reset();
    try {
      const res = await setup();
      const workspace = res.workspace !== undefined ? res.workspace : await this.engine.workspace(token);
      this.config = { ...this.config, databaseId: res.databaseId, databaseUrl: res.url, parentId: res.parentId, workspace, vaultName: res.vaultName, vaultUrl: res.vaultUrl };
    } catch (e) {
      this.config = previous;
      this.engine.reset();
      throw e;
    }
    if (previous?.databaseId !== this.config.databaseId || previous?.parentId !== this.config.parentId) await this.clearLinks();
    await this.opts.area.set({ [CONFIG_KEY]: this.config });
    await this.setState({ lastError: null });
    await this.emit();
    return this.status();
  }

  /** Options page (method with a secret): an access and the page that becomes the vault (or a table, adopted). */
  connect(token: string, target: string, access: { via?: 'oauth' | 'secret'; refreshToken?: string } = {}): Promise<NotionStatus> {
    return this.adopt(token, access, () => this.engine.connect(token, target));
  }

  /** The vaults this access reaches (the « Choisir le coffre » step after Notion's window). */
  vaults(token: string): Promise<NotionVault[]> {
    return this.engine.findVaults(token);
  }

  /**
   * « Connecter Notion », once Notion's window answered: the vault chosen
   * (`vaultId`), or the one named `name` — found again if it exists (never a
   * second « Boo Notes »), else made: in the page Notion copied from Boo
   * Notes' template, else in a page shared. Then every note of this browser
   * goes there.
   */
  async connectVault(grant: NotionGrantLike, choice: { vaultId?: string | null; name?: string | null }): Promise<NotionStatus> {
    const name = choice.name?.trim().slice(0, 100) || DEFAULT_VAULT_NAME;
    const access = { via: 'oauth' as const, ...(grant.refreshToken ? { refreshToken: grant.refreshToken } : {}) };
    const vaults = await this.engine.findVaults(grant.token);
    const existing = choice.vaultId ? vaults.find((v) => sameId(v.pageId, choice.vaultId!)) : vaults.find((v) => normalizeTitle(v.name) === normalizeTitle(name));
    const template = grant.templatePageId ?? null;
    let status: NotionStatus;
    if (existing) {
      status = await this.adopt(grant.token, access, () => this.engine.setupVault(grant.token, existing.pageId));
      // A copy of the template made by this consent: not a second vault.
      if (template && !sameId(template, existing.pageId)) await this.engine.archive(grant.token, template).catch(() => undefined);
    } else if (template) {
      // Notion copies the template in the background: its page may take a moment to be reachable.
      let done: NotionStatus | null = null;
      for (let attempt = 0; !done; attempt++) {
        try {
          done = await this.adopt(grant.token, access, () => this.engine.setupVault(grant.token, template, { name, own: true }));
        } catch (e) {
          if (attempt >= 5 || !/introuvable|not.?found/i.test(e instanceof Error ? e.message : String(e))) throw e;
          await pause(1000 * (attempt + 1));
        }
      }
      status = done;
    } else {
      const parent = pickVaultParent(await this.places(grant.token));
      if (!parent) throw new Error('aucune page Notion n’a été partagée : recommencez et choisissez « Utiliser le modèle » (ou cochez une page) dans la fenêtre Notion');
      status = await this.adopt(grant.token, access, () => this.engine.createVault(grant.token, parent.id, name));
    }
    await this.enqueueAll();
    return status;
  }

  /** The access in use, for « Déconnecter » to withdraw it in Notion too. */
  async access(): Promise<{ token: string; via: 'oauth' | 'secret'; origin: 'desktop' | 'extension' } | null> {
    await this.load();
    return this.config ? { token: this.config.token, via: this.config.via ?? 'secret', origin: this.config.origin } : null;
  }

  /** Every note of this browser, to be written (a new connection). */
  async enqueueAll(): Promise<void> {
    const ids = Object.keys(await this.opts.store.listNotes());
    if (!ids.length || !(await this.isConfigured())) return;
    await this.exclusive(async () => {
      const res = await this.opts.area.get(PENDING_KEY);
      const pending = (res[PENDING_KEY] as Pending | undefined) ?? {};
      for (const id of ids) pending[id] = { kind: 'content', at: stamp() };
      await this.opts.area.set({ [PENDING_KEY]: pending });
    });
    this.schedule();
    await this.emit();
  }

  /** What went wrong, said for who connected: without a word of « secret » after « Connecter Notion ». */
  private explain(e: unknown): string {
    if (this.config?.via === 'oauth' && e instanceof NotionError) {
      if (e.isUnauthorized) return 'Boo Notes n’a plus accès à votre Notion : reconnectez Notion (bouton « Notion » › Reconnecter Notion)';
      if (e.status === 403 || e.isNotFound) return 'Le tableau Boo Notes n’est plus accessible dans Notion : reconnectez Notion (bouton « Notion » › Reconnecter Notion)';
    }
    return explainNotionError(e);
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

  /** A course's summary was made (or made again): its page in the vault is written again. */
  async courseSummaryChanged(course: string): Promise<void> {
    if (!(await this.isConfigured())) return;
    this.engine.markCourse(course);
    this.schedule();
  }

  /** A note deleted from this browser: nothing more to write for it (its page stays in Notion). */
  async forget(noteId: string): Promise<void> {
    await this.exclusive(async () => {
      const res = await this.opts.area.get(PENDING_KEY);
      const pending = (res[PENDING_KEY] as Pending | undefined) ?? {};
      if (!pending[noteId]) return;
      delete pending[noteId];
      await this.opts.area.set({ [PENDING_KEY]: pending });
    });
    await this.opts.area.remove(linkKey(noteId));
    await this.emit();
  }

  /**
   * Where each note stands in Notion: written (its page), waiting to be
   * written, failed (why), or never sent yet.
   */
  async noteStates(ids: string[]): Promise<Record<string, NoteNotionState>> {
    const res = await this.opts.area.get([PENDING_KEY, ...ids.map(linkKey)]);
    const pending = (res[PENDING_KEY] as Pending | undefined) ?? {};
    const out: Record<string, NoteNotionState> = {};
    for (const id of ids) {
      const link = res[linkKey(id)] as NotionLink | undefined;
      const url = link?.url;
      if (pending[id]) out[id] = { state: 'pending', ...(url ? { url } : {}) };
      else if (link?.error) out[id] = { state: 'error', error: link.error, ...(url ? { url } : {}) };
      else if (link && link.syncedRev >= 0) out[id] = { state: 'synced', ...(url ? { url } : {}) };
      else if (link) out[id] = { state: 'pending', ...(url ? { url } : {}) };
      else out[id] = { state: 'new' };
    }
    return out;
  }

  /**
   * OAuth: Notion no longer takes the access (expired): a new one, asked
   * once for every sync that ran into it.
   */
  private renew(e: unknown, used: string): Promise<boolean> {
    if (!(e instanceof NotionError) || e.status !== 401) return Promise.resolve(false);
    const cfg = this.config;
    if (!cfg || cfg.via !== 'oauth') return Promise.resolve(false);
    // Already renewed by another sync meanwhile.
    if (cfg.token !== used) return Promise.resolve(true);
    const refreshToken = cfg.refreshToken;
    const renewAccess = this.opts.renewAccess;
    if (!refreshToken || !renewAccess) return Promise.resolve(false);
    this.renewing ??= (async () => {
      try {
        const next = await renewAccess(refreshToken);
        if (!next || !this.config || this.config.token !== used) return false;
        this.config = { ...this.config, token: next.token, refreshToken: next.refreshToken ?? refreshToken };
        await this.opts.area.set({ [CONFIG_KEY]: this.config });
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  /** A call to Notion, again with a renewed access if it had expired. */
  private async withAccess<T>(fn: () => Promise<T>): Promise<T> {
    const used = this.config?.token ?? '';
    try {
      return await fn();
    } catch (e) {
      if (await this.renew(e, used)) return fn();
      throw e;
    }
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
    if (!ids.length) {
      // Only a course's page to write again (its summary changed).
      if (!this.engine.hasDirtyCourses() || this.opts.desktopHandlesNotion()) return;
      this.syncing = true;
      await this.emit();
      try {
        await this.syncCourses();
      } finally {
        this.syncing = false;
        await this.emit();
      }
      return;
    }
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
          if (pending[id].kind === 'progress' && (await this.link(id))) await this.withAccess(() => this.engine.syncProperties(id));
          else await this.withAccess(() => this.engine.syncItem(id));
          await this.done(id, pending[id].at);
          await this.setState({ lastSyncAt: Date.now(), lastError: null });
          this.opts.onLinked?.(id);
        } catch (e) {
          await this.setState({ lastError: this.explain(e) });
          // Bad secret, page no longer shared…: the others would fail the same way.
          if (e instanceof NotionError && (e.status === 401 || e.status === 403)) break;
          if (!(e instanceof NotionError)) break; // Offline.
        }
      }
      await this.syncCourses();
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
      const res = await this.withAccess(() => this.engine.syncItem(noteId));
      await this.done(noteId, started);
      await this.setState({ lastSyncAt: Date.now(), lastError: null });
      this.opts.onLinked?.(noteId);
      await this.syncCourses();
      return { url: res.url };
    } catch (e) {
      const message = this.explain(e);
      await this.setState({ lastError: message });
      throw new Error(message);
    } finally {
      this.syncing = false;
      await this.emit();
    }
  }

  /** The pages of the courses whose lessons changed: written again (a failure waits for the next change). */
  private async syncCourses(): Promise<void> {
    try {
      await this.withAccess(() => this.engine.syncCourses());
    } catch (e) {
      await this.setState({ lastError: this.explain(e) });
    }
  }

  /**
   * « Tout synchroniser », idempotent: the table checked first (found again,
   * else made in the vault), then each note — those already in Notion as they
   * are here are left alone, the others written (found again by their Boo ID
   * before any page is made).
   */
  async syncAll(): Promise<{ ok: number; failed: number; unchanged: number }> {
    let ok = 0;
    let failed = 0;
    let unchanged = 0;
    if (!(await this.isConfigured())) throw new Error('Notion n’est pas connecté');
    await this.withAccess(() => this.engine.ensureDatabase());
    for (const [id] of Object.entries(await this.opts.store.listNotes())) {
      try {
        const [link, note] = await Promise.all([this.link(id), this.opts.store.getNote(id)]);
        if (note && link?.pageId && !link.error && link.syncedRev === note.rev && (await this.withAccess(() => this.engine.pageAlive(link.pageId)))) {
          unchanged++;
          continue;
        }
        await this.syncNow(id);
        ok++;
      } catch {
        failed++;
      }
    }
    return { ok, failed, unchanged };
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
