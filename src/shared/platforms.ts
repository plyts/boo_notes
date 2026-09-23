import { parseTimeParam } from './time';

export type Platform = 'youtube' | 'udemy' | 'coursera';

export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  udemy: 'Udemy',
  coursera: 'Coursera',
};

/** Identifies the video (and therefore the note) a page is about. */
export interface VideoContext {
  platform: Platform;
  /** Platform-local identifier (YouTube video id, `course/lecture` for Udemy / Coursera). */
  videoId: string;
  /** Stable note key, e.g. `youtube:dQw4w9WgXcQ`. One note per video. */
  noteId: string;
  /** URL without tracking params / time offsets, used to build timestamp links. */
  canonicalUrl: string;
}

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

  return null;
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
