import { parseTimeParam } from './time';

/**
 * `notion`: video / audio uploaded in a Notion page. `web`: any other site the
 * user activated Boo Notes on. `local`: a file opened in the desktop app.
 */
export type Platform = 'youtube' | 'udemy' | 'coursera' | 'notion' | 'web' | 'local';

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  udemy: 'Udemy',
  coursera: 'Coursera',
  notion: 'Notion',
  web: 'Web',
  local: 'Fichier local',
};

/**
 * What is being studied, and therefore how notes are anchored to it:
 * - `video`, `audio`: timestamps `[04:15]`;
 * - `pdf`: pages `[p. 12]`;
 * - `text` (local .txt / .md): paragraphs `[§ 12]`;
 * - `image` (graph, diagram, whiteboard photo): numbered pins `[pin 3]`;
 * - `page` (web article / text course): quoted passages linked with a text fragment `#:~:text=`;
 * - `note`: a free revision sheet ("fiche"), linked to others with `[[Titre]]`.
 */
export type MediaKind = 'video' | 'audio' | 'pdf' | 'text' | 'image' | 'page' | 'note';

export const KIND_LABELS: Record<MediaKind, string> = {
  video: 'Vidéo',
  audio: 'Audio',
  pdf: 'PDF',
  text: 'Texte',
  image: 'Image',
  page: 'Page web',
  note: 'Fiche',
};

/** Kinds whose position is a time (seconds). */
export function isTimeKind(kind: MediaKind): boolean {
  return kind === 'video' || kind === 'audio';
}

/** Identifies the media (and therefore the note) a page is about. */
export interface VideoContext {
  platform: Platform;
  /** Platform-local identifier (YouTube video id, `course/lecture` for Udemy / Coursera…). */
  videoId: string;
  /** Stable note key, e.g. `youtube:dQw4w9WgXcQ`. One note per video / audio / document. */
  noteId: string;
  /** URL without tracking params / time offsets, used to build timestamp links. */
  canonicalUrl: string;
  /**
   * Generic pages (Notion, other sites) are only "about" a media when they
   * actually contain one; the three course platforms are identified by URL.
   */
  requiresMedia?: boolean;
}

const KNOWN_PLATFORM_DOMAINS = ['youtube.com', 'udemy.com', 'coursera.org'];
const NOTION_ID = /([0-9a-f]{32})(?:$|[?#/])/i;
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_eid|mc_cid|ref|si)$/i;

const YT_ID = /^[\w-]{6,20}$/;

function isHost(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** Returns the video context for a supported watch / lecture URL, `null` otherwise. */
export function detectVideoContext(href: string): VideoContext | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, '');

  if (isHost(url.hostname, 'youtube.com')) {
    let id: string | null = null;
    if (path === '/watch') id = url.searchParams.get('v');
    else {
      const live = /^\/live\/([\w-]+)$/.exec(path);
      if (live) id = live[1];
    }
    if (!id || !YT_ID.test(id)) return null;
    return {
      platform: 'youtube',
      videoId: id,
      noteId: `youtube:${id}`,
      canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    };
  }

  if (isHost(url.hostname, 'udemy.com')) {
    const m = /^\/course\/([^/]+)\/learn\/lecture\/(\d+)$/.exec(path);
    if (!m) return null;
    const videoId = `${m[1]}/${m[2]}`;
    return {
      platform: 'udemy',
      videoId,
      noteId: `udemy:${videoId}`,
      canonicalUrl: `${url.origin}/course/${m[1]}/learn/lecture/${m[2]}`,
    };
  }

  if (isHost(url.hostname, 'coursera.org')) {
    const m = /^\/learn\/([^/]+)\/lecture\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (!m) return null;
    const videoId = `${m[1]}/${m[2]}`;
    return {
      platform: 'coursera',
      videoId,
      noteId: `coursera:${videoId}`,
      canonicalUrl: `${url.origin}/learn/${m[1]}/lecture/${m[2]}${m[3] ? `/${m[3]}` : ''}`,
    };
  }

  if (isHost(url.hostname, 'notion.so') || isHost(url.hostname, 'notion.site')) {
    // Page id: 32 hex chars ending the path (`/Titre-<id>`), or a peeked page (`?p=<id>`).
    const peek = url.searchParams.get('p');
    const id = (peek && /^[0-9a-f]{32}$/i.test(peek) ? peek : NOTION_ID.exec(url.pathname)?.[1])?.toLowerCase();
    if (!id) return null;
    const origin = isHost(url.hostname, 'notion.site') ? url.origin : 'https://www.notion.so';
    return { platform: 'notion', videoId: id, noteId: `notion:${id}`, canonicalUrl: `${origin}/${id}`, requiresMedia: true };
  }

  if (KNOWN_PLATFORM_DOMAINS.some((d) => isHost(url.hostname, d))) return null;

  // Any other site the user activated Boo Notes on: one note per page (tracking params dropped),
  // and per lesson of a single-page course (its `#/route`).
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const params = [...url.searchParams].filter(([k]) => !TRACKING_PARAMS.test(k));
  const search = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const route = hashRoute(url.hash);
  const hash = route ? `#${url.hash.startsWith('#!') ? '!' : ''}${route}` : '';
  const canonicalUrl = `${url.origin}${url.pathname}${search}${hash}`;
  const videoId = `${url.host}${url.pathname}${search}${hash}`;
  return { platform: 'web', videoId, noteId: `web:${videoId}`, canonicalUrl, requiresMedia: true };
}

/** A route naming a lesson (Articulate Rise `#/lessons/…`, `#/module/2`, `#/chapitres/3`…). */
const LESSON_ROUTE = /\/(?:lessons?|le[cç]ons?|modules?|chapters?|chapitres?|units?|unites?|unités?|topics?|sections?|lectures?|cours|courses?)(?:\/|$)/i;

/**
 * The lesson of a single-page course in the address's `#` (`#/lessons/abc`,
 * `#!/module/2`): one note each. Other routes (a slide of a Storyline
 * player, `#/home`), anchors (`#section`), media fragments (`#t=…`) and text
 * fragments leave the page one note.
 */
export function hashRoute(hash: string): string | null {
  const m = /^#!?(\/[^#]*)$/.exec(hash);
  const route = m?.[1].replace(/\/+$/, '');
  return route && route.length > 1 && LESSON_ROUTE.test(route) ? route : null;
}

/** The lesson shown in a course module (a frame of the page): its own note. */
export interface Lesson {
  /** Its route in the module (`/lessons/abc`). */
  route: string;
  title: string;
}

const LESSON_MARK = '#lesson';

/** The note of a lesson of the module in the page: the page's note, narrowed to the lesson. */
export function withLesson(ctx: VideoContext, lesson: Lesson): VideoContext {
  return { ...ctx, videoId: `${ctx.videoId}${LESSON_MARK}${lesson.route}`, noteId: `${ctx.noteId}${LESSON_MARK}${lesson.route}` };
}

/** The note of the page a lesson's note belongs to (itself for any other note). */
export function pageNoteId(noteId: string): string {
  const i = noteId.indexOf(`${LESSON_MARK}/`);
  return i === -1 ? noteId : noteId.slice(0, i);
}

/** True for the hosts where the content script is declared in the manifest. */
export function isDeclaredPlatformHost(hostname: string): boolean {
  return [...KNOWN_PLATFORM_DOMAINS, 'notion.so', 'notion.site'].some((d) => isHost(hostname, d));
}

/** Link to a precise instant of the video: `URL#t=255` (media fragment, handled by the content script). */
export function timestampUrl(canonicalUrl: string, seconds: number): string {
  return `${canonicalUrl.split('#')[0]}#t=${Math.max(0, Math.floor(seconds))}`;
}

/** Start offset requested by the URL (`#t=255`, `&t=4m15s`…), if any. */
export function readStartTime(href: string): number | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const raw = hash.get('t') ?? url.searchParams.get('t') ?? url.searchParams.get('start');
  return raw === null ? null : parseTimeParam(raw);
}

/** File-system friendly slug for a note id (`youtube:abc` → `youtube-abc`). */
export function noteSlug(noteId: string): string {
  return noteId
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}
