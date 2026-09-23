import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { findPageRefs, findTimestamps, toPortableMarkdown } from '../../../src/shared/markdown';
import { formatTimecode } from '../../../src/shared/time';
import { parseFrontMatter, serializeFrontMatter } from './frontmatter';
import type { ExtensionNote, Highlight, LibraryItem, MediaKind, NotionLink, StudyStatus } from './types';

const LIBRARY_FILE = join('.boo', 'library.json');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv']);

/** File types the app opens: PDF documents, audio and video files. */
export function kindForFile(path: string): MediaKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

export const OPEN_FILE_FILTERS = [
  { name: 'Cours (PDF, audio, vidéo)', extensions: ['pdf', ...[...AUDIO_EXT, ...VIDEO_EXT].map((e) => e.slice(1))] },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Audio', extensions: [...AUDIO_EXT].map((e) => e.slice(1)) },
  { name: 'Vidéo', extensions: [...VIDEO_EXT].map((e) => e.slice(1)) },
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name valid on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  let out = name
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out;
}

/** Number of timestamps / page references: one per written idea. */
export function countNotes(markdown: string): number {
  return findTimestamps(markdown).length + findPageRefs(markdown).length;
}

/** 0..1: how much of the course has been covered (furthest point reached). */
export function progressRatio(item: Pick<LibraryItem, 'progress' | 'furthest' | 'kind'>): number {
  const p = item.progress;
  if (!p || !(p.duration > 0)) return 0;
  const reached = Math.max(p.position, item.furthest ?? 0);
  return Math.min(1, Math.max(0, reached / p.duration));
}

export function studyStatus(item: LibraryItem): StudyStatus {
  if (item.status) return item.status;
  const ratio = progressRatio(item);
  if (item.kind === 'pdf' ? ratio >= 1 : ratio >= 0.95) return 'done';
  if (ratio > 0 || (item.noteCount ?? 0) > 0) return 'doing';
  return 'todo';
}

/** `12:34 / 45:00` or `p. 12 / 240`. */
export function positionLabel(item: LibraryItem): string {
  const p = item.progress;
  if (!p) return '';
  if (item.kind === 'pdf') return `p. ${Math.max(1, Math.round(p.position))}${p.duration ? ` / ${p.duration}` : ''}`;
  return p.duration ? `${formatTimecode(p.position)} / ${formatTimecode(p.duration)}` : formatTimecode(p.position);
}

interface LibraryFile {
  version: 1;
  items: Record<string, LibraryItem>;
}

/** What changed: Notion sync reacts to content / progress, never to its own `notion` updates. */
export type ChangeReason = 'reload' | 'content' | 'progress' | 'meta' | 'notion' | 'removed';

export interface LibraryEvents {
  changed: [id: string | null, reason: ChangeReason];
}

/**
 * The vault: one Markdown file per course (readable by any editor, Obsidian…),
 * screenshots in `assets/`, and `.boo/library.json` for what Markdown cannot
 * hold (progress, highlights, Notion mapping).
 */
export class Library extends EventEmitter<LibraryEvents> {
  private items: Record<string, LibraryItem> = {};
  private chain: Promise<unknown> = Promise.resolve();
  /** Positions received before their note (extension). */
  private pendingProgress = new Map<string, { position: number; duration: number; updatedAt: number }>();

  constructor(private root: string) {
    super();
  }

  get path(): string {
    return this.root;
  }

  async open(root = this.root): Promise<void> {
    this.root = resolve(root);
    await mkdir(join(this.root, 'assets'), { recursive: true });
    await mkdir(join(this.root, '.boo'), { recursive: true });
    try {
      const data = JSON.parse(await readFile(join(this.root, LIBRARY_FILE), 'utf8')) as LibraryFile;
      this.items = data.items ?? {};
    } catch {
      this.items = {};
    }
    this.emit('changed', null, 'reload');
  }

  list(): LibraryItem[] {
    return Object.values(this.items).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): LibraryItem | undefined {
    return this.items[id];
  }

  require(id: string): LibraryItem {
    const item = this.items[id];
    if (!item) throw new Error('Élément introuvable dans la bibliothèque');
    return item;
  }

  noteFilePath(item: LibraryItem): string {
    return this.inside(item.noteFile);
  }

  /** Absolute path of a vault-relative path, refusing anything outside the vault. */
  inside(rel: string): string {
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error('Chemin hors du dossier de notes');
    return abs;
  }

  assetPath(rel: string): string {
    if (!/^assets\/[\w][\w.-]{0,200}$/.test(rel)) throw new Error('Nom de capture invalide');
    return this.inside(rel);
  }

  // --- Notes written in the browser extension -----------------------------------------

  upsertFromExtension(note: ExtensionNote, portableMarkdown?: string): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const existing = this.items[note.id];
      if (existing && existing.rev >= note.rev) return existing;
      const noteFile = existing?.noteFile ?? (await this.uniqueNoteFile(note.title, note.id));
      const portable = portableMarkdown ?? toPortableMarkdown(note);
      await this.writeText(noteFile, portable);
      const item: LibraryItem = {
        ...existing,
        id: note.id,
        origin: 'extension',
        kind: note.kind ?? existing?.kind ?? 'video',
        platform: note.platform,
        title: note.title || existing?.title || note.id,
        source: note.url,
        noteFile,
        rev: note.rev,
        createdAt: existing?.createdAt ?? note.createdAt,
        updatedAt: Math.max(note.updatedAt, existing?.updatedAt ?? 0),
        noteCount: countNotes(note.markdown),
      };
      const pending = this.pendingProgress.get(note.id);
      if (pending) {
        this.pendingProgress.delete(note.id);
        applyProgress(item, pending.position, pending.duration, pending.updatedAt);
      }
      this.items[note.id] = item;
      await this.persist();
      this.emit('changed', note.id, 'content');
      return item;
    });
  }

  putAsset(rel: string, data: Buffer): Promise<void> {
    const file = this.assetPath(rel);
    return this.exclusive(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
    });
  }

  // --- Local files studied in the app ---------------------------------------------

  addLocalFile(filePath: string): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const abs = resolve(filePath);
      const kind = kindForFile(abs);
      if (!kind) throw new Error(`Format non pris en charge : ${basename(abs)}`);
      const info = await stat(abs);
      if (!info.isFile()) throw new Error(`${basename(abs)} n’est pas un fichier`);
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      const id = `file:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
      const existing = this.items[id];
      if (existing) return existing;
      const title = basename(abs, extname(abs));
      const now = Date.now();
      const noteFile = await this.uniqueNoteFile(title, id);
      const item: LibraryItem = {
        id,
        origin: 'desktop',
        kind,
        platform: 'local',
        title,
        source: abs,
        noteFile,
        rev: 0,
        createdAt: now,
        updatedAt: now,
        noteCount: 0,
      };
      await this.writeText(noteFile, this.desktopMarkdown(item, ''));
      this.items[id] = item;
      await this.persist();
      this.emit('changed', id, 'content');
      return item;
    });
  }

  /** Body of the note (front matter removed). */
  async readNote(id: string): Promise<string> {
    const item = this.require(id);
    try {
      return parseFrontMatter(await readFile(this.noteFilePath(item), 'utf8')).body;
    } catch {
      return '';
    }
  }

  /** Saves a note written in the app (local files only: extension notes are edited in the browser). */
  saveNote(id: string, markdown: string): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const item = this.require(id);
      if (item.origin !== 'desktop') throw new Error('Cette note se modifie dans l’extension du navigateur');
      const next: LibraryItem = { ...item, rev: item.rev + 1, updatedAt: Date.now(), noteCount: countNotes(markdown) };
      await this.writeText(item.noteFile, this.desktopMarkdown(next, markdown));
      this.items[id] = next;
      await this.persist();
      this.emit('changed', id, 'content');
      return next;
    });
  }

  /** Screenshot of a local video, stored like the extension's. */
  async saveCapture(id: string, data: Buffer, seconds: number, ext: 'jpg' | 'png' | 'webp'): Promise<string> {
    const item = this.require(id);
    const tc = formatTimecode(seconds).replace(/:/g, '-');
    const slug = safeFileName(item.title).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'capture';
    const rel = `assets/${slug}-${tc}-${randomBytes(3).toString('hex')}.${ext}`;
    await this.putAsset(rel, data);
    return rel;
  }

  // --- Study tracking ------------------------------------------------------------------

  setProgress(id: string, position: number, duration: number, updatedAt = Date.now()): Promise<LibraryItem | null> {
    return this.exclusive(async () => {
      const item = this.items[id];
      if (!item) {
        this.pendingProgress.set(id, { position, duration, updatedAt });
        return null;
      }
      const next = { ...item };
      applyProgress(next, position, duration, updatedAt);
      this.items[id] = next;
      await this.persist();
      this.emit('changed', id, 'progress');
      return next;
    });
  }

  addStudyTime(id: string, ms: number): Promise<void> {
    return this.exclusive(async () => {
      const item = this.items[id];
      if (!item || !(ms > 0)) return;
      this.items[id] = { ...item, studyMs: (item.studyMs ?? 0) + Math.min(ms, 10 * 60_000) };
      await this.persist();
    });
  }

  setHighlights(id: string, highlights: Highlight[]): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const item = this.require(id);
      this.items[id] = { ...item, highlights, updatedAt: Date.now() };
      await this.persist();
      this.emit('changed', id, 'content');
      return this.items[id];
    });
  }

  update(id: string, patch: { title?: string; status?: StudyStatus | null }): Promise<LibraryItem> {
    return this.exclusive(async () => {
      const item = this.require(id);
      const next: LibraryItem = { ...item };
      if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim();
      if (patch.status !== undefined) {
        if (patch.status === null) delete next.status;
        else next.status = patch.status;
      }
      next.updatedAt = Date.now();
      if (next.origin === 'desktop' && patch.title !== undefined) {
        const body = parseFrontMatter(await readFile(this.noteFilePath(item), 'utf8').catch(() => '')).body;
        next.rev = item.rev + 1;
        await this.writeText(item.noteFile, this.desktopMarkdown(next, body));
      }
      this.items[id] = next;
      await this.persist();
      this.emit('changed', id, 'meta');
      return next;
    });
  }

  setNotion(id: string, link: NotionLink | undefined): Promise<void> {
    return this.exclusive(async () => {
      const item = this.items[id];
      if (!item) return;
      const next = { ...item };
      if (link) next.notion = link;
      else delete next.notion;
      this.items[id] = next;
      await this.persist();
      this.emit('changed', id, 'notion');
    });
  }

  /** Forgets every Notion mapping (other workspace / database). */
  clearNotion(): Promise<void> {
    return this.exclusive(async () => {
      for (const [id, item] of Object.entries(this.items)) {
        if (!item.notion) continue;
        const next = { ...item };
        delete next.notion;
        this.items[id] = next;
      }
      await this.persist();
      this.emit('changed', null, 'notion');
    });
  }

  remove(id: string, opts: { deleteNote?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const item = this.items[id];
      if (!item) return;
      delete this.items[id];
      if (opts.deleteNote) await rm(this.noteFilePath(item), { force: true });
      await this.persist();
      this.emit('changed', id, 'removed');
    });
  }

  // --- Internals ---------------------------------------------------------------------

  private desktopMarkdown(item: LibraryItem, body: string): string {
    return serializeFrontMatter(
      {
        title: item.title,
        source: item.source,
        kind: item.kind,
        created: new Date(item.createdAt).toISOString(),
        updated: new Date(item.updatedAt).toISOString(),
      },
      body,
    );
  }

  private async uniqueNoteFile(title: string, id: string): Promise<string> {
    const base = safeFileName(title) || safeFileName(id.replace(/[:/]+/g, '-')) || 'Note';
    const taken = new Set(Object.values(this.items).map((i) => i.noteFile.toLowerCase()));
    for (let n = 1; ; n++) {
      const name = n === 1 ? `${base}.md` : `${base} (${n}).md`;
      if (taken.has(name.toLowerCase())) continue;
      const exists = await stat(this.inside(name)).then(
        () => true,
        () => false,
      );
      if (!exists) return name;
    }
  }

  private async writeText(rel: string, text: string): Promise<void> {
    const file = this.inside(rel);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  }

  private async persist(): Promise<void> {
    const data: LibraryFile = { version: 1, items: this.items };
    await this.writeText(LIBRARY_FILE, `${JSON.stringify(data, null, 2)}\n`);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Vault-relative path (for display). */
  relative(abs: string): string {
    return relative(this.root, abs);
  }
}

function applyProgress(item: LibraryItem, position: number, duration: number, updatedAt: number): void {
  const pos = Number.isFinite(position) ? Math.max(0, position) : 0;
  const dur = Number.isFinite(duration) && duration > 0 ? duration : (item.progress?.duration ?? 0);
  item.progress = { position: pos, duration: dur, updatedAt };
  item.furthest = Math.max(item.furthest ?? 0, pos);
  item.updatedAt = Math.max(item.updatedAt, updatedAt);
}
