import { providerLabel, type AiProviderId } from '../ai-providers';
import { normalizeTitle } from '../markdown';
import { KIND_LABELS, PLATFORM_LABELS, type MediaKind, type Platform } from '../platforms';
import { STATUS_LABELS, type StudyStatus } from '../study';
import { timestampUrl } from '../platforms';
import { coverage, isStale, POINT_LABELS, withoutSummary, type CourseSummary, type LessonSummary, type PlanNode } from '../summary';
import { formatTimecode } from '../time';
import { TRANSCRIPT_LINE, type Transcript } from '../transcript';
import { blockCount, hashBlock, markdownToBlocks, notionPageUrl, plainRichText, safeUrl, toNotion, transcriptBlocks, type BlockSpec, type Json, type RichText } from './blocks';
import { explainNotionError, NotionClient, NotionError, parseNotionId, type NotionBlock, type NotionClientOptions, type NotionPage } from './client';

/**
 * Notion synchronisation shared by the desktop app and the browser extension.
 *
 * Everything lives in one **vault**, a page named by the user (« Boo Notes »
 * by default), never two:
 *
 *   👻 Boo Notes                 the vault: a word of welcome, then
 *      🗂️ Toutes les notes        the table: one page per note (video, audio, PDF,
 *                                 text, image, web page or revision sheet)
 *      📘 AI Orchestration        one page per course: its lessons by chapter,
 *      📘 Databricks Agents       each a link to its note, ticked once done
 *      📥 Notes à ranger          the notes filed in no course
 *
 * A note's page: where it is filed (its course page, its chapter), the
 * video or the page it was taken on, the note, and its transcript folded by
 * stretches of the video. `[[Titre]]` links become page mentions and fill
 * the "Liens" relation (Notion shows the reverse "Liée depuis").
 *
 * Idempotent: the vault, its table, each course page and each note's page
 * are found again (by their place and their « Boo ID ») before anything is
 * created. Content is synced incrementally: blocks are fingerprinted, and
 * only the blocks after the first difference are rewritten (notes grow at
 * the end).
 */

/** Title of the table of the first versions (an inline table in the chosen page): still recognised. */
export const DATABASE_TITLE = 'Boo Notes — Mes notes';
/** The table of the vault. */
export const NOTES_TABLE_TITLE = 'Toutes les notes';
export const DEFAULT_VAULT_NAME = 'Boo Notes';
const VAULT_ICON = '👻';
const VAULT_COVER = 'https://www.notion.so/images/page-cover/gradients_8.png';
const COURSE_ICON = '📘';
const UNFILED_ICON = '📥';
const UNFILED_TITLE = 'Notes à ranger';

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
  /** The course its page was last listed in (null: filed nowhere): its course page follows it. */
  course?: string | null;
}

/** A vault found in the workspace: the page holding a Boo Notes table. */
export interface NotionVault {
  pageId: string;
  name: string;
  databaseId: string;
  url: string | null;
}

/** A lesson as its course's page lists it. */
export interface CourseEntry {
  id: string;
  title: string;
  kind: MediaKind;
  chapter: string | null;
  status: StudyStatus;
  /** 0..1 */
  ratio: number;
}

/** Mirror of a course in Notion: its page in the vault, the blocks Boo Notes wrote in it. */
export interface CoursePageLink {
  pageId: string;
  url?: string;
  blocks: string[];
  /** Fingerprint of what was written (unchanged: nothing to write). */
  hash: string;
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
  /** Subtitles of the media: a « Transcription » section ends the page. */
  transcript?: Transcript | null;
  /** Its AI summary: a « Résumé IA » section opens the page (undefined: not known on this device). */
  summary?: LessonSummary | null;
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
  /** The notes filed in a course (null: in none), their lessons in order: its page lists them. Absent: no course pages. */
  courseEntries?(course: string | null): Promise<CourseEntry[]>;
  getCoursePage?(key: string): Promise<CoursePageLink | undefined>;
  setCoursePage?(key: string, link: CoursePageLink | undefined): Promise<void>;
  /** The course's AI summary (null: none): its page opens with it. */
  courseSummary?(course: string): Promise<CourseSummary | null>;
}

export interface EngineConfig {
  token: string;
  /** The vault: the page holding the table and the course pages. */
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

const COURSE_PROPERTY_NAME = 'Cours';
const CHAPTER_PROPERTY_NAME = 'Chapitre';
const ID_PROPERTY_NAME = 'Boo ID';
export const LINKS_PROPERTY = 'Liens';
export const COURSE_PROPERTY = COURSE_PROPERTY_NAME;
export const CHAPTER_PROPERTY = CHAPTER_PROPERTY_NAME;
export const SOURCES_PROPERTY = 'Supports';
/** Whether the note has its AI summary (and whether it is still up to date): filtered, every summary of the vault. */
export const SUMMARY_PROPERTY = 'Résumé IA';
export const TRANSCRIPT_PROPERTY = 'Transcription';
export const SUMMARY_STATES = { fresh: '✨ À jour', stale: '↻ À mettre à jour' } as const;
export const TRANSCRIPT_STATES = { full: 'Complète', partial: 'Partielle' } as const;
export const BACKLINKS_PROPERTY = 'Liée depuis';
export const ID_PROPERTY = ID_PROPERTY_NAME;

/**
 * Columns of the table: what reads at a glance — the course and the chapter,
 * how far, what it is, where it comes from. `status` properties cannot be
 * created through the API: a select is used. Tables of the first versions
 * keep their other columns (Position, Notes, Supports, Prochaine révision):
 * they are still filled there.
 */
export const DATABASE_PROPERTIES: Json = {
  Nom: { title: {} },
  [COURSE_PROPERTY_NAME]: { select: { options: [] } },
  [CHAPTER_PROPERTY_NAME]: { rich_text: {} },
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
  Source: { url: {} },
  [SUMMARY_PROPERTY]: {
    select: {
      options: [
        { name: SUMMARY_STATES.fresh, color: 'green' },
        { name: SUMMARY_STATES.stale, color: 'orange' },
      ],
    },
  },
  [TRANSCRIPT_PROPERTY]: {
    select: {
      options: [
        { name: TRANSCRIPT_STATES.full, color: 'green' },
        { name: TRANSCRIPT_STATES.partial, color: 'yellow' },
      ],
    },
  },
  'Dernière activité': { date: {} },
  [ID_PROPERTY_NAME]: { rich_text: {} },
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

/**
 * Notion page properties of a note. `links`: pages of the notes it links to
 * (omitted: unchanged); `columns`: the table's (what it lacks is left out).
 */
export function pageProperties(item: SyncItem, links?: string[], columns?: ReadonlySet<string> | null): Json {
  const props = allProperties(item, links);
  if (!columns) return props;
  return Object.fromEntries(Object.entries(props).filter(([name]) => columns.has(name)));
}

function allProperties(item: SyncItem, links?: string[]): Json {
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
  if (item.summary !== undefined) {
    props[SUMMARY_PROPERTY] = { select: item.summary ? { name: isStale(item.summary, item.transcript ?? null) ? SUMMARY_STATES.stale : SUMMARY_STATES.fresh } : null };
  }
  if (item.transcript !== undefined) {
    const state = coverage(item.transcript ?? null).state;
    props[TRANSCRIPT_PROPERTY] = { select: state === 'none' ? null : { name: TRANSCRIPT_STATES[state] } };
  }
  return props;
}

const compactId = (id: string) => id.replace(/-/g, '').toLowerCase();
const gone = (e: unknown) => e instanceof NotionError && (e.isNotFound || e.status === 400);

/** Title of a page (its title property). */
function pageTitle(page: NotionPage): string {
  const prop = Object.values(page.properties ?? {}).find((p) => (p as Json)?.title) as { title?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined;
  return (prop?.title ?? []).map((r) => r.plain_text ?? r.text?.content ?? '').join('').trim();
}

/** Key of a course page (null: the notes filed in no course). */
export function courseKey(course: string | null): string {
  return course ? `course:${normalizeTitle(course)}` : 'unfiled';
}

function courseTitle(course: string | null): string {
  return course?.trim() || UNFILED_TITLE;
}

const pct = (ratio: number) => `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)} %`;
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** The welcome of a vault Boo Notes made: what is where, in two lines. */
function vaultIntro(): BlockSpec[] {
  return [
    {
      type: 'callout',
      emoji: VAULT_ICON,
      color: 'gray_background',
      rich: [
        ...plainRichText('Vos notes de cours, au même endroit.', { bold: true }),
        ...plainRichText(
          ' Chaque cours a sa page ci-dessous : ✨ son résumé par IA, puis ses leçons par chapitre. Chaque leçon a la sienne, en trois parties : ✨ le résumé IA (problématique, objectifs, solution, plan détaillé), 📝 vos notes, 🎙️ la transcription — chaque instant rouvre la vidéo. Le tableau « Toutes les notes » les liste toutes : sa colonne « Résumé IA » retrouve chaque résumé. Tout arrive d’ici-même depuis Boo Notes.',
        ),
      ],
    },
  ];
}

// --- AI summaries -------------------------------------------------------------------------------

const dateOf = (at: number) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(at);

/** A moment, as the transcript shows it: a small code chip, a link to the video there. */
function moment(seconds: number, timeUrl: (s: number) => string | null): RichText[] {
  return [...plainRichText(' '), ...plainRichText(formatTimecode(seconds), { code: true }, safeUrl(timeUrl(seconds)))];
}

/** A point of a part: the essential one a yellow callout; a term, an example, a trap marked; its command in code under it. */
function pointBlocks(n: PlanNode, timeUrl: (s: number) => string | null): BlockSpec[] {
  const when = n.at !== null ? moment(n.at, timeUrl) : [];
  if (!n.detail) return [{ type: 'bulleted_list_item', rich: [...plainRichText(n.title), ...when] }, ...n.children.flatMap((c) => pointBlocks(c, timeUrl))];
  const kind = n.kind ?? 'point';
  const label = kind === 'point' ? null : POINT_LABELS[kind];
  const rich = [...plainRichText(label ? `${label.label} — ${n.title} : ` : `${n.title} : `, { bold: true }), ...plainRichText(n.detail), ...when];
  const out: BlockSpec[] =
    kind === 'key' ? [{ type: 'callout', emoji: '⭐', color: 'yellow_background', rich }] : [{ type: 'bulleted_list_item', rich: label ? [...plainRichText(`${label.mark} `), ...rich] : rich }];
  if (n.code) out.push({ type: 'code', text: n.code, language: 'plain text' });
  return out;
}

/**
 * The « ✨ Résumé IA » section of a lesson's page: who wrote it and when;
 * its problem, goals and solution in coloured callouts; then its plan, each
 * part with its sentence and its points — every moment a link to the video.
 */
export function lessonSummaryBlocks(s: LessonSummary, timeUrl: (seconds: number) => string | null, opts: { stale?: boolean } = {}): BlockSpec[] {
  const by = `${providerLabel(s.provider as AiProviderId) || s.provider}${s.model ? ` · ${s.model}` : ''}`;
  const out: BlockSpec[] = [
    { type: 'heading_2', rich: plainRichText('✨ Résumé IA') },
    {
      type: 'paragraph',
      color: 'gray',
      rich: [
        ...plainRichText(`Généré par IA (${by}) d’après la transcription, le ${dateOf(s.createdAt)} — à vérifier.`, { italic: true }),
        ...(opts.stale ? plainRichText(' ↻ La transcription a changé depuis : régénérez le résumé dans Boo Notes.', { italic: true, bold: true }) : []),
      ],
    },
  ];
  if (s.problem.text) out.push({ type: 'callout', emoji: '🎯', color: 'red_background', rich: [...plainRichText('Problématique — ', { bold: true }), ...plainRichText(s.problem.text), ...s.problem.at.slice(0, 1).flatMap((t) => moment(t, timeUrl))] });
  if (s.goals.length) {
    out.push({
      type: 'callout',
      emoji: '🚩',
      color: 'blue_background',
      rich: plainRichText('Objectifs', { bold: true }),
      children: s.goals.map((g) => ({ type: 'bulleted_list_item', rich: [...plainRichText(g.text), ...g.at.slice(0, 1).flatMap((t) => moment(t, timeUrl))] })),
    });
  }
  if (s.solution.text) out.push({ type: 'callout', emoji: '💡', color: 'green_background', rich: [...plainRichText('Solution — ', { bold: true }), ...plainRichText(s.solution.text), ...s.solution.at.slice(0, 1).flatMap((t) => moment(t, timeUrl))] });
  if (s.plan.length) {
    out.push({ type: 'heading_3', rich: plainRichText('🗺️ Plan du cours') });
    for (const part of s.plan) {
      const children: BlockSpec[] = [
        ...(part.intro ? [{ type: 'paragraph' as const, color: 'gray' as const, rich: plainRichText(part.intro, { italic: true }) }] : []),
        ...part.children.flatMap((c) => pointBlocks(c, timeUrl)),
      ];
      out.push({
        type: 'numbered_list_item',
        rich: [...plainRichText(part.title, { bold: true }), ...(part.at !== null ? moment(part.at, timeUrl) : [])],
        ...(children.length ? { children } : {}),
      });
    }
  }
  return out;
}

/** The « ✨ Résumé du cours » section of a course's page (each lesson's detailed plan is in its own page). */
function courseSummaryBlocks(s: CourseSummary): BlockSpec[] {
  const read = Object.keys(s.read).length;
  const out: BlockSpec[] = [
    { type: 'heading_2', rich: plainRichText('✨ Résumé du cours') },
    {
      type: 'paragraph',
      color: 'gray',
      rich: plainRichText(`Généré par IA d’après ${plural(read, 'transcription')}${s.full ? ' lues ensemble' : ''}, le ${dateOf(s.createdAt)} — à vérifier. Le plan détaillé de chaque leçon est dans sa page.`, { italic: true }),
    },
  ];
  if (s.problem) out.push({ type: 'callout', emoji: '🎯', color: 'red_background', rich: [...plainRichText('Problématique du cours — ', { bold: true }), ...plainRichText(s.problem)] });
  if (s.goals.length) {
    out.push({
      type: 'callout',
      emoji: '🚩',
      color: 'blue_background',
      rich: plainRichText('Objectifs du cours', { bold: true }),
      children: s.goals.map((g) => ({ type: 'bulleted_list_item', rich: [...plainRichText(g.text), ...(g.chapter ? plainRichText(`  · chapitre ${g.chapter}`, { color: 'gray' }) : [])] })),
    });
  }
  if (s.solution) out.push({ type: 'callout', emoji: '💡', color: 'green_background', rich: [...plainRichText('Solution — la démarche : ', { bold: true }), ...plainRichText(s.solution)] });
  out.push({ type: 'divider' });
  return out;
}

/**
 * The page of a course: how far along, then its lessons by chapter, each a
 * link to its note, ticked once done. (Progress is rounded to tens: the page
 * is not rewritten at every minute watched.)
 */
export function courseBlocks(course: string | null, rows: ReadonlyArray<CourseEntry & { pageId: string | null }>, summary: CourseSummary | null = null): BlockSpec[] {
  if (!rows.length) return [{ type: 'paragraph', rich: plainRichText('Aucune leçon rangée ici pour l’instant.', { italic: true, color: 'gray' }) }];
  const chapters = new Map<string, Array<CourseEntry & { pageId: string | null }>>();
  for (const r of rows) {
    const name = course ? r.chapter?.trim() || 'Chapitre 1' : '';
    chapters.set(name, [...(chapters.get(name) ?? []), r]);
  }
  const done = rows.filter((r) => r.status === 'done').length;
  const mean = rows.reduce((n, r) => n + r.ratio, 0) / rows.length;
  const out: BlockSpec[] = [
    course
      ? {
          type: 'callout',
          emoji: '🎯',
          color: 'blue_background',
          rich: [
            ...plainRichText(plural(rows.length, 'leçon'), { bold: true }),
            ...plainRichText(` · ${plural(chapters.size, 'chapitre')} · ${done} terminée${done > 1 ? 's' : ''} · ${pct(Math.round(mean * 10) / 10)} du cours`),
          ],
        }
      : {
          type: 'callout',
          emoji: UNFILED_ICON,
          color: 'gray_background',
          rich: plainRichText('Les notes prises hors de tout cours. Rangez-les depuis Boo Notes (« Ranger dans un cours ») : elles rejoignent la page de leur cours.'),
        },
  ];
  if (course && summary) out.push(...courseSummaryBlocks(summary));
  // The summary's words for each chapter and lesson (one sentence each).
  const chapterSynthesis = new Map((summary?.chapters ?? []).map((c) => [normalizeTitle(c.title), c.synthesis]));
  const lessonSynthesis = new Map((summary?.chapters ?? []).flatMap((c) => c.lessons.map((l) => [l.noteId, l.synthesis] as const)));
  for (const [chapter, list] of chapters) {
    if (chapter) out.push({ type: 'heading_2', rich: plainRichText(chapter) });
    const syn = chapter ? chapterSynthesis.get(normalizeTitle(chapter)) : undefined;
    if (syn) out.push({ type: 'paragraph', color: 'gray', rich: plainRichText(syn, { italic: true }) });
    for (const r of list) {
      const title: RichText[] = r.pageId
        ? [{ type: 'mention', mention: { type: 'page', page: { id: r.pageId } } }]
        : plainRichText(`${KIND_EMOJI[r.kind]} ${r.title || 'Sans titre'}`);
      const state = r.status === 'done' ? STATUS_LABELS.done : r.status === 'doing' ? `${STATUS_LABELS.doing} · ${pct(Math.round(r.ratio * 10) / 10)}` : STATUS_LABELS.todo;
      // Its sentence under it (a ticked line is struck through: the sentence stays readable).
      const about = lessonSynthesis.get(r.id);
      out.push({
        type: 'to_do',
        checked: r.status === 'done',
        rich: [...title, ...plainRichText(`  ${state}`, { color: 'gray' })],
        ...(about ? { children: [{ type: 'paragraph', color: 'gray', rich: plainRichText(about, { italic: true }) }] } : {}),
      });
    }
  }
  return out;
}

export class NotionEngine {
  private databaseChecked: string | null = null;
  /** Columns of the table (properties it lacks are not written). */
  private columns: Set<string> | null = null;
  /** Course pages to write again (a lesson came, left, changed). */
  private readonly dirtyCourses = new Map<string, string | null>();
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
    this.columns = null;
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

  /** Name of the workspace an access opens. */
  workspace(token: string): Promise<string | null> {
    return this.workspaceOf(this.client(token.trim()));
  }

  /** A page Boo Notes made and no longer needs (a second copy of its template): to Notion's trash. */
  async archive(token: string, pageId: string): Promise<void> {
    await this.client(token.trim()).updatePage(pageId, { archived: true });
  }

  private async workspaceOf(client: NotionClient): Promise<string | null> {
    try {
      const me = await client.me();
      return me.bot?.workspace_name ?? me.name ?? null;
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
  }

  /**
   * Checks the token and the target: an existing table, adopted (missing
   * columns added; its page is the vault), or a page, which becomes the vault
   * (its table found there, or created).
   */
  async connect(token: string, target: string): Promise<{ workspace: string | null; databaseId: string; url: string | null; parentId: string | null; vaultName: string | null; vaultUrl: string | null }> {
    const id = parseNotionId(target);
    if (!token.trim()) throw new Error('Collez le secret de votre intégration Notion');
    if (!id) throw new Error('Lien Notion invalide : copiez le lien de la page (Partager › Copier le lien)');
    const client = this.client(token.trim());
    const workspace = await this.workspaceOf(client);
    try {
      const db = await client.retrieveDatabase(id);
      this.columns = await this.completeSchema(client, db.id, db.properties);
      await this.opts.saveDatabase(db.id, db.url ?? null);
      this.databaseChecked = db.id;
      const parent = (db as { parent?: { type?: string; page_id?: string } }).parent;
      const vault = parent?.type === 'page_id' && parent.page_id ? await client.retrievePage(parent.page_id).catch(() => null) : null;
      return { workspace, databaseId: db.id, url: db.url ?? null, parentId: vault?.id ?? null, vaultName: vault ? pageTitle(vault) || null : null, vaultUrl: vault?.url ?? null };
    } catch (e) {
      if (!(e instanceof NotionError) || !(e.isNotFound || e.status === 400)) throw new Error(explainNotionError(e));
    }
    const vault = await this.setupVault(token, id);
    return { workspace, ...vault };
  }

  /** The vaults this access reaches: the pages holding a Boo Notes table (its « Boo ID » column). */
  async findVaults(token: string): Promise<NotionVault[]> {
    const client = this.client(token.trim());
    let found;
    try {
      found = await client.search({ filter: { property: 'object', value: 'database' }, page_size: 100 });
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    const out = new Map<string, NotionVault>();
    for (const raw of found.results as Array<{ id?: string; archived?: boolean; in_trash?: boolean; parent?: { type?: string; page_id?: string }; properties?: Json }>) {
      if (!raw.id || raw.archived || raw.in_trash || !raw.properties?.[ID_PROPERTY] || raw.parent?.type !== 'page_id' || !raw.parent.page_id) continue;
      if (out.has(compactId(raw.parent.page_id))) continue;
      const page = await client.retrievePage(raw.parent.page_id).catch(() => null);
      if (!page || page.archived || page.in_trash) continue;
      out.set(compactId(page.id), { pageId: page.id, name: pageTitle(page) || DEFAULT_VAULT_NAME, databaseId: raw.id, url: page.url ?? null });
    }
    return [...out.values()];
  }

  /** A page of the vault holding a Boo Notes table: its table (never a second one). */
  private async findTable(client: NotionClient, pageId: string): Promise<{ id: string; url?: string; properties?: Json } | null> {
    const children = await client.listChildren(pageId).catch(() => [] as NotionBlock[]);
    for (const b of children) {
      if (b.type !== 'child_database') continue;
      const db = await client.retrieveDatabase(b.id).catch(() => null);
      if (db && !db.archived && !db.in_trash && db.properties?.[ID_PROPERTY]) return db;
    }
    // Inline tables and other layouts: by the search, in this page.
    const found = await client.search({ filter: { property: 'object', value: 'database' }, page_size: 100 }).catch(() => ({ results: [] as Json[] }));
    for (const raw of found.results as Array<{ id?: string; archived?: boolean; in_trash?: boolean; parent?: { page_id?: string }; properties?: Json; url?: string }>) {
      if (raw.id && !raw.archived && !raw.in_trash && raw.properties?.[ID_PROPERTY] && raw.parent?.page_id && compactId(raw.parent.page_id) === compactId(pageId)) return { id: raw.id, url: raw.url, properties: raw.properties };
    }
    return null;
  }

  /**
   * Makes a page the vault: its table found there or created (full page,
   * « Toutes les notes »). `own`: a page Boo Notes made (created, or copied
   * from its template) — named `name`, given its icon, cover and welcome.
   */
  async setupVault(token: string, pageId: string, opts: { name?: string; own?: boolean } = {}): Promise<{ databaseId: string; url: string | null; parentId: string; vaultName: string | null; vaultUrl: string | null }> {
    const client = this.client(token.trim());
    let page: NotionPage;
    try {
      page = await client.retrievePage(pageId);
      if (opts.own) {
        page = await client.updatePage(pageId, {
          ...(opts.name ? { properties: { title: { title: plainRichText(opts.name) } } } : {}),
          icon: { type: 'emoji', emoji: VAULT_ICON },
          cover: { type: 'external', external: { url: VAULT_COVER } },
        });
        // An empty page: its welcome (a template's own words are kept).
        if (!(await client.listChildren(pageId)).length) await client.appendChildren(pageId, await Promise.all(vaultIntro().map((b) => toNotion(b, async () => null))));
      }
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    let db = await this.findTable(client, pageId);
    if (db) this.columns = await this.completeSchema(client, db.id, db.properties ?? {});
    else {
      db = await this.createDatabase(client, pageId).catch((e: unknown) => {
        throw new Error(explainNotionError(e));
      });
      // The courses come after the table: their heading, then their pages as they are filed.
      if (opts.own) await client.appendChildren(pageId, [await toNotion({ type: 'heading_2', rich: plainRichText('📚 Mes cours') }, async () => null)]).catch(() => undefined);
    }
    await this.opts.saveDatabase(db.id, db.url ?? null);
    this.databaseChecked = db.id;
    return { databaseId: db.id, url: db.url ?? null, parentId: page.id, vaultName: pageTitle(page) || opts.name || null, vaultUrl: page.url ?? null };
  }

  /** A page Boo Notes made in the workspace (`parentPageId`): the vault, named `name`. */
  async createVault(token: string, parentPageId: string, name: string): Promise<Awaited<ReturnType<NotionEngine['setupVault']>>> {
    const client = this.client(token.trim());
    let page: NotionPage;
    try {
      page = await client.createPage({ parent: { page_id: parentPageId }, properties: { title: { title: plainRichText(name) } } });
    } catch (e) {
      throw new Error(explainNotionError(e));
    }
    return this.setupVault(token, page.id, { name, own: true });
  }

  /**
   * The table, checked once per session: still there (its missing columns
   * added), else another Boo Notes table of the vault adopted, else made
   * again in the vault — never a second one beside the first.
   */
  async ensureDatabase(client = this.client()): Promise<string> {
    const cfg = this.opts.getConfig();
    if (cfg.databaseId && this.databaseChecked === cfg.databaseId && this.columns) return cfg.databaseId;
    if (cfg.databaseId) {
      try {
        const db = await client.retrieveDatabase(cfg.databaseId);
        if (!db.archived && !db.in_trash) {
          this.columns = await this.completeSchema(client, db.id, db.properties);
          this.databaseChecked = db.id;
          return db.id;
        }
      } catch (e) {
        if (!(e instanceof NotionError && e.isNotFound)) throw e;
      }
    }
    if (!cfg.parentId) throw new Error('Base Notion introuvable : reconnectez Notion dans les réglages');
    const other = await this.findTable(client, cfg.parentId);
    if (other) {
      this.columns = await this.completeSchema(client, other.id, other.properties ?? {});
      await this.opts.saveDatabase(other.id, other.url ?? null);
      // The pages of the old table may be in this one: found again by their Boo ID.
      await this.opts.source.clearLinks();
      this.livePages.clear();
      this.databaseChecked = other.id;
      return other.id;
    }
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
      // A page of its own in the vault: the vault stays short, its courses beside it.
      is_inline: false,
      icon: { type: 'emoji', emoji: '🗂️' },
      title: plainRichText(NOTES_TABLE_TITLE),
      description: plainRichText('Une ligne par note. Ouvrez-la pour la relire ; « Source » rouvre la leçon. Les pages des cours rangent ces notes par chapitre.'),
      properties: DATABASE_PROPERTIES,
    });
    this.columns = await this.completeSchema(client, db.id, DATABASE_PROPERTIES);
    return db;
  }

  /** Adds the columns a table lacks; gives back all its columns. */
  private async completeSchema(client: NotionClient, id: string, properties: Json): Promise<Set<string>> {
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
    return new Set([...existing, ...Object.keys(missing), BACKLINKS_PROPERTY]);
  }

  /**
   * Blocks of the Notion page: where it is filed (its course's page, its
   * chapter), the resources, the note, then highlighted passages and the
   * transcript, folded. `coursePage`: the page of its course in the vault.
   */
  buildBlocks(item: SyncItem, wiki: (title: string) => string | null = () => null, coursePage: string | null = null): BlockSpec[] {
    const blocks: BlockSpec[] = [];
    if (item.course) {
      const course: RichText[] = coursePage ? [{ type: 'mention', mention: { type: 'page', page: { id: coursePage } } }] : plainRichText(item.course, { bold: true });
      blocks.push({ type: 'callout', emoji: '📍', color: 'gray_background', rich: [...course, ...plainRichText(`  ›  ${item.chapter || 'Chapitre 1'}`)] });
    }
    const sources: SyncSource[] =
      item.sources ?? (item.source ? [{ id: item.id, kind: item.kind, title: item.title, source: item.source, upload: item.uploadSource }] : []);
    const many = sources.length > 1;
    for (const src of sources) {
      const url = safeUrl(src.source);
      if (url && isYouTube(url)) blocks.push({ type: 'video', url });
      else if (url && isHttp(url)) blocks.push({ type: 'bookmark', url });
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
    const online = /^https?:\/\//.test(item.source) && (item.kind === 'video' || item.kind === 'audio');
    const timeUrl = (s: number) => (online ? timestampUrl(item.source, s) : null);
    // Three parts, each with its heading: ✨ the AI summary, 📝 the notes, 🎙️ the transcript.
    const summary = item.summary ?? null;
    if (summary) {
      blocks.push(...lessonSummaryBlocks(summary, timeUrl, { stale: isStale(summary, item.transcript ?? null) }));
      blocks.push({ type: 'divider' }, { type: 'heading_2', rich: plainRichText('📝 Mes notes') });
    }
    // The transcript's attachment line becomes the section at the end of the page; the summary block of the note is the section above.
    let body = item.transcript?.cues.length ? item.body.split('\n').filter((l) => !TRANSCRIPT_LINE.test(l)).join('\n') : item.body;
    if (summary) body = withoutSummary(body);
    const notes = markdownToBlocks(body, { wiki });
    if (summary && !notes.length) notes.push({ type: 'paragraph', color: 'gray', rich: plainRichText('Pas encore de notes sur cette leçon : prenez-les dans Boo Notes, à côté de la vidéo.', { italic: true }) });
    blocks.push(...notes);
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
    if (item.transcript) {
      if (summary && item.transcript.cues.length) blocks.push({ type: 'divider' });
      blocks.push(...transcriptBlocks(item.transcript, timeUrl, { fold: true }));
    }
    return blocks;
  }

  /** Syncs a note now (waits for a sync of the same note already running). */
  syncItem(id: string): Promise<{ url: string | null; pageId: string }> {
    return this.serial(id, () => this.doSync(id));
  }

  /** Updates the page properties only (progress changes often); its course page follows (rounded progress). */
  syncProperties(id: string): Promise<void> {
    return this.serial(id, async () => {
      const [item, link] = await Promise.all([this.opts.source.item(id), this.opts.source.getLink(id)]);
      if (!item || !link?.pageId) return;
      try {
        await this.ensureDatabase();
        await this.client().updatePage(link.pageId, { properties: pageProperties(item, undefined, this.columns) });
        this.markCourses(item, link);
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
        properties: pageProperties(item, undefined, this.columns),
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
      // Its course's page in the vault (made now if new): the page links to it.
      const coursePage = item.course ? await this.coursePage(item.course).catch(() => null) : null;
      const specs = this.buildBlocks(item, (title) => linked.get(normalizeTitle(title)) ?? null, coursePage);
      // Captures are read once: a missing one is part of the fingerprint, so it is sent once it exists.
      const files = new Map<string, Uint8Array | null>();
      for (const spec of specs) {
        if (spec.type !== 'image') continue;
        if (!files.has(spec.asset)) files.set(spec.asset, await source.readAsset(spec.asset));
        spec.missing = !files.get(spec.asset);
      }
      const hashes = specs.map(hashBlock);
      const properties = pageProperties(item, [...new Set(linked.values())], this.columns);
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
      const course = item.course === undefined ? link?.course : item.course;
      const save = (refs: NotionBlockRef[]) =>
        source.setLink(id, { pageId: pageId!, url: url ?? undefined, blocks: refs, syncedAt: Date.now(), syncedRev: item.rev, error: null, ...(course !== undefined ? { course } : {}) });

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
      // By requests of 100 blocks, 900 with what they fold (Notion takes 1000).
      for (let i = prefix; i < specs.length; ) {
        let end = i;
        let weight = 0;
        while (end < specs.length && end - i < 100 && (end === i || weight + blockCount(specs[end]) <= 900)) weight += blockCount(specs[end++]);
        const payload: Json[] = [];
        for (const spec of specs.slice(i, end)) payload.push(await toNotion(spec, upload));
        const created = await client.appendChildren(pageId, payload);
        blocks = [...blocks, ...created.map((b, j) => ({ id: b.id, hash: hashes[i + j] }))];
        await save(blocks);
        i = end;
      }
      this.markCourses(item, link);
      this.opts.log?.(`Notion : « ${item.title} » synchronisé`);
      return { url, pageId };
    } catch (e) {
      const current = (await source.getLink(id)) ?? link;
      if (current) await source.setLink(id, { ...current, error: explainNotionError(e) });
      throw e;
    }
  }

  // --- Course pages -------------------------------------------------------------------------------

  /** The course a note is listed in now, and the one it was listed in: both pages to write again. */
  private markCourses(item: SyncItem, before: NotionLink | undefined): void {
    if (!this.opts.source.courseEntries) return;
    if (item.course !== undefined) this.dirtyCourses.set(courseKey(item.course), item.course);
    else if (before?.course === undefined) this.dirtyCourses.set(courseKey(null), null);
    if (before?.course !== undefined && courseKey(before.course) !== courseKey(item.course ?? null)) this.dirtyCourses.set(courseKey(before.course), before.course);
  }

  /** A page that still exists (cached for the session). */
  async pageAlive(pageId: string): Promise<boolean> {
    if (this.livePages.has(pageId)) return true;
    try {
      const page = await this.client().retrievePage(pageId);
      if (page.archived || page.in_trash) return false;
      this.livePages.add(pageId);
      return true;
    } catch (e) {
      if (gone(e)) return false;
      throw e;
    }
  }

  /**
   * The page of a course in the vault: found again (its mirror, else a page
   * of that title in the vault), else made — empty, its list written by
   * `syncCourse`.
   */
  async coursePage(course: string | null): Promise<string | null> {
    const { source } = this.opts;
    const cfg = this.opts.getConfig();
    if (!source.getCoursePage || !source.setCoursePage || !cfg.parentId) return null;
    const key = courseKey(course);
    const link = await source.getCoursePage(key);
    if (link?.pageId && (await this.pageAlive(link.pageId))) return link.pageId;
    const client = this.client();
    const title = courseTitle(course);
    const children = await client.listChildren(cfg.parentId);
    const found = children.find((b) => b.type === 'child_page' && normalizeTitle(String((b.child_page as { title?: string } | undefined)?.title ?? '')) === normalizeTitle(title));
    let pageId: string;
    let url: string | undefined;
    let blocks: string[] = [];
    if (found) {
      pageId = found.id;
      url = notionPageUrl(found.id);
      // Written by Boo Notes before (another device, an earlier connection): replaced at the next write.
      blocks = (await client.listChildren(pageId)).filter((b) => b.type !== 'child_page' && b.type !== 'child_database').map((b) => b.id);
    } else {
      const page = await client.createPage({
        parent: { page_id: cfg.parentId },
        icon: { type: 'emoji', emoji: course ? COURSE_ICON : UNFILED_ICON },
        properties: { title: { title: plainRichText(title) } },
      });
      pageId = page.id;
      url = page.url;
    }
    this.livePages.add(pageId);
    await source.setCoursePage(key, { pageId, url, blocks, hash: '' });
    return pageId;
  }

  /** Writes the page of a course again when what it lists changed. */
  async syncCourse(course: string | null): Promise<void> {
    const { source } = this.opts;
    if (!source.courseEntries || !source.getCoursePage || !source.setCoursePage) return;
    const key = courseKey(course);
    const entries = await source.courseEntries(course);
    // Nothing to list and no page yet: none made.
    if (!entries.length && !(await source.getCoursePage(key))) return;
    const pageId = await this.coursePage(course);
    if (!pageId) return;
    const rows: Array<CourseEntry & { pageId: string | null }> = [];
    for (const e of entries) rows.push({ ...e, pageId: (await source.getLink(e.id))?.pageId ?? null });
    const summary = course && source.courseSummary ? await source.courseSummary(course).catch(() => null) : null;
    const specs = courseBlocks(course, rows, summary);
    const hash = specs.map(hashBlock).join('.');
    const link = (await source.getCoursePage(key)) ?? { pageId, blocks: [], hash: '' };
    if (link.hash === hash) return;
    const client = this.client();
    for (const blockId of link.blocks) {
      await client.deleteBlock(blockId).catch((e: unknown) => {
        if (!gone(e)) throw e;
      });
    }
    await source.setCoursePage(key, { ...link, pageId, blocks: [], hash: '' });
    const written: string[] = [];
    for (let i = 0; i < specs.length; i += 100) {
      const payload: Json[] = [];
      for (const spec of specs.slice(i, i + 100)) payload.push(await toNotion(spec, async () => null));
      written.push(...(await client.appendChildren(pageId, payload)).map((b) => b.id));
      await source.setCoursePage(key, { ...link, pageId, blocks: written, hash: i + 100 >= specs.length ? hash : '' });
    }
  }

  /** A course's page to write again (its summary changed). */
  markCourse(course: string | null): void {
    if (this.opts.source.courseEntries) this.dirtyCourses.set(courseKey(course), course);
  }

  hasDirtyCourses(): boolean {
    return this.dirtyCourses.size > 0;
  }

  /** The course pages that changed since the last time: written again. */
  async syncCourses(): Promise<void> {
    const dirty = [...this.dirtyCourses.entries()];
    this.dirtyCourses.clear();
    for (const [key, course] of dirty) {
      try {
        await this.syncCourse(course);
      } catch (e) {
        // Tried again with the next change.
        this.dirtyCourses.set(key, course);
        throw e;
      }
    }
  }
}

export { explainNotionError };

