import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { KIND_LABELS, PLATFORM_LABELS } from '../../../../src/shared/platforms';
import { parseFrontMatter } from '../frontmatter';
import { positionLabel, progressRatio, studyStatus, type Library } from '../library';
import { STATUS_LABELS, type LibraryItem, type NotionBlockRef, type NotionLink } from '../types';
import { hashBlock, markdownToBlocks, plainRichText, toNotion, type BlockSpec, type Json } from './blocks';
import { explainNotionError, NotionClient, NotionError, parseNotionId, type NotionClientOptions } from './client';

export const DATABASE_TITLE = 'Boo Notes — Cours';

/** Columns of the course database. `status` properties cannot be created through the API: a select is used. */
export const DATABASE_PROPERTIES: Json = {
  Nom: { title: {} },
  Type: {
    select: {
      options: [
        { name: KIND_LABELS.video, color: 'purple' },
        { name: KIND_LABELS.audio, color: 'orange' },
        { name: KIND_LABELS.pdf, color: 'red' },
      ],
    },
  },
  Plateforme: {
    select: {
      options: [
        { name: PLATFORM_LABELS.youtube, color: 'red' },
        { name: PLATFORM_LABELS.udemy, color: 'purple' },
        { name: PLATFORM_LABELS.coursera, color: 'blue' },
        { name: PLATFORM_LABELS.notion, color: 'default' },
        { name: PLATFORM_LABELS.web, color: 'gray' },
        { name: PLATFORM_LABELS.local, color: 'brown' },
      ],
    },
  },
  Statut: {
    select: {
      options: [
        { name: STATUS_LABELS.todo, color: 'gray' },
        { name: STATUS_LABELS.doing, color: 'blue' },
        { name: STATUS_LABELS.done, color: 'green' },
      ],
    },
  },
  Progression: { number: { format: 'percent' } },
  Position: { rich_text: {} },
  Notes: { number: { format: 'number' } },
  Source: { url: {} },
  'Dernière activité': { date: {} },
};

const KIND_EMOJI = { video: '🎬', audio: '🎧', pdf: '📄' } as const;
const HIGHLIGHT_COLORS = {
  yellow: 'yellow_background',
  green: 'green_background',
  blue: 'blue_background',
  pink: 'pink_background',
} as const;

export interface NotionConfig {
  token: string;
  /** Page under which the course database is created. */
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
  log?(message: string): void;
}

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isYouTube(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Notion page properties of a library item. */
export function pageProperties(item: LibraryItem): Json {
  return {
    Nom: { title: plainRichText(item.title || 'Sans titre') },
    Type: { select: { name: KIND_LABELS[item.kind] } },
    Plateforme: { select: { name: PLATFORM_LABELS[item.platform] } },
    Statut: { select: { name: STATUS_LABELS[studyStatus(item)] } },
    Progression: { number: Math.round(progressRatio(item) * 1000) / 1000 },
    Position: { rich_text: plainRichText(positionLabel(item)) },
    Notes: { number: item.noteCount ?? 0 },
    Source: { url: isHttp(item.source) ? item.source : null },
    'Dernière activité': { date: { start: new Date(item.updatedAt).toISOString() } },
  };
}

/**
 * Mirrors the library in a Notion database: one page per course (properties:
 * type, status, progress, position…) whose content is the note. Content is
 * synced incrementally: blocks are fingerprinted, and only the blocks after
 * the first difference are rewritten (notes grow at the end).
 */
export class NotionSync extends EventEmitter<{ state: [NotionState] }> {
  private syncing = 0;
  private lastSyncAt: number | null = null;
  private lastError: string | null = null;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<unknown>>();
  private databaseChecked: string | null = null;

  constructor(private readonly opts: NotionSyncOptions) {
    super();
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
    const cfg = this.opts.getConfig();
    return Boolean(cfg.token && (cfg.databaseId || cfg.parentId));
  }

  private autoSyncEnabled(): boolean {
    return this.isConfigured() && this.opts.getConfig().autoSync;
  }

  private cachedClient: { key: string; client: NotionClient } | null = null;

  /** One client per token: the rate limit is shared by every sync. */
  private client(token = this.opts.getConfig().token): NotionClient {
    const cfg = this.opts.getConfig();
    const key = `${token}\n${cfg.apiBase ?? ''}`;
    if (this.cachedClient?.key !== key) {
      this.cachedClient = { key, client: new NotionClient({ token, baseUrl: cfg.apiBase, ...this.opts.clientOptions }) };
    }
    return this.cachedClient.client;
  }

  /**
   * Checks the token and the target (a page, under which the course database
   * is created, or an existing database), then prepares the database.
   */
  async connect(token: string, target: string): Promise<{ workspace: string | null; databaseId: string; url: string | null }> {
    const id = parseNotionId(target);
    if (!token.trim()) throw new Error('Collez le secret de votre intégration Notion');
    if (!id) throw new Error('Lien Notion invalide : copiez le lien de la page (Partager › Copier le lien)');
    const client = this.client(token.trim());
    let workspace: string | null = null;
    try {
      const me = await client.me();
      workspace = me.bot?.workspace_name ?? me.name ?? null;
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    // A database link: adopt it (missing columns are added).
    try {
      const db = await client.retrieveDatabase(id);
      await this.completeSchema(client, db.id, db.properties);
      await this.opts.saveDatabase(db.id, db.url ?? null);
      this.databaseChecked = db.id;
      return { workspace, databaseId: db.id, url: db.url ?? null };
    } catch (e) {
      if (!(e instanceof NotionError) || !(e.isNotFound || e.status === 400)) throw new Error(explainNotionError(e));
    }
    try {
      await client.retrievePage(id);
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    const db = await client.createDatabase(databaseBody(id)).catch((e: unknown) => {
      throw new Error(explainNotionError(e));
    });
    await this.opts.saveDatabase(db.id, db.url ?? null);
    this.databaseChecked = db.id;
    return { workspace, databaseId: db.id, url: db.url ?? null };
  }

  /** The configured database, re-created under the parent page if it was deleted. */
  async ensureDatabase(client = this.client()): Promise<string> {
    const cfg = this.opts.getConfig();
    if (cfg.databaseId && this.databaseChecked === cfg.databaseId) return cfg.databaseId;
    if (cfg.databaseId) {
      try {
        const db = await client.retrieveDatabase(cfg.databaseId);
        if (!db.archived && !db.in_trash) {
          await this.completeSchema(client, db.id, db.properties);
          this.databaseChecked = db.id;
          return db.id;
        }
      } catch (e) {
        if (!(e instanceof NotionError && e.isNotFound)) throw e;
      }
    }
    if (!cfg.parentId) throw new Error('Base Notion introuvable : reconnectez Notion dans les réglages');
    const db = await client.createDatabase(databaseBody(cfg.parentId));
    await this.opts.saveDatabase(db.id, db.url ?? null);
    // Pages of the old database are gone with it.
    await this.opts.library.clearNotion();
    this.databaseChecked = db.id;
    return db.id;
  }

  private async completeSchema(client: NotionClient, id: string, properties: Json): Promise<void> {
    const existing = new Set(Object.keys(properties ?? {}));
    const missing = Object.fromEntries(
      Object.entries(DATABASE_PROPERTIES).filter(([name, def]) => !existing.has(name) && !('title' in (def as Json))),
    );
    if (Object.keys(missing).length) await client.updateDatabase(id, { properties: missing });
  }

  /** Blocks of the Notion page: source, note, then highlighted passages. */
  async buildBlocks(item: LibraryItem): Promise<BlockSpec[]> {
    const blocks: BlockSpec[] = [];
    if (isYouTube(item.source)) blocks.push({ type: 'video', url: item.source });
    else if (isHttp(item.source)) blocks.push({ type: 'bookmark', url: item.source });
    else {
      blocks.push({
        type: 'callout',
        emoji: KIND_EMOJI[item.kind],
        color: 'gray_background',
        rich: plainRichText(`Fichier local : ${basename(item.source)}`),
      });
    }
    let body = '';
    try {
      body = parseFrontMatter(await readFile(this.opts.library.noteFilePath(item), 'utf8')).body;
    } catch {
      // No note file yet.
    }
    const noteBlocks = markdownToBlocks(body);
    for (const b of noteBlocks) {
      if (b.type === 'image') {
        b.missing = !(await readFile(this.opts.library.assetPath(b.asset)).then(
          () => true,
          () => false,
        ));
      }
    }
    blocks.push(...noteBlocks);
    const highlights = [...(item.highlights ?? [])].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    if (highlights.length) {
      blocks.push({ type: 'heading_3', rich: plainRichText('Passages surlignés') });
      for (const h of highlights) {
        blocks.push({
          type: 'quote',
          color: HIGHLIGHT_COLORS[h.color],
          rich: [...plainRichText(h.text.trim()), ...plainRichText(' '), ...plainRichText(`p. ${h.page}`, { code: true })],
        });
      }
    }
    return blocks;
  }

  /** Syncs an item now (waits for a sync of the same item already running). */
  syncItem(id: string): Promise<{ url: string | null; pageId: string }> {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const previous = this.running.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.track(() => this.doSync(id)));
    this.running.set(id, run);
    void run.finally(() => {
      if (this.running.get(id) === run) this.running.delete(id);
    }).catch(() => undefined);
    return run;
  }

  /** Updates the page properties only (progress changes often). */
  async syncProgress(id: string): Promise<void> {
    const item = this.opts.library.get(id);
    if (!item?.notion?.pageId) return;
    await this.track(async () => {
      try {
        await this.client().updatePage(item.notion!.pageId, { properties: pageProperties(item) });
      } catch (e) {
        if (e instanceof NotionError && e.isNotFound) return this.doSync(id);
        throw e;
      }
      return undefined;
    });
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
    this.databaseChecked = null;
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

  private async doSync(id: string): Promise<{ url: string | null; pageId: string }> {
    const { library } = this.opts;
    if (!this.isConfigured()) throw new Error('Notion n’est pas connecté : ouvrez les réglages');
    const client = this.client();
    let link: NotionLink | undefined = library.require(id).notion;
    try {
      const databaseId = await this.ensureDatabase(client);
      link = library.require(id).notion; // may have been cleared by a database re-creation
      const item = library.require(id);
      const specs = await this.buildBlocks(item);
      const hashes = specs.map(hashBlock);
      const properties = pageProperties(item);
      const icon = { type: 'emoji', emoji: KIND_EMOJI[item.kind] };

      let pageId = link?.pageId ?? null;
      let url = link?.url ?? null;
      let blocks: NotionBlockRef[] = link?.blocks ?? [];
      if (pageId) {
        try {
          const page = await client.updatePage(pageId, { properties, icon });
          if (page.archived || page.in_trash) pageId = null;
          else url = page.url ?? url;
        } catch (e) {
          if (!(e instanceof NotionError && (e.isNotFound || e.status === 400))) throw e;
          pageId = null;
        }
      }
      if (!pageId) {
        const page = await client.createPage({ parent: { database_id: databaseId }, icon, properties });
        pageId = page.id;
        url = page.url ?? null;
        blocks = [];
      }

      let prefix = 0;
      while (prefix < blocks.length && prefix < hashes.length && blocks[prefix].hash === hashes[prefix]) prefix++;
      const save = (refs: NotionBlockRef[]) =>
        library.setNotion(id, {
          pageId: pageId!,
          url: url ?? undefined,
          blocks: refs,
          syncedAt: Date.now(),
          syncedRev: item.rev,
          error: null,
        });

      // Remove what changed, then append the new tail (saved batch by batch: no duplicates after a failure).
      if (prefix < blocks.length) {
        for (const b of blocks.slice(prefix)) {
          await client.deleteBlock(b.id).catch((e: unknown) => {
            if (!(e instanceof NotionError && (e.isNotFound || e.status === 400))) throw e;
          });
        }
        blocks = blocks.slice(0, prefix);
      }
      await save(blocks);

      const upload = async (asset: string): Promise<string | null> => {
        try {
          const data = await readFile(library.assetPath(asset));
          const mime = MIME[extname(asset).toLowerCase()] ?? 'application/octet-stream';
          return await client.uploadFile(basename(asset), mime, data);
        } catch (e) {
          if (e instanceof NotionError) throw e;
          return null;
        }
      };
      for (let i = prefix; i < specs.length; i += 100) {
        const batch = specs.slice(i, i + 100);
        const payload: Json[] = [];
        for (const spec of batch) payload.push(await toNotion(spec, upload));
        const created = await client.appendChildren(pageId, payload);
        blocks = [...blocks, ...created.map((b, j) => ({ id: b.id, hash: hashes[i + j] }))];
        await save(blocks);
      }
      this.opts.log?.(`Notion : « ${item.title} » synchronisé`);
      return { url, pageId };
    } catch (e) {
      const current = library.get(id)?.notion ?? link;
      if (current) await library.setNotion(id, { ...current, error: explainNotionError(e) });
      throw e;
    }
  }
}

function databaseBody(parentPageId: string): Json {
  return {
    parent: { type: 'page_id', page_id: parentPageId },
    icon: { type: 'emoji', emoji: '👻' },
    title: plainRichText(DATABASE_TITLE),
    properties: DATABASE_PROPERTIES,
  };
}
