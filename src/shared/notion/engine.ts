import { normalizeTitle } from '../markdown';
import { KIND_LABELS, PLATFORM_LABELS, type MediaKind, type Platform } from '../platforms';
import { STATUS_LABELS, type StudyStatus } from '../study';
import { hashBlock, markdownToBlocks, plainRichText, toNotion, type BlockSpec, type Json } from './blocks';
import { explainNotionError, NotionClient, NotionError, parseNotionId, type NotionClientOptions } from './client';

/**
 * Notion synchronisation shared by the desktop app and the browser extension:
 * one database (an inline table in the page chosen by the user), one page per
 * note (video, audio, PDF, text, image, web page or revision sheet) with its
 * properties, and the note as the page content. `[[Titre]]` links become page
 * mentions and fill the "Liens" relation (Notion shows the reverse "Liée depuis").
 *
 * Content is synced incrementally: blocks are fingerprinted, and only the
 * blocks after the first difference are rewritten (notes grow at the end).
 */

export const DATABASE_TITLE = 'Boo Notes — Mes notes';

export interface NotionBlockRef {
  id: string;
  hash: string;
}

/** Mirror of a note in the Notion database. */
export interface NotionLink {
  pageId: string;
  url?: string;
  /** Top-level blocks written by Boo Notes, in order. */
  blocks: NotionBlockRef[];
  syncedAt: number;
  /** Revision of the last successful content sync (-1: page created, content not written yet). */
  syncedRev: number;
  error?: string | null;
}

export interface SyncHighlight {
  page: number;
  text: string;
  color: 'yellow' | 'green' | 'blue' | 'pink';
  createdAt: number;
}

/** A resource of a note, shown at the top of its Notion page. */
export interface SyncSource {
  id: string;
  kind: MediaKind;
  title: string;
  /** URL or local path. */
  source: string;
  /** Local image uploaded to Notion, read with `readAsset('source:<id>')`. */
  upload?: boolean;
}

/** A note as the engine needs it. */
export interface SyncItem {
  id: string;
  kind: MediaKind;
  platform: Platform;
  title: string;
  /** URL, local path, or empty for a revision sheet. */
  source: string;
  rev: number;
  updatedAt: number;
  status: StudyStatus;
  /** 0..1 */
  ratio: number;
  position: string;
  noteCount: number;
  nextReview: number | null;
  /** Markdown of the note (no front matter). */
  body: string;
  highlights?: SyncHighlight[];
  /** Titles linked with `[[Titre]]`. */
  links: string[];
  /** Local file to show in Notion (images), read with `readAsset('source:<id>')`. */
  uploadSource?: boolean;
  /** Every resource of the note (videos, audios, PDF, images…); `source` alone when absent. */
  sources?: SyncSource[];
  /** Course and chapter the note is filed in (undefined: not managed by this device). */
  course?: string | null;
  chapter?: string | null;
}

/** Where notes and their Notion mapping live (desktop library, extension storage). */
export interface NotionSource {
  item(id: string): Promise<SyncItem | null>;
  getLink(id: string): Promise<NotionLink | undefined>;
  setLink(id: string, link: NotionLink | undefined): Promise<void>;
  /** Note id of a `[[Titre]]`. */
  resolveTitle(title: string): Promise<string | null>;
  /** `assets/…` capture, or `source:<id>` for the note's own file (image). */
  readAsset(path: string): Promise<Uint8Array | null>;
  clearLinks(): Promise<void>;
}

export interface EngineConfig {
  token: string;
  /** Page holding the database (inline table). */
  parentId: string | null;
  databaseId: string | null;
  apiBase?: string;
}

export interface EngineOptions {
  source: NotionSource;
  getConfig(): EngineConfig;
  /** Persists the database created / adopted by `connect()` or `ensureDatabase()`. */
  saveDatabase(databaseId: string, url: string | null): Promise<void>;
  clientOptions?: Partial<NotionClientOptions>;
  /** A page was created for a linked note: its content should be synced too. */
  onPageCreated?(id: string): void;
  log?(message: string): void;
}

const KIND_EMOJI: Record<MediaKind, string> = {
  video: '🎬',
  audio: '🎧',
  pdf: '📄',
  text: '📝',
  image: '🖼️',
  page: '🌐',
  note: '🗂️',
};

const KIND_COLORS: Record<MediaKind, string> = {
  video: 'purple',
  audio: 'orange',
  pdf: 'red',
  text: 'yellow',
  image: 'pink',
  page: 'blue',
  note: 'green',
};

const HIGHLIGHT_COLORS = {
  yellow: 'yellow_background',
  green: 'green_background',
  blue: 'blue_background',
  pink: 'pink_background',
} as const;

export const LINKS_PROPERTY = 'Liens';
export const COURSE_PROPERTY = 'Cours';
export const CHAPTER_PROPERTY = 'Chapitre';
export const SOURCES_PROPERTY = 'Supports';
export const BACKLINKS_PROPERTY = 'Liée depuis';
export const ID_PROPERTY = 'Boo ID';

/** Columns of the database. `status` properties cannot be created through the API: a select is used. */
export const DATABASE_PROPERTIES: Json = {
  Nom: { title: {} },
  Type: {
    select: { options: (Object.keys(KIND_LABELS) as MediaKind[]).map((k) => ({ name: KIND_LABELS[k], color: KIND_COLORS[k] })) },
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
  [COURSE_PROPERTY]: { select: { options: [] } },
  [CHAPTER_PROPERTY]: { rich_text: {} },
  [SOURCES_PROPERTY]: { rich_text: {} },
  Progression: { number: { format: 'percent' } },
  Position: { rich_text: {} },
  Notes: { number: { format: 'number' } },
  'Prochaine révision': { date: {} },
  Source: { url: {} },
  'Dernière activité': { date: {} },
  [ID_PROPERTY]: { rich_text: {} },
};

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

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function mimeOf(path: string): string {
  return MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Notion page properties of a note. `links`: pages of the notes it links to (omitted: unchanged). */
export function pageProperties(item: SyncItem, links?: string[]): Json {
  const props: Json = {
    Nom: { title: plainRichText(item.title || 'Sans titre') },
    Type: { select: { name: KIND_LABELS[item.kind] } },
    Plateforme: { select: { name: PLATFORM_LABELS[item.platform] } },
    Statut: { select: { name: STATUS_LABELS[item.status] } },
    Progression: { number: Math.round(item.ratio * 1000) / 1000 },
    Position: { rich_text: plainRichText(item.position) },
    Notes: { number: item.noteCount },
    'Prochaine révision': { date: item.nextReview ? { start: new Date(item.nextReview).toISOString().slice(0, 10) } : null },
    Source: { url: isHttp(item.source) ? item.source : null },
    'Dernière activité': { date: { start: new Date(item.updatedAt).toISOString() } },
    [ID_PROPERTY]: { rich_text: plainRichText(item.id) },
  };
  if (links) props[LINKS_PROPERTY] = { relation: links.map((id) => ({ id })) };
  if (item.course !== undefined) {
    // Notion refuses commas in select options.
    const name = item.course?.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
    props[COURSE_PROPERTY] = { select: name ? { name } : null };
    props[CHAPTER_PROPERTY] = { rich_text: plainRichText(item.chapter ?? '') };
  }
  if (item.sources) {
    props[SOURCES_PROPERTY] = { rich_text: plainRichText(item.sources.map((s) => `${KIND_LABELS[s.kind]} · ${s.title}`).join('\n')) };
  }
  return props;
}

export class NotionEngine {
  private databaseChecked: string | null = null;
  private cachedClient: { key: string; client: NotionClient } | null = null;
  private readonly running = new Map<string, Promise<unknown>>();
  /** Pages known to exist during this session (linked notes). */
  private readonly livePages = new Set<string>();

  constructor(private readonly opts: EngineOptions) {}

  isConfigured(): boolean {
    const cfg = this.opts.getConfig();
    return Boolean(cfg.token && (cfg.databaseId || cfg.parentId));
  }

  /** Configuration changed (other token / database). */
  reset(): void {
    this.databaseChecked = null;
    this.livePages.clear();
  }

  /** One client per token: the rate limit is shared by every sync. */
  client(token = this.opts.getConfig().token): NotionClient {
    const cfg = this.opts.getConfig();
    const key = `${token}\n${cfg.apiBase ?? ''}`;
    if (this.cachedClient?.key !== key) {
      this.cachedClient = { key, client: new NotionClient({ token, baseUrl: cfg.apiBase, ...this.opts.clientOptions }) };
    }
    return this.cachedClient.client;
  }

  /**
   * Checks the token and the target: a page, which receives the database as an
   * inline table, or an existing database, which is adopted (missing columns added).
   */
  async connect(token: string, target: string): Promise<{ workspace: string | null; databaseId: string; url: string | null; parentId: string | null }> {
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
    try {
      const db = await client.retrieveDatabase(id);
      await this.completeSchema(client, db.id, db.properties);
      await this.opts.saveDatabase(db.id, db.url ?? null);
      this.databaseChecked = db.id;
      return { workspace, databaseId: db.id, url: db.url ?? null, parentId: null };
    } catch (e) {
      if (!(e instanceof NotionError) || !(e.isNotFound || e.status === 400)) throw new Error(explainNotionError(e));
    }
    try {
      await client.retrievePage(id);
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    const db = await this.createDatabase(client, id).catch((e: unknown) => {
      throw new Error(explainNotionError(e));
    });
    await this.opts.saveDatabase(db.id, db.url ?? null);
    this.databaseChecked = db.id;
    return { workspace, databaseId: db.id, url: db.url ?? null, parentId: id };
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
    const db = await this.createDatabase(client, cfg.parentId);
    await this.opts.saveDatabase(db.id, db.url ?? null);
    // Pages of the old database are gone with it.
    await this.opts.source.clearLinks();
    this.livePages.clear();
    this.databaseChecked = db.id;
    return db.id;
  }

  private async createDatabase(client: NotionClient, parentPageId: string): Promise<{ id: string; url?: string }> {
    const db = await client.createDatabase({
      parent: { type: 'page_id', page_id: parentPageId },
      // An inline table in the chosen page: the page becomes the notes hub.
      is_inline: true,
      icon: { type: 'emoji', emoji: '👻' },
      title: plainRichText(DATABASE_TITLE),
      properties: DATABASE_PROPERTIES,
    });
    await this.completeSchema(client, db.id, DATABASE_PROPERTIES);
    return db;
  }

  private async completeSchema(client: NotionClient, id: string, properties: Json): Promise<void> {
    const existing = new Set(Object.keys(properties ?? {}));
    const missing: Json = Object.fromEntries(
      Object.entries(DATABASE_PROPERTIES).filter(([name, def]) => !existing.has(name) && !('title' in (def as Json))),
    );
    // Self relation (needs the database id): "Liens", and its reverse "Liée depuis".
    if (!existing.has(LINKS_PROPERTY)) {
      missing[LINKS_PROPERTY] = {
        relation: { database_id: id, type: 'dual_property', dual_property: { synced_property_name: BACKLINKS_PROPERTY } },
      };
    }
    if (Object.keys(missing).length) await client.updateDatabase(id, { properties: missing });
  }

  /** Blocks of the Notion page: resources, note, then highlighted passages. */
  buildBlocks(item: SyncItem, wiki: (title: string) => string | null = () => null): BlockSpec[] {
    const blocks: BlockSpec[] = [];
    const sources: SyncSource[] =
      item.sources ?? (item.source ? [{ id: item.id, kind: item.kind, title: item.title, source: item.source, upload: item.uploadSource }] : []);
    const many = sources.length > 1;
    for (const src of sources) {
      if (isYouTube(src.source)) blocks.push({ type: 'video', url: src.source });
      else if (isHttp(src.source)) blocks.push({ type: 'bookmark', url: src.source });
      else if (src.upload) blocks.push({ type: 'image', asset: `source:${src.id}`, caption: plainRichText(many ? src.title : baseName(src.source)) });
      else if (src.source) {
        blocks.push({
          type: 'callout',
          emoji: KIND_EMOJI[src.kind],
          color: 'gray_background',
          rich: plainRichText(`${KIND_LABELS[src.kind]} — fichier local : ${baseName(src.source)}`),
        });
      }
    }
    blocks.push(...markdownToBlocks(item.body, { wiki }));
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

  /** Syncs a note now (waits for a sync of the same note already running). */
  syncItem(id: string): Promise<{ url: string | null; pageId: string }> {
    return this.serial(id, () => this.doSync(id));
  }

  /** Updates the page properties only (progress changes often). */
  syncProperties(id: string): Promise<void> {
    return this.serial(id, async () => {
      const [item, link] = await Promise.all([this.opts.source.item(id), this.opts.source.getLink(id)]);
      if (!item || !link?.pageId) return;
      try {
        await this.client().updatePage(link.pageId, { properties: pageProperties(item) });
      } catch (e) {
        if (e instanceof NotionError && (e.isNotFound || e.status === 400)) {
          await this.doSync(id);
          return;
        }
        throw e;
      }
    });
  }

  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.running.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.running.set(id, run);
    void run
      .finally(() => {
        if (this.running.get(id) === run) this.running.delete(id);
      })
      .catch(() => undefined);
    return run;
  }

  /** Existing page of a note in the database (created by another device), by its Boo ID. */
  private async findPage(client: NotionClient, databaseId: string, id: string): Promise<{ id: string; url?: string } | null> {
    const res = await client.queryDatabase(databaseId, {
      filter: { property: ID_PROPERTY, rich_text: { equals: id } },
      page_size: 1,
    });
    const page = res.results.find((p) => !p.archived && !p.in_trash);
    return page ? { id: page.id, url: page.url } : null;
  }

  /** Page of a linked note (created empty if needed, its content is synced later). */
  private async ensurePage(client: NotionClient, databaseId: string, id: string): Promise<string | null> {
    const link = await this.opts.source.getLink(id);
    if (link?.pageId && this.livePages.has(link.pageId)) return link.pageId;
    if (link?.pageId) {
      try {
        const page = await client.retrievePage(link.pageId);
        if (!page.archived && !page.in_trash) {
          this.livePages.add(link.pageId);
          return link.pageId;
        }
      } catch (e) {
        if (!(e instanceof NotionError && (e.isNotFound || e.status === 400))) throw e;
      }
    }
    const item = await this.opts.source.item(id);
    if (!item) return null;
    const found = await this.findPage(client, databaseId, id);
    const page =
      found ??
      (await client.createPage({
        parent: { database_id: databaseId },
        icon: { type: 'emoji', emoji: KIND_EMOJI[item.kind] },
        properties: pageProperties(item),
      }));
    this.livePages.add(page.id);
    await this.opts.source.setLink(id, { pageId: page.id, url: page.url, blocks: [], syncedAt: Date.now(), syncedRev: -1, error: null });
    this.opts.onPageCreated?.(id);
    return page.id;
  }

  private async doSync(id: string): Promise<{ url: string | null; pageId: string }> {
    const { source } = this.opts;
    if (!this.isConfigured()) throw new Error('Notion n’est pas connecté : ouvrez les réglages');
    const client = this.client();
    let link = await source.getLink(id);
    try {
      const databaseId = await this.ensureDatabase(client);
      const item = await source.item(id);
      if (!item) throw new Error('Note introuvable');

      // Linked notes: their pages (mentions in the content, "Liens" relation).
      const linked = new Map<string, string>();
      for (const title of item.links) {
        const target = await source.resolveTitle(title);
        if (!target || target === id) continue;
        const pageId = await this.ensurePage(client, databaseId, target);
        if (pageId) linked.set(normalizeTitle(title), pageId);
      }
      link = await source.getLink(id);
      const specs = this.buildBlocks(item, (title) => linked.get(normalizeTitle(title)) ?? null);
      // Captures are read once: a missing one is part of the fingerprint, so it is sent once it exists.
      const files = new Map<string, Uint8Array | null>();
      for (const spec of specs) {
        if (spec.type !== 'image') continue;
        if (!files.has(spec.asset)) files.set(spec.asset, await source.readAsset(spec.asset));
        spec.missing = !files.get(spec.asset);
      }
      const hashes = specs.map(hashBlock);
      const properties = pageProperties(item, [...new Set(linked.values())]);
      const icon = { type: 'emoji', emoji: KIND_EMOJI[item.kind] };

      let pageId = link?.pageId ?? null;
      let url = link?.url ?? null;
      let blocks: NotionBlockRef[] = link?.blocks ?? [];
      /** Blocks of an adopted page, written by another device: replaced. */
      let foreign: string[] = [];
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
        blocks = [];
        const found = await this.findPage(client, databaseId, id);
        if (found) {
          pageId = found.id;
          url = found.url ?? null;
          await client.updatePage(pageId, { properties, icon });
          foreign = (await client.listChildren(pageId)).map((b) => b.id);
        } else {
          const page = await client.createPage({ parent: { database_id: databaseId }, icon, properties });
          pageId = page.id;
          url = page.url ?? null;
        }
      }
      this.livePages.add(pageId);

      let prefix = 0;
      while (prefix < blocks.length && prefix < hashes.length && blocks[prefix].hash === hashes[prefix]) prefix++;
      const save = (refs: NotionBlockRef[]) =>
        source.setLink(id, { pageId: pageId!, url: url ?? undefined, blocks: refs, syncedAt: Date.now(), syncedRev: item.rev, error: null });

      // Remove what changed, then append the new tail (saved batch by batch: no duplicates after a failure).
      for (const blockId of [...foreign, ...blocks.slice(prefix).map((b) => b.id)]) {
        await client.deleteBlock(blockId).catch((e: unknown) => {
          if (!(e instanceof NotionError && (e.isNotFound || e.status === 400))) throw e;
        });
      }
      blocks = blocks.slice(0, prefix);
      await save(blocks);

      const upload = async (asset: string): Promise<string | null> => {
        const data = files.get(asset) ?? null;
        if (!data) return null;
        const src = asset.startsWith('source:') ? (item.sources?.find((s) => `source:${s.id}` === asset)?.source ?? item.source) : '';
        const name = src ? baseName(src) : baseName(asset);
        return client.uploadFile(name, mimeOf(name), data);
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
      const current = (await source.getLink(id)) ?? link;
      if (current) await source.setLink(id, { ...current, error: explainNotionError(e) });
      throw e;
    }
  }
}

export { explainNotionError };
