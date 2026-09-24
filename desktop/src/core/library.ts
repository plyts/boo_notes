import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { countNotes, findAnchors, linkedTitles, normalizeTitle, RESOURCE_SCHEME, toPortableMarkdown } from '../../../src/shared/markdown';
import { detectVideoContext } from '../../../src/shared/platforms';
import { formatTimecode } from '../../../src/shared/time';
import { nextInterval } from '../../../src/shared/study';
import {
  annotateCues,
  carryAnnotations,
  emptyTranscript,
  parseVtt,
  transcriptPath,
  transcriptToMarkdown,
  transcriptToVtt,
  type CuePatch,
  type Transcript,
} from '../../../src/shared/transcript';
import { parseFrontMatter, serializeFrontMatter } from './frontmatter';
import type {
  Chapter,
  Course,
  ExtensionNote,
  Highlight,
  MediaEntry,
  MediaKind,
  Note,
  NotionLink,
  Pin,
  Placement,
  Resource,
  ResourceKind,
  ReviewAction,
  StudyStatus,
  TranscriptSummary,
} from './types';

const LIBRARY_FILE = join('.boo', 'library.json');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.ogv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.avif']);
const TEXT_EXT = new Set(['.txt', '.md', '.markdown']);
/** Adaptive streams (HLS, DASH): played with a streaming library. */
const STREAM_EXT = new Set(['.m3u8', '.mpd']);

/** File types the app opens: PDF, audio, video, images (graphs, diagrams) and texts. */
export function kindForFile(path: string): ResourceKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}

/**
 * What an address points to: a media file or stream (played in the app), a
 * PDF, an image, or a web page (opened in the browser, where the extension
 * takes notes on any video or audio it plays).
 */
export function kindForUrl(url: string): ResourceKind {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error('Adresse invalide');
  }
  const ext = extname(path).toLowerCase();
  if (STREAM_EXT.has(ext)) return 'video';
  return kindForFile(path) ?? 'page';
}

export function isStreamUrl(url: string): boolean {
  try {
    return STREAM_EXT.has(extname(new URL(url).pathname).toLowerCase());
  } catch {
    return false;
  }
}

const exts = (set: Set<string>) => [...set].map((e) => e.slice(1));

export const OPEN_FILE_FILTERS = [
  {
    name: 'Tous les supports de cours',
    extensions: ['pdf', ...exts(AUDIO_EXT), ...exts(VIDEO_EXT), ...exts(IMAGE_EXT), ...exts(TEXT_EXT)],
  },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Images (graphes, schémas…)', extensions: exts(IMAGE_EXT) },
  { name: 'Textes', extensions: exts(TEXT_EXT) },
  { name: 'Audio', extensions: exts(AUDIO_EXT) },
  { name: 'Vidéo', extensions: exts(VIDEO_EXT) },
];

export { REVIEW_STEPS } from '../../../src/shared/study';
const DAY = 86_400_000;

/** End of the local day of `ts`: a review is due all day long. */
export function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function isDue(note: Pick<Note, 'review'>, now = Date.now()): boolean {
  return Boolean(note.review && note.review.next <= endOfDay(now));
}

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

/** Number of anchored notes (timestamps, pages, paragraphs, pins, quoted passages): one per written idea. */
export { countNotes };

export { positionLabel, progressRatio, studyStatus } from '../../../src/shared/study';

/** Colours given to new courses, in turn (hues well apart, readable in light and dark themes). */
const COURSE_HUES = [262, 211, 152, 28, 335, 187, 45, 290, 4, 120];
const COURSE_EMOJIS = ['📘', '📗', '📙', '📕', '📓', '🧪', '🧠', '📐', '🎧', '🎬'];

interface LibraryFileV1 {
  version: 1;
  items: Record<string, V1Item>;
}

/** Library v1: one item = one resource with its note (or a revision sheet). */
interface V1Item extends Omit<Note, 'resources'> {
  kind: MediaKind;
  platform: Resource['platform'];
  source: string;
  progress?: Resource['progress'];
  furthest?: number;
  studyMs?: number;
  highlights?: Highlight[];
  pins?: Pin[];
}

interface LibraryFileV2 {
  version: 2;
  notes: Record<string, Note>;
  resources: Record<string, Resource>;
  courses: Course[];
  /** Recorded extracts and kept sound, per note id (a browser note may send them before itself). */
  media?: Record<string, MediaEntry[]>;
  /** Transcripts, per note id. */
  transcripts?: Record<string, TranscriptSummary>;
}

/** Subtitles next to a video: `cours.vtt`, `cours.srt`, `cours.en.vtt`… */
const SUBTITLE_EXT = /\.(vtt|srt)$/i;
const MEDIA_PATH = /^media\/[\w][\w.-]{0,200}$/;

/**
 * What changed. `id` is a note id when the change concerns a note (content,
 * filing, progress of one of its resources): the Notion sync reacts to those,
 * never to its own `notion` updates. `structure`: courses / chapters / resources.
 */
export type ChangeReason = 'reload' | 'content' | 'progress' | 'meta' | 'notion' | 'removed' | 'structure' | 'transcript' | 'media';

export interface LibraryEvents {
  changed: [id: string | null, reason: ChangeReason];
}

export interface NoteInput {
  title: string;
  body?: string;
  resources?: string[];
  /** Chapter to file the note in (at the end, or at `index`). */
  placement?: Placement & { index?: number };
}

const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

/**
 * The vault: one Markdown file per note (readable by any editor, Obsidian…),
 * screenshots in `assets/`, and `.boo/library.json` for what Markdown cannot
 * hold: resources (progress, highlights, pins), courses and chapters, links
 * between notes and resources, reviews, Notion mapping.
 */
export class Library extends EventEmitter<LibraryEvents> {
  private notes: Record<string, Note> = {};
  private resources: Record<string, Resource> = {};
  private courses: Course[] = [];
  /** noteId → where it is filed (rebuilt from the courses). */
  private placements = new Map<string, Placement>();
  private media: Record<string, MediaEntry[]> = {};
  private transcripts: Record<string, TranscriptSummary> = {};
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
    let data: LibraryFileV1 | LibraryFileV2 | null = null;
    try {
      data = JSON.parse(await readFile(join(this.root, LIBRARY_FILE), 'utf8')) as LibraryFileV1 | LibraryFileV2;
    } catch {
      data = null;
    }
    if (data?.version === 1) {
      // Kept next to the new file: the upgrade never loses anything.
      await copyFile(join(this.root, LIBRARY_FILE), join(this.root, '.boo', 'library.v1.json')).catch(() => undefined);
      const migrated = migrateV1(data);
      this.notes = migrated.notes;
      this.resources = migrated.resources;
      this.courses = migrated.courses;
      this.indexPlacements();
      await this.persist();
    } else {
      this.notes = data?.notes ?? {};
      this.resources = data?.resources ?? {};
      this.courses = data?.courses ?? [];
      this.media = data?.media ?? {};
      this.transcripts = data?.transcripts ?? {};
      this.indexPlacements();
    }
    this.emit('changed', null, 'reload');
  }

  // --- Reading ---------------------------------------------------------------------------

  listNotes(): Note[] {
    // Placeholders (browser notes filed before being written) are not notes yet.
    return Object.values(this.notes)
      .filter((n) => n.noteFile)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listResources(): Resource[] {
    return Object.values(this.resources).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listCourses(): Course[] {
    return this.courses;
  }

  getNote(id: string): Note | undefined {
    return this.notes[id];
  }

  getResource(id: string): Resource | undefined {
    return this.resources[id];
  }

  getCourse(id: string): Course | undefined {
    return this.courses.find((c) => c.id === id);
  }

  requireNote(id: string): Note {
    const note = this.notes[id];
    if (!note) throw new Error('Note introuvable');
    return note;
  }

  requireResource(id: string): Resource {
    const res = this.resources[id];
    if (!res) throw new Error('Support introuvable');
    return res;
  }

  requireCourse(id: string): Course {
    const course = this.getCourse(id);
    if (!course) throw new Error('Cours introuvable');
    return course;
  }

  /** Chapter (and course) a note is filed in, null for an unfiled note. */
  placement(noteId: string): Placement | null {
    return this.placements.get(noteId) ?? null;
  }

  /** Notes linked to a resource. */
  notesOf(resourceId: string): Note[] {
    return this.listNotes().filter((n) => n.resources.includes(resourceId));
  }

  /** Resources of a note, in order (missing ones skipped). */
  resourcesOf(note: Note): Resource[] {
    return note.resources.flatMap((id) => (this.resources[id] ? [this.resources[id]] : []));
  }

  noteFilePath(note: Note): string {
    return this.inside(note.noteFile);
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

  /** Body of the note (front matter removed). */
  async readNote(id: string): Promise<string> {
    const note = this.requireNote(id);
    try {
      return parseFrontMatter(await readFile(this.noteFilePath(note), 'utf8')).body;
    } catch {
      return '';
    }
  }

  /** Content of a local text document (.txt, .md). */
  async readText(resourceId: string): Promise<string> {
    const res = this.requireResource(resourceId);
    if (res.origin !== 'file' || res.kind !== 'text') throw new Error('Ce support n’est pas un texte');
    return readFile(res.source, 'utf8');
  }

  // --- Links between notes: [[Titre]] ----------------------------------------------------

  /** Every note title (for `[[` completion). */
  titles(): string[] {
    return this.listNotes().map((n) => n.title);
  }

  /** The note a `[[Titre]]` points to: same title, ignoring case and accents (sheets first). */
  findByTitle(title: string): Note | undefined {
    const key = normalizeTitle(title);
    const matches = this.listNotes().filter((n) => normalizeTitle(n.title) === key);
    return matches.find((n) => n.resources.length === 0) ?? matches[0];
  }

  /** Notes linking to this one with `[[Titre]]`. */
  backlinks(id: string): Note[] {
    const note = this.notes[id];
    if (!note) return [];
    const key = normalizeTitle(note.title);
    return this.listNotes().filter((n) => n.id !== id && (n.links ?? []).some((t) => normalizeTitle(t) === key));
  }

  // --- Resources ----------------------------------------------------------------------------

  /** A local file as a resource (the same file is added once). */
  addFile(filePath: string): Promise<Resource> {
    return this.exclusive(() => this.addFileNow(filePath));
  }

  private async addFileNow(filePath: string): Promise<Resource> {
    const abs = resolve(filePath);
    const kind = kindForFile(abs);
    if (!kind) throw new Error(`Format non pris en charge : ${basename(abs)}`);
    const info = await stat(abs);
    if (!info.isFile()) throw new Error(`${basename(abs)} n’est pas un fichier`);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const id = `file:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
    if (this.resources[id]) return this.resources[id];
    const now = Date.now();
    const res: Resource = {
      id,
      kind,
      platform: 'local',
      title: basename(abs, extname(abs)),
      source: abs,
      origin: 'file',
      createdAt: now,
      updatedAt: now,
    };
    this.resources[id] = res;
    await this.persist();
    this.emit('changed', null, 'structure');
    return res;
  }

  /** A video / audio stream, a remote PDF or image, or a web page, by address. */
  addUrl(url: string, opts: { title?: string; kind?: ResourceKind } = {}): Promise<Resource> {
    return this.exclusive(async () => {
      const clean = url.trim();
      if (!/^https?:\/\//i.test(clean)) throw new Error('Adresse invalide : elle doit commencer par https://');
      // A lesson of a course platform: a video, studied in the browser with the extension.
      const course = detectVideoContext(clean);
      const platform = course && !course.requiresMedia ? course.platform : 'web';
      const kind = opts.kind ?? (platform !== 'web' ? 'video' : kindForUrl(clean));
      const id = `url:${createHash('sha1').update(clean).digest('hex').slice(0, 16)}`;
      if (this.resources[id]) return this.resources[id];
      const now = Date.now();
      let title = opts.title?.trim() ?? '';
      if (!title) {
        const u = new URL(clean);
        const file = decodeURIComponent(basename(u.pathname));
        title = file && extname(file) ? basename(file, extname(file)) : u.hostname;
      }
      const res: Resource = { id, kind, platform, title, source: clean, origin: 'url', createdAt: now, updatedAt: now };
      this.resources[id] = res;
      await this.persist();
      this.emit('changed', null, 'structure');
      return res;
    });
  }

  updateResource(id: string, patch: { title?: string; status?: StudyStatus | null }): Promise<Resource> {
    return this.exclusive(async () => {
      const res = this.requireResource(id);
      const next: Resource = { ...res, updatedAt: Date.now() };
      if (patch.title !== undefined && patch.title.trim()) next.title = patch.title.trim();
      if (patch.status !== undefined) {
        if (patch.status === null) delete next.status;
        else next.status = patch.status;
      }
      this.resources[id] = next;
      await this.persist();
      this.emitForResource(id, 'meta');
      return next;
    });
  }

  /** Forgets a resource (the file itself is never deleted); notes keep their text. */
  removeResource(id: string): Promise<void> {
    return this.exclusive(async () => {
      if (!this.resources[id]) return;
      const linked = this.notesOf(id);
      delete this.resources[id];
      for (const note of linked) this.notes[note.id] = { ...note, resources: note.resources.filter((r) => r !== id) };
      await this.persist();
      for (const note of linked) this.emit('changed', note.id, 'meta');
      this.emit('changed', null, 'structure');
    });
  }

  setProgress(resourceId: string, position: number, duration: number, updatedAt = Date.now()): Promise<Resource | null> {
    return this.exclusive(async () => {
      const res = this.resources[resourceId];
      if (!res) {
        this.pendingProgress.set(resourceId, { position, duration, updatedAt });
        return null;
      }
      const next = { ...res };
      applyProgress(next, position, duration, updatedAt);
      this.resources[resourceId] = next;
      await this.persist();
      this.emitForResource(resourceId, 'progress');
      return next;
    });
  }

  addStudyTime(resourceId: string, ms: number): Promise<void> {
    return this.exclusive(async () => {
      const res = this.resources[resourceId];
      if (!res || !(ms > 0)) return;
      this.resources[resourceId] = { ...res, studyMs: (res.studyMs ?? 0) + Math.min(ms, 10 * 60_000) };
      await this.persist();
    });
  }

  setHighlights(resourceId: string, highlights: Highlight[]): Promise<Resource> {
    return this.exclusive(async () => {
      const res = this.requireResource(resourceId);
      this.resources[resourceId] = { ...res, highlights, updatedAt: Date.now() };
      await this.persist();
      this.emitForResource(resourceId, 'content');
      return this.resources[resourceId];
    });
  }

  setPins(resourceId: string, pins: Pin[]): Promise<Resource> {
    return this.exclusive(async () => {
      const res = this.requireResource(resourceId);
      this.resources[resourceId] = { ...res, pins, updatedAt: Date.now() };
      await this.persist();
      this.emitForResource(resourceId, 'content');
      return this.resources[resourceId];
    });
  }

  /** Screenshot of a video, stored like the extension's. */
  async saveCapture(resourceId: string, data: Buffer, seconds: number, ext: 'jpg' | 'png' | 'webp'): Promise<string> {
    const res = this.requireResource(resourceId);
    const tc = formatTimecode(seconds).replace(/:/g, '-');
    const slug = safeFileName(res.title).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'capture';
    const rel = `assets/${slug}-${tc}-${randomBytes(3).toString('hex')}.${ext}`;
    await this.putAsset(rel, data);
    return rel;
  }

  /** A picture pasted into a note: `assets/<note>-<nonce>.<ext>`. */
  async savePastedImage(noteId: string, data: Buffer, ext: 'jpg' | 'png' | 'webp' | 'gif'): Promise<string> {
    const note = this.notes[noteId];
    if (!note) throw new Error('Note introuvable');
    const slug = safeFileName(note.title).replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    const rel = `assets/${slug}-image-${randomBytes(3).toString('hex')}.${ext}`;
    await this.putAsset(rel, data);
    return rel;
  }

  putAsset(rel: string, data: Buffer): Promise<void> {
    const file = this.assetPath(rel);
    return this.exclusive(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
    });
  }

  // --- Notes --------------------------------------------------------------------------------

  /** A new note (a revision sheet without resource), filed in a chapter when `placement` is given. */
  createNote(input: NoteInput): Promise<Note> {
    return this.exclusive(() => this.createNoteNow(input));
  }

  private async createNoteNow(input: NoteInput): Promise<Note> {
    const title = this.uniqueTitle(input.title.replace(/\s+/g, ' ').trim() || 'Nouvelle note');
    const body = input.body ?? '';
    const now = Date.now();
    const id = uid('note:');
    const note: Note = {
      id,
      origin: 'desktop',
      title,
      noteFile: await this.uniqueNoteFile(title, id),
      resources: (input.resources ?? []).filter((r) => this.resources[r]),
      rev: 0,
      createdAt: now,
      updatedAt: now,
      noteCount: countNotes(body),
      links: linkedTitles(body),
      size: body.trim().length,
    };
    await this.writeText(note.noteFile, this.noteMarkdown(note, body));
    this.notes[id] = note;
    if (input.placement) this.placeNow(id, input.placement, input.placement.index);
    await this.persist();
    this.emit('changed', id, 'content');
    return note;
  }

  /** The note a `[[Titre]]` points to, created as a revision sheet when missing. */
  ensureNote(title: string): Promise<Note> {
    const existing = this.findByTitle(title);
    if (existing) return Promise.resolve(existing);
    return this.createNote({ title });
  }

  /**
   * Files added to study: each becomes a resource, with a note to write about
   * it (its existing note when the file was already added), filed in `placement`.
   */
  importFiles(paths: string[], placement?: Placement): Promise<{ notes: Note[]; errors: string[] }> {
    return this.exclusive(async () => {
      const notes: Note[] = [];
      const errors: string[] = [];
      for (const p of paths) {
        try {
          const res = await this.addFileNow(p);
          const existing = this.notesOf(res.id)[0];
          const note = existing ?? (await this.createNoteNow({ title: res.title, resources: [res.id], placement }));
          notes.push(note);
          // Subtitles next to the video become its transcript.
          if ((res.kind === 'video' || res.kind === 'audio') && !this.transcripts[note.id]) {
            const sidecar = await findSidecar(res.source);
            if (sidecar) await this.importSubtitlesNow(note.id, sidecar).catch(() => undefined);
          }
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      return { notes, errors };
    });
  }

  /** Saves a note written in the app (browser notes are edited in the extension). */
  saveNote(id: string, markdown: string): Promise<Note> {
    return this.exclusive(async () => {
      const note = this.requireNote(id);
      if (note.origin !== 'desktop') throw new Error('Cette note se modifie dans l’extension du navigateur');
      const next: Note = {
        ...note,
        rev: note.rev + 1,
        updatedAt: Date.now(),
        noteCount: countNotes(markdown),
        links: linkedTitles(markdown),
        size: markdown.trim().length,
      };
      await this.writeText(note.noteFile, this.noteMarkdown(next, markdown));
      this.notes[id] = next;
      await this.persist();
      this.emit('changed', id, 'content');
      return next;
    });
  }

  updateNote(id: string, patch: { title?: string; status?: StudyStatus | null }): Promise<Note> {
    return this.exclusive(async () => {
      const note = this.requireNote(id);
      const next: Note = { ...note };
      if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== note.title) {
        next.title = this.uniqueTitle(patch.title.trim(), id);
      }
      if (patch.status !== undefined) {
        if (patch.status === null) delete next.status;
        else next.status = patch.status;
      }
      next.updatedAt = Date.now();
      if (next.origin === 'desktop' && next.title !== note.title) {
        const body = await this.readNote(id);
        next.rev = note.rev + 1;
        await this.writeText(note.noteFile, this.noteMarkdown(next, body));
      }
      this.notes[id] = next;
      const renamed = next.title !== note.title ? await this.renameLinks(note.title, next.title) : [];
      await this.persist();
      this.emit('changed', id, 'meta');
      for (const other of renamed) this.emit('changed', other, 'content');
      return next;
    });
  }

  removeNote(id: string, opts: { deleteFile?: boolean } = {}): Promise<void> {
    return this.exclusive(async () => {
      const note = this.notes[id];
      if (!note) return;
      this.unplace(id);
      delete this.notes[id];
      if (opts.deleteFile) await rm(this.noteFilePath(note), { force: true });
      await this.persist();
      this.emit('changed', id, 'removed');
    });
  }

  /** Links a resource to a note (at the end, or at `index`). */
  linkResource(noteId: string, resourceId: string, index?: number): Promise<Note> {
    return this.exclusive(async () => {
      const note = this.requireNote(noteId);
      this.requireResource(resourceId);
      if (note.resources.includes(resourceId)) return note;
      const list = [...note.resources];
      // The main resource of a browser note is its video / page: others go after it.
      const at = index === undefined ? list.length : Math.max(note.origin === 'extension' ? 1 : 0, Math.min(index, list.length));
      if (at === 0 && list.length > 0 && note.origin === 'desktop') {
        await this.rewriteForPrimary(note, resourceId);
      }
      list.splice(at, 0, resourceId);
      this.notes[noteId] = { ...this.notes[noteId], resources: list, updatedAt: Date.now() };
      await this.persist();
      this.emit('changed', noteId, 'meta');
      return this.notes[noteId];
    });
  }

  /**
   * Unlinks a resource. Anchors about it stay in the text (named explicitly
   * when it was the main resource), so relinking it restores them.
   */
  unlinkResource(noteId: string, resourceId: string): Promise<Note> {
    return this.exclusive(async () => {
      const note = this.requireNote(noteId);
      if (!note.resources.includes(resourceId)) return note;
      if (note.origin === 'extension' && note.resources[0] === resourceId) {
        throw new Error('Le support d’une note du navigateur ne peut pas être retiré');
      }
      const list = note.resources.filter((r) => r !== resourceId);
      if (note.resources[0] === resourceId && note.origin === 'desktop') {
        await this.rewriteForPrimary(note, list[0] ?? null);
      }
      this.notes[noteId] = { ...this.notes[noteId], resources: list, updatedAt: Date.now() };
      await this.persist();
      this.emit('changed', noteId, 'meta');
      return this.notes[noteId];
    });
  }

  /** Makes a linked resource the main one; anchors are rewritten so each keeps its target. */
  setPrimaryResource(noteId: string, resourceId: string): Promise<Note> {
    return this.exclusive(async () => {
      const note = this.requireNote(noteId);
      if (!note.resources.includes(resourceId) || note.resources[0] === resourceId) return note;
      if (note.origin === 'extension') throw new Error('Le support principal d’une note du navigateur est sa page');
      await this.rewriteForPrimary(note, resourceId);
      const list = [resourceId, ...note.resources.filter((r) => r !== resourceId)];
      this.notes[noteId] = { ...this.notes[noteId], resources: list, updatedAt: Date.now() };
      await this.persist();
      this.emit('changed', noteId, 'content');
      return this.notes[noteId];
    });
  }

  /**
   * The main resource changes from the current first one to `next`: anchors
   * without target get the old main resource as target, and anchors naming
   * `next` lose theirs.
   */
  private async rewriteForPrimary(note: Note, next: string | null): Promise<void> {
    const old = note.resources[0] ?? null;
    if (old === next) return;
    const body = await this.readNote(note.id);
    let out = '';
    let last = 0;
    for (const a of findAnchors(body)) {
      const bracket = body.slice(a.from, a.bracketTo);
      const current = a.resource ?? old;
      const target = current === next ? '' : current ? `(${RESOURCE_SCHEME}${current})` : '';
      out += body.slice(last, a.from) + bracket + target;
      last = a.to;
    }
    out += body.slice(last);
    if (out === body) return;
    const updated: Note = { ...this.notes[note.id], rev: note.rev + 1, updatedAt: Date.now() };
    await this.writeText(note.noteFile, this.noteMarkdown(updated, out));
    this.notes[note.id] = updated;
  }

  /** Spaced repetition: start, stop, or grade a review (again / good / easy). */
  review(id: string, action: ReviewAction, now = Date.now()): Promise<Note> {
    return this.exclusive(async () => {
      const note = this.requireNote(id);
      const next: Note = { ...note };
      const current = note.review;
      if (action === 'stop') delete next.review;
      else if (action === 'start') next.review = current ?? { next: now, interval: 0, count: 0 };
      else {
        const interval = nextInterval(current?.interval, action);
        next.review = {
          next: now + interval * DAY,
          interval,
          count: action === 'again' ? 0 : (current?.count ?? 0) + 1,
          last: now,
        };
      }
      this.notes[id] = next;
      await this.persist();
      this.emit('changed', id, 'meta');
      return next;
    });
  }

  // --- Transcripts and recorded media ----------------------------------------------------------

  transcriptOf(noteId: string): TranscriptSummary | null {
    return this.transcripts[noteId] ?? null;
  }

  /** The note's transcript (`transcripts/<note>.json`), null when it has none. */
  async getTranscript(noteId: string): Promise<Transcript | null> {
    try {
      return JSON.parse(await readFile(this.inside(transcriptPath(noteId, 'json')), 'utf8')) as Transcript;
    } catch {
      return null;
    }
  }

  /** A transcript from the browser extension: kept unless the vault holds a more recent one. */
  saveTranscript(t: Transcript): Promise<Transcript> {
    return this.exclusive(async () => {
      const current = await this.getTranscript(t.noteId);
      if (current && current.updatedAt > t.updatedAt && current.rev >= t.rev) return current;
      return this.writeTranscript(t);
    });
  }

  /** Translations and comments typed in the app. */
  annotateTranscript(noteId: string, patches: CuePatch[], langs: { lang?: string; target?: string } = {}): Promise<Transcript> {
    return this.exclusive(async () => {
      const t = await this.getTranscript(noteId);
      if (!t) throw new Error('Cette note n’a pas de transcription');
      return this.writeTranscript({
        ...t,
        cues: annotateCues(t.cues, patches),
        lang: langs.lang ?? t.lang,
        target: langs.target ?? t.target,
        rev: t.rev + 1,
        updatedAt: Date.now(),
      });
    });
  }

  /** A .vtt / .srt file becomes the note's transcript (translations and comments carried over). */
  importSubtitles(noteId: string, file: string): Promise<Transcript> {
    return this.exclusive(() => this.importSubtitlesNow(noteId, file));
  }

  private async importSubtitlesNow(noteId: string, file: string): Promise<Transcript> {
    const cues = parseVtt(await readFile(file, 'utf8'));
    if (!cues.length) throw new Error(`Aucun sous-titre lisible dans ${basename(file)}`);
    const prev = await this.getTranscript(noteId);
    // `cours.en.vtt` → English.
    const lang = /\.([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.(?:vtt|srt)$/i.exec(basename(file))?.[1] ?? '';
    return this.writeTranscript({
      ...emptyTranscript(noteId, { lang, label: `Fichier de sous-titres · ${basename(file)}`, source: 'file', complete: true }),
      target: prev?.target ?? 'fr',
      duration: prev?.duration ?? 0,
      cues: carryAnnotations(prev?.cues ?? [], cues),
      rev: (prev?.rev ?? 0) + 1,
    });
  }

  /** JSON for the app, Markdown and WebVTT (original, translation) for people and players. */
  private async writeTranscript(t: Transcript): Promise<Transcript> {
    const note = this.notes[t.noteId];
    const res = note?.resources[0] ? this.resources[note.resources[0]] : undefined;
    const title = note?.title || res?.title || t.noteId;
    const url = res && /^https?:\/\//.test(res.source) ? res.source : undefined;
    await this.writeText(transcriptPath(t.noteId, 'json'), `${JSON.stringify(t)}\n`);
    await this.writeText(transcriptPath(t.noteId, 'md'), transcriptToMarkdown(t, { title, url }));
    await this.writeText(transcriptPath(t.noteId, 'vtt'), transcriptToVtt(t));
    const translated = t.cues.some((c) => c.tr);
    if (translated) await this.writeText(transcriptPath(t.noteId, 'vtt').replace(/\.vtt$/, `.${t.target || 'fr'}.vtt`), transcriptToVtt(t, true));
    this.transcripts[t.noteId] = { cues: t.cues.length, lang: t.lang, label: t.label, translated, updatedAt: t.updatedAt };
    await this.persist();
    this.emit('changed', t.noteId, 'transcript');
    return t;
  }

  mediaOf(noteId: string): MediaEntry[] {
    return this.media[noteId] ?? [];
  }

  mediaPath(rel: string): string {
    if (!MEDIA_PATH.test(rel)) throw new Error('Nom d’enregistrement invalide');
    return this.inside(rel);
  }

  /** A recorded extract or stretch of sound (browser extension), stored in `media/`. */
  async putMedia(noteId: string, entry: Omit<MediaEntry, 'size' | 'createdAt'>, data: Buffer): Promise<MediaEntry> {
    const file = this.mediaPath(entry.path);
    if (!/^(audio|video)\/[\w.+-]+$/.test(entry.mime)) throw new Error('Type d’enregistrement invalide');
    return this.exclusive(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
      const record: MediaEntry = {
        path: entry.path,
        kind: entry.kind === 'audio' || entry.kind === 'file' ? entry.kind : 'passage',
        ...(entry.kind === 'file' && entry.name ? { name: String(entry.name).slice(0, 200) } : {}),
        mime: entry.mime,
        start: Number(entry.start) || 0,
        end: Number(entry.end) || 0,
        size: data.length,
        createdAt: Date.now(),
      };
      const list = (this.media[noteId] ?? []).filter((m) => m.path !== record.path);
      this.media[noteId] = [...list, record].sort((a, b) => a.start - b.start);
      await this.persist();
      this.emit('changed', noteId, 'media');
      return record;
    });
  }

  // --- Notes written in the browser extension -----------------------------------------------

  upsertFromExtension(ext: ExtensionNote, portableMarkdown?: string): Promise<Note> {
    return this.exclusive(async () => {
      const before = this.notes[ext.id]?.noteFile ? this.notes[ext.id] : undefined;
      // The extension may have synced the note with Notion itself: keep the most recent mapping.
      const link = newerLink(ext.notion, before?.notion);
      const resource = this.upsertExtensionResource(ext);
      const filed = this.fileFromExtension(ext, before);
      const placedAt = this.notes[ext.id]?.placedAt;
      if (before && before.rev >= ext.rev) {
        const next: Note = { ...before, ...(placedAt ? { placedAt } : {}) };
        if (link) next.notion = link;
        this.notes[ext.id] = next;
        await this.persist();
        if (link !== before.notion) this.emit('changed', ext.id, 'notion');
        if (filed) this.emit('changed', ext.id, 'meta');
        return next;
      }
      const noteFile = before?.noteFile ?? (await this.uniqueNoteFile(ext.title, ext.id));
      await this.writeText(noteFile, portableMarkdown ?? toPortableMarkdown(ext));
      const note: Note = {
        ...before,
        id: ext.id,
        origin: 'extension',
        title: ext.title || before?.title || ext.id,
        noteFile,
        // Its browser media first; resources linked in the app after it.
        resources: [resource.id, ...(before?.resources ?? []).filter((r) => r !== resource.id)],
        rev: ext.rev,
        createdAt: before?.createdAt ?? ext.createdAt,
        updatedAt: Math.max(ext.updatedAt, before?.updatedAt ?? 0),
        noteCount: countNotes(ext.markdown),
        links: linkedTitles(ext.markdown),
        size: ext.markdown.length,
        ...(placedAt ? { placedAt } : {}),
      };
      if (link) note.notion = link;
      this.notes[ext.id] = note;
      await this.persist();
      this.emit('changed', ext.id, 'content');
      if (filed) this.emit('changed', null, 'structure');
      return note;
    });
  }

  /** The browser media of an extension note: same id as the note. */
  private upsertExtensionResource(ext: ExtensionNote): Resource {
    const existing = this.resources[ext.id];
    const kind = (ext.kind && ext.kind !== 'note' ? ext.kind : undefined) ?? existing?.kind ?? 'video';
    const res: Resource = {
      ...existing,
      id: ext.id,
      kind,
      platform: ext.platform,
      title: ext.title || existing?.title || ext.id,
      source: ext.url,
      origin: 'extension',
      createdAt: existing?.createdAt ?? ext.createdAt,
      updatedAt: Math.max(ext.updatedAt, existing?.updatedAt ?? 0),
    };
    const pending = this.pendingProgress.get(ext.id);
    if (pending) {
      this.pendingProgress.delete(ext.id);
      applyProgress(res, pending.position, pending.duration, pending.updatedAt);
    }
    this.resources[ext.id] = res;
    return res;
  }

  /** Filing chosen in the browser (course / chapter titles): applied when more recent than the app's. */
  private fileFromExtension(ext: ExtensionNote, existing: Note | undefined): boolean {
    if (!ext.course?.trim()) {
      // Unfiled in the browser (« Retirer du cours »), after the app's last filing.
      if (!ext.placedAt || (existing?.placedAt && existing.placedAt >= ext.placedAt) || !this.placements.has(ext.id)) return false;
      this.unplace(ext.id);
      this.notes[ext.id] = { ...(this.notes[ext.id] ?? ({ id: ext.id } as Note)), placedAt: ext.placedAt };
      return true;
    }
    const at = ext.placedAt ?? ext.updatedAt;
    if (existing?.placedAt && existing.placedAt >= at) return false;
    const course =
      this.courses.find((c) => normalizeTitle(c.title) === normalizeTitle(ext.course!)) ?? this.newCourse(ext.course.trim());
    const chapterTitle = ext.chapter?.trim();
    let chapter = chapterTitle ? course.chapters.find((c) => normalizeTitle(c.title) === normalizeTitle(chapterTitle)) : course.chapters[0];
    if (!chapter) {
      chapter = { id: uid('chap:'), title: chapterTitle || 'Chapitre 1', notes: [] };
      course.chapters.push(chapter);
    }
    const current = this.placements.get(ext.id);
    if (current?.chapterId === chapter.id) return false;
    // The note is written right after: a placeholder carries the filing date until then.
    this.placeNow(ext.id, { courseId: course.id, chapterId: chapter.id });
    this.notes[ext.id] = { ...(this.notes[ext.id] ?? ({ id: ext.id } as Note)), placedAt: at };
    return true;
  }

  /** Playback / reading position sent by the extension (its media id is the note id). */
  setExtensionProgress(noteId: string, position: number, duration: number, updatedAt = Date.now()): Promise<Resource | null> {
    return this.setProgress(noteId, position, duration, updatedAt);
  }

  // --- Courses and chapters -------------------------------------------------------------------

  createCourse(input: { title: string; emoji?: string; hue?: number; description?: string }): Promise<Course> {
    return this.exclusive(async () => {
      const course = this.newCourse(input.title.trim() || 'Nouveau cours', input);
      await this.persist();
      this.emit('changed', null, 'structure');
      return course;
    });
  }

  private newCourse(title: string, input: { emoji?: string; hue?: number; description?: string } = {}): Course {
    const now = Date.now();
    const n = this.courses.length;
    const course: Course = {
      id: uid('course:'),
      title,
      emoji: input.emoji || COURSE_EMOJIS[n % COURSE_EMOJIS.length],
      hue: Number.isFinite(input.hue) ? Math.round(input.hue as number) % 360 : COURSE_HUES[n % COURSE_HUES.length],
      ...(input.description ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
      chapters: [{ id: uid('chap:'), title: 'Chapitre 1', notes: [] }],
    };
    this.courses.push(course);
    return course;
  }

  updateCourse(id: string, patch: { title?: string; emoji?: string; hue?: number; description?: string }): Promise<Course> {
    return this.exclusive(async () => {
      const course = this.requireCourse(id);
      if (patch.title !== undefined && patch.title.trim()) course.title = patch.title.trim();
      if (patch.emoji !== undefined && patch.emoji.trim()) course.emoji = patch.emoji.trim();
      if (patch.hue !== undefined && Number.isFinite(patch.hue)) course.hue = ((Math.round(patch.hue) % 360) + 360) % 360;
      if (patch.description !== undefined) course.description = patch.description.trim() || undefined;
      course.updatedAt = Date.now();
      await this.persist();
      this.emitForCourse(course, 'meta');
      return course;
    });
  }

  /** Deletes a course: its notes are kept, unfiled. */
  removeCourse(id: string): Promise<void> {
    return this.exclusive(async () => {
      const course = this.getCourse(id);
      if (!course) return;
      const notes = course.chapters.flatMap((c) => c.notes);
      this.courses = this.courses.filter((c) => c.id !== id);
      this.indexPlacements();
      await this.persist();
      for (const n of notes) this.emit('changed', n, 'meta');
      this.emit('changed', null, 'structure');
    });
  }

  moveCourse(id: string, index: number): Promise<void> {
    return this.exclusive(async () => {
      const from = this.courses.findIndex((c) => c.id === id);
      if (from === -1) return;
      const [course] = this.courses.splice(from, 1);
      this.courses.splice(Math.max(0, Math.min(index, this.courses.length)), 0, course);
      await this.persist();
      this.emit('changed', null, 'structure');
    });
  }

  addChapter(courseId: string, title?: string, index?: number): Promise<Chapter> {
    return this.exclusive(async () => {
      const course = this.requireCourse(courseId);
      const chapter: Chapter = { id: uid('chap:'), title: title?.trim() || `Chapitre ${course.chapters.length + 1}`, notes: [] };
      course.chapters.splice(index === undefined ? course.chapters.length : Math.max(0, Math.min(index, course.chapters.length)), 0, chapter);
      course.updatedAt = Date.now();
      await this.persist();
      this.emit('changed', null, 'structure');
      return chapter;
    });
  }

  updateChapter(courseId: string, chapterId: string, patch: { title?: string }): Promise<Chapter> {
    return this.exclusive(async () => {
      const course = this.requireCourse(courseId);
      const chapter = course.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new Error('Chapitre introuvable');
      if (patch.title?.trim()) chapter.title = patch.title.trim();
      course.updatedAt = Date.now();
      await this.persist();
      for (const n of chapter.notes) this.emit('changed', n, 'meta');
      this.emit('changed', null, 'structure');
      return chapter;
    });
  }

  /** Deletes a chapter; its notes go to the previous chapter (a course keeps at least one). */
  removeChapter(courseId: string, chapterId: string): Promise<void> {
    return this.exclusive(async () => {
      const course = this.requireCourse(courseId);
      const i = course.chapters.findIndex((c) => c.id === chapterId);
      if (i === -1) return;
      if (course.chapters.length === 1) throw new Error('Un cours garde au moins un chapitre');
      const [removed] = course.chapters.splice(i, 1);
      const heir = course.chapters[Math.max(0, i - 1)];
      heir.notes.push(...removed.notes);
      course.updatedAt = Date.now();
      this.indexPlacements();
      await this.persist();
      for (const n of removed.notes) this.emit('changed', n, 'meta');
      this.emit('changed', null, 'structure');
    });
  }

  moveChapter(courseId: string, chapterId: string, index: number): Promise<void> {
    return this.exclusive(async () => {
      const course = this.requireCourse(courseId);
      const from = course.chapters.findIndex((c) => c.id === chapterId);
      if (from === -1) return;
      const [chapter] = course.chapters.splice(from, 1);
      course.chapters.splice(Math.max(0, Math.min(index, course.chapters.length)), 0, chapter);
      course.updatedAt = Date.now();
      await this.persist();
      this.emit('changed', null, 'structure');
    });
  }

  /** Files a note in a chapter (at `index`), or unfiles it (`null`). */
  placeNote(noteId: string, dest: (Placement & { index?: number }) | null): Promise<void> {
    return this.exclusive(async () => {
      this.requireNote(noteId);
      if (dest) this.placeNow(noteId, dest, dest.index);
      else this.unplace(noteId);
      this.notes[noteId] = { ...this.notes[noteId], placedAt: Date.now() };
      await this.persist();
      this.emit('changed', noteId, 'meta');
      this.emit('changed', null, 'structure');
    });
  }

  private placeNow(noteId: string, dest: Placement, index?: number): void {
    const course = this.requireCourse(dest.courseId);
    const chapter = course.chapters.find((c) => c.id === dest.chapterId);
    if (!chapter) throw new Error('Chapitre introuvable');
    this.unplace(noteId);
    const at = index === undefined ? chapter.notes.length : Math.max(0, Math.min(index, chapter.notes.length));
    chapter.notes.splice(at, 0, noteId);
    course.updatedAt = Date.now();
    this.placements.set(noteId, { courseId: course.id, chapterId: chapter.id });
  }

  private unplace(noteId: string): void {
    for (const course of this.courses) {
      for (const chapter of course.chapters) {
        const i = chapter.notes.indexOf(noteId);
        if (i !== -1) chapter.notes.splice(i, 1);
      }
    }
    this.placements.delete(noteId);
  }

  private indexPlacements(): void {
    this.placements.clear();
    for (const course of this.courses) {
      for (const chapter of course.chapters) {
        // A note is in one chapter only.
        chapter.notes = chapter.notes.filter((id) => !this.placements.has(id));
        for (const id of chapter.notes) this.placements.set(id, { courseId: course.id, chapterId: chapter.id });
      }
    }
  }

  // --- Notion -------------------------------------------------------------------------------

  setNotion(noteId: string, link: NotionLink | undefined): Promise<void> {
    return this.exclusive(async () => {
      const note = this.notes[noteId];
      if (!note) return;
      const next = { ...note };
      if (link) next.notion = link;
      else delete next.notion;
      this.notes[noteId] = next;
      await this.persist();
      this.emit('changed', noteId, 'notion');
    });
  }

  /** Forgets every Notion mapping (other workspace / database). */
  clearNotion(): Promise<void> {
    return this.exclusive(async () => {
      for (const [id, note] of Object.entries(this.notes)) {
        if (!note.notion) continue;
        const next = { ...note };
        delete next.notion;
        this.notes[id] = next;
      }
      await this.persist();
      this.emit('changed', null, 'notion');
    });
  }

  // --- Internals ------------------------------------------------------------------------------

  private emitForResource(resourceId: string, reason: ChangeReason): void {
    const notes = this.notesOf(resourceId);
    for (const n of notes) this.emit('changed', n.id, reason);
    if (!notes.length) this.emit('changed', null, 'structure');
  }

  private emitForCourse(course: Course, reason: ChangeReason): void {
    for (const chapter of course.chapters) for (const n of chapter.notes) this.emit('changed', n, reason);
    this.emit('changed', null, 'structure');
  }

  /** Titles stay unique, so `[[Titre]]` always finds one note. */
  private uniqueTitle(title: string, except?: string): string {
    const taken = new Set(
      Object.values(this.notes)
        .filter((n) => n.id !== except && n.title)
        .map((n) => normalizeTitle(n.title)),
    );
    if (!taken.has(normalizeTitle(title))) return title;
    for (let n = 2; ; n++) {
      const candidate = `${title} (${n})`;
      if (!taken.has(normalizeTitle(candidate))) return candidate;
    }
  }

  /** `[[Ancien titre]]` → `[[Nouveau titre]]` in the notes written in the app. Returns the ids changed. */
  private async renameLinks(from: string, to: string): Promise<string[]> {
    const key = normalizeTitle(from);
    const changed: string[] = [];
    for (const other of Object.values(this.notes)) {
      if (other.origin !== 'desktop' || !(other.links ?? []).some((t) => normalizeTitle(t) === key)) continue;
      const body = parseFrontMatter(await readFile(this.noteFilePath(other), 'utf8').catch(() => '')).body;
      const rewritten = body.replace(/\[\[([^[\]\n|]{1,200}?)((?:\|[^[\]\n]{1,200}?)?)\]\]/g, (all, title: string, alias: string) =>
        normalizeTitle(title) === key ? `[[${to}${alias}]]` : all,
      );
      if (rewritten === body) continue;
      const next: Note = { ...other, rev: other.rev + 1, updatedAt: Date.now(), links: linkedTitles(rewritten) };
      await this.writeText(other.noteFile, this.noteMarkdown(next, rewritten));
      this.notes[other.id] = next;
      changed.push(other.id);
    }
    return changed;
  }

  private noteMarkdown(note: Note, body: string): string {
    const primary = note.resources[0] ? this.resources[note.resources[0]] : undefined;
    const placement = this.placements.get(note.id);
    const course = placement ? this.getCourse(placement.courseId) : undefined;
    const chapter = course?.chapters.find((c) => c.id === placement?.chapterId);
    return serializeFrontMatter(
      {
        title: note.title,
        source: primary?.source || undefined,
        kind: primary?.kind ?? 'note',
        course: course?.title,
        chapter: chapter?.title,
        created: new Date(note.createdAt).toISOString(),
        updated: new Date(note.updatedAt).toISOString(),
      },
      body,
    );
  }

  private async uniqueNoteFile(title: string, id: string): Promise<string> {
    const base = safeFileName(title) || safeFileName(id.replace(/[:/]+/g, '-')) || 'Note';
    const taken = new Set(Object.values(this.notes).flatMap((n) => (n.noteFile ? [n.noteFile.toLowerCase()] : [])));
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
    // Placeholders created while filing a browser note that is not written yet are not saved.
    const notes = Object.fromEntries(Object.entries(this.notes).filter(([, n]) => n.noteFile));
    const data: LibraryFileV2 = {
      version: 2,
      notes,
      resources: this.resources,
      courses: this.courses,
      ...(Object.keys(this.media).length ? { media: this.media } : {}),
      ...(Object.keys(this.transcripts).length ? { transcripts: this.transcripts } : {}),
    };
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

/** v1 → v2: each item becomes a note, and — unless it was a revision sheet — a resource it is linked to. */
export function migrateV1(data: LibraryFileV1): Omit<LibraryFileV2, 'version'> {
  const notes: Record<string, Note> = {};
  const resources: Record<string, Resource> = {};
  for (const item of Object.values(data.items ?? {})) {
    const { kind, platform, source, progress, furthest, studyMs, highlights, pins, status, ...rest } = item;
    const note: Note = { ...rest, resources: [] };
    if (kind !== 'note') {
      resources[item.id] = {
        id: item.id,
        kind,
        platform,
        title: item.title,
        source,
        origin: item.origin === 'extension' ? 'extension' : 'file',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(progress ? { progress } : {}),
        ...(furthest !== undefined ? { furthest } : {}),
        ...(studyMs !== undefined ? { studyMs } : {}),
        ...(highlights ? { highlights } : {}),
        ...(pins ? { pins } : {}),
        ...(status ? { status } : {}),
      };
      note.resources = [item.id];
    } else if (status) {
      note.status = status;
    }
    notes[item.id] = note;
  }
  return { notes, resources, courses: [] };
}

function newerLink(incoming: NotionLink | undefined, current: NotionLink | undefined): NotionLink | undefined {
  if (!incoming?.pageId || !Array.isArray(incoming.blocks)) return current;
  if (!current || incoming.syncedAt > current.syncedAt) return incoming;
  return current;
}

function applyProgress(res: Resource, position: number, duration: number, updatedAt: number): void {
  const pos = Number.isFinite(position) ? Math.max(0, position) : 0;
  const dur = Number.isFinite(duration) && duration > 0 ? duration : (res.progress?.duration ?? 0);
  res.progress = { position: pos, duration: dur, updatedAt };
  res.furthest = Math.max(res.furthest ?? 0, pos);
  res.updatedAt = Math.max(res.updatedAt, updatedAt);
}

/** Subtitles next to a media file: same name, `.vtt` / `.srt` (a language suffix allowed), the one without suffix first. */
export async function findSidecar(mediaFile: string): Promise<string | null> {
  const dir = dirname(mediaFile);
  const stem = basename(mediaFile, extname(mediaFile)).toLowerCase();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const candidates = names.filter((n) => {
    if (!SUBTITLE_EXT.test(n)) return false;
    const base = n.toLowerCase().replace(SUBTITLE_EXT, '');
    return base === stem || (base.startsWith(`${stem}.`) && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(base.slice(stem.length + 1)));
  });
  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0] ? join(dir, candidates[0]) : null;
}
